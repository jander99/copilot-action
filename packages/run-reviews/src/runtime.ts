/**
 * Runtime abstraction for the reviewer CLI transport.
 *
 * `ReviewRuntime` decouples the shared spawn / parse / timeout / debug
 * machinery from the concrete CLI implementation. The original transport
 * (`opencode run --format=json`) lives in `./opencode-run.ts`; the
 * Claude Code CLI (`claude -p --output-format stream-json ...`) lives in
 * `./claude-run.ts`. Both implement the same surface so the dispatcher
 * in `./opencode.ts` can pick one at runtime without the rest of the
 * pipeline caring which CLI produced the events.
 *
 * Shared scaffolding (file capture, timeout, exit handling) lives here
 * so adding a new runtime only requires implementing the small set of
 * tool-specific methods; the heavy lifting stays in one place.
 */
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type ReviewTool = 'opencode' | 'claude';

export interface DebugCapturePaths {
  stdoutPath: string;
  stderrPath: string;
}

/**
 * Options accepted by the shared `runReview` orchestrator. The
 * `model` field is the **original** caller-supplied string (typically
 * `provider/model`). The runtime resolves it for its own CLI argument
 * via `resolveModel`; the original string is preserved on the result so
 * downstream accounting (`costByModel`, `tokensByModel`) keys on the
 * caller's identifier.
 */
export interface ReviewRuntimeOptions {
  prompt: string;
  model: string;
  configPath?: string;
  homeDir?: string;
  timeoutMinutes?: number;
  debugCapture?: DebugCapturePaths;
  /**
   * When set, the prompt is delivered to the child's stdin pipe
   * rather than as the trailing positional arg. The runtime
   * substitutes `-` (or its own stdin sentinel) for the prompt in
   * `commandArgs`, and the orchestrator writes `input` to
   * `proc.stdin` before closing it. This avoids the OS `ARG_MAX`
   * (`E2BIG` on Linux, ~128 KB) failure mode that hits when a
   * reviewer prompt + embedded diff exceeds the argv limit.
   *
   * When unset, the prompt is passed as the trailing positional
   * arg after `--` (the existing behavior). The orchestrator
   * always sets `input` so reviewers and validators stay
   * consistent; this field is left optional so the back-compat
   * `runOpenCodeRun` entry point (used by the validator's
   * opencode path) keeps its existing signature.
   */
  input?: string | Buffer;
}

export interface ReviewRuntimeResult {
  text: string;
  cost: number;
  tokens: { input: number; output: number; reasoning?: number };
  /** Original `provider/model` string from the caller; the runtime's resolved model is internal. */
  model: string;
  parts: ReadonlyArray<unknown>;
}

export interface ReviewRuntimeSpawn {
  spawn: typeof childProcess.spawn;
}

/**
 * The runtime interface implemented by every supported CLI
 * transport. Each method owns one slice of the spawn lifecycle; the
 * shared `runReview` orchestrator composes them so adding a new
 * transport only requires implementing this surface.
 */
export interface ReviewRuntime {
  readonly tool: ReviewTool;
  /** Assert the runtime binary is present at the expected version. Throw on mismatch. */
  assertVersion(expectedVersion: string): void;
  /** Resolve `provider/model` input to the tool-native model string. Throw on bad format. */
  resolveModel(rawModel: string): string;
  /** Build the env for the spawned process. */
  buildEnvironment(options: ReviewRuntimeOptions): NodeJS.ProcessEnv;
  /**
   * Build the CLI args. When `useStdin` is true, the runtime
   * substitutes a stdin sentinel (`-` for both opencode and
   * claude) for the prompt and the orchestrator writes the
   * actual prompt text to `proc.stdin`. When `useStdin` is false,
   * the prompt is the trailing positional arg after `--`.
   */
  commandArgs(model: string, prompt: string, useStdin: boolean): string[];
  /** Parse captured stdout into a structured result. */
  parseEvents(stdout: string, stdoutPath: string, stderrPath: string): ReviewRuntimeResult;
}

const DEFAULT_TIMEOUT_MINUTES = 30;
const TEMP_DEBUG_PREFIX = 'ai-review-review-run-';

