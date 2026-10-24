import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { loadCompiler } from '../lib/compiler.mjs';
import { logicalLoopContext } from '../lib/loop-branches.mjs';
import { createAnalyzer, readCoverage, normalizedPath } from '../lib/core.mjs';
import { conditionResult } from '../lib/branches.mjs';
import { measureFiles, measureSource } from '../lib/measure.mjs';

const pluginRoot = fileURLToPath(new URL('../', import.meta.url));
const coreUrl = new URL('../lib/core.mjs', import.meta.url).href;
const { transform } = createRequire(import.meta.url)('esbuild');

function coverageDirectoryFor(inherited, local) {
  return inherited || local;
}

async function captured(context, source, calls, temporaryDirectory = os.tmpdir()) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(temporaryDirectory, 'quality-logical-loops-')));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const subject = path.join(root, 'subject.cjs');
  await fs.writeFile(subject, source);
  const coverageDirectory = coverageDirectoryFor(process.env.QUALITY_GATE_V8_CAPTURE, path.join(root, 'owned'));
  await fs.mkdir(coverageDirectory, { recursive: true });
  const { NODE_TEST_CONTEXT, NODE_OPTIONS, NODE_V8_COVERAGE, ...environment } = process.env;
  const execution = spawnSync(process.execPath, ['-e', `const assert = require('node:assert/strict'); const subject = require('./subject.cjs'); ${calls}`], {
    cwd: root, encoding: 'utf8', timeout: 10000,
    env: { ...environment, NODE_OPTIONS: '--import=' + coreUrl, QUALITY_GATE_V8_CAPTURE: coverageDirectory },
  });
  assert.equal(execution.status, 0, execution.stderr);
  const result = await measureFiles([subject], { projectRoot: pluginRoot, coverageDirectory, externalNewFiles: [subject] });
  const metric = result.metrics.find((row) => row.name === 'subject');
  assert.ok(metric);
  return { subject, source, coverageDirectory, metric, metrics: result.metrics };
}

test('aliased temporary bases produce canonical subject and capture identities', async (context) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'quality-temp-alias-')));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const real = path.join(root, 'real');
  const alias = path.join(root, 'alias');
  await fs.mkdir(real);
  await fs.symlink(real, alias, 'junction');
  const setup = await captured(context, 'module.exports = function subject(value) { return value; };', 'assert.equal(subject(1),1);', alias);
  assert.equal(path.dirname(path.dirname(setup.subject)), real);
  assert.equal(setup.subject, await fs.realpath(setup.subject));
  assert.equal(setup.metric.coverage, 1);
  const aliasedSubject = path.join(alias, path.relative(real, setup.subject));
  const captures = await readCoverage(setup.coverageDirectory);
  assert.ok(captures.has(normalizedPath(setup.subject)));
  assert.equal(captures.has(normalizedPath(aliasedSubject)), false);
  await assert.rejects(measureFiles([aliasedSubject], { projectRoot: pluginRoot, coverageDirectory: setup.coverageDirectory, externalNewFiles: [aliasedSubject] }), /external declaration is an alias/);
});

function logicalRows(metric) {
  return metric.branches.filter((row) => logicalRow(row));
}

function logicalRow(row) {
  return row.untaken.every((side) => ['right', 'short-circuit'].includes(side)) && !row.unverified?.includes('loop-condition outcomes');
}

function verifiedOutcomes(metric, expected) {
  const rows = logicalRows(metric);
  assert.deepEqual(rows.map((row) => row.untaken), expected);
  assert.ok(rows.every((row) => !row.unverified), JSON.stringify(rows));
}

function unverifiedOutcomes(metric) {
  const rows = logicalRows(metric);
  assert.ok(rows.length > 0);
  assert.ok(rows.every((row) => /logical loop-test/.test(row.unverified)), JSON.stringify(rows));
  assert.ok(rows.every((row) => row.untaken.length === 0));
}

const probe = `
const seen = { left: [], middle: [], right: [] };
const p = Object.fromEntries(Object.keys(seen).map(key => [key, value => { seen[key].push(value); return value; }]));
`;

