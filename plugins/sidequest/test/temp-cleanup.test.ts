import './_temp-cleanup.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { cleanupTempRoots, TEMP_CLEANUP_RECENT_MS } from '../src/lib/temp-cleanup.js';

test('cleanup removes old roots, keeps recent roots, and reports reparse points', () => {
  const oldRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-cleanup-old-'));
  fs.writeFileSync(path.join(oldRoot, 'payload.txt'), 'old');
  const old = new Date(Date.now() - TEMP_CLEANUP_RECENT_MS - 1000);
  fs.utimesSync(oldRoot, old, old);

  const recentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-cleanup-recent-'));
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-target-'));
  const link = path.join(os.tmpdir(), `sq-cleanup-link-${process.pid}-${Date.now()}`);
  fs.symlinkSync(target, link, 'junction');
  const linkOld = new Date(Date.now() - TEMP_CLEANUP_RECENT_MS - 1000);
  try { fs.lutimesSync(link, linkOld, linkOld); } catch { }

  const report = cleanupTempRoots();

  assert.ok(report.removed >= 1);
  assert.ok(report.removedEntries >= 2);
  assert.ok(report.skippedRecent.includes(recentRoot));
  assert.ok(report.skippedUnsafe.includes(link));
  assert.equal(fs.existsSync(oldRoot), false);
  assert.equal(fs.existsSync(recentRoot), true);
  assert.equal(fs.existsSync(target), true);
  assert.equal(fs.existsSync(link), true);

  fs.rmSync(link, { force: true });
  fs.rmSync(target, { recursive: true, force: true });
});

test('cleanup records classification failures and continues scanning', () => {
  const badRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-cleanup-bad-'));
  const goodRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-cleanup-good-'));
  const old = new Date(Date.now() - TEMP_CLEANUP_RECENT_MS - 1000);
  fs.utimesSync(badRoot, old, old);
  fs.utimesSync(goodRoot, old, old);
  const originalRealpath = fs.realpathSync.native;
  Object.defineProperty(fs.realpathSync, 'native', {
    configurable: true,
    value: (candidate: fs.PathLike, options?: any) => {
      if (path.resolve(String(candidate)) === path.resolve(badRoot)) {
        const error = new Error(`ENOENT: no such file or directory, realpath '${badRoot}'`);
        (error as NodeJS.ErrnoException).code = 'ENOENT';
        throw error;
      }
      return originalRealpath(candidate, options);
    },
  });

  try {
    const report = cleanupTempRoots();

    assert.equal(fs.existsSync(goodRoot), false);
    assert.equal(fs.existsSync(badRoot), true);
    assert.ok(report.skippedUnsafe.includes(badRoot));
    assert.ok(report.failed.some((failure) => failure.path === badRoot && failure.error.includes('ENOENT')));
  } finally {
    Object.defineProperty(fs.realpathSync, 'native', { configurable: true, value: originalRealpath });
  }
});

test('cleanup refuses a caller-supplied root outside the OS temp directory', () => {
  const outside = fs.mkdtempSync(path.join(process.cwd(), 'sq-cleanup-outside-'));
  assert.throws(() => cleanupTempRoots({ root: outside }), /must resolve to the OS temp directory/);
  fs.rmSync(outside, { recursive: true, force: true });
});
