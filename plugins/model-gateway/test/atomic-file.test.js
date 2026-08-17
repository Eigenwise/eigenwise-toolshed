'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { writeFileAtomically } = require('../lib/atomic-file.js');

function atomicWriteFixture(label) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `atomic-write-${label}-`));
  const file = path.join(directory, 'state.json');
  fs.writeFileSync(file, '{"old":true}\n');
  return { directory, file };
}

test('an atomic write retries a transient target lock and replaces the target', () => {
  const { directory, file } = atomicWriteFixture('retry');
  const originalRename = fs.renameSync;
  let remainingFailures = 1;
  try {
    fs.renameSync = (from, to) => {
      if (to === file && remainingFailures-- > 0) {
        const error = new Error('the target is open elsewhere');
        error.code = 'EBUSY';
        throw error;
      }
      return originalRename(from, to);
    };

    writeFileAtomically(file, '{"new":true}\n');

    assert.equal(fs.readFileSync(file, 'utf8'), '{"new":true}\n');
  } finally {
    fs.renameSync = originalRename;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a failed atomic replace leaves no temporary sibling behind', () => {
  const { directory, file } = atomicWriteFixture('failure');
  const originalRename = fs.renameSync;
  try {
    fs.renameSync = () => {
      const error = new Error('permission denied');
      error.code = 'EPERM';
      throw error;
    };

    assert.throws(() => writeFileAtomically(file, '{"new":true}\n'), /permission denied/);

    assert.deepEqual(fs.readdirSync(directory), ['state.json']);
  } finally {
    fs.renameSync = originalRename;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a successful atomic write removes stale temporary siblings but retains live ones', () => {
  const { directory, file } = atomicWriteFixture('sweep');
  const abandoned = path.join(directory, 'state.json.4242.abandoned.tmp');
  const inFlight = path.join(directory, 'state.json.4243.in-flight.tmp');
  try {
    fs.writeFileSync(abandoned, 'stale');
    const twoHoursAgo = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(abandoned, twoHoursAgo, twoHoursAgo);
    fs.writeFileSync(inFlight, 'live');

    writeFileAtomically(file, '{"new":true}\n');

    assert.equal(fs.existsSync(abandoned), false);
    assert.equal(fs.existsSync(inFlight), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
