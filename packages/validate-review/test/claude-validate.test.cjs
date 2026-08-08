'use strict';

/**
 * Tests for the validator's Claude Code CLI transport.
 *
 * Mirrors the structure of `packages/run-reviews/test/claude-run.test.cjs`:
 * a fake spawn lets each test script the CLI's NDJSON output without
 * touching the real binary. The validator's surface is smaller than
 * the reviewer's — no retry loop, no format-fallback — so the
 * assertions focus on:
 *   - spawn args match the reviewer's shape (-p, --output-format
 *     stream-json, --verbose, --include-partial-messages, the stripped
 *     --model, and the read-only --allowedTools list). We deliberately
 *     do NOT pass --dangerously-skip-permissions here either — same
 *     reason as the reviewer.
 *   - the resolved model id (provider/ prefix stripped) is passed
 *     to --model
 *   - the env block carries the Anthropic-compatible-endpoint
 *     switches the action layer forwards (ANTHROPIC_BASE_URL,
 *     ANTHROPIC_AUTH_TOKEN, ANTHROPIC_API_KEY="",
 *     CLAUDE_ENABLE_BYTE_WATCHDOG=0,
 *     CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1)
 *   - parseValidatorResponse still strips <think> blocks before
 *     matching the `VALID` / `INVALID <reason>` first line
 *
 * The validator's own test file. Lives alongside
 * `parse-validator-response.test.cjs` in `test/`.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const bundle = require('../dist-test/index.cjs');
const { runClaudeValidator, ClaudeCodeValidatorRuntime, parseValidatorResponse } = bundle;

const PROMPT = 'validator prompt: reply with VALID or INVALID <reason>';
const RAW_MODEL = 'anthropic/MiniMax-M3';
const RESOLVED_MODEL = 'MiniMax-M3';

/**
 * Build a fake `claude` process. The test plumbing is intentionally
 * simple — we use a plain EventEmitter with a small "stdout" /
 * "stderr" abstraction that emits synchronously on `write`. The
 * orchestrator inside `runClaudeValidator` attaches `data`
 * listeners to `proc.stdout` / `proc.stderr` and then awaits
 * `proc` `close`. Emitting data synchronously in the same tick as
 * `close` keeps the orchestrator's reads-after-close deterministic
 * regardless of the test runner's microtask scheduling (which
 * varies between `node test/file.cjs` and `node --test
 * test/file.cjs`).
 */
function makeFakeStream() {
  const stream = new EventEmitter();
  stream.write = (text) => {
    // Emit synchronously so the listener sees the data before close.
    stream.emit('data', text);
  };
  stream.end = () => {};
  return stream;
}

function makeProcess({ events = [], stderr = '', exitCode = 0, stdinChunks } = {}) {
  const proc = new EventEmitter();
  proc.stdout = makeFakeStream();
  proc.stderr = makeFakeStream();
  // The validator's orchestrator delivers the prompt via
  // `proc.stdin.write(...)` (after the E2BIG fix) when the
  // runtime is set to use stdin. Capture the writes so tests
  // can assert on the actual prompt that was sent.
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
    proc.emit('close', exitCode, null);
  });

  return proc;
}

/**
 * Drive `runClaudeValidator` against a single canned event sequence
 * for the fake `claude` process. Returns the spawn call records
 * (so the test can assert on the args + env) and the awaited result.
 */
function runWithEvents(events, overrides = {}) {
  const spawnCalls = [];
  const result = runClaudeValidator(
    {
      prompt: PROMPT,
      model: RAW_MODEL,
      timeoutMinutes: 1,
      passthroughEnv: {
        ANTHROPIC_BASE_URL: 'https://api.minimax.io/anthropic',
        ANTHROPIC_AUTH_TOKEN: 'token-123',
        ANTHROPIC_API_KEY: '',
        CLAUDE_ENABLE_BYTE_WATCHDOG: '0',
        CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
      },
      ...overrides,
    },
    (command, args, options) => {
      const stdinChunks = [];
      const record = { command, args, options, stdinChunks };
      spawnCalls.push(record);
      // Wrap in `{ events }` so makeProcess's destructuring picks
      // up the array as the `events` option rather than the array
      // itself (whose `.events` is undefined → defaults to []).
      return makeProcess({ events, stdinChunks, ...overrides.process });
    },
  );
  return { result, spawnCalls };
}