/**
 * Line-buffered writer that streams child-process stdout / stderr to
 * disk. Storing the raw stream (rather than buffering in memory) keeps
 * the orchestrator's memory footprint flat for long-lived model runs
 * that produce tens of megabytes of event JSON.
 */
export class LineBufferedWriter {
  private pending = '';
  private closed = false;

  private readonly fd: number;

  constructor(filePath: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    this.fd = fs.openSync(filePath, 'w', 0o600);
  }

  write(chunk: unknown): void {
    if (this.closed || chunk == null) {
      return;
    }

    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8');
    this.pending += text;

    let newlineIndex = this.pending.indexOf('\n');
    while (newlineIndex >= 0) {
      fs.writeSync(this.fd, this.pending.slice(0, newlineIndex + 1), undefined, 'utf8');
      this.pending = this.pending.slice(newlineIndex + 1);
      newlineIndex = this.pending.indexOf('\n');
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.pending) {
      fs.writeSync(this.fd, this.pending, undefined, 'utf8');
      this.pending = '';
    }
    fs.closeSync(this.fd);
  }
}

function lastNonEmptyLine(text: string): string {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? '<none>';
}

/**
 * Build a one-line diagnostic summary of the captured child-process
 * stdout/stderr files. Used by every error path (timeout, non-zero
 * exit, parse failure) so the action log shows the last line of each
 * stream rather than dumping the full content.
 */
export function diagnostics(stdoutPath: string, stderrPath: string): string {
  const stdout = fs.existsSync(stdoutPath) ? fs.readFileSync(stdoutPath, 'utf8') : '';
  const stderr = fs.existsSync(stderrPath) ? fs.readFileSync(stderrPath, 'utf8') : '';
  return `last stdout line: ${lastNonEmptyLine(stdout)}; last stderr line: ${lastNonEmptyLine(stderr)}`;
}

function closeCapture(writer: LineBufferedWriter | null): void {
  writer?.close();
}

interface SpawnedProcess {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  stdin: { write(chunk: string | Buffer): boolean; end(): void } | null;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  kill(signal?: NodeJS.Signals | string): boolean;
}

function waitForProcess(
  proc: SpawnedProcess,
  binary: string,
  timeoutMs: number,
  getDiagnostics: () => string,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutHandle: NodeJS.Timeout | undefined;

    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      resolve({ code, signal });
    };

    proc.on('error', (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      const message = error instanceof Error ? error.message : String(error);
      reject(new Error(`could not execute ${binary}: ${message}; ${getDiagnostics()}`));
    });
    proc.on('close', (code: unknown, signal: unknown) => {
      finish(
        typeof code === 'number' ? code : null,
        typeof signal === 'string' ? signal as NodeJS.Signals : null,
      );
    });

    timeoutHandle = setTimeout(() => {
      if (settled) {
        return;
      }
      try {
        proc.kill('SIGTERM');
      } catch {
        // The process may have exited between the timeout and kill call.
      }
      const message = `${binary} timed out after ${timeoutMs} ms; ${getDiagnostics()}`;
      reject(new Error(message));
      settled = true;
      const killHandle = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          // Best-effort escalation only.
        }
      }, 3_000);
      killHandle.unref?.();
    }, timeoutMs);
    timeoutHandle.unref?.();
  });
}

/**
 * Shared scaffolding for every runtime: file capture, spawn, wait,
 * parse. Mirrors the orchestration that used to be inline in
 * `runOpenCodeRun` so both runtimes share timeout enforcement, debug
 * capture, and process handling.
 *
 * The runtime-specific CLI binary is the literal tool name (e.g.
 * `"opencode"` or `"claude"`); the binary string is used in error
 * messages only and is NOT hardcoded here.
 */