const ordinaryCases = [
  ['while zero iterations', 'while (p.left(i < n) && p.right(true)) { i++; }', 0, [['right']], [false], []],
  ['while one iteration', 'while (p.left(i < n) && p.right(true)) { i++; }', 1, [], [true, false], [true]],
  ['while repeated iterations', 'while (p.left(i < n) && p.right(true)) { i++; }', 3, [], [true, true, true, false], [true, true, true]],
  ['while continue', 'while (p.left(i < n) && p.right(true)) { i++; continue; }', 3, [], [true, true, true, false], [true, true, true]],
  ['for zero iterations', 'for (; p.left(i < n) && p.right(true); i++) {}', 0, [['right']], [false], []],
  ['for repeated iterations', 'for (; p.left(i < n) && p.right(true); i++) {}', 3, [], [true, true, true, false], [true, true, true]],
  ['AND exits only through RHS', 'while (p.left(true) && p.right(i < n)) { i++; }', 3, [['short-circuit']], [true, true, true, true], [true, true, true, false]],
  ['OR zero iterations', 'while (p.left(i < n) || p.right(false)) { i++; }', 0, [['short-circuit']], [false], [false]],
  ['OR repeated iterations', 'while (p.left(i < n) || p.right(false)) { i++; }', 3, [], [true, true, true, false], [false]],
  ['OR exits only through RHS', 'while (p.left(false) || p.right(i < n)) { i++; }', 3, [['short-circuit']], [false, false, false, false], [true, true, true, false]],
];

for (const [name, loop, limit, missing, left, right] of ordinaryCases) {
  test(`logical loop evaluations: ${name}`, async (context) => {
    const setup = await captured(context, `module.exports = function subject(n, p) { let i = 0; ${loop} return i; };`,
      `${probe} assert.equal(subject(${limit}, p), ${limit}); assert.deepEqual(seen.left, ${JSON.stringify(left)}); assert.deepEqual(seen.right, ${JSON.stringify(right)});`);
    verifiedOutcomes(setup.metric, missing);
  });
}

test('zero and repeated calls in one capture do not cancel a final short-circuit', async (context) => {
  const setup = await captured(context, 'module.exports = function subject(n, p) { let i = 0; while (p.left(i < n) && p.right(true)) { i++; } return i; };',
    `${probe} assert.equal(subject(0, p), 0); assert.equal(subject(3, p), 3); assert.deepEqual(seen.left, [false,true,true,true,false]); assert.equal(seen.right.length, 3);`);
  verifiedOutcomes(setup.metric, []);
});

const nestedCases = [
  ['left-associated AND', 'p.left(i < n) && p.middle(true) && p.right(true)', [true, true, true, false], [true, true, true], [true, true, true]],
  ['AND with a right OR', 'p.left(i < n) && (p.middle(i < 1) || p.right(true))', [true, true, true, false], [true, false, false], [true, true]],
  ['OR with a left AND', '(p.left(i < 1) && p.middle(true)) || p.right(i < n)', [true, false, false, false], [true], [true, true, false]],
  ['negated OR', '!(p.left(i >= n) || p.right(false))', [false, false, false, true], [], [false, false, false]],
];

for (const [name, guard, left, middle, right] of nestedCases) {
  test(`logical loop evaluation tree: ${name}`, async (context) => {
    const setup = await captured(context, `module.exports = function subject(n, p) { let i = 0; while (${guard}) { i++; } return i; };`,
      `${probe} assert.equal(subject(3, p), 3); assert.deepEqual(seen.left, ${JSON.stringify(left)}); assert.deepEqual(seen.middle, ${JSON.stringify(middle)}); assert.deepEqual(seen.right, ${JSON.stringify(right)});`);
    verifiedOutcomes(setup.metric, []);
  });
}

test('a short-circuited inner logical expression gets no invented evaluations', async (context) => {
  const setup = await captured(context, 'module.exports = function subject(p) { while (p.left(false) && (p.middle(true) || p.right(true))) {} return 0; };',
    `${probe} assert.equal(subject(p), 0); assert.deepEqual(seen.left, [false]); assert.deepEqual(seen.middle, []); assert.deepEqual(seen.right, []);`);
  verifiedOutcomes(setup.metric, [['right'], ['right', 'short-circuit']]);
});

const skippedCases = [
  ['prologue return', 'if (skip) return -1;', '', 'assert.equal(subject(true, p), -1);'],
  ['prologue throw', "if (skip) throw new Error('before');", '', "assert.throws(() => subject(true, p), /before/);"],
  ['conditional block not reached', 'if (!skip) {', '}', 'assert.equal(subject(true, p), 0);'],
];