test('runClaudeValidator spawns claude with the expected flags (mirroring the reviewer)', async () => {
  const { result, spawnCalls } = runWithEvents([
    { type: 'result', subtype: 'success', result: 'VALID', total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 2 } },
  ]);
  const resultValue = await result;

  assert.equal(resultValue.text, 'VALID');
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].command, 'claude');

  const args = spawnCalls[0].args;
  assert.ok(args.includes('-p'), 'must pass -p for non-interactive mode');
  assert.ok(args.includes('--output-format'), 'must pass --output-format');
  assert.equal(args[args.indexOf('--output-format') + 1], 'stream-json');
  assert.ok(args.includes('--verbose'), 'must pass --verbose');
  assert.ok(args.includes('--include-partial-messages'), 'must pass --include-partial-messages');
  assert.ok(
    !args.includes('--dangerously-skip-permissions'),
    'must NOT pass --dangerously-skip-permissions — same security reason as the reviewer (allowlist enforcement)',
  );

  // Same allow-list as the reviewer's claude runtime. `query`
  // (Claude Code's internal sub-agent tool) is intentionally
  // excluded — see ClaudeCodeValidatorRuntime's doc comment.
  const expectedTools = [
    'Read',
    'Glob',
    'Grep',
    'Bash(git diff *)',
    'Bash(git show *)',
    'Bash(git log *)',
    'Bash(git rev-parse *)',
  ];
  const seenTools = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--allowedTools') {
      seenTools.push(args[i + 1]);
      i += 1;
    }
  }
  assert.deepEqual(seenTools, expectedTools, 'validator allow-list must match reviewer allow-list');
  assert.ok(
    !seenTools.includes('query'),
    'query MUST NOT be in the validator allowedTools list — sub-agent hops break the read-only boundary',
  );

  // Resolved model (provider prefix stripped) is passed to --model.
  const modelFlagIndex = args.indexOf('--model');
  assert.notEqual(modelFlagIndex, -1, '--model flag must be present');
  assert.equal(args[modelFlagIndex + 1], RESOLVED_MODEL);

  // The prompt is delivered via stdin (to avoid the OS `ARG_MAX`
  // limit on long reviews), so the trailing positional is `-`
  // (Claude Code's stdin sentinel) rather than the prompt text.
  assert.equal(args[args.length - 1], '-');
});

test('runClaudeValidator env block carries the Anthropic-compatible endpoint switches', async () => {
  const { result, spawnCalls } = runWithEvents([
    { type: 'result', subtype: 'success', result: 'VALID', total_cost_usd: 0, usage: {} },
  ]);
  await result;

  assert.equal(spawnCalls.length, 1);
  const env = spawnCalls[0].options.env;
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://api.minimax.io/anthropic');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'token-123');
  // Set to empty string (NOT unset) so Claude Code CLI's OAuth fallback is suppressed.
  assert.equal(env.ANTHROPIC_API_KEY, '');
  // Minimax rejects Claude Code's experimental beta headers and its
  // byte-level streaming watchdog; both flags disable that.
  assert.equal(env.CLAUDE_ENABLE_BYTE_WATCHDOG, '0');
  assert.equal(env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS, '1');
});

test('runClaudeValidator parses VALID response with cost + tokens', async () => {
  const { result } = runWithEvents([
    {
      type: 'result',
      subtype: 'success',
      result: 'VALID',
      total_cost_usd: 0.42,
      usage: { input_tokens: 200, output_tokens: 50 },
    },
  ]);
  const resultValue = await result;
  assert.equal(resultValue.cost, 0.42);
  assert.deepEqual(resultValue.tokens, { input: 200, output: 50 });
});

test('runClaudeValidator parses INVALID response (extracted via parseValidatorResponse)', async () => {
  const { result } = runWithEvents([
    {
      type: 'result',
      subtype: 'success',
      // The model emits a <think> block followed by the actual verdict.
      // parseValidatorResponse strips thinking blocks before matching
      // the first non-empty line.
      result: '<think>Let me check the document carefully...\n\nThe summary says New=2 but I only see 1 finding block.\n</think>\nINVALID count mismatch: summary says New=2, blocks yield New=1',
      total_cost_usd: 0.05,
      usage: { input_tokens: 100, output_tokens: 30 },
    },
  ]);
  const resultValue = await result;

  // Sanity check the raw text passes the think-strip on its own.
  assert.equal(parseValidatorResponse(resultValue.text).status, 'invalid');
  assert.match(parseValidatorResponse(resultValue.text).reason, /count mismatch/);
});

test('runClaudeValidator rejects models without provider/ prefix', async () => {
  // resolveModel throws BEFORE spawn is called. No fake process needed.
  await assert.rejects(
    runClaudeValidator({ prompt: PROMPT, model: 'MiniMax-M3', timeoutMinutes: 1 }),
    /requires model in 'provider\/model' format/,
  );
  await assert.rejects(
    runClaudeValidator({ prompt: PROMPT, model: '', timeoutMinutes: 1 }),
    /requires model in 'provider\/model' format/,
  );
});

test('runClaudeValidator reports stderr when the process exits non-zero', async () => {
  const spawnCalls = [];
  const result = runClaudeValidator(
    {
      prompt: PROMPT,
      model: RAW_MODEL,
      timeoutMinutes: 1,
    },
    (command, args, options) => {
      spawnCalls.push({ command, args, options });
      return makeProcess({ events: [], stderr: 'auth failed: missing ANTHROPIC_AUTH_TOKEN', exitCode: 1 });
    },
  );

  await assert.rejects(result, (error) => {
    assert.match(error.message, /status 1/);
    assert.match(error.message, /auth failed/);
    return true;
  });
  assert.equal(spawnCalls.length, 1, 'spawn must happen before exit-code check');
});

