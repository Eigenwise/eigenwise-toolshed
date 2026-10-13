import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { gateSettings, sourceHashes } from '../lib/crap-inputs.mjs';
import { acquireCoverage } from '../lib/lcov.mjs';
import { crapReport } from '../lib/crap.mjs';

const pluginRoot = fileURLToPath(new URL('../', import.meta.url));
const coverageProbe = spawnSync('coverage', ['--version'], { encoding: 'utf8', timeout: 30000 });
const coverageRequired = { skip: coverageProbe.status === 0 ? false : 'UNVERIFIED: coverage.py is unavailable for genuine LCOV capture' };

async function captures(root, outputs) {
  await fs.writeFile(path.join(root, 'captures.json'), JSON.stringify(outputs));
}

async function project(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'quality-gate-lcov-path-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'subject.py'), 'import sys\ndef subject():\n    return 1\nif "run" in sys.argv:\n    subject()\n');
  const script = path.join(root, 'capture.cjs');
  await fs.writeFile(script, `const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const directory = process.env.QUALITY_GATE_COVERAGE_DIR;
assert.deepEqual(fs.readdirSync(directory), []);
assert.equal(directory, process.env.QUARTERMASTER_COVERAGE_DIR);
for (const output of JSON.parse(fs.readFileSync('captures.json', 'utf8'))) {
  const destination = output.path === 'isolated' ? path.join(directory, 'lcov.info') : output.path;
  const data = path.join(directory, '.coverage');
  const argumentsList = output.run ? ['run'] : [];
  const execution = spawnSync('coverage', ['run', '--data-file', data, 'subject.py', ...argumentsList], { encoding: 'utf8', timeout: 30000 });
  assert.equal(execution.status, 0, execution.stderr);
  const exported = spawnSync('coverage', ['lcov', '--data-file', data, '-o', destination], { encoding: 'utf8', timeout: 30000 });
  assert.equal(exported.status, 0, exported.stderr);
}
`);
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(script.replaceAll('\\', '/'))}`;
  await captures(root, [{ path: 'configured.info', run: false }]);
  const existing = acquireCoverage(root, { lcov: 'configured.info', coverageCommand: command }, ['subject.py']);
  await fs.writeFile(path.join(root, 'configured.info.sources.json'), JSON.stringify(existing.hashes));
  await captures(root, [{ path: 'isolated', run: true }]);
  await fs.mkdir(path.join(root, '.claude/quality-gate'), { recursive: true });
  await fs.writeFile(path.join(root, '.claude/quality-gate/crap.json'), JSON.stringify({ sources: ['subject.py'], lcov: 'configured.info', coverageCommand: command }));
  return { root, command };
}

function cli(root, argumentsList) {
  return spawnSync(process.execPath, [path.join(pluginRoot, 'bin/quality-gate.js'), 'crap', '--project', root, '--json', ...argumentsList], { encoding: 'utf8', timeout: 60000, env: process.env });
}

test('settings preserve explicit LCOV separately from configured fallback', () => {
  const configured = gateSettings({}, { lcov: 'configured.info' });
  assert.equal(configured.lcov, undefined);
  assert.equal(configured.fallbackLcov, 'configured.info');
  const explicit = gateSettings({ lcov: 'explicit.info' }, { lcov: 'configured.info' });
  assert.equal(explicit.lcov, 'explicit.info');
  assert.equal(explicit.fallbackLcov, 'configured.info');
});

test('fresh isolated command LCOV wins over an existing configured file', coverageRequired, async (context) => {
  const { root } = await project(context);
  const previous = await fs.readFile(path.join(root, 'configured.info'), 'utf8');
  const report = await crapReport({ project: root });
  assert.equal(report.exitCode, 0);
  assert.equal(report.changedMetrics[0].coverage, 1, 'the isolated capture executed subject');
  assert.deepEqual(report.files, sourceHashes(root, ['subject.py']));
  assert.equal(await fs.readFile(path.join(root, 'configured.info'), 'utf8'), previous, 'the configured capture stays untouched');
});

test('explicit CLI LCOV wins over fresh isolated and configured output', coverageRequired, async (context) => {
  const { root } = await project(context);
  await captures(root, [{ path: 'isolated', run: true }, { path: 'explicit.info', run: false }]);
  const execution = cli(root, ['--lcov', 'explicit.info']);
  assert.equal(execution.status, 0, execution.stderr);
  assert.equal(JSON.parse(execution.stdout).changedMetrics[0].coverage, 0, 'explicit capture did not execute subject');
});

test('configured LCOV remains the no-command fallback with authentic hashes', coverageRequired, async (context) => {
  const { root } = await project(context);
  const report = await crapReport({ project: root, coverageCommand: '' });
  assert.equal(report.exitCode, 0);
  assert.equal(report.changedMetrics[0].coverage, 0);
  await fs.writeFile(path.join(root, 'configured.info.sources.json'), '{}');
  const untrusted = await crapReport({ project: root, coverageCommand: '' });
  assert.equal(untrusted.exitCode, 2);
  assert.match(untrusted.unverified[0].unverified, /source hash is missing or differs/);
});

test('fresh rewritten configured output remains a compatible command fallback', coverageRequired, async (context) => {
  const { root } = await project(context);
  await captures(root, [{ path: 'configured.info', run: true }]);
  const report = await crapReport({ project: root });
  assert.equal(report.exitCode, 0);
  assert.equal(report.changedMetrics[0].coverage, 1);
});

test('missing isolated output refuses a stale configured fallback', coverageRequired, async (context) => {
  const { root } = await project(context);
  await captures(root, []);
  const execution = cli(root, []);
  assert.equal(execution.status, 2, execution.stderr);
  assert.match(JSON.parse(execution.stdout).unverified[0].unverified, /did not rewrite .*configured\.info/);
});

test('missing command output stays unverified when configured output is absent', coverageRequired, async (context) => {
  const { root } = await project(context);
  await fs.rm(path.join(root, 'configured.info'));
  await captures(root, []);
  const execution = cli(root, []);
  assert.equal(execution.status, 2, execution.stderr);
  assert.match(JSON.parse(execution.stdout).unverified[0].unverified, /did not rewrite .*configured\.info/);
});

test('an invalid isolated report never selects valid configured coverage', coverageRequired, async (context) => {
  const { root, command } = await project(context);
  const corrupt = `${JSON.stringify(process.execPath)} -e "require('node:fs').writeFileSync(process.env.QUALITY_GATE_COVERAGE_DIR+'/lcov.info','SF:subject.py\\nDA:bad,1\\n');"`;
  const execution = cli(root, ['--coverage-command', `${command} && ${corrupt}`]);
  assert.equal(execution.status, 2, execution.stderr);
  assert.match(JSON.parse(execution.stdout).unverified[0].unverified, /Invalid LCOV DA record/);
});

test('stale explicit override refuses fresh isolated output until rewritten', coverageRequired, async (context) => {
  const { root } = await project(context);
  const execution = cli(root, ['--lcov', 'configured.info']);
  assert.equal(execution.status, 2, execution.stderr);
  assert.match(JSON.parse(execution.stdout).unverified[0].unverified, /did not rewrite .*configured\.info/);
});

test('CLI help explains LCOV override, fallback and rewrite requirements', () => {
  const execution = cli(pluginRoot, ['--help']);
  assert.equal(execution.status, 0);
  assert.match(execution.stdout, /--lcov overrides both isolated command output and config lcov/);
  assert.match(execution.stdout, /Config lcov is a fallback/);
  assert.match(execution.stdout, /must be rewritten/);
});
