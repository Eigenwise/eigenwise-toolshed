import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { crapReport, formatCrapReport, writeReceipt } from '../lib/crap.mjs';
import { createAnalyzer } from '../lib/core.mjs';
import { coverageByFile, functionLineCoverage } from '../lib/lcov.mjs';
import { lizardDescriptors, parseLizardCsv } from '../lib/lizard.mjs';
import { gateSettings, projectRoot, readConfig, selectedFiles, sourceHashes, baseRevision } from '../lib/crap-inputs.mjs';

const pluginRoot = fileURLToPath(new URL('../', import.meta.url));
const entry = path.join(pluginRoot, 'bin/quality-gate.js');
const analyzer = await createAnalyzer(pluginRoot);

function git(root, argumentsList) {
  const result = spawnSync('git', argumentsList, { cwd: root, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function cli(root, argumentsList = [], cwd = root) {
  return spawnSync(process.execPath, [entry, 'crap', '--project', root, ...argumentsList], { cwd, encoding: 'utf8', timeout: 60000, env: process.env });
}

async function fixture(context, files = { 'source.ts': 'export function subject(value: number) { return value; }\n' }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'quality-gate-crap-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [file, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), text);
  }
  await config(root, { sources: Object.keys(files) });
  return root;
}

async function config(root, settings, owner = 'quality-gate') {
  const directory = path.join(root, '.claude', owner);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'crap.json'), JSON.stringify(settings));
}

async function lcov(root, file, text, hits = 1) {
  const coverage = `SF:${file}\n` + text.split('\n').map((_, index) => `DA:${index + 1},${hits}`).join('\n') + '\nend_of_record\n';
  await fs.mkdir(path.join(root, 'coverage'), { recursive: true });
  await fs.writeFile(path.join(root, 'coverage/lcov.info'), coverage);
  await fs.writeFile(path.join(root, 'coverage/lcov.info.sources.json'), JSON.stringify({ [file]: crypto.createHash('sha256').update(text).digest('hex') }));
}

function commitBaseline(root) {
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['add', '.']);
  git(root, ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline']);
  return git(root, ['rev-parse', 'HEAD']);
}

for (const [issue, file, expected] of [
  [497, 'multiline-ternary.ts', [['describe', 1], ['view', 1], ['<anonymous>', 2]]],
  [495, 'database.types.ts', []],
  [493, 'function-type-alias.ts', [['send', 1], ['noop', 1]]],
  [490, 'expression-arrow.ts', [['viewOf', 2], ['pick', 3]]],
]) {
  test(`GitHub #${issue}: exact reporter snippet finds only runtime bodies and passes the gate`, async (context) => {
    const text = await fs.readFile(path.join(pluginRoot, 'test/fixtures', file), 'utf8');
    assert.deepEqual((await analyzer.collectFunctions(text, file)).map((row) => [row.name, row.complexity]), expected);
    const root = await fixture(context, { [file]: text });
    await lcov(root, file, text);
    const report = await crapReport({ project: root });
    assert.equal(report.exitCode, 0);
    assert.deepEqual(report.changedMetrics.map((row) => [row.name, row.complexity]), expected);
    assert.equal(report.failures.length, 0);
    assert.equal(report.unverified.length, 0);
  });
}

test('all eight JS/TS extensions use the AST even with phantom complexity CSV', async (context) => {
  const files = Object.fromEntries(['js', 'mjs', 'cjs', 'ts', 'mts', 'cts', 'jsx', 'tsx'].map((extension) => [`source.${extension}`, 'const subject = () => 1;\n']));
  const root = await fixture(context, files);
  await fs.writeFile(path.join(root, 'phantom.csv'), '1,99,1,1,1,phantom,source.ts,phantom,phantom,1,1\n');
  const report = await crapReport({ project: root, ccOnly: true, complexity: 'phantom.csv' });
  assert.equal(report.exitCode, 0);
  assert.equal(report.changedMetrics.length, 8);
  assert.ok(report.changedMetrics.every((row) => row.source === 'typescript-ast' && row.complexity === 1));
});

