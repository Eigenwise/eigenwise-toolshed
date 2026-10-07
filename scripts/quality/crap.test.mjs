import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import crapCore from './crap-core.cjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { baselineFunctions, builtOutput, captureCoverage, changedMetricsAgainstBase, changedPathContext, collectFunctions, compareAgainstBase, diffEntries, emptyChangedFunctionWarning, functionCoverage, isScoredSource, noAnalyzerMetric, parserTransport, readCoverage, remapRecords, reportMetrics, run, selectSuites, sourceMetrics } from './crap.mjs';

const { crapScore } = crapCore;

function metric({ complexity, coverage, name = 'subject', fingerprint = 'changed', relativePath = 'plugins/example/lib/subject.js' }) {
  return {
    identity: `<root>/FunctionDeclaration:${name}#0`,
    parent: '<root>',
    name,
    fingerprint,
    relativePath,
    line: 1,
    complexity,
    coverage,
    crap: crapScore(complexity, coverage),
  };
}

function baselineOf(entries) {
  return async () => entries.map(([identity, fingerprint]) => ({ identity, parent: '<root>', fingerprint }));
}

test('collects stable identities and source fingerprints', async () => {
  const functions = await collectFunctions('function outer() { return () => 1; }', 'fixture.ts');
  assert.deepEqual(functions.map((entry) => entry.name), ['outer', '<anonymous>']);
  assert.ok(functions.every((entry) => entry.fingerprint.length === 64));
});

const workerBefore = 'function runWorker(items) {\n  const forward = (item) => item.id;\n  return items.map(forward);\n}\n';

async function changedFunctionNames(before, after) {
  const metrics = (await collectFunctions(after, 'worker.js')).map((descriptor) => ({ ...descriptor, relativePath: 'worker.js' }));
  return (await changedMetricsAgainstBase(metrics, ['worker.js'], 'base-sha', () => collectFunctions(before, 'worker.js'))).map((metric) => metric.name);
}

test('an enclosing function is fingerprinted over its own text, so editing a nested arrow touches only the arrow', async () => {
  assert.deepEqual(await changedFunctionNames(workerBefore, workerBefore.replace('item.id', 'item.id ?? item.ref')), ['forward']);
  assert.deepEqual(await changedFunctionNames(workerBefore, workerBefore.replace('items.map(forward)', 'items.flatMap(forward)')), ['runWorker']);
});

async function changedLines(before, after) {
  const metrics = (await collectFunctions(after, 'suite.js')).map((descriptor) => ({ ...descriptor, relativePath: 'suite.js' }));
  return (await changedMetricsAgainstBase(metrics, ['suite.js'], 'base-sha', () => collectFunctions(before, 'suite.js'))).map((metric) => metric.line);
}

const testCase = (title, assertion = 'equal') => `test('${title}', () => {\n  assert.${assertion}(run('${title}', (value) => value + 1), 1);\n});\n`;
const suiteBefore = ['first', 'second', 'third', 'fourth'].map((title) => testCase(title)).join('');
const suiteWithInsertion = suiteBefore.replace(testCase('third'), testCase('inserted') + testCase('third'));

test('inserting or deleting a test callback leaves every later unchanged callback out of the changed set', async () => {
  assert.deepEqual(await changedLines(suiteBefore, suiteWithInsertion), [7, 8]);
  assert.deepEqual(await changedLines(suiteBefore, suiteBefore.replace(testCase('second'), '')), []);
});

test('a later callback whose own text changed is still scored beside an insertion, and its unchanged nested arrow is not', async () => {
  assert.deepEqual(await changedLines(suiteBefore, suiteWithInsertion.replace(testCase('fourth'), testCase('fourth', 'notEqual'))), [7, 8, 13]);
});

test('strictly fails a new function with a CRAP score of six', async () => {
  const failures = await compareAgainstBase(
    [metric({ complexity: 6, coverage: 1, name: 'run' })],
    ['plugins/example/lib/subject.js'],
    'base-sha',
    baselineOf([]),
  );
  assert.deepEqual(failures, ['plugins/example/lib/subject.js:1 run cc=6 coverage=100.00% CRAP=6.0000']);
});

test('leaves an unchanged over-ceiling function out of the failure list', async () => {
  const unchanged = metric({ complexity: 9, coverage: 0, fingerprint: 'same' });
  const failures = await compareAgainstBase(
    [unchanged],
    ['plugins/example/lib/subject.js'],
    'base-sha',
    baselineOf([[unchanged.identity, 'same']]),
  );
  assert.deepEqual(failures, []);
});

test('keeps changed unverified functions in the result set', async () => {
  const unverified = { ...metric({ complexity: 1, coverage: 1 }), unverified: 'the functions beside it in plugins/example/lib/subject.js do not line up with the source, so its coverage cannot be paired' };
  const changedMetrics = await changedMetricsAgainstBase(
    [unverified],
    ['plugins/example/lib/subject.js'],
    'base-sha',
    baselineOf([]),
  );
  assert.deepEqual(changedMetrics, [unverified]);
  assert.deepEqual(await compareAgainstBase([unverified], ['plugins/example/lib/subject.js'], 'base-sha', baselineOf([])), []);
});

test('treats a file that is new since the base as entirely changed', async () => {
  const fresh = metric({ complexity: 1, coverage: 1 });
  const newFileAtBase = async (base, relativePath) => {
    throw new Error(`fatal: path '${relativePath}' exists on disk, but not in '${base}'`);
  };
  const changedMetrics = await changedMetricsAgainstBase([fresh], ['plugins/example/lib/subject.js'], 'base-sha', newFileAtBase);
  assert.deepEqual(changedMetrics, [fresh]);
  const otherFailure = async () => { throw new Error('fatal: not a git repository'); };
  await assert.rejects(changedMetricsAgainstBase([fresh], ['plugins/example/lib/subject.js'], 'base-sha', otherFailure), /not a git repository/);
});

