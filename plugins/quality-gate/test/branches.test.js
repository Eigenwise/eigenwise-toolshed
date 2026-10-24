import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { measureFiles } from '../lib/measure.mjs';

const coreUrl = new URL('../lib/core.mjs', import.meta.url).href;
const cliPath = fileURLToPath(new URL('../bin/quality-gate.js', import.meta.url));

function execute(command, argumentsList, options) {
  const execution = spawnSync(command, argumentsList, { encoding: 'utf8', timeout: 30000, ...options });
  assert.equal(execution.status, 0, execution.stderr);
  return execution;
}

async function fixture(context, source, calls, baseline) {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'quality-branches-'));
  context.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  const coverageDirectory = path.join(projectRoot, 'coverage');
  await fs.mkdir(coverageDirectory);
  assert.deepEqual(await fs.readdir(coverageDirectory), []);
  execute('git', ['init', '--quiet'], { cwd: projectRoot });
  await fs.writeFile(path.join(projectRoot, 'subject.cjs'), baseline ?? '');
  execute('git', ['add', 'subject.cjs'], { cwd: projectRoot });
  execute('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'baseline'], { cwd: projectRoot });
  await fs.writeFile(path.join(projectRoot, 'subject.cjs'), source);
  const { NODE_TEST_CONTEXT, NODE_OPTIONS, NODE_V8_COVERAGE, ...environment } = process.env;
  const runner = `const subject = require('./subject.cjs'); ${calls}`;
  execute(process.execPath, ['-e', runner], { cwd: projectRoot, env: { ...environment, NODE_OPTIONS: '--import=' + coreUrl, QUALITY_GATE_V8_CAPTURE: coverageDirectory } });
  return { projectRoot, coverageDirectory, base: 'HEAD' };
}

function report(fixture) {
  return measureFiles(['subject.cjs'], fixture);
}

test('new always-true missing-field condition fails with an untaken else despite low CRAP', async (context) => {
  const setup = await fixture(context, 'module.exports = function subject(value) { if (!value.missingField) return 1; return 0; };', 'subject({});');
  const result = await report(setup);
  assert.ok(result.changedMetrics[0].crap < 6);
  assert.deepEqual(result.changedMetrics[0].branches, [{ line: 1, text: '!value.missingField', untaken: ['else'] }]);
  assert.equal(result.failures.length, 1);
  assert.match(result.summary, /branches: 1 failures/);
  const execution = spawnSync(process.execPath, [cliPath, 'measure', '--project', setup.projectRoot, '--base', 'HEAD', '--coverage', setup.coverageDirectory, 'subject.cjs'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(execution.status, 1);
  assert.match(execution.stderr, /branches: 1 failures/);
});

test('both condition sides across separate captured processes clear the branch failure', async (context) => {
  const source = 'module.exports = function subject(value) { if (!value.missingField) return 1; return 0; };';
  const setup = await fixture(context, source, `subject({}); require('node:child_process').spawnSync(process.execPath, ['-e', "require('./subject.cjs')({missingField: true})"], {env: process.env});`);
  const result = await report(setup);
  assert.deepEqual(result.changedMetrics[0].branches, []);
  assert.deepEqual(result.failures, []);
});

test('legacy changed conditions are informational and unchanged condition lines are excluded', async (context) => {
  const baseline = 'module.exports = function subject(value) {\n if (value.old) return 1;\n if (value.untouched) return 2;\n return 0;\n};';
  const source = baseline.replace('value.old', '!value.missingField');
  const setup = await fixture(context, source, 'subject({});', baseline);
  const result = await report(setup);
  assert.equal(result.changedMetrics[0].classification, 'legacy-unchanged');
  assert.deepEqual(result.changedMetrics[0].branches, [{ line: 2, text: '!value.missingField', untaken: ['else'] }]);
  assert.deepEqual(result.failures, []);
  assert.match(result.summary, /0 failures, 1 informational/);
});

test('ternary and logical short-circuit rows report the side that never executed', async (context) => {
  const setup = await fixture(context, 'exports.ternary = value => value ? 1 : 0;\nexports.logical = value => value && Math.abs(value);\nexports.disjunction = value => value || Math.abs(value);', 'subject.ternary(true); subject.logical(1); subject.disjunction(1);');
  const result = await report(setup);
  assert.deepEqual(result.changedMetrics.map(metric => metric.branches[0]?.untaken), [['else'], ['short-circuit'], ['right']]);
  assert.equal(result.failures.length, 3);
});

test('switch arms and loop conditions retain explicit branch evidence', async (context) => {
  const setup = await fixture(context, 'exports.choice = value => { switch(value) { case 1: return 1; default: return 0; } };\nexports.loop = value => { while(value > 0) { value--; } return value; };', 'subject.choice(1); subject.loop(0);');
  const result = await report(setup);
  assert.deepEqual(result.changedMetrics[0].branches[0]?.untaken, ['default']);
  assert.deepEqual(result.changedMetrics[1].branches[0]?.untaken, ['body']);
});

test('NODE_OPTIONS child overrides make named conditions UNVERIFIED instead of never false', async (context) => {
  const setup = await fixture(context, 'module.exports = value => value ? 1 : 0;', `subject(true); require('node:child_process').spawnSync(process.execPath, ['-e', "require('./subject.cjs')(false)"], {env: {...process.env, NODE_OPTIONS: ''}});`);
  const result = await report(setup);
  assert.equal(result.failures.length, 0);
  assert.deepEqual(result.changedMetrics[0].branches[0]?.untaken, []);
  assert.equal(result.changedMetrics[0].branches[0].text, 'value');
  assert.match(result.changedMetrics[0].branches[0].unverified, /child environment dropped/);
  assert.equal(result.unverified.length, 1);
});

test('explicit else, ternary, short-circuit, switch and ordinary loops clear when all outcomes execute', async (context) => {
  const source = 'exports.explicit = value => { if(value) { return 1; } else { return 0; } };\nexports.ternary = value => value ? 1 : 0;\nexports.logical = value => value && Math.abs(value);\nexports.choice = value => { switch(value) { case 1: return 1; default: return 0; } };\nexports.loop = value => { while(value > 0) { value--; } return value; };\nexports.repeating = value => { do { value--; } while(value > 0); return value; };';
  const setup = await fixture(context, source, 'subject.explicit(true); subject.explicit(false); subject.ternary(true); subject.ternary(false); subject.logical(1); subject.logical(0); subject.choice(1); subject.choice(0); subject.loop(2); subject.repeating(2);');
  const result = await report(setup);
  assert.deepEqual(result.changedMetrics.flatMap(metric => metric.branches), []);
  assert.deepEqual(result.failures, []);
});

test('raised complexity enforces branch checks and ambiguous loop exits stay UNVERIFIED', async (context) => {
  const setup = await fixture(context, 'module.exports = value => { if(value) return 1; return 0; };', 'subject(true);', 'module.exports = value => { return 0; };');
  const result = await report(setup);
  assert.equal(result.changedMetrics[0].classification, 'modified-raised');
  assert.equal(result.failures.length, 1);
  const ambiguous = await fixture(context, 'module.exports = value => { while(value) { break; } return 0; };', 'subject(true);');
  const loop = await report(ambiguous);
  assert.match(loop.changedMetrics[0].branches[0].unverified, /loop-condition outcomes/);
  assert.equal(loop.unverified.length, 1);
});