test('JSX and TSX component bodies are runtime functions', async (context) => {
  const text = 'const View = () => <div enabled data-title="(" {...properties}>{value ? "yes" : "no"}</div>;\n';
  const root = await fixture(context, { 'view.tsx': text });
  const report = await crapReport({ project: root, ccOnly: true });
  assert.equal(report.exitCode, 0);
  assert.deepEqual(report.changedMetrics.map((row) => [row.name, row.complexity]), [['View', 2]]);
});

test('linked --project worktree wins over cwd in the main checkout', async (context) => {
  const root = await fixture(context);
  commitBaseline(root);
  const linked = path.join(root, 'linked');
  git(root, ['worktree', 'add', '-q', '-b', 'candidate', linked]);
  await fs.writeFile(path.join(linked, 'source.ts'), 'export function added() { return 1; }\n');
  assert.equal(projectRoot(linked).replaceAll('\\', '/'), linked.replaceAll('\\', '/'));
  const execution = cli(linked, ['--cc-only', '--json'], root);
  assert.equal(execution.status, 0, execution.stderr);
  assert.deepEqual(JSON.parse(execution.stdout).changedMetrics.map((row) => row.name), ['added']);
  assert.ok(!execution.stdout.includes('subject'));
});

test('empty scope says why and never says passed or runs coverage', async (context) => {
  const root = await fixture(context, { 'types.ts': 'type Callback = () => void;\n' });
  await config(root, { sources: ['types.ts'], coverageCommand: 'must-not-run' });
  const report = await crapReport({ project: root });
  assert.equal(report.verdict, 'nothing to score');
  assert.match(formatCrapReport(report), /nothing to score.*no runtime function bodies/);
  assert.ok(!formatCrapReport(report).includes('passed'));
  await config(root, { sources: ['absent'] });
  assert.match(formatCrapReport(await crapReport({ project: root })), /No supported source files matched/);
});

test('base ratchet reports legacy edits and enforces only new or raised complexity', async (context) => {
  const original = 'function legacy(value) { if (value === 1) return 1; if (value === 2) return 2; if (value === 3) return 3; if (value === 4) return 4; if (value === 5) return 5; return 0; }\n';
  const root = await fixture(context, { 'source.js': original });
  const base = commitBaseline(root);
  await fs.writeFile(path.join(root, 'source.js'), original.replace('return 0', 'return -1') + 'function added(value) { return value ? 1 : 0; }\n');
  const report = await crapReport({ project: root, base, ccOnly: true });
  assert.equal(report.exitCode, 0);
  assert.deepEqual(report.changedMetrics.map((row) => row.classification), ['legacy-unchanged', 'new']);
  assert.match(formatCrapReport(report), /LEGACY.*cc=6/);
  await fs.writeFile(path.join(root, 'source.js'), original.replace('return 0', 'if (value === 6) return 6; return 0'));
  const raised = await crapReport({ project: root, base, ccOnly: true });
  assert.equal(raised.exitCode, 1);
  assert.equal(raised.failures[0].classification, 'modified-raised');
  assert.match(formatCrapReport(raised), /split the function, more tests cannot help/);
  const unchanged = await crapReport({ project: root, base: 'HEAD', ccOnly: true });
  assert.equal(unchanged.base, null);
  assert.equal(unchanged.changedMetrics[0].classification, 'new');
});

test('unchanged bodies and nested-only edits respect independent AST ownership', async (context) => {
  const text = 'function outer() { return function inner(value) { return value; }; }\n';
  const root = await fixture(context, { 'source.js': text });
  const base = commitBaseline(root);
  assert.match(formatCrapReport(await crapReport({ project: root, base, ccOnly: true })), /No function bodies changed/);
  await fs.writeFile(path.join(root, 'source.js'), text.replace('return value;', 'return value ? 1 : 0;'));
  const report = await crapReport({ project: root, base, ccOnly: true });
  assert.deepEqual(report.changedMetrics.map((row) => [row.name, row.classification]), [['inner', 'modified-raised']]);
});