test('accepts a changed function whose score falls below six', async () => {
  const lowered = metric({ complexity: 3, coverage: 1, fingerprint: 'lowered' });
  const failures = await compareAgainstBase(
    [lowered],
    ['plugins/example/lib/subject.js'],
    'base-sha',
    baselineOf([[lowered.identity, 'higher']]),
  );
  assert.deepEqual(failures, []);
});

test('fails a changed over-ceiling function without a delta ratchet', async () => {
  const changed = metric({ complexity: 7, coverage: 0.5, fingerprint: 'changed' });
  const failures = await compareAgainstBase(
    [changed],
    ['plugins/example/lib/subject.js'],
    'base-sha',
    baselineOf([[changed.identity, 'prior']]),
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0], /subject cc=7 coverage=50\.00%/);
});

test('scores JavaScript and TypeScript wherever it lives, skipping generated Sidequest build output and other languages', () => {
  const sidequestRoot = path.join(process.cwd(), 'plugins', 'sidequest');
  assert.equal(isScoredSource(path.join(sidequestRoot, 'src', 'lib', 'mcp-collaboration.ts')), true);
  assert.equal(isScoredSource(path.join(sidequestRoot, 'scripts', 'owned-process-tree.js')), true);
  assert.equal(isScoredSource(path.join(sidequestRoot, 'test', 'store.test.ts')), true);
  assert.equal(isScoredSource(path.join(process.cwd(), 'scripts', 'quality', 'crap.mjs')), true);
  assert.equal(isScoredSource(path.join(sidequestRoot, 'lib', 'mcp-collaboration.js')), false);
  assert.equal(isScoredSource(path.join(sidequestRoot, 'hooks', 'session-start.js')), false);
  assert.equal(isScoredSource(path.join(sidequestRoot, 'bin', 'sidequest.js')), false);
  assert.equal(isScoredSource(path.join(process.cwd(), 'scripts', 'windows-job-owner.cs')), false);
  assert.equal(isScoredSource(path.join(process.cwd(), 'scripts', 'quality', 'README.md')), false);
});

test('a changed range sorts into scored sources, one no-analyzer row per other-language source, and skipped files', () => {
  const entries = ['plugins/sidequest/src/lib/store.ts', 'plugins/sidequest/lib/store.js', 'plugins/sidequest/scripts/owned-process-tree.js', 'plugins/sidequest/test/store.test.ts', 'scripts/quality/crap.mjs', 'scripts/windows-job-owner.cs', 'docs/src/content/docs/index.md'].map((changedPath) => ({ path: changedPath, baselinePath: changedPath }));
  const context = changedPathContext('base-sha', entries);
  assert.deepEqual(context.changedPaths, ['plugins/sidequest/src/lib/store.ts', 'plugins/sidequest/scripts/owned-process-tree.js', 'plugins/sidequest/test/store.test.ts', 'scripts/quality/crap.mjs']);
  assert.equal(context.allChangedPaths.length, 7);
  assert.deepEqual(context.unanalyzed, [{ relativePath: 'scripts/windows-job-owner.cs', line: 1, name: 'windows-job-owner.cs', unverified: 'this gate has no analyzer for .cs sources' }]);
  assert.equal(noAnalyzerMetric('docs/src/content/docs/index.md'), null);
});

const knownComplexities = [
  ['function ifElseIfChain(value) { if (value === 1) return 1; else if (value === 2) return 2; else return 3; }', { ifElseIfChain: 3 }],
  ['function switchWithDefault(value) { switch (value) { case 1: return 1; case 2: return 2; default: return 3; } }', { switchWithDefault: 3 }],
  ['function tryCatch() { try { return 1; } catch (error) { return 2; } finally { return 3; } }', { tryCatch: 2 }],
  ['function shortCircuit(a, b, c, d) { return (a && b) || (c ?? d); }', { shortCircuit: 4 }],
  ['function ternary(value) { return value ? 1 : 0; }', { ternary: 2 }],
  ['function everyLoop(items) { for (const item of items) {} for (const key in items) {} for (let index = 0; index < 1; index += 1) {} while (false) {} do {} while (false); }', { everyLoop: 6 }],
  ['function outer(items) { return items.filter((item) => item ? item.ok && item.ready : false); }', { outer: 1, '<anonymous>': 3 }],
];

test('counts cyclomatic complexity from the AST: 1 plus each if, loop, case, catch, conditional and short-circuit operator, nested functions excluded', async () => {
  for (const [source, expected] of knownComplexities) {
    const functions = await collectFunctions(source, 'fixture.ts');
    assert.deepEqual(Object.fromEntries(functions.map((entry) => [entry.name, entry.complexity])), expected, source);
  }
});

// lizard 1.24.0 --csv on this fixture: one row, first 1-2, and no row for second.
test('measures both siblings where Lizard loses brace tracking: a template literal nested inside another template literal\'s ${} substitution', async () => {
  const source = 'function first(a) { return `x${`y${a}`}z`; }\nfunction second(a) { return a ? 1 : 0; }\n';
  const functions = await collectFunctions(source, 'fixture.ts');
  assert.deepEqual(functions.map((entry) => [entry.name, entry.line, entry.complexity]), [['first', 1, 1], ['second', 2, 2]]);
});

