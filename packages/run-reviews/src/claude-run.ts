/**
 * Claude Code CLI transport.
 *
 * Implements `ReviewRuntime` for the Claude Code CLI
 * (`claude -p --output-format stream-json ...`). The CLI streams NDJSON
 * events on stdout; the final event of type `result` carries the
 * canonical text via `result.result` along with cost and usage fields.
 *
 * Permission lockdown is hardcoded to match the read-only git subset
 * already enforced for opencode's `OPENCODE_PERMISSION` deny-list:
 *   - `--allowedTools` whitelists `Read`, `Glob`, `Grep`, the same
 *     `git diff/show/log/rev-parse` subset, and `query` (Claude Code's
 *     internal tool name for structured prompts / sub-queries). Tools
 *     not on this list are denied by Claude Code's permission system.
 *
 * We do NOT pass `--dangerously-skip-permissions`. With that flag the
 * permission system is bypassed entirely, and shell expansion in
 * `git diff <$(...)>` arguments would match the `Bash(git diff *)`
 * allowlist rule before the allowlist check fires — i.e. an RCE-shaped
 * path. Without the flag, the allowlist is enforced.
 */
import { spawnSync } from 'child_process';
import {
  diagnostics,
  runReview,
  type ReviewRuntime,
  type ReviewRuntimeOptions,
  type ReviewRuntimeResult,
  type ReviewRuntimeSpawn,
} from './runtime';

export interface RunClaudeRunOptions extends ReviewRuntimeOptions {}
export type RunClaudeRunResult = ReviewRuntimeResult;

// Read-only git subset mirrored from OpenCodeRuntime's OPENCODE_PERMISSION
// bash allow-list. Claude Code's `--allowedTools` syntax uses the same
// `<tool>(<pattern>)` shape for bash commands.
//
// `query` is intentionally NOT included. It is Claude Code's
// internal sub-query / sub-agent tool that lets the model delegate
// to a child agent. Code review does not need sub-agents (that's an
// interactive feature), and a sub-agent hop is exactly where the
// read-only boundary breaks down: the child agent inherits the
// parent's effective permission scope, but the boundary on
// `--allowedTools` is enforced at the parent invocation, not in
// the child. Keeping `query` out of the allow-list forces the model
// to do the read-only work itself.
const CLAUDE_ALLOWED_TOOLS = [
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

function readUsageTokens(usage: ClaudeUsage | undefined): ReviewRuntimeResult['tokens'] {
  if (!usage) {
    return { input: 0, output: 0 };
  }
  const input = readNumber(usage.input_tokens) ?? 0;
  const output = readNumber(usage.output_tokens) ?? 0;
  // Prefer an explicit reasoning_tokens field when present; otherwise
  // fall back to cache_read_input_tokens as the best-available proxy for
  // cached/reused reasoning work that the CLI may report there.
  const reasoning =
    readNumber(usage.reasoning_tokens) ?? readNumber(usage.cache_read_input_tokens);
  return reasoning === undefined ? { input, output } : { input, output, reasoning };
}

/**
 * Implements the Claude Code CLI transport. Mirrors the opencode surface
 * so the dispatcher in `./opencode.ts` can pick one at runtime.
 */
export class ClaudeCodeRuntime implements ReviewRuntime {
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
    if (!expectedVersion) {
      return;
    }

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

  resolveModel(rawModel: string): string {
    // Claude Code's `--model` flag does not consume the OpenCode-style
    // `provider/model` form; the dispatcher strips the provider portion
    // here so the caller's full string is still preserved on the result
    // for downstream accounting.
    const slashIndex = rawModel.indexOf('/');
    if (slashIndex <= 0) {
      throw new Error(
        `tool=claude requires model in 'provider/model' format; got '${rawModel}'`,
      );
    }
    return rawModel.slice(slashIndex + 1);
  }

  buildEnvironment(_options: ReviewRuntimeOptions): NodeJS.ProcessEnv {
    // Build the env from an explicit allow-list rather than
    // spreading `process.env`. Spreading `process.env` forwards
    // every workflow secret (GITHUB_TOKEN, AWS_*, MINIMAX_API_KEY,
    // etc.) to the CLI — the review only needs the allow-listed
    // keys below to route through the Anthropic-compatible
    // endpoint.
    //
    // The action layer is the source of truth for endpoint
    // configuration: it sets the Anthropic + CLAUDE_* keys via
    // the workflow `env:` block (see `.github/workflows/ai-review.yml`)
    // and any override happens there. The runtime does not need to
    // consult `process.env` for arbitrary entries.
    //
    // `ANTHROPIC_API_KEY` is conditional: only force-empty when
    // `ANTHROPIC_BASE_URL` is set (third-party routing, e.g.
    // Minimax). When routing through a third-party Anthropic-
    // compatible endpoint, the auth comes via
    // `ANTHROPIC_AUTH_TOKEN` (Bearer); the empty string
    // suppresses Claude Code's OAuth fallback. Standard
    // Anthropic users (no `ANTHROPIC_BASE_URL`) get their real
    // `ANTHROPIC_API_KEY` passed through so the CLI's normal
    // auth flow works. See project memory #188.
    //
    // `PATH` is intentionally in the allow-list: the spawn calls
    // `claude` (a bare command, not an absolute path), so the OS
    // looks it up via `PATH`. Without `PATH` the spawn fails with
    // `ENOENT`. `PATH` is the OS lookup path, not a secret — it
    // carries the directory list, not credentials. Fall back to a
    // POSIX-style default if the parent env somehow lost it so the
    // spawn still finds `/usr/bin/claude` on a minimal runner.
    return {
      ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL ?? '',
      ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN ?? '',
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_BASE_URL
        ? ''
        : (process.env.ANTHROPIC_API_KEY ?? ''),
      ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL ?? '',
      CLAUDE_ENABLE_BYTE_WATCHDOG: '0',
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    };
  }

  commandArgs(model: string, prompt: string, useStdin: boolean): string[] {
    const args: string[] = ['-p'];
    for (const toolName of CLAUDE_ALLOWED_TOOLS) {
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
    // Linux) failure that hits when a reviewer prompt + embedded
    // diff exceeds the argv limit. Claude Code's `-` sentinel
    // reads the prompt from stdin.
    if (useStdin) {
      args.push('-');
    } else {
      args.push('--', prompt);
    }
    return args;
  }

  parseEvents(stdout: string, stdoutPath: string, stderrPath: string): ReviewRuntimeResult {
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
      model: '',
      parts,
    };
  }
}

/**
 * Back-compat entry point. Mirrors `runOpenCodeRun` so callers can
 * invoke the Claude Code CLI transport directly without going through
 * the dispatcher.
 */
export async function runClaudeRun(
  options: RunClaudeRunOptions,
  runtime?: ReviewRuntimeSpawn,
): Promise<RunClaudeRunResult> {
  return runReview(options, new ClaudeCodeRuntime(), runtime?.spawn);
}