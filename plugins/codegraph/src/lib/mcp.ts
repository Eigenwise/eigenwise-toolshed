import { maximumCursorBytes } from './cursors.js';
import { maximumResponseBytes } from './ranking.js';
import type { GraphEdgeKind, GraphNodeKind } from './model.js';
import { CodegraphService } from './service.js';

export const codegraphTools = [
  'codegraph_status',
  'codegraph_index',
  'codegraph_impact',
  'codegraph_path',
  'codegraph_hierarchy',
  'codegraph_modules',
  'codegraph_context',
] as const;

export type CodegraphTool = typeof codegraphTools[number];

type JsonObject = Record<string, unknown>;

const edgeKinds = new Set<GraphEdgeKind>(['contains', 'imports', 'exports', 'references', 'calls', 'extends', 'implements', 'overrides', 'aliases']);
const nodeKinds = new Set<GraphNodeKind>(['module', 'namespace', 'class', 'interface', 'type', 'enum', 'function', 'method', 'constructor', 'property', 'variable', 'parameter']);

function object(value: unknown, label: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as JsonObject;
}

function onlyKeys(value: JsonObject, keys: readonly string[]): void {
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`unknown parameter: ${key}`);
}

const maximumMcpTextBytes = 64 * 1_024;
const maximumSeedFiles = 1_000;

function text(value: unknown, label: string, minimum = 1, maximumBytes = maximumMcpTextBytes): string {
  if (typeof value !== 'string' || value.trim().length < minimum) throw new Error(`${label} must be a non-empty string`);
  if (Buffer.byteLength(value, 'utf8') > maximumBytes) throw new Error(`${label} exceeds the input budget`);
  return value;
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new Error(`${label} must be an integer from ${minimum} through ${maximum}`);
  return value as number;
}

function optionalText(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : text(value, label);
}

function selector(value: unknown, label: string): { qualifiedName: string; file?: string; kind?: GraphNodeKind } {
  const input = object(value, label);
  onlyKeys(input, ['qualifiedName', 'file', 'kind']);
  const kind = input.kind;
  if (kind !== undefined && (typeof kind !== 'string' || !nodeKinds.has(kind as GraphNodeKind))) throw new Error(`${label}.kind is invalid`);
  return { qualifiedName: text(input.qualifiedName, `${label}.qualifiedName`), ...(input.file === undefined ? {} : { file: text(input.file, `${label}.file`) }), ...(kind === undefined ? {} : { kind: kind as GraphNodeKind }) };
}

function limits(value: JsonObject, allowed: readonly string[]): { maxDepth?: number; tokenBudget?: number; maxResults?: number; cursor?: string } {
  onlyKeys(value, allowed);
  return {
    ...(value.maxDepth === undefined ? {} : { maxDepth: integer(value.maxDepth, 'maxDepth', 1, 8) }),
    ...(value.tokenBudget === undefined ? {} : { tokenBudget: integer(value.tokenBudget, 'tokenBudget', 500, 16_000) }),
    ...(value.maxResults === undefined ? {} : { maxResults: integer(value.maxResults, 'maxResults', 1, 1_000) }),
    ...(value.cursor === undefined ? {} : { cursor: text(value.cursor, 'cursor', 1, maximumCursorBytes) }),
  };
}

function traversal(value: JsonObject, allowed: readonly string[]): { direction?: 'forward' | 'reverse' | 'both'; edgeKinds?: GraphEdgeKind[]; maxDepth?: number; tokenBudget?: number; maxResults?: number; cursor?: string } {
  const parsed = limits(value, allowed);
  const direction = value.direction;
  if (direction !== undefined && direction !== 'forward' && direction !== 'reverse' && direction !== 'both') throw new Error('direction must be forward, reverse, or both');
  const kinds = value.edgeKinds;
  if (kinds !== undefined && (!Array.isArray(kinds) || kinds.some((kind) => typeof kind !== 'string' || !edgeKinds.has(kind as GraphEdgeKind)))) throw new Error('edgeKinds contains an invalid edge kind');
  return { ...parsed, ...(direction === undefined ? {} : { direction }), ...(kinds === undefined ? {} : { edgeKinds: [...kinds] as GraphEdgeKind[] }) };
}

function result(response: unknown): { content: [{ type: 'text'; text: string }]; structuredContent: unknown; isError?: boolean } {
  const serialized = JSON.stringify(response);
  if (Buffer.byteLength(serialized, 'utf8') > maximumResponseBytes) throw new Error('Codegraph response exceeded the output budget');
  const status = object(response, 'response').status;
  return { content: [{ type: 'text', text: serialized }], structuredContent: response, ...(status === 'error' || status === 'unavailable' ? { isError: true } : {}) };
}

