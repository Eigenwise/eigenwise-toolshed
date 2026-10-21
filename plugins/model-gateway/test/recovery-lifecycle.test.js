'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const test = require('node:test');
const { gatewayTestEnvironment, spawnGatewayProcess } = require('./support.js');
const { writeCommandLauncher } = require('../hooks/registry-writer.js');

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function invoke(testContext, environment, launcher, command, event = 'UserPromptSubmit') {
  return new Promise((resolve, reject) => {
    const child = spawnGatewayProcess(testContext, process.execPath, [launcher, command], {
      cwd: environment.HOME, env: environment, windowsHide: true, timeout: 45000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, output }));
    child.stdin.end(JSON.stringify({ hook_event_name: event, source: 'resume', cwd: environment.HOME }));
  });
}

async function streamedMessage(port) {
  const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-gpt-6-astra', stream: true, max_tokens: 32, messages: [{ role: 'user', content: 'fixture' }] }),
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /recovered fixture stream/);
  assert.match(body, /message_stop/);
}

test('installed gates recover stale boot state once, preserve streaming, recover death and honor persistent stop', { timeout: 150000 }, async (testContext) => {
  const shimPort = await freePort();
  const proxy = http.createServer((request, response) => {
    if (request.url === '/v1/models') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: [{ id: 'gpt-6-astra' }] }));
      return;
    }
    request.resume();
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('event: message_start\ndata: {"type":"message_start","message":{"id":"fixture","type":"message","role":"assistant","model":"gpt-6-astra","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}\n\n');
    setTimeout(() => response.end('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"recovered fixture stream"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n'), 500);
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  testContext.after(() => new Promise((resolve) => proxy.close(resolve)));
  const environment = gatewayTestEnvironment(testContext, {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${shimPort}`, CODEX_GATEWAY_REQUEST_LOG: '0',
  }, { CODEX_GATEWAY_PORT: String(shimPort), CODEX_GATEWAY_PROXY_PORT: String(proxy.address().port) });
  delete environment.CODEX_GATEWAY_WORKER_PORT;
  const state = path.join(environment.HOME, '.claude', 'model-gateway');
  assert.equal(fs.existsSync(state), false, 'recovery fixture starts with an empty gateway state');
  fs.mkdirSync(path.join(state, 'bin'), { recursive: true });
  const binary = path.join(state, 'bin', process.platform === 'win32' ? 'claude-code-proxy.exe' : 'claude-code-proxy');
  fs.copyFileSync(process.execPath, binary);
  fs.chmodSync(binary, 0o700);
  const authentication = path.join(environment.HOME, 'fake-auth.cjs');
  fs.writeFileSync(authentication, "if (require('node:path').basename(process.argv[1] || '') === 'codex') { console.log('fixture account'); process.exit(0); }\n");
  environment.NODE_OPTIONS = `${environment.NODE_OPTIONS || ''} --require=${JSON.stringify(authentication)}`;
  const registry = path.join(environment.HOME, '.claude', 'plugins', 'installed_plugins.json');
  fs.mkdirSync(path.dirname(registry), { recursive: true });
  fs.writeFileSync(registry, JSON.stringify({ plugins: { 'model-gateway@fixture': [{ version: '1.0.0', installPath: path.resolve(__dirname, '..') }] } }));
  const launcher = writeCommandLauncher({ home: environment.HOME }).file;
  fs.writeFileSync(path.join(state, 'guardian.pid'), '2147483647');
  fs.writeFileSync(path.join(state, 'shim-supervisor-failure.txt'), JSON.stringify({ supervisorPid: 2147483647, generation: 'old-boot', message: 'old failure' }));
  const results = await Promise.all([
    invoke(testContext, environment, launcher, 'readiness-gate', 'SessionStart'),
    invoke(testContext, environment, launcher, 'readiness-gate'),
  ]);
  for (const result of results) assert.equal(result.status, 0, result.output);
  const supervisor = fs.readFileSync(path.join(state, 'guardian.pid'), 'utf8');
  assert.notEqual(supervisor.trim(), '2147483647');
  const stream = streamedMessage(shimPort);
  const healthy = await invoke(testContext, environment, launcher, 'readiness-gate');
  assert.equal(healthy.status, 0, healthy.output);
  await stream;
  assert.equal(fs.readFileSync(path.join(state, 'guardian.pid'), 'utf8'), supervisor, `healthy prompt recovery leaves supervisor identity unchanged: ${fs.readFileSync(path.join(state, 'logs', 'lifecycle.jsonl'), 'utf8')}`);
  process.kill(Number(supervisor), 'SIGKILL');
  const recovered = await invoke(testContext, environment, launcher, 'readiness-gate');
  assert.equal(recovered.status, 0, recovered.output);
  assert.notEqual(fs.readFileSync(path.join(state, 'guardian.pid'), 'utf8'), supervisor);
  await streamedMessage(shimPort);
  const stopped = await invoke(testContext, environment, launcher, 'stop');
  assert.equal(stopped.status, 0, stopped.output);
  const refused = await invoke(testContext, environment, launcher, 'readiness-gate');
  assert.equal(refused.status, 2, refused.output);
  assert.match(refused.output, /intentionally stopped/);
  const resumed = await invoke(testContext, environment, launcher, 'start');
  assert.equal(resumed.status, 0, resumed.output);
  await streamedMessage(shimPort);
});
