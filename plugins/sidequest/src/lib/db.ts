import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync, SQLInputValue, SQLOutputValue, StatementSync } from 'node:sqlite';


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

export const CURRENT_SCHEMA_VERSION = 7;

// Pre-v5 default text; the v5 migration only refreshes rows the user never customized.
const OLD_CODEBASE_EXPLORATION = {
  description: 'Locate and explain how an unfamiliar code path, feature, or convention works. The deliverable is a grounded map of existing code, not an implementation or a design recommendation.',
  contract: 'Read before concluding; cite files and symbols, with no edits.',
} as const;
const V5_CODEBASE_EXPLORATION_CONTRACT = 'Read before concluding; cite files and symbols. Do not edit project source. A ticket may explicitly name one bounded documentation artifact directory as its only write scope.';

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
  jsonColumns?: readonly string[];
  payload?: 'data' | 'value';
  orderBy?: string;
}

const TABLES = {
  projects: { key: 'slug', columns: ['slug', 'data'], jsonColumns: ['data'], payload: 'data' },
  tickets: { key: 'id', columns: ['id', 'project', 'ref', 'status', 'archived', 'ord', 'claim_by', 'data'], jsonColumns: ['data'], payload: 'data', orderBy: 'ord' },
  stories: { key: 'id', columns: ['id', 'project', 'data'], jsonColumns: ['data'], payload: 'data' },
  globals: { key: 'key', columns: ['key', 'data'], jsonColumns: ['data'], payload: 'data' },
  meta: { key: 'key', columns: ['key', 'value'], jsonColumns: ['value'], payload: 'value' },
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

export interface RoutingProfileRow {
  id: string;
  name: string;
  description: string;
  source: 'seed' | 'migrated' | 'user';
  seed_key: string | null;
  seed_revision: number | null;
  revision: number;
  created_at: string;
  updated_at: string;
  retired_at: string | null;
}

export interface RoutingProfileEntryRow<T = unknown> {
  profile_id: string;
  category_id: string;
  data: T;
  position: number;
  updated_at: string;
}

export interface ProjectRoutingProfileRow {
  project: string;
  profile_id: string;
  assigned_at: string;
  assigned_by: string | null;
}

export interface RoutingProfileSettingsRow {
  singleton: number;
  new_project_profile_id: string;
}

export interface ProjectCategoryRow<T = unknown> {
  project: string;
  id: string;
  kind: string;
  base_profile_id?: string | null;
  base_data?: T | null;
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
  globals: GlobalRow;
  meta: MetaRow;
}

export interface DatabaseTableKeyMap {
  projects: string;
  tickets: string;
  stories: string;
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

function payloadColumn(spec: TableSpec): 'data' | 'value' | null {
  return spec.payload ?? null;
}

function parsePayload(row: Record<string, SQLOutputValue>, column: string): unknown {
  return JSON.parse(row[column] as string) as unknown;
}

function parseTableRow(spec: TableSpec, row: Record<string, SQLOutputValue>): unknown {
  const payload = payloadColumn(spec);
  if (payload) return parsePayload(row, payload);
  const parsed: Record<string, unknown> = {};
  for (const column of spec.columns) {
    const value = row[column];
    parsed[column] = spec.jsonColumns?.includes(column) && value != null
      ? JSON.parse(value as string) as unknown
      : value;
  }
  return parsed;
}

function encodeColumn(spec: TableSpec, column: string, value: unknown): SQLInputValue {
  if (value === undefined) return null;
  if (spec.jsonColumns?.includes(column)) return JSON.stringify(value) ?? null;
  return value as SQLInputValue;
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
  // Schema 2-7 seeded and reshaped the category and routing-profile tables. That
  // engine is gone; the tables are left in place on existing databases rather than
  // dropped, so a downgrade still finds its data. New databases never create them.
  if (schemaVersion < 7) {
    txn(database, () => {
      prepareCached(database, "UPDATE meta SET value = ? WHERE key = 'schema_version'").run(JSON.stringify(7));
    });
    schemaVersion = 7;
  }
  database.exec('PRAGMA foreign_keys=ON');
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
  const payload = payloadColumn(spec);
  const selection = payload ?? spec.columns.join(', ');
  const row = prepareCached(database, `SELECT ${selection} FROM ${table} WHERE ${keyWhere(spec)}`).get(...keyValues(spec, key));
  return row ? parseTableRow(spec, row) as T : null;
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
  const values = spec.columns.map((column) => encodeColumn(spec, column, object[column]));
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
  const payload = payloadColumn(spec);
  const selection = payload ?? spec.columns.join(', ');
  const filters = filtersFor(table, whereObj);
  const orderBy = spec.orderBy ? ` ORDER BY ${spec.orderBy}` : '';
  const rows = prepareCached(database, `SELECT ${selection} FROM ${table}${whereClause(filters)}${orderBy}`)
    .all(...filters.map(([, value]) => value));
  return rows.map((row) => parseTableRow(spec, row) as T);
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
  const payload = payloadColumn(spec);
  const selection = payload ?? spec.columns.join(', ');
  const filters = filtersFor(table, whereObj);
  const orderBy = spec.orderBy ? ` ORDER BY ${spec.orderBy}` : '';
  const rows = prepareCached(database, `SELECT ${selection} FROM ${table}${whereClause(filters)}${orderBy} LIMIT ? OFFSET ?`)
    .all(...filters.map(([, value]) => value), options.limit, offset);
  return rows.map((row) => parseTableRow(spec, row) as T);
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