test('unrounded scores below six pass even when display rounds to six', async (context) => {
  const text = 'function subject(value) {\n if (value) return 1;\n if (value === 0) return 0;\n return -1;\n' + '\n'.repeat(99) + '}\n';
  const root = await fixture(context, { 'source.js': text });
  await lcov(root, 'source.js', text);
  const records = 'SF:source.js\n' + Array.from({ length: 101 }, (_, index) => `DA:${index + 1},${Number(index >= 70)}`).join('\n') + '\nend_of_record\n';
  await fs.writeFile(path.join(root, 'coverage/lcov.info'), records);
  const report = await crapReport({ project: root });
  assert.equal(report.exitCode, 0);
  assert.ok(report.changedMetrics[0].crap < 6);
  assert.equal(report.changedMetrics[0].crap.toFixed(2), '6.00');
});

test('missing coverage, absent manifest and differing hashes stay unverified', async (context) => {
  const text = 'function subject() { return 1; }\n';
  const root = await fixture(context, { 'source.js': text });
  const missing = await crapReport({ project: root });
  assert.equal(missing.exitCode, 2);
  assert.match(missing.unverified[0].unverified, /Vitest.*raw NODE_V8_COVERAGE/);
  await lcov(root, 'source.js', text);
  await fs.rm(path.join(root, 'coverage/lcov.info.sources.json'));
  const noManifest = await crapReport({ project: root });
  assert.equal(noManifest.exitCode, 2);
  assert.match(noManifest.unverified[0].unverified, /authentic.*sources.json/);
  await fs.writeFile(path.join(root, 'coverage/lcov.info.sources.json'), JSON.stringify({ 'source.js': 'wrong' }));
  assert.equal((await crapReport({ project: root })).exitCode, 2);
});

test('zero coverage is measured and missing body lines are unverified', async (context) => {
  const text = 'function subject(value) { return value ? 1 : 0; }\n';
  const root = await fixture(context, { 'source.js': text });
  await lcov(root, 'source.js', text, 0);
  const report = await crapReport({ project: root });
  assert.equal(report.exitCode, 1);
  assert.equal(report.changedMetrics[0].crap, 6);
  await fs.writeFile(path.join(root, 'coverage/lcov.info'), 'SF:source.js\nDA:100,1\nend_of_record\n');
  const unmeasured = await crapReport({ project: root });
  assert.equal(unmeasured.exitCode, 2);
  assert.match(unmeasured.unverified[0].unverified, /No executable LCOV lines/);
});

test('LCOV merges duplicate files by maximum hits and excludes nested body lines', () => {
  const files = coverageByFile('SF:source.js\nDA:1,0\nend_of_record\nSF:source.js\nDA:1,1\nDA:2,0\nend_of_record\n', '/project');
  assert.deepEqual([...files.values()][0].get(1), 1);
  const outer = { identity: 'outer', line: 1, endLine: 4 };
  const inner = { parent: 'outer', line: 2, endLine: 3 };
  assert.equal(functionLineCoverage(outer, [outer, inner], new Map([[1, 1], [3, 0], [4, 1]])).coverage, 1);
  assert.throws(() => coverageByFile('SF:source.js\nDA:bad,1\n', '/project'), /Regenerate LCOV/);
});

test('config fallback notices, CLI overrides, exclusions and source hashes', async (context) => {
  const root = await fixture(context, { 'source.js': 'function subject() {}\n', 'ignored.js': 'function ignored() {}\n' });
  await fs.rm(path.join(root, '.claude/quality-gate/crap.json'));
  await config(root, { sources: ['.'], exclude: ['ignored.js'], max: 6, ratchet: 'HEAD', coverageCommand: 'must-not-run' }, 'quartermaster');
  const report = await crapReport({ project: root, ccOnly: true });
  assert.equal(report.exitCode, 0);
  assert.equal(report.warnings.length, 2);
  assert.deepEqual(Object.keys(report.files), ['source.js']);
  assert.deepEqual(report.files, sourceHashes(root, ['source.js']));
  await config(root, { sources: ['absent'] });
  assert.deepEqual(readConfig(root).warnings, []);
  assert.deepEqual(selectedFiles(root, { sources: ['absent'], exclude: [] }), []);
  assert.throws(() => gateSettings({ max: '7' }, {}), /Remove max/);
  assert.throws(() => gateSettings({ ccOnly: true, lcov: 'lcov.info' }, {}), /Drop --cc-only/);
  assert.throws(() => gateSettings({ ccOnly: true, coverageCommand: 'command' }, {}), /Drop --cc-only/);
});