export async function runReview(
  options: ReviewRuntimeOptions,
  runtime: ReviewRuntime,
  spawnOverride?: typeof childProcess.spawn,
): Promise<ReviewRuntimeResult> {
  if (!options || typeof options !== 'object') {
    throw new Error('runReview requires an options object');
  }
  if (!options.prompt) {
    throw new Error('runReview requires options.prompt');
  }
  if (!options.model) {
    throw new Error('runReview requires options.model');
  }
  const timeoutMinutes = options.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES;
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) {
    throw new Error('runReview requires a positive options.timeoutMinutes');
  }

  // Resolve the provider/model input to the tool-native form. For
  // opencode this is an identity; for claude this strips the provider
  // prefix. Validation errors throw from here so the dispatcher can
  // surface them as `failureReason`.
  const resolvedModel = runtime.resolveModel(options.model);
  // `useStdin` is decided once here and threaded through the
  // runtime's `commandArgs` (which substitutes `-` for the
  // prompt) and the orchestrator's spawn (which writes the
  // prompt to `proc.stdin`). Setting `input` is the canonical
  // opt-in: any caller that wants to bypass the OS `ARG_MAX`
  // (Linux: ~128 KB) provides `input` and the runtime + spawn
  // route accordingly.
  const useStdin = options.input !== undefined;
  const args = runtime.commandArgs(resolvedModel, options.prompt, useStdin);
  const binary = runtime.tool;

  const temporaryDebugDirectory = options.debugCapture
    ? null
    : fs.mkdtempSync(path.join(os.tmpdir(), TEMP_DEBUG_PREFIX));
  const stdoutPath = options.debugCapture?.stdoutPath ?? path.join(temporaryDebugDirectory as string, 'stdout.jsonl');
  const stderrPath = options.debugCapture?.stderrPath ?? path.join(temporaryDebugDirectory as string, 'stderr.log');
  const stdoutWriter = new LineBufferedWriter(stdoutPath);
  const stderrWriter = new LineBufferedWriter(stderrPath);
  const getDiagnostics = (): string => diagnostics(stdoutPath, stderrPath);

  try {
    const env = runtime.buildEnvironment(options);
    // Open stdin as a pipe when `input` is set so we can write the
    // prompt to the child. Otherwise close stdin (`'ignore'`) so
    // the child sees EOF immediately; passing `''` would create a
    // closed pipe on some platforms which `claude` interprets as
    // "no stdin", but explicit `'ignore'` is the documented
    // `stdio` mode for "close the child's stdin fd".
    const stdinMode: 'pipe' | 'ignore' = useStdin ? 'pipe' : 'ignore';
    let proc: SpawnedProcess;
    try {
      proc = (spawnOverride ?? childProcess.spawn)(binary, args, {
        env,
        stdio: [stdinMode, 'pipe', 'pipe'],
      }) as SpawnedProcess;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`could not execute ${binary}: ${message}; ${getDiagnostics()}`);
    }

    if (useStdin && options.input !== undefined && proc.stdin) {
      // Write the prompt and close the write end so the child sees
      // EOF and can start reading from stdin. Errors here are
      // non-fatal — if the child already exited, the write would
      // surface as `EPIPE`; the spawn is already over.
      try {
        proc.stdin.write(options.input);
        proc.stdin.end();
      } catch {
        // Best-effort: the child may have exited before we got to
        // write. The error path below still surfaces any
        // non-zero exit, so we don't need to re-throw here.
      }
    }

    proc.stdout?.on('data', (chunk: unknown) => stdoutWriter.write(chunk));
    proc.stderr?.on('data', (chunk: unknown) => stderrWriter.write(chunk));

    const exit = await waitForProcess(proc, binary, timeoutMinutes * 60 * 1000, getDiagnostics);
    stdoutWriter.close();
    stderrWriter.close();

    const stdout = fs.readFileSync(stdoutPath, 'utf8');
    if (exit.code !== 0 || exit.signal) {
      throw new Error(
        `${binary} exited unsuccessfully${exit.code !== null ? ` with status ${exit.code}` : ` with signal ${exit.signal}`}; ${getDiagnostics()}`,
      );
    }

    const parsed = runtime.parseEvents(stdout, stdoutPath, stderrPath);
    // Preserve the caller's original model string (e.g. `provider/model`)
    // so downstream accounting keys on the caller identifier, not the
    // runtime-resolved internal form.
    return { ...parsed, model: options.model };
  } finally {
    closeCapture(stdoutWriter);
    closeCapture(stderrWriter);
    if (temporaryDebugDirectory) {
      fs.rmSync(temporaryDebugDirectory, { recursive: true, force: true });
    }
  }
}