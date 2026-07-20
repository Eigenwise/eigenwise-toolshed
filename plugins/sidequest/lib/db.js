'use strict';

const fs = require('fs');
const path = require('path');
const { DEFAULT_CATEGORIES } = require('./category-defaults.js');
const { discoverExternalModels } = require('./discovery.js');

const originalEmitWarning = process.emitWarning;
process.emitWarning = function emitWarningWithoutSqliteExperimentalWarning(warning, ...args) {
  if (warning === 'SQLite is an experimental feature and might change at any time' && args[0] === 'ExperimentalWarning') {
    return;
  }
  return originalEmitWarning.call(this, warning, ...args);
};

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} finally {
  process.emitWarning = originalEmitWarning;
}

const CURRENT_SCHEMA_VERSION = 5;
const LEGACY_RUNTIME = { 'grade-1': 'haiku', 'grade-2': 'sonnet', 'grade-3': 'opus', 'grade-4': 'fable', haiku: 'haiku', sonnet: 'sonnet', opus: 'opus', fable: 'fable' };
const ROUTING_FALLBACK_DEFAULT = { model: 'sonnet', effort: 'high' };
const OLD_CODEBASE_EXPLORATION = {
  description: 'Locate and explain how an unfamiliar code path, feature, or convention works. The deliverable is a grounded map of existing code, not an implementation or a design recommendation.',
  contract: 'Read before concluding; cite files and symbols, with no edits.',
};

const TABLES = {
  projects: { key: 'slug', columns: ['slug', 'data'] },
  tickets: { key: 'id', columns: ['id', 'project', 'ref', 'status', 'archived', 'ord', 'claim_by', 'data'], orderBy: 'ord' },
  stories: { key: 'id', columns: ['id', 'project', 'data'] },
  categories: { key: 'id', columns: ['id', 'data'] },
  project_categories: { key: ['project', 'id'], columns: ['project', 'id', 'kind', 'data'] },
  globals: { key: 'key', columns: ['key', 'data'] },
  meta: { key: 'key', columns: ['key', 'value'] },
};

function tableSpec(table) {
  const spec = TABLES[table];
  if (!spec) throw new Error(`Unknown database table: ${table}`);
  return spec;
}