for (const [name, before, after, calls] of skippedCases) {
  test(`unreached loop is not function entry: ${name}`, async (context) => {
    const setup = await captured(context, `module.exports = function subject(skip, p) { let i = 0; ${before} while (p.left(i < 3) && p.right(true)) { i++; } i += 0; ${after} return i; };`,
      `${probe} ${calls} assert.deepEqual(seen.left, []); assert.deepEqual(seen.right, []);`);
    verifiedOutcomes(setup.metric, [['right', 'short-circuit']]);
  });
}

test('an exact zero-hit function record supplies zero logical evaluations', async (context) => {
  const setup = await captured(context, 'module.exports = function subject(p) { while (p.left(true) && p.right(true)) {} return 0; };', 'assert.equal(typeof subject, "function");');
  verifiedOutcomes(setup.metric, [['right', 'short-circuit']]);
});

const ambiguousCases = [
  ['break', 'while (p.left(true) && p.right(true)) { break; } return 0;', 'subject(p);'],
  ['OR break', 'while (p.left(true) || p.right(false)) { break; } return 0;', 'subject(p);'],
  ['caught body throw', 'while (p.left(true) && p.right(true)) { try { throw 1; } catch {} break; } return 0;', 'subject(p);'],
  ['enclosing catch', 'try { while (p.left(true) && p.right(true)) { throw 1; } } catch {} return 0;', 'subject(p);'],
  ['finally overrides return', 'while (p.left(true) && p.right(true)) { try { return 1; } finally { break; } } return 0;', 'subject(p);'],
  ['targeted labeled break', 'outer: while (p.left(true) && p.right(true)) { while (true) { break outer; } } return 0;', 'subject(p);'],
  ['labeled continue', 'let i=0; outer: while (p.left(i++ < 2) && p.right(true)) { continue outer; } return 0;', 'subject(p);'],
  ['do while has a separate denominator', 'let i=0; do { i++; } while (p.left(i < 3) && p.right(true)); return i;', 'assert.equal(subject(p), 3);'],
  ['loop lacks a continuation statement', 'let i=0; while (p.left(i++ < 3) && p.right(true)) {}', 'subject(p);'],
  ['logical test inside a call', 'let i=0; while (Boolean(p.left(i++ < 3) && p.right(true))) {} return i;', 'subject(p);'],
];

for (const [name, body, calls] of ambiguousCases) {
  test(`ambiguous logical loop count stays UNVERIFIED: ${name}`, async (context) => {
    const setup = await captured(context, `module.exports = function subject(p) { ${body} };`, `${probe} ${calls}`);
    unverifiedOutcomes(setup.metric);
  });
}

for (const statement of ['return i;', "throw new Error('body');"]) {
  test(`an unanchored body exit never inherits its function-entry count: ${statement}`, async (context) => {
    const setup = await captured(context, `module.exports = function subject(n, p) { let i=0; while (p.left(i < n) && p.right(true)) { i++; ${statement} } return i; };`,
      `${probe} try { subject(3, p); } catch (error) { assert.match(error.message, /body/); } assert.deepEqual(seen.left, [true]); assert.deepEqual(seen.right, [true]);`);
    unverifiedOutcomes(setup.metric);
  });
}

for (const statement of ['return 1;', "throw new Error('body');"]) {
  test(`an exclusive sole-body exit can use its independently counted body region: ${statement}`, async (context) => {
    const setup = await captured(context, `module.exports = function subject(n,p) { while(p.left(n>0) && p.right(true)) { ${statement} } return 0; };`,
      `${probe} try { subject(1,p); } catch(error) { assert.match(error.message,/body/); } assert.equal(subject(0,p),0);assert.equal(subject(0,p),0);assert.deepEqual(seen.left,[true,false,false]);assert.deepEqual(seen.right,[true]);`);
    verifiedOutcomes(setup.metric, []);
  });
  test(`coalesced body/continuation ranges do not prove an exclusive exit: ${statement}`, async (context) => {
    const setup = await captured(context, `module.exports = function subject(n,p) { while(p.left(n>0) && p.right(true)) { ${statement} } return 0; };`,
      `${probe} try { subject(1,p); } catch(error) { assert.match(error.message,/body/); } assert.equal(subject(0,p),0);assert.deepEqual(seen.left,[true,false]);assert.deepEqual(seen.right,[true]);`);
    unverifiedOutcomes(setup.metric);
  });
}

