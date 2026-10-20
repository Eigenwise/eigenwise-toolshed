import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { crapReport, formatCrapReport } from '../lib/crap.mjs';
import { gateSettings } from '../lib/crap-inputs.mjs';
import { pythonDescriptors, pythonRuntime, PYTHON_POLICIES } from '../lib/python.mjs';
import { functionLineCoverage } from '../lib/lcov.mjs';

const pluginRoot = fileURLToPath(new URL('../', import.meta.url));
const entry = path.join(pluginRoot, 'bin/quality-gate.js');
const adapter = path.join(pluginRoot, 'lib/python/crap_adapter.py');
const [defaultPolicy, nativePolicy] = PYTHON_POLICIES;
const productionLoop = 'def subject(value):\n    for item in []:\n        pass\n    else:\n        pass\n    if value:\n        pass\n    if value:\n        pass\n    if value:\n        pass\n';

for (const [label, text, nativeComplexity, defaultComplexity] of [
  ['production for/else plus three ifs', productionLoop, 6, 5],
  ['while else', 'def subject(value):\n    while value:\n        break\n    else:\n        pass\n', 3, 2],
  ['async for else', 'async def subject(values):\n    async for value in values:\n        pass\n    else:\n        pass\n', 3, 2],
  ['try handlers and else', 'def subject():\n    try:\n        pass\n    except ValueError:\n        pass\n    except TypeError:\n        pass\n    else:\n        pass\n', 4, 3],
  ['ordinary assertion stops predicate and message traversal', 'def subject(value):\n    assert value or value == 0, f"{1 if value else 0}"\n', 2, 4],
  ['native match keeps predicate decisions without guard surcharge', 'def subject(value):\n    match value:\n        case 1 if value and value:\n            pass\n        case _:\n            pass\n', 3, 4],
  ['native match wildcard guard', 'def subject(value):\n    match value:\n        case _ if value:\n            pass\n', 1, 2],
]) {
  test('Native Python policy: ' + label, () => {
    const native = pythonDescriptors(text, 'subject.py', pluginRoot, nativePolicy);
    assert.equal(native[0].complexity, nativeComplexity);
    assert.equal(native[0].measurementPolicy, nativePolicy);
    assert.equal(native[0].oracleClassification, 'production');
    assert.equal(pythonDescriptors(text, 'subject.py', pluginRoot)[0].complexity, defaultComplexity);
  });
}

for (const [label, assertion, decisions] of [
  ['predicate boolean and comprehension', 'values and all(value for value in values if value)', 3],
  ['message boolean', 'True, values or []', 1],
  ['message f-string conditional', 'True, f"{1 if values else 0}"', 1],
]) {
  test('Explicit Python oracle retains ' + label, () => {
    const text = 'def test_subject(values):\n    assert ' + assertion + '\n';
    const [oracle] = pythonDescriptors(text, 'test_subject.py', pluginRoot, nativePolicy);
    assert.equal(oracle.complexity, 1 + decisions);
    assert.equal(oracle.decisions, decisions);
    assert.equal(oracle.assertionStatements, 1);
    assert.equal(oracle.oracleReason, 'test_* definition in test_*.py or *_test.py');
    const [ordinary] = pythonDescriptors(text, 'subject.py', pluginRoot, nativePolicy);
    assert.equal(ordinary.complexity, 2);
    assert.equal(ordinary.oracleClassification, 'production');
  });
}

for (const [label, header, filename, defaultComplexity] of [
  ['Test class helper', 'class TestSubject:', 'test_subject.py', 1],
  ['source-resolved TestCase helper', 'from unittest import TestCase as Base\nclass Subject(Base):', 'subject.py', 1],
  ['ordinary helper in test module', '', 'test_subject.py', 6],
]) {
  test('Native Python keeps five ordinary asserts in ' + label, () => {
    const indent = header ? '    ' : '';
    const text = header + '\n' + indent + 'def prepare(self):\n' + (indent + '    assert True\n').repeat(5);
    const [row] = pythonDescriptors(text, filename, pluginRoot, nativePolicy);
    assert.equal(row.complexity, 6);
    assert.equal(row.assertionStatements, 5);
    assert.equal(row.oracleClassification, 'production');
    assert.equal(row.oracleReason, 'no explicit test_* oracle name');
    assert.equal(pythonDescriptors(text, filename, pluginRoot)[0].complexity, defaultComplexity);
  });
}

