'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { once } = require('node:events');
const { writeCommandLauncher } = require('../hooks/registry-writer.js');
const install = path.resolve(__dirname, '..');
const version = require('../.claude-plugin/plugin.json').version;

async function gateFixture(context) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-fast-path-'));
  const state = path.join(home, '.claude', 'model-gateway');
  fs.mkdirSync(state, { recursive: true });
  context.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const server = http.createServer((request, response) => response.end(JSON.stringify(server.health)));
  server.health = { ok: true, supervisorPid: process.pid, supervisorVersion: version, proxyRecovery: true, codexAuthenticated: false };
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => server.close());
  fs.writeFileSync(path.join(state, 'guardian.pid'), String(process.pid));
  fs.writeFileSync(path.join(state, 'guardian.pid.json'), JSON.stringify({ pid: process.pid, command: `node "${path.join(install, 'bin', 'model-gateway.js')}" serve-shim` }));
  const registry = path.join(home, '.claude', 'plugins', 'installed_plugins.json');
  fs.mkdirSync(path.dirname(registry), { recursive: true });
  fs.writeFileSync(registry, JSON.stringify({ plugins: { 'model-gateway@test': [{ version, installPath: install }] } }));
  const launcher = writeCommandLauncher({ home }).file;
  const preload = path.join(home, 'observe-cli.js');
  fs.writeFileSync(preload, `
    const Module = require('node:module');
    const load = Module._load;
    Module._load = function(request, parent, main) {
      if (request.endsWith('/commands.js') || request === './commands.js') {
        console.error('RECOVERY_CLI_LOADED');
        if (parent.filename.endsWith('readiness-gate.js')) return { recoverGateway: async () => { throw new Error('fixture recovery refusal'); } };
      }
      return load.call(this, request, parent, main);
    };
  `);
  return { home, state, server, launcher, preload };
}

async function invoke(fixture, event) {
  const port = fixture.server.address().port;
  const started = performance.now();
  const child = spawn(process.execPath, [fixture.launcher, 'readiness-gate'], {
    cwd: fixture.home, windowsHide: true,
    env: { ...process.env, HOME: fixture.home, USERPROFILE: fixture.home,
      MODEL_GATEWAY_CLAUDE_HOME: path.join(fixture.home, '.claude'),
      CODEX_GATEWAY_PORT: String(port), ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
      NODE_OPTIONS: `--require=${JSON.stringify(fixture.preload.replaceAll('\\', '/'))}` },
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.end(JSON.stringify({ hook_event_name: event, cwd: fixture.home }));
  const [status] = await once(child, 'exit');
  return { status, stderr, milliseconds: Math.round(performance.now() - started) };
}

test('healthy installed gate skips commands.js for both hook payloads without Codex auth', async (context) => {
  const fixture = await gateFixture(context);
  for (const event of ['UserPromptSubmit', 'SessionStart']) {
    const result = await invoke(fixture, event);
    context.diagnostic(`${event}: ${result.milliseconds} ms (informational)`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '', 'commands.js was never loaded');
  }
});

const fallbackScenarios = [
  ['unhealthy', { ok: false }],
  ['outdated', { supervisorVersion: '0.0.0' }],
  ['newer preserves quiet reload notice', { supervisorVersion: '99.0.0' }],
  ['missing proxy recovery', { proxyRecovery: false }],
  ['different supervisor', { supervisorPid: -1 }],
];
for (const [name, health] of fallbackScenarios) {
  test(`installed gate falls through to recovery: ${name}`, async (context) => {
    const fixture = await gateFixture(context);
    Object.assign(fixture.server.health, health);
    const result = await invoke(fixture, 'UserPromptSubmit');
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /RECOVERY_CLI_LOADED/);
    assert.match(result.stderr, /fixture recovery refusal/);
  });
}

test('intentional stop and foreign PID record fall through even with healthy HTTP', async (context) => {
  const fixture = await gateFixture(context);
  fs.writeFileSync(path.join(fixture.state, 'intentionally-stopped.json'), '{}');
  const stopped = await invoke(fixture, 'SessionStart');
  assert.equal(stopped.status, 1, stopped.stderr);
  assert.match(stopped.stderr, /RECOVERY_CLI_LOADED/);
  fs.rmSync(path.join(fixture.state, 'intentionally-stopped.json'));
  fs.writeFileSync(path.join(fixture.state, 'guardian.pid.json'), JSON.stringify({ pid: process.pid, command: 'node /foreign/bin/model-gateway.js serve-shim' }));
  const foreign = await invoke(fixture, 'UserPromptSubmit');
  assert.equal(foreign.status, 2, foreign.stderr);
  assert.match(foreign.stderr, /RECOVERY_CLI_LOADED/);
});