test('returning loop can independently prove both logical outcomes across calls', async (context) => {
  const setup = await captured(context, 'module.exports = function subject(n, p, early) { let i=0; while (p.left(i < n) && p.right(true)) { i++; if (early) return i; } return i; };',
    `${probe} assert.equal(subject(3,p,true),1); assert.equal(subject(0,p,false),0); assert.equal(subject(3,p,false),3); assert.deepEqual(seen.left,[true,false,true,true,true,false]); assert.equal(seen.right.length,4);`);
  verifiedOutcomes(setup.metric, []);
});

test('a throwing loop can prove outcomes with exact owned throw and continuation ranges', async (context) => {
  const setup = await captured(context, "module.exports = function subject(n,p,early) { let i=0; while(p.left(i<n) && p.right(true)) { i++; if(early) throw new Error('body'); } return i; };",
    `${probe} assert.throws(()=>subject(3,p,true),/body/);assert.equal(subject(0,p,false),0);assert.equal(subject(3,p,false),3);assert.deepEqual(seen.left,[true,false,true,true,true,false]);assert.equal(seen.right.length,4);`);
  verifiedOutcomes(setup.metric, []);
});

test('for initializer and updater logicals do not inherit the test denominator', async (context) => {
  const setup = await captured(context, 'module.exports = function subject(p) { let i=0; for (p.left(false) && p.middle(true); i < 3; p.right(true) && i++) {} return i; };',
    `${probe} assert.equal(subject(p),3); assert.deepEqual(seen.left,[false]); assert.deepEqual(seen.middle,[]); assert.deepEqual(seen.right,[true,true,true]);`);
  verifiedOutcomes(setup.metric, [['right'], ['short-circuit']]);
});

test('a callback in a guard owns its logical counts independently', async (context) => {
  const setup = await captured(context, 'module.exports = function subject(p) { let i=0; while ([true,false].some(value => value && p.right(true)) && i++ < 2) {} return i; };',
    `${probe} assert.equal(subject(p),3); assert.equal(seen.right.length,3);`);
  const rows = logicalRows(setup.metric);
  assert.ok(rows.every((row) => !row.unverified));
  assert.deepEqual(rows.map((row) => row.untaken), [['short-circuit']]);
  const callback = setup.metrics.find((row) => row.name === '<anonymous>');
  assert.ok(callback);
  verifiedOutcomes(callback, [['short-circuit']]);
});

for (const body of ['const nested = () => { return 1; }; i += nested();', 'class Nested { value() { return 1; } } i += new Nested().value();']) {
  test(`nested scopes do not become owned body exits: ${body}`, async (context) => {
    const setup = await captured(context, `module.exports = function subject(n,p) { let i=0; while(p.left(i<n) && p.right(true)) { ${body} } return i; };`, `${probe} assert.equal(subject(3,p),3);`);
    verifiedOutcomes(setup.metric, []);
  });
}

test('nested loops count their own reached regions rather than function entries', async (context) => {
  const setup = await captured(context, 'module.exports = function subject(p) { let i=0; while(p.left(i<3) && p.right(true)) { let j=0; while(p.middle(j<2) && p.right(true)) { j++; } i++; } return i; };',
    `${probe} assert.equal(subject(p),3);assert.deepEqual(seen.left,[true,true,true,false]);assert.equal(seen.middle.length,9);assert.equal(seen.right.length,9);`);
  verifiedOutcomes(setup.metric, []);
});

const pollingSource = `
const { setTimeout: pause } = require('node:timers/promises');
module.exports = async function subject(check, timeout = 5000) {
  const deadline = Date.now() + timeout;
  let value;
  while (Date.now() < deadline && !value) {
    value = await check();
    if (!value) await pause(20);
  }
  if (!value) throw new Error('fixture condition timed out');
  return value;
};`;

test('polling zero timeout never calls its callback, and natural timeouts cover short-circuit', async (context) => {
  const setup = await captured(context, pollingSource, `(async () => {
    let now=0; Date.now=()=>now;
    let expiredCalled=false;
    await assert.rejects(subject(()=>{expiredCalled=true;return true;},0),/timed out/);
    assert.equal(expiredCalled,false);
    assert.equal(await subject(()=>true,100),true);
    let calls=0;
    await assert.rejects(subject(()=>{calls++;now=200;return false;},100),/timed out/);
    assert.equal(calls,1);
  })().catch(error=>{console.error(error);process.exitCode=1;});`);
  assert.equal(setup.metric.coverage, 1);
  assert.equal(setup.metric.crap, 5);
  verifiedOutcomes(setup.metric, []);
});

