'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const bundle = require('../dist-test/index.cjs');
const { runOpenCodeRun } = bundle;

const PROMPT = 'return the canonical review';
const MODEL = 'opencode-go/minimax-m3';

function makeProcess({ events = [], stderr = '', exitCode = 0, stdinChunks } = {}) {
  const proc = new EventEmitter();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  // The orchestrator delivers the prompt via `proc.stdin.write(...)`
  // when `options.input` is set. Capture the writes into the
  // supplied array so tests can assert on the actual prompt that
  // was sent.
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
  const result = runOpenCodeRun(
    {
      prompt: PROMPT,
      model: MODEL,
      configPath: '/tmp/opencode-test.json',
      homeDir: '/tmp/opencode-test-home',
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

test('runOpenCodeRun returns terminal text after a successful process exit', async () => {
  const { result, spawnCalls } = runWithEvents([
    { type: 'text', part: { type: 'text', text: 'draft' } },
    { type: 'step_finish', part: { type: 'step-finish', reason: 'tool-calls' } },
    { type: 'text', part: { type: 'text', text: '# Review — title\n\n## Scope\n- Reviewed X\n\n## Summary' } },
    {
      type: 'step_finish',
      part: {
        type: 'step-finish',
        reason: 'stop',
        tokens: { input: 10, output: 4 },
        cost: 0.25,
      },
    },
  ]);
  const resultValue = await result;

  assert.equal(resultValue.text, '# Review — title\n\n## Scope\n- Reviewed X\n\n## Summary');
  assert.equal(resultValue.model, MODEL);
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].command, 'opencode');
  assert.deepEqual(spawnCalls[0].args, [
    `--model=${MODEL}`,
    'run',
    '--format=json',
    '--',
    PROMPT,
  ]);
});

test('runOpenCodeRun preserves a terminal document with Scope', async () => {
  const body = [
    '# Review — title',
    '',
    '## Scope',
    '- Reviewed X',
    '',
    '## Summary',
    '- New findings: 0',
    '- Unresolved from prior review: 0',
    '- Resolved by latest commits: 0',
  ].join('\n');
  const { result } = runWithEvents([
    { type: 'text', part: { type: 'text', text: body } },
    { type: 'step_finish', part: { type: 'step-finish', reason: 'stop' } },
  ]);

  const resultValue = await result;
  assert.equal(resultValue.text, body);
});
test('runOpenCodeRun reports stderr when the process exits non-zero', async () => {
  const { result } = runWithEvents([], {
    process: { events: [], stderr: 'plugin installation failed', exitCode: 7 },
  });

  await assert.rejects(result, (error) => {
    assert.match(error.message, /status 7/);
    assert.match(error.message, /plugin installation failed/);
    return true;
  });
});

test('runOpenCodeRun returns empty text when no text event is present', async () => {
  const { result } = runWithEvents([
    { type: 'step_finish', part: { type: 'step-finish', reason: 'stop' } },
  ]);

  const resultValue = await result;
  assert.equal(resultValue.text, '');
});

test('runOpenCodeRun respects the terminal step-finish boundary', async () => {
  const { result } = runWithEvents([
    { type: 'text', part: { type: 'text', text: 'before stop' } },
    { type: 'step_finish', part: { type: 'step-finish', reason: 'stop' } },
    { type: 'text', part: { type: 'text', text: 'after stop' } },
  ]);

  const resultValue = await result;
  assert.equal(resultValue.text, 'before stop');
});

test('runOpenCodeRun extracts cost and tokens from the final step-finish event', async () => {
  const { result } = runWithEvents([
    {
      type: 'step_finish',
      part: { type: 'step-finish', reason: 'tool-calls', tokens: { input: 1, output: 2 }, cost: 0.01 },
    },
    { type: 'text', part: { type: 'text', text: 'final' } },
    {
      type: 'step_finish',
      part: {
        type: 'step-finish',
        reason: 'stop',
        tokens: { input: 30, output: 12, reasoning: 5 },
        cost: 0.75,
      },
    },
  ]);

  const resultValue = await result;
  assert.deepEqual(resultValue.tokens, { input: 30, output: 12, reasoning: 5 });
  assert.equal(resultValue.cost, 0.75);
});

test('runOpenCodeRun routes the prompt through stdin when options.input is set (E2BIG fix)', async () => {
  // Mirrors the failure mode in PR #35's run 31230589499: when the
  // prompt + embedded diff exceeds the OS `ARG_MAX` (~128 KB on
  // Linux), passing the prompt via argv causes `execve` to fail
  // with E2BIG. The fix delivers the prompt via stdin (`-` as
  // the positional arg) instead.
  const bigPrompt = 'A'.repeat(1024);
  const { result, spawnCalls } = runWithEvents([
    { type: 'result', part: { type: 'step-finish', reason: 'stop', tokens: { input: 5, output: 5 }, cost: 0.01 } },
  ], { prompt: bigPrompt, input: bigPrompt });

  await result;

  assert.equal(spawnCalls.length, 1);
  const args = spawnCalls[0].args;
  // The prompt MUST NOT be in argv when `input` is set: the
  // runtime substitutes `-` (opencode's stdin sentinel) for the
  // trailing positional. The CLI reads the actual prompt text
  // from stdin.
  assert.deepEqual(args, [`--model=${MODEL}`, 'run', '--format=json', '-']);
  // The prompt content lands on stdin via `proc.stdin.write(...)`.
  const stdinContent = spawnCalls[0].stdinChunks.join('');
  assert.equal(stdinContent, bigPrompt, 'prompt must be delivered via stdin');
  // The runtime's spawn uses `stdio: ['pipe', 'pipe', 'pipe']`
  // so stdin is writable; the existing `'ignore'` mode would
  // have closed stdin and the CLI would have seen EOF with no
  // prompt.
  assert.equal(spawnCalls[0].options.stdio[0], 'pipe', 'stdin must be a writable pipe');
});

test('runOpenCodeRun falls back to argv when options.input is absent (back-compat)', async () => {
  // The back-compat `runOpenCodeRun` entry point (used by the
  // validator's opencode path) does NOT set `options.input`,
  // so the prompt must remain in argv after `--`. This test
  // bounds the regression where the change accidentally breaks
  // the back-compat path.
  const { result, spawnCalls } = runWithEvents([
    { type: 'result', part: { type: 'step-finish', reason: 'stop', tokens: { input: 5, output: 5 }, cost: 0.01 } },
  ]);

  await result;

  assert.equal(spawnCalls.length, 1);
  assert.deepEqual(spawnCalls[0].args, [`--model=${MODEL}`, 'run', '--format=json', '--', PROMPT]);
  // No stdin content captured (input was not set).
  assert.equal(spawnCalls[0].stdinChunks.join(''), '');
  // stdio[0] is 'ignore' when input is absent.
  assert.equal(spawnCalls[0].options.stdio[0], 'ignore');
});

test('runOpenCodeRun inherits PATH from process.env so the binary is resolvable', async () => {
  // The opencode runtime spreads `process.env` and only strips
  // `OPENCODE_*` entries, so PATH (and HOME, etc.) flow through
  // unchanged. Without PATH the spawn fails with `ENOENT` (the
  // same failure mode the reviewer hit when the env filter
  // dropped PATH from the claude runtime's scoped env). This
  // regression-guard bounds the regression where a future change
  // accidentally switches the opencode runtime to a scoped env
  // and forgets to include PATH.
  const ORIGINAL_ENV = process.env;
  process.env = {
    ...ORIGINAL_ENV,
    PATH: '/usr/local/bin:/usr/bin:/bin:/opt/hostedtoolcache',
    GITHUB_TOKEN: 'should-not-be-special-cased',
  };
  try {
    const { result, spawnCalls } = runWithEvents([
      { type: 'result', part: { type: 'step-finish', reason: 'stop', tokens: { input: 1, output: 1 }, cost: 0 } },
    ]);
    await result;
    const env = spawnCalls[0].options.env;
    assert.equal(
      env.PATH,
      '/usr/local/bin:/usr/bin:/bin:/opt/hostedtoolcache',
      'PATH must be forwarded from process.env so the OS can resolve the `opencode` binary',
    );
    // Inherited from process.env (the opencode runtime does not
    // filter arbitrary entries; the OPENCODE_* allow-list is what
    // governs secret leakage for opencode, not the env block).
    assert.equal(env.GITHUB_TOKEN, 'should-not-be-special-cased');
    // Stale OPENCODE_* entries must NOT survive the buildEnvironment
    // pass — the merged config is the only source of truth.
    assert.equal(env.OPENCODE_PERMISSION, JSON.stringify({
      read: 'deny',
      glob: 'deny',
      grep: 'deny',
      list: 'deny',
      webfetch: 'deny',
      edit: 'deny',
      write: 'deny',
      question: 'deny',
      doom_loop: 'deny',
      bash: { '*': 'ask', 'git log *': 'allow', 'git rev-parse *': 'allow' },
    }));
  } finally {
    process.env = ORIGINAL_ENV;
  }
});
