import './_temp-cleanup.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { cleanupTempRoots, TEMP_CLEANUP_RECENT_MS } from '../src/lib/temp-cleanup.js';

// Every case sweeps its own sandbox inside the OS temp directory, never the
// temp directory itself. A real sweep here deletes every sq- root on the
// machine older than five minutes, which is any sibling test file's fixtures
// and any other suite run in progress (SQ-867).
function sandbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sq-cleanup-sandbox-'));
}

function windowsShortPath(pathname: string) {
  if (process.platform !== 'win32') return pathname;
  return execFileSync('cmd.exe', ['/d', '/c', `for %I in ("${pathname}") do @echo %~sI`], {
    encoding: 'utf8', windowsHide: true, shell: true,
  }).trim();
}

function aged(root: string, name: string) {
  const directory = path.join(root, name);
  fs.mkdirSync(directory, { recursive: true });
  const old = new Date(Date.now() - TEMP_CLEANUP_RECENT_MS - 1000);
  fs.utimesSync(directory, old, old);
  return directory;
}

test('cleanup fixtures reject hardcoded Windows paths', () => {
  const source = fs.readFileSync(__filename, 'utf8');
  assert.doesNotMatch(source, /['"`](?:[A-Za-z]:[\\/]|\\\\)/);
});

test('cleanup accepts an 8.3 alias in a temp-root ancestor', { skip: process.platform !== 'win32' }, (context) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-cleanup-alias-parent-'));
  const root = path.join(parent, 'root');
  fs.mkdirSync(root);
  const aliasParent = windowsShortPath(parent);
  if (aliasParent.toLowerCase() === parent.toLowerCase()) {
    context.skip('8.3 aliases are unavailable on this volume');
    return;
  }
  const oldRoot = aged(root, 'sq-cleanup-old');

  const report = cleanupTempRoots({ root: path.join(aliasParent, path.basename(root)) });

  assert.equal(report.removed, 1);
  assert.equal(fs.existsSync(oldRoot), false);
});

test('cleanup removes old roots, keeps recent roots, and reports reparse points', () => {
  const root = sandbox();
  const oldRoot = path.join(root, 'sq-cleanup-old');
  fs.mkdirSync(oldRoot);
  fs.writeFileSync(path.join(oldRoot, 'payload.txt'), 'old');
  const old = new Date(Date.now() - TEMP_CLEANUP_RECENT_MS - 1000);
  fs.utimesSync(oldRoot, old, old);

  const recentRoot = path.join(root, 'sq-cleanup-recent');
  fs.mkdirSync(recentRoot);
  const target = path.join(root, 'link-target');
  fs.mkdirSync(target);
  const link = path.join(root, 'sq-cleanup-link');
  fs.symlinkSync(target, link, 'junction');
  try { fs.lutimesSync(link, old, old); } catch { }

  const report = cleanupTempRoots({ root });

  assert.equal(report.removed, 1);
  assert.ok(report.removedEntries >= 2);
  assert.ok(report.skippedRecent.includes(recentRoot));
  assert.ok(report.skippedUnsafe.includes(link));
  assert.equal(fs.existsSync(oldRoot), false);
  assert.equal(fs.existsSync(recentRoot), true);
  assert.equal(fs.existsSync(target), true);
  assert.equal(fs.existsSync(link), true);

  fs.rmSync(link, { force: true });
});

test('cleanup records classification failures and continues scanning', () => {
  const root = sandbox();
  const badRoot = aged(root, 'sq-cleanup-bad');
  const goodRoot = aged(root, 'sq-cleanup-good');
  const originalLstat = fs.lstatSync;
  const originalLstatDescriptor = Object.getOwnPropertyDescriptor(fs, 'lstatSync');
  let badRootChecks = 0;
  Object.defineProperty(fs, 'lstatSync', {
    configurable: true,
    value: (candidate: fs.PathLike, options?: any) => {
      if (path.resolve(String(candidate)) === path.resolve(badRoot) && ++badRootChecks === 2) {
        const error = new Error(`ENOENT: no such file or directory, lstat '${badRoot}'`);
        (error as NodeJS.ErrnoException).code = 'ENOENT';
        throw error;
      }
      return originalLstat(candidate, options);
    },
  });

  try {
    const report = cleanupTempRoots({ root });

    assert.equal(fs.existsSync(goodRoot), false);
    assert.equal(fs.existsSync(badRoot), true);
    assert.ok(report.skippedUnsafe.includes(badRoot));
    assert.ok(report.failed.some((failure) => failure.path === badRoot && failure.error.includes('ENOENT')));
  } finally {
    Object.defineProperty(fs, 'lstatSync', originalLstatDescriptor!);
  }
});

test('cleanup only considers sq- prefixed entries', () => {
  const root = sandbox();
  const mine = aged(root, 'sq-cleanup-mine');
  const foreign = aged(root, 'cleanup-foreign');

  const report = cleanupTempRoots({ root });

  assert.equal(report.scanned, 1);
  assert.equal(fs.existsSync(mine), false);
  assert.equal(fs.existsSync(foreign), true);
});

test('cleanup defaults to the OS temp directory', () => {
  // now:0 makes every entry look recent, so this proves the default root
  // without deleting anything on the machine.
  const report = cleanupTempRoots({ now: 0 });

  assert.equal(report.root, fs.realpathSync.native(os.tmpdir()));
  assert.equal(report.removed, 0);
  assert.equal(report.removedEntries, 0);
});

test('cleanup refuses a caller-supplied root outside the OS temp directory', () => {
  const tempRoot = fs.realpathSync.native(os.tmpdir());
  const candidates = [process.cwd(), os.homedir(), path.dirname(tempRoot), path.parse(tempRoot).root];
  let outside: string | undefined;
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    const relative = path.relative(tempRoot, resolved);
    if (relative === '' || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) continue;
    try {
      const created = fs.mkdtempSync(path.join(resolved, 'sq-cleanup-outside-'));
      const createdRelative = path.relative(tempRoot, fs.realpathSync.native(created));
      if (createdRelative.startsWith(`..${path.sep}`) || path.isAbsolute(createdRelative)) {
        outside = created;
        break;
      }
      fs.rmSync(created, { recursive: true, force: true });
    } catch { }
  }
  assert.ok(outside, 'test needs a writable directory outside the OS temp directory');
  try {
    assert.throws(() => cleanupTempRoots({ root: outside }), /must resolve to the OS temp directory/);
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('cleanup refuses a traversal that leaves the OS temp directory', () => {
  assert.throws(
    () => cleanupTempRoots({ root: path.join(os.tmpdir(), '..', '..') }),
    /must resolve to the OS temp directory/,
  );
});
