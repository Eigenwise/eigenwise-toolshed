'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  commandHead,
  describeDelta,
  isTrivialShape,
  normalizeCommand,
  redact,
  redactDeep,
  shapeComplexity,
} = require('../lib/normalize.js');

test('the same command run against different paths collapses to one shape', () => {
  const a = normalizeCommand('npm ci --prefix "C:/dev/repo/.claude/worktrees/agent-abc/plugins/sidequest"');
  const b = normalizeCommand('npm ci --prefix "C:/dev/repo/.claude/worktrees/agent-xyz/plugins/sidequest"');
  assert.equal(a.shape, b.shape);
  assert.ok(a.shape.includes('<path>'));
});

test('slot values are kept so they can become CLI arguments', () => {
  const { slots } = normalizeCommand('node /tmp/run.js --id 550e8400-e29b-41d4-a716-446655440000');
  assert.ok(slots.some((slot) => slot.token === '<uuid>'));
  assert.ok(slots.some((slot) => slot.token === '<path>' && slot.value.includes('run.js')));
});

test('a heredoc body is stripped so appends cluster as one chore', () => {
  const a = normalizeCommand("cat >> /tmp/out.js << 'EOF'\nconst x = 1;\nEOF");
  const b = normalizeCommand("cat >> /tmp/out.js << 'EOF'\nconst totallyDifferent = { deep: true };\nEOF");
  assert.equal(a.shape, b.shape);
  assert.ok(a.shape.endsWith('<<heredoc'));
});

test('a value-carrying flag does not become the command head', () => {
  assert.equal(commandHead(normalizeCommand('git -C "C:/repo/wt" status --short').shape), 'git status');
  assert.equal(commandHead(normalizeCommand('git status --short').shape), 'git status');
  assert.equal(commandHead(normalizeCommand('npm --prefix "C:/repo/p" ci').shape), 'npm ci');
  assert.equal(commandHead(normalizeCommand('npm ci --prefix "C:/repo/p"').shape), 'npm ci');
});

test('looking around is not a chore worth clustering', () => {
  assert.equal(isTrivialShape('ls -la'), true);
  assert.equal(isTrivialShape('git status'), true);
  assert.equal(isTrivialShape('npm run test:full'), false);
});

test('a piped multi-step command outranks a bare one', () => {
  assert.ok(shapeComplexity('a | b && c --flag --other') > shapeComplexity('node x'));
});

test('describeDelta names the flag that made a failing command work', () => {
  const delta = describeDelta('npm ci', 'npm ci --prefix <path>');
  assert.deepEqual(delta.added, ['--prefix', '<path>']);
  assert.deepEqual(delta.removed, []);
});

test('a dispatch token is never quoted back into a report', () => {
  const redacted = redact('node cli.js briefing SQ-1 --token fJLWH0I6PfMRQTU8JJNtVyyZlH3zuSYS --project x');
  assert.ok(!redacted.includes('fJLWH0I6PfMRQTU8JJNtVyyZlH3zuSYS'));
  assert.ok(redacted.includes('<redacted>'));
  assert.ok(redacted.includes('briefing SQ-1'), 'the surrounding command must stay readable');
});

test('common credential shapes are redacted even without a flag naming them', () => {
  for (const secret of [
    'sk-abcdefghijklmnopqrstuvwxyz012345',
    'ghp_abcdefghijklmnopqrstuvwxyz0123',
    'AKIAIOSFODNN7EXAMPLE',
    'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9abcdefghijklmnop',
    'xoxb-1234567890-abcdefghij',
  ]) {
    assert.ok(redact(secret).includes('<redacted>'), `not redacted: ${secret}`);
  }
});

test('redaction reaches every string in a nested structure', () => {
  const redacted = redactDeep({
    title: 'ran with --token fJLWH0I6PfMRQTU8JJNtVyyZlH3zuSYS',
    evidence: [{ text: 'sk-abcdefghijklmnopqrstuvwxyz012345' }],
    count: 3,
  });
  assert.ok(!JSON.stringify(redacted).includes('fJLWH0I6PfMRQTU8JJNtVyyZlH3zuSYS'));
  assert.ok(!JSON.stringify(redacted).includes('sk-abcdefghijklmnopqrstuvwxyz012345'));
  assert.equal(redacted.count, 3);
});

test('ordinary words and short ids survive redaction', () => {
  const text = 'npm run test:full --prefix plugins/sidequest';
  assert.equal(redact(text), text);
});