const stringSource = `module.exports = function subject(text, start) {
  let index = start + 1;
  while (index < text.length && text.charCodeAt(index) !== 34) {
    index += text.charCodeAt(index) === 92 ? 2 : 1;
  }
  if (index >= text.length) throw new Error('Antigravity JSON string is incomplete');
  return index + 1;
};`;

test('JSON strings: unterminated and trailing escapes prove the left-false guard', async (context) => {
  const setup = await captured(context, stringSource, `
    assert.equal(subject('""',0),2);
    assert.equal(subject('"abc"',0),5);
    assert.equal(subject('"a\\\\\\"b"',0),6);
    assert.throws(()=>subject('"abc',0),/incomplete/);
    assert.throws(()=>subject('"a\\\\',0),/incomplete/);
  `);
  assert.equal(setup.metric.coverage, 1);
  assert.equal(setup.metric.crap, 5);
  verifiedOutcomes(setup.metric, []);
});

async function proofRecord(setup) {
  const analyzer = await createAnalyzer(pluginRoot);
  try {
    const descriptors = await analyzer.collectFunctions(setup.source, setup.subject);
    const descriptor = descriptors.find((row) => row.name === 'subject');
    const condition = descriptor.conditions.find((row) => row.sides?.includes('right'));
    const captures = await readCoverage(setup.coverageDirectory);
    const [capture] = captures.get(normalizedPath(setup.subject));
    assert.equal(capture.text, setup.source);
    const record = capture.records.find((row) => row.functionName === 'subject');
    return { condition, record: { ...record, directSource: true } };
  } finally {
    await analyzer.close();
  }
}

const invalidCounters = [
  ['all ranges missing', () => []],
  ['negative count', (ranges) => ranges.map((row) => ({ ...row, count: -1 }))],
  ['unsafe integer count', (ranges) => ranges.map((row) => ({ ...row, count: Number.MAX_SAFE_INTEGER + 1 }))],
  ['fractional count', (ranges) => ranges.map((row) => ({ ...row, count: 0.5 }))],
  ['negative offset', (ranges) => ranges.map((row) => ({ ...row, startOffset: -1 }))],
  ['reversed interval', (ranges) => ranges.map((row) => ({ ...row, startOffset: row.endOffset }))],
  ['outside owned function', (ranges) => [...ranges, { startOffset: ranges[0].endOffset, endOffset: ranges[0].endOffset + 1, count: 1 }]],
  ['before owned function', (ranges) => [...ranges, { startOffset: ranges[0].startOffset - 1, endOffset: ranges[0].startOffset + 1, count: 1 }]],
  ['continuation exceeds reached entries', (ranges, condition) => [...ranges, { startOffset: condition.logicalLoop.after, endOffset: ranges[0].endOffset - 1, count: 2 }]],
  ['reversed crossing overlap', (ranges) => [ranges[0], { startOffset: ranges[1].startOffset + 1, endOffset: ranges[1].endOffset + 1, count: 1 }, ...ranges.slice(1)]],
  ['safe counters with unsafe sum', (ranges) => ranges.map((row, index) => ({ ...row, count: index === 0 ? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER - 1 }))],
  ['zero entry with positive body', (ranges) => ranges.map((row, index) => ({ ...row, count: index === 0 ? 0 : 1 }))],
  ['duplicate interval', (ranges) => [...ranges, { ...ranges[0], count: 7 }]],
  ['crossing overlap', (ranges) => [...ranges, { startOffset: ranges[1].startOffset + 1, endOffset: ranges[1].endOffset + 1, count: 1 }]],
  ['RHS exceeds proven guard count', (ranges) => ranges.map((row, index) => ({ ...row, count: index === 1 ? 100 : row.count }))],
];

for (const [name, mutate] of invalidCounters) {
  test(`invalid logical-loop evidence fails closed: ${name}`, async (context) => {
    const setup = await captured(context, 'module.exports = function subject(n, p) { let i=0; while (p.left(i<n) && p.right(true)) { i++; } return i; };', `${probe} subject(3,p);`);
    const { condition, record } = await proofRecord(setup);
    const row = conditionResult(condition, [{ ...record, ranges: mutate(record.ranges, condition) }]);
    assert.match(row?.unverified, /logical loop-test/);
    assert.deepEqual(row.untaken, []);
  });
}

