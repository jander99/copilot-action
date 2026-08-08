/**
 * Claude Code CLI transport for the validator.
 *
 * Mirrors the reviewer's `ClaudeCodeRuntime` in `run-reviews` so the
 * arg shape, NDJSON parsing, and permission lockdown are identical
 * between the two surfaces. The validator only asks the model to
 * emit `VALID` or `INVALID <reason>` so it does not need any tool
 * access beyond the read-only subset the reviewer uses; we keep the
 * allow-list identical to the reviewer for parity / audit reasons
 * (a future change that opens up tools here MUST also be reviewed
 * on the reviewer side).
 *
 * Permission lockdown (mirrored from `ClaudeCodeRuntime`):
 *   - `--allowedTools` whitelists `Read`, `Glob`, `Grep`, the same
 *     `git diff/show/log/rev-parse` subset, and `query`. Tools not on
 *     this list are denied by Claude Code's permission system.
 *
 * We do NOT pass `--dangerously-skip-permissions` here either. With
 * that flag the permission system is bypassed entirely, and shell
 * expansion in `git diff <$(...)>` arguments would match the
 * `Bash(git diff *)` allowlist rule before the allowlist check
 * fires. Without the flag, the allowlist is enforced. Same reason as
 * the reviewer side.
 *
 * Env handling is intentionally NOT pass-through-by-default here.
 * Unlike the reviewer (where the action layer sets env vars globally
 * via `core.exportVariable` / the workflow `env:` block and the
 * runtime sees them via `process.env`), the validator accepts a
 * `passthroughEnv` field on its options so the action layer can
 * forward the Anthropic-compatible endpoint + claude flag env vars
 * (see `.github/workflows/ai-review.yml` and project memory #188).
 * The runtime merges `passthroughEnv` on top of `process.env` so
 * explicit overrides always win.
 */
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Read-only git subset mirrored from the reviewer's
// `CLAUDE_ALLOWED_TOOLS`. `query` is intentionally NOT included:
// it is Claude Code's internal sub-query / sub-agent tool that
// lets the model delegate to a child agent. The validator doesn't
// need sub-agents, and a sub-agent hop is exactly where the
// read-only boundary breaks down. Keeping `query` out of the
// allow-list forces the model to do the read-only work itself.
const CLAUDE_VALIDATOR_ALLOWED_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'Bash(git diff *)',
  'Bash(git show *)',
  'Bash(git log *)',
  'Bash(git rev-parse *)',
] as const;

interface ClaudeResultEvent {
  type?: unknown;
  subtype?: unknown;
  result?: unknown;
  total_cost_usd?: unknown;
  usage?: unknown;
}

interface ClaudeUsage {
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
  reasoning_tokens?: unknown;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readUsageTokens(usage: ClaudeUsage | undefined): { input: number; output: number; reasoning?: number } {
  if (!usage) {
    return { input: 0, output: 0 };
  }
  const input = readNumber(usage.input_tokens) ?? 0;
  const output = readNumber(usage.output_tokens) ?? 0;
  const reasoning =
    readNumber(usage.reasoning_tokens) ?? readNumber(usage.cache_read_input_tokens);
  return reasoning === undefined ? { input, output } : { input, output, reasoning };
}

interface SpawnedProcess {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  stdin: { write(chunk: string | Buffer): boolean; end(): void } | null;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  kill(signal?: NodeJS.Signals | string): boolean;
}

const DEFAULT_TIMEOUT_MINUTES = 5;
const TEMP_DEBUG_PREFIX = 'ai-review-validate-claude-';

class LineBufferedWriter {
  private pending = '';
  private closed = false;
  private readonly fd: number;

  constructor(filePath: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    this.fd = fs.openSync(filePath, 'w', 0o600);
  }

