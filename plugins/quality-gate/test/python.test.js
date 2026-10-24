import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { crapReport, formatCrapReport } from '../lib/crap.mjs';
import { pythonDescriptors, pythonRuntime } from '../lib/python.mjs';
import { functionLineCoverage } from '../lib/lcov.mjs';

const pluginRoot = fileURLToPath(new URL('../', import.meta.url));
const source = await fs.readFile(path.join(pluginRoot, 'test/fixtures/test_python_contract.py'), 'utf8');
const rows = pythonDescriptors(source, 'test_contract.py', pluginRoot);
const byName = new Map(rows.map((row) => [row.name, row]));

async function project(context, text = 'def subject(value):\n    return value if value else 0\n') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'quality-gate-python-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.claude/quality-gate'), { recursive: true });
  await fs.writeFile(path.join(root, '.claude/quality-gate/crap.json'), JSON.stringify({ sources: ['subject.py'] }));
  await fs.writeFile(path.join(root, 'subject.py'), text);
  return root;
}

function git(root, argumentsList) {
  const result = spawnSync('git', argumentsList, { cwd: root, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function baseline(root) {
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['add', '.']);
  git(root, ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline']);
  return git(root, ['rev-parse', 'HEAD']);
}

test('Python assert policy keeps boolean, comprehension and f-string decisions', () => {
  const oracle = byName.get('test_assert_decisions');
  assert.equal(oracle.complexity, 5);
  assert.equal(oracle.decisions, 4);
  assert.equal(oracle.assertionStatements, 1);
  assert.equal(oracle.oracleClassification, 'oracle');
  assert.equal(byName.get('ordinary_assert').complexity, 3);
  assert.equal(byName.get('ordinary_assert').oracleClassification, 'production');
  assert.ok(rows.every((row) => row.adapterVersion === 'python-ast-1' && row.oracleReason));
});

test('Python discovers nested classes, decorated methods, closures and callbacks independently', () => {
  assert.deepEqual(rows.map((row) => row.name), [
    'test_assert_decisions', 'ordinary_assert', 'prepared', 'setup_module',
    'test_nested', 'test_nested.Session.call_tool', 'test_nested.Session.call_tool.completed', 'test_nested.Session.close',
    'TestDecorated.ready', 'TestDecorated.test_method', 'Native.setUp', 'Native.test_method',
    'outer', 'outer.inner', 'outer.callback.<lambda>', 'callback_consumer', 'callback_consumer.<lambda>',
  ]);
  assert.equal(byName.get('test_nested').complexity, 1);
  assert.equal(byName.get('test_nested.Session.call_tool').complexity, 1);
  assert.equal(byName.get('test_nested.Session.call_tool.completed').complexity, 2);
  assert.equal(byName.get('test_nested.Session.close').oracleClassification, 'production');
  assert.equal(byName.get('test_nested.Session.close').complexity, 2);
  assert.equal(byName.get('outer.inner').parent, byName.get('outer').identity);
  assert.equal(byName.get('outer.callback.<lambda>').complexity, 2);
});

test('Python fixture/setup markers and source-qualified test classes have explicit reasons', () => {
  for (const name of ['prepared', 'setup_module', 'TestDecorated.ready', 'Native.setUp']) {
    assert.equal(byName.get(name).oracleClassification, 'fixture-setup', name);
    assert.equal(byName.get(name).complexity, 2, name);
  }
  assert.equal(byName.get('TestDecorated.test_method').oracleClassification, 'oracle');
  assert.match(byName.get('Native.test_method').oracleReason, /source-resolved unittest.TestCase/);
  const conftest = pythonDescriptors('def test_accidental():\n    assert True\n', 'conftest.py', pluginRoot);
  assert.equal(conftest[0].oracleClassification, 'fixture-setup');
  assert.equal(conftest[0].complexity, 2);
  assert.equal(pythonDescriptors('def test_production():\n    assert True\n', 'production.py', pluginRoot)[0].oracleClassification, 'production');
});

test('Python per-body coverage excludes nested declarations and requires complete callback DA lines', () => {
  const outer = byName.get('test_nested.Session.call_tool');
  const inner = byName.get('test_nested.Session.call_tool.completed');
  const lines = new Map([...outer.executableLines.map((line) => [line, 1]), ...inner.executableLines.map((line) => [line, 0])]);
  assert.equal(functionLineCoverage(outer, rows, lines).coverage, 1);
  assert.equal(functionLineCoverage(inner, rows, lines).coverage, 0);
  assert.match(functionLineCoverage(byName.get('callback_consumer.<lambda>'), rows, lines).unverified, /Missing executable LCOV lines/);
});

test('Python same-byte coverage hash mismatch is unverified and report names adapter version', async (context) => {
  const root = await project(context);
  await fs.writeFile(path.join(root, 'coverage.info'), 'SF:subject.py\nDA:2,1\nend_of_record\n');
  await fs.writeFile(path.join(root, 'coverage.info.sources.json'), JSON.stringify({ 'subject.py': 'wrong' }));
  const mismatched = await crapReport({ project: root, lcov: 'coverage.info' });
  assert.equal(mismatched.exitCode, 2);
  assert.match(mismatched.unverified[0].unverified, /source hash is missing or differs/);
  const text = await fs.readFile(path.join(root, 'subject.py'));
  await fs.writeFile(path.join(root, 'coverage.info.sources.json'), JSON.stringify({ 'subject.py': crypto.createHash('sha256').update(text).digest('hex') }));
  const matched = await crapReport({ project: root, lcov: 'coverage.info' });
  assert.equal(matched.exitCode, 0);
  assert.equal(matched.changedMetrics[0].coverage, 1);
  assert.match(formatCrapReport(matched), /adapter=python-ast-1 role=production/);
});

test('Python ratchet isolates nested edits and enforces raised or new rows strictly below six', async (context) => {
  const original = 'def outer():\n    def inner(value):\n        return value\n    return inner\n';
  const root = await project(context, original);
  const base = baseline(root);
  await fs.writeFile(path.join(root, 'subject.py'), original.replace('return value', 'return value if value else 0'));
  const changed = await crapReport({ project: root, base, ccOnly: true });
  assert.deepEqual(changed.changedMetrics.map((row) => [row.name, row.classification]), [['outer.inner', 'modified-raised']]);
  await fs.writeFile(path.join(root, 'subject.py'), original.replace('return value', 'return 0'));
  assert.equal((await crapReport({ project: root, base, ccOnly: true })).changedMetrics[0].classification, 'legacy-unchanged');
  await fs.writeFile(path.join(root, 'subject.py'), original + 'def added(value):\n    return value and value and value and value and value and value\n');
  const failed = await crapReport({ project: root, base, ccOnly: true });
  assert.equal(failed.exitCode, 1);
  assert.equal(failed.failures[0].complexity, 6);
  assert.equal(failed.failures[0].classification, 'new');
});

test('Python fresh coverageCommand rejects source mutation around the capture', async (context) => {
  const root = await project(context);
  const command = `${JSON.stringify(process.execPath)} -e "require('node:fs').appendFileSync('subject.py','\\n# changed\\n')"`;
  await assert.rejects(crapReport({ project: root, coverageCommand: command }), /Scored source changed during coverageCommand/);
});

for (const [label, text, expectedExitCode, expectedCoverage, reason] of [
  ['complete', 'def subject(value):\n    first = value\n    return first if first else 0\n\nsubject(1)\nsubject(0)\n', 0, 1],
  ['explicit zero for an uncalled body', 'def subject(value):\n    first = value\n    return first if first else 0\n', 1, 0],
  ['excluded statement', 'def subject(value):\n    first = value\n    return first if first else 0  # pragma: no cover\n\nsubject(1)\n', 2, undefined, /Missing executable LCOV lines/],
  ['ambiguous multiline normalization', 'def subject(value):\n    return (\n        value\n    )\n\nsubject(1)\n', 0, undefined, /Missing executable LCOV lines/],
]) {
  test('Python live coverage.py executable inventory: ' + label, async (context) => {
    const available = spawnSync('coverage', ['--version'], { encoding: 'utf8', timeout: 10000 });
    if (available.status !== 0) return context.skip('UNVERIFIED: local coverage.py is unavailable; install coverage with pipx for the live probe.');
    const root = await project(context, text);
    const capture = path.join(root, 'capture.cjs');
    await fs.writeFile(capture, `const fs = require('node:fs'); const {spawnSync} = require('node:child_process'); const directory = process.env.QUALITY_GATE_COVERAGE_DIR; if(fs.readdirSync(directory).length) process.exit(8); const environment = {...process.env, COVERAGE_FILE: directory+'/.coverage'}; for(const argumentsList of [['run','subject.py'], ['lcov','-o', directory+'/lcov.info']]) { const result=spawnSync('coverage',argumentsList,{env:environment,encoding:'utf8'}); if(result.status!==0) {process.stderr.write(result.stderr); process.exit(result.status || 1);} }`);
    const report = await crapReport({ project: root, coverageCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(capture)}` });
    assert.equal(report.exitCode, expectedExitCode);
    assert.equal(report.changedMetrics[0].coverage, expectedCoverage);
    assert.equal(report.unverified.length, Number(expectedExitCode === 2));
    if (reason) assert.match(report.changedMetrics[0].unverified, reason);
  });
}

test('Python sources with non-ASCII text are scored, not mangled by the locale codec', () => {
  const rows = pythonDescriptors('def subject():\n    return "café \u0081"\n', 'unicode.py', pluginRoot);
  assert.equal(rows[0].name, 'subject');
  assert.equal(rows[0].complexity, 1);
  assert.equal(rows[0].unverified, undefined);
});

test('Python syntax failures are per-file unverified rows and runtime remains available', () => {
  let rows;
  assert.doesNotThrow(() => { rows = pythonDescriptors('def broken(:', 'broken.py', pluginRoot); });
  assert.match(rows[0].unverified, /SyntaxError/);
  assert.ok(pythonRuntime(pluginRoot).command);
});

for (const [label, body, expected] of [
  ['loops and handlers', '    for value in []:\n        pass\n    while False:\n        pass\n    try:\n        pass\n    except Exception:\n        pass\n', 4],
  ['async loop', '    async for value in values:\n        pass\n', 2],
  ['match guard and wildcard', '    match value:\n        case 1 if value:\n            pass\n        case _:\n            pass\n', 3],
  ['annotated callback', '    callback: object = lambda value: value\n    return callback\n', 1],
]) {
  test('Python decision convention: ' + label, () => {
    const definitions = pythonDescriptors('async def subject(values):\n' + body, 'source.py', pluginRoot);
    assert.equal(definitions[0].complexity, expected);
  });
}

test('Python runtime missing prerequisite never becomes informational green', () => {
  const previous = process.env.PATH;
  try {
    process.env.PATH = '';
    assert.throws(() => pythonRuntime(pluginRoot), /Python 3 is unavailable.*Radon is not required/);
  } finally {
    process.env.PATH = previous;
  }
});

test('Python header changes keep function identity while changing its fingerprint', () => {
  const before = pythonDescriptors('def subject(value):\n    return value\n', 'source.py', pluginRoot);
  const after = pythonDescriptors('@decorator\ndef subject(value=0):\n    return value\n', 'source.py', pluginRoot);
  assert.equal(before[0].identity, after[0].identity);
  assert.notEqual(before[0].fingerprint, after[0].fingerprint);
});

test('Python incomplete executable-line records stay unverified', () => {
  const descriptors = pythonDescriptors('def subject():\n    first = 1\n    return first\n', 'subject.py', pluginRoot);
  const measured = functionLineCoverage(descriptors[0], descriptors, new Map([[2, 1]]));
  assert.match(measured.unverified, /Missing executable LCOV lines/);
  assert.equal(measured.coverage, undefined);
});

for (const [label, records, expected] of [
  ['complete hit records', [[2, 1], [3, 1]], 1],
  ['explicit measured zero', [[2, 0], [3, 0]], 0],
  ['one explicit measured zero', [[2, 1], [3, 0]], 0.5],
]) {
  test('Python executable inventory: ' + label, () => {
    const descriptors = pythonDescriptors('def subject():\n    first = 1\n    return first\n', 'subject.py', pluginRoot);
    assert.deepEqual(descriptors[0].executableLines, [2, 3]);
    assert.equal(functionLineCoverage(descriptors[0], descriptors, new Map(records)).coverage, expected);
  });
}

test('Python optimized-away statements are absent from native executable inventory', () => {
  const descriptors = pythonDescriptors('def subject():\n    \"unused docstring\"\n    first = 1\n    return first\n', 'subject.py', pluginRoot);
  assert.deepEqual(descriptors[0].executableLines, [3, 4]);
  assert.equal(functionLineCoverage(descriptors[0], descriptors, new Map([[3, 1], [4, 1]])).coverage, 1);
});

test('Python old descriptors without native inventory stay unverified', () => {
  const [descriptor] = pythonDescriptors('def subject():\n    return 1\n', 'subject.py', pluginRoot);
  const { executableLines, ...oldDescriptor } = descriptor;
  assert.match(functionLineCoverage(oldDescriptor, [oldDescriptor], new Map([[2, 1]])).unverified, /inventory is missing/);
});

test('Python bodies without native executable lines stay unverified', () => {
  const descriptors = pythonDescriptors('def subject():\n    "docstring only"\n', 'subject.py', pluginRoot);
  assert.deepEqual(descriptors[0].executableLines, []);
  assert.match(functionLineCoverage(descriptors[0], descriptors, new Map()).unverified, /No executable LCOV lines/);
});

for (const [label, bytes, reason] of [
  ['invalid UTF-8', Buffer.from([0x23, 0x81, 0x0a]), /UTF-8 decode failed/],
  ['syntax error', Buffer.from('def broken(:'), /SyntaxError/],
]) {
  test('Python changed body stays measured beside unchanged ' + label, async (context) => {
    const root = await project(context);
    await fs.writeFile(path.join(root, '.claude/quality-gate/crap.json'), JSON.stringify({ sources: ['.'] }));
    await fs.writeFile(path.join(root, 'broken.py'), bytes);
    const base = baseline(root);
    await fs.appendFile(path.join(root, 'subject.py'), '\ndef added():\n    return 1\n');
    let report;
    await assert.doesNotReject(async () => { report = await crapReport({ project: root, base, ccOnly: true }); });
    assert.equal(report.checked, 1);
    assert.equal(report.changedMetrics.find((row) => row.name === 'added').complexity, 1);
    assert.deepEqual(report.unverified, [], 'an unchanged file is not analysed against a base (GitHub #554)');
    assert.equal(report.failures.length, 0);
    const wholeTree = await crapReport({ project: root, base: 'HEAD', ccOnly: true });
    assert.equal(wholeTree.unverified[0].relativePath, 'broken.py');
    assert.match(wholeTree.unverified[0].unverified, reason);
  });
}

test('Python source protocol isolates a lone surrogate as an unverified row', () => {
  let rows;
  assert.doesNotThrow(() => { rows = pythonDescriptors('# ' + String.fromCharCode(0xdc81), 'broken.py', pluginRoot); });
  const [row] = rows;
  assert.match(row.unverified, /UnicodeEncodeError.*surrogates not allowed/);
  assert.equal(row.informational, true);
});

test('repeatable CLI source selectors narrow configured scope and keep exclusions', async (context) => {
  const root = await project(context);
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src/first.py'), 'def first():\n    return 1\n');
  await fs.writeFile(path.join(root, 'src/second.py'), 'def second():\n    return 2\n');
  await fs.writeFile(path.join(root, 'src/excluded.py'), 'def excluded():\n    return 3\n');
  const configPath = path.join(root, '.claude/quality-gate/crap.json');
  const config = JSON.stringify({ sources: ['src'], exclude: ['**/excluded.py'] });
  await fs.writeFile(configPath, config);
  const entry = path.join(pluginRoot, 'bin/quality-gate.js');
  const result = spawnSync(process.execPath, [entry, 'crap', '--project', root, '--cc-only', '--json', '--source', 'src/first.py', '--source', 'src/excluded.py', '--source', 'subject.py'], { cwd: pluginRoot, encoding: 'utf8', timeout: 60000 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(Object.keys(JSON.parse(result.stdout).files), ['src/first.py']);
  assert.equal(await fs.readFile(configPath, 'utf8'), config);
  const defaults = await crapReport({ project: root, ccOnly: true, source: ['src'] });
  assert.deepEqual(Object.keys(defaults.files).sort(), ['src/first.py', 'src/second.py']);
  await fs.rm(configPath);
  git(root, ['init', '-q']);
  git(root, ['add', '.']);
  const selected = await crapReport({ project: root, ccOnly: true, source: ['src/second.py', 'subject.py'] });
  assert.deepEqual(Object.keys(selected.files).sort(), ['src/second.py', 'subject.py']);
});