test('coverageCommand uses an empty isolated directory, hashes fixed sources and emits a receipt', async (context) => {
  const root = await fixture(context, { 'source.js': 'function subject() { return 1; }\n' });
  const head = commitBaseline(root);
  const command = `${JSON.stringify(process.execPath)} -e "const fs=require('node:fs');const directory=process.env.QUALITY_GATE_COVERAGE_DIR;if(fs.readdirSync(directory).length)process.exit(8);if(directory!==process.env.QUARTERMASTER_COVERAGE_DIR)process.exit(9);fs.writeFileSync(directory+'/lcov.info','SF:source.js\\nDA:1,1\\nend_of_record\\n');"`;
  const report = await crapReport({ project: root, base: 'HEAD', coverageCommand: command });
  assert.equal(report.exitCode, 0);
  const receipt = JSON.parse(await fs.readFile(writeReceipt(report), 'utf8'));
  assert.equal(receipt.head, head);
  assert.equal(receipt.gateVersion, 'crap-1');
  assert.equal(receipt.verdict, 'passed');
  assert.equal(receipt.rowCounts.new, 1);
  assert.deepEqual(receipt.files, sourceHashes(root, ['source.js']));
});

test('coverageCommand rejects stale output, source edits and command failures', async (context) => {
  const text = 'function subject() { return 1; }\n';
  const root = await fixture(context, { 'source.js': text });
  await lcov(root, 'source.js', text);
  const noOp = `${JSON.stringify(process.execPath)} -e ""`;
  await assert.rejects(crapReport({ project: root, coverageCommand: noOp }), /did not rewrite/);
  const edit = `${JSON.stringify(process.execPath)} -e "require('node:fs').appendFileSync('source.js',' ');"`;
  await assert.rejects(crapReport({ project: root, coverageCommand: edit }), /source changed during coverageCommand/);
  await assert.rejects(crapReport({ project: root, coverageCommand: `${JSON.stringify(process.execPath)} -e "process.exit(3)"` }), /Fix coverageCommand/);
});

