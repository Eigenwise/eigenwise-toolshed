import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { PyrightCompatibilityError } from '../src/lib/extractors/python/pyright-adapter.ts';
import { PyrightSemanticExtractor } from '../src/lib/extractors/python/python.ts';
import { discoverPythonProjects } from '../src/lib/languages/python/projects.ts';

const fixtureRoot = path.join(__dirname, 'fixtures', 'python-semantic');
const runtimeRoot = path.join(__dirname, '..', 'runtime-pyright', 'node_modules');

function pyrightRuntime() {
  return {
    id: 'pyright', version: '1.1.411', engineId: 'pyright', engineVersion: '1.1.411', extractors: [],
    importModule(specifier: string): Promise<unknown> {
      return import(pathToFileURL(path.join(runtimeRoot, specifier)).href);
    },
  };
}

test('rejects a mismatched Pyright engine before extraction', async () => {
  const [project] = await discoverPythonProjects(fixtureRoot);
  assert.ok(project);
  await assert.rejects(new PyrightSemanticExtractor({ ...pyrightRuntime(), version: '1.1.410', engineVersion: '1.1.410' }).extractProject(project), PyrightCompatibilityError);
});

test('extracts stable Python declarations and classified relationships through Pyright analysis', async () => {
  const [project] = await discoverPythonProjects(fixtureRoot);
  assert.ok(project);
  const extractor = new PyrightSemanticExtractor(pyrightRuntime());
  const first = await extractor.extractProject(project);
  const second = await extractor.extractProject(project);
  const nodes = first.flatMap((graph) => graph.nodes);
  const edges = first.flatMap((graph) => graph.edges);
  assert.ok(nodes.some((node) => node.kind === 'class' && node.name === 'Child'));
  assert.ok(nodes.some((node) => node.kind === 'property' && node.name === 'label'));
  assert.ok(nodes.some((node) => node.kind === 'function' && node.name === 'declared'));
  assert.ok(!first.some((graph) => graph.file === 'ignored.py'));
  const nodeId = (qualifiedName: string) => {
    const node = nodes.find((candidate) => candidate.qualifiedName === qualifiedName);
    assert.ok(node, `missing node ${qualifiedName}`);
    return node.id;
  };
  const edge = (kind: string, source: string, target: string | null, resolution?: string) => {
    const relationship = edges.find((candidate) => candidate.kind === kind && candidate.sourceId === source && candidate.targetId === target && (resolution === undefined || candidate.resolution === resolution));
    assert.ok(relationship, `missing ${kind} edge from ${source} to ${target}: ${JSON.stringify(edges.filter((candidate) => candidate.kind === kind && candidate.sourceId === source).map((candidate) => ({ targetId: candidate.targetId, resolution: candidate.resolution })))}`);
    return relationship;
  };
  assert.equal(edge('extends', nodeId('pkg.api.Child'), nodeId('pkg.base.Base')).resolution, 'resolved');
  assert.equal(edge('calls', nodeId('pkg.adverse.patched_call'), null, 'unresolved').resolution, 'unresolved');
  const initModule = first.find((graph) => graph.file === 'pkg/__init__.py')?.nodes[0];
  assert.ok(initModule);
  assert.equal(edge('imports', initModule.id, nodeId('pkg.base.Base')).resolution, 'resolved');
  assert.equal(edge('imports', initModule.id, nodeId('pkg.api.exported')).resolution, 'resolved');
  assert.equal(edge('calls', nodeId('pkg.adverse.conditional_target'), null).resolution, 'ambiguous');
  assert.ok(edges.some((edge) => edge.kind === 'calls' && edge.resolution === 'dynamic'));
  assert.ok(edges.some((edge) => edge.kind === 'calls' && edge.resolution === 'unresolved'));
  assert.ok(edges.some((edge) => edge.kind === 'calls' && edge.resolution === 'ambiguous'));
  assert.ok(edges.some((edge) => edge.resolution === 'external'));
  assert.ok(edges.some((edge) => edge.kind === 'imports' && edge.resolution === 'resolved'));
  assert.deepEqual(first.flatMap((graph) => graph.nodes.map((node) => node.id)).sort(), second.flatMap((graph) => graph.nodes.map((node) => node.id)).sort());
});

test('keeps Python declaration identities when source lines move', async () => {
  const [project] = await discoverPythonProjects(fixtureRoot);
  assert.ok(project);
  const file = path.join(fixtureRoot, 'pkg', 'base.py');
  const original = await readFile(file, 'utf8');
  const extractor = new PyrightSemanticExtractor(pyrightRuntime());
  const before = await extractor.extractProject(project);
  try {
    await writeFile(file, `\n\n${original}`);
    const after = await extractor.extractProject(project);
    const namedIds = (graphs: Awaited<ReturnType<PyrightSemanticExtractor['extractProject']>>) => graphs
      .flatMap((graph) => graph.nodes)
      .filter((node) => node.qualifiedName.endsWith('.Base') || node.qualifiedName.endsWith('.Base.run'))
      .map((node) => node.id)
      .sort();
    assert.deepEqual(namedIds(after), namedIds(before));
  } finally {
    await writeFile(file, original);
  }
});
