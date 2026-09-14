import assert from 'node:assert/strict';
import test from 'node:test';
import { collectFunctions } from './crap.mjs';

test('counts nullish coalescing as one decision point', async () => {
  const [functionMetric] = await collectFunctions('function choose(value) { return value ?? "fallback"; }', 'fixture.ts');
  assert.equal(functionMetric.complexity, 2);
});

test('does not charge a parent for a nested function decision', async () => {
  const functions = await collectFunctions('function outer() { return () => { if (true) return 1; return 0; }; }', 'fixture.ts');
  assert.deepEqual(functions.map((functionMetric) => functionMetric.complexity), [1, 2]);
});