test('scores a source function from its AST complexity and mapped coverage', async () => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'crap-source-metrics-'));
  const sourcePath = path.join(temporaryDirectory, 'fixture.js');
  const sourceText = 'function subject(value) { return value ? 1 : 0; }';
  await fs.writeFile(sourcePath, sourceText);
  try {
    const coverageScripts = new Map([[path.resolve(sourcePath).replaceAll('\\', '/').toLowerCase(), [{ functionName: 'subject', ranges: [{ startOffset: 0, endOffset: sourceText.length, count: 1 }] }]]]);
    const [metricResult] = await sourceMetrics(sourcePath, coverageScripts);
    assert.equal(metricResult.name, 'subject');
    assert.equal(metricResult.unverified, undefined);
    assert.deepEqual([metricResult.complexity, metricResult.coverage, metricResult.crap], [2, 1, 2]);
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});

function caveatInput(overrides) {
  return {
    changedMetrics: [],
    workingTreeIsClean: true,
    baseWasExplicit: true,
    base: 'base-sha',
    allChangedPaths: ['plugins/example/lib/subject.js'],
    changedPaths: ['plugins/example/lib/subject.js'],
    ...overrides,
  };
}

test('stays silent once a changed function was scored', () => {
  assert.equal(emptyChangedFunctionWarning(caveatInput({ changedMetrics: [metric({ complexity: 1, coverage: 1 })] })), null);
});

test('warns on the HEAD-default trap: no --base, empty diff, clean tree', () => {
  const warning = emptyChangedFunctionWarning(caveatInput({ baseWasExplicit: false, allChangedPaths: [], changedPaths: [] }));
  assert.match(warning, /no --base was given/);
  assert.match(warning, /vacuous/);
});

test('warns when an explicit --base produces an empty diff', () => {
  const warning = emptyChangedFunctionWarning(caveatInput({ baseWasExplicit: true, allChangedPaths: [], changedPaths: [] }));
  assert.equal(warning, 'Warning: --base base-sha produced an empty diff; this CRAP result is vacuous.');
});

test('reports out-of-scope changed paths instead of calling a non-empty diff vacuous', () => {
  const warning = emptyChangedFunctionWarning(caveatInput({
    allChangedPaths: ['scripts/quality/crap.mjs', 'scripts/quality/crap.test.mjs'],
    changedPaths: [],
  }));
  assert.doesNotMatch(warning, /this CRAP result is vacuous/);
  assert.match(warning, /out of scope/);
  assert.match(warning, /scripts\/quality\/crap\.mjs/);
  assert.match(warning, /scripts\/quality\/crap\.test\.mjs/);
});

test('warns when a clean tree has changed scored files but no changed functions', () => {
  assert.equal(
    emptyChangedFunctionWarning(caveatInput()),
    'Warning: no changed functions were found in a clean working tree; this CRAP result is vacuous.',
  );
  assert.equal(emptyChangedFunctionWarning(caveatInput({ workingTreeIsClean: false })), null);
});

function runGitFixture(fixtureRoot, argumentsList) {
  const result = spawnSync('git', argumentsList, { cwd: fixtureRoot, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `git ${argumentsList.join(' ')} failed in fixture`);
  return result.stdout.trim();
}

function commitFixture(fixtureRoot, message) {
  runGitFixture(fixtureRoot, ['add', '-A']);
  runGitFixture(fixtureRoot, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message]);
  return runGitFixture(fixtureRoot, ['rev-parse', 'HEAD']);
}

const TWO_FUNCTION_SOURCE = 'function first() {\n  return 1;\n}\n\nfunction second() {\n  return 2;\n}\n';

async function createRenamedFixture(secondFunctionSource = 'function second() {\n  return 2;\n}\n') {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'crap-rename-fixture-'));
  await fs.writeFile(path.join(fixtureRoot, 'module.js'), TWO_FUNCTION_SOURCE);
  runGitFixture(fixtureRoot, ['init', '-q']);
  const baseCommit = commitFixture(fixtureRoot, 'initial');
  runGitFixture(fixtureRoot, ['mv', 'module.js', 'renamed.js']);
  const renamedSource = `function first() {\n  return 1;\n}\n\n${secondFunctionSource}`;
  await fs.writeFile(path.join(fixtureRoot, 'renamed.js'), renamedSource);
  runGitFixture(fixtureRoot, ['add', '-A']);
  const renameCommit = commitFixture(fixtureRoot, 'rename');
  return { fixtureRoot, baseCommit, renameCommit, renamedSource };
}

async function metricsForFixture(renamedSource) {
  const descriptors = await collectFunctions(renamedSource, 'renamed.js');
  return descriptors.map((descriptor) => ({
    ...descriptor,
    relativePath: 'renamed.js',
    complexity: 7,
    coverage: 0,
    crap: crapScore(7, 0),
  }));
}

