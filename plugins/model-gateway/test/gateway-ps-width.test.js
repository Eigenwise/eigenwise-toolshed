'use strict';

// Regression test for terminal-width truncation of `ps` probe output.
//
// procps `ps` truncates the args column to $COLUMNS even when stdout is a
// pipe. Gateway controllers run from interactive shells and Claude Code hooks
// that export COLUMNS (e.g. 117 in a real PTY), so the four probe code paths
// (processInfoSync, processTableSync, processInfoAsync, processTableAsync)
// saw commands cut off before `.../model-gateway/bin/model-gateway.js`.
// gatewayInstallRootFromCommand() then failed to extract the install root and
// the gateway misclassified its OWN supervisor/proxy processes as not owned:
// pid records were retired and legitimate stop/restart flows refused to act.
//
// These tests spawn real long-command fixture subprocesses and probe them
// with real `ps` subprocesses at COLUMNS of 80, 117, 128, 133, 200 and unset,
// asserting own/foreign/unknown ownership classification and full, untruncated
// command lines in all four probes. No mocks, no ports, and the module HOME is
// redirected to a temp fixture home before lib is loaded, so the live gateway
// home and :18764 are never touched.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

// Isolate HOME before any lib require: runtime.js derives STATE/LOGS/PROXY_BIN
// from os.homedir() at load time, and os.homedir() honors $HOME on POSIX.
const fixtureHome = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-ps-width-home-'));
process.env.HOME = fixtureHome;
delete process.env.CLAUDE_CONFIG_DIR;

const {
  installBelongsToThisPlugin,
  isDescendantOfAsync,
  processInfoAsync,
  processInfoSync,
  processIsOwnedByThisInstall,
  processIsOwnedByThisInstallAsync,
  processTableAsync,
  processTableSync,
} = require('../lib/process-supervision.js');
const { CLI_PATH, PROXY_BIN } = require('../lib/runtime.js');

const LSTART_PATTERN = /^\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4}$/;
// The widths observed in the wild: 80 (default shell), 117 (Claude Code PTY),
// 128/133 (common terminal defaults), 200 (wide terminal), and unset (pipe
// default, which procps leaves unlimited — the control case).
const WIDTHS = [80, 117, 128, 133, 200, null];

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-ps-width-'));
const IDLE_FIXTURE_SOURCE = `'use strict';\n// Idle fixture: stays alive so ps probes can observe it.\nsetInterval(() => {}, 1000);\n`;

// A deliberately deep directory so every fixture argv exceeds 200 columns
// before its sentinel argument, at any tmpdir prefix length.
const deepDirectory = path.join(fixtureRoot, `deep-${'f'.repeat(48)}-fixture-directory`);
fs.mkdirSync(deepDirectory, { recursive: true });

const idleFixtureScript = path.join(deepDirectory, 'long-argv-idle-fixture.js');
const unknownFixtureScript = path.join(deepDirectory, 'not-a-gateway-process.js');
fs.writeFileSync(idleFixtureScript, IDLE_FIXTURE_SOURCE);
fs.writeFileSync(unknownFixtureScript, IDLE_FIXTURE_SOURCE);

// A foreign install shaped exactly like a real plugin cache install root
// (…/plugins/cache/<marketplace>/model-gateway/<version>/bin/model-gateway.js)
// but under the temp fixture root, so it never matches this worktree install.
const foreignInstallRoot = path.join(fixtureRoot, 'foreign-install', '.claude', 'plugins', 'cache', 'eigenwise-toolshed', 'model-gateway', '9.99.99');
const foreignCliPath = path.join(foreignInstallRoot, 'bin', 'model-gateway.js');
fs.mkdirSync(path.dirname(foreignCliPath), { recursive: true });
fs.writeFileSync(foreignCliPath, IDLE_FIXTURE_SOURCE);

const paddingArg = `--gw-ps-width-padding=${'p'.repeat(160)}`;
function sentinelArg(label) {
  return `--gw-ps-width-sentinel=${label}-${crypto.randomBytes(6).toString('hex')}`;
}
const sentinels = {
  own: sentinelArg('own'),
  foreign: sentinelArg('foreign'),
  unknown: sentinelArg('unknown'),
  proxy: sentinelArg('proxy'),
};

function spawnIdleFixture(args) {
  const child = spawn(process.execPath, args, { stdio: 'ignore', windowsHide: true });
  child.once('error', () => {});
  return child;
}

