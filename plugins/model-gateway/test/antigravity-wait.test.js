'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function nextStep(values, label, trace) {
  trace.push(label);
  const value = values.shift();
  if (value instanceof Error) throw value;
  return value;
}

function controlledWait(clock, trace) {
  const filename = path.join(__dirname, 'fixtures', 'antigravity.js');
  const originalRequire = createRequire(filename);
  const subject = { exports: {} };
  const timers = { setTimeout: async (milliseconds) => { trace.push(`pause:${milliseconds}`); } };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module: subject,
    exports: subject.exports,
    Date: { now: () => nextStep(clock, 'clock', trace) },
    require: (name) => name === 'node:timers/promises' ? timers : originalRequire(name),
  }, { filename });
  return subject.exports.waitFor;
}

const ready = { ready: true };
const checkError = new Error('synthetic check rejection');
const clockError = new Error('synthetic clock failure after a successful check');

for (const scenario of [
  { name: 'returns the original truthy value after the final clock observation',
    clock: [0, 0, 1], checks: [ready], result: ready,
    trace: ['clock', 'clock', 'check', 'clock'] },
  { name: 'pauses only after a false check and preserves the final observation',
    clock: [0, 0, 1, 2], checks: [false, 'ready'], result: 'ready',
    trace: ['clock', 'clock', 'check', 'pause:20', 'clock', 'check', 'clock'] },
  { name: 'does not invoke a check after the initial deadline',
    clock: [0, 51], checks: [], error: /fixture condition timed out/,
    trace: ['clock', 'clock'] },
  { name: 'times out after a false check without another invocation',
    clock: [0, 0, 51], checks: [false], error: /fixture condition timed out/,
    trace: ['clock', 'clock', 'check', 'pause:20', 'clock'] },
  { name: 'propagates a rejected check without another clock or pause',
    clock: [0, 0], checks: [checkError], error: checkError,
    trace: ['clock', 'clock', 'check'] },
  { name: 'preserves a final clock failure even after a truthy check',
    clock: [0, 0, clockError], checks: ['ready'], error: clockError,
    trace: ['clock', 'clock', 'check', 'clock'] },
]) {
  test(`native fixture wait ${scenario.name}`, async () => {
    const trace = [];
    const clock = [...scenario.clock];
    const checks = [...scenario.checks];
    const waitFor = controlledWait(clock, trace);
    const result = waitFor(async () => nextStep(checks, 'check', trace), 50);
    if (scenario.error) await assert.rejects(result, scenario.error);
    else assert.equal(await result, scenario.result);
    assert.deepEqual(trace, scenario.trace);
    assert.deepEqual(clock, []);
    assert.deepEqual(checks, []);
  });
}
