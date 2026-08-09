import type { GraphEdgeKind, GraphNodeKind, GraphResponse } from './model.ts';
import { sortGraphResults } from './model.ts';
import { decodeCursor, encodeCursor } from './cursors.ts';
import { applyQueryLimits, boundResults, queryTerms, type QueryLimits } from './ranking.ts';
import type { GraphStore, LexicalMatch, StoredEdge, StoredNode } from './store.ts';

export interface SymbolSelector { qualifiedName: string; file?: string; kind?: GraphNodeKind }
export interface TraversalStep { node: StoredNode; depth: number; via: StoredEdge | null; rank: number; file: string; startLine: number; kind: string; qualifiedName: string; id: string }
export interface PathResult { nodes: readonly StoredNode[]; edges: readonly StoredEdge[]; rank: number; file: string; startLine: number; kind: string; qualifiedName: string; id: string }
export interface ModuleResult { files: readonly string[]; value: number; rank: number; file: string; startLine: number; kind: string; qualifiedName: string; id: string }
export interface ContextResult { node: StoredNode; score: number; reasons: readonly string[]; depth: number; rank: number; file: string; startLine: number; kind: string; qualifiedName: string; id: string }

export interface TraversalOptions extends QueryLimits { direction?: 'forward' | 'reverse' | 'both'; edgeKinds?: readonly GraphEdgeKind[]; cursor?: string }

function unavailable<Result>(): GraphResponse<Result> {
  return { status: 'missing', snapshot: null, coverage: null, results: [], omitted: 0, nextCursor: null, tokenEstimate: 0, message: 'Codegraph has no indexed snapshot. Run codegraph_index first.' };
}

function readyResponse<Result extends { rank: number; file: string; startLine: number; kind: string; qualifiedName: string; id: string }>(store: GraphStore, query: unknown, values: readonly Result[], limits: QueryLimits, cursor?: string): GraphResponse<Result> {
  const snapshot = store.snapshot();
  if (snapshot === null) return unavailable<Result>();
  const applied = applyQueryLimits(limits);
  const offset = cursor === undefined ? 0 : decodeCursor(cursor, snapshot.snapshotId, query);
  const ordered = sortGraphResults(values).slice(offset);
  const bounded = boundResults(ordered, applied.tokenBudget, applied.maxResults);
  const nextOffset = offset + bounded.results.length;
  return { status: 'ready', snapshot, coverage: store.coverage(snapshot.snapshotId), results: bounded.results, omitted: bounded.omitted, nextCursor: bounded.omitted === 0 ? null : encodeCursor(snapshot.snapshotId, query, nextOffset), tokenEstimate: bounded.tokenEstimate, message: bounded.omitted === 0 ? 'ok' : 'result limit reached; use nextCursor' };
}

export function resolveSymbolCandidates(store: GraphStore, selector: SymbolSelector): GraphResponse<StoredNode> {
  const snapshot = store.snapshot();
  if (snapshot === null) return unavailable<StoredNode>();
  const candidates = store.symbolCandidates(snapshot.snapshotId, selector.qualifiedName, selector.file, selector.kind).map((node) => ({ ...node, rank: 0 }));
  return readyResponse(store, { op: 'candidates', selector }, candidates, { maxResults: 200 });
}

function matchingEdges(store: GraphStore, snapshotId: string, edgeKinds?: readonly GraphEdgeKind[]): StoredEdge[] {
  return store.edges(snapshotId).filter((edge) => edge.resolution === 'resolved' && edge.targetId !== null && (edgeKinds === undefined || edgeKinds.includes(edge.kind)));
}

function traversal(store: GraphStore, root: StoredNode, options: TraversalOptions): TraversalStep[] {
  const snapshot = store.snapshot();
  if (snapshot === null) return [];
  const limits = applyQueryLimits(options);
  const edges = matchingEdges(store, snapshot.snapshotId, options.edgeKinds);
  const nodes = new Map(store.nodes(snapshot.snapshotId).map((node) => [node.id, node]));
  const visited = new Set([root.id]);
  const queue: Array<{ node: StoredNode; depth: number; via: StoredEdge | null }> = [{ node: root, depth: 0, via: null }];
  const results: TraversalStep[] = [];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    if (current.depth > 0) results.push({ ...current, rank: -current.depth, file: current.node.declaration.file, startLine: current.node.declaration.startLine, kind: current.node.kind, qualifiedName: current.node.qualifiedName, id: current.node.id });
    if (current.depth === limits.maxDepth) continue;
    for (const edge of edges) {
      const outgoing = edge.sourceId === current.node.id;
      const incoming = edge.targetId === current.node.id;
      const permitted = options.direction === 'reverse' ? incoming : options.direction === 'both' ? outgoing || incoming : outgoing;
      if (!permitted) continue;
      const nextId = outgoing ? edge.targetId : edge.sourceId;
      if (nextId === null || visited.has(nextId)) continue;
      const nextNode = nodes.get(nextId);
      if (nextNode === undefined) continue;
      visited.add(nextId);
      queue.push({ node: nextNode, depth: current.depth + 1, via: edge });
    }
  }
  return results;
}

