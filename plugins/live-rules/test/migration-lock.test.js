'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const migrationLock = require('../hooks/lib/migration-lock');

function tempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'live-rules-lock-'));
}

test('withLock reports contention only when a fresh lock file already exists (EEXIST)', () => {
  const dir = tempProject();
  const lockPath = path.join(dir, '.claude', 'live-rules.write.lock');
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, 'active\n');

  const result = migrationLock.withLock(lockPath, { locked: true }, () => {
    throw new Error('work must not run while the lock is held');
  });

  assert.deepStrictEqual(result, { locked: true });
  assert.strictEqual(fs.readFileSync(lockPath, 'utf8'), 'active\n');
});

test('withLock creates a missing parent directory instead of reporting contention (ENOENT)', () => {
  const dir = tempProject();
  const lockPath = path.join(dir, 'nested', 'missing', 'live-rules.write.lock');

  const result = migrationLock.withLock(lockPath, { locked: true }, () => 'worked');

  assert.strictEqual(result, 'worked');
  assert.strictEqual(fs.existsSync(path.dirname(lockPath)), true);
  assert.strictEqual(fs.existsSync(lockPath), false);
});

test('withLock clears a stale lock file and retries the claim', () => {
  const dir = tempProject();
  const lockPath = path.join(dir, '.claude', 'live-rules.write.lock');
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, 'stale\n');
  const staleTime = new Date(Date.now() - migrationLock.STALE_LOCK_MS - 1000);
  fs.utimesSync(lockPath, staleTime, staleTime);

  const result = migrationLock.withLock(lockPath, { locked: true }, () => 'worked');

  assert.strictEqual(result, 'worked');
  assert.strictEqual(fs.existsSync(lockPath), false);
});

test('withLock reports a real filesystem error as itself, not as contention (EACCES)', () => {
  const dir = tempProject();
  const lockPath = path.join(dir, '.claude', 'live-rules.write.lock');
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  // Node's `wx` open flag reports an existing path as EEXIST regardless of
  // whether it is a file or a directory (verified empirically), so a real
  // directory placed at lockPath cannot reproduce EACCES portably. Stub the
  // open call instead to simulate a permission-denied write location.
  const realOpenSync = fs.openSync;
  fs.openSync = (targetPath, flags) => {
    if (targetPath === lockPath && flags === 'wx') {
      const error = new Error("EACCES: permission denied, open '" + lockPath + "'");
      error.code = 'EACCES';
      throw error;
    }
    return realOpenSync(targetPath, flags);
  };

  try {
    assert.throws(
      () => migrationLock.withLock(lockPath, { locked: true }, () => 'unreachable'),
      (error) => error.code === 'EACCES' && error.message.includes(lockPath) && error.message.includes('EACCES'),
    );
  } finally {
    fs.openSync = realOpenSync;
  }
});
