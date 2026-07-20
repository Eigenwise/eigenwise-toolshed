import test from 'node:test';
import assert from 'node:assert';

const {
  CLAUDE_PREFIX,
  DISPATCH_PREFIX,
  EFFORTS,
  classify,
  isEffort,
  stableClaudeName,
  stableDispatchName,
} = require('../lib/exec-names.js') as {
  CLAUDE_PREFIX: string;
  DISPATCH_PREFIX: string;
  EFFORTS: readonly string[];
  classify(name: unknown): { kind: string; effort: string | null };
  isEffort(value: unknown): boolean;
  stableClaudeName(effort: string): string;
  stableDispatchName(effort: string): string;
};

test('builders produce the current public stable names', () => {
  assert.strictEqual(stableClaudeName('high'), 'sidequest-exec-high');
  assert.strictEqual(stableDispatchName('high'), 'sidequest-exec-dispatch-high');
  assert.strictEqual(stableDispatchName('xhigh'), 'sidequest-exec-dispatch-xhigh');
});

test('every stable kind round-trips through classify with its effort', () => {
  for (const effort of EFFORTS) {
    assert.deepStrictEqual(classify(stableClaudeName(effort)), { kind: 'claude_builtin', effort });
    assert.deepStrictEqual(classify(stableDispatchName(effort)), { kind: 'codex_dispatch', effort });
  }
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

test('isEffort and the prefixes are exported for consumers', () => {
  assert.ok(isEffort('max'));
  assert.ok(!isEffort('extreme'));
  assert.strictEqual(CLAUDE_PREFIX, 'sidequest-exec-');
  assert.strictEqual(DISPATCH_PREFIX, 'sidequest-exec-dispatch-');
});
