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

function invoke(testContext, environment, launcher, command, event = 'UserPromptSubmit', commandArguments = []) {
  return new Promise((resolve, reject) => {
    const child = spawnGatewayProcess(testContext, process.execPath, [launcher, command, ...commandArguments], {
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

async function waitForProcessDeath(pid) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`fixture process ${pid} did not exit after SIGKILL`);
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

function installSetupDownloadFixture(environment) {
  const preload = path.join(environment.HOME, 'setup-download.cjs');
  fs.writeFileSync(preload, `
    if (process.argv.includes('setup')) {
      const fs = require('node:fs');
      const path = require('node:path');
      const children = require('node:child_process');
      const spawnSync = children.spawnSync;
      children.spawnSync = (command, arguments_, options) => {
        if (arguments_[0] !== '-xf') return spawnSync(command, arguments_, options);
        fs.copyFileSync(process.execPath, path.join(options.cwd, ${JSON.stringify(process.platform === 'win32' ? 'claude-code-proxy.exe' : 'claude-code-proxy')}));
        return { status: 0 };
      };
      const supervision = require(${JSON.stringify(require.resolve('../lib/process-supervision.js'))});
      const fetchUrl = supervision.fetchUrl;
      supervision.fetchUrl = async (url, options) => url.startsWith('https://api.github.com/') ? { status: 200, body: Buffer.from('{}') } : fetchUrl(url, options);
      require(${JSON.stringify(require.resolve('../lib/release-verification.js'))}).downloadVerifiedArchive = async () => Buffer.from('fixture archive');
      const writeFile = fs.writeFileSync;
      fs.writeFileSync = (file, ...arguments_) => {
        if (path.basename(String(file)) === 'guardian.pid') {
          require('node:assert/strict').equal(fs.existsSync(path.join(path.dirname(file), 'intentionally-stopped.json')), true, 'real supervisor spawn preserves stop until guardian record');
        }
        return writeFile(file, ...arguments_);
      };
    }
  `);
  environment.NODE_OPTIONS = `${environment.NODE_OPTIONS || ''} --require=${JSON.stringify(preload)}`;
}

test('installed prompt gate leaves a foreign listener untouched and reports local recovery', { timeout: 45000 }, async (testContext) => {
  const foreign = http.createServer((request, response) => response.end('foreign fixture'));
  await new Promise((resolve) => foreign.listen(0, '127.0.0.1', resolve));
  testContext.after(() => new Promise((resolve) => foreign.close(resolve)));
  const port = foreign.address().port;
  const environment = gatewayTestEnvironment(testContext, { ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` }, {
    CODEX_GATEWAY_PORT: String(port), CODEX_GATEWAY_PROXY_PORT: String(await freePort()),
  });
  delete environment.CODEX_GATEWAY_WORKER_PORT;
  const state = path.join(environment.HOME, '.claude', 'model-gateway');
  fs.mkdirSync(path.join(state, 'bin'), { recursive: true });
  fs.copyFileSync(process.execPath, path.join(state, 'bin', process.platform === 'win32' ? 'claude-code-proxy.exe' : 'claude-code-proxy'));
  const registry = path.join(environment.HOME, '.claude', 'plugins', 'installed_plugins.json');
  fs.mkdirSync(path.dirname(registry), { recursive: true });
  fs.writeFileSync(registry, JSON.stringify({ plugins: { 'model-gateway@fixture': [{ version: '1.0.0', installPath: path.resolve(__dirname, '..') }] } }));
  const launcher = writeCommandLauncher({ home: environment.HOME }).file;
  const refused = await invoke(testContext, environment, launcher, 'readiness-gate');
  assert.equal(refused.status, 2, refused.output);
  assert.match(refused.output, /could not confirm the owner.*left the listener untouched/s);
  assert.match(refused.output, /doctor.*resubmit/s);
  assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'foreign fixture');
  assert.equal(fs.existsSync(path.join(state, 'guardian.pid')), false);
});

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
  await waitForProcessDeath(Number(supervisor));
  const recovered = await invoke(testContext, environment, launcher, 'readiness-gate');
  assert.equal(recovered.status, 0, recovered.output);
  assert.notEqual(fs.readFileSync(path.join(state, 'guardian.pid'), 'utf8'), supervisor);
  await streamedMessage(shimPort);
  const blockedFile = path.join(state, 'codex-upstream-blocked.json');
  fs.writeFileSync(blockedFile, JSON.stringify({ state: 'upstream-blocked', observedAt: new Date().toISOString(), statusCode: 401, evidence: 'fixture expired login' }));
  const authLatched = await invoke(testContext, environment, launcher, 'readiness-gate');
  assert.equal(authLatched.status, 0, `auth-latched Codex never blocks a healthy router prompt: ${authLatched.output}`);
  assert.equal(JSON.parse(fs.readFileSync(blockedFile, 'utf8')).statusCode, 401, 'gate leaves the per-request auth latch intact');
  fs.unlinkSync(blockedFile);
  await streamedMessage(shimPort);
  fs.writeFileSync(authentication, "if (require('node:path').basename(process.argv[1] || '') === 'codex') { console.error('fixture login required'); process.exit(1); }\n");
  const unauthenticated = await invoke(testContext, environment, launcher, 'readiness-gate');
  assert.equal(unauthenticated.status, 0, unauthenticated.output);
  fs.writeFileSync(authentication, "if (require('node:path').basename(process.argv[1] || '') === 'codex') { console.log('fixture account'); process.exit(0); }\n");
  const unavailableFile = path.join(state, 'codex-upstream-unavailable.json');
  fs.writeFileSync(unavailableFile, JSON.stringify({ state: 'upstream-unavailable', observedAtMs: Date.now(), statusCode: 503 }));
  const unavailable = await invoke(testContext, environment, launcher, 'readiness-gate');
  assert.equal(unavailable.status, 0, unavailable.output);
  assert.equal(JSON.parse(fs.readFileSync(unavailableFile, 'utf8')).statusCode, 503, 'gate preserves the recent upstream failure for per-request handling');
  fs.unlinkSync(unavailableFile);
  const stopped = await invoke(testContext, environment, launcher, 'stop');
  assert.equal(stopped.status, 0, stopped.output);
  const refused = await invoke(testContext, environment, launcher, 'readiness-gate');
  assert.equal(refused.status, 2, refused.output);
  assert.match(refused.output, /intentionally stopped/);
  installSetupDownloadFixture(environment);
  fs.writeFileSync(authentication, "if (require('node:path').basename(process.argv[1] || '') === 'codex') { process.exit(1); }\n");
  const maintenance = await invoke(testContext, environment, launcher, 'setup', 'UserPromptSubmit', ['--preserve-wiring']);
  assert.equal(maintenance.status, 0, maintenance.output);
  assert.equal(fs.existsSync(path.join(state, 'intentionally-stopped.json')), true, 'maintenance setup retains stop');
  assert.equal(fs.existsSync(path.join(state, 'guardian.pid')), false, 'maintenance setup creates no supervisor');
  const resumed = await invoke(testContext, environment, launcher, 'setup');
  assert.equal(resumed.status, 0, resumed.output);
  assert.equal(fs.existsSync(path.join(state, 'intentionally-stopped.json')), false, 'explicit setup resumes after real guardian record');
  assert.equal(fs.existsSync(path.join(state, 'guardian.pid')), true);
  await streamedMessage(shimPort);
  const runningSetup = await invoke(testContext, environment, launcher, 'setup');
  assert.equal(runningSetup.status, 0, runningSetup.output);
  assert.match(runningSetup.output, /restarting shim without dropping its listener/);
  await streamedMessage(shimPort);
});
