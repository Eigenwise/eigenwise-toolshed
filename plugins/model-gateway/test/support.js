'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const CLI = path.join(__dirname, '..', 'bin', 'model-gateway.js');
const START_TIMEOUT_MS = 5000;

function waitForHealth(port) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const retry = () => {
      if (settled || timer) return;
      if (Date.now() >= deadline) {
        return finish(new Error(`listener ${port} did not become healthy within ${START_TIMEOUT_MS}ms`));
      }
      timer = setTimeout(() => {
        timer = null;
        attempt();
      }, 25);
    };
    const attempt = () => {
      if (settled) return;
      const request = http.get({ host: '127.0.0.1', port, path: '/healthz' }, (response) => {
        response.resume();
        response.once('end', () => {
          if (response.statusCode === 200) finish();
          else retry();
        });
      });
      request.once('error', retry);
    };
    attempt();
  });
}

function startGateway(t, command, environment, { cliPath = CLI } = {}) {
  const home = environment.HOME || fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-test-'));
  const ownsHome = !environment.HOME;
  const socketPath = environment.CODEX_GATEWAY_SOCKET_PATH || path.join(home, 'anthropic.sock');
  if (ownsHome) t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, command], {
      env: {
        ...process.env,
        ...environment,
        HOME: home,
        USERPROFILE: home,
        CODEX_GATEWAY_SOCKET_PATH: socketPath,
        CODEX_GATEWAY_PORT: environment.CODEX_GATEWAY_PORT || '0',
        CODEX_GATEWAY_WORKER_PORT: environment.CODEX_GATEWAY_WORKER_PORT || '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let listening = false;
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} did not report an ephemeral listener within ${START_TIMEOUT_MS}ms: ${output}`));
    }, START_TIMEOUT_MS);
    const settle = (callback) => {
      clearTimeout(timeout);
      callback();
    };
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/listening on 127\.0\.0\.1:(\d+)/);
      if (!match || listening) return;
      listening = true;
      const port = Number(match[1]);
      waitForHealth(port).then(
        () => settle(() => resolve({ child, port })),
        (error) => settle(() => reject(new Error(`${error.message}: ${output}`))),
      );
    });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('error', (error) => settle(() => reject(error)));
    child.once('exit', (code, signal) => settle(() => reject(new Error(`${command} exited before listening (${code ?? signal}): ${output}`))));
    t.after(() => new Promise((done) => {
      if (child.exitCode != null) return done();
      child.once('exit', done);
      child.kill();
    }));
  });
}

function proxyTarget(requestLine) {
  const connect = requestLine.match(/^CONNECT\s+([^\s]+)\s+HTTP\/\d\.\d$/i);
  if (connect) return connect[1];
  const absoluteUri = requestLine.match(/^[A-Z]+\s+(https?:\/\/[^\s/]+)(?:\/[^\s]*)?\s+HTTP\/\d\.\d$/i);
  if (!absoluteUri) return requestLine;
  const target = new URL(absoluteUri[1]);
  return `${target.hostname}:${target.port || (target.protocol === 'https:' ? '443' : '80')}`;
}

async function startCountingProxy(t) {
  let connectionCount = 0;
  const targets = [];
  const proxy = net.createServer((socket) => {
    connectionCount += 1;
    socket.once('data', (data) => {
      targets.push(proxyTarget(data.toString('latin1').split(/\r?\n/, 1)[0]));
      socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    });
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const { port } = proxy.address();
  t.after(() => new Promise((resolve) => proxy.close(resolve)));
  return { url: `http://127.0.0.1:${port}`, connectionCount: () => connectionCount, targets: () => [...targets] };
}

module.exports = { startCountingProxy, startGateway };