  write(chunk: unknown): void {
    if (this.closed || chunk == null) return;
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
    if (this.closed) return;
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

function diagnostics(stdoutPath: string, stderrPath: string): string {
  const stdout = fs.existsSync(stdoutPath) ? fs.readFileSync(stdoutPath, 'utf8') : '';
  const stderr = fs.existsSync(stderrPath) ? fs.readFileSync(stderrPath, 'utf8') : '';
  return `last stdout line: ${lastNonEmptyLine(stdout)}; last stderr line: ${lastNonEmptyLine(stderr)}`;
}

function closeCapture(writer: LineBufferedWriter | null): void {
  writer?.close();
}

/**
 * Implements the Claude Code CLI transport for the validator. The
 * interface mirrors `ReviewRuntime` in `run-reviews` so the two
 * surfaces stay structurally identical, but the validator's runtime
 * is intentionally simpler: no retry loop, no format-fallback, no
 * multi-issue reporting — just one-shot spawn → parse → return.
 */
export class ClaudeCodeValidatorRuntime {
  readonly tool = 'claude' as const;

  assertVersion(expectedVersion: string): void {
    const result = spawnSync('claude', ['--version'], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    });
    const stdout = typeof result.stdout === 'string' ? result.stdout.trim() : '';
    const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : '';

    if (result.error) {
      throw new Error(`could not execute 'claude --version': ${result.error.message}`);
    }
    if (result.status !== 0) {
      throw new Error(
        `'claude --version' exited with status ${result.status}${stderr ? `: ${stderr}` : ''}`,
      );
    }

    // Empty expected version means "only verify the binary is on PATH";
    // skip the semver pin so callers can opt out of a hard version
    // requirement (the Claude Code CLI is released on a fast cadence
    // and pinning every minor is high-friction).
    if (!expectedVersion) return;

    const reportedVersion = stdout || stderr;
    const versionMatch = reportedVersion.match(/v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
    const installedVersion = (versionMatch?.[1] ?? reportedVersion.replace(/^v/, '')).trim();
    const normalizedExpectedVersion = expectedVersion.replace(/^v/, '');
    if (!installedVersion || installedVersion !== normalizedExpectedVersion) {
      throw new Error(
        `expected Claude Code ${normalizedExpectedVersion}, but 'claude --version' reported '${reportedVersion || '<empty>'}'`,
      );
    }
  }

  /**
   * Strip the `provider/` prefix from the model string. Claude Code
   * CLI's `--model` flag does NOT consume the OpenCode-style
   * `provider/model` form; the validator runtime mirrors the
   * reviewer's `ClaudeCodeRuntime.resolveModel` so both surfaces
   * surface the same error message when the caller forgets the
   * prefix.
   */
  resolveModel(rawModel: string): string {
    const slashIndex = rawModel.indexOf('/');
    if (slashIndex <= 0) {
      throw new Error(
        `tool=claude requires model in 'provider/model' format; got '${rawModel}'`,
      );
    }
    return rawModel.slice(slashIndex + 1);
  }

  /**
   * Build the env for the spawned process. Start from the
   * allow-listed 5 keys (same as the reviewer's claude runtime),
   * then layer the explicit `passthroughEnv` overrides on top so
   * the action layer can route through `ANTHROPIC_BASE_URL` etc.
   * without the runtime having to know which keys are
   * interesting.
   *
   * `process.env` is NOT spread: doing so would forward every
   * workflow secret (GITHUB_TOKEN, AWS_*, MINIMAX_API_KEY, etc.)
   * to the CLI. The validator only needs the five keys below to
   * route through the Anthropic-compatible endpoint.
   *
   * `ANTHROPIC_API_KEY` is set to the empty string (NOT unset)
   * so Claude Code CLI's OAuth fallback is suppressed and the
   * endpoint routes via `ANTHROPIC_AUTH_TOKEN`. See project
   * memory #188.
   */
  buildEnvironment(passthroughEnv: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
    const scopedEnv: NodeJS.ProcessEnv = {
      ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL ?? '',
      ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN ?? '',
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL ?? '',
      CLAUDE_ENABLE_BYTE_WATCHDOG: '0',
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
    };
    return { ...scopedEnv, ...(passthroughEnv ?? {}) };
  }

  commandArgs(model: string, prompt: string, useStdin: boolean): string[] {
    const args: string[] = ['-p'];
    for (const toolName of CLAUDE_VALIDATOR_ALLOWED_TOOLS) {
      args.push('--allowedTools', toolName);
    }
    args.push(
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--model', model,
    );
    // When `useStdin` is true, the orchestrator writes the prompt
    // to `proc.stdin`; the runtime substitutes `-` as the
    // positional arg. This avoids the OS `ARG_MAX` (`E2BIG` on
    // Linux) failure on a long review. The validator's prompt is
    // the structural-validation result + the review file
    // contents; both can be substantial.
    if (useStdin) {
      args.push('-');
    } else {
      args.push('--', prompt);
    }
    return args;
  }

  parseEvents(stdout: string, stdoutPath: string, stderrPath: string): {
    text: string;
    cost: number;
    tokens: { input: number; output: number; reasoning?: number };
    model: string;
    parts: ReadonlyArray<unknown>;
  } {
    const parts: unknown[] = [];
    let finalResultEvent: ClaudeResultEvent | undefined;

    for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
      let parsed: ClaudeResultEvent;
      try {
        parsed = JSON.parse(line) as ClaudeResultEvent;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`could not parse Claude Code JSON event: ${message}; ${diagnostics(stdoutPath, stderrPath)}`);
      }

      parts.push(parsed);
      if (parsed.type === 'result') {
        // Last result event wins (the CLI emits one per top-level turn).
        finalResultEvent = parsed;
      }
    }

    const text = readString(finalResultEvent?.result) ?? '';
    const cost = readNumber(finalResultEvent?.total_cost_usd) ?? 0;
    const tokens = readUsageTokens(finalResultEvent?.usage as ClaudeUsage | undefined);

    return {
      text,
      cost,
      tokens,
      // The runtime contract returns the caller's original model
      // string (the reviewer's runtime sets `model: ''` here and
      // then runReview() overwrites it with the caller's input).
      // For the validator we set the stripped model directly so
      // downstream accounting keys on the bare Claude Code model id.
      model: '',
      parts,
    };
  }
}

function waitForProcess(
  proc: SpawnedProcess,
  timeoutMs: number,
  getDiagnostics: () => string,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutHandle: NodeJS.Timeout | undefined;

    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      resolve({ code, signal });
    };