// own: the sentinel-carrying command line contains THIS install's CLI path
// (as a real gateway process command line does), followed by long padding.
const ownFixture = spawnIdleFixture([idleFixtureScript, CLI_PATH, paddingArg, sentinels.own]);
// foreign: a live process running a different install root's model-gateway.js.
const foreignFixture = spawnIdleFixture([foreignCliPath, paddingArg, sentinels.foreign]);
// unknown: a live long-command process with no gateway path at all.
const unknownFixture = spawnIdleFixture([unknownFixtureScript, paddingArg, sentinels.unknown]);
// proxy-named: a live process whose command line carries this (fixture-home)
// install's proxy binary path, exercising the name:'proxy' binary-identity
// branch of processIsOwnedByThisInstall, which also depends on full commands.
const proxyFixture = spawnIdleFixture([idleFixtureScript, PROXY_BIN, paddingArg, sentinels.proxy]);

const fixtures = {
  own: { child: ownFixture, gatewayPath: CLI_PATH, sentinel: sentinels.own },
  foreign: { child: foreignFixture, gatewayPath: foreignCliPath, sentinel: sentinels.foreign },
  unknown: { child: unknownFixture, gatewayPath: unknownFixtureScript, sentinel: sentinels.unknown },
  proxy: { child: proxyFixture, gatewayPath: PROXY_BIN, sentinel: sentinels.proxy },
};

function waitForFixtureExit(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', resolve);
    child.once('error', resolve);
  });
}

test.after(async () => {
  for (const { child } of Object.values(fixtures)) {
    try { child.kill('SIGTERM'); } catch {}
  }
  await Promise.all(Object.values(fixtures).map(({ child }) => waitForFixtureExit(child)));
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
  fs.rmSync(fixtureHome, { recursive: true, force: true });
});

async function withColumns(width, run) {
  const hadColumns = Object.prototype.hasOwnProperty.call(process.env, 'COLUMNS');
  const originalColumns = process.env.COLUMNS;
  if (width === null) delete process.env.COLUMNS;
  else process.env.COLUMNS = String(width);
  try {
    return await run();
  } finally {
    if (hadColumns) process.env.COLUMNS = originalColumns;
    else delete process.env.COLUMNS;
  }
}

function widthLabel(width) {
  return width === null ? 'unset' : String(width);
}

function assertFullCommand(command, fixture, label) {
  assert.ok(command, `${label}: probe returned no command line`);
  assert.ok(
    command.includes(fixture.gatewayPath),
    `${label}: command line lost the fixture path ${fixture.gatewayPath}; got: ${command}`,
  );
  assert.ok(
    command.includes(fixture.sentinel),
    `${label}: command line was truncated before the sentinel ${fixture.sentinel}; got: ${command}`,
  );
}

function assertExpectedOwnership(actual, kind, probeLabel, width) {
  const expected = kind === 'own';
  assert.equal(
    actual,
    expected,
    `${probeLabel} at COLUMNS=${widthLabel(width)} misclassified the ${kind} fixture: expected owned=${expected}, got ${actual}`,
  );
}

function assertParsedProcessInfo(info, fixture, label) {
  assert.ok(info, `${label}: probe returned no process info`);
  assert.equal(info.pid, fixture.child.pid, `${label}: pid mismatch`);
  assert.equal(info.parentPid, process.pid, `${label}: parent pid mismatch`);
  assert.match(info.startedAt, LSTART_PATTERN, `${label}: lstart did not parse`);
  assertFullCommand(info.command, fixture, label);
}

function assertTableRow(table, fixture, label) {
  assert.ok(table instanceof Map, `${label}: probe returned no process table`);
  const row = table.get(fixture.child.pid);
  assert.ok(row, `${label}: fixture pid ${fixture.child.pid} missing from process table`);
  assert.equal(row.parentPid, process.pid, `${label}: table row parent pid mismatch`);
  assert.match(row.startedAt, LSTART_PATTERN, `${label}: table row lstart did not parse`);
  assertFullCommand(row.command, fixture, label);
}

