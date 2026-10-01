import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import crapCore from './crap-core.cjs';
import { baselineFunctions, builtOutput, captureCoverage, changedMetricsAgainstBase, collectFunctions, compareAgainstBase, diffEntries, emptyChangedFunctionWarning, functionCoverage, isScoredSource, lizardMetric, selectSuites, sourceMetrics } from './crap.mjs';

const { crapScore, parseLizardCsv } = crapCore;

function metric({ complexity, coverage, name = 'subject', fingerprint = 'changed', relativePath = 'plugins/example/lib/subject.js' }) {
  return {
    identity: `<root>/FunctionDeclaration:${name}#0`,
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
  return async () => new Map(entries);
}

test('collects stable identities and source fingerprints', async () => {
  const functions = await collectFunctions('function outer() { return () => 1; }', 'fixture.ts');
  assert.deepEqual(functions.map((entry) => entry.name), ['outer', '<anonymous>']);
  assert.ok(functions.every((entry) => entry.fingerprint.length === 64));
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
  const unverified = { ...metric({ complexity: 1, coverage: 1 }), unverified: 'lizard could not measure this function' };
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

test('skips generated Sidequest build output', () => {
  const sidequestRoot = path.join(process.cwd(), 'plugins', 'sidequest');
  assert.equal(isScoredSource(path.join(sidequestRoot, 'src', 'lib', 'mcp-collaboration.ts')), true);
  assert.equal(isScoredSource(path.join(sidequestRoot, 'lib', 'mcp-collaboration.js')), false);
  assert.equal(isScoredSource(path.join(sidequestRoot, 'hooks', 'session-start.js')), false);
  assert.equal(isScoredSource(path.join(sidequestRoot, 'bin', 'sidequest.js')), false);
});

test('reports an unmeasurable Lizard descriptor without throwing', () => {
  const descriptor = { line: 174, name: '<anonymous>' };
  assert.equal(lizardMetric(descriptor, []), null);
  assert.equal(lizardMetric(descriptor, [{ start: 174, name: '(anonymous)', complexity: 3 }]), 3);
  assert.equal(parseLizardCsv('').length, 0);
});

test('keeps unmeasurable source functions in the metric list', async () => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'crap-source-metrics-'));
  const sourcePath = path.join(temporaryDirectory, 'fixture.js');
  const sourceText = 'function subject() { return 1; }';
  await fs.writeFile(sourcePath, sourceText);
  try {
    const coverageScripts = new Map([[path.resolve(sourcePath).replaceAll('\\', '/').toLowerCase(), [{ functionName: 'subject', ranges: [{ startOffset: 0, endOffset: sourceText.length, count: 1 }] }]]]);
    const [metricResult] = await sourceMetrics(sourcePath, coverageScripts, []);
    assert.equal(metricResult.name, 'subject');
    assert.equal(metricResult.unverified, 'lizard could not measure this function');
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
    const lizardEntries = [{ start: 1, name: 'outer', complexity: 1 }, { start: 2, name: '(anonymous)', complexity: 2 }];
    const metrics = await sourceMetrics(sourcePath, coverageScripts, lizardEntries);
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
  assert.deepEqual(suites.map((suite) => suite.plugin), ['sidequest']);
  assert.deepEqual(suites[0].args, ['run', 'test:full']);
  assert.equal(suiteSummary, 'sidequest');
});

test('a gateway plus observability diff runs both suites and nothing else', async () => {
  const { suites, suiteSummary } = await suitesRunFor(['plugins/model-gateway/lib/commands.js', 'plugins/observability/lib/store.js', 'plugins/model-gateway/lib/settings-wiring.js']);
  assert.deepEqual(suites.map((suite) => suite.plugin), ['model-gateway', 'observability']);
  assert.deepEqual(suites[0].args, ['run', 'test']);
  assert.deepEqual(suites[1].args.slice(0, 1), ['--test']);
  assert.equal(suiteSummary, 'model-gateway, observability');
});

test('a quartermaster hooks diff runs the quartermaster node --test suite', async () => {
  const { suites } = await suitesRunFor(['plugins/quartermaster/hooks/session-start-nudge.js']);
  assert.deepEqual(suites.map((suite) => suite.plugin), ['quartermaster']);
  assert.equal(suites[0].args[0], '--test');
});

test('a diff outside the plugins runs no suite', async () => {
  const { suites, suiteSummary } = await suitesRunFor(['docs/src/content/docs/contributing.md', 'plugins']);
  assert.deepEqual(suites, []);
  assert.equal(suiteSummary, 'none, no plugin changed');
  assert.deepEqual(await selectSuites(['plugins/not-a-plugin/lib/a.js']), []);
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
