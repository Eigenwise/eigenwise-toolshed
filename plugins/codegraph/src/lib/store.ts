import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { FileGraph, GraphCoverage, GraphEdge, GraphNode, GraphResultOrder, ProjectDescriptor, SnapshotIdentity } from './model.ts';
import { normalizeProjectRelativePath } from './paths.ts';
import { migrateGraphSchema, validateGraphDatabase } from './schema.ts';

export interface GraphSnapshotInput {
  snapshot: SnapshotIdentity;
  projects: readonly ProjectDescriptor[];
  files: readonly FileGraph[];
}

export interface StoredNode extends GraphNode, Omit<GraphResultOrder, 'kind'> { rank: number }
export interface StoredEdge extends GraphEdge { readonly sourceFile: string; readonly targetFile: string | null }
export interface LexicalMatch { node: StoredNode; score: number; terms: readonly string[] }

interface NodeRow {
  node_id: string; extractor: string; language: string; kind: GraphNode['kind']; name: string;
  qualified_name: string; project_id: string; file: string; start_line: number; start_column: number;
  end_line: number; end_column: number; exported: number; content_hash: string;
}
interface EdgeRow {
  edge_id: string; kind: GraphEdge['kind']; source_id: string; target_id: string | null;
  resolution: GraphEdge['resolution']; evidence_file: string; start_line: number; start_column: number;
  end_line: number; end_column: number; reason: string | null; source_file: string; target_file: string | null;
}

function nodeFromRow(row: NodeRow, rank = 0): StoredNode {
  return {
    id: row.node_id, extractor: row.extractor, language: row.language, kind: row.kind, name: row.name,
    qualifiedName: row.qualified_name, projectId: row.project_id,
    declaration: { file: row.file, startLine: row.start_line, startColumn: row.start_column, endLine: row.end_line, endColumn: row.end_column },
    exported: row.exported === 1, contentHash: row.content_hash, rank, file: row.file, startLine: row.start_line,
  };
}

function edgeFromRow(row: EdgeRow): StoredEdge {
  return {
    id: row.edge_id, kind: row.kind, sourceId: row.source_id, targetId: row.target_id, resolution: row.resolution,
    evidence: { file: row.evidence_file, startLine: row.start_line, startColumn: row.start_column, endLine: row.end_line, endColumn: row.end_column },
    ...(row.reason === null ? {} : { reason: row.reason }), sourceFile: row.source_file, targetFile: row.target_file,
  };
}

function rankingTerms(value: string): string[] {
  return [...new Set(value.split(/[^a-z0-9]+|(?<=[a-z])(?=[A-Z])/).map((term) => term.toLowerCase()).filter((term) => term.length > 0))];
}

export class GraphStore {
  readonly database: DatabaseSync;

  private constructor(database: DatabaseSync) { this.database = database; }