test('ClaudeCodeValidatorRuntime.resolveModel strips the provider prefix', () => {
  const runtime = new ClaudeCodeValidatorRuntime();
  assert.equal(runtime.resolveModel('anthropic/MiniMax-M3'), 'MiniMax-M3');
  assert.equal(runtime.resolveModel('openai/something'), 'something');
  // No slash → throws (mirrors the reviewer's check).
  assert.throws(() => runtime.resolveModel('MiniMax-M3'), /requires model in 'provider\/model' format/);
});

test('ClaudeCodeValidatorRuntime.buildEnvironment layers passthroughEnv over the scoped 5-key env', () => {
  // Regression guard for the "forwarded secrets" finding: the
  // validator's env is now built from a fixed 5-key allow-list
  // (the same shape as the reviewer's claude runtime). Spreading
  // `process.env` is no longer in the path; if the workflow
  // happens to set `GITHUB_TOKEN` or any other secret, it must
  // NOT leak into the spawn's env.
  const ORIGINAL_ENV = process.env;
  process.env = {
    ...ORIGINAL_ENV,
    GITHUB_TOKEN: 'ghp_supersecret',
    AWS_SECRET_ACCESS_KEY: 'should-not-leak',
    MINIMAX_API_KEY: 'sk-minimax-supersecret',
  };
  try {
    const runtime = new ClaudeCodeValidatorRuntime();
    const env = runtime.buildEnvironment({
      ANTHROPIC_BASE_URL: 'https://override.example/anthropic',
    });

    // The 5 keys the review actually needs are present.
    assert.ok('ANTHROPIC_BASE_URL' in env, 'ANTHROPIC_BASE_URL must be present');
    assert.ok('ANTHROPIC_AUTH_TOKEN' in env, 'ANTHROPIC_AUTH_TOKEN must be present');
    assert.ok('ANTHROPIC_API_KEY' in env, 'ANTHROPIC_API_KEY must be present');
    assert.ok('ANTHROPIC_MODEL' in env, 'ANTHROPIC_MODEL must be present');
    assert.ok('CLAUDE_ENABLE_BYTE_WATCHDOG' in env, 'CLAUDE_ENABLE_BYTE_WATCHDOG must be present');
    assert.ok('CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS' in env, 'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS must be present');

    // passthroughEnv override wins for ANTHROPIC_* keys.
    assert.equal(env.ANTHROPIC_BASE_URL, 'https://override.example/anthropic');
    // Empty defaults.
    assert.equal(env.ANTHROPIC_API_KEY, '');
    assert.equal(env.CLAUDE_ENABLE_BYTE_WATCHDOG, '0');
    assert.equal(env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS, '1');

    // No workflow secrets leaked.
    assert.equal(env.GITHUB_TOKEN, undefined, 'GITHUB_TOKEN must not leak');
    assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined, 'AWS_SECRET_ACCESS_KEY must not leak');
    assert.equal(env.MINIMAX_API_KEY, undefined, 'MINIMAX_API_KEY must not leak');

    // The env is bounded: only the 6 keys above.
    assert.equal(
      Object.keys(env).sort().join(','),
      ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS', 'CLAUDE_ENABLE_BYTE_WATCHDOG'].sort().join(','),
      'env must contain exactly the 6 allow-listed keys',
    );
  } finally {
    process.env = ORIGINAL_ENV;
  }
});

test('runClaudeValidator routes the prompt through stdin (E2BIG fix)', async () => {
  // The validator's prompt embeds the review file content, which
  // can be substantial. Routing through stdin keeps the argv
  // under `ARG_MAX` regardless of how long the review document
  // gets. The trailing positional is `-` (Claude Code's stdin
  // sentinel) and the prompt is delivered via `proc.stdin.write`.
  const bigPrompt = 'C'.repeat(4096);
  const { result, spawnCalls } = runWithEvents(
    [{ type: 'result', subtype: 'success', result: 'VALID', total_cost_usd: 0, usage: {} }],
    { prompt: bigPrompt },
  );
  await result;

  assert.equal(spawnCalls.length, 1);
  const args = spawnCalls[0].args;
  // Trailing positional is `-`, NOT the prompt.
  assert.equal(args[args.length - 1], '-', 'trailing positional must be the stdin sentinel');
  // The prompt must NOT be in argv anywhere.
  assert.ok(!args.includes(bigPrompt), 'prompt must not appear in argv');
  // The prompt content lands on stdin.
  const stdinContent = spawnCalls[0].stdinChunks.join('');
  assert.equal(stdinContent, bigPrompt, 'prompt must be delivered via stdin');
  // stdio[0] is 'pipe' (writable) when input is set; the
  // orchestrator's `'ignore'` mode would have closed stdin and
  // the CLI would have seen EOF with no prompt.
  assert.equal(spawnCalls[0].options.stdio[0], 'pipe');
});