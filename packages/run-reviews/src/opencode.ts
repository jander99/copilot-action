import { extractReviewDocument } from '@jander99/ai-review-review-contract';
import type { ReviewResult } from './types';
import {
  runReview,
  type DebugCapturePaths,
  type ReviewRuntime,
  type ReviewRuntimeResult,
  type ReviewRuntimeSpawn,
  type ReviewTool,
} from './runtime';
import { OpenCodeRuntime } from './opencode-run';
import { ClaudeCodeRuntime } from './claude-run';

export type { DebugCapturePaths } from './runtime';
export type { ReviewTool, ReviewRuntime } from './runtime';

export interface InvokeReviewOptions {
  homeDir: string;
  timeoutMinutes?: number;
  disableTools?: boolean;
  debugCapture?: DebugCapturePaths;
  /**
   * Kept for public API compatibility. The selected agent is read from the
   * merged OpenCode config by the one-shot CLI invocation.
   */
  agent?: string;
}

/**
 * Optional dependency-injection seam for `invokeOpenCode` / `invokeReview`.
 * Mirrors the pattern used by `runOpenCodeRun`: callers can pass a custom
 * `spawn` to script the OpenCode CLI in tests. The 4/5-argument form is the
 * documented public surface; the optional runtime argument is a non-breaking
 * extension used by the test suite and any future test fixtures.
 */
export type InvokeOpenCodeRuntime = ReviewRuntimeSpawn;

// Re-export the opencode-specific InvokeOpenCodeOptions shape as an
// alias of InvokeReviewOptions for back-compat with callers that
// imported the original name. The dispatcher ignores opencode-only
// fields when running with tool='claude'.
export type InvokeOpenCodeOptions = InvokeReviewOptions;

function resolveRuntime(tool: ReviewTool): ReviewRuntime {
  return tool === 'claude' ? new ClaudeCodeRuntime() : new OpenCodeRuntime();
}

/**
 * Canonical review-document shape, inlined as a focused format
 * directive for the retry call. The retry's job is to take whatever
 * analysis the first call produced (or the raw diff+prompts, when the
 * first call returned nothing) and emit a strict canonical document
 * that begins with `# Review — `. Repeating the shape here keeps the
 * retry prompt self-contained: the model does not have to remember
 * the full original system prompt in order to follow the contract.
 *
 * Mirrors the shape described in `REVIEW_AGENT_PROMPT_TEMPLATE` and
 * enforced by `validateReviewDocument` in the review contract.
 */
const CANONICAL_FORMAT_TEMPLATE = `# Review — <title>

## Scope
- <one or more bullet lines, each non-empty>

## Summary
- New findings: <integer>
- Unresolved from prior review: <integer>
- Resolved by latest commits: <integer>

## Findings (only when there are findings; max 5 blocks)
### 🔴 Critical — <short title>
- Status: <new | unresolved | resolved | new variant>
- Location: <path>:<line>
- Description: <single-line text, max 200 chars>

(repeat the finding block for each finding; omit the section entirely when there are no findings)`;

/**
 * Build the retry prompt for attempts 2..N. Three modes:
 *   - **reset** (when `priorIssuesByAttempt.length >= 2`): the model
 *     has now tried twice and still produced a rejected document.
 *     Instead of asking it to convert the previous analysis (which
 *     produced the same problems), we list every issue from every
 *     prior attempt and ask the model to start over with a clean
 *     canonical document.
 *   - **missing-output**: the previous attempt produced no text;
 *     the directive is the canonical-format template plus the
 *     original prompt.
 *   - **missing-heading**: the previous attempt produced text but
 *     no `# Review —` heading; the directive asks the model to
 *     convert its analysis to the canonical format.
 *   - **format-issue**: the previous attempt produced a document
 *     with one or more format issues; the directive lists them as
 *     a numbered list and asks the model to fix them all.
 *
 * `priorIssuesByAttempt` is the history of issue lists, one entry
 * per prior attempt that failed. For attempt 2 it has one entry;
 * for attempt 3 it has two. The function uses the LATEST entry for
 * the format-issue mode, and the FULL history for the reset mode.
 */
