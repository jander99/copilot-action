import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { VALIDATOR_AGENT_PROMPT_TEMPLATE } from '@jander99/ai-review-review-contract';
import { runOpenCodeRun } from '@jander99/ai-review-run-reviews';
import { validateReviewDocument } from './structure';
import { runClaudeValidator, type ClaudeCodeValidatorRuntime } from './claude-validate';

export type ValidatorTool = 'opencode' | 'claude';
export type { ClaudeCodeValidatorRuntime };

const DEFAULT_OPENCODE_VERSION = '1.18.4';
const DEFAULT_TIMEOUT_MINUTES = 5;
const VALIDATOR_PERMISSION = {
  read: 'deny',
  glob: 'deny',
  grep: 'deny',
  list: 'deny',
  webfetch: 'deny',
  edit: 'deny',
  question: 'deny',
  doom_loop: 'deny',
  bash: 'deny',
} as const;
const FAILURE_REASON_MAX_CHARS = 1024;
const FAILURE_REASON_ELLIPSIS = '...';

function capReason(message: string): string {
  if (message.length <= FAILURE_REASON_MAX_CHARS) {
    return message;
  }
  const keep = FAILURE_REASON_MAX_CHARS - FAILURE_REASON_ELLIPSIS.length;
  return `${message.slice(0, keep)}${FAILURE_REASON_ELLIPSIS}`;
}

function stripThinkingBlocks(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '');
}

