import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { gzipSync } from 'zlib';
import {
  MAX_CHARS,
  mergeReviewDocuments,
  validateReviewDocument,
} from '@jander99/ai-review-review-contract';
import { fetchPriorReviews } from '@jander99/ai-review-previous-reviews';
import {
  buildAgentDefinition,
  buildValidatorAgentDefinition,
  getEventContext,
  titleOrRefForHeading,
} from './agent-definition';
import { buildMergedConfig, buildValidatorConfig } from './config-builder';
import { invokeReview } from './opencode';
import type { DebugCapturePaths, ReviewTool } from './opencode';
import { OpenCodeRuntime } from './opencode-run';
import { ClaudeCodeRuntime } from './claude-run';
import { parsePrompts, composeTaskPromptWithPreviousReviews } from './prompt-composer';
import type { EventContext, Permission, PromptEntry, ReviewResult } from './types';

// Best-effort only: debug artifacts may still contain sensitive data. AWS secret
// access keys have no tight identifying prefix and cannot be safely pattern-matched.
const REDACTION_PATTERNS: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  { pattern: /sk-ant-[A-Za-z0-9._-]+/g, replacement: '[REDACTED]' },
  { pattern: /sk-[A-Za-z0-9._-]+/g, replacement: '[REDACTED]' },
  { pattern: /github_pat_[A-Za-z0-9_]+/g, replacement: '[REDACTED]' },
  { pattern: /ghp_[A-Za-z0-9_]+/g, replacement: '[REDACTED]' },
  { pattern: /ghs_[A-Za-z0-9_]+/g, replacement: '[REDACTED]' },
  { pattern: /gho_[A-Za-z0-9_]+/g, replacement: '[REDACTED]' },
  { pattern: /ghr_[A-Za-z0-9_]+/g, replacement: '[REDACTED]' },
  { pattern: /ghu_[A-Za-z0-9_]+/g, replacement: '[REDACTED]' },
  { pattern: /AIza[A-Za-z0-9_-]{35}/g, replacement: '[REDACTED]' },
  { pattern: /AKIA[A-Z0-9]{16}/g, replacement: '[REDACTED]' },
  { pattern: /Bearer\s+[^\s"'`\\]+/gi, replacement: 'Bearer [REDACTED]' },
];

/**
 * Pathspec excludes applied to the diff that is embedded in the
 * reviewer prompt. Filtering is deterministic by construction so a PR
 * that only changes auto-generated dist bundles cannot get the
 * reviewer stuck reading machine-bundled code (see issue: CI runs
 * failed when the model spent its entire context on dist/main.cjs
 * regeneration and emitted only think blocks).
 *
 * The two patterns cover both layouts that ship in this repo:
 *   - the root-action bundle at dist/main.cjs, AND
 *   - per-package bundles under packages STAR dist STAR STAR (the glob
 *     matches dist/ and the gitignored dist-test/ rebuild artifacts
 *     uniformly, which keeps the filter simple). The textual
 *     placeholder is used here because a literal star-star sequence
 *     would close this JSDoc block prematurely.
 *
 * Exported so tests can confirm the same pathspecs the runtime uses.
 */
export const REVIEW_DIFF_EXCLUDE_PATHSPECS: ReadonlyArray<string> = [
  ':(exclude)dist/**',
  ':(exclude)packages/*/dist*/**',
];

/**
 * Hard cap on the byte size of the diff embedded in the reviewer
 * prompt. The reviewer prompt itself is bounded by the model's
 * context window, and the diff is the largest single section, so a
 * fixed 200 KB cap keeps token use predictable across PRs without
 * sacrificing the ability to review large source changes. Diff lines
 * above the cap are dropped; a `[diff truncated to 200 KB]` marker is
 * appended so the model knows the section is incomplete.
 */
export const REVIEW_DIFF_MAX_BYTES = 200_000;

/**
 * Placeholder returned by `computeReviewDiff` when no diff is
 * available (the event did not supply a ref range, the working
 * directory is not a git repo, `git diff` returned non-zero, or the
 * filtered diff was empty because every changed path matched an
 * exclude pathspec). The model emits a valid `## Scope` line based on
 * this placeholder instead of looping on an empty prompt.
 */
export const REVIEW_DIFF_EMPTY_PLACEHOLDER =
  '(no diff available — the changes may be entirely under dist/** which is auto-generated and excluded from review)';

/**
 * Compute the filtered diff for the current event and embed it in the
 * reviewer prompt. Pure from the caller's perspective: every failure
 * mode (missing refs, missing git binary, non-zero exit, empty
 * filtered diff) returns `REVIEW_DIFF_EMPTY_PLACEHOLDER` so the prompt
 * remains well-formed and the model still has a path to emit a valid
 * `## Scope`.
 *
 * Filtering is applied at `git diff` time via pathspec excludes, so
 * the model never sees dist/ content even if it tried to run `git
 * diff` (which is also denied by `OPENCODE_PERMISSION`).
 *
 * Exported for tests; the production call site is in `runReviews`.
 */
export function computeReviewDiff(eventContext: EventContext, workingDir: string): string {
  const range = resolveDiffRange(eventContext, workingDir);
  if (!range) {
    return REVIEW_DIFF_EMPTY_PLACEHOLDER;
  }

  const args = [
    '-C', workingDir,
    'diff',
    range,
    '--',
    ...REVIEW_DIFF_EXCLUDE_PATHSPECS,
  ];

  const result = spawnSync('git', args, {
    encoding: 'utf8',
    maxBuffer: REVIEW_DIFF_MAX_BYTES * 2,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15_000,
  });

  if (result.error) {
    return REVIEW_DIFF_EMPTY_PLACEHOLDER;
  }
  if (result.status !== 0) {
    return REVIEW_DIFF_EMPTY_PLACEHOLDER;
  }

  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  if (!stdout.trim()) {
    return REVIEW_DIFF_EMPTY_PLACEHOLDER;
  }

  if (stdout.length <= REVIEW_DIFF_MAX_BYTES) {
    return stdout;
  }
  // Hard truncate at the byte cap. The marker makes it obvious the
  // section is incomplete so the model does not cite findings from
  // content past the boundary.
  return `${stdout.slice(0, REVIEW_DIFF_MAX_BYTES)}\n\n[diff truncated to ${REVIEW_DIFF_MAX_BYTES / 1000} KB]`;
}

/**
 * Resolve the `<a>..<b>` ref range for the current event. Returns
 * `null` when the event shape does not expose a diff range (e.g. a
 * `workflow_dispatch` run without `HEAD~1` available, or a
 * `pull_request` event missing `baseSha`/`headSha`).
 */
function resolveDiffRange(eventContext: EventContext, workingDir: string): string | null {
  if (eventContext.eventName === 'pull_request') {
    if (eventContext.baseSha && eventContext.headSha) {
      return `${eventContext.baseSha}..${eventContext.headSha}`;
    }
    return null;
  }
  if (eventContext.eventName === 'push') {
    if (eventContext.before && eventContext.after) {
      return `${eventContext.before}..${eventContext.after}`;
    }
    return null;
  }
  // workflow_dispatch / other events: fall back to HEAD~1..HEAD when
  // both refs resolve in the working tree. Shallow clones do not
  // always have HEAD~1, so probe before constructing the range. The
  // probe MUST run in the actual working directory — earlier revisions
  // branched on `eventContext.repository` (always a slug, so the branch
  // was effectively unreachable) and always picked `/dev/null`, which
  // made `workflow_dispatch` fall through to the placeholder for every
  // PR. The model caught this; the fix is to pass `workingDir` directly.
  const probe = spawnSync('git', ['-C', workingDir, 'rev-parse', '--verify', '--quiet', 'HEAD~1'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5_000,
  });
  // The probe is best-effort; if it fails (shallow clone, not a repo,
  // etc.) we cannot construct a meaningful range, so the caller gets
  // the placeholder.
  if (probe.status !== 0) {
    return null;
  }
  return 'HEAD~1..HEAD';
}

function assertToolVersion(
  tool: ReviewTool,
  opencodeVersion: string,
  claudeVersion: string,
): void {
  // The version-check shape (spawnSync <binary> --version, compare
  // semver, throw on mismatch) lives on each runtime's
  // `assertVersion` method. For Claude, an empty `claudeVersion`
  // means "only verify the binary is on PATH" - see the runtime
  // implementation for the rationale.
  if (tool === 'claude') {
    new ClaudeCodeRuntime().assertVersion(claudeVersion);
  } else {
    new OpenCodeRuntime().assertVersion(opencodeVersion);
  }
}

function createDebugDirectory(): string {
  const temporaryRoot = process.env.RUNNER_TEMP || os.tmpdir();
  fs.mkdirSync(temporaryRoot, { recursive: true });
  const debugDirectory = fs.mkdtempSync(path.join(temporaryRoot, 'ai-review-debug-'));
  fs.chmodSync(debugDirectory, 0o700);
  return debugDirectory;
}

function createDebugCapturePaths(
  directory: string,
  invocation: number,
  kind: 'review',
  model: string,
): DebugCapturePaths {
  const safeModel = model.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80) || 'unknown-model';
  const prefix = `${invocation.toString().padStart(3, '0')}-${kind}-${safeModel}`;
  return {
    stdoutPath: path.join(directory, `${prefix}.stdout.jsonl`),
    stderrPath: path.join(directory, `${prefix}.stderr.log`),
  };
}

