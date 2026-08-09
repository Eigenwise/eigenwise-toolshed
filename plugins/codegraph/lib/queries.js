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
var queries_exports = {};
__export(queries_exports, {
  context: () => context,
  hierarchy: () => hierarchy,
  impact: () => impact,
  modules: () => modules,
  resolveSymbolCandidates: () => resolveSymbolCandidates,
  shortestPath: () => shortestPath
});
module.exports = __toCommonJS(queries_exports);
var import_model = require("./model.ts");
var import_cursors = require("./cursors.ts");
var import_ranking = require("./ranking.ts");
function unavailable() {
  return { status: "missing", snapshot: null, coverage: null, results: [], omitted: 0, nextCursor: null, tokenEstimate: 0, message: "Codegraph has no indexed snapshot. Run codegraph_index first." };
}
function readyResponse(store, query, values, limits, cursor) {
  const snapshot = store.snapshot();
  if (snapshot === null) return unavailable();
  const applied = (0, import_ranking.applyQueryLimits)(limits);
  const offset = cursor === void 0 ? 0 : (0, import_cursors.decodeCursor)(cursor, snapshot.snapshotId, query);
  const ordered = (0, import_model.sortGraphResults)(values).slice(offset);
  const bounded = (0, import_ranking.boundResults)(ordered, applied.tokenBudget, applied.maxResults);
  const nextOffset = offset + bounded.results.length;
  return { status: "ready", snapshot, coverage: store.coverage(snapshot.snapshotId), results: bounded.results, omitted: bounded.omitted, nextCursor: bounded.omitted === 0 ? null : (0, import_cursors.encodeCursor)(snapshot.snapshotId, query, nextOffset), tokenEstimate: bounded.tokenEstimate, message: bounded.omitted === 0 ? "ok" : "result limit reached; use nextCursor" };
}
function resolveSymbolCandidates(store, selector) {
  const snapshot = store.snapshot();
  if (snapshot === null) return unavailable();
  const candidates = store.symbolCandidates(snapshot.snapshotId, selector.qualifiedName, selector.file, selector.kind).map((node) => ({ ...node, rank: 0 }));
  return readyResponse(store, { op: "candidates", selector }, candidates, { maxResults: 200 });
}
function matchingEdges(store, snapshotId, edgeKinds) {
  return store.edges(snapshotId).filter((edge) => edge.resolution === "resolved" && edge.targetId !== null && (edgeKinds === void 0 || edgeKinds.includes(edge.kind)));
}
function traversal(store, root, options) {
  const snapshot = store.snapshot();
  if (snapshot === null) return [];
  const limits = (0, import_ranking.applyQueryLimits)(options);
  const edges = matchingEdges(store, snapshot.snapshotId, options.edgeKinds);
  const nodes = new Map(store.nodes(snapshot.snapshotId).map((node) => [node.id, node]));
  const visited = /* @__PURE__ */ new Set([root.id]);
  const queue = [{ node: root, depth: 0, via: null }];
  const results = [];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === void 0) break;
    if (current.depth > 0) results.push({ ...current, rank: -current.depth, file: current.node.declaration.file, startLine: current.node.declaration.startLine, kind: current.node.kind, qualifiedName: current.node.qualifiedName, id: current.node.id });
    if (current.depth === limits.maxDepth) continue;
    for (const edge of edges) {
      const outgoing = edge.sourceId === current.node.id;
      const incoming = edge.targetId === current.node.id;
      const permitted = options.direction === "reverse" ? incoming : options.direction === "both" ? outgoing || incoming : outgoing;
      if (!permitted) continue;
      const nextId = outgoing ? edge.targetId : edge.sourceId;
      if (nextId === null || visited.has(nextId)) continue;
      const nextNode = nodes.get(nextId);
      if (nextNode === void 0) continue;
      visited.add(nextId);
      queue.push({ node: nextNode, depth: current.depth + 1, via: edge });
    }
  }
  return results;
}
function impact(store, selector, options = {}) {
  const snapshot = store.snapshot();
  if (snapshot === null) return unavailable();
  const candidates = store.symbolCandidates(snapshot.snapshotId, selector.qualifiedName, selector.file, selector.kind);
  if (candidates.length !== 1) return readyResponse(store, { op: "impact-candidates", selector }, candidates, options, options.cursor);
  return readyResponse(store, { op: "impact", selector, options: { ...options, cursor: void 0 } }, traversal(store, candidates[0], { ...options, direction: options.direction ?? "both" }), options, options.cursor);
}
function shortestPath(store, from, to, options = {}) {
  const snapshot = store.snapshot();
  if (snapshot === null) return unavailable();
  const sources = store.symbolCandidates(snapshot.snapshotId, from.qualifiedName, from.file, from.kind);
  const targets = store.symbolCandidates(snapshot.snapshotId, to.qualifiedName, to.file, to.kind);
  if (sources.length !== 1) return readyResponse(store, { op: "path-from-candidates", from }, sources, options, options.cursor);
  if (targets.length !== 1) return readyResponse(store, { op: "path-to-candidates", to }, targets, options, options.cursor);
  const source = sources[0];
  const target = targets[0];
  const limits = (0, import_ranking.applyQueryLimits)(options);
  const nodes = new Map(store.nodes(snapshot.snapshotId).map((node) => [node.id, node]));
  const edges = matchingEdges(store, snapshot.snapshotId, options.edgeKinds);
  const queue = [{ id: source.id, edges: [] }];
  const visited = /* @__PURE__ */ new Set([source.id]);
  let result = null;
  while (queue.length > 0 && result === null) {
    const current = queue.shift();
    if (current === void 0) break;
    if (current.id === target.id) {
      const pathNodes = [source];
      let cursor = source.id;
      for (const edge of current.edges) {
        cursor = edge.targetId ?? cursor;
        const node = nodes.get(cursor);
        if (node !== void 0) pathNodes.push(node);
      }
      result = { nodes: pathNodes, edges: current.edges, rank: -current.edges.length, file: source.declaration.file, startLine: source.declaration.startLine, kind: source.kind, qualifiedName: source.qualifiedName, id: `${source.id}:${target.id}` };
      break;
    }
    if (current.edges.length === limits.maxDepth) continue;
    for (const edge of edges) if (edge.sourceId === current.id && edge.targetId !== null && !visited.has(edge.targetId)) {
      visited.add(edge.targetId);
      queue.push({ id: edge.targetId, edges: [...current.edges, edge] });
    }
  }
  return readyResponse(store, { op: "path", from, to, options: { ...options, cursor: void 0 } }, result === null ? [] : [result], options, options.cursor);
}
function hierarchy(store, selector, options = {}) {
  return impact(store, selector, { ...options, edgeKinds: ["extends", "implements"], direction: options.direction ?? "both" });
}
function moduleEdges(store, snapshotId) {
  const adjacency = /* @__PURE__ */ new Map();
  for (const edge of matchingEdges(store, snapshotId, ["imports"])) {
    if (edge.targetFile === null || edge.targetFile === edge.sourceFile) continue;
    const targets = adjacency.get(edge.sourceFile) ?? /* @__PURE__ */ new Set();
    targets.add(edge.targetFile);
    adjacency.set(edge.sourceFile, targets);
    if (!adjacency.has(edge.targetFile)) adjacency.set(edge.targetFile, /* @__PURE__ */ new Set());
  }
  return adjacency;
}
function stronglyConnected(adjacency) {
  let index = 0;
  const indexes = /* @__PURE__ */ new Map();
  const lowlinks = /* @__PURE__ */ new Map();
  const stack = [];
  const active = /* @__PURE__ */ new Set();
  const output = [];
  const visit = (file) => {
    indexes.set(file, index);
    lowlinks.set(file, index);
    index += 1;
    stack.push(file);
    active.add(file);
    for (const target of adjacency.get(file) ?? []) {
      if (!indexes.has(target)) {
        visit(target);
        lowlinks.set(file, Math.min(lowlinks.get(file), lowlinks.get(target)));
      } else if (active.has(target)) lowlinks.set(file, Math.min(lowlinks.get(file), indexes.get(target)));
    }
    if (lowlinks.get(file) === indexes.get(file)) {
      const component = [];
      let member;
      do {
        member = stack.pop();
        if (member !== void 0) {
          active.delete(member);
          component.push(member);
        }
      } while (member !== file);
      output.push(component.sort());
    }
  };
  for (const file of [...adjacency.keys()].sort()) if (!indexes.has(file)) visit(file);
  return output;
}
function modules(store, mode, options = {}) {
  const snapshot = store.snapshot();
  if (snapshot === null) return unavailable();
  const adjacency = moduleEdges(store, snapshot.snapshotId);
  const components = stronglyConnected(adjacency);
  const results = [];
  if (mode === "cycles") {
    for (const component of components) if (component.length > 1) results.push({ files: component, value: component.length, rank: component.length, file: component[0], startLine: 0, kind: "cycle", qualifiedName: component.join(","), id: component.join("|") });
  }
  if (mode === "fanout") for (const [file, targets] of adjacency) results.push({ files: [file], value: targets.size, rank: targets.size, file, startLine: 0, kind: "fanout", qualifiedName: file, id: file });
  if (mode === "layers") {
    const componentByFile = /* @__PURE__ */ new Map();
    components.forEach((component, index) => component.forEach((file) => componentByFile.set(file, index)));
    const incoming = components.map(() => /* @__PURE__ */ new Set());
    for (const [source, targets] of adjacency) for (const target of targets) {
      const left = componentByFile.get(source);
      const right = componentByFile.get(target);
      if (left !== void 0 && right !== void 0 && left !== right) incoming[right].add(left);
    }
    const depths = components.map(() => 0);
    let changed = true;
    while (changed) {
      changed = false;
      for (let index = 0; index < components.length; index += 1) {
        const depth = Math.max(0, ...[...incoming[index]].map((parent) => depths[parent] + 1));
        if (depth !== depths[index]) {
          depths[index] = depth;
          changed = true;
        }
      }
    }
    components.forEach((component, index) => results.push({ files: component, value: depths[index], rank: -depths[index], file: component[0], startLine: 0, kind: "layer", qualifiedName: component.join(","), id: component.join("|") }));
  }
  return readyResponse(store, { op: "modules", mode }, results, options, options.cursor);
}
function context(store, query, options = {}) {
  const snapshot = store.snapshot();
  if (snapshot === null) return unavailable();
  const matches = store.lexicalMatches(snapshot.snapshotId, (0, import_ranking.queryTerms)(query));
  const selected = /* @__PURE__ */ new Map();
  for (const match of matches) selected.set(match.node.id, { node: match.node, score: match.score, reasons: match.terms.map((term) => `lexical:${term}`), depth: 0, rank: match.score, file: match.node.declaration.file, startLine: match.node.declaration.startLine, kind: match.node.kind, qualifiedName: match.node.qualifiedName, id: match.node.id });
  const edges = matchingEdges(store, snapshot.snapshotId);
  const nodes = new Map(store.nodes(snapshot.snapshotId).map((node) => [node.id, node]));
  const depthLimit = (0, import_ranking.applyQueryLimits)(options).maxDepth;
  let frontier = [...selected.values()];
  for (let depth = 1; depth <= depthLimit; depth += 1) {
    const next = [];
    for (const entry of frontier) for (const edge of edges) if (edge.sourceId === entry.node.id || edge.targetId === entry.node.id) {
      const id = edge.sourceId === entry.node.id ? edge.targetId : edge.sourceId;
      if (id === null || selected.has(id)) continue;
      const node = nodes.get(id);
      if (node === void 0) continue;
      const result = { node, score: entry.score - depth, reasons: [`graph:${edge.kind}`], depth, rank: entry.score - depth, file: node.declaration.file, startLine: node.declaration.startLine, kind: node.kind, qualifiedName: node.qualifiedName, id: node.id };
      selected.set(id, result);
      next.push(result);
    }
    frontier = next;
  }
  return readyResponse(store, { op: "context", query, options: { ...options, cursor: void 0 } }, [...selected.values()], options, options.cursor);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  context,
  hierarchy,
  impact,
  modules,
  resolveSymbolCandidates,
  shortestPath
});
