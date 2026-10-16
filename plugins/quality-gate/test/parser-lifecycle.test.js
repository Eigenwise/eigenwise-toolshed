import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { crapReport } from '../lib/crap.mjs';

const parserChildren = { spawned: 0, live: 0, peak: 0 };
const originalSpawn = childProcess.spawn;
childProcess.spawn = function trackParserChildren(command, argumentsList, options) {
  const child = originalSpawn.call(this, command, argumentsList, options);
  if (argumentsList?.[0] === '--api') {
    parserChildren.spawned += 1;
    parserChildren.live += 1;
    parserChildren.peak = Math.max(parserChildren.peak, parserChildren.live);
    child.once('exit', () => { parserChildren.live -= 1; });
  }
  return child;
};
syncBuiltinESMExports();

function git(root, argumentsList) {
  const result = childProcess.spawnSync('git', argumentsList, { cwd: root, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

const FILE_COUNT = 6;

async function committedProject(context) {
  const root = realpathSync.native(await fs.mkdtemp(path.join(os.tmpdir(), 'quality-gate-parser-')));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'src'));
  for (let index = 0; index < FILE_COUNT; index += 1) await fs.writeFile(path.join(root, `src/file${index}.ts`), `export function body${index}(value: number) { return value; }\n`);
  await fs.mkdir(path.join(root, '.claude/quality-gate'), { recursive: true });
  await fs.writeFile(path.join(root, '.claude/quality-gate/crap.json'), JSON.stringify({ sources: ['src'] }));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['add', '.']);
  git(root, ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline']);
  return { root, base: git(root, ['rev-parse', 'HEAD']) };
}

for (const [transport, spawnedChildren] of [['sync', 1], ['async', FILE_COUNT]]) {
  test(`GitHub #554: a whole-tree ${transport} run never runs two parser children at once and has reaped them when the report returns`, async (context) => {
    const { root } = await committedProject(context);
    context.after(() => { delete process.env.CRAP_PARSER_TRANSPORT; });
    process.env.CRAP_PARSER_TRANSPORT = transport;
    const before = parserChildren.spawned;
    parserChildren.peak = 0;
    const report = await crapReport({ project: root, base: 'HEAD', ccOnly: true });
    assert.equal(parserChildren.spawned - before, spawnedChildren);
    assert.equal(parserChildren.peak, 1);
    assert.equal(parserChildren.live, 0);
    assert.deepEqual(report.metrics.map((metric) => metric.name).sort(), Array.from({ length: FILE_COUNT }, (_, index) => `body${index}`));
  });
}

test('GitHub #554: --base analyses only the changed and untracked files', async (context) => {
  const { root, base } = await committedProject(context);
  await fs.writeFile(path.join(root, 'src/file2.ts'), 'export function body2(value: number) { return value ? 1 : 2; }\n');
  await fs.writeFile(path.join(root, 'src/added.ts'), 'export function added() { return 1; }\n');
  const before = parserChildren.spawned;
  const report = await crapReport({ project: root, base, ccOnly: true });
  assert.deepEqual(Object.keys(report.files).sort(), ['src/added.ts', 'src/file2.ts']);
  assert.deepEqual(report.metrics.map((metric) => `${metric.relativePath}:${metric.name}`).sort(), ['src/added.ts:added', 'src/file2.ts:body2']);
  assert.deepEqual(report.changedMetrics.map((metric) => `${metric.name}:${metric.classification}`).sort(), ['added:new', 'body2:modified-raised']);
  assert.equal(parserChildren.spawned - before, 1);
  assert.equal(parserChildren.live, 0);
});

test('GitHub #554: --base with no changed file parses nothing and says why', async (context) => {
  const { root, base } = await committedProject(context);
  const before = parserChildren.spawned;
  const report = await crapReport({ project: root, base, ccOnly: true });
  assert.equal(parserChildren.spawned - before, 0);
  assert.equal(report.verdict, 'nothing to score');
  assert.equal(report.nothingToScoreReason, 'No function bodies changed against the base revision.');
});
