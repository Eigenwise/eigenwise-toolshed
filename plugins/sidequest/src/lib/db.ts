import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync, SQLInputValue, SQLOutputValue, StatementSync } from 'node:sqlite';

import { DEFAULT_CATEGORIES } from './category-defaults.js';
import { discoverExternalModels } from './discovery.js';

const originalEmitWarning = process.emitWarning;
process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
  if (warning === 'SQLite is an experimental feature and might change at any time' && args[0] === 'ExperimentalWarning') {
    return;
  }
  Reflect.apply(originalEmitWarning, process, [warning, ...args]);
}) as typeof process.emitWarning;

let DatabaseSyncConstructor: typeof import('node:sqlite').DatabaseSync;
try {
  ({ DatabaseSync: DatabaseSyncConstructor } = require('node:sqlite') as typeof import('node:sqlite'));
} finally {
  process.emitWarning = originalEmitWarning;
}

export const CURRENT_SCHEMA_VERSION = 4;

const LEGACY_RUNTIME: Readonly<Record<string, string>> = {
  'grade-1': 'haiku',
  'grade-2': 'sonnet',
  'grade-3': 'opus',
  'grade-4': 'fable',
  haiku: 'haiku',
  sonnet: 'sonnet',
  opus: 'opus',
  fable: 'fable',
};
const ROUTING_FALLBACK_DEFAULT = { model: 'sonnet', effort: 'high' } as const;

interface TableSpec {
  key: string | readonly string[];
  columns: readonly string[];
  orderBy?: string;
}

const TABLES = {
  projects: { key: 'slug', columns: ['slug', 'data'] },
  tickets: { key: 'id', columns: ['id', 'project', 'ref', 'status', 'archived', 'ord', 'claim_by', 'data'], orderBy: 'ord' },
  stories: { key: 'id', columns: ['id', 'project', 'data'] },
  categories: { key: 'id', columns: ['id', 'data'] },
  project_categories: { key: ['project', 'id'], columns: ['project', 'id', 'kind', 'data'] },
  globals: { key: 'key', columns: ['key', 'data'] },
  meta: { key: 'key', columns: ['key', 'value'] },
} as const satisfies Record<string, TableSpec>;

export type TableName = keyof typeof TABLES;
export type ChangeCount = number | bigint;
export type SidequestDatabase = DatabaseSync & { __sidequestSchemaVersion: number };

export interface ProjectRow<T = unknown> {
  slug: string;
  data: T;
}

export interface TicketRow<T = unknown> {
  id: string;
  project: string;
  ref: string | null;
  status: string | null;
  archived: number;
  ord: number;
  claim_by: string | null;
  data: T;
}

export interface StoryRow<T = unknown> {
  id: string;
  project: string;
  data: T;
}

export interface CategoryRow<T = unknown> {
  id: string;
  data: T;
}

export interface ProjectCategoryRow<T = unknown> {
  project: string;
  id: string;
  kind: string;
  data: T;
}

export interface GlobalRow<T = unknown> {
  key: string;
  data: T;
}

export interface MetaRow<T = unknown> {
  key: string;
  value: T;
}

export interface DatabaseTableRowMap {
  projects: ProjectRow;
  tickets: TicketRow;
  stories: StoryRow;
  categories: CategoryRow;
  project_categories: ProjectCategoryRow;
  globals: GlobalRow;
  meta: MetaRow;
}

export interface DatabaseTableKeyMap {
  projects: string;
  tickets: string;
  stories: string;
  categories: string;
  project_categories: { project: string; id: string };
  globals: string;
  meta: string;
}

export type RowFilter<T extends TableName> = Partial<Record<(typeof TABLES)[T]['columns'][number], SQLInputValue>>;

export interface PageOptions {
  limit: number;
  offset?: number;
}

const statementCaches = new WeakMap<DatabaseSync, Map<string, StatementSync>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function tableSpec(table: TableName): TableSpec {
  const spec: TableSpec | undefined = TABLES[table];
  if (!spec) throw new Error(`Unknown database table: ${table}`);
  return spec;
}

