'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { buildWarning, detectBillingPath, parseAuthStatus } = require('../hooks/billing-path-check.js');

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-billing-path-'));
}

function authStatusResult(status) {
  return { status: 0, stdout: JSON.stringify(status) };
}

test('subscription auth stays silent', () => {
  let calls = 0;
  const output = buildWarning({ session_id: 'session-subscription' }, {
    environment: {},
    spawnSync() {
      calls += 1;
      return authStatusResult({ authMethod: 'claude.ai', subscriptionType: 'max' });
    },
  });
  assert.equal(output, '');
  assert.equal(calls, 1);
});

test('API-key auth warns exactly once when a subscription is configured', (t) => {
  const directory = temporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const calls = [];
  const options = {
    environment: { ANTHROPIC_API_KEY: 'private-credential', PATH: process.env.PATH },
    warningStateDirectory: directory,
    spawnSync(command, args, spawnOptions) {
      calls.push({ command, args, hasApiKey: Object.hasOwn(spawnOptions.env, 'ANTHROPIC_API_KEY') });
      if (spawnOptions.env.ANTHROPIC_API_KEY) {
        return authStatusResult({ authMethod: 'claude.ai', apiKeySource: 'ANTHROPIC_API_KEY', subscriptionType: null });
      }
      return authStatusResult({ authMethod: 'claude.ai', subscriptionType: 'max' });
    },
  };

  const first = buildWarning({ session_id: 'session-leak' }, options);
  const second = buildWarning({ session_id: 'session-leak' }, options);
  assert.match(first, /PAY-PER-TOKEN BILLING ACTIVE/);
  assert.match(first, /Max subscription/);
  assert.doesNotMatch(first, /private-credential/);
  assert.equal(second, '');
  assert.deepEqual(calls.slice(0, 2).map((call) => call.hasApiKey), [true, false]);
  assert.deepEqual(calls[0].args, ['auth', 'status', '--json']);
});

test('API-key auth without a configured subscription stays silent', () => {
  const subscription = detectBillingPath({
    environment: { ANTHROPIC_API_KEY: 'private-credential' },
    spawnSync(command, args, spawnOptions) {
      return authStatusResult(spawnOptions.env.ANTHROPIC_API_KEY
        ? { apiKeySource: 'ANTHROPIC_API_KEY', subscriptionType: null }
        : { subscriptionType: null });
    },
  });
  assert.equal(subscription, null);
});

test('auth status parser keeps mode metadata only', () => {
  assert.deepEqual(parseAuthStatus(JSON.stringify({
    authMethod: 'claude.ai',
    apiKeySource: 'ANTHROPIC_API_KEY',
    subscriptionType: 'max',
    email: 'private@example.test',
    token: 'private-token',
  })), { apiKeyActive: true, subscriptionType: 'max' });
});
