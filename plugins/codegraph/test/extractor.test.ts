import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TypeScriptSemanticExtractor } from '../src/lib/extractors/typescript.ts';

const fixtureRoot = path.join(process.cwd(), 'test', 'fixtures', 'projects', 'semantic');

async function extractFixture(files: Readonly<Record<string, string>>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codegraph-semantic-'));
  await Promise.all(Object.entries(files).map(([file, content]) => writeFile(path.join(root, file), content)));
  const extractor = new TypeScriptSemanticExtractor();
  const [project] = await extractor.discoverProjects(root);
  assert.ok(project);
  return {
    root,
    graphs: await extractor.extractProject(project),
  };
}

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

test('resolves a project-owned side-effect import to its module declaration', async () => {
  const { root, graphs } = await extractFixture({
    'tsconfig.json': JSON.stringify({ files: ['index.ts', 'helper.ts'] }),
    'index.ts': "import './helper';\n",
    'helper.ts': 'export const initialized = true;\n',
  });
  try {
    const indexModule = graphs.find((graph) => graph.file === 'index.ts')?.nodes[0];
    const helperModule = graphs.find((graph) => graph.file === 'helper.ts')?.nodes[0];
    assert.ok(indexModule);
    assert.ok(helperModule);
    assert.ok(graphs.flatMap((graph) => graph.edges).some((edge) => edge.kind === 'imports'
      && edge.sourceId === indexModule.id && edge.targetId === helperModule.id && edge.resolution === 'resolved'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolves namespace imports, aliases, and qualified base classes through module mapping', async () => {
  const { root, graphs } = await extractFixture({
    'tsconfig.json': JSON.stringify({ files: ['base.ts', 'child.ts'] }),
    'base.ts': 'export class Base {}\n',
    'child.ts': "import * as types from './base';\nexport class Child extends types.Base {}\n",
  });
  try {
    const baseModule = graphs.find((graph) => graph.file === 'base.ts')?.nodes[0];
    const childModule = graphs.find((graph) => graph.file === 'child.ts')?.nodes[0];
    const base = graphs.flatMap((graph) => graph.nodes).find((node) => node.name === 'Base' && node.kind === 'class');
    const child = graphs.flatMap((graph) => graph.nodes).find((node) => node.name === 'Child' && node.kind === 'class');
    const edges = graphs.flatMap((graph) => graph.edges);
    assert.ok(baseModule);
    assert.ok(childModule);
    assert.ok(base);
    assert.ok(child);
    assert.ok(edges.some((edge) => edge.kind === 'imports'
      && edge.sourceId === childModule.id && edge.targetId === baseModule.id && edge.resolution === 'resolved'));
    assert.ok(edges.some((edge) => edge.kind === 'aliases'
      && edge.sourceId === childModule.id && edge.targetId === baseModule.id && edge.resolution === 'resolved'));
    assert.ok(edges.some((edge) => edge.kind === 'extends'
      && edge.sourceId === child.id && edge.targetId === base.id && edge.resolution === 'resolved'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('indexes statically owned declarations without local or object-literal collisions', async () => {
  const { root, graphs } = await extractFixture({
    'tsconfig.json': JSON.stringify({ files: ['index.ts'] }),
    'index.ts': [
      'const retained = true;',
      'for (const response of [1, 2]) { console.log(response); }',
      'for (const response of [3, 4]) { console.log(response); }',
      'function first() { const entry = 1; return entry; }',
      'function second() { const entry = 2; return entry; }',
      'const firstObject = { extractProject() { return first(); } };',
      'const secondObject = { extractProject() { return second(); } };',
      'class Worker { run() {} }',
      'interface WorkerShape { run(): void; }',
    ].join('\n'),
  });
  try {
    const nodes = graphs.flatMap((graph) => graph.nodes);
    assert.equal(nodes.filter((node) => node.name === 'entry' && node.kind === 'variable').length, 0);
    assert.equal(nodes.filter((node) => node.name === 'response' && node.kind === 'variable').length, 0);
    assert.equal(nodes.filter((node) => node.name === 'extractProject' && node.kind === 'method').length, 0);
    assert.ok(nodes.some((node) => node.name === 'retained' && node.kind === 'variable'));
    assert.ok(nodes.some((node) => node.qualifiedName === 'Worker.run' && node.kind === 'method'));
    assert.ok(nodes.some((node) => node.qualifiedName === 'WorkerShape.run' && node.kind === 'method'));
    assert.equal(new Set(nodes.map((node) => node.id)).size, nodes.length);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolves statically known member calls to their method declaration', async () => {
  const { root, graphs } = await extractFixture({
    'tsconfig.json': JSON.stringify({ files: ['index.ts'] }),
    'index.ts': 'class Helper { method() {} }\nconst helper = new Helper();\nhelper.method();\n',
  });
  try {
    const method = graphs.flatMap((graph) => graph.nodes).find((node) => node.name === 'method' && node.kind === 'method');
    assert.ok(method);
    assert.ok(graphs.flatMap((graph) => graph.edges).some((edge) => edge.kind === 'calls'
      && edge.targetId === method.id && edge.resolution === 'resolved'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