function assertOpenCodeVersion(expectedVersion: string): void {
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

function readReviewFile(reviewPath: string): string {
  if (!fs.existsSync(reviewPath)) {
    throw new Error(`review file not found at ${reviewPath}`);
  }
  const content = fs.readFileSync(reviewPath, 'utf8');
  if (!content.trim()) {
    throw new Error(`review file at ${reviewPath} is empty`);
  }
  return content;
}

interface InvokeValidatorOptions {
  reviewPath: string;
  reviewContent: string;
  model: string;
  timeoutMinutes: number;
  passedConfigJson: string;
}

interface InvokeValidatorResult {
  text: string;
  tokens: { input: number; output: number };
  cost: number;
}

function invokeValidator(options: InvokeValidatorOptions): Promise<InvokeValidatorResult> {
  const runnerTemp = process.env.RUNNER_TEMP ?? os.tmpdir();
  const homeDir = fs.mkdtempSync(path.join(runnerTemp, 'ai-review-validate-'));
  fs.chmodSync(homeDir, 0o700);

  const prompt = VALIDATOR_AGENT_PROMPT_TEMPLATE
    .replace('__REVIEW_PATH__', options.reviewPath)
    .concat('\n\n---\n\nReview file contents:\n\n', options.reviewContent);

  let baseConfig: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(options.passedConfigJson) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      baseConfig = parsed as Record<string, unknown>;
    } else {
      throw new Error('passed config is not a JSON object');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to parse passed OpenCode config: ${message}`);
  }

  if (baseConfig.__validator__ !== true) {
    throw new Error(
      'passed config is not a validator-only config (missing __validator__: true marker)',
    );
  }

  const provider =
    baseConfig.provider && typeof baseConfig.provider === 'object' && !Array.isArray(baseConfig.provider)
      ? (baseConfig.provider as Record<string, unknown>)
      : {};

  const mergedConfig = {
    provider,
    agent: {
      validator: {
        description: 'Validates the structural shape of a review markdown file.',
        mode: 'primary' as const,
        prompt,
      },
    },
    default_agent: 'validator',
    model: options.model,
    permission: VALIDATOR_PERMISSION,
  };

  const configPath = path.join(homeDir, 'opencode.json');
  fs.writeFileSync(configPath, JSON.stringify(mergedConfig, null, 2), 'utf8');

  return runOpenCodeRun({
    configPath,
    homeDir,
    model: options.model,
    prompt,
    timeoutMinutes: options.timeoutMinutes,
    disableTools: true,
    // No `passthroughEnv` is threaded through here on purpose: the
    // opencode path inherits `PATH` from `process.env` via
    // `OpenCodeRuntime.buildEnvironment` (which spreads
    // `process.env` and only strips `OPENCODE_*` entries), so the
    // spawn finds the `opencode` binary on PATH without any extra
    // plumbing. The validator's claude path uses a separate
    // passthrough env because `ClaudeCodeValidatorRuntime` builds
    // a scoped allow-list and does NOT spread `process.env`.
  }).then((result) => ({
    text: result.text.trim(),
    tokens: { input: result.tokens.input, output: result.tokens.output },
    cost: result.cost,
  }));
}

export function parseValidatorResponse(text: string): { status: 'valid' | 'invalid'; reason: string } {
  const cleaned = stripThinkingBlocks(text);
  const firstLine = cleaned.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? '';
  if (firstLine === 'VALID') {
    return { status: 'valid', reason: '' };
  }
  if (firstLine.startsWith('INVALID')) {
    const reason = firstLine.slice('INVALID'.length).trim() || 'unspecified';
    return { status: 'invalid', reason };
  }
  return {
    status: 'invalid',
    reason: `validator response did not start with VALID or INVALID: ${firstLine.slice(0, 200)}`,
  };
}

/**
 * Options consumed by the programmatic validator. Callers MUST supply
 * every input as a field on this object; the function does not
 * touch `core` directly.
 */
export interface ValidateReviewOptions {
  /**
   * Review runtime CLI to invoke. `'opencode'` (default) uses the
   * OpenCode CLI; `'claude'` uses the Claude Code CLI. The default
   * preserves the package's pre-doubling behavior (always OpenCode);
   * callers from the root action should always pass this through so
   * `tool: claude` reviews don't silently leak into the opencode
   * validator.
   */
  tool?: ValidatorTool;
  opencodeVersion: string;
  reviewPath: string;
  model: string;
  timeoutMinutes: number;
  passedConfigJson: string;
  /**
   * Env vars to layer on top of `process.env` when spawning the
   * Claude Code CLI for validation. The action layer uses this to
   * forward `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`,
   * `ANTHROPIC_API_KEY=""`, the `CLAUDE_ENABLE_BYTE_WATCHDOG=0` /
   * `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` flags, and any other
   * Anthropic-compatible endpoint config. Ignored when
   * `tool === 'opencode'` (the opencode path strips env itself).
   */
  passthroughEnv?: NodeJS.ProcessEnv;
}

/**
 * Result of the programmatic validator. Mirrors the action outputs
 * so the standalone action wrapper can write them via
 * `core.setOutput` and the root action can use them as plain fields.
 */
export interface ValidateReviewResult {
  status: 'valid' | 'invalid';
  reason: string;
  cost: number;
  tokens: { input: number; output: number };
  failureReason: string;
}

const EMPTY_RESULT: ValidateReviewResult = {
  status: 'invalid',
  reason: '',
  cost: 0,
  tokens: { input: 0, output: 0 },
  failureReason: '',
};

export async function validateReview(options: ValidateReviewOptions): Promise<ValidateReviewResult> {
  const tool: ValidatorTool = options.tool ?? 'opencode';

  // Shared input validation: review-path and timeout apply to both
  // runtimes. `passedConfigJson` only applies to the opencode path
  // (the claude path doesn't read it) but we keep the existing check
  // here for back-compat with callers that pre-date the doubling.
  if (!options.reviewPath) {
    const reason = 'review-path input is required';
    return {
      ...EMPTY_RESULT,
      reason: capReason(reason),
      failureReason: reason,
    };
  }

  if (!Number.isFinite(options.timeoutMinutes) || options.timeoutMinutes <= 0) {
    const reason = 'timeout-minutes must be a positive integer';
    return {
      ...EMPTY_RESULT,
      reason: capReason(reason),
      failureReason: reason,
    };
  }

  if (tool === 'opencode' && !options.passedConfigJson) {
    const reason = 'config-json input is required (resolved validator-only OpenCode config from run-reviews)';
    return {
      ...EMPTY_RESULT,
      reason: capReason(reason),
      failureReason: reason,
    };
  }

  // Read the review file up front so both runtimes share the same
  // not-found / empty / structural-rejection path before any CLI is
  // spawned.
  let reviewContent: string;
  try {
    reviewContent = readReviewFile(options.reviewPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...EMPTY_RESULT,
      reason: capReason(message),
      failureReason: `Cannot read review file: ${message}`,
    };
  }

  const structural = validateReviewDocument(reviewContent);
  if (!structural.valid) {
    return {
      ...EMPTY_RESULT,
      reason: capReason(structural.reason),
      failureReason: `Review failed structural validation: ${structural.reason}`,
    };
  }

  if (tool === 'claude') {
    return runClaudeValidation(options, reviewContent);
  }

  return runOpencodeValidation(options, reviewContent);
}

/**
 * Shared post-spawn path: invoke the chosen CLI, parse the
 * `VALID` / `INVALID <reason>` response via
 * `parseValidatorResponse`, and shape the result.
 */
function shapeResult(
  result: InvokeValidatorResult,
): ValidateReviewResult {
  const verdict = parseValidatorResponse(result.text);
  return {
    status: verdict.status,
    reason: capReason(verdict.reason),
    cost: result.cost,
    tokens: result.tokens,
    failureReason: verdict.status === 'invalid' ? `Review validation failed: ${verdict.reason}` : '',
  };
}

function runOpencodeValidation(
  options: ValidateReviewOptions,
  reviewContent: string,
): Promise<ValidateReviewResult> {
  // OpenCode version assertion only runs on the opencode path.
  // The claude path's binary check happens inside `runClaudeValidator`
  // (via the runtime's `assertVersion`); it's a separate concern from
  // the opencode semver pin.
  try {
    assertOpenCodeVersion(options.opencodeVersion);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Promise.resolve({
      ...EMPTY_RESULT,
      reason: capReason(`OpenCode version assertion failed: ${message}`),
      failureReason: `OpenCode version assertion failed: ${message}`,
    });
  }

  return invokeValidator({
    reviewPath: options.reviewPath,
    reviewContent,
    model: options.model,
    timeoutMinutes: options.timeoutMinutes,
    passedConfigJson: options.passedConfigJson,
  })
    .then(shapeResult)
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ...EMPTY_RESULT,
        reason: capReason(`validator invocation failed: ${message}`),
        failureReason: `Validator invocation failed: ${message}`,
      };
    });
}

function runClaudeValidation(
  options: ValidateReviewOptions,
  reviewContent: string,
): Promise<ValidateReviewResult> {
  // The validator's prompt template is review-content-agnostic: it
  // asks the model to validate a structural contract. For the
  // claude runtime the prompt goes verbatim into `claude -p --`;
  // we don't need a temp config file (the opencode path writes one)
  // because claude reads from its env / per-process config, not from
  // a generated `opencode.json`.
  const prompt = VALIDATOR_AGENT_PROMPT_TEMPLATE
    .replace('__REVIEW_PATH__', options.reviewPath)
    .concat('\n\n---\n\nReview file contents:\n\n', reviewContent);

  return runClaudeValidator({
    prompt,
    model: options.model,
    timeoutMinutes: options.timeoutMinutes,
    passthroughEnv: options.passthroughEnv,
  })
    .then(shapeResult)
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ...EMPTY_RESULT,
        reason: capReason(`validator invocation failed: ${message}`),
        failureReason: `Validator invocation failed: ${message}`,
      };
    });
}