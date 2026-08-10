"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
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
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var schema_exports = {};
__export(schema_exports, {
  GRAPH_SCHEMA_VERSION: () => GRAPH_SCHEMA_VERSION,
  migrateGraphSchema: () => migrateGraphSchema,
  validateGraphDatabase: () => validateGraphDatabase
});
module.exports = __toCommonJS(schema_exports);
const GRAPH_SCHEMA_VERSION = 2;
const schemaVersionOne = `
CREATE TABLE snapshots (
  snapshot_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  project_root_hash TEXT NOT NULL,
  source_manifest_hash TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  engine_id TEXT NOT NULL,
  engine_version TEXT NOT NULL,
  indexed_at TEXT NOT NULL
) STRICT;
CREATE TABLE projects (
  snapshot_id TEXT NOT NULL REFERENCES snapshots(snapshot_id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  root TEXT NOT NULL,
  config_file TEXT,
  language TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, project_id)
) STRICT;
CREATE TABLE files (
  snapshot_id TEXT NOT NULL REFERENCES snapshots(snapshot_id) ON DELETE CASCADE,
  file TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  diagnostics_json TEXT NOT NULL,
  unresolved_count INTEGER NOT NULL CHECK (unresolved_count >= 0),
  PRIMARY KEY (snapshot_id, file)
) STRICT;
CREATE TABLE nodes (
  snapshot_id TEXT NOT NULL REFERENCES snapshots(snapshot_id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  extractor TEXT NOT NULL,
  language TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  qualified_name TEXT NOT NULL,
  file TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  start_column INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  end_column INTEGER NOT NULL,
  exported INTEGER NOT NULL CHECK (exported IN (0, 1)),
  content_hash TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, node_id),
  FOREIGN KEY (snapshot_id, project_id) REFERENCES projects(snapshot_id, project_id),
  FOREIGN KEY (snapshot_id, file) REFERENCES files(snapshot_id, file)
) STRICT;
CREATE INDEX nodes_symbol_order ON nodes(snapshot_id, qualified_name, file, start_line, kind, node_id);
CREATE TABLE edges (
  snapshot_id TEXT NOT NULL REFERENCES snapshots(snapshot_id) ON DELETE CASCADE,
  edge_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  target_id TEXT,
  resolution TEXT NOT NULL,
  evidence_file TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  start_column INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  end_column INTEGER NOT NULL,
  reason TEXT,
  PRIMARY KEY (snapshot_id, edge_id),
  FOREIGN KEY (snapshot_id, source_id) REFERENCES nodes(snapshot_id, node_id),
  FOREIGN KEY (snapshot_id, target_id) REFERENCES nodes(snapshot_id, node_id),
  FOREIGN KEY (snapshot_id, evidence_file) REFERENCES files(snapshot_id, file)
) STRICT;
CREATE INDEX edges_forward ON edges(snapshot_id, source_id, kind, edge_id);
CREATE INDEX edges_reverse ON edges(snapshot_id, target_id, kind, edge_id);
CREATE TABLE lexical_terms (
  snapshot_id TEXT NOT NULL REFERENCES snapshots(snapshot_id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  term TEXT NOT NULL,
  weight REAL NOT NULL CHECK (weight >= 0),
  PRIMARY KEY (snapshot_id, node_id, term),
  FOREIGN KEY (snapshot_id, node_id) REFERENCES nodes(snapshot_id, node_id)
) STRICT;
CREATE INDEX lexical_term_lookup ON lexical_terms(snapshot_id, term, weight DESC, node_id);
CREATE TABLE file_ownership (
  snapshot_id TEXT NOT NULL REFERENCES snapshots(snapshot_id) ON DELETE CASCADE,
  file TEXT NOT NULL,
  node_id TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, file, node_id),
  FOREIGN KEY (snapshot_id, file) REFERENCES files(snapshot_id, file),
  FOREIGN KEY (snapshot_id, node_id) REFERENCES nodes(snapshot_id, node_id)
) STRICT;
`;
const schemaVersionTwo = `
CREATE TABLE dependency_environments (
  snapshot_id TEXT NOT NULL REFERENCES snapshots(snapshot_id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('configured', 'conventional', 'absent')),
  PRIMARY KEY (snapshot_id, project_id),
  FOREIGN KEY (snapshot_id, project_id) REFERENCES projects(snapshot_id, project_id)
) STRICT;
`;
function databaseVersion(database) {
  const row = database.prepare("PRAGMA user_version").get();
  return row?.user_version ?? 0;
}
function migrateGraphSchema(database) {
  database.exec("PRAGMA foreign_keys = ON");
  const version = databaseVersion(database);
  if (version > GRAPH_SCHEMA_VERSION) {
    throw new Error(`graph database schema ${version} is newer than supported schema ${GRAPH_SCHEMA_VERSION}`);
  }
  if (version === GRAPH_SCHEMA_VERSION) return;
  database.exec("BEGIN IMMEDIATE");
  try {
    if (version === 0) database.exec(schemaVersionOne);
    if (version <= 1) database.exec(schemaVersionTwo);
    database.exec(`PRAGMA user_version = ${GRAPH_SCHEMA_VERSION}`);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
function validateGraphDatabase(database) {
  database.exec("PRAGMA foreign_keys = ON");
  const integrityRows = database.prepare("PRAGMA integrity_check").all();
  if (integrityRows.length !== 1 || integrityRows[0]?.integrity_check !== "ok") {
    throw new Error(`graph database integrity check failed: ${integrityRows.map((row) => row.integrity_check).join(", ")}`);
  }
  const foreignKeyRows = database.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeyRows.length > 0) throw new Error("graph database foreign key check failed");
  if (databaseVersion(database) !== GRAPH_SCHEMA_VERSION) {
    throw new Error(`graph database schema is not version ${GRAPH_SCHEMA_VERSION}`);
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  GRAPH_SCHEMA_VERSION,
  migrateGraphSchema,
  validateGraphDatabase
});
