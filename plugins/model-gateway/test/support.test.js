'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { observeGatewayChildClose, processIsRunning, requireFixtureShutdown } = require('./support.js');

function permissionDenied() {
  throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
}

function processMissing() {
  throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
}

test('fixture shutdown trusts observed close without probing a reused pid', () => {
  const child = Object.assign(new EventEmitter(), { pid: 1234 });
  observeGatewayChildClose(child);
  child.emit('close');
  let probes = 0;
  const isRunning = (pid) => {
    probes += 1;
    return processIsRunning(pid, { kill: permissionDenied, platform: 'linux' });
  };
  assert.doesNotThrow(() => requireFixtureShutdown('fixture-home', {
    children: [child], pids: [child.pid], closed: true,
  }, isRunning));
  assert.equal(probes, 0, 'an observed close must prevent even an EPERM probe');
});

test('fixture shutdown accepts ESRCH for a pid without observed close', () => {
  const isRunning = (pid) => processIsRunning(pid, { kill: processMissing });
  assert.doesNotThrow(() => requireFixtureShutdown('fixture-home', {
    children: [], pids: [1234], closed: true,
  }, isRunning));
});

test('fixture shutdown rejects a running pid without observed close', () => {
  const child = Object.assign(new EventEmitter(), { pid: 1234 });
  observeGatewayChildClose(child);
  const probes = [];
  const isRunning = (pid) => processIsRunning(pid, {
    kill: (probedPid, signal) => probes.push([probedPid, signal]),
  });
  assert.throws(() => requireFixtureShutdown('fixture-home', {
    children: [child], pids: [child.pid], closed: true,
  }, isRunning), { code: 'ERR_GATEWAY_FIXTURE_PROCESS_ALIVE' });
  assert.deepEqual(probes, [[child.pid, 0]]);
});

test('fixture process probe treats Windows EPERM as a foreign pid', () => {
  assert.equal(processIsRunning(1234, { kill: permissionDenied, platform: 'win32' }), false);
});

test('fixture process probe preserves non-Windows EPERM liveness', () => {
  assert.equal(processIsRunning(1234, { kill: permissionDenied, platform: 'linux' }), true);
});

test('fixture process probe treats ESRCH as exited on every platform', () => {
  assert.equal(processIsRunning(1234, { kill: processMissing, platform: 'win32' }), false);
  assert.equal(processIsRunning(1234, { kill: processMissing, platform: 'linux' }), false);
});

test('fixture process probe preserves unexpected errors as possibly running', () => {
  const kill = () => { throw Object.assign(new Error('unexpected'), { code: 'EIO' }); };
  assert.equal(processIsRunning(1234, { kill, platform: 'win32' }), true);
});

test('fixture process probe ignores missing pids', () => {
  assert.equal(processIsRunning(null, { kill: assert.fail }), false);
});
