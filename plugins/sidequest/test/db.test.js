'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { openDb, getRow, putRow, deleteRow, listRows, txn } = require('../lib/db.js');
const { DEFAULT_CATEGORIES } = require('../lib/category-defaults.js');

const CODEBASE_EXPLORATION = DEFAULT_CATEGORIES.find((category) => category.id === 'codebase-exploration');
const OLD_CODEBASE_EXPLORATION = {
  description: CODEBASE_EXPLORATION.description,
  contract: 'Read before concluding; cite files and symbols, with no edits.',
};

function makeDb() {
  const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-db-test-'));
  const db = openDb(homeRoot);
  return { db, homeRoot };
}

function reopenFromSchemaV4(homeRoot, db) {
  db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(JSON.stringify(4));
  db.close();
  return openDb(homeRoot);
}

function ticket(id, project, status, ord) {
  return {
    id,
    project,
    ref: `SQ-${id}`,
    status,
    archived: 0,
    ord,
    claim_by: null,
    data: { id, project, status, title: `${status} ticket` },
  };
}

test('schema v5 stores project category rows by project and id', () => {
  const { db } = makeDb();
  putRow(db, 'project_categories', { project: 'one', id: 'local', kind: 'ADD', data: { id: 'local' } });
  putRow(db, 'project_categories', { project: 'two', id: 'local', kind: 'ADD', data: { id: 'local', name: 'Other' } });

  assert.deepStrictEqual(getRow(db, 'project_categories', { project: 'one', id: 'local' }), { id: 'local' });
  assert.deepStrictEqual(listRows(db, 'project_categories', { project: 'two' }), [{ id: 'local', name: 'Other' }]);
  assert.strictEqual(deleteRow(db, 'project_categories', { project: 'one', id: 'local' }), true);
  assert.strictEqual(getRow(db, 'project_categories', { project: 'one', id: 'local' }), null);
  db.close();
});

test('fresh databases seed the artifact-aware codebase exploration contract', () => {
  const { db } = makeDb();
  assert.strictEqual(getRow(db, 'categories', 'codebase-exploration').contract, CODEBASE_EXPLORATION.contract);
  db.close();
});

test('schema v5 migrates the shipped codebase exploration row without changing project copies', () => {
  const { db, homeRoot } = makeDb();
  const oldGlobal = Object.assign({}, getRow(db, 'categories', 'codebase-exploration'), OLD_CODEBASE_EXPLORATION);
  putRow(db, 'categories', { id: oldGlobal.id, data: oldGlobal });
  putRow(db, 'project_categories', {
    project: 'detached-project',
    id: oldGlobal.id,
    kind: 'DETACH',
    data: Object.assign({}, oldGlobal, { contract: 'Detached project contract.' }),
  });
  putRow(db, 'project_categories', {
    project: 'overridden-project',
    id: oldGlobal.id,
    kind: 'OVERRIDE',
    data: { contract: 'Overridden project contract.' },
  });

  const migrated = reopenFromSchemaV4(homeRoot, db);
  assert.strictEqual(getRow(migrated, 'categories', oldGlobal.id).contract, CODEBASE_EXPLORATION.contract);
  assert.strictEqual(
    getRow(migrated, 'project_categories', { project: 'detached-project', id: oldGlobal.id }).contract,
    'Detached project contract.'
  );
  assert.strictEqual(
    getRow(migrated, 'project_categories', { project: 'overridden-project', id: oldGlobal.id }).contract,
    'Overridden project contract.'
  );
  migrated.close();
});

test('schema v5 leaves customized global codebase exploration rows untouched', () => {
  for (const field of ['description', 'contract']) {
    const { db, homeRoot } = makeDb();
    const customized = Object.assign({}, getRow(db, 'categories', 'codebase-exploration'), OLD_CODEBASE_EXPLORATION, {
      [field]: `Customized ${field}.`,
    });
    putRow(db, 'categories', { id: customized.id, data: customized });

    const migrated = reopenFromSchemaV4(homeRoot, db);
    assert.strictEqual(getRow(migrated, 'categories', customized.id)[field], `Customized ${field}.`);
    migrated.close();
  }
});

test('schema v5 refuses to open a newer database schema', () => {
  const { db, homeRoot } = makeDb();
  db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(JSON.stringify(6));
  db.close();

  assert.throws(
    () => openDb(homeRoot),
    /database schema 6 is newer than supported schema 5/
  );
});

test('putRow and getRow round-trip ticket data', () => {
  const { db } = makeDb();
  const row = ticket('tk_1', 'toolshed', 'todo', 1);

  putRow(db, 'tickets', row);

  assert.deepStrictEqual(getRow(db, 'tickets', 'tk_1'), row.data);
  db.close();
});

test('listRows filters ticket data by project and status', () => {
  const { db } = makeDb();
  const expected = ticket('tk_1', 'toolshed', 'todo', 1);
  putRow(db, 'tickets', expected);
  putRow(db, 'tickets', ticket('tk_2', 'toolshed', 'doing', 2));
  putRow(db, 'tickets', ticket('tk_3', 'other', 'todo', 3));

  assert.deepStrictEqual(listRows(db, 'tickets', { project: 'toolshed', status: 'todo' }), [expected.data]);
  db.close();
});

test('deleteRow removes a row', () => {
  const { db } = makeDb();
  putRow(db, 'tickets', ticket('tk_1', 'toolshed', 'todo', 1));

  assert.strictEqual(deleteRow(db, 'tickets', 'tk_1'), true);
  assert.strictEqual(getRow(db, 'tickets', 'tk_1'), null);
  db.close();
});

test('txn rolls back when its callback throws', () => {
  const { db } = makeDb();

  assert.throws(() => txn(db, () => {
    putRow(db, 'tickets', ticket('tk_1', 'toolshed', 'todo', 1));
    throw new Error('stop');
  }), /stop/);

  assert.strictEqual(getRow(db, 'tickets', 'tk_1'), null);
  db.close();
});

test('openDb enables WAL', () => {
  const { db } = makeDb();

  assert.strictEqual(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  db.close();
});

test('requiring db.js emits no SQLite ExperimentalWarning', () => {
  const dbPath = path.join(__dirname, '..', 'lib', 'db.js');
  const result = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(dbPath)})`], { encoding: 'utf8' });

  assert.strictEqual(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /ExperimentalWarning/);
  assert.doesNotMatch(result.stderr, /ExperimentalWarning/);
});