for (const [filename, text, role, reason] of [
  ['subject_test.py', 'def test_subject():\n    assert True\n', 'oracle', /test_\* definition/],
  ['subject.py', 'import unittest as checks\nclass Subject(checks.TestCase):\n    def test_subject(self):\n        assert True\n', 'oracle', /test_\* method of source-resolved/],
  ['test_subject.py', 'from pytest import fixture as preparation\n@preparation\ndef test_subject():\n    assert True\n', 'fixture-setup', /pytest fixture/],
  ['test_subject.py', 'def setup_module():\n    assert True\n', 'fixture-setup', /setup.*teardown/],
  ['conftest.py', 'def test_subject():\n    assert True\n', 'fixture-setup', /conftest/],
]) {
  test('Explicit Python qualification: ' + filename + ' ' + reason, () => {
    const [row] = pythonDescriptors(text, filename, pluginRoot, nativePolicy);
    assert.equal(row.oracleClassification, role);
    assert.match(row.oracleReason, reason);
    assert.equal(row.complexity, 1 + Number(role !== 'oracle'));
  });
}

test('Native Python independently owns nested methods closures and lambdas', () => {
  const text = 'def test_outer():\n    class Session:\n        def prepare(self):\n            assert True\n    def inner(value):\n        assert value or value == 0\n    callback = lambda value: value if value else 0\n    assert True\n    return Session, inner, callback\n';
  const rows = pythonDescriptors(text, 'test_subject.py', pluginRoot, nativePolicy);
  assert.deepEqual(rows.map((row) => [row.name, row.complexity, row.oracleClassification]), [
    ['test_outer', 1, 'oracle'], ['test_outer.Session.prepare', 2, 'production'],
    ['test_outer.inner', 2, 'production'], ['test_outer.callback.<lambda>', 2, 'production'],
  ]);
  assert.ok(rows.slice(1).every((row) => row.parent === rows[0].identity));
  const lines = new Map(rows[0].executableLines.map((line) => [line, 1]));
  assert.equal(functionLineCoverage(rows[0], rows, lines).coverage, 1);
  assert.match(functionLineCoverage(rows[0], rows, lines).coverageNote, /upper bound for callback execution/);
  const methodLines = new Map(rows[1].executableLines.map((line) => [line, 1]));
  assert.equal(functionLineCoverage(rows[1], rows, methodLines).coverage, 1);
  assert.match(functionLineCoverage(rows[1], rows, lines).unverified, /Missing executable LCOV lines/);
});

test('Python policy protocol has an explicit default and rejects unknown identities', () => {
  const { command, argumentsList } = pythonRuntime(pluginRoot);
  const request = { text: 'def subject():\n    assert True\n', file: 'subject.py' };
  const execution = spawnSync(command, [...argumentsList, '-I', adapter], { input: JSON.stringify(request), encoding: 'utf8', timeout: 30000 });
  assert.equal(execution.status, 0, execution.stderr);
  assert.equal(JSON.parse(execution.stdout).measurementPolicy, defaultPolicy);
  const invalid = spawnSync(command, [...argumentsList, '-I', adapter], { input: JSON.stringify({ ...request, policy: 'unknown' }), encoding: 'utf8', timeout: 30000 });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /Unknown Python measurement policy/);
  assert.throws(() => pythonDescriptors(request.text, request.file, pluginRoot, 'unknown'), /Unknown Python measurement policy/);
  assert.throws(() => gateSettings({ pythonPolicy: 'unknown' }, {}), /Unknown Python measurement policy/);
  assert.equal(gateSettings({ pythonPolicy: defaultPolicy }, { pythonPolicy: nativePolicy }).pythonPolicy, defaultPolicy);
});