function buildRetryPrompt(
  originalPrompt: string,
  currentText: string,
  currentIssues: string[],
  priorIssuesByAttempt: string[][],
): string {
  const hasText = currentText.trim().length > 0;
  let formatDirective: string;

  if (priorIssuesByAttempt.length >= 2) {
    // Reset mode: the model has now tried twice. Listing every
    // issue from every prior attempt and asking for a clean
    // canonical document works better than asking the model to
    // patch the previous (broken) analysis. The "Convert your
    // analysis to the canonical format" framing assumes the
    // previous text is a useful substrate, which is not the case
    // when both prior attempts were rejected.
    const history = priorIssuesByAttempt
      .map((issues, idx) => {
        const inner = issues.map((i) => `    * ${i}`).join('\n');
        return `  - Attempt ${idx + 1}:\n${inner}`;
      })
      .join('\n');
    formatDirective = `You have now tried twice and the validator still rejected your output. Start over with a clean canonical document; do NOT try to patch the previous response. Here is the complete list of issues across both prior attempts:

${history}

Emit ONLY the canonical review document below; begin with "# Review — " on the very first character. Address every issue above in this retry.

${CANONICAL_FORMAT_TEMPLATE}`;
  } else if (!hasText) {
    formatDirective = `Your previous response produced no output. Emit ONLY the canonical review document based on the diff and prompts below; begin with "# Review — " on the very first character.

${CANONICAL_FORMAT_TEMPLATE}`;
  } else if (currentIssues.length === 1 && currentIssues[0] === 'missing heading') {
    formatDirective = `Your previous response produced analysis but no canonical review document. Convert that analysis to the canonical format below. Emit ONLY the canonical review document; begin with "# Review — " on the very first character.

${CANONICAL_FORMAT_TEMPLATE}

Your previous analysis (for context):
${currentText}`;
  } else {
    // Format-issue case: list every validator reason the helper
    // surfaced (typically 1-3 entries) so the model fixes them all
    // in this retry instead of round-tripping the cycle again.
    const issueList = currentIssues
      .map((reason, idx) => `  ${idx + 1}. ${reason}`)
      .join('\n');
    formatDirective = `Your previous response produced a document but the validator rejected it for the following format reasons:
${issueList}

Convert your analysis to the canonical format below and emit ONLY the canonical review document; begin with "# Review — " on the very first character. Address every issue above in your retry.

${CANONICAL_FORMAT_TEMPLATE}

Your previous analysis (for context):
${currentText}`;
  }

  return `${formatDirective}\n\n---\n\n${originalPrompt}`;
}

// ---------------------------------------------------------------------------
// Client-side format checks mirroring `validateReviewDocument`.
//
// The validator's most common rejection modes on real model output:
//   1. `## Scope` section is missing OR has no bullet lines.
//   2. A finding block's `Location:` field does not match the
//      canonical `<path>:<line>` / `<path>:<line>-<line>` grammar
//      (per comma-separated item).
//   3. The `## Summary` integer fields don't match the counts derived
//      from `## Findings` blocks (status -> count).
//
// We mirror those rules here so the retry path can fire on format
// invalidity in addition to the heading-missing case. ALL issues
// found in one pass are returned (in validator order); the retry
// prompt surfaces them as a numbered list so the model addresses
// every issue in a single retry. Client-side checks (no call into
// the validator package) keep this lightweight enough to run on
// every review invocation without measurable cost.
// ---------------------------------------------------------------------------

const SCOPE_HEADING_PATTERN = /^## Scope\s*$/;
const FINDING_HEADING_PATTERN = /^### /;
const LOCATION_FIELD_PATTERN = /^-\s*Location:\s*(\S.*)$/;
const STATUS_FIELD_PATTERN = /^-\s*Status:\s*(.+)$/i;
const SUMMARY_HEADING_PATTERN = /^## Summary\s*$/;
const TOP_BULLET_PATTERN = /^-\s+\S/;
const LOCATION_ITEM_PATTERN = /^([^:]+):(\d+)(?:-(\d+))?$/;
// Matches the three `## Summary` integer lines. Each accepts the
// leading `-`, optional whitespace, and an integer capture. The
// regex mirrors the validator's `parseSummary` shape.
const NEW_FINDINGS_PATTERN = /^\s*-\s*New findings:\s*(\d+)\s*$/;
const UNRESOLVED_PATTERN = /^\s*-\s*Unresolved from prior review:\s*(\d+)\s*$/;
const RESOLVED_PATTERN = /^\s*-\s*Resolved by latest commits:\s*(\d+)\s*$/;
// Mirrors `STATUS_COUNTS_AS_NEW` in the contract: `new` and
// `new variant` both count toward New findings.
const NEW_STATUSES = new Set(['new', 'new variant']);

