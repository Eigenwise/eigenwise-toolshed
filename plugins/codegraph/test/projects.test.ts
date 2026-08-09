import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { discoverProjects } from '../src/lib/projects.ts';

async function createProjectRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'codegraph-projects-'));
  await mkdir(path.join(root, 'packages', 'library', 'src'), { recursive: true });
  await mkdir(path.join(root, 'packages', 'web', 'src'), { recursive: true });
  await writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ references: [{ path: './packages/library' }, { path: './packages/web' }] }));
  await writeFile(path.join(root, 'packages', 'library', 'tsconfig.json'), JSON.stringify({ include: ['src/**/*.ts'] }));
  await writeFile(path.join(root, 'packages', 'web', 'jsconfig.json'), JSON.stringify({ include: ['src/**/*.js'] }));
  return root;
}

test('discovers leaf TypeScript and JavaScript projects from a solution config', async () => {
  const root = await createProjectRoot();
  const projects = await discoverProjects(root);

  assert.deepEqual(projects.map((project) => [path.basename(project.configFile ?? ''), project.language]), [
    ['tsconfig.json', 'typescript'],
    ['jsconfig.json', 'javascript'],
  ]);
});

test('creates an inferred project only when no configuration exists', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'codegraph-inferred-'));
  const inferred = await discoverProjects(root);
  assert.equal(inferred.length, 1);
  assert.equal(inferred[0]?.configFile, null);

  await writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ references: [{ path: './missing' }] }));
  assert.deepEqual(await discoverProjects(root), []);
});