async function project(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'quality-gate-policy-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.claude/quality-gate'), { recursive: true });
  await fs.writeFile(path.join(root, 'subject.py'), productionLoop);
  await fs.writeFile(path.join(root, '.claude/quality-gate/crap.json'), JSON.stringify({ sources: ['subject.py'], pythonPolicy: nativePolicy }));
  return root;
}

function cli(root, argumentsList) {
  return spawnSync(process.execPath, [entry, 'crap', '--project', root, ...argumentsList], { encoding: 'utf8', timeout: 60000 });
}

test('Python policy config CLI and baseline all use the selected version', async (context) => {
  const root = await project(context);
  const defaultExecution = cli(root, ['--cc-only', '--json', '--python-policy', defaultPolicy]);
  assert.equal(defaultExecution.status, 0, defaultExecution.stderr);
  assert.equal(JSON.parse(defaultExecution.stdout).changedMetrics[0].complexity, 5);
  const nativeExecution = cli(root, ['--cc-only', '--json']);
  assert.equal(nativeExecution.status, 1, nativeExecution.stderr);
  assert.equal(JSON.parse(nativeExecution.stdout).changedMetrics[0].complexity, 6);
  const optionReport = await crapReport({ project: root, pythonPolicy: defaultPolicy, ccOnly: true });
  assert.equal(optionReport.pythonPolicy, defaultPolicy);
  const git = spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root, encoding: 'utf8' });
  assert.equal(git.status, 0, git.stderr);
  assert.equal(spawnSync('git', ['add', '.'], { cwd: root }).status, 0);
  const committed = spawnSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline'], { cwd: root, encoding: 'utf8' });
  assert.equal(committed.status, 0, committed.stderr);
  assert.equal((await crapReport({ project: root, base: 'HEAD', ccOnly: true })).metrics[0].measurementPolicy, nativePolicy);
  await fs.appendFile(path.join(root, 'subject.py'), '    # physical edit\n');
  const changed = await crapReport({ project: root, base: 'main', ccOnly: true });
  assert.equal(changed.changedMetrics[0].classification, 'legacy-unchanged');
  assert.equal(changed.changedMetrics[0].complexity, 6);
  assert.deepEqual(changed.failures, []);
  assert.equal(changed.exitCode, 0);
  const receiptExecution = cli(root, ['--cc-only', '--json']);
  const report = JSON.parse(receiptExecution.stdout);
  assert.equal(JSON.parse(await fs.readFile(report.receipt, 'utf8')).pythonPolicy, nativePolicy);
  const invalid = cli(root, ['--json', '--python-policy', 'unknown']);
  assert.equal(invalid.status, 2);
  assert.match(JSON.parse(invalid.stdout).unverified[0].unverified, /Unknown Python measurement policy/);
  await fs.writeFile(path.join(root, '.claude/quality-gate/crap.json'), JSON.stringify({ pythonPolicy: 2 }));
  assert.equal(cli(root, ['--json']).status, 2);
  const help = spawnSync(process.execPath, [entry, '--help'], { encoding: 'utf8' });
  assert.ok(PYTHON_POLICIES.every((policy) => help.stdout.includes(policy)));
});

