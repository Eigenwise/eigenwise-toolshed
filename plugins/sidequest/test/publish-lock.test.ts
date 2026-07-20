'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const publish = require('../lib/publish.js');

function tempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-publish-lock-'));
  execFileSync('git', ['init', '-q', dir], { encoding: 'utf8' });
  return dir;
}

test('lock file lives in the common git dir, shared by worktrees of the repo', async () => {
  const repo = tempRepo();
  const file = await publish.lockFile(repo);
  assert.strictEqual(path.dirname(file), await publish.gitCommonDir(repo));
  assert.strictEqual(path.basename(file), publish.LOCK_BASENAME);
  await assert.rejects(() => publish.lockFile(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-not-a-repo-'))));
});

test('acquire, contention, and owner release', async () => {
  const repo = tempRepo();
  const a = await publish.acquirePublishLock(repo, { by: 'orch-a', sessionId: 'sess-a' });
  assert.strictEqual(a.ok, true);
  assert.ok(fs.existsSync(a.file));

  const b = await publish.acquirePublishLock(repo, { by: 'orch-b', sessionId: 'sess-b' });
  assert.strictEqual(b.ok, false);
  assert.strictEqual(b.reason, 'held');
  assert.strictEqual(b.holder.by, 'orch-a');
  assert.strictEqual(b.holder.sessionId, 'sess-a');
  assert.strictEqual(b.stale, false);

  const denied = await publish.releasePublishLock(repo, { by: 'orch-b', sessionId: 'sess-b' });
  assert.strictEqual(denied.ok, false);
  assert.strictEqual(denied.reason, 'not_owner');

  const released = await publish.releasePublishLock(repo, { by: 'orch-a', sessionId: 'sess-a' });
  assert.strictEqual(released.ok, true);
  assert.strictEqual(released.released.by, 'orch-a');
  assert.ok(!fs.existsSync(a.file));

  const again = await publish.releasePublishLock(repo, { by: 'orch-a' });
  assert.strictEqual(again.ok, true);
  assert.strictEqual(again.released, null);
});

test('the same session re-acquires (crash recovery for an interrupted transaction)', async () => {
  const repo = tempRepo();
  assert.strictEqual((await publish.acquirePublishLock(repo, { by: 'orch-a', sessionId: 'sess-a' })).ok, true);
  const resumed = await publish.acquirePublishLock(repo, { by: 'orch-a-later', sessionId: 'sess-a' });
  assert.strictEqual(resumed.ok, true);
  assert.strictEqual(resumed.reacquired, true);
});

test('TTL expiry, dead non-transient pids, and corrupt records read as stale and are reclaimed', async () => {
  const repo = tempRepo();
  const file = await publish.lockFile(repo);

  fs.writeFileSync(file, JSON.stringify({
    pid: process.pid, transient: true, by: 'orch-dead', sessionId: 'sess-dead',
    host: os.hostname(), at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
  }));
  assert.strictEqual((await publish.publishLockStatus(repo)).stale, true);
  const overTtl = await publish.acquirePublishLock(repo, { by: 'orch-new', sessionId: 'sess-new' });
  assert.strictEqual(overTtl.ok, true);
  await publish.releasePublishLock(repo, { by: 'orch-new', force: true });

  fs.writeFileSync(file, JSON.stringify({
    pid: 999999999, transient: false, by: 'orch-crashed', sessionId: 'sess-crashed',
    host: os.hostname(), at: new Date().toISOString(),
  }));
  const afterCrash = await publish.acquirePublishLock(repo, { by: 'orch-new', sessionId: 'sess-new' });
  assert.strictEqual(afterCrash.ok, true, 'a dead pid must not wedge publishing');
  await publish.releasePublishLock(repo, { by: 'orch-new', force: true });

  fs.writeFileSync(file, JSON.stringify({
    pid: 999999999, transient: true, by: 'orch-live', sessionId: 'sess-live',
    host: os.hostname(), at: new Date().toISOString(),
  }));
  const contended = await publish.acquirePublishLock(repo, { by: 'orch-new', sessionId: 'sess-new' });
  assert.strictEqual(contended.ok, false, 'a live transient holder keeps the lock');
  assert.strictEqual((await publish.publishLockStatus(repo)).stale, false);

  const stolen = await publish.acquirePublishLock(repo, { by: 'orch-new', sessionId: 'sess-new', steal: true });
  assert.strictEqual(stolen.ok, true);
  await publish.releasePublishLock(repo, { by: 'orch-new' });

  fs.writeFileSync(file, 'not json{{{');
  assert.strictEqual((await publish.publishLockStatus(repo)).stale, true);
  assert.strictEqual((await publish.acquirePublishLock(repo, { by: 'orch-new', sessionId: 'sess-new' })).ok, true);
});
