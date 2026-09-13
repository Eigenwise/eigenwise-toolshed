'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { CONTROL_HEADER, authenticatedControlRequest, controlRequestHeaders, ensureControlToken, readControlToken } = require('../lib/control-auth.js');
const { canReplaceInstalledCliPath } = require('../lib/runtime.js');

const token = 'a'.repeat(64);
const port = 12345;
function request(headers = {}) {
  return { method: 'POST', headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', [CONTROL_HEADER]: token, ...headers } };
}

test('lifecycle requests require a valid token, local host, JSON, and no browser origin', () => {
  assert.equal(authenticatedControlRequest(request(), token, [port]), true);
  for (const headers of [
    { [CONTROL_HEADER]: undefined }, { [CONTROL_HEADER]: 'b'.repeat(64) }, { [CONTROL_HEADER]: 'short' },
    { origin: 'https://fixture.invalid' }, { origin: 'null' }, { host: `fixture.invalid:${port}` },
    { 'content-type': 'text/plain' },
  ]) assert.equal(authenticatedControlRequest(request(headers), token, [port]), false);
  assert.equal(authenticatedControlRequest({ ...request(), method: 'GET' }, token, [port]), false);
  assert.equal(authenticatedControlRequest(request(), token, [port], true), false);
});

test('control token is stable, remains local, and invalid token files fail closed', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-control-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'control-token');
  assert.equal(readControlToken(file), null);
  const generated = ensureControlToken(file);
  assert.match(generated, /^[a-f0-9]{64}$/);
  assert.equal(ensureControlToken(file), generated);
  assert.deepEqual(controlRequestHeaders(file), { [CONTROL_HEADER]: generated });
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.writeFileSync(file, 'invalid');
  assert.throws(() => ensureControlToken(file), /invalid local control token/);
});

function createCli(root, version) {
  const file = path.join(root, version, 'bin', 'model-gateway.js');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '// fixture only\n');
  return file;
}

test('worker replacement stays in the same real cache root and never downgrades', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-path-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const cache = path.join(directory, 'cache', 'marketplace', 'model-gateway');
  const current = createCli(cache, '1.0.0');
  const next = createCli(cache, '1.0.1');
  const old = createCli(cache, '0.9.0');
  const foreign = createCli(path.join(directory, 'foreign'), '99.0.0');
  const development = createCli(path.join(directory, 'checkout'), 'model-gateway');
  assert.equal(canReplaceInstalledCliPath(current, current), true);
  assert.equal(canReplaceInstalledCliPath(current, next), true);
  assert.equal(canReplaceInstalledCliPath(current, old), false);
  assert.equal(canReplaceInstalledCliPath(current, foreign), false);
  assert.equal(canReplaceInstalledCliPath(development, current), false);
  assert.equal(canReplaceInstalledCliPath(current, development), false);
  assert.equal(canReplaceInstalledCliPath(development, development), true);
  assert.equal(canReplaceInstalledCliPath(current, '../99.0.0/bin/model-gateway.js'), false);
  const linkedVersion = path.join(cache, '99.0.0');
  fs.symlinkSync(path.dirname(path.dirname(foreign)), linkedVersion, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(canReplaceInstalledCliPath(current, path.join(linkedVersion, 'bin', 'model-gateway.js')), false);
});
