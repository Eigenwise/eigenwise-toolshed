import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { crapReport, formatCrapReport, writeReceipt } from '../lib/crap.mjs';
import { createAnalyzer } from '../lib/core.mjs';
import { coverageByFile, functionLineCoverage } from '../lib/lcov.mjs';
import { lizardDescriptors, parseLizardCsv } from '../lib/lizard.mjs';
import { crapScore } from '../lib/measure.mjs';
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
  const root = realpathSync.native(await fs.mkdtemp(path.join(os.tmpdir(), 'quality-gate-crap-')));
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

// noop's empty body has no statement line.
for (const [issue, file, expected, unverifiedNames] of [
  [497, 'multiline-ternary.ts', [['describe', 1], ['view', 1], ['<anonymous>', 2]], []],
  [495, 'database.types.ts', [], []],
  [493, 'function-type-alias.ts', [['send', 1], ['noop', 1]], ['noop']],
  [490, 'expression-arrow.ts', [['viewOf', 2], ['pick', 3]], []],
]) {
  test(`GitHub #${issue}: exact reporter snippet finds only runtime bodies and measures LCOV per owned statement line`, async (context) => {
    const text = await fs.readFile(path.join(pluginRoot, 'test/fixtures', file), 'utf8');
    assert.deepEqual((await analyzer.collectFunctions(text, file)).map((row) => [row.name, row.complexity]), expected);
    const root = await fixture(context, { [file]: text });
    await lcov(root, file, text);
    const report = await crapReport({ project: root });
    assert.equal(report.exitCode, 0);
    assert.deepEqual(report.changedMetrics.map((row) => [row.name, row.complexity]), expected);
    assert.equal(report.failures.length, 0);
    assert.deepEqual(report.changedMetrics.filter((row) => row.unverified).map((row) => row.name), unverifiedNames);
    assert.deepEqual(report.unverified, []);
    assert.ok(report.changedMetrics.every((row) => row.unverified || row.coverage === 1));
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

test('base comparison reports legacy edits and enforces raised and new bodies at six', async (context) => {
  const original = 'function legacy(value) { if (value === 1) return 1; if (value === 2) return 2; if (value === 3) return 3; if (value === 4) return 4; if (value === 5) return 5; return 0; }\n';
  const root = await fixture(context, { 'source.js': original });
  const base = commitBaseline(root);
  await fs.writeFile(path.join(root, 'source.js'), original.replace('return 0', 'return -1') + 'function added(value) { return value ? 1 : 0; }\n');
  const report = await crapReport({ project: root, base, ccOnly: true });
  assert.equal(report.exitCode, 0);
  assert.deepEqual(report.changedMetrics.map((row) => row.classification), ['legacy-unchanged', 'new']);
  assert.match(formatCrapReport(report), /LEGACY.*cc=6/);
  assert.doesNotMatch(formatCrapReport(report), /fails at any coverage/);
  await fs.writeFile(path.join(root, 'source.js'), original.replace('return 0', 'if (value === 6) return 6; return 0'));
  const raised = await crapReport({ project: root, base, ccOnly: true });
  assert.equal(raised.exitCode, 1);
  assert.equal(raised.failures[0].classification, 'modified-raised');
  assert.match(formatCrapReport(raised), /split the function, more tests cannot help/);
  const unchanged = await crapReport({ project: root, base: 'HEAD', ccOnly: true });
  assert.equal(unchanged.base, null);
  assert.equal(unchanged.changedMetrics[0].classification, 'new');
  await fs.writeFile(path.join(root, 'source.js'), original + original.replace('legacy', 'fresh'));
  const added = await crapReport({ project: root, base, ccOnly: true });
  assert.equal(added.exitCode, 1);
  assert.deepEqual(added.failures.map((row) => [row.name, row.classification, row.complexity]), [['fresh', 'new', 6]]);
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

test('unrounded scores below six pass even when display rounds to six', () => {
  const score = crapScore(3, 31 / 101);
  assert.ok(score < 6);
  assert.equal(score.toFixed(2), '6.00');
});

test('missing coverage, absent manifest and differing hashes stay unverified', async (context) => {
  const text = 'function subject(value) { if (value) return 1; return 0; }\n';
  const root = await fixture(context, { 'source.js': text });
  const missing = await crapReport({ project: root });
  assert.equal(missing.exitCode, 0);
  assert.equal(missing.ccOnly, true);
  assert.deepEqual(missing.unverified, []);
  await lcov(root, 'source.js', text);
  await fs.rm(path.join(root, 'coverage/lcov.info.sources.json'));
  const noManifest = await crapReport({ project: root });
  assert.equal(noManifest.exitCode, 2);
  assert.match(noManifest.unverified[0].unverified, /authentic.*sources.json/);
  await fs.writeFile(path.join(root, 'coverage/lcov.info.sources.json'), JSON.stringify({ 'source.js': 'wrong' }));
  assert.equal((await crapReport({ project: root })).exitCode, 2);
});

test('a TS function added on a branch is measured from complete LCOV (GH-563)', async (context) => {
  const base = 'export function f(a: number): number {\n  return a + 1;\n}\n';
  const head = base + '\nexport function g(a: number): number {\n  if (a > 0) {\n    return a;\n  }\n  return -a;\n}\n';
  const root = await fixture(context, { 'src/a.ts': base });
  await config(root, { lcov: 'coverage/lcov.info', sources: ['src'], base: 'main' });
  commitBaseline(root);
  git(root, ['checkout', '-qb', 'feature']);
  await fs.writeFile(path.join(root, 'src/a.ts'), head);
  const hits = [[1, 3], [2, 3], [3, 3], [5, 4], [6, 4], [7, 2], [8, 2], [9, 2], [10, 2]];
  await fs.mkdir(path.join(root, 'coverage'));
  await fs.writeFile(path.join(root, 'coverage/lcov.info'), `TN:\nSF:${path.join(root, 'src/a.ts')}\n${hits.map(([line, count]) => `DA:${line},${count}`).join('\n')}\nend_of_record\n`);
  await fs.writeFile(path.join(root, 'coverage/lcov.info.sources.json'), JSON.stringify({ 'src/a.ts': crypto.createHash('sha256').update(head).digest('hex') }));
  const result = cli(root);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^PASS src\/a\.ts:5 g cc=2 coverage=100\.00% CRAP=2\.0000/m);
  await fs.writeFile(path.join(root, 'coverage/lcov.info'), `SF:src/a.ts\n${hits.filter(([line]) => line !== 9).map(([line, count]) => `DA:${line},${count}`).join('\n')}\nend_of_record\n`);
  const missingLine = cli(root);
  assert.equal(missingLine.status, 2);
  assert.match(missingLine.stdout, /UNVERIFIED src\/a\.ts:5 g: Missing executable LCOV lines/);
});

test('GH-627: Vitest LCOV measures parenthesized arrows, split initializers and uninitialized declarations', async (context) => {
  const file = 'lcov-expression-starts.ts';
  const text = await fs.readFile(path.join(pluginRoot, 'test/fixtures', file), 'utf8');
  const root = await fixture(context, { [file]: text });
  await lcov(root, file, text);
  const recordedLines = [1, 2, 3, 7, 9, 10, 13, 15, 16];
  await fs.writeFile(path.join(root, 'coverage/lcov.info'), `SF:${file}\n${recordedLines.map((line) => `DA:${line},1`).join('\n')}\nend_of_record\n`);
  const report = await crapReport({ project: root });
  assert.deepEqual(report.changedMetrics.map((row) => [row.name, row.executableLines]), [
    ['paren', [2]], ['<anonymous>', [3]], ['declared', [9, 10]], ['uninit', [15, 16]],
  ]);
  assert.ok(report.changedMetrics.every((row) => row.coverage === 1 && !row.unverified));
  assert.equal(report.exitCode, 0);
  await fs.writeFile(path.join(root, 'coverage/lcov.info'), `SF:${file}\n${recordedLines.filter((line) => line !== 9).map((line) => `DA:${line},1`).join('\n')}\nend_of_record\n`);
  assert.match((await crapReport({ project: root })).changedMetrics.find((row) => row.name === 'declared').unverified, /Missing executable LCOV lines/);
});

test('the TS executable-line inventory skips decorators, blocks, empty, type-only and ambient statements', async () => {
  const text = [
    'export function g(a: number): number {',
    '  type Local = number;',
    '  interface Shape { x: number }',
    '  declare const ambient: number;',
    '  @sealed',
    '  class Box {',
    '    run() { return 1; }',
    '  }',
    '  if (a > 0) {',
    '    ;',
    '  }',
    '  return -a;',
    '}',
  ].join('\n');
  const rows = await analyzer.collectFunctions(text, 'g.ts');
  assert.deepEqual(rows.map((row) => [row.name, row.executableLines]), [['g', [6, 9, 12]], ['run', [7]]]);
  assert.ok(rows.every((row) => row.ownedLines === row.executableLines));
});

test('JS LCOV measures owned statement lines including nested callbacks and refuses missing lines', async (context) => {
  const text = 'function subject(value) {\n  const pick = (flag) =>\n    flag ? 1 : 0;\n  return pick(value);\n}\nfunction inline(items) {\n  return items.map((item) => item);\n}\n';
  const root = await fixture(context, { 'source.js': text });
  await lcov(root, 'source.js', text, 0);
  const report = await crapReport({ project: root });
  const byName = Object.fromEntries(report.changedMetrics.map((metric) => [metric.name, metric]));
  assert.deepEqual(byName.subject.executableLines, [2, 4]);
  assert.deepEqual(byName.pick.executableLines, [3]);
  assert.equal(byName.subject.coverage, 0);
  assert.equal(byName.pick.crap, 6);
  assert.equal(byName.inline.coverage, 0);
  assert.match(byName.inline.coverageNote, /upper bound for callback execution/);
  assert.equal(report.exitCode, 1);
  await fs.writeFile(path.join(root, 'coverage/lcov.info'), 'SF:source.js\nDA:2,1\nDA:3,1\nend_of_record\n');
  const unmeasured = await crapReport({ project: root });
  assert.match(unmeasured.changedMetrics.find((metric) => metric.name === 'subject').unverified, /Missing executable LCOV lines/);
  assert.equal(unmeasured.changedMetrics.find((metric) => metric.name === 'pick').coverage, 1);
});

test('LCOV merges duplicate files by maximum hits without inventing an executable inventory', () => {
  const files = coverageByFile('SF:source.js\nDA:1,0\nend_of_record\nSF:source.js\nDA:1,1\nDA:2,0\nend_of_record\n', '/project');
  assert.deepEqual([...files.values()][0].get(1), 1);
  const outer = { identity: 'outer', line: 1, endLine: 4 };
  const inner = { parent: 'outer', line: 2, endLine: 3 };
  assert.match(functionLineCoverage(outer, [outer, inner], new Map([[1, 1], [3, 0], [4, 1]])).unverified, /unverified for this adapter/);
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
  assert.deepEqual(receipt.reasons, []);
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
  const root = await fixture(context, { 'source.js': 'function subject(value) { if (value) return 1; return 0; }\n' });
  const head = commitBaseline(root);
  const unverified = cli(root, ['--base', 'HEAD', '--lcov', 'missing.info', '--json']);
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

test('Python real-source adapter scores production bodies without radon', async (context) => {
  const root = await fixture(context, { 'source.py': 'def subject():\n    return 1\n' });
  const report = await crapReport({ project: root, ccOnly: true });
  assert.equal(report.exitCode, 0);
  assert.equal(report.verdict, 'passed');
  assert.equal(report.changedMetrics[0].adapterVersion, 'python-ast-1');
  assert.equal(report.changedMetrics[0].complexity, 1);
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


test('DUPLICATE? flags a new normalized name in another HEAD source file without changing verdict or exit code', async (context) => {
  const root = await fixture(context, {
    'existing.py': 'def format_price(value):\n    return value\n',
    'new.js': '',
    'tests/ignored.js': 'export function formatPrice(value) { return value; }\n',
    'fixtures/ignored.js': 'export function formatPrice(value) { return value; }\n',
    'generated/ignored.js': 'export function formatPrice(value) { return value; }\n',
  });
  await config(root, { sources: ['new.js'] });
  const base = commitBaseline(root);
  await fs.writeFile(path.join(root, 'new.js'), 'export function differentName(value) { return value; }\n');
  const without = cli(root, ['--base', base, '--cc-only', '--json']);
  await fs.writeFile(path.join(root, 'new.js'), 'export function formatPrice(value) { return value; }\n');
  const execution = cli(root, ['--base', base, '--cc-only', '--json']);
  const report = JSON.parse(execution.stdout);
  assert.equal(execution.status, without.status, execution.stderr);
  assert.equal(report.verdict, JSON.parse(without.stdout).verdict);
  assert.deepEqual(report.signals, [{ kind: 'duplicate', name: 'formatPrice', file: 'new.js', line: 1, other: { name: 'format_price', file: 'existing.py', line: 1 } }]);
  const text = cli(root, ['--base', base, '--cc-only']);
  assert.match(text.stdout, /PASS[\s\S]*DUPLICATE\? formatPrice ≈ format_price \(existing.py:1\)[\s\S]*1 reuse signals/);
  assert.equal(text.status, execution.status);
  assert.equal(Object.hasOwn(JSON.parse(await fs.readFile(report.receipt, 'utf8')), 'signals'), false);
  const full = cli(root, ['--base', base, '--json']);
  await fs.writeFile(path.join(root, 'new.js'), 'export function differentName(value) { return value; }\n');
  const fullWithout = cli(root, ['--base', base, '--json']);
  assert.equal(full.status, fullWithout.status);
  assert.equal(JSON.parse(full.stdout).verdict, JSON.parse(fullWithout.stdout).verdict);
  assert.deepEqual(JSON.parse(fullWithout.stdout).signals, []);
});

test('CALLERS OPEN flags a removed paired body, is silent without callers, and preserves verdict and exit code', async (context) => {
  const root = await fixture(context, {
    'source.js': 'export function removed() { return 1; }\nexport function retained() { return 2; }\n',
    'caller.js': 'removed();\n',
    'tests/ignored.js': 'removed();\n',
  });
  await config(root, { sources: ['source.js'] });
  const base = commitBaseline(root);
  await fs.writeFile(path.join(root, 'source.js'), 'export function retained() { return 2; }\n');
  const execution = cli(root, ['--base', base, '--cc-only', '--json']);
  const report = JSON.parse(execution.stdout);
  assert.deepEqual(report.changedMetrics, []);
  assert.deepEqual(report.signals, [{ kind: 'callers-open', name: 'removed', file: 'source.js', line: 1, sites: [{ file: 'caller.js', line: 1 }] }]);
  assert.match(formatCrapReport(report), /CALLERS OPEN removed: caller.js:1[\s\S]*1 reuse signals/);
  await fs.writeFile(path.join(root, 'caller.js'), 'removed();\nremoved();\nremoved();\n');
  const multiple = await crapReport({ project: root, base, ccOnly: true });
  assert.deepEqual(multiple.signals[0].sites, [{ file: 'caller.js', line: 1 }, { file: 'caller.js', line: 2 }]);
  await fs.writeFile(path.join(root, 'caller.js'), '');
  const silent = cli(root, ['--base', base, '--cc-only', '--json']);
  assert.deepEqual(JSON.parse(silent.stdout).signals, []);
  assert.equal(silent.status, execution.status, silent.stderr);
  assert.equal(JSON.parse(silent.stdout).verdict, report.verdict);
  await fs.rm(path.join(root, 'source.js'));
  await fs.writeFile(path.join(root, 'caller.js'), 'removed();\n');
  const deleted = await crapReport({ project: root, base, ccOnly: true });
  assert.equal(deleted.signals[0].name, 'removed');
  assert.equal(deleted.exitCode, report.exitCode);
  await config(root, { sources: ['source.js'], exclude: ['source.js'] });
  assert.deepEqual((await crapReport({ project: root, base, ccOnly: true })).signals, []);
});

for (const [file, text, expectedNames] of [
  ['src/a.ts', await fs.readFile(path.join(pluginRoot, 'test/fixtures/nested-callback.ts.txt'), 'utf8'), ['g', '<anonymous>']],
  ['subject.py', 'def outer():\n    value = 1\n    return lambda: value\n', ['outer', 'outer.<lambda>']],
]) {
  test('nested LCOV line ownership scores both bodies with explicit upper-bound notes: ' + file, async (context) => {
    const root = await fixture(context, { [file]: text });
    await lcov(root, file, text);
    const report = await crapReport({ project: root });
    assert.equal(report.exitCode, 0);
    assert.deepEqual(report.changedMetrics.map((row) => row.name), expectedNames);
    for (const row of report.changedMetrics) {
      assert.equal(row.coverage, 1);
      assert.equal(row.crap, 1);
      assert.match(row.coverageNote, /upper bound for callback execution/);
    }
    const output = cli(root);
    assert.equal(output.status, 0, output.stdout + output.stderr);
    assert.equal(output.stdout.match(/upper bound for callback execution/g).length, 2);
  });
}

test('GH-573 shell reproduction scores g and its callback against the committed baseline', async (context) => {
  const root = await fixture(context, { 'src/a.ts': 'export const base = 1;\n' });
  commitBaseline(root);
  git(root, ['checkout', '-qb', 'feature']);
  const text = await fs.readFile(path.join(pluginRoot, 'test/fixtures/nested-callback.ts.txt'), 'utf8');
  await fs.writeFile(path.join(root, 'src/a.ts'), text);
  git(root, ['add', 'src/a.ts']);
  git(root, ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'add g']);
  await config(root, { sources: ['src'], base: 'main', lcov: 'coverage/lcov.info' });
  await lcov(root, 'src/a.ts', text);
  await fs.writeFile(path.join(root, 'coverage/lcov.info'), 'TN:\nSF:src/a.ts\nFN:3,g\nFN:4,(anonymous_1)\nFNDA:2,g\nFNDA:1,(anonymous_1)\nFNF:2\nFNH:2\nDA:1,1\nDA:3,2\nDA:4,2\nDA:5,2\nLF:4\nLH:4\nend_of_record\n');
  const result = cli(root);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^PASS src\/a\.ts:3 g cc=1 coverage=100\.00% CRAP=1\.0000/m);
  assert.match(result.stdout, /^PASS src\/a\.ts:4 <anonymous> cc=1 coverage=100\.00% CRAP=1\.0000/m);
});

test('sibling arrows sharing one executable line stay UNVERIFIED', async (context) => {
  const text = 'const first = () => 1; const second = () => 2;\n';
  const root = await fixture(context, { 'source.js': text });
  await lcov(root, 'source.js', text);
  const report = await crapReport({ project: root });
  assert.equal(report.exitCode, 0);
  assert.deepEqual(report.unverified, []);
  assert.ok(report.changedMetrics.every((row) => row.boundVerdict === 'pass' && /Sibling bodies share executable source lines/.test(row.unverified)));
  assert.equal(formatCrapReport(report).match(/coverage=unverified \(bound cc²\+cc=2 < 6\)/g).length, 2);
});

test('nested LCOV containment follows multiple parent identities and preserves zero and missing DA evidence', () => {
  const outer = { identity: 'outer', parent: '<root>', ownedLines: [1, 2], executableLines: [1, 2] };
  const middle = { identity: 'middle', parent: 'outer', ownedLines: [2], executableLines: [2] };
  const inner = { identity: 'inner', parent: 'middle', ownedLines: [2], executableLines: [2] };
  const descriptors = [outer, middle, inner];
  assert.equal(functionLineCoverage(outer, descriptors, new Map([[1, 1], [2, 0]])).coverage, 0.5);
  assert.equal(functionLineCoverage(inner, descriptors, new Map([[1, 1], [2, 0]])).coverage, 0);
  assert.match(functionLineCoverage(inner, descriptors, new Map([[1, 1]])).unverified, /Missing executable LCOV lines/);
});

for (const [complexity, exitCode, boundVerdict, verdict, unresolved, failures, outputPattern] of [
  [1, 0, 'pass', 'passed', 0, 0, /PASS .*coverage=unverified \(bound cc²\+cc=2 < 6\); No LCOV/],
  [2, 2, undefined, 'unverified', 1, 0, /UNVERIFIED .*No LCOV/],
  [3, 2, undefined, 'unverified', 1, 0, /UNVERIFIED .*No LCOV/],
  [6, 1, undefined, 'failed', 0, 1, /FAIL .*fails at any coverage/],
]) {
  test(`GH-628 crap cc-${complexity} resolves only coverage-independent verdicts`, async (context) => {
    const text = `export function subject(value) {\n${'if (value) value--;\n'.repeat(complexity - 1)}return value;\n}\n`;
    const root = await fixture(context, { 'source.js': text });
    const head = commitBaseline(root);
    const result = cli(root, ['--base', 'HEAD', '--lcov', 'missing.info', '--json']);
    assert.equal(result.status, exitCode, result.stderr);
    const report = JSON.parse(result.stdout);
    const metric = report.changedMetrics[0];
    assert.equal(metric.complexity, complexity);
    assert.equal(metric.classification, 'new');
    assert.match(metric.unverified, /No LCOV/);
    assert.equal(metric.coverage, undefined);
    assert.equal(metric.crap, undefined);
    assert.equal(metric.boundVerdict, boundVerdict);
    assert.equal(report.unverified.length, unresolved);
    assert.equal(report.failures.length, failures);
    const receipt = JSON.parse(await fs.readFile(report.receipt, 'utf8'));
    assert.equal(receipt.head, head);
    assert.equal(receipt.verdict, verdict);
    const output = formatCrapReport(report);
    assert.match(output, outputPattern);
  });
}
