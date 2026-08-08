'use strict';

/**
 * Tests for the two-call retry strategy in `invokeOpenCode`.
 *
 * The wrapper runs the OpenCode CLI once. If the result text contains
 * a `# Review — ` heading the wrapper returns the extracted
 * document; otherwise it dispatches a second call with a focused
 * format-conversion prompt that uses the first call's text as
 * context. Tokens and cost are summed across both calls.
 *
 * The fake `spawn` here lets each test script a sequence of OpenCode
 * NDJSON events for the first and second call independently, so the
 * test exercises the retry branch without actually running the CLI.
 * Each test asserts on:
 *   - the number of spawn calls (1 = no retry, 2 = retry fired)
 *   - the text returned to the caller
 *   - the prompt passed to the second spawn
 *   - summed tokens and cost when two calls happen
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const bundle = require('../dist-test/index.cjs');
const { invokeOpenCode } = bundle;

const PROMPT = 'return the canonical review';
const MODEL = 'opencode-go/minimax-m3';

/**
 * Build a fake child process. The runtime now delivers the prompt
 * via `proc.stdin.write(...)` (to avoid the OS `ARG_MAX` /
 * `E2BIG` failure when the prompt + embedded diff exceeds the
 * argv limit on Linux), so the fake exposes a minimal writable
 * stream and captures writes into the supplied `stdinChunks`
 * array. The test fixture's spawn override forwards that array
 * onto the per-spawn record so tests can assert on the prompt
 * that was actually sent.
 */
function makeProcess({ events = [], stderr = '', exitCode = 0, stdinChunks } = {}) {
  const proc = new EventEmitter();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  // Synchronous writable for the prompt. The runtime only calls
  // `write(string|Buffer)` and `end()`; a real Node Writable
  // would buffer and emit 'data' asynchronously, but a plain
  // object that pushes into a test-owned array is enough to
  // capture what the runtime sent without the per-test plumbing
  // of a Transform stream.
  proc.stdin = {
    write: (chunk) => {
      if (stdinChunks) {
        stdinChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      }
      return true;
    },
    end: () => {},
  };
  proc.kill = () => true;

  setImmediate(() => {
    for (const event of events) {
      proc.stdout.write(`${JSON.stringify(event)}\n`);
    }
    if (stderr) {
      proc.stderr.write(stderr.endsWith('\n') ? stderr : `${stderr}\n`);
    }
    proc.stdout.end();
    proc.stderr.end();
    proc.emit('close', exitCode, null);
  });

  return proc;
}

/**
 * Drive `invokeOpenCode` against a script of OpenCode NDJSON event
 * sequences, one per spawn call. Each entry in `eventScript` becomes
 * the stdout of one fake `opencode` process; the wrapper decides
 * whether to make a second call based on whether the first emitted a
 * canonical heading.
 */
function runWithScript(eventScript, overrides = {}) {
  const spawnCalls = [];
  const result = invokeOpenCode(
    PROMPT,
    MODEL,
    '/tmp/opencode-test.json',
    {
      homeDir: '/tmp/opencode-test-home',
      timeoutMinutes: 1,
      ...overrides,
    },
    {
      spawn: (command, args, options) => {
        const idx = spawnCalls.length;
        const stdinChunks = [];
        // Pre-allocate the record so the spawn override can fill
        // it in as the test process emits events. Tests assert on
        // `stdinContent` after awaiting the orchestrator's
        // promise (so all writes have settled).
        const record = { command, args, options, stdinChunks };
        spawnCalls.push(record);
        const events = eventScript[idx] ?? { events: [], stderr: 'unexpected extra spawn', exitCode: 1 };
        return makeProcess({ ...events, stdinChunks });
      },
    },
  );
  return { result, spawnCalls };
}

/**
 * Extract the prompt the action sent to a spawn call. After the
 * stdin-routing change, the prompt is delivered via
 * `proc.stdin.write(...)` and the runtime's `commandArgs`
 * substitutes `-` as the trailing positional. Tests that
 * previously pulled the prompt from the last argv element need
 * this helper to stay readable.
 */
function promptFor(spawnCall) {
  return spawnCall.stdinChunks?.join('');
}

const CANONICAL_DOCUMENT = [
  '# Review — title',
  '',
  '## Scope',
  '- Reviewed the change end to end.',
  '',
  '## Summary',
  '- New findings: 0',
  '- Unresolved from prior review: 0',
  '- Resolved by latest commits: 0',
].join('\n');

/**
 * Build the OpenCode NDJSON event sequence for a single successful
 * review with the supplied terminal text and an optional cost /
 * token count on the closing `step_finish` event.
 */