export async function invokeCodegraphTool(service: CodegraphService, name: string, arguments_: unknown = {}): Promise<ReturnType<typeof result>> {
  const input = object(arguments_, 'arguments');
  if (!codegraphTools.includes(name as CodegraphTool)) throw new Error(`unknown Codegraph tool: ${name}`);
  if (name === 'codegraph_status') { onlyKeys(input, []); return result(await service.status()); }
  if (name === 'codegraph_index') { onlyKeys(input, []); return result(await service.index()); }
  if (name === 'codegraph_impact') {
    onlyKeys(input, ['symbol', 'direction', 'edgeKinds', 'maxDepth', 'tokenBudget', 'maxResults', 'cursor']);
    const { symbol, ...options } = input;
    return result(await service.impact(selector(symbol, 'symbol'), traversal(options, ['direction', 'edgeKinds', 'maxDepth', 'tokenBudget', 'maxResults', 'cursor'])));
  }
  if (name === 'codegraph_path') {
    onlyKeys(input, ['from', 'to', 'edgeKinds', 'maxDepth', 'tokenBudget', 'maxResults', 'cursor']);
    const { from, to, ...options } = input;
    return result(await service.path(selector(from, 'from'), selector(to, 'to'), traversal(options, ['edgeKinds', 'maxDepth', 'tokenBudget', 'maxResults', 'cursor'])));
  }
  if (name === 'codegraph_hierarchy') {
    onlyKeys(input, ['symbol', 'direction', 'maxDepth', 'tokenBudget', 'maxResults', 'cursor']);
    const { symbol, ...options } = input;
    return result(await service.hierarchy(selector(symbol, 'symbol'), traversal(options, ['direction', 'maxDepth', 'tokenBudget', 'maxResults', 'cursor'])));
  }
  if (name === 'codegraph_modules') {
    onlyKeys(input, ['mode', 'tokenBudget', 'maxResults', 'cursor']);
    const mode = input.mode;
    if (mode !== 'cycles' && mode !== 'layers' && mode !== 'fanout') throw new Error('mode must be cycles, layers, or fanout');
    return result(await service.modules(mode, limits(input, ['mode', 'tokenBudget', 'maxResults', 'cursor'])));
  }
  onlyKeys(input, ['query', 'seedFiles', 'maxDepth', 'tokenBudget', 'maxResults', 'cursor']);
  if (input.seedFiles !== undefined) {
    if (!Array.isArray(input.seedFiles) || input.seedFiles.length > maximumSeedFiles) throw new Error(`seedFiles must contain at most ${maximumSeedFiles} entries`);
    for (const file of input.seedFiles) text(file, 'seedFiles entry', 1);
  }
  return result(await service.context(text(input.query, 'query'), { ...limits(input, ['query', 'seedFiles', 'maxDepth', 'tokenBudget', 'maxResults', 'cursor']), ...(input.seedFiles === undefined ? {} : { seedFiles: input.seedFiles }) }));
}

const selectorSchema = {
  type: 'object', additionalProperties: false, required: ['qualifiedName'],
  properties: { qualifiedName: { type: 'string', minLength: 1, maxLength: maximumMcpTextBytes }, file: { type: 'string', minLength: 1, maxLength: maximumMcpTextBytes }, kind: { type: 'string', enum: [...nodeKinds] } },
};
const limitsSchema = {
  maxDepth: { type: 'integer', minimum: 1, maximum: 8 },
  tokenBudget: { type: 'integer', minimum: 500, maximum: 16_000 },
  maxResults: { type: 'integer', minimum: 1, maximum: 1_000 },
  cursor: { type: 'string', minLength: 1, maxLength: maximumCursorBytes },
};
function toolSchema(properties: Record<string, unknown>, required: readonly string[] = []): { type: 'object'; additionalProperties: false; properties: Record<string, unknown>; required?: readonly string[] } {
  return { type: 'object', additionalProperties: false, properties, ...(required.length === 0 ? {} : { required }) };
}
export const codegraphToolDefinitions = [
  { name: 'codegraph_status', description: 'Read Codegraph availability, snapshot, and coverage.', inputSchema: toolSchema({}) },
  { name: 'codegraph_index', description: 'Build a fresh Codegraph snapshot.', inputSchema: toolSchema({}) },
  { name: 'codegraph_impact', description: 'Traverse callers and dependents of a symbol.', inputSchema: toolSchema({ symbol: selectorSchema, direction: { enum: ['forward', 'reverse', 'both'] }, edgeKinds: { type: 'array', items: { enum: [...edgeKinds] } }, ...limitsSchema }, ['symbol']) },
  { name: 'codegraph_path', description: 'Find the shortest resolved path between two symbols.', inputSchema: toolSchema({ from: selectorSchema, to: selectorSchema, edgeKinds: { type: 'array', items: { enum: [...edgeKinds] } }, ...limitsSchema }, ['from', 'to']) },
  { name: 'codegraph_hierarchy', description: 'Traverse type extension and implementation relationships.', inputSchema: toolSchema({ symbol: selectorSchema, direction: { enum: ['forward', 'reverse', 'both'] }, ...limitsSchema }, ['symbol']) },
  { name: 'codegraph_modules', description: 'Report import cycles, layers, or fanout.', inputSchema: toolSchema({ mode: { enum: ['cycles', 'layers', 'fanout'] }, tokenBudget: limitsSchema.tokenBudget, maxResults: limitsSchema.maxResults, cursor: limitsSchema.cursor }, ['mode']) },
  { name: 'codegraph_context', description: 'Rank lexical and graph-adjacent context.', inputSchema: toolSchema({ query: { type: 'string', minLength: 1, maxLength: maximumMcpTextBytes }, seedFiles: { type: 'array', maxItems: maximumSeedFiles, items: { type: 'string', minLength: 1, maxLength: maximumMcpTextBytes } }, ...limitsSchema }, ['query']) },
] as const;
