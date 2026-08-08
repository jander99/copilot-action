/**
 * OpenCode CLI transport.
 *
 * Extracted into `OpenCodeRuntime` (a `ReviewRuntime` implementation)
 * so the dispatcher in `./opencode.ts` can pick between opencode and
 * Claude Code without duplicating spawn / parse / timeout scaffolding.
 * The legacy `runOpenCodeRun(options, runtime?)` entry point is kept
 * for back-compat (the validator package and existing tests rely on
 * it).
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import { selectTerminalText } from '@jander99/ai-review-review-contract';
import {
  diagnostics,
  runReview,
  type DebugCapturePaths,
  type ReviewRuntime,
  type ReviewRuntimeOptions,
  type ReviewRuntimeResult,
  type ReviewRuntimeSpawn,
} from './runtime';

export type { DebugCapturePaths } from './runtime';

// ---------------------------------------------------------------------------
// Back-compat public types (used by `validate-review` and existing tests).
// ---------------------------------------------------------------------------

/**
 * Options accepted by `runOpenCodeRun`. Extends the shared runtime
 * options with the opencode-only `disableTools` flag (preserved for
 * API compatibility, not currently read by the implementation).
 */
export interface RunOpenCodeRunOptions extends ReviewRuntimeOptions {
  disableTools?: boolean;
}

/** Result returned by `runOpenCodeRun`. Identical shape to the shared result. */
export type RunOpenCodeRunResult = ReviewRuntimeResult;

/** Back-compat alias for the spawn override type. */
export type OpenCodeRunRuntime = ReviewRuntimeSpawn;

// ---------------------------------------------------------------------------
// OpenCode-specific implementation.
// ---------------------------------------------------------------------------

interface OpenCodeEvent {
  type?: unknown;
  text?: unknown;
  part?: unknown;
  tokens?: unknown;
  cost?: unknown;
}

const EVENT_TYPES = new Set(['text', 'step_finish', 'step_use', 'tool_use', 'reasoning']);