function locationItems(value: string): string[] {
  return value.split(',').map((item) => item.trim());
}

function describeLocationError(value: string): string {
  if (value.includes(';')) {
    return 'Location items must be separated by commas only; semicolons are not allowed';
  }
  for (const raw of locationItems(value)) {
    if (raw === '') {
      return 'Location must not contain empty items or a trailing/leading comma';
    }
    if (!LOCATION_ITEM_PATTERN.test(raw)) {
      return `Location item "${raw}" must match <path>:<line> or <path>:<line>-<line> (use commas to separate multiple items; do not use "and", "or", "&", ";", markdown links, or bullets)`;
    }
  }
  // Unreachable when the caller invokes us only after a regex miss,
  // but kept so future changes can't silently fall through.
  return 'Location is invalid';
}

function isValidLocations(value: string): boolean {
  if (value.trim() === '' || value.includes(';')) {
    return false;
  }
  for (const raw of locationItems(value)) {
    if (raw === '' || !LOCATION_ITEM_PATTERN.test(raw)) {
      return false;
    }
  }
  return true;
}

interface FindingStub {
  /** Line number (1-indexed) of the `### …` heading. */
  lineNumber: number;
  /** Lowercased Status field value (e.g. `new`, `new variant`, `unresolved`). */
  status: string;
  /** Raw Location field value (may be invalid). */
  locationValue: string;
  /** Whether the Location field matches the canonical grammar. */
  locationValid: boolean;
  /** Human-readable Location error, populated when `locationValid` is false. */
  locationError: string | null;
}

/**
 * Walk `### …` finding blocks and collect one `FindingStub` per
 * block. Scope-bullets / Summary-count checks happen elsewhere; this
 * helper only extracts finding metadata for the Location + count
 * checks.
 */
function extractFindings(lines: string[]): FindingStub[] {
  const findings: FindingStub[] = [];
  let current: FindingStub | null = null;
  const pushCurrent = (): void => {
    if (current) {
      findings.push(current);
      current = null;
    }
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (FINDING_HEADING_PATTERN.test(line)) {
      pushCurrent();
      current = {
        lineNumber: i + 1,
        status: '',
        locationValue: '',
        locationValid: true,
        locationError: null,
      };
      continue;
    }
    if (line.startsWith('## ')) {
      pushCurrent();
      continue;
    }
    if (!current) continue;
    const statusMatch = line.match(STATUS_FIELD_PATTERN);
    if (statusMatch) {
      current.status = statusMatch[1].trim().toLowerCase();
      continue;
    }
    const locMatch = line.match(LOCATION_FIELD_PATTERN);
    if (locMatch) {
      current.locationValue = locMatch[1].trim();
      if (!isValidLocations(current.locationValue)) {
        current.locationValid = false;
        current.locationError = describeLocationError(current.locationValue);
      }
    }
  }
  pushCurrent();
  return findings;
}

/**
 * Walk the `## Summary` section and extract the three integers.
 * Returns `null` when any of the three fields is missing (the
 * validator will reject the document for a separate reason; we
 * simply cannot compute counts to compare).
 */
