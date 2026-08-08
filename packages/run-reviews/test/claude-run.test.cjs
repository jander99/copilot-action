'use strict';

/**
 * Tests for the Claude Code CLI transport (`claude-run.ts`).
 *
 * Most tests spawn a fake `claude` process via a custom `spawn`
 * override and assert the parsed result shape. Two tests exercise
 * `ClaudeCodeRuntime.resolveModel` directly so we don't need to spawn
 * anything to verify model-format behavior.
 *
 * The fake process emits the NDJSON line shape documented for the
 * Claude Code CLI (`--output-format stream-json`): the final line is a
 * `{type: "result", ...}` event carrying `result`, `total_cost_usd`,
 * and `usage`.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const bundle = require('../dist-test/index.cjs');
const { runClaudeRun, ClaudeCodeRuntime } = bundle;

const PROMPT = 'return the canonical review';
const RAW_MODEL = 'anthropic/claude-sonnet-4.6';
const RESOLVED_MODEL = 'claude-sonnet-4.6';

function makeProcess({ events = [], stderr = '', exitCode = 0, stdinChunks } = {}) {
  const proc = new EventEmitter();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
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

function runWithEvents(events, overrides = {}) {
  const spawnCalls = [];
  const result = runClaudeRun(
    {
      prompt: PROMPT,
      model: RAW_MODEL,
      homeDir: '/tmp/claude-test-home',
      timeoutMinutes: 1,
      ...overrides,
    },
    {
      spawn: (command, args, options) => {
        const stdinChunks = [];
        const record = { command, args, options, stdinChunks };
        spawnCalls.push(record);
        const eventsForCall = overrides.process ?? { events };
        return makeProcess({ ...eventsForCall, stdinChunks });
      },
    },
  );
  return { result, spawnCalls };
}

test('runClaudeRun spawns claude with expected flags', async () => {
  const { result, spawnCalls } = runWithEvents([
    { type: 'result', subtype: 'success', result: 'hello', total_cost_usd: 0, usage: {} },
  ]);
  const resultValue = await result;

  assert.equal(resultValue.text, 'hello');
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].command, 'claude');

  // Verify the args sequence. Each `--allowedTools <name>` pair is a
  // separate argv entry (Claude Code accepts multiple separate
  // `--allowedTools` flags rather than a single comma-separated
  // value).
  const args = spawnCalls[0].args;
  assert.ok(args.includes('-p'), 'must pass -p for non-interactive mode');
  assert.ok(args.includes('--output-format'), 'must pass --output-format');
  assert.equal(args[args.indexOf('--output-format') + 1], 'stream-json');
  assert.ok(args.includes('--verbose'), 'must pass --verbose');
  assert.ok(args.includes('--include-partial-messages'), 'must pass --include-partial-messages');
  assert.ok(
    !args.includes('--dangerously-skip-permissions'),
    'must NOT pass --dangerously-skip-permissions — bypassing the permission system would defeat the --allowedTools lockdown and allow shell expansion in `git diff <$(...)>` arguments to match the allowlist',
  );

  // The full allowedTools allow-list must be present, each as its own
  // argv entry. `query` (Claude Code's internal sub-agent tool) is
  // intentionally excluded — see ClaudeCodeRuntime's doc comment.
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
  assert.deepEqual(seenTools, expectedTools, 'every allowedTool must appear once');
  assert.ok(
    !seenTools.includes('query'),
    'query MUST NOT be in the allowedTools list — sub-agent hops break the read-only boundary',
  );

  // Resolved model (provider prefix stripped) is passed to --model.
  const modelFlagIndex = args.indexOf('--model');
  assert.notEqual(modelFlagIndex, -1, '--model flag must be present');
  assert.equal(args[modelFlagIndex + 1], RESOLVED_MODEL);

  // Prompt is the trailing positional after `--`.
  assert.equal(args[args.length - 2], '--');
  assert.equal(args[args.length - 1], PROMPT);
});

test('runClaudeRun extracts text from the result event', async () => {
  const { result } = runWithEvents([
    { type: 'stream_event', delta: { text: 'partial ' } },
    { type: 'result', subtype: 'success', result: '# Review — title\n\n## Summary', total_cost_usd: 0, usage: {} },
  ]);
  const resultValue = await result;
  assert.equal(resultValue.text, '# Review — title\n\n## Summary');
});

test('runClaudeRun prefers the result event text over stream_event deltas', async () => {
  // The CLI emits incremental `stream_event` deltas as it streams
  // output, then a single terminal `result` event whose `result` field
  // holds the canonical text. The runtime must ignore the deltas so
  // partial chunks don't leak into the final review document.
  const { result } = runWithEvents([
    { type: 'stream_event', delta: { text: 'partial chunk one ' } },
    { type: 'stream_event', delta: { text: 'partial chunk two ' } },
    { type: 'result', subtype: 'success', result: 'canonical text', total_cost_usd: 0, usage: {} },
  ]);
  const resultValue = await result;
  assert.equal(resultValue.text, 'canonical text');
});

test('runClaudeRun extracts cost and tokens from the result event', async () => {
  const { result } = runWithEvents([
    {
      type: 'result',
      subtype: 'success',
      result: '',
      total_cost_usd: 0.42,
      usage: { input_tokens: 123, output_tokens: 45, cache_read_input_tokens: 7 },
    },
  ]);
  const resultValue = await result;
  assert.equal(resultValue.cost, 0.42);
  // cache_read_input_tokens is the fallback for the reasoning token
  // count when the CLI does not surface a dedicated `reasoning_tokens`
  // field.
  assert.deepEqual(resultValue.tokens, { input: 123, output: 45, reasoning: 7 });
});

test('runClaudeRun uses reasoning_tokens when the CLI surfaces it', async () => {
  const { result } = runWithEvents([
    {
      type: 'result',
      subtype: 'success',
      result: '',
      total_cost_usd: 0.5,
      usage: { input_tokens: 10, output_tokens: 5, reasoning_tokens: 99, cache_read_input_tokens: 7 },
    },
  ]);
  const resultValue = await result;
  assert.deepEqual(resultValue.tokens, { input: 10, output: 5, reasoning: 99 });
});

test('runClaudeRun preserves the original provider/model string in result', async () => {
  const { result } = runWithEvents([
    { type: 'result', subtype: 'success', result: '', total_cost_usd: 0, usage: {} },
  ]);
  const resultValue = await result;
  // The runtime resolves to `claude-sonnet-4.6` for the --model flag,
  // but the caller's original `anthropic/claude-sonnet-4.6` is what
  // downstream accounting (costByModel / tokensByModel) keys on.
  assert.equal(resultValue.model, RAW_MODEL);
});

test('runClaudeRun rejects models without provider/ prefix', async () => {
  // resolveModel throws BEFORE spawn is called, so we can exercise
  // the validation purely through the runtime class - no fake
  // process needed.
  const runtime = new ClaudeCodeRuntime();
  assert.throws(
    () => runtime.resolveModel('claude-sonnet-4.6'),
    /requires model in 'provider\/model' format/,
  );
  assert.throws(
    () => runtime.resolveModel(''),
    /requires model in 'provider\/model' format/,
  );
});

test('runClaudeRun handles an empty result text gracefully', async () => {
  const { result } = runWithEvents([
    { type: 'result', subtype: 'success', result: '', total_cost_usd: 0, usage: {} },
  ]);
  const resultValue = await result;
  assert.equal(resultValue.text, '');
  assert.equal(resultValue.cost, 0);
});

test('runClaudeRun reports stderr when the process exits non-zero', async () => {
  const { result } = runWithEvents([], {
    process: { events: [], stderr: 'auth failed: missing ANTHROPIC_API_KEY', exitCode: 1 },
  });

  await assert.rejects(result, (error) => {
    assert.match(error.message, /status 1/);
    assert.match(error.message, /auth failed/);
    return true;
  });
});

test('runClaudeRun routes the prompt through stdin when options.input is set (E2BIG fix)', async () => {
  // The reviewer side (`invokeReview` -> `runOnce`) always sets
  // `options.input` so the prompt is delivered via stdin. The
  // back-compat `runClaudeRun` entry point does NOT, so the
  // back-compat path uses argv. This test exercises the
  // `ClaudeCodeRuntime` directly with `input` set to verify the
  // runtime's command-args shape (it should substitute `-` for
  // the trailing positional, not the prompt text).
  const bigPrompt = 'B'.repeat(2048);
  const events = [
    { type: 'result', subtype: 'success', result: 'OK', total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 1 } },
  ];
  const spawnCalls = [];
  const result = runClaudeRun(
    {
      prompt: bigPrompt,
      model: RAW_MODEL,
      homeDir: '/tmp/claude-test-home',
      timeoutMinutes: 1,
      input: bigPrompt,
    },
    {
      spawn: (command, args, options) => {
        const stdinChunks = [];
        const record = { command, args, options, stdinChunks };
        spawnCalls.push(record);
        return makeProcess({ events, stdinChunks });
      },
    },
  );
  const resultValue = await result;
  assert.equal(resultValue.text, 'OK');

  assert.equal(spawnCalls.length, 1);
  // The prompt must NOT be in argv. The runtime substitutes `-`
  // (Claude Code's stdin sentinel) and the orchestrator writes
  // the actual prompt to `proc.stdin`.
  assert.equal(spawnCalls[0].args[spawnCalls[0].args.length - 1], '-');
  // The prompt content lands on stdin.
  const stdinContent = spawnCalls[0].stdinChunks.join('');
  assert.equal(stdinContent, bigPrompt, 'prompt must be delivered via stdin');
  // stdio[0] is 'pipe' when input is set; 'ignore' otherwise.
  assert.equal(spawnCalls[0].options.stdio[0], 'pipe', 'stdin must be a writable pipe');
});

test('buildEnvironment passes only the 5 claude-keys to the spawned process (no workflow secrets)', () => {
  // Regression guard for the "forwarded secrets" reviewer finding:
  // `buildEnvironment` must NOT spread `process.env`. The review
  // only needs the 5 keys required for the Anthropic-compatible
  // endpoint. Even when arbitrary secrets are set in `process.env`,
  // the spawn's env must not contain them.
  const ORIGINAL_ENV = process.env;
  // Plant a handful of secrets in `process.env`; the runtime
  // must NOT forward them.
  process.env = {
    ...ORIGINAL_ENV,
    GITHUB_TOKEN: 'ghp_supersecret',
    AWS_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
    AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    MINIMAX_API_KEY: 'sk-minimax-supersecret',
    NPM_TOKEN: 'npm_supersecret',
    RANDOM_OTHER_SECRET: 'should-not-leak',
  };
  try {
    const runtime = new ClaudeCodeRuntime();
    const env = runtime.buildEnvironment({});

    // The 5 keys the review actually needs.
    assert.ok('ANTHROPIC_BASE_URL' in env, 'ANTHROPIC_BASE_URL must be present');
    assert.ok('ANTHROPIC_AUTH_TOKEN' in env, 'ANTHROPIC_AUTH_TOKEN must be present');
    assert.ok('ANTHROPIC_API_KEY' in env, 'ANTHROPIC_API_KEY must be present (empty string suppresses OAuth fallback)');
    assert.ok('ANTHROPIC_MODEL' in env, 'ANTHROPIC_MODEL must be present');
    assert.ok('CLAUDE_ENABLE_BYTE_WATCHDOG' in env, 'CLAUDE_ENABLE_BYTE_WATCHDOG must be present');
    assert.ok('CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS' in env, 'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS must be present');

    // Empty defaults when the env vars are not set.
    assert.equal(env.ANTHROPIC_API_KEY, '');
    assert.equal(env.CLAUDE_ENABLE_BYTE_WATCHDOG, '0');
    assert.equal(env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS, '1');

    // No workflow secrets leaked.
    for (const key of Object.keys(env)) {
      assert.ok(
        !['GITHUB_TOKEN', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'MINIMAX_API_KEY', 'NPM_TOKEN', 'RANDOM_OTHER_SECRET']
          .includes(key),
        `env must not contain ${key} (secret leak)`,
      );
    }
    // The env is bounded: only the 6 keys above.
    assert.equal(
      Object.keys(env).sort().join(','),
      ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS', 'CLAUDE_ENABLE_BYTE_WATCHDOG'].sort().join(','),
      'env must contain exactly the 6 allow-listed keys (5 endpoint + 1 empty ANTHROPIC_API_KEY)',
    );
  } finally {
    process.env = ORIGINAL_ENV;
  }
});

test('buildEnvironment forwards the 5 claude-keys when present in process.env', () => {
  // The runtime reads ANTHROPIC_* and CLAUDE_* from process.env
  // as the action layer's "passthrough" surface. The runtime does
  // NOT read arbitrary workflow secrets.
  const ORIGINAL_ENV = process.env;
  process.env = {
    ...ORIGINAL_ENV,
    ANTHROPIC_BASE_URL: 'https://api.minimax.io/anthropic',
    ANTHROPIC_AUTH_TOKEN: 'token-abc',
    ANTHROPIC_MODEL: 'MiniMax-M3',
    // These are NOT in the allow-list — they must NOT leak.
    GITHUB_TOKEN: 'should-not-leak',
    AWS_SECRET_ACCESS_KEY: 'should-not-leak',
  };
  try {
    const runtime = new ClaudeCodeRuntime();
    const env = runtime.buildEnvironment({});
    assert.equal(env.ANTHROPIC_BASE_URL, 'https://api.minimax.io/anthropic');
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'token-abc');
    assert.equal(env.ANTHROPIC_MODEL, 'MiniMax-M3');
    assert.equal(env.ANTHROPIC_API_KEY, '');
    assert.equal(env.CLAUDE_ENABLE_BYTE_WATCHDOG, '0');
    assert.equal(env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS, '1');
    assert.equal(env.GITHUB_TOKEN, undefined, 'GITHUB_TOKEN must not leak');
    assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined, 'AWS_SECRET_ACCESS_KEY must not leak');
  } finally {
    process.env = ORIGINAL_ENV;
  }
});