test('missing dedicated continuation after return is not inherited from function entry', async (context) => {
  const setup = await captured(context, 'module.exports = function subject(p) { while (p.left(true) && p.right(true)) { return 1; } return 0; };', `${probe} assert.equal(subject(p),1);`);
  const { condition, record } = await proofRecord(setup);
  const row = conditionResult(condition, [{ ...record, ranges: [record.ranges[0]] }]);
  assert.match(row?.unverified, /logical loop-test/);
  assert.deepEqual(row.untaken, []);
});

test('transformed or unknown branch provenance cannot prove direct-source loop math', async (context) => {
  const setup = await captured(context, 'module.exports = function subject(p) { let i=0; while (p.left(i++<3) && p.right(true)) {} return i; };', `${probe} subject(p);`);
  const { condition, record } = await proofRecord(setup);
  for (const directSource of [false, undefined]) {
    const row = conditionResult(condition, [{ ...record, directSource }]);
    assert.match(row?.unverified, /logical loop-test/);
    assert.deepEqual(row.untaken, []);
  }
});

test('capture directory selection preserves inherited capture and isolated fallback', () => {
  assert.equal(coverageDirectoryFor('/owned', '/local'), '/owned');
  assert.equal(coverageDirectoryFor(undefined, '/local'), '/local');
});

for (const [body, bodyCalls] of [['i++;', 0], ['return 1;', 1]]) {
  test(`an aborted inner predicate cannot masquerade as a short-circuit across calls: ${body}`, async (context) => {
    const setup = await captured(context, `module.exports = function subject(mode, p) { let i=0; while (p.left(mode !== 'skip') && (p.middle(mode) && p.right(mode === 'body'))) { ${body} } return i; };`, `
      let middleCalls=0, rightCalls=0; const middleReturns=[];
      const p={left:value=>value, middle(mode){middleCalls++;if(mode==='abort')throw new Error('predicate');middleReturns.push(true);return true;}, right(value){rightCalls++;return value;}};
      assert.throws(()=>subject('abort',p),/predicate/);
      assert.equal(subject('normal',p),0);
      assert.equal(subject('skip',p),0);
      for(let index=0;index<${bodyCalls};index++) assert.equal(subject('body',p),1);
      assert.equal(middleCalls,${2 + bodyCalls});assert.deepEqual(middleReturns,${JSON.stringify(Array(1 + bodyCalls).fill(true))});assert.equal(rightCalls,${1 + bodyCalls});
    `);
    unverifiedOutcomes(setup.metric);
  });
}

test('an aborted getter in a logical left operand cannot supply short-circuit evidence', async (context) => {
  const setup = await captured(context, `module.exports = function subject(mode, p) { while (p.left(mode !== 'skip') && (p.middle && p.right(false))) {} return 0; };`, `
    let mode='abort', getterCalls=0, rightCalls=0;
    const p={left:value=>value,get middle(){getterCalls++;if(mode==='abort')throw new Error('getter');return true;},right(value){rightCalls++;return value;}};
    assert.throws(()=>subject(mode,p),/getter/);mode='normal';assert.equal(subject(mode,p),0);mode='skip';assert.equal(subject(mode,p),0);
    assert.equal(getterCalls,2);assert.equal(rightCalls,1);
  `);
  unverifiedOutcomes(setup.metric);
});

test('an aborted inner OR cannot become a fully covered function by aggregation', async (context) => {
  const setup = await captured(context, 'module.exports = function subject(p) { let i=0; while (p.a(i) && (p.b() || p.c())) { i++; } return i; };', `
    const a=[], b=[], c=[];
    assert.throws(()=>subject({a:i=>{a.push(true);return true;},b:()=>{b.push('throw');throw new Error('predicate');},c:()=>{throw new Error('unreached');}}),/predicate/);
    assert.equal(subject({a:i=>{a.push(i<1);return i<1;},b:()=>{b.push(false);return false;},c:()=>{c.push(true);return true;}}),1);
    assert.equal(subject({a:i=>{a.push(false);return false;},b:()=>{throw new Error('unreached');},c:()=>{throw new Error('unreached');}}),0);
    assert.deepEqual(a,[true,true,false,false]);assert.deepEqual(b,['throw',false]);assert.deepEqual(c,[true]);
  `);
  assert.equal(setup.metric.coverage,1);
  unverifiedOutcomes(setup.metric);
});