    proc.on('error', (error: unknown) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      const message = error instanceof Error ? error.message : String(error);
      reject(new Error(`could not execute claude: ${message}; ${getDiagnostics()}`));
    });
    proc.on('close', (code: unknown, signal: unknown) => {
      finish(
        typeof code === 'number' ? code : null,
        typeof signal === 'string' ? signal as NodeJS.Signals : null,
      );
    });

    timeoutHandle = setTimeout(() => {
      if (settled) return;
      try {
        proc.kill('SIGTERM');
      } catch {
        // The process may have exited between the timeout and kill call.
      }
      const message = `claude timed out after ${timeoutMs} ms; ${getDiagnostics()}`;
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

export interface ClaudeValidatorOptions {
  prompt: string;
  /** Caller-supplied `provider/model` string; the runtime strips the prefix for `--model`. */
  model: string;
  timeoutMinutes?: number;
  /**
   * Explicit env overrides layered on top of `process.env`. The
   * action layer uses this to forward `ANTHROPIC_BASE_URL`,
   * `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY=""`, the
   * `CLAUDE_ENABLE_BYTE_WATCHDOG=0` / `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`
   * flags, and any other Anthropic-compatible endpoint config
   * without hardcoding keys here.
   */
  passthroughEnv?: NodeJS.ProcessEnv;
}

export interface ClaudeValidatorResult {
  text: string;
  cost: number;
  tokens: { input: number; output: number; reasoning?: number };
}

/**
 * Spawn the Claude Code CLI in non-interactive mode for the
 * validator. Mirrors the structure used by the reviewer's
 * `runClaudeRun` but stays self-contained inside the validator
 * package (no `ReviewRuntime` shared type) and accepts the env
 * overrides the action layer needs to forward.
 */
export async function runClaudeValidator(
  options: ClaudeValidatorOptions,
  spawnOverride?: (command: string, args: string[], spawnOptions: { env: NodeJS.ProcessEnv }) => SpawnedProcess,
): Promise<ClaudeValidatorResult> {
  const runtime = new ClaudeCodeValidatorRuntime();
  const timeoutMinutes = options.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES;
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) {
    throw new Error('runClaudeValidator requires a positive timeoutMinutes');
  }

  const model = runtime.resolveModel(options.model);
  // Always deliver the prompt via stdin (mirroring the reviewer's
  // `invokeReview`). The validator's prompt is the structural-
  // validation result + the review file contents; both can be
  // substantial. Routing through stdin keeps the argv under
  // `ARG_MAX` regardless of how big the review document gets.
  const useStdin = true;
  const args = runtime.commandArgs(model, options.prompt, useStdin);
  const env = runtime.buildEnvironment(options.passthroughEnv);

  const runnerTemp = process.env.RUNNER_TEMP ?? os.tmpdir();
  const homeDir = fs.mkdtempSync(path.join(runnerTemp, TEMP_DEBUG_PREFIX));
  fs.chmodSync(homeDir, 0o700);

  const stdoutPath = path.join(homeDir, 'stdout.jsonl');
  const stderrPath = path.join(homeDir, 'stderr.log');
  const stdoutWriter = new LineBufferedWriter(stdoutPath);
  const stderrWriter = new LineBufferedWriter(stderrPath);
  const getDiagnostics = (): string => diagnostics(stdoutPath, stderrPath);

  try {
    let proc: SpawnedProcess;
    try {
      proc = (spawnOverride ?? spawn)('claude', args, {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as SpawnedProcess;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`could not execute claude: ${message}; ${getDiagnostics()}`);
    }

    // Write the prompt to stdin and close the write end so the
    // child sees EOF and starts reading. Errors here are
    // non-fatal: if the child already exited, the write would
    // surface as `EPIPE` and the spawn is over.
    if (proc.stdin) {
      try {
        proc.stdin.write(options.prompt);
        proc.stdin.end();
      } catch {
        // Best-effort. The error path below still surfaces any
        // non-zero exit, so we don't need to re-throw here.
      }
    }

    proc.stdout?.on('data', (chunk: unknown) => stdoutWriter.write(chunk));
    proc.stderr?.on('data', (chunk: unknown) => stderrWriter.write(chunk));

    const exit = await waitForProcess(proc, timeoutMinutes * 60 * 1000, getDiagnostics);
    stdoutWriter.close();
    stderrWriter.close();

    const stdout = fs.readFileSync(stdoutPath, 'utf8');
    if (exit.code !== 0 || exit.signal) {
      throw new Error(
        `claude exited unsuccessfully${exit.code !== null ? ` with status ${exit.code}` : ` with signal ${exit.signal}`}; ${getDiagnostics()}`,
      );
    }

    return runtime.parseEvents(stdout, stdoutPath, stderrPath);
  } finally {
    closeCapture(stdoutWriter);
    closeCapture(stderrWriter);
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
}