'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

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

test('stable updater launches the highest installed model-gateway version', (t) => {
  const home = temporaryDirectory(t);
  const registryDirectory = path.join(home, '.claude', 'plugins');
  const oldInstall = path.join(home, 'model-gateway-0.1.9');
  const newInstall = path.join(home, 'model-gateway-0.1.10');
  const result = path.join(home, 'result.json');
  for (const install of [oldInstall, newInstall]) {
    fs.mkdirSync(path.join(install, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(install, 'bin', 'model-gateway.js'), "require('node:fs').writeFileSync(process.env.MODEL_GATEWAY_TEST_RESULT, JSON.stringify([process.argv[1], ...process.argv.slice(2)]));\n");
  }
  fs.mkdirSync(registryDirectory, { recursive: true });
  fs.writeFileSync(path.join(registryDirectory, 'installed_plugins.json'), JSON.stringify({
    plugins: {
      'model-gateway@eigenwise-toolshed': [
        { version: '0.1.9', installPath: oldInstall },
        { version: '0.1.10', installPath: newInstall },
      ],
    },
  }));
  const launcher = writer.writeUpdateLauncher({ home }).file;

  const run = spawnSync(process.execPath, [launcher], {
    encoding: 'utf8',
    env: { ...process.env, MODEL_GATEWAY_CLAUDE_HOME: path.join(home, '.claude'), MODEL_GATEWAY_TEST_RESULT: result },
  });

  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(result, 'utf8')), [path.join(newInstall, 'bin', 'model-gateway.js'), 'setup']);
});
