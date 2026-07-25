import './_temp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert';

const {
  AGENT_NAME_MAX_LENGTH,
  CLAUDE_PREFIX,
  DISPATCH_PREFIX,
  READ_ONLY_CLAUDE_PREFIX,
  READ_ONLY_DISPATCH_PREFIX,
  READ_ONLY_CATEGORY_IDS,
  EFFORTS,
  classify,
  dispatchLaunchName,
  isEffort,
  isReadOnlyCategory,
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
  READ_ONLY_CATEGORY_IDS: readonly string[];
  EFFORTS: readonly string[];
  classify(name: unknown): { kind: string; effort: string | null };
  dispatchLaunchName(ref: unknown, title?: unknown, sequence?: unknown): string;
  isEffort(value: unknown): boolean;
  isReadOnlyCategory(categoryId: unknown): boolean;
  stableClaudeName(effort: string): string;
  stableDispatchName(effort: string): string;
  stableReadOnlyClaudeName(effort: string): string;
  stableReadOnlyDispatchName(effort: string): string;
  titleSlug(title: unknown): string;
};

// Claude Code's Agent `name` parameter schema.
const NATIVE_AGENT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

test('builders produce the current public stable names', () => {
  assert.strictEqual(stableClaudeName('high'), 'sidequest-exec-high');
  assert.strictEqual(stableDispatchName('high'), 'sidequest-exec-dispatch-high');
  assert.strictEqual(stableDispatchName('xhigh'), 'sidequest-exec-dispatch-xhigh');
  assert.strictEqual(stableReadOnlyClaudeName('high'), 'sidequest-exec-readonly-high');
  assert.strictEqual(stableReadOnlyDispatchName('high'), 'sidequest-exec-dispatch-readonly-high');
});

test('every stable kind round-trips through classify with its effort', () => {
  for (const effort of EFFORTS) {
    assert.deepStrictEqual(classify(stableClaudeName(effort)), { kind: 'claude_builtin', effort });
    assert.deepStrictEqual(classify(stableDispatchName(effort)), { kind: 'codex_dispatch', effort });
    assert.deepStrictEqual(classify(stableReadOnlyClaudeName(effort)), { kind: 'read_only_claude_builtin', effort });
    assert.deepStrictEqual(classify(stableReadOnlyDispatchName(effort)), { kind: 'read_only_codex_dispatch', effort });
  }
});

test('read-only category selection is explicit and stable', () => {
  assert.deepStrictEqual(READ_ONLY_CATEGORY_IDS, [
    'codebase-exploration',
    'research',
    'review-audit',
    'spike-investigation',
  ]);
  for (const category of READ_ONLY_CATEGORY_IDS) assert.ok(isReadOnlyCategory(category));
  assert.ok(!isReadOnlyCategory('coding.normal'));
  assert.ok(!isReadOnlyCategory('visual-review'));
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

test('launch names carry the ref and enough title to tell parallel work apart', () => {
  assert.strictEqual(dispatchLaunchName('SQ-843', 'Release engine'), 'sq-843-release-engine');
  assert.strictEqual(
    dispatchLaunchName('SQ-836', 'Make Sidequest agent names descriptive and restore model/effort tags'),
    'sq-836-make-sidequest-agent',
  );
  // Filler words are dropped before the three-word budget is counted.
  assert.strictEqual(titleSlug('Fix the flake in the publish suite'), 'fix-flake-publish');
  assert.strictEqual(dispatchLaunchName('SQ-9', 'Fix'), 'sq-9-fix');
});

test('launch names never fall back to an opaque id', () => {
  // Nothing sluggable left: the bare ref beats a random suffix.
  assert.strictEqual(dispatchLaunchName('SQ-843', '日本語のチケット'), 'sq-843');
  assert.strictEqual(dispatchLaunchName('SQ-843', ''), 'sq-843');
  assert.strictEqual(dispatchLaunchName('SQ-843'), 'sq-843');
  assert.strictEqual(dispatchLaunchName(null, 'orphan launch'), 'sidequest-orphan-launch');
});

test('a relaunched ticket counts up instead of drawing a fresh id', () => {
  assert.strictEqual(dispatchLaunchName('SQ-843', 'Release engine', 1), 'sq-843-release-engine');
  assert.strictEqual(dispatchLaunchName('SQ-843', 'Release engine', 2), 'sq-843-release-engine-2');
  assert.strictEqual(dispatchLaunchName('SQ-843', 'Release engine', 7), 'sq-843-release-engine-7');
  // Same inputs, same name: the value is reproducible from board state alone.
  assert.strictEqual(dispatchLaunchName('SQ-843', 'Release engine', 2), dispatchLaunchName('SQ-843', 'Release engine', 2));
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
      const name = dispatchLaunchName('SQ-123456', title, sequence);
      assert.ok(NATIVE_AGENT_NAME_RE.test(name), `${name} is not a legal Agent name`);
      assert.ok(name.length <= AGENT_NAME_MAX_LENGTH, `${name} exceeds ${AGENT_NAME_MAX_LENGTH}`);
    }
  }
  assert.match(dispatchLaunchName('SQ-1', 'x'.repeat(400), 99), /-99$/);
});

test('isEffort and the prefixes are exported for consumers', () => {
  assert.ok(isEffort('max'));
  assert.ok(!isEffort('extreme'));
  assert.strictEqual(CLAUDE_PREFIX, 'sidequest-exec-');
  assert.strictEqual(DISPATCH_PREFIX, 'sidequest-exec-dispatch-');
});