test('a pure rename produces no findings for untouched legacy functions', async () => {
  const { fixtureRoot, baseCommit, renamedSource } = await createRenamedFixture();
  try {
    const entries = diffEntries(baseCommit, null, fixtureRoot);
    assert.deepEqual(entries, [{ path: 'renamed.js', baselinePath: 'module.js' }]);
    const metrics = await metricsForFixture(renamedSource);
    const readBaseline = (base, relativePath) => baselineFunctions(base, relativePath, fixtureRoot);
    const failures = await compareAgainstBase(metrics, entries, baseCommit, readBaseline);
    assert.deepEqual(failures, []);
  } finally {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('a rename plus one edited function reports only that function', async () => {
  const { fixtureRoot, baseCommit, renamedSource } = await createRenamedFixture('function second() {\n  if (Math.random() > 2) return 3;\n  return 2;\n}\n');
  try {
    const entries = diffEntries(baseCommit, null, fixtureRoot);
    assert.deepEqual(entries, [{ path: 'renamed.js', baselinePath: 'module.js' }]);
    const metrics = await metricsForFixture(renamedSource);
    const readBaseline = (base, relativePath) => baselineFunctions(base, relativePath, fixtureRoot);
    const failures = await compareAgainstBase(metrics, entries, baseCommit, readBaseline);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /renamed\.js:\d+ second/);
  } finally {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
});

function v8Record(functionName, text, functionText, count) {
  const startOffset = text.indexOf(functionText);
  return { functionName, ranges: [{ startOffset, endOffset: startOffset + functionText.length, count }] };
}

test('scores an inline callback covered in one process and idle in another as covered', async () => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'crap-two-process-'));
  const sourcePath = path.join(temporaryDirectory, 'fixture.js');
  const callback = '(value) => value > 1 ? value : 0';
  const outer = `function outer(values) {\n  return values.map(${callback});\n}`;
  const sourceText = `${outer}\n`;
  await fs.writeFile(sourcePath, sourceText);
  try {
    const idleProcess = [v8Record('outer', sourceText, outer, 1), v8Record('', sourceText, callback, 0)];
    const busyProcess = [v8Record('outer', sourceText, outer, 1), v8Record('', sourceText, callback, 3)];
    const coverageScripts = new Map([[path.resolve(sourcePath).replaceAll('\\', '/').toLowerCase(), [...idleProcess, ...busyProcess]]]);
    const metrics = await sourceMetrics(sourcePath, coverageScripts);
    const closure = metrics.find((entry) => entry.name === '<anonymous>');
    assert.equal(closure.coverage, 1);
    assert.equal(closure.crap, 2);
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});

const typedSource = 'export function outer(values: number[]): number[] {\n  return values.map((value: number) => value + 1);\n}\n';
const builtCallback = '(value) => value + 1';
const builtText = `export function outer(values) {\n  return values.map(${builtCallback});\n}\n`;

async function coverageOutput(relativePath, text, records = []) {
  return { relativePath, descriptors: await collectFunctions(text, relativePath), records };
}

test('pairs a TypeScript inline callback with its twin in the built output', async () => {
  const source = await coverageOutput('src/lib/subject.ts', typedSource);
  const unrelatedBundle = await coverageOutput('hooks/other.js', 'function elsewhere() { return [1].map((item) => item); }\n');
  const built = await coverageOutput('lib/subject.js', builtText, [v8Record('', builtText, builtCallback, 2)]);
  const closure = source.descriptors.find((descriptor) => descriptor.name === '<anonymous>');
  assert.deepEqual(functionCoverage(closure, [source, unrelatedBundle, built]), { coverage: 1 });
});

test('leaves a TypeScript inline callback unverified when the built output does not line up', async () => {
  const source = await coverageOutput('src/lib/subject.ts', typedSource);
  const reshapedText = `export function outer(values) {\n  const extra = () => 0;\n  return values.map(${builtCallback});\n}\n`;
  const built = await coverageOutput('lib/subject.js', reshapedText, [v8Record('', reshapedText, builtCallback, 2)]);
  const closure = source.descriptors.find((descriptor) => descriptor.name === '<anonymous>');
  assert.match(functionCoverage(closure, [source, built]).unverified, /lib\/subject\.js do not line up with the source/);
});

test('reads a built output with its functions, and skips one that was never built', async () => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'crap-built-output-'));
  const outputPath = path.join(temporaryDirectory, 'subject.js');
  await fs.writeFile(outputPath, builtText);
  try {
    const records = [v8Record('', builtText, builtCallback, 2)];
    const coverageScripts = new Map([[path.resolve(outputPath).replaceAll('\\', '/').toLowerCase(), records]]);
    const output = await builtOutput(outputPath, coverageScripts, true);
    assert.deepEqual(output.descriptors.map((descriptor) => descriptor.name), ['outer', '<anonymous>']);
    assert.equal(output.records, records);
    assert.deepEqual((await builtOutput(outputPath, new Map(), false)).descriptors, []);
    assert.equal(await builtOutput(path.join(temporaryDirectory, 'missing.js'), coverageScripts, true), null);
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});

async function suitesRunFor(changedPaths, status = 0) {
  const suites = [];
  const captured = await captureCoverage(changedPaths, null, (suite) => {
    suites.push(suite);
    return { status };
  }).catch((error) => ({ error }));
  if (captured.coverageDirectory) await fs.rm(captured.coverageDirectory, { recursive: true, force: true });
  return { suites, ...captured };
}

test('a sidequest-only diff runs only the sidequest suite', async () => {
  const { suites, suiteSummary } = await suitesRunFor(['plugins/sidequest/src/lib/store.ts']);
  assert.deepEqual(suites.map((suite) => suite.name), ['sidequest']);
  assert.deepEqual(suites[0].args, ['run', 'test:full']);
  assert.equal(suiteSummary, 'sidequest');
});

test('a changed plugin script or test file runs that plugin suite', async () => {
  const { suites } = await suitesRunFor(['plugins/sidequest/scripts/owned-process-tree.js', 'plugins/sidequest/test/store.test.ts']);
  assert.deepEqual(suites.map((suite) => suite.name), ['sidequest']);
});

