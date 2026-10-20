'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { gatewayTestEnvironment, startGateway, waitForFixtureProxy } = require('./support.js');

function proxyReadinessFixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-proxy-readiness-'));
  const child = Object.assign(new EventEmitter(), {
    exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough(),
  });
  t.after(() => {
    child.stdout.destroy();
    child.stderr.destroy();
    fs.rmSync(home, { recursive: true, force: true });
  });
  return { home, child };
}

function readinessClock(initial = 0) {
  let time = initial;
  return {
    now: () => time,
    pause: async (milliseconds) => { time += milliseconds; },
    advance: (milliseconds) => { time += milliseconds; },
  };
}

test('fixture proxy readiness waits past five seconds for a live recorded proxy', async (t) => {
  const { child, home } = proxyReadinessFixture(t);
  const clock = readinessClock();
  let probes = 0;
  const pid = await waitForFixtureProxy(child, {
    home, port: 12345, startedAt: 0, ...clock,
    readPid: () => clock.now() >= 5500 ? process.pid : null,
    probe: async () => { probes += 1; return true; },
  });
  assert.equal(pid, process.pid);
  assert.equal(clock.now(), 5500);
  assert.equal(probes, 1);
  assert.equal(child.listenerCount('exit'), 0);
  assert.equal(child.stdout.listenerCount('data'), 0);
});

test('fixture proxy readiness shares its launch deadline with every bounded probe', async (t) => {
  const { child, home } = proxyReadinessFixture(t);
  const clock = readinessClock(14700);
  const budgets = [];
  await assert.rejects(waitForFixtureProxy(child, {
    home, port: 12345, startedAt: 0, ...clock, readPid: () => process.pid,
    probe: async (_port, budget) => { budgets.push(budget); clock.advance(budget); return false; },
  }), /fixture proxy not ready within 15000ms/);
  assert.deepEqual(budgets, [300], 'only the remaining launch budget is available');
  assert.equal(clock.now(), 15000);
});

for (const [label, readPid, isRunning] of [
  ['missing PID', () => null, () => true],
  ['dead PID', () => 12345, () => false],
]) {
  test(`fixture proxy readiness rejects a ${label} without probing HTTP`, async (t) => {
    const { child, home } = proxyReadinessFixture(t);
    const clock = readinessClock();
    await assert.rejects(waitForFixtureProxy(child, {
      home, port: 12345, startedAt: 0, timeout: 100, ...clock, readPid, isRunning,
      probe: async () => { assert.fail('no live recorded PID'); },
    }), /fixture proxy not ready within 100ms/);
    assert.equal(clock.now(), 100);
  });
}

for (const [code, signal] of [[7, null], [null, 'SIGTERM']]) {
  test(`fixture proxy readiness fast-fails on supervisor exit (${code}, ${signal})`, async (t) => {
    const { child, home } = proxyReadinessFixture(t);
    let probeSignal;
    const waiting = waitForFixtureProxy(child, {
      home, port: 12345, startedAt: Date.now(), readPid: () => process.pid,
      probe: async (_port, _timeout, signal) => {
        probeSignal = signal;
        return new Promise((resolve) => signal.addEventListener('abort', () => resolve(false), { once: true }));
      },
    });
    child.stderr.write('supervisor stderr evidence');
    child.emit('exit', code, signal);
    await assert.rejects(waiting, new RegExp(`supervisor exited: code=${code} signal=${signal}[\\s\\S]*supervisor stderr evidence`));
    assert.equal(probeSignal.aborted, true);
    assert.equal(child.listenerCount('exit'), 0);
    assert.equal(child.listenerCount('error'), 0);
  });
}

test('fixture proxy readiness notices an already exited supervisor', async (t) => {
  const { child, home } = proxyReadinessFixture(t);
  child.exitCode = 2;
  await assert.rejects(waitForFixtureProxy(child, {
    home, port: 12345, startedAt: Date.now(), readPid: () => null,
  }), /supervisor exited: code=2 signal=null/);
});

test('fixture proxy readiness reports a spawn error and detaches its observers', async (t) => {
  const { child, home } = proxyReadinessFixture(t);
  const waiting = waitForFixtureProxy(child, { home, port: 12345, startedAt: Date.now(), readPid: () => null });
  child.emit('error', new Error('fixture spawn refused'));
  await assert.rejects(waiting, /fixture spawn refused/);
  assert.equal(child.stdout.listenerCount('data'), 0);
});

async function readinessServer(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return server.address().port;
}

const unavailableModels = [
  ['non-200', (_req, res) => { res.writeHead(503); res.end(); }],
  ['stalled headers', () => {}],
  ['stalled body', (_req, res) => { res.writeHead(200); res.flushHeaders(); }],
  ['aborted body', (_req, res) => { res.writeHead(200); res.flushHeaders(); res.destroy(); }],
];
for (const [label, handler] of unavailableModels) {
  test(`fixture proxy readiness bounds ${label} HTTP probes`, async (t) => {
    const { child, home } = proxyReadinessFixture(t);
    const port = await readinessServer(t, handler);
    const startedAt = Date.now();
    await assert.rejects(waitForFixtureProxy(child, {
      home, port, startedAt, timeout: 200, readPid: () => process.pid,
    }), /fixture proxy not ready within 200ms/);
    assert.ok(Date.now() - startedAt < 3000, 'a stalled endpoint cannot escape the launch deadline');
  });
}

