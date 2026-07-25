import assert from 'node:assert/strict';
import test from 'node:test';

import { parseFrontmatter, parseYaml, stringifyYaml, YamlError } from '../lib/yaml.mjs';

test('parses the documented subset', () => {
  const data = parseYaml([
    'ref: SQ-843',
    'title: Build the engine',
    'bump: minor',
    'plugins: [sidequest, workbench]',
    'hold: false',
    'commit: c7b2702',
  ].join('\n'));

  assert.deepEqual(data, {
    ref: 'SQ-843',
    title: 'Build the engine',
    bump: 'minor',
    plugins: ['sidequest', 'workbench'],
    hold: false,
    commit: 'c7b2702',
  });
});

test('parses a nested map and a block list', () => {
  assert.deepEqual(parseYaml('plugins:\n  sidequest: minor\n  workbench: patch').plugins, {
    sidequest: 'minor',
    workbench: 'patch',
  });
  assert.deepEqual(parseYaml('plugins:\n  - sidequest\n  - workbench').plugins, ['sidequest', 'workbench']);
});

test('keeps colons and quoting inside values', () => {
  assert.equal(parseYaml('title: Fix: the thing').title, 'Fix: the thing');
  assert.equal(parseYaml('title: "Fix #12 and \\"quotes\\""').title, 'Fix #12 and "quotes"');
  assert.equal(parseYaml("title: 'it''s fine'").title, "it's fine");
  assert.equal(parseYaml('commit: 12345678').commit, '12345678', 'shas stay strings');
});

test('rejects what it cannot represent instead of guessing', () => {
  const bad = [
    'plugins:\n  sidequest:\n    nested: yes',
    'ref SQ-843',
    'ref: a\nref: b',
    'plugins:\n  - a\n  b: c',
    '  ref: SQ-1',
    'title: a #comment',
    'plugins: [a, b',
    'title: "unterminated',
  ];
  for (const source of bad) {
    assert.throws(() => parseYaml(source), YamlError, `expected ${JSON.stringify(source)} to be rejected`);
  }
});

test('frontmatter needs both delimiters and keeps the body', () => {
  const parsed = parseFrontmatter('---\nref: SQ-1\n---\n\nsome body\n');
  assert.equal(parsed.data.ref, 'SQ-1');
  assert.equal(parsed.body, 'some body');

  assert.throws(() => parseFrontmatter('ref: SQ-1\n'), /missing opening/);
  assert.throws(() => parseFrontmatter('---\nref: SQ-1\n'), /missing closing/);
});

test('render and parse round-trip', () => {
  const front = { ref: 'SQ-843', title: 'Fix: a tricky, quoted title', bump: 'minor', plugins: ['sidequest'], hold: true };
  assert.deepEqual(parseYaml(stringifyYaml(front)), front);
});

test('CRLF frontmatter parses the same as LF', () => {
  assert.deepEqual(parseFrontmatter('---\r\nref: SQ-1\r\ntitle: t\r\n---\r\nbody\r\n').data, { ref: 'SQ-1', title: 't' });
});