test('Native Python coverage keeps same-byte proof and complete ownership requirements', async (context) => {
  const root = await project(context);
  const text = 'def subject(value):\n    assert value or value == 0\n';
  await fs.writeFile(path.join(root, 'subject.py'), text);
  await fs.writeFile(path.join(root, 'coverage.info'), 'SF:subject.py\nDA:2,1\nend_of_record\n');
  const missing = await crapReport({ project: root, lcov: 'coverage.info' });
  assert.equal(missing.exitCode, 2);
  const hash = crypto.createHash('sha256').update(text).digest('hex');
  await fs.writeFile(path.join(root, 'coverage.info.sources.json'), JSON.stringify({ 'subject.py': hash }));
  const matched = await crapReport({ project: root, lcov: 'coverage.info' });
  assert.equal(matched.changedMetrics[0].complexity, 2);
  assert.equal(matched.changedMetrics[0].coverage, 1);
  assert.match(formatCrapReport(matched), /policy=python-radon-6.0.1-oracle-1/);
  await fs.appendFile(path.join(root, 'subject.py'), '    # mutation\n');
  assert.equal((await crapReport({ project: root, lcov: 'coverage.info' })).exitCode, 2);
});

const explicitHelperSource = 'def _assert_unchanged(value):\n    assert value or value == 0, f"{1 if value else 0}"\n    def nested():\n        assert True\n    return nested\ndef test_replacement(value):\n    assert value or value == 0\ndef test_unlisted(value):\n    assert value or value == 0\ndef neighbor():\n    assert True\n';
const explicitOracles = [
  { file: 'test_subject.py', name: '_assert_unchanged', reason: 'snapshot invariant oracle' },
  { file: 'test_subject.py', name: 'test_replacement', reason: 'replacement invariant oracle' },
];

test('Explicit Python allowlist selects exact pair with reasons and no inherited or name fallback', () => {
  const rows = pythonDescriptors(explicitHelperSource, 'test_subject.py', pluginRoot, nativePolicy, explicitOracles);
  assert.deepEqual(rows.map((row) => [row.name, row.complexity, row.oracleClassification]), [
    ['_assert_unchanged', 3, 'oracle'], ['_assert_unchanged.nested', 2, 'production'],
    ['test_replacement', 2, 'oracle'], ['test_unlisted', 2, 'production'], ['neighbor', 2, 'production'],
  ]);
  assert.deepEqual(rows[0].oracleSelector, explicitOracles[0]);
  assert.match(rows[0].oracleReason, /explicit file.*name selector: snapshot invariant oracle/);
  assert.equal(rows[1].oracleSelector, null);
  assert.equal(rows[3].oracleReason, 'not in explicit oracle allowlist');
  const empty = pythonDescriptors(explicitHelperSource, 'test_subject.py', pluginRoot, nativePolicy, []);
  assert.ok(empty.every((row) => row.oracleClassification === 'production'));
  assert.equal(empty[0].complexity, 2);
  assert.equal(pythonDescriptors(explicitHelperSource, 'different_test.py', pluginRoot, nativePolicy, explicitOracles)[0].oracleClassification, 'production');
});

for (const [label, oracles] of [
  ['null', null], ['non-array', {}], ['missing reason', [{ file: 'test_subject.py', name: '_assert_unchanged' }]],
  ['blank reason', [{ ...explicitOracles[0], reason: ' ' }]], ['non-string', [{ ...explicitOracles[0], reason: 2 }]],
  ['glob file', [{ ...explicitOracles[0], file: '**/test_subject.py' }]],
  ['relative escape', [{ ...explicitOracles[0], file: '../test_subject.py' }]],
  ['absolute file', [{ ...explicitOracles[0], file: '/test_subject.py' }]],
  ['pattern name', [{ ...explicitOracles[0], name: '_assert_*' }]],
  ['duplicate', [explicitOracles[0], explicitOracles[0]]],
  ['conflicting', [explicitOracles[0], { ...explicitOracles[0], reason: 'another reason' }]],
]) {
  test('Explicit Python rejects malformed selector: ' + label, () => {
    assert.throws(() => pythonDescriptors(explicitHelperSource, 'test_subject.py', pluginRoot, nativePolicy, oracles), /pythonOracles/);
    const { command, argumentsList } = pythonRuntime(pluginRoot);
    const direct = spawnSync(command, [...argumentsList, '-I', adapter], { input: JSON.stringify({ text: explicitHelperSource, file: 'test_subject.py', policy: nativePolicy, oracles }), encoding: 'utf8', timeout: 30000 });
    assert.notEqual(direct.status, 0);
    assert.match(direct.stderr, /ValueError/);
  });
}

