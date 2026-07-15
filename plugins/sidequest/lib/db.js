'use strict';

const fs = require('fs');
const path = require('path');

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

const TABLES = {
  projects: { key: 'slug', columns: ['slug', 'data'] },
  tickets: { key: 'id', columns: ['id', 'project', 'ref', 'status', 'archived', 'ord', 'claim_by', 'data'], orderBy: 'ord' },
  stories: { key: 'id', columns: ['id', 'project', 'data'] },
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
  return db;
}

function getRow(db, table, key) {
  const spec = tableSpec(table);
  const payloadColumn = spec.columns.includes('data') ? 'data' : 'value';
  const row = db.prepare(`SELECT ${payloadColumn} FROM ${table} WHERE ${spec.key} = ?`).get(key);
  return row ? JSON.parse(row[payloadColumn]) : null;
}

function putRow(db, table, rowObj) {
  const spec = tableSpec(table);
  const values = spec.columns.map((column) => {
    const value = rowObj[column];
    return column === 'data' || column === 'value' ? JSON.stringify(value) : value;
  });
  const assignments = spec.columns
    .filter((column) => column !== spec.key)
    .map((column) => `${column} = excluded.${column}`)
    .join(', ');
  const placeholders = spec.columns.map(() => '?').join(', ');
  const result = db.prepare(`
    INSERT INTO ${table} (${spec.columns.join(', ')}) VALUES (${placeholders})
    ON CONFLICT(${spec.key}) DO UPDATE SET ${assignments}
  `).run(...values);
  return result.changes;
}

function deleteRow(db, table, key) {
  const spec = tableSpec(table);
  return db.prepare(`DELETE FROM ${table} WHERE ${spec.key} = ?`).run(key).changes > 0;
}

function listRows(db, table, whereObj) {
  const spec = tableSpec(table);
  const payloadColumn = spec.columns.includes('data') ? 'data' : 'value';
  const filters = Object.entries(whereObj || {});
  for (const [column] of filters) {
    if (!spec.columns.includes(column)) throw new Error(`Unknown ${table} column: ${column}`);
  }
  const where = filters.length ? ` WHERE ${filters.map(([column]) => `${column} = ?`).join(' AND ')}` : '';
  const orderBy = spec.orderBy ? ` ORDER BY ${spec.orderBy}` : '';
  const rows = db.prepare(`SELECT ${payloadColumn} FROM ${table}${where}${orderBy}`).all(...filters.map(([, value]) => value));
  return rows.map((row) => JSON.parse(row[payloadColumn]));
}

// Existence check that never parses the payload — callers use it to detect a
// persisted record without triggering a read that would throw on a corrupt blob.
function hasRow(db, table, key) {
  const spec = tableSpec(table);
  return db.prepare(`SELECT 1 FROM ${table} WHERE ${spec.key} = ? LIMIT 1`).get(key) !== undefined;
}

function txn(db, fn) {
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

module.exports = { openDb, getRow, putRow, deleteRow, listRows, hasRow, txn };
