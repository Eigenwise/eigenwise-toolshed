'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { checkParses, compareOutput, shellFor, verifySalvage } = require('../lib/verify.js');
const { inspectPlugin, unhiddenCalls } = require('../../test-support/windows-hide.js');

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'skill-retro-verify-test-'));
}

test('a salvaged script that does not parse is caught before anyone is asked to review it', () => {
  const dir = scratch();
  const broken = path.join(dir, 'broken.js');
  fs.writeFileSync(broken, 'const x = {;', 'utf8');
  const result = checkParses(broken);
  assert.equal(result.checked, true);
  assert.equal(result.ok, false);
});

test('a valid script passes the parse check', () => {
  const dir = scratch();
  const good = path.join(dir, 'good.js');
  fs.writeFileSync(good, 'console.log("hello");\n', 'utf8');
  assert.equal(checkParses(good).ok, true);
});

test('a file type with no parse check says so rather than claiming to have checked', () => {
  const dir = scratch();
  const file = path.join(dir, 'notes.txt');
  fs.writeFileSync(file, 'whatever', 'utf8');
  const result = checkParses(file);
  assert.equal(result.checked, false);
  assert.equal(result.ok, null);
});

test('output that differs only by timestamps and paths still counts as a match', () => {
  const recorded = 'scanned 12 files in C:/tmp/abc at 2026-07-30T10:00:00Z\ndone';
  const actual = 'scanned 15 files in C:/tmp/xyz at 2026-07-31T11:22:33Z\ndone';
  assert.equal(compareOutput(recorded, actual).match, 'normalized');
  assert.equal(compareOutput(recorded, recorded).match, 'exact');
});

test('genuinely different output is reported as a difference with the first mismatching line', () => {
  const result = compareOutput('alpha\nbeta', 'alpha\ngamma');
  assert.equal(result.match, 'differs');
  assert.match(result.detail, /first difference at normalized line 2/);
});

test('the recorded Bash and PowerShell shells keep their own replay arguments', () => {
  assert.deepEqual(shellFor('Bash', 'printf ok', () => 'bash'), ['bash', ['-lc', 'printf ok']]);
  assert.deepEqual(
    shellFor('PowerShell', 'Write-Output ok', () => 'pwsh'),
    ['pwsh', ['-NoProfile', '-NonInteractive', '-Command', 'Write-Output ok']],
  );
});

test('an unavailable recorded shell is reported separately from a failing replay', () => {
  const dir = scratch();
  const entry = {
    id: 'salvage-unavailable-shell',
    basename: 'probe.js',
    sourcePath: 'C:/old/probe.js',
    content: 'console.log("hello");\n',
    proof: { tool: 'Bash', command: 'node C:/old/probe.js', stdout: 'hello\n' },
  };

  const result = verifySalvage(entry, { execute: true, scratchDir: dir, resolveShell: () => null });
  assert.equal(result.execution.status, 'shell-unavailable');
  assert.match(result.execution.detail, /Bash shell is unavailable/);
});

test('a salvaged script is replayed against the output its transcript recorded', () => {
  const dir = scratch();
  const entry = {
    id: 'salvage-1',
    basename: 'probe.js',
    sourcePath: 'C:/old/probe.js',
    content: 'console.log("counted 42 rows");\n',
    proof: { tool: 'Bash', command: 'node C:/old/probe.js', stdout: 'counted 41 rows\n' },
  };

  const result = verifySalvage(entry, { execute: true, scratchDir: dir });
  assert.equal(result.parse.ok, true);
  assert.equal(result.execution.status, 'ran');
  assert.equal(result.execution.match, 'normalized', 'a differing row count is still the same output shape');
});

test('a salvaged script whose behavior actually changed is not reported as working', () => {
  const dir = scratch();
  const entry = {
    id: 'salvage-2',
    basename: 'probe.js',
    sourcePath: 'C:/old/probe.js',
    content: 'console.log("something else entirely");\n',
    proof: { tool: 'Bash', command: 'node C:/old/probe.js', stdout: 'counted 41 rows\n' },
  };
  const result = verifySalvage(entry, { execute: true, scratchDir: dir });
  assert.equal(result.execution.match, 'differs');
});

test('nothing is executed unless execution was asked for', () => {
  const dir = scratch();
  const entry = {
    id: 'salvage-3',
    basename: 'probe.js',
    sourcePath: 'C:/old/probe.js',
    content: 'console.log("hi");\n',
    proof: { tool: 'Bash', command: 'rm -rf /', stdout: '' },
  };
  const result = verifySalvage(entry, { scratchDir: dir });
  assert.equal(result.execution.status, 'skipped');
  assert.match(result.execution.detail, /pass --run/);
});

test('a script with no recorded successful run is reported as unproven, not as passing', () => {
  const dir = scratch();
  const result = verifySalvage({ id: 'salvage-4', basename: 'probe.js', content: 'console.log(1);\n', proof: null }, { scratchDir: dir });
  assert.equal(result.execution.status, 'unproven');
});

test('every child process this plugin spawns is hidden on Windows', () => {
  const calls = inspectPlugin(path.join(__dirname, '..'));
  assert.deepEqual(unhiddenCalls(calls).map((call) => `${call.file}:${call.line}`), []);
  assert.ok(calls.length > 0, 'the scanner must actually be finding this plugin\'s spawn calls');
});
