import assert from 'node:assert/strict';
import test from 'node:test';
import { collectFunctions, compareAgainstBase } from './crap.mjs';

function metric({ complexity, coverage, name = 'subject', relativePath = 'src/lib/subject.ts' }) {
  return {
    identity: `<root>/function:${name}#0`,
    name,
    relativePath,
    line: 1,
    complexity,
    coverage,
    crap: complexity ** 2 * (1 - coverage) ** 3 + complexity,
  };
}

function baselineOf(complexityByName) {
  return async () => new Map(Object.entries(complexityByName)
    .map(([name, complexity]) => [`<root>/function:${name}#0`, complexity]));
}

test('counts nullish coalescing as one decision point', async () => {
  const [functionMetric] = await collectFunctions('function choose(value) { return value ?? "fallback"; }', 'fixture.ts');
  assert.equal(functionMetric.complexity, 2);
});

test('does not charge a parent for a nested function decision', async () => {
  const functions = await collectFunctions('function outer() { return () => { if (true) return 1; return 0; }; }', 'fixture.ts');
  assert.deepEqual(functions.map((functionMetric) => functionMetric.complexity), [1, 2]);
});

test('a changed function that gained a decision point fails the gate', async () => {
  const failures = await compareAgainstBase(
    [metric({ complexity: 9, coverage: 0.5 })],
    ['src/lib/subject.ts'],
    'base-sha',
    baselineOf({ subject: 6 }),
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0], /src\/lib\/subject\.ts:1 subject rose from /);
});

test('a changed function that is unchanged passes the gate', async () => {
  const failures = await compareAgainstBase(
    [metric({ complexity: 9, coverage: 0.5 })],
    ['src/lib/subject.ts'],
    'base-sha',
    baselineOf({ subject: 9 }),
  );
  assert.deepEqual(failures, []);
});

test('a changed function that lost a decision point passes the gate', async () => {
  const failures = await compareAgainstBase(
    [metric({ complexity: 6, coverage: 0.5 })],
    ['src/lib/subject.ts'],
    'base-sha',
    baselineOf({ subject: 9 }),
  );
  assert.deepEqual(failures, []);
});

test('a new function at or above the threshold fails the gate', async () => {
  const failures = await compareAgainstBase(
    [metric({ complexity: 9, coverage: 0.5, name: 'arrival' })],
    ['src/lib/subject.ts'],
    'base-sha',
    baselineOf({}),
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0], /arrival is new at /);
});

test('a new function under the threshold does not fail the gate', async () => {
  const failures = await compareAgainstBase(
    [metric({ complexity: 2, coverage: 0.95, name: 'arrival' })],
    ['src/lib/subject.ts'],
    'base-sha',
    baselineOf({}),
  );
  assert.deepEqual(failures, []);
});

test('a worsened function in an unchanged file does not fail the gate', async () => {
  const failures = await compareAgainstBase(
    [metric({ complexity: 9, coverage: 0.5 })],
    [],
    'base-sha',
    baselineOf({ subject: 6 }),
  );
  assert.deepEqual(failures, []);
});

// The gate holds coverage constant on both sides, so a function that keeps its
// complexity and loses coverage reads as unchanged. SQ-2889 owns closing that arm;
// this asserts the current reach so the follow-up has a failing test to flip.
test('a coverage regression alone is currently invisible to the gate', async () => {
  const failures = await compareAgainstBase(
    [metric({ complexity: 9, coverage: 0.1 })],
    ['src/lib/subject.ts'],
    'base-sha',
    baselineOf({ subject: 9 }),
  );
  assert.deepEqual(failures, []);
});
