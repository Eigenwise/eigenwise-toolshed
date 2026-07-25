import assert from 'node:assert/strict';
import test from 'node:test';

import { bumpVersion, compareVersions, isLevel, maxLevel, parseVersion } from '../lib/semver.mjs';

test('bump arithmetic zeroes the lower fields', () => {
  assert.equal(bumpVersion('3.6.49', 'patch'), '3.6.50');
  assert.equal(bumpVersion('3.6.49', 'minor'), '3.7.0');
  assert.equal(bumpVersion('3.6.49', 'major'), '4.0.0');
  assert.equal(bumpVersion('0.63.11', 'patch'), '0.63.12');
  assert.equal(bumpVersion('0.33.9', 'minor'), '0.34.0');
  assert.equal(bumpVersion('3.207.0', 'minor'), '3.208.0');
  assert.equal(bumpVersion('3.207.0', 'patch'), '3.207.1');
});

test('a window takes the highest level any fragment asks for', () => {
  assert.equal(maxLevel(['patch', 'patch', 'patch']), 'patch');
  assert.equal(maxLevel(['patch', 'minor', 'patch']), 'minor');
  assert.equal(maxLevel(['minor', 'major']), 'major');
  assert.equal(maxLevel(Array.from({ length: 13 }, () => 'patch')), 'patch');
});

test('thirteen patch fragments still produce one patch bump', () => {
  const level = maxLevel(Array.from({ length: 13 }, () => 'patch'));
  assert.equal(bumpVersion('3.6.17', level), '3.6.18');
});

test('non-plain versions are rejected rather than guessed at', () => {
  for (const bad of ['3.6', '3.6.49-rc.1', '3.6.49+build', 'v3.6.49', '03.6.49', '', 'latest']) {
    assert.throws(() => parseVersion(bad), /not a plain x\.y\.z semver/, `expected ${JSON.stringify(bad)} to be rejected`);
  }
  assert.throws(() => parseVersion(null), TypeError);
});

test('unknown levels fail loudly', () => {
  assert.throws(() => bumpVersion('1.0.0', 'huge'), /unknown bump level/);
  assert.throws(() => maxLevel(['patch', 'huge']), /unknown bump level/);
  assert.throws(() => maxLevel([]), /at least one level/);
  assert.equal(isLevel('patch'), true);
  assert.equal(isLevel('Patch'), false);
});

test('versions compare numerically, not lexically', () => {
  assert.ok(compareVersions('3.6.9', '3.6.10') < 0);
  assert.ok(compareVersions('3.10.0', '3.9.0') > 0);
  assert.equal(compareVersions('3.6.49', '3.6.49'), 0);
});