for (const width of WIDTHS) {
  test(`ps probes keep full command lines and ownership at COLUMNS=${widthLabel(width)}`, async (t) => {
    if (process.platform === 'win32') {
      t.skip('the width-truncated ps probes are POSIX-only; the Windows probes use CIM CommandLine, which is never truncated');
      return;
    }

    // Probe 1: synchronous per-PID probe (processInfoSync) plus the
    // synchronous ownership decision that consumes it.
    await withColumns(width, () => {
      assertParsedProcessInfo(processInfoSync(ownFixture.pid), fixtures.own, 'processInfoSync(own)');
      assertParsedProcessInfo(processInfoSync(foreignFixture.pid), fixtures.foreign, 'processInfoSync(foreign)');
      assertParsedProcessInfo(processInfoSync(unknownFixture.pid), fixtures.unknown, 'processInfoSync(unknown)');
      assertParsedProcessInfo(processInfoSync(proxyFixture.pid), fixtures.proxy, 'processInfoSync(proxy)');
      assertExpectedOwnership(processIsOwnedByThisInstall(ownFixture.pid), 'own', 'processIsOwnedByThisInstall', width);
      assertExpectedOwnership(processIsOwnedByThisInstall(foreignFixture.pid), 'foreign', 'processIsOwnedByThisInstall', width);
      assertExpectedOwnership(processIsOwnedByThisInstall(unknownFixture.pid), 'unknown', 'processIsOwnedByThisInstall', width);
      assert.equal(
        processIsOwnedByThisInstall(proxyFixture.pid, { name: 'proxy' }),
        true,
        `the proxy-binary identity path at COLUMNS=${widthLabel(width)} must own a process running this install's PROXY_BIN`,
      );
      assert.equal(
        processIsOwnedByThisInstall(unknownFixture.pid, { name: 'proxy' }),
        false,
        `the proxy-binary identity path at COLUMNS=${widthLabel(width)} must not own a process that does not run PROXY_BIN`,
      );
    });

    // Probe 2: synchronous process-table probe (processTableSync).
    await withColumns(width, () => {
      const table = processTableSync();
      assertTableRow(table, fixtures.own, 'processTableSync(own)');
      assertTableRow(table, fixtures.foreign, 'processTableSync(foreign)');
      assertTableRow(table, fixtures.unknown, 'processTableSync(unknown)');
      assertTableRow(table, fixtures.proxy, 'processTableSync(proxy)');
    });

    // Probe 3: asynchronous per-PID probe (processInfoAsync) plus the
    // asynchronous ownership decision that consumes it.
    await withColumns(width, async () => {
      assertParsedProcessInfo(await processInfoAsync(ownFixture.pid), fixtures.own, 'processInfoAsync(own)');
      assertParsedProcessInfo(await processInfoAsync(foreignFixture.pid), fixtures.foreign, 'processInfoAsync(foreign)');
      assertParsedProcessInfo(await processInfoAsync(unknownFixture.pid), fixtures.unknown, 'processInfoAsync(unknown)');
      assertParsedProcessInfo(await processInfoAsync(proxyFixture.pid), fixtures.proxy, 'processInfoAsync(proxy)');
      assertExpectedOwnership(await processIsOwnedByThisInstallAsync(ownFixture.pid), 'own', 'processIsOwnedByThisInstallAsync', width);
      assertExpectedOwnership(await processIsOwnedByThisInstallAsync(foreignFixture.pid), 'foreign', 'processIsOwnedByThisInstallAsync', width);
      assertExpectedOwnership(await processIsOwnedByThisInstallAsync(unknownFixture.pid), 'unknown', 'processIsOwnedByThisInstallAsync', width);
      assert.equal(
        await processIsOwnedByThisInstallAsync(proxyFixture.pid, { name: 'proxy' }),
        true,
        `the async proxy-binary identity path at COLUMNS=${widthLabel(width)} must own a process running this install's PROXY_BIN`,
      );
      assert.equal(
        await processIsOwnedByThisInstallAsync(unknownFixture.pid, { name: 'proxy' }),
        false,
        `the async proxy-binary identity path at COLUMNS=${widthLabel(width)} must not own a process that does not run PROXY_BIN`,
      );
    });

    // Probe 4: asynchronous process-table probe (processTableAsync), plus the
    // descendant walk that consumes it.
    await withColumns(width, async () => {
      const table = await processTableAsync();
      assertTableRow(table, fixtures.own, 'processTableAsync(own)');
      assertTableRow(table, fixtures.foreign, 'processTableAsync(foreign)');
      assertTableRow(table, fixtures.unknown, 'processTableAsync(unknown)');
      assertTableRow(table, fixtures.proxy, 'processTableAsync(proxy)');
      assert.equal(await isDescendantOfAsync(ownFixture.pid, process.pid), true, 'the own fixture is a direct child of this test process');
    });

    // Sync and async probes must agree field-for-field, so -ww did not change
    // parsing semantics between the two code paths.
    await withColumns(width, async () => {
      const sync = processInfoSync(ownFixture.pid);
      const async = await processInfoAsync(ownFixture.pid);
      assert.equal(async.command, sync.command, 'sync and async PID probes disagree on the command line');
      assert.equal(async.startedAt, sync.startedAt, 'sync and async PID probes disagree on lstart');
      assert.equal(async.parentPid, sync.parentPid, 'sync and async PID probes disagree on ppid');
    });

    // Ownership semantics preserved: the foreign fixture's install root stays
    // extractable and non-belonging once truncation is gone, and the fixture
    // home never became this install's home.
    await withColumns(width, () => {
      const foreignInfo = processInfoSync(foreignFixture.pid);
      assert.equal(installBelongsToThisPlugin(foreignInstallRoot), false, 'the foreign cache-style install root must not belong to this plugin');
      assert.ok(foreignInfo.command.includes(foreignCliPath), 'foreign command line lost the foreign CLI path');
    });
  });
}
