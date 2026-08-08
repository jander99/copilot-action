import * as core from '@actions/core';
import { context } from '@actions/github';
import { runReviews } from '@jander99/ai-review-run-reviews';
import type { RunReviewsOptions, RunReviewsResult, ReviewTool } from '@jander99/ai-review-run-reviews';
import { validateReview } from '@jander99/ai-review-validate-review';
import type { ValidateReviewOptions, ValidateReviewResult } from '@jander99/ai-review-validate-review';
import { postComment } from '@jander99/ai-review-post-comment';
import type { PostCommentOptions, PostCommentResult } from '@jander99/ai-review-post-comment';
import { postCheckRun } from '@jander99/ai-review-post-check-run';
import type { PostCheckRunOptions, PostCheckRunResult } from '@jander99/ai-review-post-check-run';
import { postErrorComment } from '@jander99/ai-review-post-error-comment';
import type { PostErrorCommentOptions, PostErrorCommentResult } from '@jander99/ai-review-post-error-comment';
import { DEFAULT_PERMISSION } from '@jander99/ai-review-run-reviews/permissions';

// The compiled run-reviews dist embeds the DEFAULT_PERMISSION. Importing
// the pure source instead of the dist keeps the bundle small and lets
// us share the typed value without going through node:fs at runtime.
// (See packages/run-reviews/src/permissions.ts for the source of truth.)
//
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _DEFAULT_PERMISSION_SHAPE = DEFAULT_PERMISSION;

const DEFAULT_OPENCODE_VERSION = '1.18.4';
const DEFAULT_MODEL = 'anthropic/claude-sonnet-4.6';
const DEFAULT_TIMEOUT_MINUTES = 30;

// Empty RunReviewsResult used when runReviews throws. The run() flow
// converts any thrown error into a synthetic failure-reason so the
// orchestration can still post an error comment instead of silently
// failing.
const EMPTY_REVIEW_RESULT: RunReviewsResult = {
  review: '',
  reviewOutputPath: '',
  modelsUsed: '',
  cost: 0,
  costByModel: {},
  tokens: { input: 0, output: 0 },
  tokensByModel: {},
  configJson: '',
  effectiveModel: '',
  debugArtifactPath: '',
  failureReason: '',
  rejectedDocuments: [],
};

// Single source of truth for the missing-token warning. Surfaced as
// a `core.warning` at the top of `runWithDeps` when neither the
// `github-token` input nor `process.env.GITHUB_TOKEN` resolves, and
// again inside every publish path that would otherwise silently
// no-op (best-effort `postErrorComment` / `postCheckRun` callers
// already swallow API failures; we now log why up front).
const MISSING_GITHUB_TOKEN_WARNING =
  'github-token is not available; review and error comments/check-runs will not be published. Pass github-token: ${{ github.token }} to the action.';

/**
 * Resolve the GitHub token used by every publish call. Centralizing
 * the resolution (input + env fallback) lets us emit the
 * missing-token warning exactly once and lets `publishError` /
 * `publishReview` skip the GitHub API cleanly when the token is
 * absent instead of silently swallowing 401s.
 */
function resolveGithubToken(): string {
  return core.getInput('github-token') || process.env.GITHUB_TOKEN || '';
}

function getBooleanInput(name: string, fallback = false): boolean {
  const raw = core.getInput(name).trim().toLowerCase();
  if (raw === '') {
    return fallback;
  }
  if (['true', '1', 'yes'].includes(raw)) {
    return true;
  }
  if (['false', '0', 'no'].includes(raw)) {
    return false;
  }
  throw new Error(
    `Input does not meet boolean specification for '${name}': '${raw}'. Expected true|false.`,
  );
}

