'use strict';
/**
 * Tests for the cross-process publish lock (SQ-398, lib/publish.js).
 *
 * The lock serializes the orchestrator's publish transaction across every
 * session, process, and worktree of a repository. It lives in the repo's COMMON
 * git dir and records owner pid + session metadata, so a crashed publisher is
 * recoverable: same-session re-acquire refreshes, TTL expiry and dead
 * (non-transient) pids read as stale, and --steal takes over explicitly.
 *
 * Run: node --test plugins/sidequest/test/publish-lock.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const publish = require('../lib/publish.js');

function tempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-publish-lock-'));
  execFileSync('git', ['init', '-q', dir], { encoding: 'utf8' });
  return dir;
}

test('lock file lives in the common git dir, shared by worktrees of the repo', () => {
  const repo = tempRepo();
  const file = publish.lockFile(repo);
  assert.strictEqual(path.dirname(file), publish.gitCommonDir(repo));
  assert.strictEqual(path.basename(file), publish.LOCK_BASENAME);
  assert.throws(() => publish.lockFile(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-not-a-repo-'))));
});

test('acquire, contention, and owner release', () => {
  const repo = tempRepo();
  const a = publish.acquirePublishLock(repo, { by: 'orch-a', sessionId: 'sess-a' });
  assert.strictEqual(a.ok, true);
  assert.ok(fs.existsSync(a.file));

  // A different live publisher is refused with the holder's metadata, not stolen.
  const b = publish.acquirePublishLock(repo, { by: 'orch-b', sessionId: 'sess-b' });
  assert.strictEqual(b.ok, false);
  assert.strictEqual(b.reason, 'held');
  assert.strictEqual(b.holder.by, 'orch-a');
  assert.strictEqual(b.holder.sessionId, 'sess-a');
  assert.strictEqual(b.stale, false);

  // Not the owner: release refused without force.
  const denied = publish.releasePublishLock(repo, { by: 'orch-b', sessionId: 'sess-b' });
  assert.strictEqual(denied.ok, false);
  assert.strictEqual(denied.reason, 'not_owner');

  const released = publish.releasePublishLock(repo, { by: 'orch-a', sessionId: 'sess-a' });
  assert.strictEqual(released.ok, true);
  assert.strictEqual(released.released.by, 'orch-a');
  assert.ok(!fs.existsSync(a.file));

  // Releasing an unlocked repo is idempotent cleanup, never a failure.
  const again = publish.releasePublishLock(repo, { by: 'orch-a' });
  assert.strictEqual(again.ok, true);
  assert.strictEqual(again.released, null);
});

test('the same session re-acquires (crash recovery for an interrupted transaction)', () => {
  const repo = tempRepo();
  assert.strictEqual(publish.acquirePublishLock(repo, { by: 'orch-a', sessionId: 'sess-a' }).ok, true);
  const resumed = publish.acquirePublishLock(repo, { by: 'orch-a-later', sessionId: 'sess-a' });
  assert.strictEqual(resumed.ok, true);
  assert.strictEqual(resumed.reacquired, true);
});

test('TTL expiry, dead non-transient pids, and corrupt records read as stale and are reclaimed', () => {
  const repo = tempRepo();
  const file = publish.lockFile(repo);

  // TTL-expired transient holder (the CLI acquisition shape).
  fs.writeFileSync(file, JSON.stringify({
    pid: process.pid, transient: true, by: 'orch-dead', sessionId: 'sess-dead',
    host: os.hostname(), at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
  }));
  assert.strictEqual(publish.publishLockStatus(repo).stale, true);
  const overTtl = publish.acquirePublishLock(repo, { by: 'orch-new', sessionId: 'sess-new' });
  assert.strictEqual(overTtl.ok, true);
  publish.releasePublishLock(repo, { by: 'orch-new', force: true });

  // Fresh timestamp but a dead long-lived owner pid on this host.
  fs.writeFileSync(file, JSON.stringify({
    pid: 999999999, transient: false, by: 'orch-crashed', sessionId: 'sess-crashed',
    host: os.hostname(), at: new Date().toISOString(),
  }));
  const afterCrash = publish.acquirePublishLock(repo, { by: 'orch-new', sessionId: 'sess-new' });
  assert.strictEqual(afterCrash.ok, true, 'a dead pid must not wedge publishing');
  publish.releasePublishLock(repo, { by: 'orch-new', force: true });

  // A fresh TRANSIENT holder's (already-exited) pid must NOT read as stale: the
  // CLI process dies immediately while its session keeps publishing.
  fs.writeFileSync(file, JSON.stringify({
    pid: 999999999, transient: true, by: 'orch-live', sessionId: 'sess-live',
    host: os.hostname(), at: new Date().toISOString(),
  }));
  const contended = publish.acquirePublishLock(repo, { by: 'orch-new', sessionId: 'sess-new' });
  assert.strictEqual(contended.ok, false, 'a live transient holder keeps the lock');
  assert.strictEqual(publish.publishLockStatus(repo).stale, false);

  // Explicit steal takes over a live holder.
  const stolen = publish.acquirePublishLock(repo, { by: 'orch-new', sessionId: 'sess-new', steal: true });
  assert.strictEqual(stolen.ok, true);
  publish.releasePublishLock(repo, { by: 'orch-new' });

  // Corrupt record: the writer crashed mid-write; reclaimable.
  fs.writeFileSync(file, 'not json{{{');
  assert.strictEqual(publish.publishLockStatus(repo).stale, true);
  assert.strictEqual(publish.acquirePublishLock(repo, { by: 'orch-new', sessionId: 'sess-new' }).ok, true);
});