function extractSummaryCounts(lines: string[]): { new: number; unresolved: number; resolved: number } | null {
  const summaryIdx = lines.findIndex((l) => SUMMARY_HEADING_PATTERN.test(l));
  if (summaryIdx === -1) return null;

  let newCount: number | null = null;
  let unresolvedCount: number | null = null;
  let resolvedCount: number | null = null;

  for (let i = summaryIdx + 1; i < lines.length; i += 1) {
    const line = lines[i];
    // Stop at the next finding block or major heading.
    if (FINDING_HEADING_PATTERN.test(line) || /^\s*##\s+/.test(line)) {
      break;
    }
    const newMatch = line.match(NEW_FINDINGS_PATTERN);
    if (newMatch) {
      newCount = Number.parseInt(newMatch[1], 10);
      continue;
    }
    const unresolvedMatch = line.match(UNRESOLVED_PATTERN);
    if (unresolvedMatch) {
      unresolvedCount = Number.parseInt(unresolvedMatch[1], 10);
      continue;
    }
    const resolvedMatch = line.match(RESOLVED_PATTERN);
    if (resolvedMatch) {
      resolvedCount = Number.parseInt(resolvedMatch[1], 10);
    }
  }

  if (newCount === null || unresolvedCount === null || resolvedCount === null) {
    return null;
  }
  return { new: newCount, unresolved: unresolvedCount, resolved: resolvedCount };
}

/**
 * Client-side mirror of the validator's most common rejection modes.
 * Returns the issues found in the order the validator would
 * encounter them (Scope first, then per-finding Location issues in
 * document order, then the Summary count mismatch). Empty array
 * means the document passes all checks.
 *
 * The prompt owns the format contract for Summary-content and
 * finding-block-content (covered by the CANONICAL SHAPE worked
 * example and the WHAT NOT TO DO list in
 * `REVIEW_AGENT_PROMPT_TEMPLATE`). Client-side checks for those
 * would be redundant — the model has been emitting things like
 * trailing parentheticals in Summary bullets, self-talk in
 * Description, and preambles before `# Review —`; the prompt now
 * names these explicitly so the model pattern-matches the WRONG
 * examples with the WRONG verdict. Token + cost budget is
 * preserved by removing the checks that produced the most
 * retries.
 *
 * Fence tracking is intentionally NOT included: the checks operate
 * on top-level structural markers (`## Scope`, `- Location:`,
 * `## Summary`, `### `) that the validator also reads; if a model
 * puts a `- Location:` line inside a fenced code block the
 * validator ignores it as fenced prose, but a retry is still safe
 * (the validator runs on the retry's output, not the first call's
 * text). False positives are cheap; missed checks leak through.
 */
export function formatReviewDocumentIssues(text: string): string[] {
  const lines = text.split('\n');
  const issues: string[] = [];

  // ----- 1. ## Scope check: present and at least one top-level bullet. -----
  const scopeIdx = lines.findIndex((l) => SCOPE_HEADING_PATTERN.test(l));
  if (scopeIdx === -1) {
    issues.push('missing ## Scope section');
  } else {
    let scopeHasBullet = false;
    for (let j = scopeIdx + 1; j < lines.length; j += 1) {
      const inner = lines[j];
      if (inner.startsWith('## ')) break;
      if (inner.trim() === '') continue;
      if (TOP_BULLET_PATTERN.test(inner)) {
        scopeHasBullet = true;
      }
      break; // first non-blank content determines pass/fail
    }
    if (!scopeHasBullet) {
      issues.push('## Scope section is present but contains no bullets');
    }
  }

  // ----- 2. Per-finding Location validity. -----
  const findings = extractFindings(lines);
  for (const finding of findings) {
    if (!finding.locationValid && finding.locationError !== null) {
      issues.push(`finding at line ${finding.lineNumber} has invalid Location: ${finding.locationError}`);
    }
  }

  // ----- 3. Summary-count mismatch with finding Status counts. -----
  const summary = extractSummaryCounts(lines);
  if (summary !== null) {
    const actual = { new: 0, unresolved: 0, resolved: 0 };
    for (const finding of findings) {
      if (NEW_STATUSES.has(finding.status)) {
        actual.new += 1;
      } else if (finding.status === 'unresolved') {
        actual.unresolved += 1;
      } else if (finding.status === 'resolved') {
        actual.resolved += 1;
      }
    }
    if (
      actual.new !== summary.new
      || actual.unresolved !== summary.unresolved
      || actual.resolved !== summary.resolved
    ) {
      issues.push(
        `count mismatch: summary says New=${summary.new}, Unresolved=${summary.unresolved}, Resolved=${summary.resolved}; blocks yield New=${actual.new}, Unresolved=${actual.unresolved}, Resolved=${actual.resolved}`,
      );
    }
  }
  // If Summary is missing or incomplete, `extractSummaryCounts`
  // returns null; the downstream `validateReviewDocument` call
  // catches that as a separate rejection mode.

  return issues;
}

