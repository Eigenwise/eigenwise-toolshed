'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const CLI = path.join(__dirname, '..', 'bin', 'model-gateway.js');
const START_TIMEOUT_MS = 5000;

function waitForHealth(port) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const request = http.get({ host: '127.0.0.1', port, path: '/healthz' }, (response) => {
        response.resume();
        if (response.statusCode === 200) return resolve();
        retry();
      });
      request.once('error', retry);
    };
    const retry = () => {
      if (Date.now() >= deadline) return reject(new Error(`listener ${port} did not become healthy within ${START_TIMEOUT_MS}ms`));
      setTimeout(attempt, 25);
    };
    attempt();
  });
}

function startGateway(t, command, environment) {
  const home = environment.HOME || fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-test-'));
  const ownsHome = !environment.HOME;
  const socketPath = environment.CODEX_GATEWAY_SOCKET_PATH || path.join(home, 'anthropic.sock');
  if (ownsHome) t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, command], {
      env: {
        ...process.env,
        ...environment,
        HOME: home,
        USERPROFILE: home,
        CODEX_GATEWAY_SOCKET_PATH: socketPath,
        CODEX_GATEWAY_PORT: '0',
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

module.exports = { startGateway };