  static open(databasePath: string): GraphStore {
    if (databasePath !== ':memory:') mkdirSync(path.dirname(databasePath), { recursive: true });
    const database = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true, timeout: 5_000 });
    migrateGraphSchema(database);
    validateGraphDatabase(database);
    return new GraphStore(database);
  }

  close(): void { this.database.close(); }

  validate(): void { validateGraphDatabase(this.database); }

  replaceSnapshot(input: GraphSnapshotInput): void {
    const { snapshot } = input;
    if (snapshot.schemaVersion !== 1) throw new Error(`cannot write schema version ${snapshot.schemaVersion}`);
    const files = input.files.map((fileGraph) => ({ ...fileGraph, file: normalizeProjectRelativePath(fileGraph.file) }));
    const allNodeIds = new Set<string>();
    for (const fileGraph of files) for (const node of fileGraph.nodes) {
      if (allNodeIds.has(node.id)) throw new Error(`duplicate node id: ${node.id}`);
      allNodeIds.add(node.id);
      if (normalizeProjectRelativePath(node.declaration.file) !== fileGraph.file) throw new Error(`node ${node.id} is not owned by ${fileGraph.file}`);
    }
    for (const fileGraph of files) for (const edge of fileGraph.edges) {
      if (!allNodeIds.has(edge.sourceId)) throw new Error(`edge ${edge.id} source is not file-owned: ${edge.sourceId}`);
      if (edge.targetId !== null && !allNodeIds.has(edge.targetId)) throw new Error(`edge ${edge.id} target is not in snapshot: ${edge.targetId}`);
      if (normalizeProjectRelativePath(edge.evidence.file) !== fileGraph.file) throw new Error(`edge ${edge.id} evidence is not owned by ${fileGraph.file}`);
    }
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.exec('DELETE FROM snapshots');
      this.database.prepare('INSERT INTO snapshots VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(snapshot.snapshotId, snapshot.schemaVersion, snapshot.projectRootHash, snapshot.sourceManifestHash, snapshot.configHash, snapshot.engineId, snapshot.engineVersion, snapshot.indexedAt);
      const addProject = this.database.prepare('INSERT INTO projects VALUES (?, ?, ?, ?, ?)');
      for (const project of input.projects) addProject.run(snapshot.snapshotId, project.id, project.root, project.configFile, project.language);
      const addFile = this.database.prepare('INSERT INTO files VALUES (?, ?, ?, ?, ?)');
      const addNode = this.database.prepare('INSERT INTO nodes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      const addOwnership = this.database.prepare('INSERT INTO file_ownership VALUES (?, ?, ?)');
      const addTerm = this.database.prepare('INSERT INTO lexical_terms VALUES (?, ?, ?, ?)');
      const addEdge = this.database.prepare('INSERT INTO edges VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
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
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    this.validate();
  }

  snapshot(): SnapshotIdentity | null {
    const row = this.database.prepare('SELECT * FROM snapshots ORDER BY indexed_at DESC, snapshot_id ASC LIMIT 1').get() as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    return { schemaVersion: row.schema_version as number, snapshotId: row.snapshot_id as string, projectRootHash: row.project_root_hash as string, sourceManifestHash: row.source_manifest_hash as string, configHash: row.config_hash as string, engineId: row.engine_id as string, engineVersion: row.engine_version as string, indexedAt: row.indexed_at as string };
  }

  coverage(snapshotId = this.snapshot()?.snapshotId): GraphCoverage | null {
    if (snapshotId === undefined) return null;
    const row = this.database.prepare(`SELECT (SELECT count(*) FROM projects WHERE snapshot_id = ?) projects, (SELECT count(*) FROM files WHERE snapshot_id = ?) files, (SELECT count(*) FROM nodes WHERE snapshot_id = ?) nodes, (SELECT count(*) FROM edges WHERE snapshot_id = ?) edges, (SELECT count(*) FROM edges WHERE snapshot_id = ? AND resolution = 'unresolved') unresolvedEdges, (SELECT count(*) FROM edges WHERE snapshot_id = ? AND resolution = 'ambiguous') ambiguousEdges, (SELECT count(*) FROM edges WHERE snapshot_id = ? AND resolution = 'dynamic') dynamicEdges, (SELECT count(*) FROM edges WHERE snapshot_id = ? AND resolution = 'external') externalEdges`).get(snapshotId, snapshotId, snapshotId, snapshotId, snapshotId, snapshotId, snapshotId, snapshotId) as unknown as GraphCoverage;
    return { ...row };
  }

  node(snapshotId: string, nodeId: string): StoredNode | null {
    const row = this.database.prepare('SELECT * FROM nodes WHERE snapshot_id = ? AND node_id = ?').get(snapshotId, nodeId) as NodeRow | undefined;
    return row === undefined ? null : nodeFromRow(row);
  }

  nodes(snapshotId: string): StoredNode[] {
    return (this.database.prepare('SELECT * FROM nodes WHERE snapshot_id = ?').all(snapshotId) as unknown as NodeRow[]).map((row) => nodeFromRow(row));
  }

  symbolCandidates(snapshotId: string, qualifiedName: string, file?: string, kind?: GraphNode['kind']): StoredNode[] {
    const rows = this.database.prepare('SELECT * FROM nodes WHERE snapshot_id = ? AND qualified_name = ? AND (? IS NULL OR file = ?) AND (? IS NULL OR kind = ?) ORDER BY file, start_line, kind, qualified_name, node_id').all(snapshotId, qualifiedName, file ?? null, file ?? null, kind ?? null, kind ?? null) as unknown as NodeRow[];
    return rows.map((row) => nodeFromRow(row));
  }

  edges(snapshotId: string): StoredEdge[] {
    const rows = this.database.prepare(`SELECT edges.*, source.file source_file, target.file target_file FROM edges JOIN nodes source ON source.snapshot_id = edges.snapshot_id AND source.node_id = edges.source_id LEFT JOIN nodes target ON target.snapshot_id = edges.snapshot_id AND target.node_id = edges.target_id WHERE edges.snapshot_id = ? ORDER BY edges.edge_id`).all(snapshotId) as unknown as EdgeRow[];
    return rows.map(edgeFromRow);
  }

  lexicalMatches(snapshotId: string, terms: readonly string[]): LexicalMatch[] {
    if (terms.length === 0) return [];
    const placeholders = terms.map(() => '?').join(', ');
    const rows = this.database.prepare(`SELECT nodes.*, sum(lexical_terms.weight) score, group_concat(lexical_terms.term) matched_terms FROM lexical_terms JOIN nodes ON nodes.snapshot_id = lexical_terms.snapshot_id AND nodes.node_id = lexical_terms.node_id WHERE lexical_terms.snapshot_id = ? AND lexical_terms.term IN (${placeholders}) GROUP BY nodes.node_id ORDER BY score DESC, nodes.file, nodes.start_line, nodes.kind, nodes.qualified_name, nodes.node_id`).all(snapshotId, ...terms) as unknown as Array<NodeRow & { score: number; matched_terms: string }>;
    return rows.map((row) => ({ node: nodeFromRow(row, row.score), score: row.score, terms: row.matched_terms.split(',').sort() }));
  }
}
