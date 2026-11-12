'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { gatewayTestEnvironment } = require('./support.js');

test('AGY fixtures discard inherited native config/auth/proxy roots and preserve explicit isolated overrides', (t) => {
  const values = { CCP_CONFIG_DIR: '/private-native', CCP_ANTIGRAVITY_ENABLED: 'true', CCP_ANTIGRAVITY_CLIENT_SECRET: 'private-secret',
    XDG_CONFIG_HOME: '/private-xdg', XDG_STATE_HOME: '/private-state', XDG_CACHE_HOME: '/private-cache',
    XDG_DATA_HOME: '/private-data', XDG_RUNTIME_DIR: '/private-runtime', MODEL_GATEWAY_CLAUDE_HOME: '/private-claude' };
  const before = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const environment = gatewayTestEnvironment(t, { ...process.env });
  assert.equal(environment.CCP_ANTIGRAVITY_ENABLED, undefined);
  assert.equal(environment.CCP_ANTIGRAVITY_CLIENT_SECRET, undefined);
  assert.equal(environment.CCP_CONFIG_DIR, path.join(environment.HOME, '.config', 'claude-code-proxy'));
  for (const key of ['XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR', 'MODEL_GATEWAY_CLAUDE_HOME']) assert.ok(environment[key].startsWith(environment.HOME + path.sep), key);
  const isolated = gatewayTestEnvironment(t, {}, { CCP_CONFIG_DIR: '/fixture-only', CCP_ANTIGRAVITY_ENABLED: 'false' });
  assert.equal(isolated.CCP_CONFIG_DIR, '/fixture-only');
  assert.equal(isolated.CCP_ANTIGRAVITY_ENABLED, 'false');
});