function keyColumns(spec: TableSpec): readonly string[] {
  return typeof spec.key === 'string' ? [spec.key] : spec.key;
}

function keyValues(spec: TableSpec, key: unknown): SQLInputValue[] {
  const columns = keyColumns(spec);
  if (columns.length === 1) return [key as SQLInputValue];
  if (!isRecord(key)) throw new Error(`Composite key for ${columns.join(', ')} requires an object.`);
  return columns.map((column) => key[column] as SQLInputValue);
}

function keyWhere(spec: TableSpec): string {
  return keyColumns(spec).map((column) => `${column} = ?`).join(' AND ');
}

function payloadColumn(spec: TableSpec): 'data' | 'value' {
  return spec.columns.includes('data') ? 'data' : 'value';
}

function parsePayload(row: Record<string, SQLOutputValue>, column: string): unknown {
  return JSON.parse(row[column] as string) as unknown;
}

function filtersFor<T extends TableName>(table: T, whereObj?: RowFilter<T>): Array<[string, SQLInputValue]> {
  const spec = tableSpec(table);
  const filters = Object.entries(whereObj ?? {}) as Array<[string, SQLInputValue]>;
  for (const [column] of filters) {
    if (!spec.columns.includes(column)) throw new Error(`Unknown ${table} column: ${column}`);
  }
  return filters;
}

function whereClause(filters: ReadonlyArray<readonly [string, SQLInputValue]>): string {
  return filters.length ? ` WHERE ${filters.map(([column]) => `${column} = ?`).join(' AND ')}` : '';
}

