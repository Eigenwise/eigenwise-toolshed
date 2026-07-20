"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var db_exports = {};
__export(db_exports, {
  CURRENT_SCHEMA_VERSION: () => CURRENT_SCHEMA_VERSION,
  assertWritable: () => assertWritable,
  countRows: () => countRows,
  deleteRow: () => deleteRow,
  getRow: () => getRow,
  hasRow: () => hasRow,
  listRows: () => listRows,
  listRowsPage: () => listRowsPage,
  openDb: () => openDb,
  prepareCached: () => prepareCached,
  putRow: () => putRow,
  selectRow: () => selectRow,
  selectRows: () => selectRows,
  txn: () => txn
});
module.exports = __toCommonJS(db_exports);
var import_node_fs = __toESM(require("node:fs"));
var import_node_path = __toESM(require("node:path"));
var import_category_defaults = require("./category-defaults.js");
var import_discovery = require("./discovery.js");
const originalEmitWarning = process.emitWarning;
process.emitWarning = ((warning, ...args) => {
  if (warning === "SQLite is an experimental feature and might change at any time" && args[0] === "ExperimentalWarning") {
    return;
  }
  Reflect.apply(originalEmitWarning, process, [warning, ...args]);
});
let DatabaseSyncConstructor;
try {
  ({ DatabaseSync: DatabaseSyncConstructor } = require("node:sqlite"));
} finally {
  process.emitWarning = originalEmitWarning;
}
const CURRENT_SCHEMA_VERSION = 5;
const OLD_CODEBASE_EXPLORATION = {
  description: "Locate and explain how an unfamiliar code path, feature, or convention works. The deliverable is a grounded map of existing code, not an implementation or a design recommendation.",
  contract: "Read before concluding; cite files and symbols, with no edits."
};
const LEGACY_RUNTIME = {
  "grade-1": "haiku",
  "grade-2": "sonnet",
  "grade-3": "opus",
  "grade-4": "fable",
  haiku: "haiku",
  sonnet: "sonnet",
  opus: "opus",
  fable: "fable"
};
const ROUTING_FALLBACK_DEFAULT = { model: "sonnet", effort: "high" };
const TABLES = {
  projects: { key: "slug", columns: ["slug", "data"] },
  tickets: { key: "id", columns: ["id", "project", "ref", "status", "archived", "ord", "claim_by", "data"], orderBy: "ord" },
  stories: { key: "id", columns: ["id", "project", "data"] },
  categories: { key: "id", columns: ["id", "data"] },
  project_categories: { key: ["project", "id"], columns: ["project", "id", "kind", "data"] },
  globals: { key: "key", columns: ["key", "data"] },
  meta: { key: "key", columns: ["key", "value"] }
};
const statementCaches = /* @__PURE__ */ new WeakMap();
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function tableSpec(table) {
  const spec = TABLES[table];
  if (!spec) throw new Error(`Unknown database table: ${table}`);
  return spec;
}
function keyColumns(spec) {
  return typeof spec.key === "string" ? [spec.key] : spec.key;
}
function keyValues(spec, key) {
  const columns = keyColumns(spec);
  if (columns.length === 1) return [key];
  if (!isRecord(key)) throw new Error(`Composite key for ${columns.join(", ")} requires an object.`);
  return columns.map((column) => key[column]);
}
function keyWhere(spec) {
  return keyColumns(spec).map((column) => `${column} = ?`).join(" AND ");
}
function payloadColumn(spec) {
  return spec.columns.includes("data") ? "data" : "value";
}
function parsePayload(row, column) {
  return JSON.parse(row[column]);
}
function filtersFor(table, whereObj) {
  const spec = tableSpec(table);
  const filters = Object.entries(whereObj ?? {});
  for (const [column] of filters) {
    if (!spec.columns.includes(column)) throw new Error(`Unknown ${table} column: ${column}`);
  }
  return filters;
}
function whereClause(filters) {
  return filters.length ? ` WHERE ${filters.map(([column]) => `${column} = ?`).join(" AND ")}` : "";
}
function parseStoredRecord(value) {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
function prepareCached(database, sql) {
  let cache = statementCaches.get(database);
  if (!cache) {
    cache = /* @__PURE__ */ new Map();
    statementCaches.set(database, cache);
  }
  let statement = cache.get(sql);
  if (!statement) {
    statement = database.prepare(sql);
    cache.set(sql, statement);
  }
  return statement;
}
function selectRows(database, sql, parameters = []) {
  return prepareCached(database, sql).all(...parameters);
}
function selectRow(database, sql, parameters = []) {
  return prepareCached(database, sql).get(...parameters) ?? null;
}
function openDb(homeRoot) {
  import_node_fs.default.mkdirSync(homeRoot, { recursive: true });
  const database = new DatabaseSyncConstructor(import_node_path.default.join(homeRoot, "sidequest.db"), { timeout: 5e3 });
  database.exec("PRAGMA journal_mode=WAL");
  database.exec("PRAGMA busy_timeout=5000");
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
  let schemaVersion = Number(schemaRow && JSON.parse(schemaRow.value));
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1) schemaVersion = 1;
  if (schemaVersion < 2) {
    txn(database, () => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS categories (
          id TEXT PRIMARY KEY,
          data TEXT
        )
      `);
      for (const category of import_category_defaults.DEFAULT_CATEGORIES) {
        prepareCached(database, "INSERT OR IGNORE INTO categories (id, data) VALUES (?, ?)").run(category.id, JSON.stringify(category));
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
      const discovered = (0, import_discovery.discoverExternalModels)();
      const byKey = new Map(discovered.map((entry) => [`${entry.source}:${entry.slug}`, entry]));
      const bySlug = new Map(discovered.map((entry) => [entry.slug, entry]));
      const rows = prepareCached(database, "SELECT id, data FROM categories").all();
      for (const row of rows) {
        const category = parseStoredRecord(row.data);
        const route = isRecord(category.route) ? category.route : null;
        const oldModel = String(route?.model ?? "").trim().toLowerCase();
        const runtime = LEGACY_RUNTIME[oldModel];
        if (!runtime || !route) continue;
        const tierBackend = isRecord(prefs.tierBackend) ? prefs.tierBackend : null;
        const configured = tierBackend?.[oldModel] ?? tierBackend?.[runtime];
        const selected = typeof configured === "string" ? configured.trim().toLowerCase() : "claude";
        const entry = byKey.get(selected) ?? bySlug.get(selected);
        const model = selected !== "claude" && !LEGACY_RUNTIME[selected] && entry ? entry.slug : runtime;
        const effort = route.effort;
        category.route = { model, effort };
        category.fallback = { model: runtime, effort };
        prepareCached(database, "UPDATE categories SET data = ? WHERE id = ?").run(JSON.stringify(category), row.id);
      }
      prepareCached(database, "DELETE FROM globals WHERE key = 'model-prefs'").run();
      const fallbackRow = prepareCached(database, "SELECT data FROM globals WHERE key = 'routing-fallback'").get();
      let validFallback = false;
      try {
        const fallback = fallbackRow && JSON.parse(fallbackRow.data);
        validFallback = isRecord(fallback) && typeof fallback.model === "string" && typeof fallback.effort === "string";
      } catch {
        validFallback = false;
      }
      if (!validFallback) {
        prepareCached(database, "INSERT INTO globals (key, data) VALUES ('routing-fallback', ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data").run(JSON.stringify(ROUTING_FALLBACK_DEFAULT));
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
  if (schemaVersion < 5) {
    txn(database, () => {
      const row = prepareCached(database, "SELECT data FROM categories WHERE id = 'codebase-exploration'").get();
      let category = null;
      try {
        const parsed = row ? JSON.parse(row.data) : null;
        category = isRecord(parsed) ? parsed : null;
      } catch {
        category = null;
      }
      if (category && category.description === OLD_CODEBASE_EXPLORATION.description && category.contract === OLD_CODEBASE_EXPLORATION.contract) {
        const next = import_category_defaults.DEFAULT_CATEGORIES.find((entry) => entry.id === "codebase-exploration");
        if (next) {
          category.description = next.description;
          category.contract = next.contract;
          prepareCached(database, "UPDATE categories SET data = ? WHERE id = 'codebase-exploration'").run(JSON.stringify(category));
        }
      }
      prepareCached(database, "UPDATE meta SET value = ? WHERE key = 'schema_version'").run(JSON.stringify(5));
    });
    schemaVersion = 5;
  }
  const sidequestDatabase = database;
  sidequestDatabase.__sidequestSchemaVersion = CURRENT_SCHEMA_VERSION;
  return sidequestDatabase;
}
function getRow(database, table, key) {
  const spec = tableSpec(table);
  const column = payloadColumn(spec);
  const row = prepareCached(database, `SELECT ${column} FROM ${table} WHERE ${keyWhere(spec)}`).get(...keyValues(spec, key));
  return row ? parsePayload(row, column) : null;
}
function assertWritable(database) {
  const row = prepareCached(database, "SELECT value FROM meta WHERE key = 'schema_version'").get();
  const version = Number(row && JSON.parse(row.value));
  if (version > CURRENT_SCHEMA_VERSION) {
    throw new Error(`Sidequest database schema ${version} is newer than supported schema ${CURRENT_SCHEMA_VERSION}; refusing write.`);
  }
}
function putRow(database, table, rowObject) {
  assertWritable(database);
  const spec = tableSpec(table);
  const object = rowObject;
  const values = spec.columns.map((column) => {
    const value = object[column];
    return column === "data" || column === "value" ? JSON.stringify(value) : value;
  });
  const assignments = spec.columns.filter((column) => !keyColumns(spec).includes(column)).map((column) => `${column} = excluded.${column}`).join(", ");
  const placeholders = spec.columns.map(() => "?").join(", ");
  return prepareCached(database, `
    INSERT INTO ${table} (${spec.columns.join(", ")}) VALUES (${placeholders})
    ON CONFLICT(${keyColumns(spec).join(", ")}) DO UPDATE SET ${assignments}
  `).run(...values).changes;
}
function deleteRow(database, table, key) {
  assertWritable(database);
  return prepareCached(database, `DELETE FROM ${table} WHERE ${keyWhere(tableSpec(table))}`).run(...keyValues(tableSpec(table), key)).changes !== 0;
}
function listRows(database, table, whereObj) {
  const spec = tableSpec(table);
  const column = payloadColumn(spec);
  const filters = filtersFor(table, whereObj);
  const orderBy = spec.orderBy ? ` ORDER BY ${spec.orderBy}` : "";
  const rows = prepareCached(database, `SELECT ${column} FROM ${table}${whereClause(filters)}${orderBy}`).all(...filters.map(([, value]) => value));
  return rows.map((row) => parsePayload(row, column));
}
function listRowsPage(database, table, whereObj, options) {
  if (!Number.isInteger(options.limit) || options.limit < 0) throw new RangeError("Page limit must be a non-negative integer.");
  const offset = options.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0) throw new RangeError("Page offset must be a non-negative integer.");
  const spec = tableSpec(table);
  const column = payloadColumn(spec);
  const filters = filtersFor(table, whereObj);
  const orderBy = spec.orderBy ? ` ORDER BY ${spec.orderBy}` : "";
  const rows = prepareCached(database, `SELECT ${column} FROM ${table}${whereClause(filters)}${orderBy} LIMIT ? OFFSET ?`).all(...filters.map(([, value]) => value), options.limit, offset);
  return rows.map((row) => parsePayload(row, column));
}
function countRows(database, table, whereObj) {
  const filters = filtersFor(table, whereObj);
  const row = prepareCached(database, `SELECT COUNT(*) AS count FROM ${table}${whereClause(filters)}`).get(...filters.map(([, value]) => value));
  return Number(row?.count ?? 0);
}
function hasRow(database, table, key) {
  const spec = tableSpec(table);
  return prepareCached(database, `SELECT 1 FROM ${table} WHERE ${keyWhere(spec)} LIMIT 1`).get(...keyValues(spec, key)) !== void 0;
}
function txn(database, fn) {
  const row = prepareCached(database, "SELECT value FROM meta WHERE key = 'schema_version'").get();
  if (row) assertWritable(database);
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    if (isRecord(result) && typeof result.then === "function") {
      throw new TypeError("SQLite transaction callbacks must be synchronous.");
    }
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
    }
    throw error;
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CURRENT_SCHEMA_VERSION,
  assertWritable,
  countRows,
  deleteRow,
  getRow,
  hasRow,
  listRows,
  listRowsPage,
  openDb,
  prepareCached,
  putRow,
  selectRow,
  selectRows,
  txn
});
