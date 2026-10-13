import './_temp-cleanup.js';
import './_sidequest-install-fixture.js';
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// SQ-3559: a Codex dispatch prepared while the gateway was ready briefed its executor Sol·xhigh, then the
// provider dropped out of the live catalog for a moment and the claim was refused as effort_mismatch
// sonnet·high, the category fallback. A prepared attempt's route is immutable; provider health only picks
// the route for a NEW dispatch.
const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-prepared-route-home-'));
const PROJECT = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-prepared-route-project-'));
const DISCOVERY = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-prepared-route-catalog-'));
const catalogPath = path.join(DISCOVERY, 'model-gateway', 'catalog.json');
fs.mkdirSync(path.dirname(catalogPath), { recursive: true });

function writeCatalog(ready: boolean) {
  fs.writeFileSync(catalogPath, JSON.stringify({
    schemaVersion: 3,
    updatedAt: new Date().toISOString(),
    source: 'model-gateway',
    codexReadiness: ready
      ? { ready: true, state: 'ready', message: 'Codex readiness confirms the local gateway is ready.' }
      : { ready: false, state: 'unauthenticated', message: 'Codex sign-in is missing.' },
    models: [{ slug: 'codex-gpt-6-1-sol', id: 'claude-gpt-6.1-sol[1m]', label: 'GPT-6.1 Sol' }],
  }));
}

writeCatalog(true);
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;
process.env.CLAUDE_PROJECT_DIR = PROJECT;
process.env.SIDEQUEST_DISCOVERY_DIRS = DISCOVERY;

const store = require('../lib/store.js');
const slug = store.ensureProject(PROJECT).slug;

store.setCategory({
  id: 'prepared.codex',
  name: 'Prepared Codex route',
  route: { model: 'codex-gpt-6-1-sol', effort: 'xhigh' },
  fallback: { model: 'sonnet', effort: 'high' },
  enabled: true,
});

function seed() {
  return store.createTicket(slug, {
    title: 'prepared route fixture',
    description: 'Where: prepared route fixture. Contract: claim against the prepared route. Verify: inspect the claim.',
    category: 'prepared.codex',
    source: 'test',
  }).ref;
}

function prepareWhileReady() {
  writeCatalog(true);
  const ref = seed();
  const prepared = store.prepareDispatch(slug, ref, { allowUnscoped: true });
  assert.equal(prepared.ticket.effort, 'xhigh');
  return { ref, token: prepared.token, executor: prepared.ticket.dispatch.executor };
}

test.afterEach(() => writeCatalog(true));

test('a prepared Codex route survives a provider readiness drop and admits its briefed claim', () => {
  const { ref, token, executor } = prepareWhileReady();
  writeCatalog(false);
  const projected = store.getTicket(slug, ref);
  assert.equal(projected.model, 'codex-gpt-6-1-sol');
  assert.equal(projected.effort, 'xhigh');
  const claimed = store.claimTicket(slug, ref, 'prepared-route', { token, executor, effort: 'xhigh' });
  assert.equal(claimed.ok, true, JSON.stringify({ reason: claimed.reason, message: claimed.message }));
});

test('a healthy prepared Codex route admits its briefed claim', () => {
  const { ref, token, executor } = prepareWhileReady();
  assert.equal(store.claimTicket(slug, ref, 'healthy-route', { token, executor, effort: 'xhigh' }).ok, true);
});

test('a readiness drop does not relax the token check', () => {
  const { ref, executor } = prepareWhileReady();
  writeCatalog(false);
  const refused = store.claimTicket(slug, ref, 'wrong-token', { token: 'not-the-token', executor, effort: 'xhigh' });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'token');
});

test('a readiness drop does not relax the prepared executor check', () => {
  const { ref, token } = prepareWhileReady();
  writeCatalog(false);
  const refused = store.claimTicket(slug, ref, 'wrong-executor', { token, executor: 'sidequest-exec-high', effort: 'xhigh' });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'executor_mismatch');
});

test('a claim at the fallback effort is still a mismatch against the prepared route', () => {
  const { ref, token, executor } = prepareWhileReady();
  writeCatalog(false);
  const refused = store.claimTicket(slug, ref, 'fallback-effort', { token, executor, effort: 'high' });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'effort_mismatch');
  assert.equal(refused.derivedEffort, 'xhigh');
  assert.equal(refused.claimedEffort, 'high');
});

test('a new dispatch while the provider is down still takes the category fallback', () => {
  writeCatalog(false);
  const ref = seed();
  const unprepared = store.getTicket(slug, ref);
  assert.equal(unprepared.model, 'sonnet');
  assert.equal(unprepared.effort, 'high');
  const prepared = store.prepareDispatch(slug, ref, { allowUnscoped: true });
  assert.equal(prepared.ticket.model, 'sonnet');
  assert.equal(prepared.ticket.effort, 'high');
  const claimed = store.claimTicket(slug, ref, 'fallback-dispatch', { token: prepared.token, executor: prepared.ticket.dispatch.executor, effort: 'high' });
  assert.equal(claimed.ok, true, JSON.stringify({ reason: claimed.reason, message: claimed.message }));
});
