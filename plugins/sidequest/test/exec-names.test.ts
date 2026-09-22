import './_temp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert';

const {
  AGENT_NAME_MAX_LENGTH,
  CLAUDE_PREFIX,
  DISPATCH_PREFIX,
  READ_ONLY_CLAUDE_PREFIX,
  READ_ONLY_DISPATCH_PREFIX,
  EFFORTS,
  classify,
  dispatchLaunchName,
  isEffort,
  stableClaudeName,
  stableDispatchName,
  stableReadOnlyClaudeName,
  stableReadOnlyDispatchName,
  titleSlug,
} = require('../lib/exec-names.js') as {
  AGENT_NAME_MAX_LENGTH: number;
  CLAUDE_PREFIX: string;
  DISPATCH_PREFIX: string;
  READ_ONLY_CLAUDE_PREFIX: string;
  READ_ONLY_DISPATCH_PREFIX: string;
  EFFORTS: readonly string[];
  classify(name: unknown): { kind: string; effort: string | null };
  dispatchLaunchName(ref: unknown, title?: unknown, resolvedExec?: unknown, effort?: unknown, sequence?: unknown): string;
  isEffort(value: unknown): boolean;
  stableClaudeName(effort: string): string;
  stableDispatchName(effort?: string): string;
  stableReadOnlyClaudeName(effort: string): string;
  stableReadOnlyDispatchName(effort?: string): string;
  titleSlug(title: unknown): string;
};

// Claude Code's Agent `name` parameter schema.
const NATIVE_AGENT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const TERRA_EXEC = { backend: 'codex', dispatchModel: 'gpt-5.6-terra', runsLabel: 'GPT-5.6 Terra' };
const OPUS_EXEC = { backend: 'claude', runsModel: 'claude-opus-5', runsLabel: 'Claude Opus 5' };

test('builders produce the current public stable names', () => {
  assert.strictEqual(stableClaudeName('high'), 'sidequest-exec-high');
  // The dispatch builders are effort-collapsed: model and effort ride the route marker.
  assert.strictEqual(stableDispatchName('high'), 'sidequest-exec-dispatch');
  assert.strictEqual(stableDispatchName('xhigh'), 'sidequest-exec-dispatch');
  assert.strictEqual(stableDispatchName(), 'sidequest-exec-dispatch');
  assert.strictEqual(stableReadOnlyClaudeName('high'), 'sidequest-exec-readonly-high');
  assert.strictEqual(stableReadOnlyDispatchName('high'), 'sidequest-exec-dispatch-readonly');
});

test('every stable kind round-trips through classify', () => {
  for (const effort of EFFORTS) {
    assert.deepStrictEqual(classify(stableClaudeName(effort)), { kind: 'claude_builtin', effort });
    assert.deepStrictEqual(classify(stableReadOnlyClaudeName(effort)), { kind: 'read_only_claude_builtin', effort });
    // Collapsed dispatch names carry no effort; the marker does.
    assert.deepStrictEqual(classify(stableDispatchName(effort)), { kind: 'codex_dispatch', effort: null });
    assert.deepStrictEqual(classify(stableReadOnlyDispatchName(effort)), { kind: 'read_only_codex_dispatch', effort: null });
    // Pre-collapse per-effort names must STILL classify, so old dispatch records stay
    // readable and heal by redispatch instead of erroring.
    assert.deepStrictEqual(classify(`sidequest-exec-dispatch-${effort}`), { kind: 'codex_dispatch', effort });
    assert.deepStrictEqual(classify(`sidequest-exec-dispatch-readonly-${effort}`), { kind: 'read_only_codex_dispatch', effort });
  }
});

test('read-only executor names remain stable without category policy', () => {
  assert.strictEqual(READ_ONLY_CLAUDE_PREFIX, 'sidequest-exec-readonly-');
  assert.strictEqual(READ_ONLY_DISPATCH_PREFIX, 'sidequest-exec-dispatch-readonly-');
});

test('dispatch is classified before the claude prefix it shares', () => {
  // 'sidequest-exec-dispatch-high' must not be read as a claude builtin named 'dispatch-high'.
  assert.strictEqual(classify('sidequest-exec-dispatch-high').kind, 'codex_dispatch');
  assert.strictEqual(classify(DISPATCH_PREFIX + 'high').kind, 'codex_dispatch');
});

test('legacy ticket and temp names are tolerated, not unknown', () => {
  assert.strictEqual(classify('sidequest-sq-486-Ab12Cd34').kind, 'ticket');
  assert.strictEqual(classify('sidequest-exec-486-high').kind, 'ticket');
  assert.strictEqual(classify('sidequest-exec-dispatch-486').kind, 'ticket');
});

test('legacy ticket executors retain lifecycle cleanup recognition', () => {
  assert.deepStrictEqual(classify('sidequest-ticket-sq-584-haiku-b37fffcb'), { kind: 'legacy_ticket', effort: null });
});

