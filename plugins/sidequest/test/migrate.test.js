'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const db = require('../lib/db.js');
const { migrateIfNeeded } = require('../lib/migrate.js');
const store = require('../lib/store.js');

function makeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sq-migrate-test-'));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

function writeLegacyTree(homeRoot) {
  const alphaMeta = { path: 'C:/work/alpha', name: 'Alpha', createdAt: '2026-01-01T00:00:00.000Z', seq: 2, storySeq: 1 };
  const betaMeta = { path: 'C:/work/beta', name: 'Beta', createdAt: '2026-01-02T00:00:00.000Z', seq: 1, storySeq: 0 };
  const todo = { id: 'tk_alpha_todo', ref: 'SQ-1', status: 'todo', order: 10, title: 'Todo ticket' };
  const archived = { id: 'tk_alpha_archived', ref: 'SQ-2', status: 'done', order: 20, archived: true, claim: { by: 'worker-1' }, title: 'Archived ticket' };
  const betaTicket = { id: 'tk_beta_todo', ref: 'SQ-1', status: 'doing', order: 30, title: 'Beta ticket' };
  const story = { id: 'st_alpha', ref: 'US-1', title: 'Alpha story', order: 1 };
  const globals = {
    'model-prefs': { tierBackend: { ['g' + 'rade-1']: 'claude' } },
    notifications: { notifications: [{ id: 'nt_1', message: 'hello' }] },
    'notify-prefs': { enabled: false },
    workers: { sessions: { worker: { state: 'working' } } },
    'server-info': { port: 4711, pid: 1234 },
  };

  writeJson(path.join(homeRoot, 'projects', 'alpha', 'meta.json'), alphaMeta);
  writeJson(path.join(homeRoot, 'projects', 'alpha', 'tickets', 'todo.json'), todo);
  writeJson(path.join(homeRoot, 'projects', 'alpha', 'tickets', 'archived.json'), archived);
  writeJson(path.join(homeRoot, 'projects', 'alpha', 'stories', 'story.json'), story);
  writeJson(path.join(homeRoot, 'projects', 'beta', 'meta.json'), betaMeta);
  writeJson(path.join(homeRoot, 'projects', 'beta', 'tickets', 'todo.json'), betaTicket);
  writeJson(path.join(homeRoot, 'projects', 'model-prefs.json'), globals['model-prefs']);
  writeJson(path.join(homeRoot, 'projects', 'notifications.json'), globals.notifications);
  writeJson(path.join(homeRoot, 'projects', 'notify-prefs.json'), globals['notify-prefs']);
  writeJson(path.join(homeRoot, 'projects', 'workers.json'), globals.workers);
  writeJson(path.join(homeRoot, 'server.json'), globals['server-info']);

  return { alphaMeta, betaMeta, todo, archived, betaTicket, story, globals };
}

function rowCounts(database) {
  return {
    projects: db.listRows(database, 'projects').length,
    tickets: db.listRows(database, 'tickets').length,
    stories: db.listRows(database, 'stories').length,
    globals: db.listRows(database, 'globals').length,
  };
}

test('schema migrations add the project category layer to a v3 database', () => {
  const homeRoot = makeHome();
  const dbPath = path.join(homeRoot, 'sidequest.db');
  const seed = String.raw`
    const { DatabaseSync } = require('node:sqlite');
    const database = new DatabaseSync(${JSON.stringify(dbPath)});
    database.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE categories (id TEXT PRIMARY KEY, data TEXT); INSERT INTO meta VALUES ('schema_version', '3');");
    database.prepare('INSERT INTO categories VALUES (?, ?)').run('fixture', JSON.stringify({ id: 'fixture', name: 'Fixture', route: { model: 'opus', effort: 'high' } }));
    database.close();
  `;
  assert.equal(spawnSync(process.execPath, ['-e', seed], { encoding: 'utf8' }).status, 0);

  const database = db.openDb(homeRoot);
  assert.equal(db.getRow(database, 'meta', 'schema_version'), 5);
  assert.deepEqual(db.getRow(database, 'categories', 'fixture').id, 'fixture');
  assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'project_categories'").get().name, 'project_categories');
  assert.deepEqual(db.listRows(database, 'project_categories', { project: 'missing' }), []);
  database.close();
});
test('migrates a JSON tree into SQLite without deleting its rollback copy', () => {
  const homeRoot = makeHome();
  const expected = writeLegacyTree(homeRoot);
  const database = db.openDb(homeRoot);

  migrateIfNeeded(database, homeRoot);

  assert.deepEqual(db.getRow(database, 'projects', 'alpha'), expected.alphaMeta);
  assert.deepEqual(db.getRow(database, 'projects', 'beta'), expected.betaMeta);
  assert.deepEqual(db.getRow(database, 'tickets', expected.todo.id), expected.todo);
  assert.deepEqual(db.getRow(database, 'tickets', expected.archived.id), expected.archived);
  assert.deepEqual(db.getRow(database, 'tickets', expected.betaTicket.id), expected.betaTicket);
  assert.deepEqual(db.getRow(database, 'stories', expected.story.id), expected.story);
  for (const [key, value] of Object.entries(expected.globals)) {
    assert.deepEqual(db.getRow(database, 'globals', key), value);
  }
  assert.equal(db.getRow(database, 'meta', 'json_migrated'), '1');
  assert.deepEqual(rowCounts(database), { projects: 2, tickets: 3, stories: 1, globals: 6 });
  assert.deepEqual(db.getRow(database, 'globals', 'routing-fallback'), { model: 'sonnet', effort: 'high' });
  const indexedTicket = database.prepare('SELECT archived, claim_by FROM tickets WHERE id = ?').get(expected.archived.id);
  assert.equal(indexedTicket.archived, 1);
  assert.equal(indexedTicket.claim_by, 'worker-1');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(homeRoot, 'projects', 'alpha', 'tickets', 'archived.json'), 'utf8')), expected.archived);

  const counts = rowCounts(database);
  migrateIfNeeded(database, homeRoot);
  assert.deepEqual(rowCounts(database), counts);
  database.close();
});

test('marks an empty home as migrated without adding rows', () => {
  const homeRoot = makeHome();
  const database = db.openDb(homeRoot);

  assert.doesNotThrow(() => migrateIfNeeded(database, homeRoot));
  assert.equal(db.getRow(database, 'meta', 'json_migrated'), '1');
  assert.deepEqual(rowCounts(database), { projects: 0, tickets: 0, stories: 0, globals: 1 });
  assert.deepEqual(db.getRow(database, 'globals', 'routing-fallback'), { model: 'sonnet', effort: 'high' });
  database.close();
});

test('store migration runs before listTickets reads a legacy home', () => {
  const homeRoot = makeHome();
  const expected = writeLegacyTree(homeRoot);
  const priorHome = process.env.SIDEQUEST_HOME;
  process.env.SIDEQUEST_HOME = homeRoot;
  try {
    const tickets = store.listTickets('alpha');
    assert.deepEqual(tickets.map((ticket) => ticket.id).sort(), [expected.todo.id, expected.archived.id].sort());
  } finally {
    if (priorHome === undefined) delete process.env.SIDEQUEST_HOME;
    else process.env.SIDEQUEST_HOME = priorHome;
  }
});
