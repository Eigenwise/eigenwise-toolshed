'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createProbeCache, cachedGatewayCheck, comparisonAge, MINUTE_MS } = require('../lib/freshness-probe-cache.js');
const { audit, sessionAuditOptions } = require('../hooks/session-start-freshness.js');

function cacheFixture(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'freshness-probes-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { environment: { QUARTERMASTER_STATE_DIR: directory }, now: 1_000_000 };
}

test('empty-state foreground never executes probes and reports gateway checking', (context) => {
  const options = cacheFixture(context);
  const cache = createProbeCache(options);
  assert.deepEqual(fs.readdirSync(options.environment.QUARTERMASTER_STATE_DIR), []);
  const original = childProcess.spawnSync;
  let subprocessCalls = 0;
  childProcess.spawnSync = () => { subprocessCalls += 1; throw new Error('foreground subprocess forbidden'); };
  context.after(() => { childProcess.spawnSync = original; });
  const result = audit({
    ...sessionAuditOptions(cache, options.environment),
    home: options.environment.QUARTERMASTER_STATE_DIR,
    currentProject: '/project',
    registry: { plugins: { 'model-gateway@eigenwise-toolshed': [{ version: '1.0.0', installPath: '/gateway', projectPath: '/project' }] } },
    marketplaces: {}, boards: [], platform: 'win32',
  });
  assert.match(result.projectProblems.map((problem) => problem.text).join('\n'), /gateway: checking \(last known unknown unknown age ago\)/);
  assert.equal(subprocessCalls, 0);
  assert.deepEqual(fs.readdirSync(options.environment.QUARTERMASTER_STATE_DIR), []);
});

test('refreshes gateway only once and reuses fresh observations without executing a probe', (context) => {
  const options = cacheFixture(context);
  const gateway = { installPath: '/gateway' };
  let calls = 0;
  const probe = () => { calls += 1; return { available: true, auth: true, proxy: true, shim: true }; };
  const refreshing = createProbeCache({ ...options, refresh: true });
  cachedGatewayCheck(refreshing, gateway, probe);
  cachedGatewayCheck(refreshing, gateway, probe);
  assert.equal(calls, 1);
  const foreground = createProbeCache({ ...options, now: options.now + 9 * MINUTE_MS });
  assert.equal(cachedGatewayCheck(foreground, gateway, probe).cachedAge, '9m');
  assert.equal(calls, 1);
  cachedGatewayCheck(createProbeCache({ ...options, refresh: true, now: options.now + 10 * MINUTE_MS }), gateway, probe);
  assert.equal(calls, 2);
});

test('stale unhealthy gateway stays nonblocking and shows the previous state and age', (context) => {
  const options = cacheFixture(context);
  const gateway = { installPath: '/gateway' };
  cachedGatewayCheck(createProbeCache({ ...options, refresh: true }), gateway, () => ({ available: false, state: 'timeout' }));
  let result;
  assert.doesNotThrow(() => { result = cachedGatewayCheck(createProbeCache({ ...options, now: options.now + 12 * MINUTE_MS }), gateway, () => { throw new Error('foreground refresh forbidden'); }); });
  assert.equal(result.checking, 'gateway: checking (last known timeout 12m ago)');
});

test('process inventory and version expire at sixty minutes while comparison age is configurable', (context) => {
  const options = cacheFixture(context);
  let calls = 0;
  const probe = () => { calls += 1; return 'observed'; };
  const refresh = (now) => createProbeCache({ ...options, refresh: true, now }).readProbe('process inventory', 'win32', 60 * MINUTE_MS, probe, () => []);
  refresh(options.now);
  refresh(options.now + 59 * MINUTE_MS);
  assert.equal(calls, 1);
  refresh(options.now + 60 * MINUTE_MS);
  assert.equal(calls, 2);
  assert.equal(comparisonAge({}), 6 * 60 * MINUTE_MS);
  assert.equal(comparisonAge({ QUARTERMASTER_FRESHNESS_CACHE_HOURS: '2' }), 2 * 60 * MINUTE_MS);
  assert.equal(comparisonAge({ QUARTERMASTER_FRESHNESS_CACHE_HOURS: '-1' }), 6 * 60 * MINUTE_MS);
});

test('direct audits share one gateway observation across global and project findings', (context) => {
  const options = cacheFixture(context);
  let calls = 0;
  audit({ home: options.environment.QUARTERMASTER_STATE_DIR, currentProject: '/project',
    registry: { plugins: { 'model-gateway@eigenwise-toolshed': [{ installPath: '/gateway', projectPath: '/project' }] } },
    marketplaces: {}, boards: [], versions: {}, platform: 'linux',
    checkGateway: () => { calls += 1; return { available: true }; },
  });
  assert.equal(calls, 1);
});

test('background refresh declares async before populating an empty state directory', (context) => {
  const options = cacheFixture(context);
  const output = childProcess.execFileSync(process.execPath, [path.join(__dirname, '../hooks/session-start-probes.js')], {
    input: '{}', encoding: 'utf8', timeout: 15_000,
    env: { ...process.env, ...options.environment, HOME: options.environment.QUARTERMASTER_STATE_DIR, USERPROFILE: options.environment.QUARTERMASTER_STATE_DIR },
  });
  assert.deepEqual(JSON.parse(output), { async: true, asyncTimeout: 15_000 });
  assert.ok(fs.existsSync(path.join(options.environment.QUARTERMASTER_STATE_DIR, 'freshness-probes.json')));
});
