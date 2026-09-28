'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const runtime = require('../lib/runtime.js');
const { spawnGatewayProcessSync } = require('./support.js');

const COMMANDS = path.join(__dirname, '..', 'lib', 'commands.js');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-stable-command-'));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { home, project };
}

function runDoctor(home, project, readinessOverrides = {}) {
  const readiness = {
    ready: true,
    state: 'ready',
    checks: { proxyBinary: false, proxyModels: true, codexAuth: true, shimRunning: true, servingVersion: 'test', servingVersionMatches: true },
    ...readinessOverrides,
  };
  const { ANTHROPIC_BASE_URL, ...environment } = process.env;
  const result = spawnGatewayProcessSync(process.execPath, [
    '-e', `require(${JSON.stringify(COMMANDS)}).commands.doctor({ readiness: ${JSON.stringify(readiness)} })`,
  ], {
    cwd: project,
    encoding: 'utf8',
    timeout: 20000,
    isolatedOverrides: { CODEX_GATEWAY_PORT: '9', CODEX_GATEWAY_WORKER_PORT: '9', CODEX_GATEWAY_PROXY_PORT: '9' },
    env: { ...environment, HOME: home, USERPROFILE: home, CODEX_GATEWAY_PORT: '9', CODEX_GATEWAY_PROXY_PORT: '9' },
  });
  assert.ifError(result.error);
  return { code: result.status, output: result.stdout + result.stderr };
}

test('resolveStableCommandPath falls back to the CLI when the SessionStart launcher was never written', () => {
  const resolved = runtime.resolveStableCommandPath({ pathExists: () => false });
  assert.equal(resolved, runtime.CLI_PATH);
  assert.ok(fs.existsSync(resolved), 'the fallback path must be a file that actually exists and can run');
});

test('resolveStableCommandPath prefers the stable launcher once it exists', () => {
  const resolved = runtime.resolveStableCommandPath({ pathExists: (candidate) => candidate === runtime.STABLE_COMMAND_PATH });
  assert.equal(resolved, runtime.STABLE_COMMAND_PATH);
});

test('codexReadinessMessage falls back to a runnable path when the launcher is absent, unchanged when present', () => {
  const missingLauncherMessage = runtime.codexReadinessMessage('shim-down', runtime.resolveStableCommandPath({ pathExists: () => false }));
  assert.match(missingLauncherMessage, new RegExp(`node "${runtime.CLI_PATH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" ensure`));

  const presentLauncherMessage = runtime.codexReadinessMessage('shim-down', runtime.STABLE_COMMAND_PATH);
  assert.match(presentLauncherMessage, new RegExp(`node "${runtime.STABLE_COMMAND_PATH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" ensure`));
});

test('doctor advises a command that runs when the SessionStart launcher was never written', (t) => {
  const { home, project } = fixture(t);

  const result = runDoctor(home, project, { checks: { shimRunning: true, servingVersionMatches: false, servingVersion: '0.50.16', codexAuth: true, proxyBinary: false, proxyModels: true } });

  assert.doesNotMatch(result.output, new RegExp(path.join(home, '.claude', 'model-gateway', 'model-gateway.js').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), result.output);
  const cliPath = path.join(__dirname, '..', 'bin', 'model-gateway.js');
  assert.match(result.output, new RegExp(`VERSION MISMATCH.*Run node "${cliPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" ensure`));
  assert.ok(fs.existsSync(cliPath), 'the advised fallback command must exist and run');
});

test('doctor keeps advising the stable launcher once SessionStart has written it', (t) => {
  const { home, project } = fixture(t);
  const launcherPath = path.join(home, '.claude', 'model-gateway', 'model-gateway.js');
  fs.mkdirSync(path.dirname(launcherPath), { recursive: true });
  fs.writeFileSync(launcherPath, '// stable launcher fixture\n');

  const result = runDoctor(home, project, { checks: { shimRunning: true, servingVersionMatches: false, servingVersion: '0.50.16', codexAuth: true, proxyBinary: false, proxyModels: true } });

  assert.match(result.output, new RegExp(`VERSION MISMATCH.*Run node "${launcherPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" ensure`), result.output);
});
