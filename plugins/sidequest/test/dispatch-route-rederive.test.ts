'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-dispatch-rederive-home-'));
const PROJECT = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-dispatch-rederive-project-'));
const DISCOVERY = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-dispatch-rederive-catalog-'));
const catalogDir = path.join(DISCOVERY, 'codex-gateway');
const catalogPath = path.join(catalogDir, 'catalog.json');
fs.mkdirSync(catalogDir, { recursive: true });

function writeCatalog(models?: any) {
  fs.writeFileSync(catalogPath, JSON.stringify({ schemaVersion: 3, source: 'codex-gateway', models }));
}

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
  fallback: { model: 'opus', effort: 'medium' },
  enabled: true,
});

test('re-dispatch re-derives an unlaunched prepared route after model availability recovers', () => {
  const ticket = store.createTicket(slug, {
    title: 'Recovered route fixture',
    category: 'dispatch.rederive',
    source: 'test',
  });

  const degraded = store.prepareDispatch(slug, ticket.ref, { sessionId: 'degraded-roster' });
  assert.deepEqual(degraded.ticket.dispatch.route, { model: 'opus', effort: 'medium' });

  writeCatalog([{
    slug: 'codex-gpt-recovered',
    id: 'claude-codex-gpt-recovered',
    label: 'Recovered Codex model',
  }]);

  const recovered = store.prepareDispatch(slug, ticket.ref, { sessionId: 'recovered-roster' });
  assert.notEqual(recovered.token, degraded.token);
  assert.deepEqual(recovered.ticket.dispatch.route, { model: 'codex-gpt-recovered', effort: 'medium' });
  assert.equal(recovered.ticket.dispatchExecutor, 'sidequest-exec-dispatch-medium');
  assert.equal(recovered.ticket.dispatch.supersededTokens.length, 1);
});

export {};