test('CLI writes unverified receipts and preserves actionable help and exit codes', async (context) => {
  const root = await fixture(context, { 'source.js': 'function subject() { return 1; }\n' });
  const head = commitBaseline(root);
  const unverified = cli(root, ['--base', 'HEAD', '--json']);
  assert.equal(unverified.status, 2, unverified.stderr);
  const report = JSON.parse(unverified.stdout);
  const receipt = JSON.parse(await fs.readFile(report.receipt, 'utf8'));
  assert.equal(receipt.verdict, 'unverified');
  assert.equal(receipt.head, head);
  assert.equal(receipt.rowCounts.unverified, 1);
  assert.match(receipt.reasons[0], /No LCOV/);
  const help = cli(root, ['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--project selects the tree measured/);
  assert.match(help.stdout, /Exit codes for crap: 0/);
  assert.equal(cli(root, ['unexpected.js']).status, 2);
  assert.equal(cli(root, ['--coverage', 'v8']).status, 2);
  assert.equal(cli(root, ['--cc-only', '--lcov', 'lcov.info']).status, 2);
  assert.equal(cli(root, ['--base', 'unknown', '--cc-only']).status, 2);
});

test('Python adapter placeholder is informational-unverified and never a gate stop', async (context) => {
  const root = await fixture(context, { 'source.py': 'def subject():\n    return 1\n' });
  const report = await crapReport({ project: root, ccOnly: true });
  assert.equal(report.exitCode, 0);
  assert.equal(report.verdict, 'unverified');
  assert.equal(report.unverified[0].unverified, 'Python adapter not installed in this version');
  assert.equal(report.unverified[0].complexity, null);
});

test('PHP and Vue keep lizard counts and unbound rows remain informational', async (context) => {
  const root = await fixture(context, { 'source.php': '<?php\nfunction subject($value) { return $value; }\n' });
  const csv = '1,2,1,1,1,subject,source.php,subject,subject,2,2\n1,99,1,1,1,phantom,source.php,phantom,phantom,3,3\n';
  await fs.writeFile(path.join(root, 'complexity.csv'), csv);
  const report = await crapReport({ project: root, ccOnly: true, complexity: 'complexity.csv' });
  assert.equal(report.exitCode, 0);
  assert.equal(report.changedMetrics[0].complexity, 2);
  assert.equal(report.changedMetrics[0].source, 'lizard');
  assert.match(report.unverified[0].unverified, /cannot be bound/);
  const vue = '<template><div>subject()</div></template>\n<script lang="ts">\nfunction subject(value: number) { return value; }\n</script>\n';
  const rows = await lizardDescriptors(vue, 'view.vue', analyzer, '1,3,1,1,1,subject,view.vue,subject,subject,3,3\n');
  assert.equal(rows[0].complexity, 3);
  assert.equal(rows[0].unverified, undefined);
  assert.equal(parseLizardCsv('invalid\n1,no,1,1,1,subject,file,subject,subject,1,1').length, 0);
});

test('native lizard binds PHP and Vue functions without changing their complexity authority', { skip: spawnSync('lizard', ['--version'], { windowsHide: true }).status !== 0 }, async (context) => {
  const root = await fixture(context, { 'source.php': '<?php\nfunction subject($value) { if ($value) return 1; return 0; }\n' });
  const php = await crapReport({ project: root, ccOnly: true });
  assert.equal(php.exitCode, 0);
  assert.equal(php.changedMetrics[0].complexity, 2);
  const rows = await lizardDescriptors('<script>\nconst subject = (value) => value ? 1 : 0;\n</script>\n', 'view.vue', analyzer);
  assert.equal(rows[0].source, 'lizard');
  assert.equal(rows[0].complexity, 2);
});

test('default base warning names a stale upstream and invalid refs fail loudly', async (context) => {
  const root = await fixture(context);
  const base = commitBaseline(root);
  git(root, ['branch', 'upstream']);
  await fs.writeFile(path.join(root, 'extra.txt'), 'next');
  git(root, ['add', 'extra.txt']);
  git(root, ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'next']);
  git(root, ['branch', '-f', 'upstream', 'HEAD']);
  git(root, ['checkout', '-q', '-b', 'candidate', base]);
  git(root, ['branch', '-f', 'main', base]);
  git(root, ['config', 'branch.main.remote', '.']);
  git(root, ['config', 'branch.main.merge', 'refs/heads/upstream']);
  assert.match(baseRevision(root).warnings[0], /1 commits behind.*--base main@/);
  assert.throws(() => baseRevision(root, 'unknown'), /Check the project path and base revision/);
});


test('invalid config prerequisites write an unverified receipt with the remedy', async (context) => {
  const root = await fixture(context);
  const head = commitBaseline(root);
  await config(root, { sources: 'invalid' });
  const execution = cli(root, ['--cc-only', '--json']);
  assert.equal(execution.status, 2);
  const report = JSON.parse(execution.stdout);
  const receipt = JSON.parse(await fs.readFile(report.receipt, 'utf8'));
  assert.equal(receipt.head, head);
  assert.equal(receipt.verdict, 'unverified');
  assert.match(receipt.reasons[0], /sources must be an array of strings.*Fix the config file/);
  await config(root, { coverageCommand: 2 });
  await assert.rejects(crapReport({ project: root }), /coverageCommand must be a string/);
  await config(root, null);
  await assert.rejects(crapReport({ project: root }), /JSON object/);
});

test('missing lizard reports its installation remedy without attempting installation', async (context) => {
  const root = await fixture(context, { 'source.php': '<?php\nfunction subject() { return 1; }\n' });
  const execution = spawnSync(process.execPath, [entry, 'crap', '--project', root, '--cc-only'], { encoding: 'utf8', timeout: 60000, env: { ...process.env, PATH: '' } });
  assert.equal(execution.status, 2);
  assert.match(execution.stdout, /Lizard is unavailable.*pipx install lizard/);
});
