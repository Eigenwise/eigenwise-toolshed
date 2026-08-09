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
var store_exports = {};
__export(store_exports, {
  GraphStore: () => GraphStore
});
module.exports = __toCommonJS(store_exports);
var import_node_fs = require("node:fs");
var import_node_path = __toESM(require("node:path"));
var import_node_sqlite = require("node:sqlite");
var import_paths = require("./paths.ts");
var import_schema = require("./schema.ts");
function nodeFromRow(row, rank = 0) {
  return {
    id: row.node_id,
    extractor: row.extractor,
    language: row.language,
    kind: row.kind,
    name: row.name,
    qualifiedName: row.qualified_name,
    projectId: row.project_id,
    declaration: { file: row.file, startLine: row.start_line, startColumn: row.start_column, endLine: row.end_line, endColumn: row.end_column },
    exported: row.exported === 1,
    contentHash: row.content_hash,
    rank,
    file: row.file,
    startLine: row.start_line
  };
}
function edgeFromRow(row) {
  return {
    id: row.edge_id,
    kind: row.kind,
    sourceId: row.source_id,
    targetId: row.target_id,
    resolution: row.resolution,
    evidence: { file: row.evidence_file, startLine: row.start_line, startColumn: row.start_column, endLine: row.end_line, endColumn: row.end_column },
    ...row.reason === null ? {} : { reason: row.reason },
    sourceFile: row.source_file,
    targetFile: row.target_file
  };
}
function rankingTerms(value) {
  return [...new Set(value.split(/[^a-z0-9]+|(?<=[a-z])(?=[A-Z])/).map((term) => term.toLowerCase()).filter((term) => term.length > 0))];
}
class GraphStore {
  database;
  constructor(database) {
    this.database = database;
  }
  static open(databasePath) {
    if (databasePath !== ":memory:") (0, import_node_fs.mkdirSync)(import_node_path.default.dirname(databasePath), { recursive: true });
    const database = new import_node_sqlite.DatabaseSync(databasePath, { enableForeignKeyConstraints: true, timeout: 5e3 });
    (0, import_schema.migrateGraphSchema)(database);
    (0, import_schema.validateGraphDatabase)(database);
    return new GraphStore(database);
  }
  close() {
    this.database.close();
  }
  validate() {
    (0, import_schema.validateGraphDatabase)(this.database);
  }
  replaceSnapshot(input) {
    const { snapshot } = input;
    if (snapshot.schemaVersion !== 1) throw new Error(`cannot write schema version ${snapshot.schemaVersion}`);
    const files = input.files.map((fileGraph) => ({ ...fileGraph, file: (0, import_paths.normalizeProjectRelativePath)(fileGraph.file) }));
    const allNodeIds = /* @__PURE__ */ new Set();
    for (const fileGraph of files) for (const node of fileGraph.nodes) {
      if (allNodeIds.has(node.id)) throw new Error(`duplicate node id: ${node.id}`);
      allNodeIds.add(node.id);
      if ((0, import_paths.normalizeProjectRelativePath)(node.declaration.file) !== fileGraph.file) throw new Error(`node ${node.id} is not owned by ${fileGraph.file}`);
    }
    for (const fileGraph of files) for (const edge of fileGraph.edges) {
      if (!allNodeIds.has(edge.sourceId)) throw new Error(`edge ${edge.id} source is not file-owned: ${edge.sourceId}`);
      if (edge.targetId !== null && !allNodeIds.has(edge.targetId)) throw new Error(`edge ${edge.id} target is not in snapshot: ${edge.targetId}`);
      if ((0, import_paths.normalizeProjectRelativePath)(edge.evidence.file) !== fileGraph.file) throw new Error(`edge ${edge.id} evidence is not owned by ${fileGraph.file}`);
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.exec("DELETE FROM snapshots");
      this.database.prepare("INSERT INTO snapshots VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(snapshot.snapshotId, snapshot.schemaVersion, snapshot.projectRootHash, snapshot.sourceManifestHash, snapshot.configHash, snapshot.engineId, snapshot.engineVersion, snapshot.indexedAt);
      const addProject = this.database.prepare("INSERT INTO projects VALUES (?, ?, ?, ?, ?)");
      for (const project of input.projects) addProject.run(snapshot.snapshotId, project.id, project.root, project.configFile, project.language);
      const addFile = this.database.prepare("INSERT INTO files VALUES (?, ?, ?, ?, ?)");
      const addNode = this.database.prepare("INSERT INTO nodes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      const addOwnership = this.database.prepare("INSERT INTO file_ownership VALUES (?, ?, ?)");
      const addTerm = this.database.prepare("INSERT INTO lexical_terms VALUES (?, ?, ?, ?)");
      const addEdge = this.database.prepare("INSERT INTO edges VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      for (const fileGraph of files) {
        addFile.run(snapshot.snapshotId, fileGraph.file, fileGraph.contentHash, JSON.stringify(fileGraph.diagnostics), fileGraph.unresolvedCount);
      }
      for (const fileGraph of files) {
        for (const node of fileGraph.nodes) {
          const declaration = node.declaration;
          addNode.run(snapshot.snapshotId, node.id, node.projectId, node.extractor, node.language, node.kind, node.name, node.qualifiedName, fileGraph.file, declaration.startLine, declaration.startColumn, declaration.endLine, declaration.endColumn, node.exported ? 1 : 0, node.contentHash);
          addOwnership.run(snapshot.snapshotId, fileGraph.file, node.id);
          for (const term of rankingTerms(`${node.name} ${node.qualifiedName}`)) addTerm.run(snapshot.snapshotId, node.id, term, term === node.name.toLowerCase() ? 2 : 1);
        }
      }
      for (const fileGraph of files) {
        for (const edge of fileGraph.edges) {
          const evidence = edge.evidence;
          addEdge.run(snapshot.snapshotId, edge.id, edge.kind, edge.sourceId, edge.targetId, edge.resolution, fileGraph.file, evidence.startLine, evidence.startColumn, evidence.endLine, evidence.endColumn, edge.reason ?? null);
        }
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    this.validate();
  }
  snapshot() {
    const row = this.database.prepare("SELECT * FROM snapshots ORDER BY indexed_at DESC, snapshot_id ASC LIMIT 1").get();
    if (row === void 0) return null;
    return { schemaVersion: row.schema_version, snapshotId: row.snapshot_id, projectRootHash: row.project_root_hash, sourceManifestHash: row.source_manifest_hash, configHash: row.config_hash, engineId: row.engine_id, engineVersion: row.engine_version, indexedAt: row.indexed_at };
  }
  coverage(snapshotId = this.snapshot()?.snapshotId) {
    if (snapshotId === void 0) return null;
    const row = this.database.prepare(`SELECT (SELECT count(*) FROM projects WHERE snapshot_id = ?) projects, (SELECT count(*) FROM files WHERE snapshot_id = ?) files, (SELECT count(*) FROM nodes WHERE snapshot_id = ?) nodes, (SELECT count(*) FROM edges WHERE snapshot_id = ?) edges, (SELECT count(*) FROM edges WHERE snapshot_id = ? AND resolution = 'unresolved') unresolvedEdges, (SELECT count(*) FROM edges WHERE snapshot_id = ? AND resolution = 'ambiguous') ambiguousEdges, (SELECT count(*) FROM edges WHERE snapshot_id = ? AND resolution = 'dynamic') dynamicEdges, (SELECT count(*) FROM edges WHERE snapshot_id = ? AND resolution = 'external') externalEdges`).get(snapshotId, snapshotId, snapshotId, snapshotId, snapshotId, snapshotId, snapshotId, snapshotId);
    return { ...row };
  }
  node(snapshotId, nodeId) {
    const row = this.database.prepare("SELECT * FROM nodes WHERE snapshot_id = ? AND node_id = ?").get(snapshotId, nodeId);
    return row === void 0 ? null : nodeFromRow(row);
  }
  nodes(snapshotId) {
    return this.database.prepare("SELECT * FROM nodes WHERE snapshot_id = ?").all(snapshotId).map((row) => nodeFromRow(row));
  }
  symbolCandidates(snapshotId, qualifiedName, file, kind) {
    const rows = this.database.prepare("SELECT * FROM nodes WHERE snapshot_id = ? AND qualified_name = ? AND (? IS NULL OR file = ?) AND (? IS NULL OR kind = ?) ORDER BY file, start_line, kind, qualified_name, node_id").all(snapshotId, qualifiedName, file ?? null, file ?? null, kind ?? null, kind ?? null);
    return rows.map((row) => nodeFromRow(row));
  }
  edges(snapshotId) {
    const rows = this.database.prepare(`SELECT edges.*, source.file source_file, target.file target_file FROM edges JOIN nodes source ON source.snapshot_id = edges.snapshot_id AND source.node_id = edges.source_id LEFT JOIN nodes target ON target.snapshot_id = edges.snapshot_id AND target.node_id = edges.target_id WHERE edges.snapshot_id = ? ORDER BY edges.edge_id`).all(snapshotId);
    return rows.map(edgeFromRow);
  }
  lexicalMatches(snapshotId, terms) {
    if (terms.length === 0) return [];
    const placeholders = terms.map(() => "?").join(", ");
    const rows = this.database.prepare(`SELECT nodes.*, sum(lexical_terms.weight) score, group_concat(lexical_terms.term) matched_terms FROM lexical_terms JOIN nodes ON nodes.snapshot_id = lexical_terms.snapshot_id AND nodes.node_id = lexical_terms.node_id WHERE lexical_terms.snapshot_id = ? AND lexical_terms.term IN (${placeholders}) GROUP BY nodes.node_id ORDER BY score DESC, nodes.file, nodes.start_line, nodes.kind, nodes.qualified_name, nodes.node_id`).all(snapshotId, ...terms);
    return rows.map((row) => ({ node: nodeFromRow(row, row.score), score: row.score, terms: row.matched_terms.split(",").sort() }));
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  GraphStore
});