test('await rejection is not an inner short-circuit even when another call exits normally', async (context) => {
  const setup = await captured(context, 'module.exports = async function subject(n,p) { let i=0; while(p.left(i<n) && (await p.middle() && p.right(true))) { i++; } return i; };', `(async()=>{
    const seen={left:[],middle:0,right:[]};
    const p={left(value){seen.left.push(value);return value;},async middle(){seen.middle++;throw new Error('predicate');},right(value){seen.right.push(value);return value;}};
    await assert.rejects(subject(3,p),/predicate/);assert.equal(await subject(0,p),0);
    assert.deepEqual(seen,{left:[true,false],middle:1,right:[]});
  })().catch(error=>{console.error(error);process.exitCode=1;});`);
  unverifiedOutcomes(setup.metric);
});

test('a suspended predicate leaves an unexplained reached attempt UNVERIFIED', async (context) => {
  const setup = await captured(context, 'module.exports = async function subject(p) { while(p.left(true) && (await p.middle() && p.right(true))) {} return 0; };', `
    let calls=0;subject({left:value=>value,middle(){calls++;return new Promise(()=>{});},right(){throw new Error('unreached');}});assert.equal(calls,1);
  `);
  unverifiedOutcomes(setup.metric);
});

test('unused abrupt exits without a dedicated continuation remain unproven', async (context) => {
  const setup = await captured(context, 'module.exports = function subject(n,p,early) { let i=0; while(p.left(i<n) && p.right(true)) { i++; if(early) return i; } return i; };', `${probe} assert.equal(subject(3,p,false),3);`);
  unverifiedOutcomes(setup.metric);
});

test('missing proof anchors and unknown owned-exit context fail closed', async (context) => {
  const setup = await captured(context, 'module.exports = function subject(n,p) { let i=0; while(p.left(i<n) && p.right(true)) { i++; } return i; };', `${probe} subject(3,p);`);
  const { condition, record } = await proofRecord(setup);
  const outside = record.ranges[0].endOffset + 1;
  for (const patch of [{ after: outside }, { exits: undefined }, { exits: [{ startOffset: outside, endOffset: outside + 1 }] }]) {
    const row = conditionResult({ ...condition, logicalLoop: { ...condition.logicalLoop, ...patch } }, [record]);
    assert.match(row?.unverified, /logical loop-test/);
    assert.deepEqual(row.untaken, []);
  }
  const missingRight = conditionResult({ ...condition, taken: outside }, [record]);
  assert.match(missingRight?.unverified, /logical loop-test/);
});

test('an exclusive block cannot be reassigned to another exit statement', async (context) => {
  const setup = await captured(context, 'module.exports = function subject(n,p) { while(p.left(n>0) && p.right(true)) { return 1; } return 0; };', `${probe} subject(1,p);subject(0,p);subject(0,p);`);
  verifiedOutcomes(setup.metric, []);
  const { condition, record } = await proofRecord(setup);
  const exclusiveExit = { ...condition.logicalLoop.exclusiveExit, statement: { startOffset: 0, endOffset: 1 } };
  const row = conditionResult({ ...condition, logicalLoop: { ...condition.logicalLoop, exclusiveExit } }, [record]);
  assert.match(row?.unverified, /logical loop-test/);
});

test('independent owned exit counters cannot overflow the conservation sum', async (context) => {
  const setup = await captured(context, "module.exports = function subject(n,p) { while(p.left(n>0) && p.right(true)) { if(n===1) return 1; if(n===2) throw new Error('body'); n=0; } return 0; };", `${probe} assert.equal(subject(1,p),1);assert.throws(()=>subject(2,p),/body/);assert.equal(subject(3,p),0);assert.equal(subject(3,p),0);assert.equal(subject(0,p),0);`);
  verifiedOutcomes(setup.metric, []);
  const { condition, record } = await proofRecord(setup);
  assert.equal(condition.logicalLoop.exits.length, 2);
  const ranges = record.ranges.map((range) => ({ ...range, count: condition.logicalLoop.exits.some((exit) => exit.startOffset === range.startOffset && exit.endOffset === range.endOffset) ? Number.MAX_SAFE_INTEGER : range.count }));
  const row = conditionResult(condition, [{ ...record, ranges }]);
  assert.match(row?.unverified, /logical loop-test/);
});