function reviewEvents(text, { input = 10, output = 4, cost = 0.25 } = {}) {
  return [
    { type: 'step_finish', part: { type: 'step-finish', reason: 'tool-calls' } },
    { type: 'text', part: { type: 'text', text } },
    {
      type: 'step_finish',
      part: {
        type: 'step-finish',
        reason: 'stop',
        tokens: { input, output },
        cost,
      },
    },
  ];
}

/**
 * Same shape as `reviewEvents` but for a thinking-only response
 * (the model hit the output budget on `<think>` analysis and
 * stopped without emitting a visible heading). The analysis is
 * placed in a `text` part because `selectTerminalText` only reads
 * text parts; reasoning parts are ignored. This matches the
 * production failure shape: the model emits visible analysis text
 * (or a partial document) but never reaches the `# Review — `
 * heading.
 */
function thinkingOnlyEvents(analysisText, { input = 32000, output = 1, cost = 0.4, reason = 'length' } = {}) {
  return [
    { type: 'text', part: { type: 'text', text: analysisText } },
    {
      type: 'step_finish',
      part: {
        type: 'step-finish',
        reason,
        tokens: { input, output },
        cost,
      },
    },
  ];
}

test('invokeOpenCode returns the first-call document when it already has a heading', async () => {
  const { result, spawnCalls } = runWithScript([{ events: reviewEvents(CANONICAL_DOCUMENT) }]);
  const resultValue = await result;

  assert.equal(resultValue.text, CANONICAL_DOCUMENT);
  assert.equal(spawnCalls.length, 1, 'no retry when the first call produces a heading');
  assert.equal(spawnCalls[0].command, 'opencode');
});

test('invokeOpenCode retries with a format-conversion prompt when the first call emits only thinking', async () => {
  const thinking = '<think>The reviewer prompt requires a strict heading first...\n\nI see a real bug at packages/run-reviews/src/main.ts.</think>';
  const { result, spawnCalls } = runWithScript([
    { events: thinkingOnlyEvents(thinking, { input: 30000, output: 1, cost: 0.35, reason: 'length' }) },
    { events: reviewEvents(CANONICAL_DOCUMENT, { input: 30500, output: 80, cost: 0.10 }) },
  ]);

  const resultValue = await result;

  assert.equal(spawnCalls.length, 2, 'retry must fire when first call has no heading');
  assert.equal(resultValue.text, CANONICAL_DOCUMENT);

  // The retry prompt must include the first call's analysis as context
  // so the second call can convert it into a canonical document.
  const retryPrompt = promptFor(spawnCalls[1]);
  assert.match(retryPrompt, /Your previous response produced analysis but no canonical review document/);
  assert.ok(retryPrompt.includes(thinking), 'retry prompt must include the first-call text as context');

  // Tokens and cost are summed across both calls.
  assert.equal(resultValue.tokens.input, 30000 + 30500);
  assert.equal(resultValue.tokens.output, 1 + 80);
  assert.equal(resultValue.cost, 0.35 + 0.10);
});

