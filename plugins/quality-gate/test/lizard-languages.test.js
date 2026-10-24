import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { crapReport, formatCrapReport } from '../lib/crap.mjs';
import { lizardDescriptors } from '../lib/lizard.mjs';

const entry = fileURLToPath(new URL('../bin/quality-gate.js', import.meta.url));
const fixtures = new URL('./fixtures/gh-574/', import.meta.url);

function git(root, argumentsList) {
  const execution = spawnSync('git', argumentsList, { cwd: root, encoding: 'utf8', timeout: 30000 });
  assert.equal(execution.status, 0, execution.stderr);
}

async function project(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'quality-languages-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  git(root, ['init', '-q', '-b', 'main']);
  await fs.writeFile(path.join(root, 'README.md'), 'baseline\n');
  git(root, ['add', '.']);
  git(root, ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'base']);
  await fs.mkdir(path.join(root, '.claude/quality-gate'), { recursive: true });
  await fs.writeFile(path.join(root, '.claude/quality-gate/crap.json'), JSON.stringify({ sources: ['src'], base: 'main' }));
  await fs.mkdir(path.join(root, 'src'));
  return root;
}

async function rustProject(context) {
  const root = await project(context);
  const text = await fs.readFile(new URL('lib.rs', fixtures), 'utf8');
  await fs.writeFile(path.join(root, 'src/lib.rs'), text);
  await fs.copyFile(new URL('lizard.csv', fixtures), path.join(root, 'lizard.csv'));
  await fs.mkdir(path.join(root, 'coverage'));
  await fs.copyFile(new URL('lcov.info', fixtures), path.join(root, 'coverage/lcov.info'));
  await fs.writeFile(path.join(root, 'coverage/lcov.info.sources.json'), JSON.stringify({ 'src/lib.rs': crypto.createHash('sha256').update(text).digest('hex') }));
  return root;
}

function cli(root, argumentsList) {
  return spawnSync(process.execPath, [entry, 'crap', '--project', root, ...argumentsList], { encoding: 'utf8', timeout: 60000 });
}

test('GH-574 Rust CSV enforces cc 7 and preserves the LCOV inventory refusal', async (context) => {
  const root = await rustProject(context);
  const complexity = cli(root, ['--complexity', 'lizard.csv', '--cc-only']);
  assert.equal(complexity.status, 1, complexity.stderr + complexity.stdout);
  assert.match(complexity.stdout, /FAIL src\/lib.rs:5 g cc=7/);
  const coverage = await crapReport({ project: root, complexity: 'lizard.csv', lcov: 'coverage/lcov.info' });
  assert.deepEqual(coverage.changedMetrics.map((metric) => metric.complexity), [1, 7]);
  assert.equal(coverage.exitCode, 1, 'cc 7 fails at any coverage, unverified or not');
  assert.equal(coverage.verdict, 'failed');
  assert.deepEqual(coverage.failures.map((metric) => metric.name), ['g']);
  assert.match(formatCrapReport(coverage), /FAIL src\/lib.rs:5 g cc=7 coverage unverified .*fails at any coverage.*executable-line completeness is unverified/);
  assert.deepEqual(coverage.unverified, []);
  assert.equal(coverage.changedMetrics[0].boundVerdict, 'pass');
  assert.match(coverage.changedMetrics[0].unverified, /executable-line completeness is unverified/);
  assert.match(formatCrapReport(coverage), /PASS src\/lib.rs:1 f cc=1 coverage=unverified \(bound cc²\+cc=2 < 6\)/);
  assert.equal(coverage.changedMetrics[1].coverage, undefined);
});

test('unsupported source-only extensions without CSV exit 2 and respect source/exclude selectors', async (context) => {
  const root = await project(context);
  await fs.writeFile(path.join(root, 'src/subject.ex'), 'defmodule Subject do\nend\n');
  await fs.writeFile(path.join(root, 'src/other.ex'), 'defmodule Other do\nend\n');
  const execution = cli(root, []);
  assert.equal(execution.status, 2, execution.stderr + execution.stdout);
  assert.match(execution.stdout, /UNVERIFIED \.ex: 2 changed source files/);
  assert.match(execution.stdout, /JS\/TS via the TypeScript AST.*Python via the versioned inventory.*PHP\/Vue.*--complexity <lizard.csv>/s);
  const selected = await crapReport({ project: root, source: ['src/subject.ex'] });
  assert.deepEqual(selected.unsupportedSources, [{ extension: '.ex', count: 1 }]);
  await fs.writeFile(path.join(root, '.claude/quality-gate/crap.json'), JSON.stringify({ sources: ['src'], exclude: ['**/*.ex'], base: 'main' }));
  assert.equal((await crapReport({ project: root })).exitCode, 0);
});

test('docs-only changes keep the nothing-to-score exit 0', async (context) => {
  const root = await project(context);
  await fs.writeFile(path.join(root, 'src/guide.md'), 'documentation\n');
  const execution = cli(root, []);
  assert.equal(execution.status, 0, execution.stderr);
  assert.match(execution.stdout, /nothing to score/);
});

test('supplied rows select arbitrary Lizard extensions without overriding Python or JS authority', async (context) => {
  const root = await project(context);
  await fs.writeFile(path.join(root, 'src/subject.custom'), 'function subject() { return 1; }\n');
  await fs.writeFile(path.join(root, 'lizard.csv'), '1,7,1,1,1,subject,src/subject.custom,subject,subject,1,1\n');
  const report = await crapReport({ project: root, complexity: 'lizard.csv', ccOnly: true });
  assert.equal(report.exitCode, 1);
  assert.equal(report.changedMetrics[0].complexity, 7);
  assert.equal(report.changedMetrics[0].source, 'lizard');
});

test('Lizard rows with invalid or overlapping spans cannot acquire verified ownership', async () => {
  const invalid = await lizardDescriptors('fn subject() {}\n', 'source.rs', { collectFunctions: async () => [] }, '1,1,1,1,1,subject,source.rs,subject,subject,0,2\n');
  assert.match(invalid[0].unverified, /Invalid Lizard source span/);
  const overlapping = await lizardDescriptors('fn subject() {}\n', 'source.rs', { collectFunctions: async () => [] }, '1,1,1,1,1,subject,source.rs,subject,subject,1,1\n1,1,1,1,1,other,source.rs,other,other,1,1\n');
  assert.match(overlapping[0].unverified, /Overlapping/);
});

test('native Lizard scores Rust from its original extension', { skip: spawnSync('lizard', ['--version'], { windowsHide: true }).status !== 0 }, async (context) => {
  const root = await rustProject(context);
  const report = await crapReport({ project: root, ccOnly: true });
  assert.equal(report.exitCode, 1);
  assert.equal(report.changedMetrics.find((metric) => metric.name === 'g').complexity, 7);
});
