'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function freshStore(options) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-category-test-'));
  const discovery = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-category-discovery-'));
  if (options && options.catalog) {
    const dir = path.join(discovery, 'codex-gateway');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify({ schema: 2, source: 'codex-gateway', models: options.catalog }));
  }
  process.env.SIDEQUEST_HOME = home;
  process.env.SIDEQUEST_DISCOVERY_DIRS = discovery;
  const storePath = require.resolve('../lib/store.js');
  delete require.cache[storePath];
  const store = require('../lib/store.js');
  const slug = store.ensureProject(path.join(home, 'project'), 'Category test').slug;
  return { store, slug, home };
}

test('defaults seed once without overwriting, recreating, or disabling general', () => {
  const { store } = freshStore();
  assert.equal(store.getCategories().length, 14);
  store.setCategory('coding.normal', { name: 'User owned', route: { model: 'grade-1', effort: 'low' } });
  store.removeCategory('mechanical');
  assert.throws(() => store.removeCategory('general'), /cannot be removed/);
  assert.throws(() => store.setCategory('general', { enabled: false }), /cannot be disabled/);

  assert.equal(store.getCategory('coding.normal').name, 'User owned');
  assert.equal(store.getCategory('mechanical'), null);
  assert.equal(store.getCategory('general').enabled, true);
});

test('category takes precedence over complexity and list reads expose taxonomy', () => {
  const { store, slug } = freshStore();
  const created = store.createTicket(slug, { title: 'category route', category: 'mechanical', complexity: 10, complexityWhy: 'legacy score remains' });
  const ticket = store.getTicket(slug, created.ref);

  assert.equal(ticket.model, 'grade-1');
  assert.equal(ticket.effort, 'medium');
  assert.equal(ticket.category.id, 'mechanical');
  assert.equal(ticket.category.fallback, false);
  assert.equal(store.listPayload(slug).categories.length, 14);
  assert.equal(store.readyPayload(slug).categories.length, 14);
  assert.equal(store.listPayload(slug, { brief: true }).tickets[0].categoryName, 'Mechanical change');
});

test('unknown and disabled category ids fall back to general without rewriting the ticket', () => {
  const { store, slug } = freshStore();
  store.setCategory('testing', { enabled: false });
  for (const id of ['missing-id', 'testing']) {
    const created = store.createTicket(slug, { title: id, category: id });
    const ticket = store.getTicket(slug, created.ref);
    assert.equal(ticket.category.id, 'general');
    assert.equal(ticket.category.fallback, true);
    assert.equal(ticket.categoryId, id);
    assert.match(ticket.warnings[0], new RegExp(id));
  }
  store.setCategory('testing', { enabled: true });
  assert.equal(store.getTicket(slug, 'SQ-2').category.id, 'testing');
});

test('explicit backend category routes use discovered runtime and degrade when it disappears', () => {
  const catalog = [{ slug: 'codex-gpt-test', id: 'gpt-test', label: 'GPT Test', suggestedTier: 'grade-3' }];
  const { store, slug } = freshStore({ catalog });
  store.setCategory({ id: 'backend-pin', name: 'Backend pin', description: 'fixture', route: { model: 'codex-gpt-test', effort: 'high' }, contract: 'fixture', enabled: true });
  const created = store.createTicket(slug, { title: 'backend', category: 'backend-pin' });
  let ticket = store.getTicket(slug, created.ref);
  assert.equal(ticket.model, 'grade-3');
  assert.equal(ticket.exec.backend, 'codex');
  assert.equal(ticket.exec.runsModel, 'codex-gpt-test');

  process.env.SIDEQUEST_DISCOVERY_DIRS = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-category-empty-'));
  ticket = store.getTicket(slug, created.ref);
  assert.equal(ticket.model, 'grade-2');
  assert.equal(ticket.exec.backend, 'claude');
  assert.match(ticket.warnings[0], /isn't currently available/);
});

test('opening an existing schema v1 database migrates to v2 and preserves markers', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-category-v1-'));
  const dbPath = path.join(home, 'sidequest.db');
  const seed = String.raw`
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(${JSON.stringify(dbPath)});
    db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); INSERT INTO meta VALUES ('schema_version', '1'); INSERT INTO meta VALUES ('json_migrated', '\"done\"');");
    db.close();
  `;
  const seeded = spawnSync(process.execPath, ['-e', seed], { encoding: 'utf8' });
  assert.equal(seeded.status, 0, seeded.stderr);

  const { openDb, getRow, listRows } = require('../lib/db.js');
  const db = openDb(home);
  assert.equal(getRow(db, 'meta', 'schema_version'), 2);
  assert.equal(getRow(db, 'meta', 'json_migrated'), 'done');
  assert.equal(listRows(db, 'categories').length, 14);
  db.close();
});
