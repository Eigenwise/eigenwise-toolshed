'use strict';

// Regression test for a process table larger than spawnSync's default 1 MiB maxBuffer.
//
// On a shared macOS host the `ps -ww -eo pid=,ppid=,lstart=,args=` output measured 1.1 to 1.5 MB
// (other users' jobs carrying ~110 KB prompts on their command lines). spawnSync failed with
// ENOBUFS, processTableSync returned null, and releases before 0.55.2 then treated every recorded
// gateway process as an orphan and stopped a healthy supervisor on each `ensure`.
//
// A fake `ps` placed first on PATH replays the real table and appends padding rows past 1 MiB, so
// the real probe code path runs against a real subprocess. No ports, no live gateway state.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { processTableSync, reapGatewayOrphans } = require('../lib/process-supervision.js');

const WIN = process.platform === 'win32';
const PADDING_ROWS = 24;
const PADDING_ARG_BYTES = 100 * 1024;

function realPsPath() {
  return (process.env.PATH || '').split(path.delimiter)
    .map((directory) => path.join(directory, 'ps'))
    .find((candidate) => fs.existsSync(candidate));
}

function installOversizedPs(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-large-ps-'));
  const originalPath = process.env.PATH;
  const script = [
    '#!/bin/sh',
    `"${realPsPath()}" "$@" || exit $?`,
    // Only the whole-table probe is padded; a single-pid probe keeps its real size.
    'case " $* " in *" -eo "*) ;; *) exit 0 ;; esac',
    `pad=$(head -c ${PADDING_ARG_BYTES} /dev/zero | tr '\\0' 'p')`,
    'i=0',
    `while [ "$i" -lt ${PADDING_ROWS} ]; do`,
    '  echo "$((4000000 + i))     1 Wed Sep  9 10:00:00 2026 /fixture/padding $pad"',
    '  i=$((i + 1))',
    'done',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(directory, 'ps'), script, { mode: 0o755 });
  process.env.PATH = `${directory}${path.delimiter}${originalPath}`;
  t.after(() => {
    process.env.PATH = originalPath;
    fs.rmSync(directory, { recursive: true, force: true });
  });
}

test('processTableSync reads a process table larger than 1 MiB', { skip: WIN }, (t) => {
  installOversizedPs(t);
  const table = processTableSync();
  assert.ok(table, 'a process table over 1 MiB must still be read, not reported as unreadable');
  assert.ok(table.has(process.pid), 'the table includes this test process');
  assert.equal(table.get(4000000)?.parentPid, 1);
  const bytes = [...table.values()].reduce((total, entry) => total + entry.command.length, 0);
  assert.ok(bytes > 1024 * 1024, `fixture table must exceed 1 MiB, saw ${bytes} bytes of commands`);
});

test('an unreadable process table never reaps anything under a live supervisor', () => {
  const stopped = [];
  const reaped = reapGatewayOrphans(process.pid, {
    processTable: () => null,
    terminate: (pid) => { stopped.push(pid); return true; },
    kill: (pid) => { stopped.push(pid); return true; },
  });
  assert.deepEqual(reaped, []);
  assert.deepEqual(stopped, []);
});