for (const statement of ['return 1;', "throw new Error('body');"]) {
  test(`unbraced sole exits have their own statement counter: ${statement}`, async (context) => {
    const setup = await captured(context, `module.exports = function subject(n,p) { while(p.left(n>0) && p.right(true)) ${statement} return 0; };`, `${probe} try { subject(1,p); } catch(error) {assert.match(error.message,/body/);}subject(0,p);subject(0,p);`);
    verifiedOutcomes(setup.metric, []);
  });
}

test('standalone AST roots stop context search without borrowing function ownership', async () => {
  const { ast, SyncParserApi, createVirtualFileSystem } = await loadCompiler(pluginRoot);
  const files = createVirtualFileSystem({});
  files.writeFile('/top-level.js', 'const value = left && right; while(left && right) {} done();');
  files.writeFile('/tsconfig.json', JSON.stringify({ compilerOptions: { allowJs: true }, files: ['/top-level.js'] }));
  const api = new SyncParserApi({ cwd: '/', fs: files });
  const child = api.client.channel.child;
  const exited = once(child, 'exit');
  child.ref();
  try {
    const snapshot = await api.updateSnapshot({ openProject: '/tsconfig.json' });
    try {
      const source = await snapshot.getProject('/tsconfig.json').program.getSourceFile('/top-level.js');
      const outside = source.statements[0].declarationList.declarations[0].initializer;
      assert.deepEqual(logicalLoopContext(ast, outside), {});
      const loop = logicalLoopContext(ast, source.statements[1].expression);
      assert.equal(loop.logicalLoop.unsupported, true);
    } finally {
      await snapshot.dispose();
    }
  } finally {
    await api.close();
    await exited;
  }
});

test('external capture debt remains authoritative for a named condition', () => {
  assert.deepEqual(conditionResult({ line: 1, text: 'flag', sides: ['then', 'else'] }, [], 'capture gap'), { line: 1, text: 'flag', untaken: [], unverified: 'capture gap' });
});

test('non-loop switch arms keep their existing outcome semantics', async (context) => {
  const setup = await captured(context, 'module.exports = function subject(value) { switch(value) { case 1: return 1; default: return 0; } };', 'assert.equal(subject(1),1);assert.equal(subject(0),0);');
  assert.deepEqual(setup.metric.branches, []);
});

const mappedCases = [
  ['loop', 'module.exports = function subject(n,p) { let i=0; while(p.left(i<n) && p.right(true)) { i++; } return i; };', `${probe} assert.equal(subject(3,p),3);`, unverifiedOutcomes],
  ['non-loop', 'module.exports = function subject(value) { return value && Math.abs(value); };', 'assert.equal(subject(0),0);assert.equal(subject(-1),1);', (metric) => verifiedOutcomes(metric, [])],
];

for (const [name, source, calls, expect] of mappedCases) {
  test(`authentic compiler provenance: ${name} evidence stays in its supported scope`, async (context) => {
    const { code: original } = await transform(source, { loader: 'js', format: 'cjs' });
    const { code: generated } = await transform(original, { loader: 'js', format: 'cjs', sourcemap: 'inline', sourcesContent: true, sourcefile: 'original.cjs' });
    const setup = await captured(context, generated, calls);
    const originalPath = path.join(path.dirname(setup.subject), 'original.cjs');
    await fs.writeFile(originalPath, original);
    assert.notEqual(generated, original);
    const analyzer = await createAnalyzer(pluginRoot);
    try {
      const metrics = await measureSource(originalPath, await readCoverage(setup.coverageDirectory), { projectRoot: pluginRoot, analyzer, outputPaths: [setup.subject], changedLines: [[1, Infinity]] });
      const metric = metrics.find((row) => row.name === 'subject');
      assert.equal(metric.unverified, undefined);
      assert.equal(metric.coverage, 1);
      expect(metric);
    } finally {
      await analyzer.close();
    }
  });
}

for (const ranges of [undefined, null, 'missing', [null]]) {
  test(`malformed logical-loop range container fails closed: ${JSON.stringify(ranges)}`, async (context) => {
    const setup = await captured(context, 'module.exports = function subject(p) { let i=0; while (p.left(i++<3) && p.right(true)) {} return i; };', `${probe} subject(p);`);
    const { condition, record } = await proofRecord(setup);
    const row = conditionResult(condition, [{ ...record, ranges }]);
    assert.match(row?.unverified, /logical loop-test/);
    assert.deepEqual(row.untaken, []);
  });
}
