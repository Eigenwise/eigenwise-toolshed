'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { gatewayTestEnvironment, startGateway } = require('./support.js');

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
