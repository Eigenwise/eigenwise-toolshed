import './_temp-cleanup.js';
import './_sidequest-install-fixture.js';
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-dispatch-rederive-home-'));
const PROJECT = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-dispatch-rederive-project-'));
const DISCOVERY = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-dispatch-rederive-catalog-'));
const catalogDir = path.join(DISCOVERY, 'model-gateway');
const catalogPath = path.join(catalogDir, 'catalog.json');
fs.mkdirSync(catalogDir, { recursive: true });

function writeCatalog(models?: any, codexReadiness: any = null) {
  fs.writeFileSync(catalogPath, JSON.stringify({ schemaVersion: 3, source: 'model-gateway', codexReadiness, models }));
}

const READY = {
  ready: true,
  state: 'ready',
  message: 'Codex readiness confirms local binary, /v1/models, authentication, shim, and serving-version checks.',
};

const PROXY_DOWN = {
  ready: false,
  state: 'proxy-down',
  message: 'Codex dispatch refused: claude-code-proxy is not answering on /v1/models. Run `node "gateway" ensure`, then retry. No Anthropic fallback was used.',
};

writeCatalog([]);
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;
process.env.CLAUDE_PROJECT_DIR = PROJECT;
process.env.SIDEQUEST_DISCOVERY_DIRS = DISCOVERY;

const store = require('../lib/store.js');
const slug = store.ensureProject(PROJECT).slug;

store.setCategory({
  id: 'dispatch.rederive',
  name: 'Dispatch rederive',
  route: { model: 'codex-gpt-recovered', effort: 'medium' },
  fallback: { model: 'codex-gpt-fallback', effort: 'medium' },
  enabled: true,
});

test('dead Codex refuses before creating dispatch state', () => {
  writeCatalog([{
    slug: 'codex-gpt-recovered',
    id: 'claude-gpt-recovered',
    label: 'Recovered Codex model',
  }], PROXY_DOWN);
  const ticket = store.createTicket(slug, {
    title: 'Dead Codex route fixture',
    category: 'dispatch.rederive',
    source: 'test',
  });
  const before = store.getTicket(slug, ticket.ref);
  assert.throws(
    () => store.prepareDispatch(slug, ticket.ref, { sessionId: 'dead-codex' }),
    new RegExp(PROXY_DOWN.message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  );
  const after = store.getTicket(slug, ticket.ref);
  assert.equal(after.dispatchNonce, before.dispatchNonce);
  assert.deepEqual(after.dispatch, before.dispatch);
});

test('a Codex route never falls through to a Claude fallback', () => {
  writeCatalog([], READY);
  store.setCategory({
    id: 'dispatch.cross-provider',
    name: 'Cross provider fallback',
    route: { model: 'codex-gpt-missing', effort: 'medium' },
    fallback: { model: 'sonnet', effort: 'high' },
    enabled: true,
  });
  const ticket = store.createTicket(slug, {
    title: 'Cross-provider fallback fixture',
    category: 'dispatch.cross-provider',
    source: 'test',
  });
  const resolved = store.resolveCategoryRoute(store.getCategory('dispatch.cross-provider'));
  assert.equal(resolved.model, 'codex-gpt-missing');
  assert.equal(resolved.exec, null);
  assert.throws(
    () => store.prepareDispatch(slug, ticket.ref, { sessionId: 'cross-provider' }),
    /Codex dispatch refused: configured route codex-gpt-missing is not available/,
  );
  assert.equal(store.getTicket(slug, ticket.ref).dispatchNonce, null);
});

test('same-provider fallback is prepared with its reason and re-derives when the primary returns', () => {
  writeCatalog([{
    slug: 'codex-gpt-fallback',
    id: 'claude-gpt-fallback',
    label: 'Fallback Codex model',
  }], READY);
  const ticket = store.createTicket(slug, {
    title: 'Recovered route fixture',
    category: 'dispatch.rederive',
    source: 'test',
  });

  const degraded = store.prepareDispatch(slug, ticket.ref, { sessionId: 'degraded-roster' });
  assert.deepEqual(degraded.ticket.dispatch.route, { model: 'codex-gpt-fallback', effort: 'medium', marker: 'gpt-fallback' });
  assert.equal(degraded.ticket.dispatch.fallbackReason, 'category fallback replaced unavailable codex-gpt-recovered.');

  writeCatalog([{
    slug: 'codex-gpt-fallback',
    id: 'claude-gpt-fallback',
    label: 'Fallback Codex model',
  }, {
    slug: 'codex-gpt-recovered',
    id: 'claude-gpt-recovered',
    label: 'Recovered Codex model',
  }], READY);

  const recovered = store.prepareDispatch(slug, ticket.ref, { sessionId: 'recovered-roster' });
  assert.notEqual(recovered.token, degraded.token);
  assert.deepEqual(recovered.ticket.dispatch.route, { model: 'codex-gpt-recovered', effort: 'medium', marker: 'gpt-recovered' });
  assert.equal(recovered.ticket.dispatch.fallbackReason, undefined);
  assert.equal(recovered.ticket.dispatchExecutor, 'sidequest-exec-dispatch-medium');
  assert.equal(recovered.ticket.dispatch.supersededTokens.length, 1);
});

export {};