test('invokeOpenCode retries with the full original prompt when the first call emitted no text', async () => {
  // Empty text event + length cap = literally nothing visible.
  const emptyFirstCall = [
    { type: 'text', part: { type: 'text', text: '' } },
    {
      type: 'step_finish',
      part: {
        type: 'step-finish',
        reason: 'length',
        tokens: { input: 100, output: 0 },
        cost: 0.05,
      },
    },
  ];
  const { result, spawnCalls } = runWithScript([
    { events: emptyFirstCall },
    { events: reviewEvents(CANONICAL_DOCUMENT, { input: 200, output: 90, cost: 0.15 }) },
  ]);

  const resultValue = await result;

  assert.equal(spawnCalls.length, 2);
  assert.equal(resultValue.text, CANONICAL_DOCUMENT);

  // With no first-call text to reuse, the retry prompt must say so
  // explicitly and include the canonical-format template so the
  // model still has a strict shape to follow.
  const retryPrompt = promptFor(spawnCalls[1]);
  assert.match(retryPrompt, /Your previous response produced no output/);
  assert.match(retryPrompt, /# Review — <title>/, 'retry prompt must include the canonical format template');
  // Original prompt must still be appended so the model has the diff
  // + task prompt to work from.
  assert.ok(retryPrompt.includes(PROMPT), 'retry prompt must include the original prompt as fallback context');
});

test('invokeOpenCode returns the LAST attempt text when all 3 attempts fail to produce a heading', async () => {
  // All three attempts produce visible analysis but no `# Review —`
  // heading. The bounded loop runs all 3 attempts and falls through
  // to the last attempt's raw text so downstream validation in
  // `runReviews` (which routes through `validateReviewDocument`) can
  // surface a clean `failure-reason`.
  const firstCallText = '<think>first analysis only</think>';
  const secondCallText = '<think>second call also failed to emit a heading</think>';
  const thirdCallText = '<think>third call also failed to emit a heading</think>';
  const { result, spawnCalls } = runWithScript([
    { events: thinkingOnlyEvents(firstCallText, { input: 100, output: 1, cost: 0.1, reason: 'length' }) },
    { events: thinkingOnlyEvents(secondCallText, { input: 150, output: 1, cost: 0.1, reason: 'length' }) },
    { events: thinkingOnlyEvents(thirdCallText, { input: 200, output: 1, cost: 0.1, reason: 'length' }) },
  ]);

  const resultValue = await result;

  assert.equal(spawnCalls.length, 3, 'loop runs all 3 attempts when no attempt produces a heading');
  // The wrapper does NOT throw on a missing heading: it returns the
  // raw text from the LAST attempt so downstream validation can
  // surface a clean `failure-reason`.
  assert.equal(resultValue.text, thirdCallText);
  // Tokens and cost are still summed across all 3 attempts - the
  // budget was spent, even if no canonical document came back.
  assert.equal(resultValue.tokens.input, 450);
  assert.equal(resultValue.tokens.output, 3);
  assert.ok(Math.abs(resultValue.cost - 0.3) < 1e-9, `cost should sum to 0.3, got ${resultValue.cost}`);
});

test('invokeOpenCode sums tokens and cost across the two calls', async () => {
  const { result } = runWithScript([
    { events: thinkingOnlyEvents('<think>partial analysis</think>', { input: 250, output: 3, cost: 0.07 }) },
    { events: reviewEvents(CANONICAL_DOCUMENT, { input: 270, output: 120, cost: 0.18 }) },
  ]);

  const resultValue = await result;

  assert.equal(resultValue.tokens.input, 250 + 270);
  assert.equal(resultValue.tokens.output, 3 + 120);
  assert.equal(resultValue.cost, 0.07 + 0.18);
});

test('invokeOpenCode passes the SAME model string on the retry as on the first call', async () => {
  const { result, spawnCalls } = runWithScript([
    { events: thinkingOnlyEvents('<think>first call</think>', { input: 50, output: 1, cost: 0.01 }) },
    { events: reviewEvents(CANONICAL_DOCUMENT, { input: 60, output: 40, cost: 0.05 }) },
  ]);

  await result;

  assert.equal(spawnCalls.length, 2);
  // Both calls must use the same `--model=` argument; the wrapper is
  // not allowed to swap models under the caller.
  const firstModelArg = spawnCalls[0].args.find((arg) => arg.startsWith('--model='));
  const secondModelArg = spawnCalls[1].args.find((arg) => arg.startsWith('--model='));
  assert.equal(firstModelArg, `--model=${MODEL}`);
  assert.equal(secondModelArg, `--model=${MODEL}`);
});

test('invokeOpenCode passes the FIRST call prompt as-is to the spawn', async () => {
  // Bound the regression where a future change accidentally prepends
  // the format directive to the first call (which would short-circuit
  // the natural prompt). The first call always receives the
  // caller's original prompt unchanged.
  const { result, spawnCalls } = runWithScript([{ events: reviewEvents(CANONICAL_DOCUMENT) }]);
  await result;

  assert.equal(spawnCalls.length, 1);
  const firstPrompt = promptFor(spawnCalls[0]);
  assert.equal(firstPrompt, PROMPT, 'first call must receive the original prompt verbatim');
  assert.ok(!firstPrompt.includes('# Review — <title>'), 'first call must not be wrapped in the retry format directive');
});

// ---------------------------------------------------------------------------
// Format-invalid retry trigger: heading is present, but the body fails
// the validator's two most common rejection modes (## Scope bullets,
// finding Location pattern). These cover the production failure mode
// the latest CI run hit: the model produced a document but the
// validator rejected it for `Scope no bullets` or `Location: <path>`
// (no line numbers).
// ---------------------------------------------------------------------------

test('invokeOpenCode retries when the first call has a heading but ## Scope has no bullets', async () => {
  // The first call emits a structurally well-formed-looking document
  // EXCEPT that ## Scope is followed directly by ## Summary with no
  // bullet lines in between. The validator rejects with
  // "## Scope section is present but contains no bullets".
  const scopeWithoutBullets = [
    '# Review — title',
    '',
    '## Scope',
    'Reviewed the change.',
    '',
    '## Summary',
    '- New findings: 0',
    '- Unresolved from prior review: 0',
    '- Resolved by latest commits: 0',
  ].join('\n');

  const { result, spawnCalls } = runWithScript([
    { events: reviewEvents(scopeWithoutBullets, { input: 200, output: 50, cost: 0.10 }) },
    { events: reviewEvents(CANONICAL_DOCUMENT, { input: 220, output: 80, cost: 0.06 }) },
  ]);

  const resultValue = await result;
  assert.equal(spawnCalls.length, 2, 'retry must fire on the no-bullets Scope failure');
  assert.equal(resultValue.text, CANONICAL_DOCUMENT);

  const retryPrompt = promptFor(spawnCalls[1]);
  // The retry directive must call out the specific validator reason
  // (now formatted as a numbered list) so the model knows exactly
  // which rule to fix.
  assert.match(retryPrompt, /the validator rejected it for the following format reasons:/);
  assert.match(retryPrompt, /\n\s+1\. ## Scope section is present but contains no bullets/);
  assert.ok(retryPrompt.includes(scopeWithoutBullets), 'retry prompt must include the first-call text as context');
  // Tokens / cost still sum across both calls.
  assert.equal(resultValue.tokens.input, 200 + 220);
  assert.equal(resultValue.cost, 0.10 + 0.06);
});

test('invokeOpenCode retries when the first call has a finding with a Location that lacks line numbers', async () => {
  // The first call emits a heading + Scope + a finding whose
  // Location field is a bare path with no `:line` suffix. The
  // validator rejects with a "must match <path>:<line>" reason.
  const findingWithoutLineNumber = [
    '# Review — title',
    '',
    '## Scope',
    '- Reviewed the change.',
    '',
    '## Summary',
    '- New findings: 1',
    '- Unresolved from prior review: 0',
    '- Resolved by latest commits: 0',
    '',
    '## Findings',
    '',
    '### 🔴 Critical — bogus /dev/null probe',
    '- Status: new',
    '- Location: packages/run-reviews/src/runtime.ts',
    '- Description: probe targets /dev/null instead of the working dir.',
  ].join('\n');

  const { result, spawnCalls } = runWithScript([
    { events: reviewEvents(findingWithoutLineNumber, { input: 250, output: 60, cost: 0.12 }) },
    { events: reviewEvents(CANONICAL_DOCUMENT, { input: 270, output: 90, cost: 0.07 }) },
  ]);

  const resultValue = await result;
  assert.equal(spawnCalls.length, 2, 'retry must fire on the bad-Location format failure');
  assert.equal(resultValue.text, CANONICAL_DOCUMENT);

  const retryPrompt = promptFor(spawnCalls[1]);
  // The validator's rejection surfaces in the directive as a single-
  // entry numbered list so the model can fix the Location format on
  // the retry.
  assert.match(retryPrompt, /the validator rejected it for the following format reasons:/);
  assert.match(retryPrompt, /\n\s+1\. finding at line 13 has invalid Location: .*must match <path>:<line>/);
  assert.ok(retryPrompt.includes(findingWithoutLineNumber), 'retry prompt must include the first-call text as context');
  assert.equal(resultValue.cost, 0.12 + 0.07);
});

test('invokeOpenCode does NOT retry when the first call is fully valid (heading + Scope bullets + valid Locations)', async () => {
  // A fully valid document with no format issues must take a single
  // spawn. Bound the regression where the retry trigger fires on
  // false positives from the client-side format check.
  const { result, spawnCalls } = runWithScript([
    { events: reviewEvents(CANONICAL_DOCUMENT, { input: 300, output: 100, cost: 0.15 }) },
  ]);

  const resultValue = await result;
  assert.equal(spawnCalls.length, 1, 'no retry when the first call passes all format checks');
  assert.equal(resultValue.text, CANONICAL_DOCUMENT);
  assert.equal(resultValue.cost, 0.15);
});

test('invokeOpenCode retries with a numbered list when the first call has BOTH a bad Location AND a Summary count mismatch', async () => {
  // Multi-issue document: the bare-path Location AND a Summary that
  // says "Unresolved: 3" when blocks yield "Unresolved: 3, Resolved: 0".
  // Mirrors the production failure mode in run #31226995889: single-fix
  // retry + multi-issue document = leak.
  const multiIssue = [
    '# Review — title',
    '',
    '## Scope',
    '- Reviewed the change.',
    '',
    '## Summary',
    '- New findings: 1',
    '- Unresolved from prior review: 3',
    '- Resolved by latest commits: 1',
    '',
    '## Findings',
    '',
    '### 🔴 Critical — bogus /dev/null probe',
    '- Status: new',
    '- Location: packages/run-reviews/src/main.ts',
    '- Description: probe targets /dev/null instead of working dir.',
    '',
    '### 🟡 Warning — unresolved issue A',
    '- Status: unresolved',
    '- Location: packages/run-reviews/src/opencode.ts:100',
    '- Description: pre-existing unresolved.',
    '',
    '### 🟡 Warning — unresolved issue B',
    '- Status: unresolved',
    '- Location: packages/run-reviews/src/opencode.ts:110',
    '- Description: pre-existing unresolved.',
    '',
    '### 🟡 Warning — unresolved issue C',
    '- Status: unresolved',
    '- Location: packages/run-reviews/src/opencode.ts:120',
    '- Description: pre-existing unresolved.',
  ].join('\n');

  const { result, spawnCalls } = runWithScript([
    { events: reviewEvents(multiIssue, { input: 350, output: 120, cost: 0.20 }) },
    { events: reviewEvents(CANONICAL_DOCUMENT, { input: 380, output: 90, cost: 0.08 }) },
  ]);

  const resultValue = await result;
  assert.equal(spawnCalls.length, 2, 'retry must fire when the first call has multi-issue format failures');
  assert.equal(resultValue.text, CANONICAL_DOCUMENT);

  const retryPrompt = promptFor(spawnCalls[1]);
  // The retry directive must surface BOTH issues as a numbered list
  // so the model fixes them in one pass.
  assert.match(retryPrompt, /the validator rejected it for the following format reasons:/);
  assert.match(retryPrompt, /\n\s+1\. finding at line 13 has invalid Location: .*must match <path>:<line>/);
  assert.match(retryPrompt, /\n\s+2\. count mismatch: summary says New=1, Unresolved=3, Resolved=1; blocks yield New=1, Unresolved=3, Resolved=0/);
  assert.ok(retryPrompt.includes(multiIssue), 'retry prompt must include the first-call text as context');
});

test('invokeOpenCode retries on Summary-count mismatch alone (no Location or Scope issues)', async () => {
  // Valid Scope + valid Locations, but Summary says New=2 while
  // blocks only yield New=1. Validator rejects with the count
  // mismatch reason.
  const countMismatch = [
    '# Review — title',
    '',
    '## Scope',
    '- Reviewed the change.',
    '',
    '## Summary',
    '- New findings: 2',
    '- Unresolved from prior review: 0',
    '- Resolved by latest commits: 0',
    '',
    '## Findings',
    '',
    '### 🔴 Critical — one real bug',
    '- Status: new',
    '- Location: packages/foo.ts:42',
    '- Description: a real bug.',
  ].join('\n');

  const { result, spawnCalls } = runWithScript([
    { events: reviewEvents(countMismatch, { input: 250, output: 60, cost: 0.12 }) },
    { events: reviewEvents(CANONICAL_DOCUMENT, { input: 270, output: 90, cost: 0.07 }) },
  ]);

  const resultValue = await result;
  assert.equal(spawnCalls.length, 2, 'retry must fire on the count-mismatch failure');
  assert.equal(resultValue.text, CANONICAL_DOCUMENT);

  const retryPrompt = promptFor(spawnCalls[1]);
  assert.match(retryPrompt, /the validator rejected it for the following format reasons:/);
  assert.match(retryPrompt, /\n\s+1\. count mismatch: summary says New=2, Unresolved=0, Resolved=0; blocks yield New=1, Unresolved=0, Resolved=0/);
  assert.ok(retryPrompt.includes(countMismatch), 'retry prompt must include the first-call text as context');
});

test('formatReviewDocumentIssues returns the bare-path Location reason', () => {
  const { formatReviewDocumentIssues } = bundle;
  const document = [
    '# Review — title',
    '',
    '## Scope',
    '- Reviewed.',
    '',
    '## Summary',
    '- New findings: 1',
    '- Unresolved from prior review: 0',
    '- Resolved by latest commits: 0',
    '',
    '## Findings',
    '',
    '### 🔴 Critical — bogus',
    '- Status: new',
    '- Location: packages/run-reviews/src/runtime.ts',
    '- Description: bad',
  ].join('\n');
  const issues = formatReviewDocumentIssues(document);
  assert.equal(issues.length, 1);
  assert.match(issues[0], /must match <path>:<line>/);
});

test('formatReviewDocumentIssues returns the Scope-no-bullets reason', () => {
  const { formatReviewDocumentIssues } = bundle;
  const document = [
    '# Review — title',
    '',
    '## Scope',
    'Reviewed.',
    '',
    '## Summary',
    '- New findings: 0',
    '- Unresolved from prior review: 0',
    '- Resolved by latest commits: 0',
  ].join('\n');
  const issues = formatReviewDocumentIssues(document);
  assert.deepEqual(issues, ['## Scope section is present but contains no bullets']);
});

test('formatReviewDocumentIssues returns the count-mismatch reason', () => {
  const { formatReviewDocumentIssues } = bundle;
  const document = [
    '# Review — title',
    '',
    '## Scope',
    '- Reviewed.',
    '',
    '## Summary',
    '- New findings: 2',
    '- Unresolved from prior review: 0',
    '- Resolved by latest commits: 0',
    '',
    '## Findings',
    '',
    '### 🔴 Critical — one real bug',
    '- Status: new',
    '- Location: packages/foo.ts:42',
    '- Description: a real bug.',
  ].join('\n');
  const issues = formatReviewDocumentIssues(document);
  assert.equal(issues.length, 1);
  assert.match(issues[0], /^count mismatch: summary says New=2, Unresolved=0, Resolved=0; blocks yield New=1, Unresolved=0, Resolved=0$/);
});

test('formatReviewDocumentIssues returns BOTH a Location issue and the count-mismatch for a multi-issue document', () => {
  const { formatReviewDocumentIssues } = bundle;
  const document = [
    '# Review — title',
    '',
    '## Scope',
    '- Reviewed.',
    '',
    '## Summary',
    '- New findings: 1',
    '- Unresolved from prior review: 3',
    '- Resolved by latest commits: 1',
    '',
    '## Findings',
    '',
    '### 🔴 Critical — bogus',
    '- Status: new',
    '- Location: packages/run-reviews/src/main.ts',
    '- Description: bad.',
    '',
    '### 🟡 Warning — A',
    '- Status: unresolved',
    '- Location: a.ts:1',
    '- Description: a.',
    '',
    '### 🟡 Warning — B',
    '- Status: unresolved',
    '- Location: b.ts:2',
    '- Description: b.',
    '',
    '### 🟡 Warning — C',
    '- Status: unresolved',
    '- Location: c.ts:3',
    '- Description: c.',
  ].join('\n');
  const issues = formatReviewDocumentIssues(document);
  assert.equal(issues.length, 2);
  assert.match(issues[0], /finding at line \d+ has invalid Location: .*must match <path>:<line>/);
  assert.match(issues[1], /^count mismatch: summary says New=1, Unresolved=3, Resolved=1; blocks yield New=1, Unresolved=3, Resolved=0$/);
});

test('formatReviewDocumentIssues returns an empty array for a fully valid document', () => {
  const { formatReviewDocumentIssues } = bundle;
  assert.deepEqual(formatReviewDocumentIssues(CANONICAL_DOCUMENT), []);
});

test('formatReviewDocumentIssues returns an empty array for trailing parentheticals in Summary (regression guard)', () => {
  // Mirrors the production failure mode in run 31230589499 / job
  // 93033507321: the model used to put inline reasoning in the
  // Summary bullets. The hardened
  // `REVIEW_AGENT_PROMPT_TEMPLATE`'s "WHAT NOT TO DO" section
  // names "extra bullets to Summary" and the field-ordering rule
  // (`Field 1: Status`, `Field 2: Location`, `Field 3:
  // Description`) so the model pattern-matches the WRONG examples
  // with the WRONG verdict. The client-side check is therefore
  // redundant — this regression guard asserts it does NOT emit
  // "unexpected content in ## Summary" for either parentheticals
  // or extra bullets, so a future reintroduction of the check
  // is a deliberate choice.
  const { formatReviewDocumentIssues } = bundle;
  const document = [
    '# Review — title',
    '',
    '## Scope',
    '- Reviewed.',
    '',
    '## Summary',
    '- New findings: 1',
    '- Unresolved from prior review: 0 (cannot verify diff not in context)',
    '- Resolved by latest commits: 1 (the OpenCode-only validator rejection fixed b)',
    '',
    '## Findings',
    '',
    '### 🔴 Critical — one real bug',
    '- Status: new',
    '- Location: packages/foo.ts:42',
    '- Description: a real bug.',
  ].join('\n');
  const issues = formatReviewDocumentIssues(document);
  // The parentheticals are NOT flagged by the client-side check
  // anymore — the prompt owns the contract now. The validator's
  // own parser still rejects them on the final pass.
  for (const issue of issues) {
    assert.ok(
      !/unexpected content in ## Summary/.test(issue),
      `helper must NOT emit "unexpected content in ## Summary" for trailing parentheticals (got: ${issue}); the prompt now owns this contract`,
    );
  }
});

test('formatReviewDocumentIssues returns an empty array for extra bullets in the Summary section (regression guard)', () => {
  // The hardened template's "WHAT NOT TO DO" list explicitly names
  // "Adding extra bullets to Summary (Note:, Total:)" as a slip the
  // model must avoid. The client-side check is therefore redundant.
  // This regression guard asserts the helper no longer flags extra
  // bullets, so a future reintroduction is a deliberate choice.
  const { formatReviewDocumentIssues } = bundle;
  const document = [
    '# Review — title',
    '',
    '## Scope',
    '- Reviewed.',
    '',
    '## Summary',
    '- New findings: 0',
    '- Unresolved from prior review: 0',
    '- Resolved by latest commits: 0',
    '- Note: 0',
    '',
    '## Findings',
  ].join('\n');
  const issues = formatReviewDocumentIssues(document);
  for (const issue of issues) {
    assert.ok(
      !/unexpected content in ## Summary/.test(issue),
      `helper must NOT emit "unexpected content in ## Summary" for extra bullets (got: ${issue}); the prompt now owns this contract`,
    );
  }
});

// ---------------------------------------------------------------------------
// Bounded retry loop (MAX_ATTEMPTS=3): tests for the 3-attempt cap,
// the reset-mode directive on the second retry, and the success
// mid-loop path.
// ---------------------------------------------------------------------------

// A document with bare-path Location AND no Scope bullets.
const BARE_PATH_NO_SCOPE = [
  '# Review — title',
  '',
  '## Scope',
  'Reviewed.',
  '',
  '## Summary',
  '- New findings: 1',
  '- Unresolved from prior review: 0',
  '- Resolved by latest commits: 0',
  '',
  '## Findings',
  '',
  '### 🔴 Critical — bogus',
  '- Status: new',
  '- Location: packages/run-reviews/src/runtime.ts',
  '- Description: bad',
].join('\n');

// A document with no Scope bullets AND no Location issues.
const NO_SCOPE_CLEAN_LOCATION = [
  '# Review — title',
  '',
  '## Scope',
  'Reviewed.',
  '',
  '## Summary',
  '- New findings: 1',
  '- Unresolved from prior review: 0',
  '- Resolved by latest commits: 0',
  '',
  '## Findings',
  '',
  '### 🔴 Critical — bogus',
  '- Status: new',
  '- Location: packages/foo.ts:42',
  '- Description: bad',
].join('\n');

test('invokeOpenCode returns on the 3rd attempt when the model fixes one issue per pass (reset-mode directive)', async () => {
  // Attempt 1: bare-path Location (no Scope bullets because the
  // paragraph "Reviewed." doesn't satisfy TOP_BULLET_PATTERN — wait,
  // it does because "Reviewed." is not a top-level bullet. So
  // attempt 1 has BOTH Scope-no-bullets AND a bad Location. Let
  // me use a document where only Location is bad on attempt 1.)
  //
  // Actually the BARE_PATH_NO_SCOPE document above is constructed
  // so that attempt 1 yields TWO issues (Scope no bullets + bad
  // Location). The model fixes the Location on attempt 2, but
  // introduces a different problem (still no bullets). Attempt 3
  // produces a clean document.
  const { result, spawnCalls } = runWithScript([
    { events: reviewEvents(BARE_PATH_NO_SCOPE, { input: 200, output: 50, cost: 0.10 }) },
    { events: reviewEvents(NO_SCOPE_CLEAN_LOCATION, { input: 220, output: 80, cost: 0.06 }) },
    { events: reviewEvents(CANONICAL_DOCUMENT, { input: 240, output: 100, cost: 0.04 }) },
  ]);

  const resultValue = await result;
  assert.equal(spawnCalls.length, 3, 'success on the 3rd attempt runs all 3 spawns');
  assert.equal(resultValue.text, CANONICAL_DOCUMENT);

  // The 2nd attempt's prompt uses the single-retry directive
  // (since priorIssuesByAttempt.length === 1).
  const attempt2Prompt = promptFor(spawnCalls[1]);
  assert.match(attempt2Prompt, /the validator rejected it for the following format reasons:/);
  assert.match(attempt2Prompt, /Scope section is present but contains no bullets/);
  assert.match(attempt2Prompt, /must match <path>:<line>/);

  // The 3rd attempt's prompt uses the RESET directive (since
  // priorIssuesByAttempt.length === 2). The reset directive
  // explicitly tells the model to start over with a clean
  // canonical document and lists BOTH prior attempts' issues.
  const attempt3Prompt = promptFor(spawnCalls[2]);
  assert.match(attempt3Prompt, /You have now tried twice/);
  assert.match(attempt3Prompt, /Start over with a clean canonical document/);
  assert.match(attempt3Prompt, /Attempt 1:/);
  assert.match(attempt3Prompt, /Attempt 2:/);
  // The 3rd attempt's prompt must NOT include the second-call
  // analysis as context (the reset mode drops the "Your previous
  // analysis" block).
  assert.ok(!attempt3Prompt.includes('Your previous analysis (for context):'), 'reset directive must NOT include the previous analysis block');

  // Tokens and cost are summed across all 3 attempts.
  assert.equal(resultValue.tokens.input, 200 + 220 + 240);
  assert.equal(resultValue.tokens.output, 50 + 80 + 100);
  assert.ok(Math.abs(resultValue.cost - (0.10 + 0.06 + 0.04)) < 1e-9, `cost should sum, got ${resultValue.cost}`);
});

test('invokeOpenCode caps at MAX_ATTEMPTS=3 when every attempt has format issues', async () => {
  // All 3 attempts produce a document with format issues. The
  // wrapper should run exactly 3 spawns and return the last
  // attempt's extracted text with summed tokens + cost.
  const brokenDocument = [
    '# Review — title',
    '',
    '## Scope',
    'Reviewed.',  // no bullets — Scope issue
    '',
    '## Summary',
    '- New findings: 1',
    '- Unresolved from prior review: 0',
    '- Resolved by latest commits: 0',
    '',
    '## Findings',
    '',
    '### 🔴 Critical — bogus',
    '- Status: new',
    '- Location: packages/run-reviews/src/runtime.ts',  // no line number — Location issue
    '- Description: bad',
  ].join('\n');

  const { result, spawnCalls } = runWithScript([
    { events: reviewEvents(brokenDocument, { input: 200, output: 50, cost: 0.10 }) },
    { events: reviewEvents(brokenDocument, { input: 220, output: 50, cost: 0.08 }) },
    { events: reviewEvents(brokenDocument, { input: 240, output: 50, cost: 0.06 }) },
  ]);

  const resultValue = await result;
  assert.equal(spawnCalls.length, 3, 'cap at 3 attempts when every attempt fails');
  // The wrapper returns the last attempt's text (which is the
  // brokenDocument; downstream validator surfaces the failure).
  assert.equal(resultValue.text, brokenDocument);
  // Tokens and cost are summed across all 3 attempts.
  assert.equal(resultValue.tokens.input, 660);
  assert.equal(resultValue.tokens.output, 150);
  assert.ok(Math.abs(resultValue.cost - 0.24) < 1e-9, `cost should sum to 0.24, got ${resultValue.cost}`);
});

test('invokeOpenCode returns on the 2nd attempt when the first call has no heading (existing behavior)', async () => {
  // After the loop refactor, missing-heading still triggers a
  // retry and the model can recover on attempt 2 — 2 spawns total,
  // not 3.
  const { result, spawnCalls } = runWithScript([
    { events: thinkingOnlyEvents('<think>the reviewer prompt requires a strict heading first...</think>', { input: 30000, output: 1, cost: 0.35, reason: 'length' }) },
    { events: reviewEvents(CANONICAL_DOCUMENT, { input: 30500, output: 80, cost: 0.10 }) },
  ]);

  const resultValue = await result;
  assert.equal(spawnCalls.length, 2, 'success on the 2nd attempt for the missing-heading case');
  assert.equal(resultValue.text, CANONICAL_DOCUMENT);
  assert.equal(resultValue.tokens.input, 30000 + 30500);
  assert.equal(resultValue.tokens.output, 1 + 80);
});

test('invokeOpenCode attempt-2 prompt references BOTH issues from attempt 1', async () => {
  // First call has a bare-path Location AND a Summary count
  // mismatch. The second call's prompt must list BOTH issues
  // (preserved behavior from PR #36's single-shot retry; verified
  // here to confirm the loop refactor doesn't regress the
  // directive content).
  const multiIssue = [
    '# Review — title',
    '',
    '## Scope',
    '- Reviewed.',
    '',
    '## Summary',
    '- New findings: 1',
    '- Unresolved from prior review: 0',
    '- Resolved by latest commits: 2',  // mismatch with the 1 new finding
    '',
    '## Findings',
    '',
    '### 🔴 Critical — bogus',
    '- Status: new',
    '- Location: packages/run-reviews/src/runtime.ts',  // bad Location
    '- Description: bad',
  ].join('\n');

  const { result, spawnCalls } = runWithScript([
    { events: reviewEvents(multiIssue, { input: 200, output: 50, cost: 0.10 }) },
    { events: reviewEvents(CANONICAL_DOCUMENT, { input: 220, output: 80, cost: 0.06 }) },
  ]);

  const resultValue = await result;
  assert.equal(spawnCalls.length, 2, 'success on the 2nd attempt for the multi-issue case');
  assert.equal(resultValue.text, CANONICAL_DOCUMENT);

  // The 2nd attempt's prompt must list BOTH issues (Location +
  // count mismatch) from the first attempt.
  const attempt2Prompt = promptFor(spawnCalls[1]);
  assert.match(attempt2Prompt, /the validator rejected it for the following format reasons:/);
  assert.match(attempt2Prompt, /\n\s+1\. finding at line \d+ has invalid Location: .*must match <path>:<line>/);
  assert.match(attempt2Prompt, /\n\s+2\. count mismatch: summary says New=1, Unresolved=0, Resolved=2; blocks yield New=1, Unresolved=0, Resolved=0/);
});