test('a gateway plus observability diff runs both suites and nothing else', async () => {
  const { suites, suiteSummary } = await suitesRunFor(['plugins/model-gateway/lib/commands.js', 'plugins/observability/lib/store.js', 'plugins/model-gateway/lib/settings-wiring.js']);
  assert.deepEqual(suites.map((suite) => suite.name), ['model-gateway', 'observability']);
  assert.deepEqual(suites[0].args, ['run', 'test']);
  assert.deepEqual(suites[1].args.slice(0, 1), ['--test']);
  assert.equal(suiteSummary, 'model-gateway, observability');
});

test('a quartermaster hooks diff runs the quartermaster node --test suite', async () => {
  const { suites } = await suitesRunFor(['plugins/quartermaster/hooks/session-start-nudge.js']);
  assert.deepEqual(suites.map((suite) => suite.name), ['quartermaster']);
  assert.equal(suites[0].args[0], '--test');
});

test('repository scripts run their documented node --test suites from the repository root', async () => {
  const { suites, suiteSummary } = await suitesRunFor(['scripts/quality/crap.mjs', 'scripts/release/cut.mjs', 'docs/scripts/generate-reference.mjs', 'plugins/quartermaster/lib/catalog.js']);
  assert.deepEqual(suites.map((suite) => suite.name), ['quartermaster', 'scripts/quality', 'scripts/release', 'docs']);
  assert.deepEqual(suites.slice(1).map((suite) => suite.args), [
    ['--test', 'scripts/quality/*.test.mjs'],
    ['--test', 'scripts/release/test/*.test.mjs'],
    ['--test', 'docs/scripts/content.test.mjs'],
  ]);
  assert.ok(suites.slice(1).every((suite) => suite.cwd === process.cwd() && suite.command === process.execPath));
  assert.equal(suiteSummary, 'quartermaster, scripts/quality, scripts/release, docs');
});

test('a diff with no suite behind it runs none and says so', async () => {
  const { suites, suiteSummary } = await suitesRunFor(['docs/src/content/docs/contributing.md', 'plugins', 'scripts/windows-job-owner.cs']);
  assert.deepEqual(suites, []);
  assert.equal(suiteSummary, 'none, no suite covers the changed paths');
  assert.deepEqual(await selectSuites(['plugins/not-a-plugin/lib/a.js']), []);
});