function openDb(homeRoot) {
  fs.mkdirSync(homeRoot, { recursive: true });
  const db = new DatabaseSync(path.join(homeRoot, 'sidequest.db'), { timeout: 5000 });
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA busy_timeout=5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      slug TEXT PRIMARY KEY,
      data TEXT
    );
    CREATE TABLE IF NOT EXISTS tickets (
      id TEXT PRIMARY KEY,
      project TEXT,
      ref TEXT,
      status TEXT,
      archived INTEGER,
      ord REAL,
      claim_by TEXT,
      data TEXT
    );
    CREATE INDEX IF NOT EXISTS tickets_project_status_idx ON tickets(project, status);
    CREATE INDEX IF NOT EXISTS tickets_project_archived_idx ON tickets(project, archived);
    CREATE INDEX IF NOT EXISTS tickets_project_ord_idx ON tickets(project, ord);
    CREATE TABLE IF NOT EXISTS stories (
      id TEXT PRIMARY KEY,
      project TEXT,
      data TEXT
    );
    CREATE INDEX IF NOT EXISTS stories_project_idx ON stories(project);
    CREATE TABLE IF NOT EXISTS globals (
      key TEXT PRIMARY KEY,
      data TEXT
    );
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1');
  `);

  const schemaRow = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  let schemaVersion = Number(schemaRow && JSON.parse(schemaRow.value));
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1) schemaVersion = 1;
  if (schemaVersion < 2) {
    txn(db, () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS categories (
          id TEXT PRIMARY KEY,
          data TEXT
        )
      `);
      for (const category of DEFAULT_CATEGORIES) {
        db.prepare('INSERT OR IGNORE INTO categories (id, data) VALUES (?, ?)').run(category.id, JSON.stringify(category));
      }
      db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(JSON.stringify(2));
    });
    schemaVersion = 2;
  }
  if (schemaVersion > CURRENT_SCHEMA_VERSION) {
    throw new Error(`Sidequest database schema ${schemaVersion} is newer than supported schema ${CURRENT_SCHEMA_VERSION}.`);
  }
  if (schemaVersion < 3) {
    txn(db, () => {
      const prefsRow = db.prepare("SELECT data FROM globals WHERE key = 'model-prefs'").get();
      let prefs = {};
      try { prefs = prefsRow ? JSON.parse(prefsRow.data) : {}; } catch (_) { prefs = {}; }
      const discovered = discoverExternalModels();
      const byKey = new Map(discovered.map((entry) => [`${entry.source}:${entry.slug}`, entry]));
      const bySlug = new Map(discovered.map((entry) => [entry.slug, entry]));
      const rows = db.prepare('SELECT id, data FROM categories').all();
      for (const row of rows) {
        let category;
        try { category = JSON.parse(row.data); } catch (_) { continue; }
        const oldModel = category && category.route && String(category.route.model || '').trim().toLowerCase();
        const runtime = LEGACY_RUNTIME[oldModel];
        if (!runtime) continue;
        const configured = prefs.tierBackend && (prefs.tierBackend[oldModel] || prefs.tierBackend[runtime]);
        const selected = typeof configured === 'string' ? configured.trim().toLowerCase() : 'claude';
        const entry = byKey.get(selected) || bySlug.get(selected);
        const model = selected !== 'claude' && !LEGACY_RUNTIME[selected] && entry ? entry.slug : runtime;
        const effort = category.route.effort;
        category.route = { model, effort };
        category.fallback = { model: runtime, effort };
        db.prepare('UPDATE categories SET data = ? WHERE id = ?').run(JSON.stringify(category), row.id);
      }
      db.prepare("DELETE FROM globals WHERE key = 'model-prefs'").run();
      const fallbackRow = db.prepare("SELECT data FROM globals WHERE key = 'routing-fallback'").get();
      let validFallback = false;
      try {
        const fallback = fallbackRow && JSON.parse(fallbackRow.data);
        validFallback = fallback && typeof fallback.model === 'string' && typeof fallback.effort === 'string';
      } catch (_) {}
      if (!validFallback) {
        db.prepare("INSERT INTO globals (key, data) VALUES ('routing-fallback', ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data").run(JSON.stringify(ROUTING_FALLBACK_DEFAULT));
      }
      db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(JSON.stringify(3));
    });
    schemaVersion = 3;
  }
  if (schemaVersion < 4) {
    txn(db, () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS project_categories (
          project TEXT,
          id TEXT,
          kind TEXT,
          data TEXT,
          PRIMARY KEY (project, id)
        );
        CREATE INDEX IF NOT EXISTS project_categories_project_idx ON project_categories(project);
      `);
      db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(JSON.stringify(4));
    });
    schemaVersion = 4;
  }
  if (schemaVersion < 5) {
    txn(db, () => {
      const row = db.prepare("SELECT data FROM categories WHERE id = 'codebase-exploration'").get();
      let category = null;
      try { category = row ? JSON.parse(row.data) : null; } catch (_) {}
      if (category
        && category.description === OLD_CODEBASE_EXPLORATION.description
        && category.contract === OLD_CODEBASE_EXPLORATION.contract) {
        const next = DEFAULT_CATEGORIES.find((entry) => entry.id === 'codebase-exploration');
        category.description = next.description;
        category.contract = next.contract;
        db.prepare("UPDATE categories SET data = ? WHERE id = 'codebase-exploration'").run(JSON.stringify(category));
      }
      db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(JSON.stringify(5));
    });
    schemaVersion = 5;
  }
  db.__sidequestSchemaVersion = CURRENT_SCHEMA_VERSION;
  return db;
}

function keyColumns(spec) {
  return Array.isArray(spec.key) ? spec.key : [spec.key];
}

function keyValues(spec, key) {
  const columns = keyColumns(spec);
  if (columns.length === 1) return [key];
  if (!key || typeof key !== 'object') throw new Error(`Composite key for ${columns.join(', ')} requires an object.`);
  return columns.map((column) => key[column]);
}

function keyWhere(spec) {
  return keyColumns(spec).map((column) => `${column} = ?`).join(' AND ');
}

function payloadColumn(spec) {
  return spec.columns.includes('data') ? 'data' : 'value';
}

function getRow(db, table, key) {
  const spec = tableSpec(table);
  const column = payloadColumn(spec);
  const row = db.prepare(`SELECT ${column} FROM ${table} WHERE ${keyWhere(spec)}`).get(...keyValues(spec, key));
  return row ? JSON.parse(row[column]) : null;
}

function assertWritable(db) {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  const version = Number(row && JSON.parse(row.value));
  if (version > CURRENT_SCHEMA_VERSION) {
    throw new Error(`Sidequest database schema ${version} is newer than supported schema ${CURRENT_SCHEMA_VERSION}; refusing write.`);
  }
}

function putRow(db, table, rowObj) {
  assertWritable(db);
  const spec = tableSpec(table);
  const values = spec.columns.map((column) => {
    const value = rowObj[column];
    return column === 'data' || column === 'value' ? JSON.stringify(value) : value;
  });
  const assignments = spec.columns
    .filter((column) => !keyColumns(spec).includes(column))
    .map((column) => `${column} = excluded.${column}`)
    .join(', ');
  const placeholders = spec.columns.map(() => '?').join(', ');
  const result = db.prepare(`
    INSERT INTO ${table} (${spec.columns.join(', ')}) VALUES (${placeholders})
    ON CONFLICT(${keyColumns(spec).join(', ')}) DO UPDATE SET ${assignments}
  `).run(...values);
  return result.changes;
}

function deleteRow(db, table, key) {
  assertWritable(db);
  const spec = tableSpec(table);
  return db.prepare(`DELETE FROM ${table} WHERE ${keyWhere(spec)}`).run(...keyValues(spec, key)).changes > 0;
}

function listRows(db, table, whereObj) {
  const spec = tableSpec(table);
  const column = payloadColumn(spec);
  const filters = Object.entries(whereObj || {});
  for (const [filterColumn] of filters) {
    if (!spec.columns.includes(filterColumn)) throw new Error(`Unknown ${table} column: ${filterColumn}`);
  }
  const where = filters.length ? ` WHERE ${filters.map(([filterColumn]) => `${filterColumn} = ?`).join(' AND ')}` : '';
  const orderBy = spec.orderBy ? ` ORDER BY ${spec.orderBy}` : '';
  const rows = db.prepare(`SELECT ${column} FROM ${table}${where}${orderBy}`).all(...filters.map(([, value]) => value));
  return rows.map((row) => JSON.parse(row[column]));
}

// Existence check that never parses the payload — callers use it to detect a
// persisted record without triggering a read that would throw on a corrupt blob.
function hasRow(db, table, key) {
  const spec = tableSpec(table);
  return db.prepare(`SELECT 1 FROM ${table} WHERE ${keyWhere(spec)} LIMIT 1`).get(...keyValues(spec, key)) !== undefined;
}

function txn(db, fn) {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  if (row) assertWritable(db);
  // IMMEDIATE takes the write lock at BEGIN so concurrent writers queue on
  // busy_timeout instead of both grabbing a read lock and deadlocking on the
  // upgrade (SQLITE_BUSY isn't retryable once two txns hold the shared lock).
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch (_) {
      // Preserve the operation error if a rollback is no longer possible.
    }
    throw error;
  }
}

module.exports = { CURRENT_SCHEMA_VERSION, openDb, getRow, putRow, deleteRow, listRows, hasRow, txn };