function normalizeEventType(type: unknown): string | null {
  if (typeof type !== 'string') {
    return null;
  }
  if (type === 'step-finish') {
    return 'step_finish';
  }
  return type;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizePart(event: OpenCodeEvent, eventType: string): Record<string, unknown> {
  const eventPart = asRecord(event.part);
  const part = eventPart ? { ...eventPart } : { ...event };
  const partType = normalizeEventType(part.type) ?? eventType;
  part.type = partType === 'step_finish' ? 'step-finish' : partType;
  if (typeof part.text !== 'string' && typeof event.text === 'string') {
    part.text = event.text;
  }
  return part;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readTokens(
  event: Record<string, unknown> | undefined,
  part: Record<string, unknown> | undefined,
): RunOpenCodeRunResult['tokens'] {
  const rawTokens = asRecord(event?.tokens) ?? asRecord(part?.tokens);
  const input = readNumber(rawTokens?.input) ?? 0;
  const output = readNumber(rawTokens?.output) ?? 0;
  const reasoning = readNumber(rawTokens?.reasoning);
  return reasoning === undefined ? { input, output } : { input, output, reasoning };
}

/**
 * Implements the OpenCode CLI transport. Behavior preserved EXACTLY
 * from the original `runOpenCodeRun` so existing tests and the
 * validator package keep working without modification.
 */
export class OpenCodeRuntime implements ReviewRuntime {
  readonly tool = 'opencode' as const;

  assertVersion(expectedVersion: string): void {
    const result = spawnSync('opencode', ['--version'], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    });
    const stdout = typeof result.stdout === 'string' ? result.stdout.trim() : '';
    const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : '';

    if (result.error) {
      throw new Error(`could not execute 'opencode --version': ${result.error.message}`);
    }
    if (result.status !== 0) {
      throw new Error(
        `'opencode --version' exited with status ${result.status}${stderr ? `: ${stderr}` : ''}`,
      );
    }

    const reportedVersion = stdout || stderr;
    const versionMatch = reportedVersion.match(/v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
    const installedVersion = (versionMatch?.[1] ?? reportedVersion.replace(/^v/, '')).trim();
    const normalizedExpectedVersion = expectedVersion.replace(/^v/, '');
    if (!installedVersion || installedVersion !== normalizedExpectedVersion) {
      throw new Error(
        `expected OpenCode ${normalizedExpectedVersion}, but 'opencode --version' reported '${reportedVersion || '<empty>'}'`,
      );
    }
  }

  resolveModel(rawModel: string): string {
    // OpenCode consumes the full `provider/model` string verbatim.
    return rawModel;
  }

  buildEnvironment(options: ReviewRuntimeOptions): NodeJS.ProcessEnv {
    // Unlike `ClaudeCodeRuntime`, this runtime deliberately spreads
    // `process.env` so the opencode CLI inherits PATH (the spawn
    // calls `opencode` as a bare command, so the OS resolves it via
    // PATH) and HOME (opencode reads `~/.config/opencode` and
    // similar paths under the user's home dir). The allow-list
    // filter that strips workflow secrets is the Claude Code
    // runtime's defense-in-depth; this runtime does not need it
    // because opencode itself is read-only-by-config (the
    // OPENCODE_PERMISSION deny-list below) and any secret in the
    // env is gated by the opencode config, not the env block.
    //
    // Strip inherited OPENCODE_* entries first so a stale parent
    // env does not leak an endpoint / token override past the
    // merged config. The runtime then re-adds OPENCODE_CONFIG /
    // OPENCODE_PERMISSION below; HOME / PATH (and everything else)
    // are preserved.
    const env = { ...process.env };
    for (const name of Object.keys(env)) {
      if (name.startsWith('OPENCODE_')) {
        delete env[name];
      }
    }
    if (options.configPath) {
      env.OPENCODE_CONFIG = options.configPath;
    }
    if (options.homeDir) {
      fs.mkdirSync(options.homeDir, { recursive: true, mode: 0o700 });
      env.HOME = options.homeDir;
    }
    env.OPENCODE_PERMISSION = JSON.stringify({
      read: 'deny',
      glob: 'deny',
      grep: 'deny',
      list: 'deny',
      webfetch: 'deny',
      edit: 'deny',
      write: 'deny',
      question: 'deny',
      doom_loop: 'deny',
      bash: {
        // The action embeds a pathspec-filtered diff in the reviewer
        // prompt (see REVIEW_DIFF_EXCLUDE_PATHSPECS in main.ts).
        // `git diff` and `git show` are denied so the model cannot
        // bypass that filter by re-fetching the raw diff via bash
        // (which would otherwise expose the auto-generated dist
        // bundles that the filter intentionally excludes).
        '*': 'ask',
        'git log *': 'allow',
        'git rev-parse *': 'allow',
      },
    });
    return env;
  }

  commandArgs(model: string, prompt: string, useStdin: boolean): string[] {
    // When `useStdin` is true, the orchestrator writes the prompt
    // to `proc.stdin`; the runtime substitutes `-` as the
    // positional arg. This avoids the OS `ARG_MAX` (`E2BIG` on
    // Linux) failure that hits when a reviewer prompt + embedded
    // diff exceeds the argv limit.
    if (useStdin) {
      return [
        `--model=${model}`,
        'run',
        '--format=json',
        '-',
      ];
    }
    return [
      `--model=${model}`,
      'run',
      '--format=json',
      '--',
      prompt,
    ];
  }

  parseEvents(stdout: string, stdoutPath: string, stderrPath: string): ReviewRuntimeResult {
    const parts: unknown[] = [];
    let finalStepFinish: { event: Record<string, unknown>; part: Record<string, unknown> } | undefined;

    for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
      let parsed: OpenCodeEvent;
      try {
        parsed = JSON.parse(line) as OpenCodeEvent;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`could not parse OpenCode JSON event: ${message}; ${diagnostics(stdoutPath, stderrPath)}`);
      }

      const eventType = normalizeEventType(parsed.type);
      const partRecord = asRecord(parsed.part);
      const partType = normalizeEventType(partRecord?.type);
      const filteredType = eventType ?? partType;
      if (!filteredType || !EVENT_TYPES.has(filteredType)) {
        continue;
      }

      const normalized = normalizePart(parsed, filteredType);
      parts.push(normalized);
      if (filteredType === 'step_finish') {
        finalStepFinish = {
          event: asRecord(parsed) ?? {},
          part: normalized,
        };
      }
    }

    const selection = selectTerminalText(parts);
    const finalEvent = finalStepFinish?.event;
    const finalPart = finalStepFinish?.part;
    const cost = readNumber(finalEvent?.cost) ?? readNumber(finalPart?.cost) ?? 0;
    const tokens = finalStepFinish ? readTokens(finalEvent, finalPart) : { input: 0, output: 0 };

    return {
      text: selection.text,
      cost,
      tokens,
      model: '',
      parts,
    };
  }
}

// ---------------------------------------------------------------------------
// Back-compat entry point. Preserved so `validate-review` and existing
// tests can keep calling `runOpenCodeRun(options, runtime?)` directly.
// ---------------------------------------------------------------------------

/**
 * Run OpenCode as a one-shot CLI process and consume its line-delimited JSON
 * stream after the process exits. This deliberately avoids `opencode serve`:
 * the server can accept connections before plugin installation has finished
 * and then block the CI event loop.
 */
export async function runOpenCodeRun(
  options: RunOpenCodeRunOptions,
  runtime?: OpenCodeRunRuntime,
): Promise<RunOpenCodeRunResult> {
  return runReview(options, new OpenCodeRuntime(), runtime?.spawn);
}