/**
 * Sum the tokens and cost of two reviewer invocations into the shape
 * `ReviewResult` expects. The `reasoning` field on the per-call
 * result is intentionally dropped: `ReviewResult.tokens` does not
 * surface it and the contract validator does not require it.
 */
function combineResults(first: ReviewRuntimeResult, second: ReviewRuntimeResult): ReviewResult['tokens'] {
  return {
    input: first.tokens.input + second.tokens.input,
    output: first.tokens.output + second.tokens.output,
  };
}

/**
 * Run a single reviewer invocation through the selected runtime.
 * Internal helper that does NOT trigger the format fallback - the
 * caller decides whether to retry.
 *
 * The retry path always passes `undefined` for `debugCapture` so the
 * first call's captured analysis is the only artifact on disk. The
 * retry either succeeds (a canonical review emerges) or fails
 * (downstream validation surfaces a `failure-reason`); either way
 * the retry's raw streams are not interesting enough to warrant a
 * separate debug artifact.
 */
async function runOnce(
  prompt: string,
  model: string,
  configPath: string,
  options: InvokeReviewOptions,
  debugCapture: DebugCapturePaths | undefined,
  runtime: ReviewRuntime,
  spawnOverride: ReviewRuntimeSpawn | undefined,
): Promise<ReviewRuntimeResult> {
  const callOptions = {
    configPath,
    homeDir: options.homeDir,
    model,
    prompt,
    // Always deliver the prompt via stdin. The reviewer prompt
    // includes the embedded diff (up to REVIEW_DIFF_MAX_BYTES =
    // 200 KB on top of the system prompt + task prompt), which
    // exceeds the OS `ARG_MAX` (`E2BIG` on Linux, ~128 KB) on
    // any reasonably-sized PR. Routing through stdin keeps the
    // argv under the limit regardless of which runtime is in
    // use. The runtime substitutes `-` for the prompt in
    // `commandArgs`; the orchestrator writes the prompt to
    // `proc.stdin`.
    input: prompt,
    timeoutMinutes: options.timeoutMinutes ?? 30,
    disableTools: options.disableTools,
    debugCapture,
  };
  return runReview(callOptions, runtime, spawnOverride?.spawn);
}

/**
 * Maximum number of reviewer invocations per call to
 * `invokeReview`. The loop runs `MAX_ATTEMPTS` times at most; the
 * first attempt uses the original prompt, and any subsequent
 * attempts use `buildRetryPrompt` with the issues the helper
 * surfaced. Recent CI runs on PR #35 showed the model could
 * converge on a canonical document in 2-3 passes given a
 * sufficiently explicit reset-mode directive; capping at 3
 * bounds the per-invocation token + cost budget while leaving
 * enough headroom for the model to recover from earlier mistakes.
 */
const MAX_ATTEMPTS = 3;

/**
 * Invoke the selected reviewer CLI through the shared `runReview`
 * transport. Picks the OpenCode CLI (`opencode run --format=json`) for
 * `tool: 'opencode'` and the Claude Code CLI (`claude -p
 * --output-format stream-json`) for `tool: 'claude'`.
 *
 * The transport owns process and stream handling; this wrapper
 * preserves the review pipeline's sanitization and canonical document
 * extraction regardless of which CLI produced the events.
 *
 * Bounded retry loop: when an attempt's output does not produce a
 * canonical review document (either no `# Review —` heading, OR a
 * heading plus a body that fails one or more of the validator's
 * common format checks — see `formatReviewDocumentIssues`), the
 * next attempt is dispatched with a focused format-conversion
 * prompt that uses the prior attempt's text as context. The
 * `priorIssuesByAttempt` history is threaded through so attempt
 * N+1 can reference every issue from attempts 1..N. When two
 * prior attempts have both failed, the directive switches to
 * "reset" mode (start over with a clean canonical document) on
 * the grounds that asking the model to patch a broken substrate
 * two attempts in a row is what got us here in the first place.
 *
 * Tokens and cost are summed across every attempt so downstream
 * accounting reflects the full spend. After `MAX_ATTEMPTS`
 * unsuccessful attempts the wrapper returns the last attempt's
 * text (or the raw text when no attempt produced a heading) and
 * the action's downstream validation surfaces the failure cleanly
 * via `failure-reason`; this wrapper never throws on a missing
 * heading.
 *
 * The optional 6th argument is a non-breaking extension for tests
 * that script the underlying CLI spawn. Existing callers that pass
 * only 5 arguments keep working unchanged.
 */