for (const [label, text, selector, reason] of [
  ['missing body', explicitHelperSource, { ...explicitOracles[0], name: 'absent' }, /exactly one/],
  ['ambiguous body', 'def subject():\n    assert True\ndef subject():\n    assert True\n', { ...explicitOracles[0], name: 'subject' }, /exactly one/],
  ['fixture precedence', 'from pytest import fixture\n@fixture\ndef subject():\n    assert True\n', { ...explicitOracles[0], name: 'subject' }, /fixture.*setup/],
]) {
  test('Explicit Python refuses ' + label, () => {
    assert.throws(() => pythonDescriptors(text, 'test_subject.py', pluginRoot, nativePolicy, [selector]), reason);
  });
}

test('Explicit Python allowlist config resolves selected scope and newly introduced baseline names', async (context) => {
  const root = await project(context);
  await fs.rename(path.join(root, 'subject.py'), path.join(root, 'test_subject.py'));
  await fs.writeFile(path.join(root, '.claude/quality-gate/crap.json'), JSON.stringify({ sources: ['test_subject.py'], pythonPolicy: nativePolicy, pythonOracles: explicitOracles }));
  await fs.writeFile(path.join(root, 'test_subject.py'), explicitHelperSource);
  const report = await crapReport({ project: root, ccOnly: true });
  assert.deepEqual(report.pythonOracles, explicitOracles);
  assert.equal(report.metrics[0].complexity, 3);
  const outOfScope = [{ ...explicitOracles[0], file: 'unselected.py' }];
  await assert.rejects(crapReport({ project: root, ccOnly: true, pythonOracles: outOfScope }), /selected source scope/);
  await assert.rejects(crapReport({ project: root, ccOnly: true, pythonPolicy: defaultPolicy }), /requires the native/);
  assert.ok((await crapReport({ project: root, ccOnly: true, pythonOracles: [] })).metrics.every((row) => row.oracleClassification === 'production'));
  const execution = cli(root, ['--cc-only', '--json']);
  assert.equal(execution.status, 0, execution.stderr);
  assert.deepEqual(JSON.parse(execution.stdout).pythonOracles, explicitOracles);
  await fs.writeFile(path.join(root, 'test_subject.py'), 'def before():\n    return 1\n');
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root }).status, 0);
  assert.equal(spawnSync('git', ['add', '.'], { cwd: root }).status, 0);
  assert.equal(spawnSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline'], { cwd: root }).status, 0);
  await fs.writeFile(path.join(root, 'test_subject.py'), explicitHelperSource);
  const changed = await crapReport({ project: root, base: 'main', ccOnly: true });
  assert.equal(changed.metrics[0].oracleClassification, 'oracle');
  assert.equal(changed.exitCode, 0);
});


test('Python policy enum stays current in CLI README and prose', async () => {
  const readme = await fs.readFile(path.join(pluginRoot, 'README.md'), 'utf8');
  const prose = await fs.readFile(path.join(pluginRoot, '../../docs/src/content/docs/getting-started/quality-gate.md'), 'utf8');
  assert.ok(PYTHON_POLICIES.every((policy) => readme.includes(policy) && prose.includes(policy)));
  assert.ok(['pythonOracles', 'oracleSelector', 'oracleReason'].every((field) => readme.includes(field) && prose.includes(field)));
});