test('a file no suite loaded is unverified with the child-process capture hint instead of scoring zero coverage', async () => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'crap-unloaded-'));
  const sourcePath = path.join(temporaryDirectory, 'spawned-only.js');
  await fs.writeFile(sourcePath, 'function spawnedOnly(value) { return value ? 1 : 0; }\n');
  try {
    const [metricResult] = await sourceMetrics(sourcePath, new Map());
    assert.match(metricResult.unverified, /^no suite loaded this file, so it has no coverage record/);
    assert.match(metricResult.unverified, /NODE_V8_COVERAGE/);
    assert.equal(metricResult.crap, undefined);
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('remaps V8 ranges through a source map and drops a record whose function range does not map', () => {
  const toOriginal = (offset) => (offset >= 100 ? null : offset - 10);
  const records = [
    { functionName: 'kept', ranges: [{ startOffset: 10, endOffset: 50, count: 1 }, { startOffset: 20, endOffset: 120, count: 0 }] },
    { functionName: 'lost', ranges: [{ startOffset: 100, endOffset: 150, count: 1 }] },
  ];
  assert.deepEqual(remapRecords(records, toOriginal), [{ functionName: 'kept', ranges: [{ startOffset: 0, endOffset: 40, count: 1 }] }]);
});

const typedTestFile = [
  "import assert from 'node:assert/strict';",
  "import test from 'node:test';",
  '',
  'export function add(left: number, right: number): number {',
  '  return left > 0 ? left + right : right;',
  '}',
  '',
  "test('adds', (): void => {",
  '  assert.equal(add(1, 2), 3);',
  '  assert.equal(add(0, 2), 2);',
  '});',
  '',
].join('\n');

test('a tsx-loaded TypeScript test file gets its callback and helper scored from source-mapped coverage', async () => {
  const fixtureRoot = await fs.mkdtemp(path.join(process.cwd(), 'plugins', 'sidequest', 'test', 'crap-tsx-fixture-'));
  const coverageDirectory = path.join(fixtureRoot, 'coverage');
  const sourcePath = path.join(fixtureRoot, 'typed.test.ts');
  await fs.writeFile(sourcePath, typedTestFile);
  try {
    const { NODE_TEST_CONTEXT, ...environment } = process.env;
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', 'typed.test.ts'], { cwd: fixtureRoot, encoding: 'utf8', env: { ...environment, NODE_V8_COVERAGE: coverageDirectory } });
    assert.equal(result.status, 0, result.stderr);
    const metrics = await sourceMetrics(sourcePath, await readCoverage(coverageDirectory));
    const rows = Object.fromEntries(metrics.map((entry) => [entry.name, [entry.line, entry.complexity, entry.coverage, entry.unverified]]));
    assert.deepEqual(rows, { add: [4, 2, 1, undefined], '<anonymous>': [8, 1, 1, undefined] });
  } finally {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
});

// Each nested body below must run for the test to pass. V8 names the assigned hook "" and the
// constructor after its class, esbuild drops a lone parameter's parentheses, and tsx's __name
// wrapper leaves the property arrow no segment of its own, so their ranges start past the AST's.
const nestedCallbackTestFile = [
  "import assert from 'node:assert/strict';",
  "import test from 'node:test';",
  '',
  'let hook: ((value: number) => void) | null = null;',
  'class Recorder {',
  '  seen: number[];',
  '  constructor(...values: number[]) {',
  '    this.seen = values;',
  '  }',
  '}',
  '',
  "test('nested callbacks run', (): void => {",
  '  hook = (value) => {',
  "    if (value > 1) throw new Error('boom');",
  '  };',
  '  const recorder = new Recorder(1, 2);',
  '  assert.throws(() => hook?.(2), (error: Error) => /boom/.test(error.message));',
  '  assert.ok(recorder.seen.some((value: number) => value > 1));',
  '  const store = { size: () => recorder.seen.length };',
  '  assert.equal(store.size(), 2);',
  '});',
  '',
].join('\n');

test('a tsx-loaded test file scores the nested callbacks that had to run with their executed coverage', async () => {
  const fixtureRoot = await fs.mkdtemp(path.join(process.cwd(), 'plugins', 'sidequest', 'test', 'crap-tsx-nested-'));
  const coverageDirectory = path.join(fixtureRoot, 'coverage');
  const sourcePath = path.join(fixtureRoot, 'nested.test.ts');
  await fs.writeFile(sourcePath, nestedCallbackTestFile);
  try {
    const { NODE_TEST_CONTEXT, ...environment } = process.env;
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', 'nested.test.ts'], { cwd: fixtureRoot, encoding: 'utf8', env: { ...environment, NODE_V8_COVERAGE: coverageDirectory } });
    assert.equal(result.status, 0, result.stderr);
    const metrics = await sourceMetrics(sourcePath, await readCoverage(coverageDirectory));
    const rows = metrics.map((entry) => `${entry.line} ${entry.name} ${entry.coverage}`);
    assert.deepEqual(rows, [
      '7 constructor 1',
      '12 <anonymous> 1',
      '13 hook 1',
      '17 <anonymous> 1',
      '17 <anonymous> 1',
      '18 <anonymous> 1',
      '19 size 1',
    ]);
  } finally {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('a supplied coverage directory runs no suite', async () => {
  const captured = await captureCoverage(['plugins/sidequest/src/a.ts'], '/tmp/supplied', () => assert.fail('no suite should run'));
  assert.deepEqual(captured, { coverageDirectory: '/tmp/supplied', suiteSummary: 'none, --coverage supplied' });
});

test('a failing suite stops the capture and names its plugin', async () => {
  const { suites, error } = await suitesRunFor(['plugins/model-gateway/lib/a.js', 'plugins/observability/lib/a.js'], 1);
  assert.equal(suites.length, 1);
  assert.match(error.message, /model-gateway tests failed with exit 1/);
});

test('a failing suite removes the coverage directory the earlier suites wrote into and rethrows the same error', async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'crap-leak-test-'));
  const previousTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = temporaryRoot;
  const failOnLastSuite = (suite, coverageDirectory) => {
    if (suite.name === 'observability') return { status: 3 };
    fsSync.writeFileSync(path.join(coverageDirectory, 'coverage-1.json'), '{}');
    return { status: 0 };
  };
  try {
    await assert.rejects(captureCoverage(['plugins/model-gateway/lib/a.js', 'plugins/observability/lib/a.js'], null, failOnLastSuite), { message: 'observability tests failed with exit 3' });
    assert.deepEqual((await fs.readdir(temporaryRoot)).filter((entry) => entry.startsWith('toolshed-crap-')), []);
  } finally {
    if (previousTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpdir;
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

async function withCapturedProcessOutput(action) {
  const originalExitCode = process.exitCode;
  const originalStandardOutputWrite = process.stdout.write;
  const originalStandardErrorWrite = process.stderr.write;
  process.exitCode = undefined;
  process.stdout.write = () => true;
  process.stderr.write = () => true;
  try {
    return await action();
  } finally {
    process.exitCode = originalExitCode;
    process.stdout.write = originalStandardOutputWrite;
    process.stderr.write = originalStandardErrorWrite;
  }
}

test('runs production CLI phases and its failing report outcome', async () => {
  const coverageDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'crap-production-cli-'));
  try {
    const result = await withCapturedProcessOutput(() => run({ base: 'HEAD', coverageDirectory, all: false }));
    // Uncommitted edits to this gate's own files are changed paths now, scored against the empty capture above.
    assert.ok(result.changedMetrics.every((entry) => entry.relativePath.startsWith('scripts/quality/') && entry.unverified.startsWith('no suite loaded this file')), JSON.stringify(result.changedMetrics));

    const failingMetric = metric({ complexity: 6, coverage: 1, relativePath: 'scripts/quality/crap.mjs' });
    const anotherFailingMetric = { ...failingMetric, identity: '<root>/FunctionDeclaration:anotherSubject#0', line: 2, name: 'anotherSubject' };
    await withCapturedProcessOutput(async () => {
      const reported = await reportMetrics({
        allChangedPaths: ['scripts/quality/crap.mjs'],
        base: 'HEAD',
        baseWasExplicit: true,
        changedEntries: [{ path: 'scripts/quality/crap.mjs' }],
        changedPaths: ['scripts/quality/crap.mjs'],
        metrics: [anotherFailingMetric, failingMetric],
        options: { all: true },
        suiteSummary: 'none',
      });
      assert.equal(reported.failures.length, 2);
      assert.equal(process.exitCode, 1);
    });
  } finally {
    await fs.rm(coverageDirectory, { recursive: true, force: true });
  }
});

const qualityDirectory = path.dirname(fileURLToPath(import.meta.url));
const passSubject = 'export function subject(value) {\n  return value + 1;\n}\n';
const failingSubject = 'export function subject(value) {\n  if (value === 1) return 1;\n  if (value === 2) return 2;\n  if (value === 3) return 3;\n  if (value === 4) return 4;\n  if (value === 5) return 5;\n  return 0;\n}\n';

async function createCliFixture() {
  const fixtureRoot = await fs.mkdtemp(path.join(process.cwd(), 'plugins', 'sidequest', 'test', 'crap-cli-fixture-'));
  const qualityFixtureDirectory = path.join(fixtureRoot, 'scripts', 'quality');
  const pluginRoot = path.join(fixtureRoot, 'plugins', 'sidequest');
  await Promise.all(['src', 'scripts', 'test'].map((directory) => fs.mkdir(path.join(pluginRoot, directory), { recursive: true })));
  await fs.mkdir(path.join(fixtureRoot, 'plugins', 'quartermaster', 'lib'), { recursive: true });
  await fs.mkdir(qualityFixtureDirectory, { recursive: true });
  await Promise.all([
    fs.copyFile(path.join(qualityDirectory, 'crap.mjs'), path.join(qualityFixtureDirectory, 'crap.mjs')),
    fs.copyFile(path.join(qualityDirectory, 'crap-core.cjs'), path.join(qualityFixtureDirectory, 'crap-core.cjs')),
    fs.copyFile(path.join(process.cwd(), 'plugins', 'quartermaster', 'lib', 'crap-core.cjs'), path.join(fixtureRoot, 'plugins', 'quartermaster', 'lib', 'crap-core.cjs')),
    fs.writeFile(path.join(pluginRoot, 'package.json'), JSON.stringify({ type: 'module', scripts: { 'test:full': 'node --test test/subject.test.mjs' } })),
    fs.writeFile(path.join(pluginRoot, 'src', 'subject.js'), 'export function subject(value) {\n  return value;\n}\n'),
    fs.writeFile(path.join(pluginRoot, 'src', 'retired.js'), 'export function retired() {\n  return 0;\n}\n'),
    fs.writeFile(path.join(pluginRoot, 'scripts', 'helper.js'), 'export function helper(value) {\n  return value;\n}\n'),
    fs.writeFile(path.join(pluginRoot, 'test', 'subject.test.mjs'), fixtureTestFile('subject(0);')),
    fs.writeFile(path.join(fixtureRoot, 'scripts', 'windows-job-owner.cs'), 'class JobOwner { }\n'),
  ]);
  runGitFixture(fixtureRoot, ['init', '-q']);
  return { fixtureRoot, base: commitFixture(fixtureRoot, 'initial') };
}

function fixtureTestFile(body) {
  return `import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { helper } from '../scripts/helper.js';\nimport { subject } from '../src/subject.js';\n\ntest('subject', () => {\n  ${body}\n  assert.equal(helper(1), 1);\n  assert.equal(helper(-1), helper(-1));\n});\n`;
}

function runCliFixture(fixtureRoot, base) {
  return spawnSync(process.execPath, ['scripts/quality/crap.mjs', '--base', base], { cwd: fixtureRoot, encoding: 'utf8' });
}

test('the CLI scores a changed plugin script, test callback and src function with coverage, and reports a changed C# file once as having no analyzer', async () => {
  const { fixtureRoot, base } = await createCliFixture();
  const pluginRoot = path.join(fixtureRoot, 'plugins', 'sidequest');
  try {
    await Promise.all([
      fs.writeFile(path.join(pluginRoot, 'src', 'subject.js'), passSubject),
      fs.writeFile(path.join(pluginRoot, 'scripts', 'helper.js'), 'export function helper(value) {\n  return value > 0 ? value : 0;\n}\n'),
      fs.writeFile(path.join(pluginRoot, 'test', 'subject.test.mjs'), fixtureTestFile("assert.equal(typeof subject(0), 'number');")),
      fs.writeFile(path.join(fixtureRoot, 'scripts', 'windows-job-owner.cs'), 'class JobOwner { int Pid; }\n'),
      fs.rm(path.join(pluginRoot, 'src', 'retired.js')),
    ]);
    const result = runCliFixture(fixtureRoot, base);
    const rows = result.stdout.split('\n').filter((line) => /^(PASS|FAIL|UNVERIFIED) /.test(line));
    assert.deepEqual(rows.map((row) => row.split(' ').slice(0, 3).join(' ')), [
      'PASS plugins/sidequest/scripts/helper.js:1 helper',
      'PASS plugins/sidequest/src/subject.js:1 subject',
      'PASS plugins/sidequest/test/subject.test.mjs:6 <anonymous>',
      'UNVERIFIED scripts/windows-job-owner.cs:1 windows-job-owner.cs',
    ], result.stdout + result.stderr);
    assert.match(rows[0], /cc=2 coverage=100\.00% CRAP=2\.0000/);
    assert.match(rows[2], /cc=1 coverage=100\.00% CRAP=1\.0000/);
    assert.match(rows[3], /this gate has no analyzer for \.cs sources; measurement is unverified\./);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /coverage suites: sidequest/);
    assert.doesNotMatch(result.stdout + result.stderr, /retired/);
  } finally {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('the CLI captures a fixture suite and reports passing and failing changed functions', async () => {
  const { fixtureRoot, base } = await createCliFixture();
  try {
    await fs.writeFile(path.join(fixtureRoot, 'plugins', 'sidequest', 'src', 'subject.js'), passSubject);
    const passing = runCliFixture(fixtureRoot, base);
    assert.equal(passing.status, 0);
    assert.match(passing.stdout, /PASS plugins\/sidequest\/src\/subject\.js:1 subject/);
    assert.match(passing.stdout, /coverage suites: sidequest/);

    await fs.writeFile(path.join(fixtureRoot, 'plugins', 'sidequest', 'src', 'subject.js'), failingSubject);
    const failing = runCliFixture(fixtureRoot, base);
    assert.equal(failing.status, 1);
    assert.match(failing.stdout, /FAIL plugins\/sidequest\/src\/subject\.js:1 subject/);
    assert.match(failing.stderr, /CRAP gate failed against/);
  } finally {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
});

const transportFixture = [
  'function outer(values) {',
  '  const double = (value) => value * 2;',
  '  function inner() { return values.map(double); }',
  '  return inner();',
  '}',
  'const config = { build() { return 1; }, get size() { return 2; } };',
  'class Shape {',
  '  constructor(width) { this.width = width; }',
  '  get area() { return this.width ** 2; }',
  '  area() { return 0; }',
  '  static of(width) { return new Shape(width); }',
  '}',
  'module.exports = function assigned() { return () => outer([1]); };',
  '',
].join('\n');

function collectUnderReadOnlyPermission(transport) {
  const script = "const { collectFunctions } = await import(process.env.CRAP_OWNER_URL); process.stdout.write(JSON.stringify(await collectFunctions(process.env.CRAP_FIXTURE, 'fixture.js')));";
  const environment = { ...process.env, CRAP_OWNER_URL: pathToFileURL(path.join(qualityDirectory, 'crap.mjs')).href, CRAP_FIXTURE: transportFixture, CRAP_PARSER_TRANSPORT: transport };
  delete environment.NODE_V8_COVERAGE;
  return spawnSync(process.execPath, ['--permission', '--allow-fs-read=*', '--allow-child-process', '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 60000, env: environment });
}

test('the async parser transport yields byte-identical rows to the sync default', async () => {
  const syncRows = await collectFunctions(transportFixture, 'fixture.js');
  const asyncRows = await collectFunctions(transportFixture, 'fixture.js', { transport: 'async' });
  assert.equal(JSON.stringify(asyncRows), JSON.stringify(syncRows));
  assert.deepEqual(syncRows.filter((row) => row.name === 'area').map((row) => row.identity), ['<root>/GetAccessor:area#0', '<root>/MethodDeclaration:area#0']);
  assert.equal(syncRows.length, 11);
});

test('the parser transport comes from the option, then the environment, and rejects unknown names', () => {
  assert.throws(() => parserTransport('bogus'), /Unknown TypeScript parser transport "bogus"; use sync or async/);
  const previous = process.env.CRAP_PARSER_TRANSPORT;
  process.env.CRAP_PARSER_TRANSPORT = 'async';
  try {
    assert.equal(parserTransport(), parserTransport('async'));
    assert.notEqual(parserTransport('sync'), parserTransport('async'));
  } finally {
    if (previous === undefined) delete process.env.CRAP_PARSER_TRANSPORT;
    else process.env.CRAP_PARSER_TRANSPORT = previous;
  }
});

test('under node --permission the sync transport is refused at the named pipe and the async transport matches an unrestricted run', async () => {
  const refused = collectUnderReadOnlyPermission('sync');
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /SyncRpcChannel: timed out connecting to named pipe/);

  const permitted = collectUnderReadOnlyPermission('async');
  assert.equal(permitted.status, 0, permitted.stderr);
  assert.equal(permitted.stdout, JSON.stringify(await collectFunctions(transportFixture, 'fixture.js')));
});

// SQ-3465: tsx maps an async arrow's start past `async (`, so the record has to land inside the
// arrow's own span, never the enclosing callback's, which would take the child's coverage.
const asyncArrowTestFile = [
  "import assert from 'node:assert/strict';",
  "import test from 'node:test';",
  '',
  'function fixture() {',
  '  const values: number[] = [];',
  '  return {',
  '    values,',
  '    cleanup: async () => {',
  '      values.push(1);',
  '      await Promise.resolve();',
  '    },',
  '  };',
  '}',
  '',
  "test('async arrows run', async (): Promise<void> => {",
  '  const values: number[] = [];',
  '  const cleanup = async () => {',
  '    values.push(1);',
  '    await Promise.resolve();',
  '  };',
  '  const syncCleanup = () => {',
  '    values.push(2);',
  '  };',
  '  const idle = async () => {',
  '    values.push(3);',
  '  };',
  '  await cleanup();',
  '  syncCleanup();',
  '  const made = fixture();',
  '  await made.cleanup();',
  '  assert.deepEqual([...values, ...made.values], [1, 2, 1]);',
  '  assert.equal(typeof idle, "function");',
  '});',
  '',
].join('\n');

test('a tsx-loaded test file scores an executed async arrow, assigned or a property, with its own coverage', async () => {
  const fixtureRoot = await fs.mkdtemp(path.join(process.cwd(), 'plugins', 'sidequest', 'test', 'crap-tsx-async-'));
  const coverageDirectory = path.join(fixtureRoot, 'coverage');
  const sourcePath = path.join(fixtureRoot, 'async.test.ts');
  await fs.writeFile(sourcePath, asyncArrowTestFile);
  try {
    const { NODE_TEST_CONTEXT, ...environment } = process.env;
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', 'async.test.ts'], { cwd: fixtureRoot, encoding: 'utf8', env: { ...environment, NODE_V8_COVERAGE: coverageDirectory } });
    assert.equal(result.status, 0, result.stderr);
    const metrics = await sourceMetrics(sourcePath, await readCoverage(coverageDirectory));
    const rows = metrics.map((entry) => `${entry.line} ${entry.name} ${entry.coverage}`);
    assert.deepEqual(rows, [
      '4 fixture 1',
      '8 cleanup 1',
      '15 <anonymous> 1',
      '17 cleanup 1',
      '21 syncCleanup 1',
      '24 idle 0',
    ]);
  } finally {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
});