export async function invokeReview(
  prompt: string,
  model: string,
  configPath: string,
  options: InvokeReviewOptions,
  tool: ReviewTool,
  runtime?: ReviewRuntimeSpawn,
): Promise<ReviewResult> {
  const runtimeImpl = resolveRuntime(tool);

  let currentText = '';
  let currentIssues: string[] = [];
  const priorIssuesByAttempt: string[][] = [];
  let cumulativeInput = 0;
  let cumulativeOutput = 0;
  let cumulativeCost = 0;
  let lastResult: ReviewRuntimeResult | null = null;
  let lastExtracted: string | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    // Attempt 1 uses the original prompt verbatim; attempts 2..N
    // use the focused retry directive. The retry's debug capture
    // is always undefined so the first call's captured analysis
    // is the only artifact on disk (retries either succeed and
    // produce a canonical document, or fail and surface a
    // failure-reason — their raw streams are not interesting).
    const attemptPrompt = attempt === 1
      ? prompt
      : buildRetryPrompt(prompt, currentText, currentIssues, priorIssuesByAttempt);
    const debugCapture = attempt === 1 ? options.debugCapture : undefined;

    const result = await runOnce(
      attemptPrompt, model, configPath, options,
      debugCapture,
      runtimeImpl,
      runtime,
    );
    lastResult = result;
    cumulativeInput += result.tokens.input;
    cumulativeOutput += result.tokens.output;
    cumulativeCost += result.cost;

    const extracted = extractReviewDocument(result.text);
    lastExtracted = extracted;

    if (extracted === null) {
      // The model emitted nothing visible (think-block analysis
      // only, or no output at all). Treat the next attempt as
      // "missing heading" so the retry directive can convert the
      // analysis to a canonical document.
      priorIssuesByAttempt.push(['missing heading']);
      currentText = result.text;
      currentIssues = ['missing heading'];
      continue;
    }

    const issues = formatReviewDocumentIssues(extracted);
    if (issues.length === 0) {
      // Success — the document is canonical. Return immediately.
      return {
        text: extracted,
        tokens: { input: cumulativeInput, output: cumulativeOutput },
        cost: cumulativeCost,
        model: result.model,
      };
    }

    // Document is structurally valid but the validator would
    // reject it. Record the issues for the next attempt and
    // continue the loop.
    priorIssuesByAttempt.push(issues);
    currentText = extracted;
    currentIssues = issues;
  }

  // MAX_ATTEMPTS reached without convergence. Return the last
  // attempt's extracted text (or raw text when no attempt ever
  // produced a heading); downstream validation surfaces the
  // failure-reason.
  return {
    text: lastExtracted ?? lastResult?.text ?? '',
    tokens: { input: cumulativeInput, output: cumulativeOutput },
    cost: cumulativeCost,
    model: lastResult?.model ?? '',
  };
}

/**
 * Back-compat thin wrapper around `invokeReview` that pins the
 * OpenCode runtime. Preserved so existing internal callers continue
 * to work without modification; new code should call `invokeReview`
 * directly with an explicit `tool` argument.
 *
 * The optional 5th argument is preserved from PR #36's
 * dependency-injection seam: callers (and the test suite) can pass
 * a custom `spawn` to script the OpenCode CLI. Existing 4-argument
 * callers keep working unchanged.
 */
export async function invokeOpenCode(
  prompt: string,
  model: string,
  configPath: string,
  options: InvokeOpenCodeOptions,
  runtime?: InvokeOpenCodeRuntime,
): Promise<ReviewResult> {
  return invokeReview(prompt, model, configPath, options, 'opencode', runtime);
}