function redactDebugOutput(output: string): string {
  return REDACTION_PATTERNS.reduce(
    (redacted, { pattern, replacement }) => redacted.replace(pattern, replacement),
    output,
  );
}

function finalizeDebugDirectory(directory: string): void {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name.endsWith('.gz')) {
      continue;
    }
    const rawPath = path.join(directory, entry.name);
    const redacted = redactDebugOutput(fs.readFileSync(rawPath, 'utf8'));
    fs.writeFileSync(`${rawPath}.gz`, gzipSync(redacted), { mode: 0o600 });
    fs.rmSync(rawPath, { force: true });
  }
}

interface IndividualReviewResult extends ReviewResult {
  prompt: string;
  document: string;
}

function writeReviewOutputFile(targetPath: string, content: string): void {
  // The action is the authoritative source of the review file. The model
  // emits the structured review markdown in its reply; the action captures
  // the reply text, validates it, and writes the canonical document so
  // the structural validator and the publishing step both read the same
  // file.
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, content, { encoding: 'utf8', mode: 0o600 });
}

function readReviewOutputFile(targetPath: string): string {
  if (!fs.existsSync(targetPath)) {
    throw new Error(`review output file not found at ${targetPath}`);
  }
  const content = fs.readFileSync(targetPath, 'utf8');
  if (!content.trim()) {
    throw new Error(`review output file at ${targetPath} is empty`);
  }
  return content;
}