function getIntInput(name: string, fallback: number): number {
  const raw = core.getInput(name).trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer (received '${raw}')`);
  }
  return parsed;
}

function readPermissionInput(): typeof DEFAULT_PERMISSION {
  const raw = core.getInput('permission');
  if (!raw) {
    return { ...DEFAULT_PERMISSION };
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('permission must be a JSON object');
  }
  return parsed as typeof DEFAULT_PERMISSION;
}

function roundCost(value: number): string {
  return (Math.round(value * 1e6) / 1e6).toString();
}

function buildRunReviewsOptions(): RunReviewsOptions {
  // `tool` is read once at the wrapper boundary; an invalid value
  // raises here (before runReviews is invoked) so the action log
  // surfaces the typo cleanly instead of the runtime failing later.
  const rawTool = (core.getInput('tool') || 'opencode').trim().toLowerCase();
  if (rawTool !== 'opencode' && rawTool !== 'claude') {
    throw new Error(
      `tool input must be 'opencode' or 'claude'; received '${core.getInput('tool') || '<empty>'}'`,
    );
  }
  const tool: ReviewTool = rawTool === 'claude' ? 'claude' : 'opencode';
  return {
    tool,
    opencodeVersion: core.getInput('opencode-version') || DEFAULT_OPENCODE_VERSION,
    claudeVersion: core.getInput('claude-version') || undefined,
    debug: getBooleanInput('debug'),
    model: core.getInput('model') || DEFAULT_MODEL,
    modelsInput: core.getInput('models'),
    failOnError: getBooleanInput('fail-on-error'),
    timeoutMinutes: getIntInput('timeout-minutes', DEFAULT_TIMEOUT_MINUTES),
    prompts: core.getInput('prompts'),
    permission: readPermissionInput(),
    userConfig: core.getInput('opencode-config') || undefined,
    githubToken: core.getInput('github-token') || process.env.GITHUB_TOKEN,
  };
}

/**
 * Build the env block the validator's claude runtime needs. Mirrors
 * the env block the reviewer uses for its claude invocation (see the
 * `review-claude` job in `.github/workflows/ai-review.yml`): when the
 * claude binary is routed through Minimax's Anthropic-compatible
 * endpoint, three switches make it work — an empty
 * `ANTHROPIC_API_KEY` suppresses Claude Code's OAuth fallback, an
 * `ANTHROPIC_AUTH_TOKEN` carries the Bearer credential the endpoint
 * expects, and the two `CLAUDE_*` flags disable experimental beta
 * headers and the byte-level streaming watchdog Minimax rejects.
 *
 * Centralizing the env here (rather than hardcoding it in the
 * validator package) keeps the action layer as the single source
 * of truth for how to reach the model endpoint. Callers that don't
 * pass these vars get the original `process.env` via
 * `runClaudeValidator`'s pass-through merge.
 */
function buildClaudePassthroughEnv(): NodeJS.ProcessEnv {
  return {
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL ?? '',
    ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN ?? '',
    // Set to empty string (NOT unset) so Claude Code CLI's OAuth
    // fallback is suppressed and the endpoint routes via
    // ANTHROPIC_AUTH_TOKEN. See project memory #188.
    ANTHROPIC_API_KEY: '',
    CLAUDE_ENABLE_BYTE_WATCHDOG: '0',
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
  };
}

function buildValidateReviewOptions(
  reviewPath: string,
  model: string,
  passedConfigJson: string,
  tool: ReviewTool,
): ValidateReviewOptions {
  // `tool` is plumbed through from `RunReviewsOptions.tool` (set by
  // the reviewer's own input parsing) so the validator runtime
  // matches the reviewer's runtime. The reviewer routes through
  // opencode when tool=opencode and claude when tool=claude; the
  // validator now does the same instead of always running opencode.
  //
  // The passthroughEnv is built unconditionally so the
  // `opencode` path is byte-identical to the pre-doubling behavior
  // (the opencode runtime ignores it) AND the `claude` path gets
  // the env it needs without the action layer having to branch on
  // tool.
  return {
    tool,
    opencodeVersion: core.getInput('opencode-version') || DEFAULT_OPENCODE_VERSION,
    reviewPath,
    model,
    timeoutMinutes: 5,
    passedConfigJson,
    passthroughEnv: buildClaudePassthroughEnv(),
  };
}

function buildPostCommentOptions(review: string, maxChars: number): PostCommentOptions {
  return {
    token: core.getInput('github-token') || process.env.GITHUB_TOKEN,
    review,
    postComment: getBooleanInput('post-comment', true),
    maxChars,
  };
}

function buildPostCheckRunOptions(review: string, name: string, conclusion: string, detailsUrl: string): PostCheckRunOptions {
  return {
    token: core.getInput('github-token') || process.env.GITHUB_TOKEN,
    review,
    name,
    conclusion,
    detailsUrl,
    headSha: process.env.GITHUB_SHA ?? '',
    owner: context.repo.owner,
    repo: context.repo.repo,
  };
}

function buildPostErrorCommentOptions(reason: string, maxChars: number): PostErrorCommentOptions {
  return {
    token: core.getInput('github-token') || process.env.GITHUB_TOKEN,
    reason,
    postComment: getBooleanInput('post-comment', true),
    maxChars,
    title: 'AI Review validator rejected the generated review.',
  };
}

/**
 * Compute the canonical failure-reason string from the reviewer
 * and validator results. The output covers BOTH reviewer failures
 * (which usually prevent the validator from running) and validator
 * failures (which happen when the reviewer succeeded but produced
 * a document that did not pass structural + model validation).
 *
 * Reviewer failures win over validator failures: if the reviewer
 * failed, the validator typically was skipped, so the validator's
 * message is either empty or a misleading "validation skipped" line.
 */
function computeFailureReason(
  reviewerFailureReason: string,
  validatorFailureReason: string,
): string {
  if (reviewerFailureReason) {
    return reviewerFailureReason;
  }
  if (validatorFailureReason) {
    return `Validator: ${validatorFailureReason}`;
  }
  return '';
}

/**
 * Build a synthetic invalid validation result when the validator
 * invocation throws. This mirrors the shape returned by the
 * validate-review package and is what the publish-error helper
 * expects so the error comment can be posted with the throw message.
 */
function buildSyntheticInvalidValidation(message: string, prefix: string): ValidateReviewResult {
  return {
    status: 'invalid',
    reason: message,
    cost: 0,
    tokens: { input: 0, output: 0 },
    failureReason: `${prefix}: ${message}`,
  };
}

/**
 * Mutable dependency bag for the orchestration. Exported so tests
 * can stub individual methods via `mock.method` from `node:test`,
 * and so the same object backs the default `run()` entrypoint and
 * any future call sites that want to override one specific dep
 * without going through `runWithDeps`.
 */
export interface RunDeps {
  runReviews(options: RunReviewsOptions): Promise<RunReviewsResult>;
  validateReview(options: ValidateReviewOptions): Promise<ValidateReviewResult>;
  postComment(
    options: PostCommentOptions,
    ctx: { owner: string; repo: string; issueNumber: number },
  ): Promise<PostCommentResult>;
  postCheckRun(options: PostCheckRunOptions): Promise<PostCheckRunResult>;
  postErrorComment(
    options: PostErrorCommentOptions,
    ctx: { owner: string; repo: string; issueNumber: number },
  ): Promise<PostErrorCommentResult>;
}

export const runDeps: RunDeps = {
  runReviews,
  validateReview,
  postComment,
  postCheckRun,
  postErrorComment,
};

interface PublishContext {
  eventName: string;
  owner: string;
  repo: string;
  issueNumber: number;
  maxCommentChars: number;
  postCommentEnabled: boolean;
  postCheckRunEnabled: boolean;
  checkName: string;
  checkDetailsUrl: string;
  /**
   * Resolved GitHub token. When empty, every publish call must
   * skip the GitHub API and surface a `core.warning` explaining
   * why instead of silently swallowing the failure inside the
   * best-effort wrappers.
   */
  githubToken: string;
}

function buildPublishContext(githubToken: string): PublishContext {
  return {
    eventName: process.env.GITHUB_EVENT_NAME || '',
    owner: context.repo.owner,
    repo: context.repo.repo,
    issueNumber: context.issue.number,
    maxCommentChars: getIntInput('max-comment-chars', 65000),
    postCommentEnabled: getBooleanInput('post-comment', true),
    postCheckRunEnabled: getBooleanInput('post-check-run', true),
    checkName: core.getInput('check-name') || 'ai-review',
    checkDetailsUrl: core.getInput('check-details-url') || 'https://github.com',
    githubToken,
  };
}

/**
 * Post an event-aware error comment / failure check run. Used by
 * BOTH the existing runFailed/validationInvalid path and the new
 * exception path (runReviews throw, validateReview throw, or any
 * other unhandled throw caught by the entrypoint's `.catch`).
 *
 * Always clears `comment-url` / `check-run-url` first so the
 * outputs reflect whichever publication channel fired (or none).
 * When the GitHub token is missing the API call is skipped (the
 * best-effort wrappers in post-error-comment / post-check-run
 * would otherwise swallow the resulting 401 silently); instead we
 * emit a `core.warning` with the missing-token message so the run
 * log explains why no comment / check run was published.
 */
async function publishError(reason: string, deps: RunDeps, ctx: PublishContext): Promise<void> {
  core.setOutput('comment-url', '');
  core.setOutput('check-run-url', '');

  if (!reason) {
    return;
  }

  if (!ctx.githubToken) {
    core.warning(MISSING_GITHUB_TOKEN_WARNING);
    return;
  }

  if (ctx.eventName === 'pull_request' && ctx.postCommentEnabled) {
    const commentResult: PostErrorCommentResult = await deps.postErrorComment(
      buildPostErrorCommentOptions(reason, ctx.maxCommentChars),
      {
        owner: ctx.owner,
        repo: ctx.repo,
        issueNumber: ctx.issueNumber,
      },
    );
    core.setOutput('comment-url', commentResult.commentUrl);
  } else if (ctx.eventName !== 'pull_request' && ctx.postCheckRunEnabled) {
    const checkResult: PostCheckRunResult = await deps.postCheckRun(
      buildPostCheckRunOptions(reason, ctx.checkName, 'failure', ctx.checkDetailsUrl),
    );
    core.setOutput('check-run-url', checkResult.checkRunUrl);
  }
}

/**
 * Programmatic orchestration entrypoint. Same flow as `run()` but
 * with the package APIs injected through `deps`. The default `run()`
 * entrypoint delegates here with the bundled `runDeps`.
 *
 * Every failure path (reviewer throw, reviewer invalid, validator
 * throw, validator invalid, all invalid) routes through
 * `publishError` so an error comment is posted on PR events or a
 * failure check run is created on non-PR events. The entrypoint's
 * `.catch` (in `run()`) is the final backstop and also calls
 * `publishError` so unhandled throws do not silently drop the
 * error publication.
 */
export async function runWithDeps(deps: RunDeps): Promise<void> {
  // Resolve the GitHub token once. When missing, surface the
  // warning BEFORE running the pipeline so the operator sees why
  // no review / error comment will land on the PR; subsequent
  // publish paths short-circuit cleanly instead of letting the
  // best-effort wrappers swallow a 401.
  const githubToken = resolveGithubToken();
  if (!githubToken) {
    core.warning(MISSING_GITHUB_TOKEN_WARNING);
  }
  const publishCtx = buildPublishContext(githubToken);
  const checkConclusion = core.getInput('check-conclusion') || 'neutral';
  const failOnError = getBooleanInput('fail-on-error');

  // 1. Run reviews. Catch any thrown error and convert it into a
  // synthetic failure-reason so the existing publish-error logic
  // still fires (previously the throw propagated past the catch
  // in `run()` and only `core.setFailed` ran, leaving the PR with
  // a red step but no error comment).
  const reviewOptions = buildRunReviewsOptions();
  let reviewResult: RunReviewsResult;
  try {
    reviewResult = await deps.runReviews(reviewOptions);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    reviewResult = { ...EMPTY_REVIEW_RESULT, failureReason: `Review invocation threw: ${message}` };
  }

  core.setOutput('review', reviewResult.review);
  core.setOutput('review-output-path', reviewResult.reviewOutputPath);
  core.setOutput('models-used', reviewResult.modelsUsed);
  core.setOutput('cost', reviewResult.cost);
  core.setOutput('cost-by-model', JSON.stringify(reviewResult.costByModel));
  core.setOutput('tokens', JSON.stringify(reviewResult.tokens));
  core.setOutput('tokens-by-model', JSON.stringify(reviewResult.tokensByModel));
  core.setOutput('effective-model', reviewResult.effectiveModel);
  core.setOutput('config-json', reviewResult.configJson);
  if (reviewResult.debugArtifactPath) {
    core.setOutput('debug-artifact-path', reviewResult.debugArtifactPath);
  }

  // 2. Validate the review when one was produced. Same try/catch
  // shape as the reviewer call: a thrown validator invocation now
  // surfaces as an invalid validation result with the throw message
  // so the publish-error logic posts a comment.
  let validation: ValidateReviewResult | null = null;
  if (reviewResult.review) {
    try {
      validation = await deps.validateReview(
        buildValidateReviewOptions(
          reviewResult.reviewOutputPath,
          reviewResult.effectiveModel || reviewOptions.model,
          reviewResult.configJson,
          reviewOptions.tool,
        ),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      validation = buildSyntheticInvalidValidation(message, 'Validator invocation threw');
    }
    core.setOutput('validate-status', validation.status);
    core.setOutput('validate-reason', validation.reason);
    core.setOutput('validate-cost', validation.cost);
    core.setOutput('validate-tokens', JSON.stringify(validation.tokens));
  } else {
    core.setOutput('validate-status', '');
    core.setOutput('validate-reason', '');
    core.setOutput('validate-cost', 0);
    core.setOutput('validate-tokens', JSON.stringify({ input: 0, output: 0 }));
  }

  // 3. Compute total-cost (reviewer + validator) and expose it.
  const totalCost = reviewResult.cost + (validation?.cost ?? 0);
  core.setOutput('total-cost', totalCost);
  core.info(`total-cost=${roundCost(totalCost)}`);

  // 4. The single canonical failure-reason output. Covers BOTH
  // reviewer and validator failures.
  const failureReason = computeFailureReason(
    reviewResult.failureReason,
    validation?.failureReason ?? '',
  );
  core.setOutput('failure-reason', failureReason);

  // 5. Determine whether to publish or surface an error.
  const reviewerFailureReason = reviewResult.failureReason;
  const errorReason =
    validation?.reason ||
    (reviewerFailureReason ? `review failed before producing a document: ${reviewerFailureReason}` : '');
  const validationInvalid = validation?.status === 'invalid';
  const runFailed = !reviewResult.review && Boolean(reviewerFailureReason);
  const shouldPublishError = validationInvalid || runFailed;

  if (!shouldPublishError && reviewResult.review) {
    core.setOutput('comment-url', '');
    core.setOutput('check-run-url', '');
    if (!publishCtx.githubToken) {
      // Surface the missing-token warning on the success path too:
      // a valid review is no good to anyone if it never lands on
      // the PR / check run.
      core.warning(MISSING_GITHUB_TOKEN_WARNING);
    } else if (publishCtx.eventName === 'pull_request' && publishCtx.postCommentEnabled) {
      const commentResult: PostCommentResult = await deps.postComment(
        buildPostCommentOptions(reviewResult.review, publishCtx.maxCommentChars),
        {
          owner: publishCtx.owner,
          repo: publishCtx.repo,
          issueNumber: publishCtx.issueNumber,
        },
      );
      core.setOutput('comment-url', commentResult.commentUrl);
    } else if (publishCtx.eventName !== 'pull_request' && publishCtx.postCheckRunEnabled) {
      const checkResult: PostCheckRunResult = await deps.postCheckRun(
        buildPostCheckRunOptions(
          reviewResult.review,
          publishCtx.checkName,
          checkConclusion,
          publishCtx.checkDetailsUrl,
        ),
      );
      core.setOutput('check-run-url', checkResult.checkRunUrl);
    }
  } else if (shouldPublishError && errorReason) {
    // Covers reviewer throw (caught above -> failureReason set ->
    // runFailed true), reviewer produced no document, and validator
    // throw / invalid. Always routes through `publishError` so the
    // helper is the single source of truth for error publication.
    await publishError(errorReason, deps, publishCtx);
  } else {
    core.setOutput('comment-url', '');
    core.setOutput('check-run-url', '');
  }

  // 6. Surface diagnostic previews of model documents rejected by
  // the deterministic contract validator. The previews are
  // sanitized (orphan-tag stripped) and bounded to
  // REJECTED_DOCUMENT_PREVIEW_MAX_CHARS per entry on the
  // run-reviews side; the orchestrator just emits one
  // `core.warning` per entry so operators can see the offending
  // content in the run log without leaking it back into prompts.
  for (const entry of reviewResult.rejectedDocuments) {
    core.warning(
      `Rejected document preview (model=${entry.model}, reason=${entry.reason}):\n${entry.preview}`,
    );
  }

  // 7. Surface the step's final status.
  const hasFailure = Boolean(reviewerFailureReason) || validationInvalid || runFailed;
  if (hasFailure) {
    const finalMessage = reviewerFailureReason
      ? `Review failed: ${reviewerFailureReason}`
      : `Review validation failed: ${validation?.reason || 'unspecified'}`;
    core.setFailed(finalMessage);
  } else if (failOnError && reviewerFailureReason) {
    core.setFailed(reviewerFailureReason);
  }
}

export async function run(): Promise<void> {
  return runWithDeps(runDeps);
}

// Top-level entrypoint. Gated on `require.main === module` so
// importing this bundle as a library (e.g., by tests) does not
// trigger the action.
if (require.main === module) {
  run().catch(async (error) => {
    const message = error instanceof Error ? error.message : String(error);
    const reason = `Root action failed: ${message}`;
    // Best-effort: also post an error comment / failure check run.
    // This is the final backstop: any throw that escapes the inner
    // try/catches (e.g. malformed permission JSON, unknown boolean
    // input value) still surfaces on the PR. Token is resolved
    // fresh so a missing-token warning is logged even on this
    // backstop path.
    try {
      const githubToken = resolveGithubToken();
      if (!githubToken) {
        core.warning(MISSING_GITHUB_TOKEN_WARNING);
      }
      const publishCtx = buildPublishContext(githubToken);
      await publishError(reason, runDeps, publishCtx);
    } catch {
      // Ignore publication errors here; `core.setFailed` below is
      // the authoritative failure signal.
    }
    core.setFailed(reason);
  });
}

// Re-export the wired APIs so consumers (and tests) can require
// this bundle as a library and call them directly without going
// through `@actions/core`.
export {
  runReviews,
  validateReview,
  postComment,
  postCheckRun,
  postErrorComment,
  computeFailureReason,
};
export type {
  RunReviewsOptions,
  RunReviewsResult,
  ValidateReviewOptions,
  ValidateReviewResult,
  PostCommentOptions,
  PostCommentResult,
  PostCheckRunOptions,
  PostCheckRunResult,
  PostErrorCommentOptions,
  PostErrorCommentResult,
};