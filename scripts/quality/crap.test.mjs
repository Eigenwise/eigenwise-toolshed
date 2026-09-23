import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import crapCore from './crap-core.cjs';
import { changedMetricsAgainstBase, collectFunctions, compareAgainstBase, emptyChangedFunctionWarning, isScoredSource, lizardMetric, sourceMetrics } from './crap.mjs';

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