function compareLexically(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseRepository(repository: string | undefined): { owner: string; repo: string } | null {
  if (!repository) {
    return null;
  }
  const slashIndex = repository.indexOf('/');
  if (slashIndex <= 0 || slashIndex === repository.length - 1) {
    return null;
  }
  return {
    owner: repository.slice(0, slashIndex),
    repo: repository.slice(slashIndex + 1),
  };
}

/**
 * Options consumed by the programmatic review pipeline. Callers MUST
 * supply every input as a field on this object; the function does not
 * touch `core` directly. The standalone action wrapper translates
 * `@actions/core` inputs into this shape.
 */
export interface RunReviewsOptions {
  /**
   * Review runtime CLI to invoke. `'opencode'` (default) runs the
   * OpenCode CLI; `'claude'` runs the Claude Code CLI. The standalone
   * action wrapper and root action both default this to `'opencode'`
   * when the caller omits the input.
   */
  tool: ReviewTool;
  /** Exact OpenCode version expected from `opencode --version` (only consulted when `tool === 'opencode'`). */
  opencodeVersion: string;
  /**
   * Expected Claude Code CLI version (only consulted when
   * `tool === 'claude'`). When empty, the action only verifies the
   * `claude` binary is on PATH without pinning a specific version.
   */
  claudeVersion?: string;
  debug: boolean;
  model: string;
  modelsInput: string;
  failOnError: boolean;
  timeoutMinutes: number;
  prompts: string;
  permission: Permission;
  userConfig?: string;
  githubToken?: string;
}

/**
 * Diagnostic preview of a model document that the deterministic
 * contract validator rejected. Surfaced on `RunReviewsResult` so the
 * root-action orchestration can emit a `core.warning` per entry and
 * give operators something to look at beyond the bare reason string.
 */
export interface RejectedDocument {
  readonly model: string;
  readonly reason: string;
  readonly preview: string;
}

/**
 * Cap on the number of rejected-document previews surfaced on the
 * result. The diagnostics are intended for human inspection; three
 * entries cover the common failure shape (one per model or one per
 * prompt) without flooding the action log on runs that fan out
 * across many model/prompt pairs.
 */
export const REJECTED_DOCUMENT_CAP = 3;

/**
 * Default cap on the size of each preview. The preview is intended
 * to fit comfortably inside a single `core.warning` annotation
 * without bloating the run log.
 */
export const REJECTED_DOCUMENT_PREVIEW_MAX_CHARS = 1024;

/**
 * Build a line-bounded preview of a model document. Used
 * by `runReviews` to populate the `rejectedDocuments` field on the
 * result so the orchestration layer can log diagnostics when the
 * deterministic contract validator rejects a model response.
 *
 * The result is always <= `maxChars` characters (no marker is
 * appended - the caller decides how to label the preview). When the
 * input fits in the budget the input text is returned verbatim;
 * when it does not, the helper breaks at the last newline that fits
 * in the budget so the preview never chops a line mid-token. If no
 * newline fits (single huge line), the helper hard-truncates at the
 * cap.
 *
 * Pure function: no `core`, no `fs`, no `process` access. Tests can
 * import this helper directly via the run-reviews index.
 */
export function buildRejectedDocumentPreview(
  text: string,
  maxChars: number = REJECTED_DOCUMENT_PREVIEW_MAX_CHARS,
): string {
  if (text.length <= maxChars) {
    return text;
  }
  const slice = text.slice(0, maxChars);
  const lastNewline = slice.lastIndexOf('\n');
  if (lastNewline > 0) {
    return slice.slice(0, lastNewline);
  }
  return slice;
}

/**
 * Result of the programmatic review pipeline. Mirrors the action
 * outputs so the standalone action wrapper can write them via
 * `core.setOutput` and the root action can use them as plain fields.
 */
export interface RunReviewsResult {
  review: string;
  reviewOutputPath: string;
  modelsUsed: string;
  cost: number;
  costByModel: Record<string, number>;
  tokens: { input: number; output: number };
  tokensByModel: Record<string, { input: number; output: number }>;
  configJson: string;
  effectiveModel: string;
  debugArtifactPath: string;
  failureReason: string;
  /**
   * Previews of model documents rejected by the
   * deterministic contract validator. Capped at
   * `REJECTED_DOCUMENT_CAP` entries; entries are appended in the
   * order the validator rejects them. Empty when every invocation
   * produces a valid document.
   */
  rejectedDocuments: ReadonlyArray<RejectedDocument>;
}

export async function runReviews(options: RunReviewsOptions): Promise<RunReviewsResult> {
  const empty: RunReviewsResult = {
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

  try {
    assertToolVersion(options.tool, options.opencodeVersion, options.claudeVersion ?? '');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ...empty, failureReason: `Review runtime version assertion failed: ${message}` };
  }

  const validResults: IndividualReviewResult[] = [];
  const accountedResults: ReviewResult[] = [];
  const successfulModels = new Set<string>();
  const failures: string[] = [];
  // Diagnostics for the orchestration layer. Capped at
  // REJECTED_DOCUMENT_CAP so the action log stays bounded on fan-out
  // failures (e.g. every model/prompt combination returning
  // preamble-only text).
  const rejectedDocuments: RejectedDocument[] = [];
  let prompts: PromptEntry[];
  let effectiveModels: string[];
  let configPath: string;
  let homeDir: string;
  let serializedConfig = '';
  let debugDirectory = '';
  let debugInvocation = 0;
  let priorReviewsBlock: string | null = null;
  let eventContextForSetup: ReturnType<typeof getEventContext>;
  let reviewDiff = REVIEW_DIFF_EMPTY_PLACEHOLDER;
  let failureMessage: string | null = null;

  try {
    if (!Number.isFinite(options.timeoutMinutes) || options.timeoutMinutes <= 0) {
      throw new Error('timeout-minutes must be a positive integer');
    }

    const parsedModels = options.modelsInput
      ? options.modelsInput
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean)
      : [options.model];
    effectiveModels = [...new Set(parsedModels)];
    if (effectiveModels.length === 0) {
      throw new Error('At least one model is required');
    }

    prompts = parsePrompts(options.prompts);
    eventContextForSetup = getEventContext();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ...empty, failureReason: `Review setup failed: ${message}` };
  }

  if (eventContextForSetup.eventName === 'pull_request' && eventContextForSetup.prNumber) {
    const parsedRepo = parseRepository(eventContextForSetup.repository);
    if (parsedRepo) {
      try {
        const fetched = await fetchPriorReviews({
          token: options.githubToken || undefined,
          owner: parsedRepo.owner,
          repo: parsedRepo.repo,
          issueNumber: eventContextForSetup.prNumber,
        });
        if (fetched) {
          priorReviewsBlock = fetched.combined;
          console.log(`Loaded ${fetched.comments.length} prior AI review comment(s) for #${eventContextForSetup.prNumber}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`Prior review fetch failed; proceeding without prior context: ${message}`);
      }
    }
  }

  // Compute the filtered diff for the reviewer prompt. Failure modes
  // (missing refs, not a git repo, empty filtered diff) fall back to
  // the placeholder so the prompt is always well-formed.
  reviewDiff = computeReviewDiff(eventContextForSetup, process.env.GITHUB_WORKSPACE || process.cwd());

  if (options.tool === 'claude') {
    // Claude Code does not consume an OpenCode config or an isolated
    // home directory. Use `os.tmpdir()` as a stand-in `homeDir` so
    // the dispatcher signature stays uniform across runtimes; the
    // `ClaudeCodeRuntime.buildEnvironment` ignores it (it builds
    // the env from a fixed allow-list, not from `homeDir`). The
    // `configPath` is unused for the same reason. The validator
    // config is also omitted because the validator is now
    // tool-aware and mirrors the reviewer's runtime: at the
    // `tool: claude` path the validator dispatches through
    // `claude-validate.ts` (Claude Code CLI) instead of the
    // opencode-only path, so `passedConfigJson` is unused.
    configPath = '';
    homeDir = os.tmpdir();
    serializedConfig = '';
    if (options.debug) {
      debugDirectory = createDebugDirectory();
    }
  } else {
    try {
      const agent = buildAgentDefinition({
        eventContext: eventContextForSetup,
        priorReviewsBlock,
        reviewDiff,
      });
      const merged = buildMergedConfig({
        userConfig: options.userConfig,
        permission: options.permission,
        agent,
        model: effectiveModels[0],
      });
      configPath = merged.configPath;
      homeDir = merged.homeDir;
      serializedConfig = merged.serializedConfig;
      if (options.debug) {
        debugDirectory = createDebugDirectory();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ...empty, failureReason: `Review setup failed: ${message}` };
    }
  }

  const orderedPrompts = [...prompts].sort((left, right) => compareLexically(left.source, right.source));
  const orderedModels = [...effectiveModels].sort(compareLexically);

  const reviewOutputPath = eventContextForSetup.reviewOutputPath;
  if (!reviewOutputPath) {
    return { ...empty, failureReason: 'review output path could not be determined for this event' };
  }

  const validatorConfig = buildValidatorConfig({
    model: effectiveModels[0],
    validatorAgent: buildValidatorAgentDefinition(),
    userConfig: options.userConfig,
  });

  for (const prompt of orderedPrompts) {
    for (const currentModel of orderedModels) {
      console.log(`Running review: ${currentModel} :: ${prompt.source}`);
      try {
        // Model-format errors thrown from the runtime's
        // `resolveModel` (e.g. `tool=claude` with a model that lacks
        // the `provider/` prefix) propagate here. Convert to a
        // per-invocation failure so the loop can continue (and the
        // remaining model/prompt pairs still produce a document).
        const result = await invokeReview(
          composeTaskPromptWithPreviousReviews([prompt], priorReviewsBlock),
          currentModel,
          configPath,
          {
            homeDir,
            timeoutMinutes: options.timeoutMinutes,
            debugCapture: options.debug
              ? createDebugCapturePaths(debugDirectory, ++debugInvocation, 'review', currentModel)
              : undefined,
          },
          options.tool,
        );
        accountedResults.push(result);
        successfulModels.add(currentModel);
        const validation = validateReviewDocument(result.text);
        if (!validation.valid) {
          failures.push(
            `${currentModel} :: ${prompt.source}: invalid review document (${validation.reason})`,
          );
          console.warn(
            `Review from ${currentModel} :: ${prompt.source} is structurally invalid: ${validation.reason}`,
          );
          // Capture a sanitized, line-bounded preview so the
          // orchestration layer can emit a `core.warning` with the
          // offending content. Cap at REJECTED_DOCUMENT_CAP to keep
          // the action log bounded on fan-out failures.
          if (rejectedDocuments.length < REJECTED_DOCUMENT_CAP) {
            rejectedDocuments.push({
              model: currentModel,
              reason: validation.reason,
              preview: buildRejectedDocumentPreview(result.text),
            });
          }
          continue;
        }
        validResults.push({ ...result, prompt: prompt.source, document: result.text });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${currentModel} :: ${prompt.source}: ${message}`);
        console.warn(`Review failed for ${currentModel} :: ${prompt.source}: ${message}`);
      }
    }
  }

  const titleOrRef = titleOrRefForHeading(eventContextForSetup);
  let canonicalDocument: string | undefined;
  let reviewText = '';

  if (validResults.length === 0) {
    if (accountedResults.length === 0) {
      failureMessage = `all ${failures.length} review invocation(s) failed before producing a document`;
    } else {
      failureMessage =
        `all ${accountedResults.length} review invocation(s) produced invalid documents`;
    }
  } else {
    if (canonicalDocument === undefined) {
      if (validResults.length === 1) {
        canonicalDocument = validResults[0].document;
      } else {
        try {
          canonicalDocument = mergeReviewDocuments(
            validResults.map((entry) => entry.document),
            titleOrRef,
          );
        } catch (error) {
          // mergeReviewDocuments enforces the MAX_CHARS cap; surface the
          // message via failureReason and skip the write/read so the
          // action's downstream consumers see the failure cleanly
          // instead of an oversized invalid document.
          failureMessage = error instanceof Error ? error.message : String(error);
          canonicalDocument = undefined;
        }
      }
    }

    if (canonicalDocument !== undefined) {
      try {
        writeReviewOutputFile(reviewOutputPath, canonicalDocument);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failureMessage = failureMessage ?? `Review output file write failed: ${message}`;
      }

      if (failureMessage === null) {
        try {
          reviewText = readReviewOutputFile(reviewOutputPath);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          failureMessage = failureMessage ?? `Review output file read failed: ${message}`;
        }
      }
    }
  }

  const costByModel: Record<string, number> = {};
  const tokensByModel: Record<string, { input: number; output: number }> = {};
  let totalCost = 0;
  const totalTokens = { input: 0, output: 0 };

  for (const result of accountedResults) {
    totalCost += result.cost;
    totalTokens.input += result.tokens.input;
    totalTokens.output += result.tokens.output;
    costByModel[result.model] = (costByModel[result.model] ?? 0) + result.cost;
    const modelTokens = tokensByModel[result.model] ?? { input: 0, output: 0 };
    modelTokens.input += result.tokens.input;
    modelTokens.output += result.tokens.output;
    tokensByModel[result.model] = modelTokens;
  }

  let debugArtifactPath = '';
  if (options.debug && debugDirectory) {
    try {
      finalizeDebugDirectory(debugDirectory);
      debugArtifactPath = debugDirectory;
    } catch (error) {
      fs.rmSync(debugDirectory, { recursive: true, force: true });
      const message = error instanceof Error ? error.message : String(error);
      failureMessage = failureMessage ?? `Failed to create redacted debug artifact: ${message}`;
    }
  }

  let resolvedFailureReason = failureMessage ?? '';
  if (!resolvedFailureReason && failures.length > 0 && options.failOnError) {
    resolvedFailureReason = `${failures.length} review operation(s) failed`;
  }

  return {
    review: reviewText,
    reviewOutputPath,
    modelsUsed: [...successfulModels].join(','),
    cost: totalCost,
    costByModel,
    tokens: totalTokens,
    tokensByModel,
    configJson: validatorConfig.serializedConfig,
    effectiveModel: effectiveModels[0],
    debugArtifactPath,
    failureReason: resolvedFailureReason,
    rejectedDocuments,
  };
}