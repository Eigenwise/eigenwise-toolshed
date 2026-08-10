import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { type Readable } from 'node:stream';
import path from 'node:path';
import test from 'node:test';
import { PyrightCompatibilityError } from '../src/lib/extractors/python/pyright-adapter.ts';
import { PyrightSemanticExtractor } from '../src/lib/extractors/python/python.ts';
import { discoverPythonProjects } from '../src/lib/languages/python/projects.ts';
import { PyrightRuntimeAcquirer } from '../src/lib/languages/python/runtime.ts';
import type { SemanticEngineRuntime } from '../src/lib/runtime-contract.ts';

const fixtureRoot = path.join(__dirname, 'fixtures', 'python-semantic');
const codegraphRoot = path.resolve(__dirname, '..');
const pyrightRuntime = new PyrightRuntimeAcquirer().acquire();

async function readStream(stream: Readable): Promise<string> {
  stream.setEncoding('utf8');
  let output = '';
  for await (const chunk of stream) output += String(chunk);
  return output;
}

function waitForExit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
}

async function extractProjectInChild(projectRoot: string): Promise<string> {
  const extractorModule = path.join(codegraphRoot, 'lib', 'extractors', 'python', 'python.js');
  const projectsModule = path.join(codegraphRoot, 'lib', 'languages', 'python', 'projects.js');
  const runtimeModule = path.join(codegraphRoot, 'lib', 'languages', 'python', 'runtime.js');
  const extraction = [
    `const { PyrightSemanticExtractor } = require(${JSON.stringify(extractorModule)});`,
    `const { discoverPythonProjects } = require(${JSON.stringify(projectsModule)});`,
    `const { PyrightRuntimeAcquirer } = require(${JSON.stringify(runtimeModule)});`,
    'void (async () => {',
    `const [project] = await discoverPythonProjects(${JSON.stringify(projectRoot)});`,
    "if (!project) throw new Error('Python fixture project was not discovered');",
    'await new PyrightSemanticExtractor(await new PyrightRuntimeAcquirer().acquire()).extractProject(project);',
    '})();',
  ].join('\n');
  const child = spawn(process.execPath, ['--eval', extraction], {
    cwd: codegraphRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (child.stdout === null || child.stderr === null) throw new Error('Python extraction child did not expose output streams');
  const [stdout, stderr, exitCode] = await Promise.all([readStream(child.stdout), readStream(child.stderr), waitForExit(child)]);
  if (exitCode !== 0) throw new Error(`Python extraction child exited ${exitCode}: ${stderr}`);
  return stdout;
}

function mismatchedPyrightRuntime(runtime: SemanticEngineRuntime): SemanticEngineRuntime {
  return {
    id: runtime.id,
    version: '1.1.410',
    engineId: runtime.engineId,
    engineVersion: '1.1.410',
    extractors: runtime.extractors,
    importModule: runtime.importModule.bind(runtime),
  };
}

test('rejects a mismatched Pyright engine before extraction', async () => {
  const [project] = await discoverPythonProjects(fixtureRoot);
  assert.ok(project);
  await assert.rejects(new PyrightSemanticExtractor(mismatchedPyrightRuntime(await pyrightRuntime)).extractProject(project), PyrightCompatibilityError);
});

test('keeps Pyright extraction silent on stdout', async () => {
  assert.equal(await extractProjectInChild(fixtureRoot), '');
});

test('extracts stable Python declarations and classified relationships through Pyright analysis', async () => {
  const [project] = await discoverPythonProjects(fixtureRoot);
  assert.ok(project);
  const extractor = new PyrightSemanticExtractor(await pyrightRuntime);
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

test('records unreachable Python names as unresolved references', async () => {
  const [project] = await discoverPythonProjects(fixtureRoot);
  assert.ok(project);
  const graphs = await new PyrightSemanticExtractor(await pyrightRuntime).extractProject(project);
  const unreachableGraph = graphs.find((graph) => graph.file === 'pkg/unreachable.py');
  assert.ok(unreachableGraph);
  const hasUnresolvedReferenceAt = (line: number) => unreachableGraph.edges.some((edge) => edge.kind === 'references' && edge.resolution === 'unresolved' && edge.evidence.startLine === line);
  assert.ok(hasUnresolvedReferenceAt(6), 'missing unresolved reference after raise');
  assert.ok(hasUnresolvedReferenceAt(12), 'missing unresolved reference after return');
  assert.ok(hasUnresolvedReferenceAt(17), 'missing unresolved reference in a false version-gated branch');
});

test('keeps Python declaration identities when source lines move', async () => {
  const [project] = await discoverPythonProjects(fixtureRoot);
  assert.ok(project);
  const file = path.join(fixtureRoot, 'pkg', 'base.py');
  const original = await readFile(file, 'utf8');
  const extractor = new PyrightSemanticExtractor(await pyrightRuntime);
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

test('represents globals and nonlocals as their enclosing declarations', async () => {
  const [project] = await discoverPythonProjects(fixtureRoot);
  assert.ok(project);
  const graphs = await new PyrightSemanticExtractor(await pyrightRuntime).extractProject(project);
  const graph = graphs.find((candidate) => candidate.file === 'pkg/scope_rebinding.py');
  assert.ok(graph);
  assert.equal(graph.nodes.filter((node) => node.name === 'counter').length, 1);
  assert.equal(new Set(graph.nodes.map((node) => node.id)).size, graph.nodes.length);
});
