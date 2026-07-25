import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { normalizeRelative, pluginSourceDir, resolveInRepo, UnsafePathError } from '../lib/paths.mjs';

test('a plugin source may only name plugins/<name>', () => {
  assert.equal(pluginSourceDir('./plugins/sidequest', 'sidequest'), 'plugins/sidequest');
  assert.equal(pluginSourceDir('plugins/codex-gateway', 'codex-gateway'), 'plugins/codex-gateway');
  assert.equal(pluginSourceDir(undefined, 'live-rules'), 'plugins/live-rules', 'a missing source defaults to the convention');
});

test('anything that could leave plugins/ is refused', () => {
  const evil = [
    '../../victim',
    '/etc/passwd',
    'C:/Windows/System32',
    '\\\\server\\share',
    'plugins/../../escape',
    './plugins/sidequest/../../..',
    'plugins/sidequest/nested',
    'plugins',
    'docs',
    '',
    '   ',
    'plugins/.hidden',
  ];
  for (const source of evil) {
    assert.throws(() => pluginSourceDir(source, 'sidequest'), UnsafePathError, `expected ${JSON.stringify(source)} to be refused`);
  }
});

test('normalizeRelative keeps ordinary repo paths and rejects escapes', () => {
  assert.equal(normalizeRelative('.release/unreleased/SQ-1.md', 'fragment'), '.release/unreleased/SQ-1.md');
  assert.equal(normalizeRelative('./CHANGELOG.md', 'changelog'), 'CHANGELOG.md');
  assert.equal(normalizeRelative('plugins\\sidequest\\CHANGELOG.md', 'changelog'), 'plugins/sidequest/CHANGELOG.md');

  for (const value of ['../outside', 'a/../../b', '/abs', 'D:/abs', '.', '..']) {
    assert.throws(() => normalizeRelative(value, 'path'), UnsafePathError, value);
  }
});

test('resolveInRepo refuses a path that reaches through a symlink', (t) => {
  const base = mkdtempSync(path.join(tmpdir(), 'release-paths-'));
  t.after(() => rmSync(base, { recursive: true, force: true, maxRetries: 3 }));

  const repo = path.join(base, 'repo');
  const outside = path.join(base, 'outside');
  mkdirSync(path.join(repo, 'plugins'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(outside, 'plugin.json'), '{}');

  assert.equal(
    resolveInRepo(repo, 'plugins/sidequest/.claude-plugin/plugin.json'),
    path.join(repo, 'plugins/sidequest/.claude-plugin/plugin.json'),
    'a path that does not exist yet is fine; its existing parents are what matter',
  );

  try {
    symlinkSync(outside, path.join(repo, 'plugins/sidequest'), 'junction');
  } catch {
    t.skip('this platform will not create a directory symlink without extra privileges');
    return;
  }

  assert.throws(
    () => resolveInRepo(repo, 'plugins/sidequest/.claude-plugin/plugin.json'),
    /passes through the symlink "plugins\/sidequest"/,
  );
});

test('resolveInRepo refuses to leave the repository even when the path normalizes', (t) => {
  const base = mkdtempSync(path.join(tmpdir(), 'release-paths-'));
  t.after(() => rmSync(base, { recursive: true, force: true, maxRetries: 3 }));

  assert.throws(() => resolveInRepo(base, '../escape'), UnsafePathError);
  assert.throws(() => resolveInRepo(base, 'plugins/../../escape'), UnsafePathError);
});