test('non-sidequest and malformed names are unknown and never throw', () => {
  assert.deepStrictEqual(classify('general-purpose'), { kind: 'unknown', effort: null });
  assert.deepStrictEqual(classify(''), { kind: 'unknown', effort: null });
  assert.deepStrictEqual(classify(null), { kind: 'unknown', effort: null });
  assert.deepStrictEqual(classify(42), { kind: 'unknown', effort: null });
});

test('launch names carry the ref, title, and resolved codex route', () => {
  assert.strictEqual(dispatchLaunchName('SQ-843', 'Release engine', TERRA_EXEC, 'high'), 'sq-843-release-engine-terra-high');
  assert.strictEqual(
    dispatchLaunchName('SQ-836', 'Make Sidequest agent names descriptive and restore model/effort tags', TERRA_EXEC, 'high'),
    'sq-836-make-sidequest-agent-terra-high',
  );
  // Filler words are dropped before the three-word budget is counted.
  assert.strictEqual(titleSlug('Fix the flake in the publish suite'), 'fix-flake-publish');
  assert.strictEqual(dispatchLaunchName('SQ-9', 'Fix', TERRA_EXEC, 'high'), 'sq-9-fix-terra-high');
});

test('launch names derive builtin routes from the resolved runtime', () => {
  assert.strictEqual(dispatchLaunchName('SQ-843', 'Release engine', OPUS_EXEC, 'xhigh'), 'sq-843-release-engine-opus-5-xhigh');
});

test('launch names never fall back to an opaque id', () => {
  // Nothing sluggable left: the bare ref beats a random suffix.
  assert.strictEqual(dispatchLaunchName('SQ-843', '日本語のチケット', TERRA_EXEC, 'high'), 'sq-843-terra-high');
  assert.strictEqual(dispatchLaunchName('SQ-843', '', TERRA_EXEC, 'high'), 'sq-843-terra-high');
  assert.strictEqual(dispatchLaunchName('SQ-843', undefined, TERRA_EXEC, 'high'), 'sq-843-terra-high');
  assert.strictEqual(dispatchLaunchName(null, 'orphan launch'), 'sidequest-orphan-launch');
});

test('a relaunched ticket keeps its resolved route before the sequence suffix', () => {
  assert.strictEqual(dispatchLaunchName('SQ-843', 'Release engine', TERRA_EXEC, 'high', 1), 'sq-843-release-engine-terra-high');
  assert.strictEqual(dispatchLaunchName('SQ-843', 'Release engine', TERRA_EXEC, 'high', 2), 'sq-843-release-engine-terra-high-2');
  assert.strictEqual(dispatchLaunchName('SQ-843', 'Release engine', TERRA_EXEC, 'high', 7), 'sq-843-release-engine-terra-high-7');
  // Same inputs, same name: the value is reproducible from board state alone.
  assert.strictEqual(
    dispatchLaunchName('SQ-843', 'Release engine', TERRA_EXEC, 'high', 2),
    dispatchLaunchName('SQ-843', 'Release engine', TERRA_EXEC, 'high', 2),
  );
});

test('title truncation preserves the route and sequence suffix', () => {
  const route = { backend: 'codex', runsLabel: 'x'.repeat(24) };
  const name = dispatchLaunchName('SQ-1234567', 'x'.repeat(400), route, 'high', 99);
  assert.strictEqual(name, `sq-1234567-${'x'.repeat(20)}-${'x'.repeat(24)}-high-99`);
});

test('launch names stay inside the native Agent name constraints', () => {
  const titles = [
    'Release engine',
    'Supercalifragilisticexpialidocious pipeline overhaul',
    'x'.repeat(400),
    '!!! ??? ***',
    'Ünïcödé rôute wörk',
  ];
  for (const title of titles) {
    for (const sequence of [1, 2, 99]) {
      const name = dispatchLaunchName('SQ-123456', title, TERRA_EXEC, 'high', sequence);
      assert.ok(NATIVE_AGENT_NAME_RE.test(name), `${name} is not a legal Agent name`);
      assert.ok(name.length <= AGENT_NAME_MAX_LENGTH, `${name} exceeds ${AGENT_NAME_MAX_LENGTH}`);
    }
  }
  assert.match(dispatchLaunchName('SQ-1', 'x'.repeat(400), TERRA_EXEC, 'high', 99), /-terra-high-99$/);
});

test('isEffort and the prefixes are exported for consumers', () => {
  assert.ok(isEffort('max'));
  assert.ok(!isEffort('extreme'));
  assert.strictEqual(CLAUDE_PREFIX, 'sidequest-exec-');
  assert.strictEqual(DISPATCH_PREFIX, 'sidequest-exec-dispatch-');
});
