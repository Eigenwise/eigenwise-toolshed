import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAnalyzer } from '../lib/core.mjs';
import { resolveCompiler } from '../lib/compiler.mjs';
import { measureFiles } from '../lib/measure.mjs';

const pluginRoot = fileURLToPath(new URL('../', import.meta.url));

async function isolatedPlugin() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'quality-gate-'));
  assert.deepEqual(await fs.readdir(root), []);
  const plugin = path.join(root, 'plugin');
  const project = path.join(root, 'project');
  await fs.mkdir(project);
  await fs.cp(pluginRoot, plugin, { recursive: true, filter: (sourcePath) => !sourcePath.includes('node_modules') });
  return { root, plugin, project };
}

function runNode(argumentsList, options = {}) {
  return spawnSync(process.execPath, argumentsList, { encoding: 'utf8', timeout: 60000, ...options });
}

function git(project, argumentsList) {
  const result = spawnSync('git', argumentsList, { cwd: project, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test('resolves the scored project compiler before the plugin dependency', async () => {
  const { root, project } = await isolatedPlugin();
  try {
    await fs.cp(path.join(pluginRoot, 'node_modules'), path.join(project, 'node_modules'), { recursive: true });
    assert.ok(resolveCompiler(project).resolve('typescript/unstable/ast').startsWith(project));
    assert.deepEqual((await (await createAnalyzer(project)).collectFunctions('const double = (value) => value * 2;', 'subject.js')).map((descriptor) => descriptor.name), ['double']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('an isolated plugin uses its own compiler and refuses plainly when neither location has one', async () => {
  const { root, plugin, project } = await isolatedPlugin();
  try {
    const entry = pathToFileURL(path.join(plugin, 'lib/core.mjs')).href;
    const script = `const { createAnalyzer } = await import(${JSON.stringify(entry)}); const analyzer = await createAnalyzer(${JSON.stringify(project)}); console.log(JSON.stringify(await analyzer.collectFunctions('function subject() { return 1; }', 'subject.js')));`;
    const missing = runNode(['--input-type=module', '-e', script], { cwd: project });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /No supported typescript dependency was found in the scored project .* or in the quality-gate plugin/);
    await fs.cp(path.join(pluginRoot, 'node_modules'), path.join(plugin, 'node_modules'), { recursive: true });
    const fallback = runNode(['--input-type=module', '-e', script], { cwd: project });
    assert.equal(fallback.status, 0, fallback.stderr);
    assert.equal(JSON.parse(fallback.stdout)[0].complexity, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('measure consumes real V8 coverage, preserves report JSON and fails at six', async () => {
  const { root, project } = await isolatedPlugin();
  try {
    const subject = path.join(project, 'subject.mjs');
    await fs.writeFile(subject, 'export function subject(value) { return value; }\n');
    git(project, ['init', '-q']);
    git(project, ['add', '.']);
    git(project, ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline']);
    const base = git(project, ['rev-parse', 'HEAD']);
    await fs.writeFile(subject, 'export function subject(value) {\n if (value === 1) return 1;\n if (value === 2) return 2;\n if (value === 3) return 3;\n if (value === 4) return 4;\n if (value === 5) return 5;\n return 0;\n}\n');
    const coverage = path.join(root, 'coverage');
    await fs.mkdir(coverage);
    assert.deepEqual(await fs.readdir(coverage), []);
    const execution = runNode(['--input-type=module', '-e', `const { subject } = await import(${JSON.stringify(pathToFileURL(subject).href)}); for (let value = 0; value <= 5; value += 1) subject(value);`], { cwd: project, env: { ...process.env, NODE_V8_COVERAGE: coverage } });
    assert.equal(execution.status, 0, execution.stderr);
    const report = await measureFiles(['subject.mjs'], { projectRoot: project, base, coverageDirectory: coverage });
    assert.equal(report.changedMetrics[0].crap, 6);
    assert.equal(report.changedMetrics[0].coverage, 1);
    const cli = runNode([path.join(pluginRoot, 'bin/quality-gate.js'), 'measure', '--project', project, '--base', base, '--coverage', coverage, 'subject.mjs']);
    assert.equal(cli.status, 1, cli.stderr);
    assert.deepEqual(JSON.parse(cli.stdout), report);
    assert.deepEqual(await measureFiles([subject], { projectRoot: project, base, coverageDirectory: coverage }), report);
    assert.equal(report.failures.length, 1);
    const emptyCoverage = path.join(root, 'empty-coverage');
    await fs.mkdir(emptyCoverage);
    const missing = await measureFiles(['subject.mjs'], { projectRoot: project, base, coverageDirectory: emptyCoverage });
    assert.equal(missing.unverified.length, 1);
    assert.match(missing.unverified[0].unverified, /no suite loaded this file/);
    await fs.writeFile(path.join(project, 'fresh.mjs'), 'export function fresh() { return 1; }\n');
    const newFile = await measureFiles(['fresh.mjs'], { projectRoot: project, base, coverageDirectory: coverage });
    assert.equal(newFile.changedMetrics.length, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('the measurement entry refuses incomplete arguments', () => {
  const result = runNode([path.join(pluginRoot, 'bin/quality-gate.js'), 'measure']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage: quality-gate measure/);
});
