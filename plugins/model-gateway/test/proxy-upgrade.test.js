'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { spawnGatewayProcessSync } = require('./support.js');

const commands = require('../lib/commands.js');
const writer = require('../hooks/registry-writer.js');

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-proxy-upgrade-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('replaces an open current proxy by rename', (t) => {
  const directory = temporaryDirectory(t);
  const current = path.join(directory, 'claude-code-proxy');
  const staged = path.join(directory, 'staged-proxy');
  fs.writeFileSync(current, 'old proxy');
  fs.writeFileSync(staged, 'new proxy');
  const handle = fs.openSync(current, 'r');
  t.after(() => fs.closeSync(handle));

  const result = commands.replaceProxyBinary({ currentPath: current, stagedPath: staged, currentVersion: [0, 1, 30], now: 1 });

  assert.equal(fs.readFileSync(current, 'utf8'), 'new proxy');
  assert.equal(fs.readFileSync(result.previousPath, 'utf8'), 'old proxy');
  assert.match(result.previousPath, /\.old-0\.1\.30-1$/);
});

test('restores the previous proxy when the staged rename fails', (t) => {
  const directory = temporaryDirectory(t);
  const current = path.join(directory, 'claude-code-proxy');
  const staged = path.join(directory, 'staged-proxy');
  fs.writeFileSync(current, 'old proxy');
  fs.writeFileSync(staged, 'new proxy');
  const fsImpl = {
    ...fs,
    renameSync(source, target) {
      if (source === staged && target === current) {
        const error = new Error('locked staged file');
        error.code = 'EBUSY';
        throw error;
      }
      return fs.renameSync(source, target);
    },
  };

  assert.throws(
    () => commands.replaceProxyBinary({ currentPath: current, stagedPath: staged, currentVersion: [0, 1, 30], fsImpl, now: 1 }),
    /original proxy restored/
  );
  assert.equal(fs.readFileSync(current, 'utf8'), 'old proxy');
  assert.equal(fs.existsSync(path.join(directory, 'claude-code-proxy.old-0.1.30-1')), false);
});

test('leaves undeletable old proxies for a later sweep', (t) => {
  const directory = temporaryDirectory(t);
  const oldProxy = path.join(directory, 'claude-code-proxy.old-0.1.30-1');
  fs.writeFileSync(oldProxy, 'old proxy');
  const fsImpl = {
    ...fs,
    rmSync(file) {
      if (file === oldProxy) {
        const error = new Error('still in use');
        error.code = 'EPERM';
        throw error;
      }
      return fs.rmSync(file);
    },
  };

  assert.doesNotThrow(() => commands.sweepOldProxyBinaries({ directory, basename: 'claude-code-proxy', fsImpl }));
  assert.equal(fs.existsSync(oldProxy), true);
});

test('version change without a supervisor stops the proxy and reports the next ensure', async () => {
  let listeningChecks = 0;
  let stopped = false;
  const restarted = await commands.restartProxyForVersionChange({
    listening: async () => listeningChecks++ === 0,
    stop: () => { stopped = true; },
    supervisorRunning: async () => false,
  });
  let report = '';
  const result = await commands.restartProxyIfOutdated({
    currentVersion: () => '2.0.0',
    readServingVersion: () => '1.0.0',
    restart: async () => false,
    report: (message) => { report = message; },
  });

  assert.equal(restarted, false);
  assert.equal(stopped, true);
  assert.deepEqual(result, { restarted: false, onDisk: '2.0.0', serving: '1.0.0' });
  assert.match(report, /proxy on disk: 2\.0\.0\s+serving: 1\.0\.0\s+restarts on next `ensure`/);
});

test('matching serving and on-disk proxy versions do nothing', async () => {
  let restarted = false;
  const result = await commands.restartProxyIfOutdated({
    currentVersion: () => '2.0.0',
    readServingVersion: () => '2.0.0',
    restart: async () => { restarted = true; },
  });

  assert.deepEqual(result, { restarted: false, onDisk: '2.0.0', serving: '2.0.0' });
  assert.equal(restarted, false);
});

test('stable command launcher follows registry changes and forwards command exits', (t) => {
  const home = temporaryDirectory(t);
  const registryDirectory = path.join(home, '.claude', 'plugins');
  const oldInstall = path.join(home, 'model-gateway-0.1.9');
  const newInstall = path.join(home, 'model-gateway-0.1.10');
  const result = path.join(home, 'result.json');
  for (const install of [oldInstall, newInstall]) {
    fs.mkdirSync(path.join(install, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(install, 'bin', 'model-gateway.js'), [
      "const fs = require('node:fs');",
      "fs.writeFileSync(process.env.MODEL_GATEWAY_TEST_RESULT, JSON.stringify([process.argv[1], ...process.argv.slice(2)]));",
      'process.exit(Number(process.env.MODEL_GATEWAY_TEST_EXIT));',
    ].join('\n'));
  }
  fs.mkdirSync(registryDirectory, { recursive: true });
  const registry = path.join(registryDirectory, 'installed_plugins.json');
  fs.writeFileSync(registry, JSON.stringify({
    plugins: {
      'model-gateway@eigenwise-toolshed': [
        { version: '0.1.9', installPath: oldInstall },
        { version: '0.1.10', installPath: newInstall },
      ],
    },
  }));
  const updateLauncher = writer.writeUpdateLauncher({ home }).file;
  const launcher = writer.commandLauncherPath(home);
  const env = { ...process.env, MODEL_GATEWAY_CLAUDE_HOME: path.join(home, '.claude'), MODEL_GATEWAY_TEST_RESULT: result };

  const update = spawnGatewayProcessSync(process.execPath, [updateLauncher], {
    encoding: 'utf8',
    env: { ...env, MODEL_GATEWAY_TEST_EXIT: '11' },
  });

  assert.equal(update.status, 11, update.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(result, 'utf8')), [path.join(newInstall, 'bin', 'model-gateway.js'), 'setup']);

  const newer = spawnGatewayProcessSync(process.execPath, [launcher, 'status', '--json'], {
    encoding: 'utf8',
    env: { ...env, MODEL_GATEWAY_TEST_EXIT: '17' },
  });

  assert.equal(newer.status, 17, newer.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(result, 'utf8')), [path.join(newInstall, 'bin', 'model-gateway.js'), 'status', '--json']);

  fs.writeFileSync(registry, JSON.stringify({
    plugins: { 'model-gateway@eigenwise-toolshed': [{ version: '0.1.9', installPath: oldInstall }] },
  }));
  const downgraded = spawnGatewayProcessSync(process.execPath, [launcher, 'doctor'], {
    encoding: 'utf8',
    env: { ...env, MODEL_GATEWAY_TEST_EXIT: '23' },
  });

  assert.equal(downgraded.status, 23, downgraded.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(result, 'utf8')), [path.join(oldInstall, 'bin', 'model-gateway.js'), 'doctor']);

  fs.writeFileSync(registry, JSON.stringify({ plugins: { 'model-gateway@eigenwise-toolshed': [] } }));
  const missing = spawnGatewayProcessSync(process.execPath, [launcher, 'status'], { encoding: 'utf8', env });

  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /no installed Model Gateway CLI was found in Claude Code's plugin registry/);
});
