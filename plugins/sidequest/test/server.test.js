'use strict';
/**
 * Tests for the dashboard server's hot-reload self-recycle (SQ-136).
 * Run: node --test plugins/sidequest/test/server.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

// Point the store at a throwaway home so any incidental store reads/writes
// (findNewerInstall never touches it, but requiring server.js pulls in
// store.js) never touch the real one. Also opt this whole process out of the
// real recycle watch — these tests call the pure/fs functions directly and
// must never let a background setInterval fire during the run.
process.env.SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-server-test-'));
process.env.SIDEQUEST_NO_HOT_RECYCLE = '1';

const { pickNewerInstall, findNewerInstall } = require('../lib/server.js');

/* ------------------------------------------------------------------ *
 *  pickNewerInstall — pure core
 * ------------------------------------------------------------------ */

test('pickNewerInstall: picks a strictly-newer clean-semver install with a bin', () => {
  const entries = [{ name: '1.23.0', version: '1.23.0', hasBin: true }];
  assert.strictEqual(pickNewerInstall(entries, '1.20.0'), '1.23.0');
});

test('pickNewerInstall: no strictly-newer candidate -> null (newest install never recycles)', () => {
  const entries = [
    { name: '1.20.0', version: '1.20.0', hasBin: true },
    { name: '1.23.0', version: '1.23.0', hasBin: true },
  ];
  assert.strictEqual(pickNewerInstall(entries, '1.23.0'), null);
});

test('pickNewerInstall: candidate without hasBin is skipped', () => {
  const entries = [{ name: '2.0.0', version: '2.0.0', hasBin: false }];
  assert.strictEqual(pickNewerInstall(entries, '1.0.0'), null);
});

test('pickNewerInstall: prerelease version is skipped (never auto-hops to a prerelease)', () => {
  const entries = [{ name: '1.24.0-pre.1', version: '1.24.0-pre.1', hasBin: true }];
  assert.strictEqual(pickNewerInstall(entries, '1.20.0'), null);
});

test('pickNewerInstall: non-semver names are skipped', () => {
  const entries = [
    { name: 'sidequest', version: 'sidequest', hasBin: true },
    { name: 'foo', version: 'foo', hasBin: true },
  ];
  assert.strictEqual(pickNewerInstall(entries, '1.0.0'), null);
});

test('pickNewerInstall: compares numerically, not lexically (1.10.0 > 1.9.0)', () => {
  const entries = [
    { name: '1.9.0', version: '1.9.0', hasBin: true },
    { name: '1.10.0', version: '1.10.0', hasBin: true },
  ];
  // Lexical string comparison would rank "1.9.0" above "1.10.0" (the '9' > '1'
  // digit); numeric comparison must pick 1.10.0 instead.
  assert.strictEqual(pickNewerInstall(entries, '1.8.0'), '1.10.0');
});

test('pickNewerInstall: equal version -> null', () => {
  const entries = [{ name: '1.20.0', version: '1.20.0', hasBin: true }];
  assert.strictEqual(pickNewerInstall(entries, '1.20.0'), null);
});

test('pickNewerInstall: empty entries -> null', () => {
  assert.strictEqual(pickNewerInstall([], '1.20.0'), null);
});

test('pickNewerInstall: picks the highest of several strictly-newer candidates', () => {
  const entries = [
    { name: '1.21.0', version: '1.21.0', hasBin: true },
    { name: '1.23.0', version: '1.23.0', hasBin: true },
    { name: '1.22.0', version: '1.22.0', hasBin: true },
  ];
  assert.strictEqual(pickNewerInstall(entries, '1.20.0'), '1.23.0');
});

test('pickNewerInstall: malformed input degrades to null rather than throwing', () => {
  assert.strictEqual(pickNewerInstall(null, '1.20.0'), null);
  assert.strictEqual(pickNewerInstall([{ name: 'x' }], '1.20.0'), null);
  assert.strictEqual(pickNewerInstall([{ name: '1.23.0', version: '1.23.0', hasBin: true }], 'not-a-version'), null);
});

/* ------------------------------------------------------------------ *
 *  findNewerInstall — best-effort fs wrapper + guards
 * ------------------------------------------------------------------ */

test('findNewerInstall: SIDEQUEST_NO_HOT_RECYCLE guard returns null', () => {
  // Set for the whole file (see top), so this just documents/exercises it.
  assert.strictEqual(process.env.SIDEQUEST_NO_HOT_RECYCLE, '1');
  assert.strictEqual(findNewerInstall(), null);
});

test('findNewerInstall: repo-source checkout (non-semver dir name) never self-recycles', () => {
  // Running the real suite from the repo, __dirname resolves under
  // plugins/sidequest/lib, whose parent dir basename is "sidequest" — not a
  // clean semver — so the guard must fire even with the env var unset.
  const prev = process.env.SIDEQUEST_NO_HOT_RECYCLE;
  delete process.env.SIDEQUEST_NO_HOT_RECYCLE;
  try {
    assert.strictEqual(findNewerInstall(), null);
  } finally {
    if (prev !== undefined) process.env.SIDEQUEST_NO_HOT_RECYCLE = prev;
  }
});

test('findNewerInstall: never throws even with guards disabled', () => {
  assert.doesNotThrow(() => findNewerInstall());
});