export function impact(store: GraphStore, selector: SymbolSelector, options: TraversalOptions = {}): GraphResponse<TraversalStep | StoredNode> {
  const snapshot = store.snapshot();
  if (snapshot === null) return unavailable<TraversalStep | StoredNode>();
  const candidates = store.symbolCandidates(snapshot.snapshotId, selector.qualifiedName, selector.file, selector.kind);
  if (candidates.length !== 1) return readyResponse(store, { op: 'impact-candidates', selector }, candidates, options, options.cursor);
  return readyResponse(store, { op: 'impact', selector, options: { ...options, cursor: undefined } }, traversal(store, candidates[0]!, { ...options, direction: options.direction ?? 'both' }), options, options.cursor);
}

export function shortestPath(store: GraphStore, from: SymbolSelector, to: SymbolSelector, options: Omit<TraversalOptions, 'direction'> = {}): GraphResponse<PathResult | StoredNode> {
  const snapshot = store.snapshot();
  if (snapshot === null) return unavailable<PathResult | StoredNode>();
  const sources = store.symbolCandidates(snapshot.snapshotId, from.qualifiedName, from.file, from.kind);
  const targets = store.symbolCandidates(snapshot.snapshotId, to.qualifiedName, to.file, to.kind);
  if (sources.length !== 1) return readyResponse(store, { op: 'path-from-candidates', from }, sources, options, options.cursor);
  if (targets.length !== 1) return readyResponse(store, { op: 'path-to-candidates', to }, targets, options, options.cursor);
  const source = sources[0]!; const target = targets[0]!;
  const limits = applyQueryLimits(options);
  const nodes = new Map(store.nodes(snapshot.snapshotId).map((node) => [node.id, node]));
  const edges = matchingEdges(store, snapshot.snapshotId, options.edgeKinds);
  const queue: Array<{ id: string; edges: StoredEdge[] }> = [{ id: source.id, edges: [] }];
  const visited = new Set([source.id]); let result: PathResult | null = null;
  while (queue.length > 0 && result === null) {
    const current = queue.shift(); if (current === undefined) break;
    if (current.id === target.id) {
      const pathNodes = [source]; let cursor = source.id;
      for (const edge of current.edges) { cursor = edge.targetId ?? cursor; const node = nodes.get(cursor); if (node !== undefined) pathNodes.push(node); }
      result = { nodes: pathNodes, edges: current.edges, rank: -current.edges.length, file: source.declaration.file, startLine: source.declaration.startLine, kind: source.kind, qualifiedName: source.qualifiedName, id: `${source.id}:${target.id}` };
      break;
    }
    if (current.edges.length === limits.maxDepth) continue;
    for (const edge of edges) if (edge.sourceId === current.id && edge.targetId !== null && !visited.has(edge.targetId)) { visited.add(edge.targetId); queue.push({ id: edge.targetId, edges: [...current.edges, edge] }); }
  }
  return readyResponse(store, { op: 'path', from, to, options: { ...options, cursor: undefined } }, result === null ? [] : [result], options, options.cursor);
}

export function hierarchy(store: GraphStore, selector: SymbolSelector, options: Omit<TraversalOptions, 'edgeKinds'> = {}): GraphResponse<TraversalStep | StoredNode> {
  return impact(store, selector, { ...options, edgeKinds: ['extends', 'implements'], direction: options.direction ?? 'both' });
}

function moduleEdges(store: GraphStore, snapshotId: string): Map<string, Set<string>> {
  const adjacency = new Map<string, Set<string>>();
  for (const edge of matchingEdges(store, snapshotId, ['imports'])) {
    if (edge.targetFile === null || edge.targetFile === edge.sourceFile) continue;
    const targets = adjacency.get(edge.sourceFile) ?? new Set<string>(); targets.add(edge.targetFile); adjacency.set(edge.sourceFile, targets);
    if (!adjacency.has(edge.targetFile)) adjacency.set(edge.targetFile, new Set());
  }
  return adjacency;
}

