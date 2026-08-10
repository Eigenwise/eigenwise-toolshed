import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildProjectIndex } from '../src/lib/index-builder.ts';
import { TypeScriptSemanticExtractor } from '../src/lib/extractors/typescript.ts';
import type { FileGraph, LanguageExtractor, ProjectDescriptor } from '../src/lib/model.ts';
import { discoverProjects } from '../src/lib/projects.ts';
import type { ProjectGraphSnapshot, ProjectSnapshotStore, SemanticRuntime } from '../src/lib/runtime-contract.ts';

class CapturingStore implements ProjectSnapshotStore {
  readonly snapshots: ProjectGraphSnapshot[] = [];

  async readSnapshot(): Promise<null> {
    return null;
  }

  async replaceSnapshot(snapshot: ProjectGraphSnapshot): Promise<void> {
    this.snapshots.push(snapshot);
  }
}

function extractor(fail: boolean): LanguageExtractor {
  const descriptor: ProjectDescriptor = { id: 'project', root: '', configFile: null, language: 'typescript' };
  return {
    id: 'fixture', languages: ['typescript'],
    async discoverProjects(): Promise<ProjectDescriptor[]> { return [descriptor]; },
    async extractProject(): Promise<FileGraph[]> {
      if (fail) throw new Error('extract failed');
      return [{ file: 'entry.ts', contentHash: 'content', nodes: [], edges: [], unresolvedCount: 0, diagnostics: [] }];
    },
  };
}

function discoveredProjectExtractor(): LanguageExtractor {
  return {
    id: 'fixture', languages: ['typescript'],
    discoverProjects,
    async extractProject(): Promise<FileGraph[]> {
      return [{ file: 'src/entry.ts', contentHash: 'content', nodes: [], edges: [], unresolvedCount: 0, diagnostics: [] }];
    },
  };
}

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'codegraph-index-'));
  await writeFile(path.join(root, 'entry.ts'), 'export {};\n');
  return root;
}

test('builds a validated snapshot before replacing it', async () => {
  const store = new CapturingStore();
  const runtime: SemanticRuntime = { engineId: 'typescript', engineVersion: '7.0.2', extractors: [extractor(false)] };
  const result = await buildProjectIndex(await fixtureRoot(), { runtime, store, indexedAt: () => '2026-01-01T00:00:00.000Z' });

  assert.equal(result.snapshots.length, 1);
  assert.equal(store.snapshots.length, 1);
  assert.equal(store.snapshots[0]?.snapshot.indexedAt, '2026-01-01T00:00:00.000Z');
});

// Project discovery canonicalizes every descriptor root, so an index root left as the caller typed
// it subtracts two different names for one directory and every file reads as outside the project.
test('indexes repository-relative paths when the root is an alias of its real path', async () => {
  const fixtureParent = await mkdtemp(path.join(tmpdir(), 'codegraph-index-aliased-root-'));
  const realRoot = path.join(fixtureParent, 'project');
  const aliasedRoot = path.join(fixtureParent, 'alias');
  try {
    await mkdir(path.join(realRoot, 'src'), { recursive: true });
    await writeFile(path.join(realRoot, 'tsconfig.json'), JSON.stringify({ include: ['src/*.ts'] }));
    await writeFile(path.join(realRoot, 'src', 'entry.ts'), 'export {};\n');
    await symlink(realRoot, aliasedRoot, 'junction');
    assert.notEqual(realpathSync.native(aliasedRoot), path.resolve(aliasedRoot));

    const store = new CapturingStore();
    const runtime: SemanticRuntime = { engineId: 'typescript', engineVersion: '7.0.2', extractors: [discoveredProjectExtractor()] };
    const result = await buildProjectIndex(aliasedRoot, { runtime, store, indexedAt: () => '2026-01-01T00:00:00.000Z' });

    assert.deepEqual(result.snapshots.flatMap((snapshot) => snapshot.files.map((file) => file.file)), ['src/entry.ts']);
    assert.equal(result.manifest.inputs.some((input) => input.path === 'src/entry.ts'), true);
  } finally {
    await rm(fixtureParent, { recursive: true, force: true });
  }
});

test('indexes repeated local declarations and object-literal methods into a ready snapshot', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'codegraph-duplicate-symbols-'));
  try {
    await writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ files: ['index.ts'] }));
    await writeFile(path.join(root, 'index.ts'), [
      'const retained = true;',
      'for (const response of [1, 2]) { console.log(response); }',
      'for (const response of [3, 4]) { console.log(response); }',
      'function first() { const entry = 1; return entry; }',
      'function second() { const entry = 2; return entry; }',
      'const firstObject = { extractProject() { return first(); } };',
      'const secondObject = { extractProject() { return second(); } };',
      'class Worker { run() {} }',
      'interface WorkerShape { run(): void; }',
    ].join('\n'));

    const store = new CapturingStore();
    const runtime: SemanticRuntime = {
      engineId: 'typescript',
      engineVersion: '7.0.2',
      extractors: [new TypeScriptSemanticExtractor()],
    };
    const result = await buildProjectIndex(root, { runtime, store });

    assert.equal(result.snapshots.length, 1);
    assert.equal(store.snapshots.length, 1);
    assert.equal(store.snapshots[0]?.coverage.nodes, 10);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('does not replace a snapshot when extraction fails', async () => {
  const store = new CapturingStore();
  const runtime: SemanticRuntime = { engineId: 'typescript', engineVersion: '7.0.2', extractors: [extractor(true)] };
  await assert.rejects(buildProjectIndex(await fixtureRoot(), { runtime, store }));
  assert.equal(store.snapshots.length, 0);
});
