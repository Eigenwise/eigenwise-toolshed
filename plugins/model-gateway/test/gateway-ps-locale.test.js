'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const supervisionPath = path.join(__dirname, '..', 'lib', 'process-supervision.js');
const childEnvironmentProgram = `
(async () => {
const [platform, modulePath] = process.argv.slice(1);
Object.defineProperty(process, 'platform', { value: platform, configurable: true });
const {
  commandResultAsync,
  commandResultSync,
  isDescendantOfAsync,
  processInfoAsync,
  processTableAsync,
  resolvePortOwner,
} = require(modulePath);

const englishCommand = '/tmp/模型/.claude/plugins/cache/example/model-gateway/9.9.9/bin/model-gateway.js serve';
const englishOutput = '95299     1 Wed Sep  9 23:24:12 2026 ' + englishCommand;
const frenchOutput = '95299     1 mer.  9 sept. 23:24:12 2026 ' + englishCommand;
const tableOutput = englishOutput + '\\n1     0 Wed Sep  9 10:00:00 2026 /sbin/launchd';
const childProgram = 'process.stdout.write(JSON.stringify({ LC_ALL: process.env.LC_ALL, LANG: process.env.LANG, LC_TIME: process.env.LC_TIME, unrelated: process.env.MODEL_GATEWAY_LOCALE_SENTINEL }))';
const parentEnvironmentBefore = { ...process.env };
const syncResult = commandResultSync(process.execPath, ['-e', childProgram]);
const asyncResult = await commandResultAsync(process.execPath, ['-e', childProgram]);
if (platform === 'win32') {
  process.stdout.write(JSON.stringify({
    asyncEnvironment: JSON.parse(asyncResult.stdout),
    parentEnvironmentUnchanged: JSON.stringify(parentEnvironmentBefore) === JSON.stringify(process.env),
    syncEnvironment: JSON.parse(syncResult.stdout),
  }));
  return;
}
const processFrom = (output) => async () => ({ status: 0, stdout: output, stderr: '', timedOut: false });
const englishProcess = await processInfoAsync(95299, { commandResult: processFrom(englishOutput) });
const frenchProcess = await processInfoAsync(95299, { commandResult: processFrom(frenchOutput) });
const malformedProcess = await processInfoAsync(95299, { commandResult: processFrom('ps: localized failure') });
const table = await processTableAsync({ commandResult: processFrom(tableOutput) });
const sameInstallOwner = await resolvePortOwner(18764, {
  belongsToThisInstall: () => true,
  inspectProcess: async () => englishProcess,
  listening: async () => true,
  owner: async () => 95299,
});
const foreignOwner = await resolvePortOwner(18764, {
  belongsToThisInstall: () => false,
  inspectProcess: async () => englishProcess,
  listening: async () => true,
  owner: async () => 95299,
});
const unknownOwner = await resolvePortOwner(18764, {
  inspectProcess: async () => frenchProcess,
  listening: async () => true,
  owner: async () => 95299,
});
process.stdout.write(JSON.stringify({
  asyncEnvironment: JSON.parse(asyncResult.stdout),
  englishCommand,
  sameInstallOwner,
  englishProcess,
  descendant: await isDescendantOfAsync(95299, 1, { processTable: async () => table }),
  foreignOwner,
  frenchProcess,
  malformedProcess,
  parentEnvironmentUnchanged: JSON.stringify(parentEnvironmentBefore) === JSON.stringify(process.env),
  syncEnvironment: JSON.parse(syncResult.stdout),
  tableSize: table.size,
  unknownOwner,
}));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
`;

function runProbeFixture(platform) {
  const environment = {
    ...process.env,
    LANG: 'fr_FR.UTF-8',
    LC_ALL: 'fr_FR.UTF-8',
    LC_TIME: 'fr_FR.UTF-8',
    MODEL_GATEWAY_LOCALE_SENTINEL: 'keep-me',
  };
  const result = spawnSync(process.execPath, ['-e', childEnvironmentProgram, platform, supervisionPath], {
    encoding: 'utf8',
    env: environment,
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function assertProbeEnvironment(environment, expectedLocale) {
  assert.deepEqual(environment, {
    LANG: 'fr_FR.UTF-8',
    LC_ALL: expectedLocale,
    LC_TIME: 'fr_FR.UTF-8',
    unrelated: 'keep-me',
  });
}

test('POSIX process probes pin C while parser and ownership fixtures retain their authority', () => {
  const parentEnvironmentBefore = { ...process.env };
  const fixture = runProbeFixture(process.platform === 'win32' ? 'darwin' : process.platform);

  assertProbeEnvironment(fixture.syncEnvironment, 'C');
  assertProbeEnvironment(fixture.asyncEnvironment, 'C');
  assert.equal(fixture.parentEnvironmentUnchanged, true);
  assert.deepEqual({ ...process.env }, parentEnvironmentBefore);
  assert.equal(fixture.englishCommand, '/tmp/模型/.claude/plugins/cache/example/model-gateway/9.9.9/bin/model-gateway.js serve');
  assert.equal(fixture.englishProcess.command, fixture.englishCommand);
  assert.equal(fixture.englishProcess.startedAt, 'Wed Sep  9 23:24:12 2026');
  assert.equal(fixture.frenchProcess, null);
  assert.equal(fixture.malformedProcess, null);
  assert.equal(fixture.tableSize, 2);
  assert.equal(fixture.descendant, true);
  assert.equal(fixture.sameInstallOwner.state, 'same-install');
  assert.equal(fixture.sameInstallOwner.pid, 95299);
  assert.ok(fixture.sameInstallOwner.installRoot);
  assert.equal(fixture.foreignOwner.state, 'foreign-install');
  assert.equal(fixture.foreignOwner.pid, 95299);
  assert.ok(fixture.foreignOwner.installRoot);
  assert.deepEqual(fixture.unknownOwner, { state: 'unknown', pid: 95299 });
});

test('Windows process probes inherit their existing environment', () => {
  const fixture = runProbeFixture('win32');

  assertProbeEnvironment(fixture.syncEnvironment, 'fr_FR.UTF-8');
  assertProbeEnvironment(fixture.asyncEnvironment, 'fr_FR.UTF-8');
  assert.equal(fixture.parentEnvironmentUnchanged, true);
});
