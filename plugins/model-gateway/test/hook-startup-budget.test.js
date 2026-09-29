'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const gateway = require(path.join(__dirname, '..', 'bin', 'model-gateway.js'));

test('quiet ensure stops waiting inside its hook budget when the proxy never answers', async () => {
  let now = 0;
  const timeout = gateway.startupWaitMsFor(true);
  const result = await gateway.waitForStartupReadiness({
    timeout,
    proxyAnswers: async () => false,
    shimReady: async () => false,
    shimFailureExists: () => false,
    now: () => now,
    pause: async (milliseconds) => { now += milliseconds; },
  });

  assert.equal(timeout, 12000);
  assert.deepEqual(result, { ok: false, timedOut: true });
  assert.equal(now, timeout);

  const hookManifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'hooks', 'hooks.json'), 'utf8'));
  const verifySkill = fs.readFileSync(path.join(__dirname, '..', '.claude', 'skills', 'verify', 'SKILL.md'), 'utf8');
  assert.match(hookManifest.description, /waits up to 12 seconds.*exits 0.*retry.*background/);
  assert.match(verifySkill, /always exits 0.*structured hook notice.*settings mutation/s);
  assert.match(verifySkill, /12-second wait.*asks for a retry.*background/s);
  assert.match(gateway.usage, /remote-control <enable\|disable\|doctor> \[--confirm\]/);
});

test('a current wired shim lets login leave its listener alone', () => {
  const currentHealth = { proxyRecovery: true, supervisorVersion: gateway.PLUGIN_VERSION };

  assert.match(gateway.loginSuccessMessage({ wired: true, health: currentHealth }), /next request/);
  assert.doesNotMatch(gateway.loginSuccessMessage({ wired: true, health: currentHealth }), /setup/);
  assert.match(gateway.loginSuccessMessage({ wired: false, health: currentHealth }), /setup/);
});