for (const [label, classBody, defaultComplexity, defaultAssertions] of [
  ['five class asserts', '        assert True\n'.repeat(5), 6, 5],
  ['class branch loop try', '        if value:\n            pass\n        for item in []:\n            pass\n        else:\n            pass\n        try:\n            pass\n        except ValueError:\n            pass\n        else:\n            pass\n', 4, 0],
]) {
  test('Native Python isolates local ' + label, () => {
    const text = 'def subject(value):\n    class Local:\n' + classBody + '    return Local\n';
    const [ordinary] = pythonDescriptors(text, 'subject.py', pluginRoot, nativePolicy);
    assert.equal(ordinary.complexity, 1);
    assert.equal(ordinary.decisions, 0);
    assert.equal(ordinary.assertionStatements, 0);
    const [legacy] = pythonDescriptors(text, 'subject.py', pluginRoot, defaultPolicy);
    assert.equal(legacy.complexity, defaultComplexity);
    assert.equal(legacy.assertionStatements, defaultAssertions);
  });
}

test('Native Python isolates class decorators bases and decisions but keeps parent and independent methods and lambdas', () => {
  const text = 'def subject(value):\n    if value:\n        pass\n    assert value or value == 0\n    @decorate(value or False)\n    class Local(Base if value else Other):\n        if value:\n            pass\n        assert True\n        callback = lambda item: item if item else 0\n        @decorate(lambda item: item or 0)\n        def method(self, choice=lambda item: item if item else 0):\n            if value:\n                pass\n            assert value or value == 0\n    return Local\n';
  const rows = pythonDescriptors(text, 'subject.py', pluginRoot, nativePolicy);
  assert.deepEqual(rows.map((row) => [row.name, row.complexity, row.assertionStatements]), [
    ['subject', 3, 1], ['subject.Local.callback.<lambda>', 2, 0],
    ['subject.Local.method', 3, 1], ['subject.Local.method.<lambda>', 2, 0], ['subject.Local.method.<lambda>', 2, 0],
  ]);
  assert.equal(rows[1].parent, rows[0].identity);
  assert.equal(rows[2].parent, rows[0].identity);
  assert.ok(rows.slice(3).every((row) => row.parent === rows[2].identity));
});

for (const [label, name, filename, oracles, complexity, role] of [
  ['source-named oracle', 'test_subject', 'test_subject.py', undefined, 3, 'oracle'],
  ['exact helper oracle', '_assert_unchanged', 'subject.py', [{file:'subject.py',name:'_assert_unchanged',reason:'class isolation oracle'}], 3, 'oracle'],
  ['empty allowlist', 'test_subject', 'test_subject.py', [], 2, 'production'],
]) {
  test('Native Python assertion inventory isolates local classes for ' + label, () => {
    const text = 'def ' + name + '(value):\n    assert value or value == 0, f"{1 if value else 0}"\n    class Local:\n' + '        assert True\n'.repeat(5) + '        if value:\n            pass\n        def method(self):\n            assert True\n    return Local\n';
    const rows = pythonDescriptors(text, filename, pluginRoot, nativePolicy, oracles);
    assert.equal(rows[0].complexity, complexity);
    assert.equal(rows[0].assertionStatements, 1);
    assert.equal(rows[0].oracleClassification, role);
    assert.deepEqual(rows.slice(1).map((row) => [row.name, row.complexity, row.assertionStatements, row.oracleClassification]), [
      [name + '.Local.method', 2, 1, 'production'],
    ]);
  });
}

test('Python CLI help describes source convention or exact helper selection with unselected helpers ordinary', () => {
  const help = spawnSync(process.execPath, [entry, '--help'], {encoding:'utf8',timeout:30000});
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /source-named test_\* or explicitly selected exact helper oracles/);
  assert.match(help.stdout, /Unselected helpers stay ordinary/);
  const [selected] = pythonDescriptors('def prepare(value):\n    assert value or value == 0\n', 'subject.py', pluginRoot, nativePolicy, [{file:'subject.py',name:'prepare',reason:'helper assertion oracle'}]);
  assert.equal(selected.oracleClassification, 'oracle');
  assert.equal(selected.complexity, 2);
  const [unselected] = pythonDescriptors('def prepare(value):\n    assert value or value == 0\n', 'subject.py', pluginRoot, nativePolicy, []);
  assert.equal(unselected.oracleClassification, 'production');
  assert.equal(unselected.assertionStatements, 1);
});