function parseStoredRecord(value: SQLOutputValue | undefined): Record<string, unknown> {
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function prepareCached(database: DatabaseSync, sql: string): StatementSync {
  let cache = statementCaches.get(database);
  if (!cache) {
    cache = new Map<string, StatementSync>();
    statementCaches.set(database, cache);
  }
  let statement = cache.get(sql);
  if (!statement) {
    statement = database.prepare(sql);
    cache.set(sql, statement);
  }
  return statement;
}

export function selectRows<T = Record<string, SQLOutputValue>>(
  database: DatabaseSync,
  sql: string,
  parameters: readonly SQLInputValue[] = [],
): T[] {
  return prepareCached(database, sql).all(...parameters) as T[];
}

export function selectRow<T = Record<string, SQLOutputValue>>(
  database: DatabaseSync,
  sql: string,
  parameters: readonly SQLInputValue[] = [],
): T | null {
  return (prepareCached(database, sql).get(...parameters) as T | undefined) ?? null;
}

export function openDb(homeRoot: string): SidequestDatabase {
  fs.mkdirSync(homeRoot, { recursive: true });
  const database = new DatabaseSyncConstructor(path.join(homeRoot, 'sidequest.db'), { timeout: 5000 });
  database.exec('PRAGMA journal_mode=WAL');
  database.exec('PRAGMA busy_timeout=5000');
  database.exec(`
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

  const schemaRow = prepareCached(database, "SELECT value FROM meta WHERE key = 'schema_version'").get();
  let schemaVersion = Number(schemaRow && JSON.parse(schemaRow.value as string));
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1) schemaVersion = 1;
  if (schemaVersion < 2) {
    txn(database, () => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS categories (
          id TEXT PRIMARY KEY,
          data TEXT
        )
      `);
      for (const category of DEFAULT_CATEGORIES) {
        prepareCached(database, 'INSERT OR IGNORE INTO categories (id, data) VALUES (?, ?)').run(category.id, JSON.stringify(category));
      }
      prepareCached(database, "UPDATE meta SET value = ? WHERE key = 'schema_version'").run(JSON.stringify(2));
    });
    schemaVersion = 2;
  }
  if (schemaVersion > CURRENT_SCHEMA_VERSION) {
    throw new Error(`Sidequest database schema ${schemaVersion} is newer than supported schema ${CURRENT_SCHEMA_VERSION}.`);
  }
  if (schemaVersion < 3) {
    txn(database, () => {
      const prefsRow = prepareCached(database, "SELECT data FROM globals WHERE key = 'model-prefs'").get();
      const prefs = parseStoredRecord(prefsRow?.data);
      const discovered = discoverExternalModels();
      const byKey = new Map(discovered.map((entry) => [`${entry.source}:${entry.slug}`, entry]));
      const bySlug = new Map(discovered.map((entry) => [entry.slug, entry]));
      const rows = prepareCached(database, 'SELECT id, data FROM categories').all();
      for (const row of rows) {
        const category = parseStoredRecord(row.data);
        const route = isRecord(category.route) ? category.route : null;
        const oldModel = String(route?.model ?? '').trim().toLowerCase();
        const runtime = LEGACY_RUNTIME[oldModel];
        if (!runtime || !route) continue;
        const tierBackend = isRecord(prefs.tierBackend) ? prefs.tierBackend : null;
        const configured = tierBackend?.[oldModel] ?? tierBackend?.[runtime];
        const selected = typeof configured === 'string' ? configured.trim().toLowerCase() : 'claude';
        const entry = byKey.get(selected) ?? bySlug.get(selected);
        const model = selected !== 'claude' && !LEGACY_RUNTIME[selected] && entry ? entry.slug : runtime;
        const effort = route.effort;
        category.route = { model, effort };
        category.fallback = { model: runtime, effort };
        prepareCached(database, 'UPDATE categories SET data = ? WHERE id = ?')
          .run(JSON.stringify(category) as string, row.id as SQLInputValue);
      }
      prepareCached(database, "DELETE FROM globals WHERE key = 'model-prefs'").run();
      const fallbackRow = prepareCached(database, "SELECT data FROM globals WHERE key = 'routing-fallback'").get();
      let validFallback = false;
      try {
        const fallback = fallbackRow && JSON.parse(fallbackRow.data as string) as unknown;
        validFallback = isRecord(fallback) && typeof fallback.model === 'string' && typeof fallback.effort === 'string';
      } catch {
        validFallback = false;
      }
      if (!validFallback) {
        prepareCached(database, "INSERT INTO globals (key, data) VALUES ('routing-fallback', ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data")
          .run(JSON.stringify(ROUTING_FALLBACK_DEFAULT));
      }
      prepareCached(database, "UPDATE meta SET value = ? WHERE key = 'schema_version'").run(JSON.stringify(3));
    });
    schemaVersion = 3;
  }
  if (schemaVersion < 4) {
    txn(database, () => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS project_categories (
          project TEXT,
          id TEXT,
          kind TEXT,
          data TEXT,
          PRIMARY KEY (project, id)
        );
        CREATE INDEX IF NOT EXISTS project_categories_project_idx ON project_categories(project);
      `);
      prepareCached(database, "UPDATE meta SET value = ? WHERE key = 'schema_version'").run(JSON.stringify(4));
    });
    schemaVersion = 4;
  }
  const sidequestDatabase = database as SidequestDatabase;
  sidequestDatabase.__sidequestSchemaVersion = CURRENT_SCHEMA_VERSION;
  return sidequestDatabase;
}

export function getRow<T = unknown, N extends TableName = TableName>(
  database: DatabaseSync,
  table: N,
  key: DatabaseTableKeyMap[N],
): T | null {
  const spec = tableSpec(table);
  const column = payloadColumn(spec);
  const row = prepareCached(database, `SELECT ${column} FROM ${table} WHERE ${keyWhere(spec)}`).get(...keyValues(spec, key));
  return row ? parsePayload(row, column) as T : null;
}

export function assertWritable(database: DatabaseSync): void {
  const row = prepareCached(database, "SELECT value FROM meta WHERE key = 'schema_version'").get();
  const version = Number(row && JSON.parse(row.value as string));
  if (version > CURRENT_SCHEMA_VERSION) {
    throw new Error(`Sidequest database schema ${version} is newer than supported schema ${CURRENT_SCHEMA_VERSION}; refusing write.`);
  }
}

export function putRow<N extends TableName>(database: DatabaseSync, table: N, rowObject: DatabaseTableRowMap[N]): ChangeCount {
  assertWritable(database);
  const spec = tableSpec(table);
  const object = rowObject as unknown as Record<string, unknown>;
  const values = spec.columns.map((column) => {
    const value = object[column];
    return (column === 'data' || column === 'value' ? JSON.stringify(value) : value) as SQLInputValue;
  });
  const assignments = spec.columns
    .filter((column) => !keyColumns(spec).includes(column))
    .map((column) => `${column} = excluded.${column}`)
    .join(', ');
  const placeholders = spec.columns.map(() => '?').join(', ');
  return prepareCached(database, `
    INSERT INTO ${table} (${spec.columns.join(', ')}) VALUES (${placeholders})
    ON CONFLICT(${keyColumns(spec).join(', ')}) DO UPDATE SET ${assignments}
  `).run(...values).changes;
}

export function deleteRow<N extends TableName>(database: DatabaseSync, table: N, key: DatabaseTableKeyMap[N]): boolean {
  assertWritable(database);
  return prepareCached(database, `DELETE FROM ${table} WHERE ${keyWhere(tableSpec(table))}`).run(...keyValues(tableSpec(table), key)).changes !== 0;
}

export function listRows<T = unknown, N extends TableName = TableName>(
  database: DatabaseSync,
  table: N,
  whereObj?: RowFilter<N>,
): T[] {
  const spec = tableSpec(table);
  const column = payloadColumn(spec);
  const filters = filtersFor(table, whereObj);
  const orderBy = spec.orderBy ? ` ORDER BY ${spec.orderBy}` : '';
  const rows = prepareCached(database, `SELECT ${column} FROM ${table}${whereClause(filters)}${orderBy}`)
    .all(...filters.map(([, value]) => value));
  return rows.map((row) => parsePayload(row, column) as T);
}

export function listRowsPage<T = unknown, N extends TableName = TableName>(
  database: DatabaseSync,
  table: N,
  whereObj: RowFilter<N> | undefined,
  options: PageOptions,
): T[] {
  if (!Number.isInteger(options.limit) || options.limit < 0) throw new RangeError('Page limit must be a non-negative integer.');
  const offset = options.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0) throw new RangeError('Page offset must be a non-negative integer.');
  const spec = tableSpec(table);
  const column = payloadColumn(spec);
  const filters = filtersFor(table, whereObj);
  const orderBy = spec.orderBy ? ` ORDER BY ${spec.orderBy}` : '';
  const rows = prepareCached(database, `SELECT ${column} FROM ${table}${whereClause(filters)}${orderBy} LIMIT ? OFFSET ?`)
    .all(...filters.map(([, value]) => value), options.limit, offset);
  return rows.map((row) => parsePayload(row, column) as T);
}

export function countRows<N extends TableName>(database: DatabaseSync, table: N, whereObj?: RowFilter<N>): number {
  const filters = filtersFor(table, whereObj);
  const row = prepareCached(database, `SELECT COUNT(*) AS count FROM ${table}${whereClause(filters)}`)
    .get(...filters.map(([, value]) => value));
  return Number(row?.count ?? 0);
}

export function hasRow<N extends TableName>(database: DatabaseSync, table: N, key: DatabaseTableKeyMap[N]): boolean {
  const spec = tableSpec(table);
  return prepareCached(database, `SELECT 1 FROM ${table} WHERE ${keyWhere(spec)} LIMIT 1`).get(...keyValues(spec, key)) !== undefined;
}

export function txn<T>(database: DatabaseSync, fn: () => T): T {
  const row = prepareCached(database, "SELECT value FROM meta WHERE key = 'schema_version'").get();
  if (row) assertWritable(database);
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    if (isRecord(result) && typeof result.then === 'function') {
      throw new TypeError('SQLite transaction callbacks must be synchronous.');
    }
    database.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // Preserve the operation error if a rollback is no longer possible.
    }
    throw error;
  }
}