test('fixture proxy readiness bounds a refused connection', async (t) => {
  const { child, home } = proxyReadinessFixture(t);
  const port = await freePort();
  await assert.rejects(waitForFixtureProxy(child, {
    home, port, startedAt: Date.now(), timeout: 200, readPid: () => process.pid,
  }), /fixture proxy not ready within 200ms/);
});

test('fixture proxy readiness accepts a live PID only after the local model response completes', async (t) => {
  const { child, home } = proxyReadinessFixture(t);
  const port = await readinessServer(t, (request, response) => {
    assert.equal(request.url, '/v1/models');
    response.end(JSON.stringify({ data: [] }));
  });
  const pid = await waitForFixtureProxy(child, { home, port, startedAt: Date.now(), readPid: () => process.pid });
  assert.equal(pid, process.pid);
});

test('fixture proxy readiness caps individual probes even with launch time remaining', async (t) => {
  const { child, home } = proxyReadinessFixture(t);
  const clock = readinessClock();
  const budgets = [];
  await assert.rejects(waitForFixtureProxy(child, {
    home, port: 12345, startedAt: 0, timeout: 600, ...clock, readPid: () => process.pid,
    probe: async (_port, budget) => { budgets.push(budget); clock.advance(budget); return false; },
  }), /fixture proxy not ready within 600ms/);
  assert.deepEqual(budgets, [500, 75]);
  assert.equal(clock.now(), 600);
});

test('fixture proxy readiness retains bounded actual diagnostics before fixture removal', async (t) => {
  const { child, home } = proxyReadinessFixture(t);
  const state = path.join(home, '.claude', 'model-gateway');
  const files = ['shim-supervisor-failure.txt', 'logs/lifecycle.jsonl', 'logs/proxy.log', 'logs/shim.log', 'proxy.pid.json'];
  for (const file of files) {
    const target = path.join(state, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `discarded-start-${file}${'x'.repeat(1024 * 1024)}retained-end-${file}`);
  }
  const originalRead = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    assert.equal(String(file).startsWith(state), false, 'diagnostics must not read whole fixture files');
    return originalRead(file, ...args);
  });
  const originalReadBounded = fs.readSync;
  t.mock.method(fs, 'readSync', (fd, buffer, offset, length, position) => {
    assert.ok(length <= 2048, 'every diagnostic file read is bounded');
    return originalReadBounded(fd, buffer, offset, length, position);
  });
  const clock = readinessClock();
  const waiting = waitForFixtureProxy(child, { home, port: 12345, startedAt: 0, timeout: 25, ...clock });
  child.stdout.write(`discarded-stdout${'x'.repeat(10000)}retained-stdout`);
  child.stderr.write(`discarded-stderr${'x'.repeat(10000)}retained-stderr`);
  await assert.rejects(waiting, (error) => {
    fs.rmSync(state, { recursive: true, force: true });
    for (const file of files) assert.ok(error.message.includes(`retained-end-${file}`), file);
    assert.match(error.message, /retained-stdout/);
    assert.match(error.message, /retained-stderr/);
    assert.match(error.message, /proxy.pid[\s\S]*unavailable: ENOENT/);
    assert.doesNotMatch(error.message, /discarded-/);
    assert.ok(error.message.length < 40000);
    return true;
  });
});

function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function startupTimeoutCliPath(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-startup-timeout-'));
  const cliPath = path.join(directory, 'cli.js');
  fs.writeFileSync(cliPath, `
    'use strict';
    if (process.env.STARTUP_TIMEOUT_MODE === 'listener') {
      process.stdout.write(\`listening on 127.0.0.1:\${process.env.STARTUP_TIMEOUT_PORT}\\n\`);
    }
    setInterval(() => {}, 1000);
  `);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return cliPath;
}

test('startGateway reports the startup phase that timed out', async (t) => {
  const cliPath = startupTimeoutCliPath(t);
  const port = await freePort();

  await assert.rejects(
    () => startGateway(t, 'test-shim', gatewayTestEnvironment(t, {
      STARTUP_TIMEOUT_MODE: 'listener',
      STARTUP_TIMEOUT_PORT: String(port),
    }), { cliPath }),
    new RegExp(`listener ${port} did not become healthy within 5000ms`),
  );

  await assert.rejects(
    () => startGateway(t, 'test-shim', gatewayTestEnvironment(t, {
      STARTUP_TIMEOUT_MODE: 'silent',
    }), { cliPath }),
    /test-shim did not report an ephemeral listener within 5000ms/,
  );
});
