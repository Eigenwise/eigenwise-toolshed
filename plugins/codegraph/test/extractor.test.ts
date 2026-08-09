import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { TypeScriptSemanticExtractor } from '../src/lib/extractors/typescript.ts';

const fixtureRoot = path.join(process.cwd(), 'test', 'fixtures', 'projects', 'semantic');

test('extracts authoritative TypeScript declarations and semantic relationships', async () => {
  const extractor = new TypeScriptSemanticExtractor();
  const [project] = await extractor.discoverProjects(fixtureRoot);
  assert.ok(project);
  const graphs = await extractor.extractProject(project);
  const nodes = graphs.flatMap((graph) => graph.nodes);
  const edges = graphs.flatMap((graph) => graph.edges);

  assert.ok(nodes.some((node) => node.name === 'Base' && node.kind === 'class'));
  assert.ok(nodes.some((node) => node.name === 'Child' && node.kind === 'class'));
  assert.ok(edges.some((edge) => edge.kind === 'extends' && edge.resolution === 'resolved'));
  assert.ok(edges.some((edge) => edge.kind === 'aliases' && edge.resolution === 'resolved'));
  assert.ok(edges.some((edge) => edge.kind === 'calls' && edge.resolution === 'resolved'));
  assert.ok(edges.some((edge) => edge.kind === 'overrides' && edge.resolution === 'resolved'));
});