function stronglyConnected(adjacency: Map<string, Set<string>>): string[][] {
  let index = 0; const indexes = new Map<string, number>(); const lowlinks = new Map<string, number>(); const stack: string[] = []; const active = new Set<string>(); const output: string[][] = [];
  const visit = (file: string): void => { indexes.set(file, index); lowlinks.set(file, index); index += 1; stack.push(file); active.add(file); for (const target of adjacency.get(file) ?? []) { if (!indexes.has(target)) { visit(target); lowlinks.set(file, Math.min(lowlinks.get(file)!, lowlinks.get(target)!)); } else if (active.has(target)) lowlinks.set(file, Math.min(lowlinks.get(file)!, indexes.get(target)!)); } if (lowlinks.get(file) === indexes.get(file)) { const component: string[] = []; let member: string | undefined; do { member = stack.pop(); if (member !== undefined) { active.delete(member); component.push(member); } } while (member !== file); output.push(component.sort()); } };
  for (const file of [...adjacency.keys()].sort()) if (!indexes.has(file)) visit(file);
  return output;
}

export function modules(store: GraphStore, mode: 'cycles' | 'layers' | 'fanout', options: QueryLimits & { cursor?: string } = {}): GraphResponse<ModuleResult> {
  const snapshot = store.snapshot(); if (snapshot === null) return unavailable<ModuleResult>();
  const adjacency = moduleEdges(store, snapshot.snapshotId); const components = stronglyConnected(adjacency);
  const results: ModuleResult[] = [];
  if (mode === 'cycles') for (const component of components) if (component.length > 1) results.push({ files: component, value: component.length, rank: component.length, file: component[0]!, startLine: 0, kind: 'cycle', qualifiedName: component.join(','), id: component.join('|') });
  if (mode === 'fanout') for (const [file, targets] of adjacency) results.push({ files: [file], value: targets.size, rank: targets.size, file, startLine: 0, kind: 'fanout', qualifiedName: file, id: file });
  if (mode === 'layers') { const componentByFile = new Map<string, number>(); components.forEach((component, index) => component.forEach((file) => componentByFile.set(file, index))); const incoming = components.map(() => new Set<number>()); for (const [source, targets] of adjacency) for (const target of targets) { const left = componentByFile.get(source); const right = componentByFile.get(target); if (left !== undefined && right !== undefined && left !== right) incoming[right]!.add(left); } const depths = components.map(() => 0); let changed = true; while (changed) { changed = false; for (let index = 0; index < components.length; index += 1) { const depth = Math.max(0, ...[...incoming[index]!].map((parent) => depths[parent]! + 1)); if (depth !== depths[index]) { depths[index] = depth; changed = true; } } } components.forEach((component, index) => results.push({ files: component, value: depths[index]!, rank: -depths[index]!, file: component[0]!, startLine: 0, kind: 'layer', qualifiedName: component.join(','), id: component.join('|') })); }
  return readyResponse(store, { op: 'modules', mode }, results, options, options.cursor);
}

export function context(store: GraphStore, query: string, options: QueryLimits & { seedFiles?: readonly string[]; maxDepth?: number; cursor?: string } = {}): GraphResponse<ContextResult> {
  const snapshot = store.snapshot(); if (snapshot === null) return unavailable<ContextResult>();
  const matches = store.lexicalMatches(snapshot.snapshotId, queryTerms(query)); const selected = new Map<string, ContextResult>();
  for (const match of matches) selected.set(match.node.id, { node: match.node, score: match.score, reasons: match.terms.map((term) => `lexical:${term}`), depth: 0, rank: match.score, file: match.node.declaration.file, startLine: match.node.declaration.startLine, kind: match.node.kind, qualifiedName: match.node.qualifiedName, id: match.node.id });
  const edges = matchingEdges(store, snapshot.snapshotId); const nodes = new Map(store.nodes(snapshot.snapshotId).map((node) => [node.id, node])); const depthLimit = applyQueryLimits(options).maxDepth;
  let frontier = [...selected.values()];
  for (let depth = 1; depth <= depthLimit; depth += 1) { const next: ContextResult[] = []; for (const entry of frontier) for (const edge of edges) if (edge.sourceId === entry.node.id || edge.targetId === entry.node.id) { const id = edge.sourceId === entry.node.id ? edge.targetId : edge.sourceId; if (id === null || selected.has(id)) continue; const node = nodes.get(id); if (node === undefined) continue; const result: ContextResult = { node, score: entry.score - depth, reasons: [`graph:${edge.kind}`], depth, rank: entry.score - depth, file: node.declaration.file, startLine: node.declaration.startLine, kind: node.kind, qualifiedName: node.qualifiedName, id: node.id }; selected.set(id, result); next.push(result); } frontier = next; }
  return readyResponse(store, { op: 'context', query, options: { ...options, cursor: undefined } }, [...selected.values()], options, options.cursor);
}
