import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { gateSettings, readConfig } from '../lib/crap-inputs.mjs';
import { acquireCoverage, expandCommandVariables } from '../lib/lcov.mjs';

const commandReport = 'SF:subject.js\nDA:1,1\nend_of_record\n';
const writeReportInto = `${JSON.stringify(process.execPath)} -e "require('fs').writeFileSync(process.argv[1] + '/lcov.info', 'SF:subject.js\\nDA:1,1\\nend_of_record\\n')"`;

function project(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-gate-coverage-command-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'subject.js'), 'export const one = 1;\n');
  return root;
}

test('$VAR, ${VAR} and %VAR% expand from the child environment, and an unset name stays literal', () => {
  const env = { QUALITY_GATE_COVERAGE_DIR: 'C:\\temp\\run', HOME: '/home/user' };
  assert.equal(
    expandCommandVariables('a $QUALITY_GATE_COVERAGE_DIR b ${HOME}/x c %QUALITY_GATE_COVERAGE_DIR%\\lcov.info d $NOT_SET %ALSO_NOT_SET% e $1', env),
    'a C:\\temp\\run b /home/user/x c C:\\temp\\run\\lcov.info d $NOT_SET %ALSO_NOT_SET% e $1',
  );
});

test('a POSIX-style coverage command reaches spawn with its coverage directory already expanded on any platform (GH-543)', async (context) => {
  const root = project(context);
  const command = coverageScript(root, "require('node:assert/strict').equal(process.argv[2], process.env.QUALITY_GATE_COVERAGE_DIR); require('node:fs').writeFileSync(process.argv[2] + '/lcov.info', " + JSON.stringify(commandReport) + ');');
  const coverage = await acquireCoverage(root, { coverageCommand: command + ' "$QUALITY_GATE_COVERAGE_DIR"' }, ['subject.js']);
  assert.equal(coverage.text, commandReport);
});

test('a real shell runs a $VAR coverage command against the isolated directory, on Windows too (GH-543)', async (context) => {
  const root = project(context);
  const coverage = await acquireCoverage(root, { coverageCommand: `${writeReportInto} "$QUALITY_GATE_COVERAGE_DIR"` }, ['subject.js']);
  assert.equal(coverage.text, commandReport);
  assert.deepEqual(fs.readdirSync(root), ['subject.js'], 'no literal $QUALITY_GATE_COVERAGE_DIR folder is created');
});

test('with both config lcov and coverageCommand set, the report the command wrote is the one scored (GH-519)', async (context) => {
  const root = project(context);
  fs.writeFileSync(path.join(root, 'configured.info'), 'SF:subject.js\nDA:1,0\nend_of_record\n');
  const settings = gateSettings({}, { lcov: 'configured.info', coverageCommand: `${writeReportInto} "\${QUARTERMASTER_COVERAGE_DIR}"` });
  assert.equal((await acquireCoverage(root, settings, ['subject.js'])).text, commandReport);
});

function coverageScript(root, source) {
  const script = path.join(root, 'capture.cjs');
  fs.writeFileSync(script, source);
  return JSON.stringify(process.execPath) + ' ' + JSON.stringify(script.replaceAll('\\', '/'));
}

test('coverage timeout settings default to unlimited and CLI overrides config', () => {
  assert.equal(gateSettings({}, {}).coverageTimeoutMs, 0);
  assert.equal(gateSettings({}, { coverageTimeoutMs: 300000 }).coverageTimeoutMs, 300000);
  assert.equal(gateSettings({ coverageTimeoutMs: '0' }, { coverageTimeoutMs: 1 }).coverageTimeoutMs, 0);
  assert.equal(gateSettings({ coverageTimeoutMs: '123' }, {}).coverageTimeoutMs, 123);
  for (const value of [-1, 1.5, NaN, Infinity, 2147483648, 'abc', '']) {
    assert.throws(() => gateSettings({ coverageTimeoutMs: value }, {}), /coverageTimeoutMs.*coverage-timeout-ms/);
  }
});

test('both current and legacy config accept numeric coverageTimeoutMs and reject invalid types', (context) => {
  const root = project(context);
  for (const owner of ['quartermaster', 'quality-gate']) {
    const directory = path.join(root, '.claude', owner);
    fs.mkdirSync(directory, { recursive: true });
    const config = path.join(directory, 'crap.json');
    fs.writeFileSync(config, JSON.stringify({ coverageTimeoutMs: 123 }));
    assert.equal(gateSettings({}, readConfig(root).config).coverageTimeoutMs, 123);
    fs.writeFileSync(config, JSON.stringify({ coverageTimeoutMs: '123' }));
    assert.throws(() => readConfig(root), /coverageTimeoutMs/);
  }
});

test('a configured timeout names the duration, setting and flag', async (context) => {
  const root = project(context);
  const command = coverageScript(root, 'setTimeout(() => {}, 2000);');
  await assert.rejects(async () => acquireCoverage(root, gateSettings({}, { coverageCommand: command, coverageTimeoutMs: 50 }), ['subject.js']), /ran out of time after 50 ms.*coverageTimeoutMs.*--coverage-timeout-ms/);
});

test('without a timeout a sleeping command completes and captures fresh LCOV', async (context) => {
  const root = project(context);
  const command = coverageScript(root, "setTimeout(() => require('node:fs').writeFileSync(process.env.QUALITY_GATE_COVERAGE_DIR + '/lcov.info', " + JSON.stringify(commandReport) + '), 150);');
  const coverage = await acquireCoverage(root, gateSettings({}, { coverageCommand: command }), ['subject.js']);
  assert.equal(coverage.text, commandReport);
});

function processRunning(identifier) {
  try { process.kill(identifier, 0); } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
  if (process.platform === 'linux') return !fs.readFileSync('/proc/' + identifier + '/stat', 'utf8').split(') ')[1].startsWith('Z');
  return true;
}

test('timeout kills the coverage shell, child and grandchild before returning', async (context) => {
  const root = project(context);
  const grandchild = path.join(root, 'grandchild.cjs');
  fs.writeFileSync(grandchild, "require('node:fs').writeFileSync('grandchild.pid', String(process.pid)); setTimeout(() => {}, 5000);");
  const command = coverageScript(root, "require('node:fs').writeFileSync('child.pid', String(process.pid)); require('node:fs').writeFileSync('shell.pid', String(process.ppid)); require('node:child_process').spawn(process.execPath, ['grandchild.cjs'], {stdio:'inherit'}); setTimeout(() => {}, 5000);");
  await assert.rejects(async () => acquireCoverage(root, { coverageCommand: command, coverageTimeoutMs: 1500 }, ['subject.js']), /ran out of time after 1500 ms/);
  for (const name of ['shell.pid', 'child.pid', 'grandchild.pid']) {
    const identifier = Number(fs.readFileSync(path.join(root, name), 'utf8'));
    assert.equal(processRunning(identifier), false, name + ' must be dead when capture rejects');
  }
});

function cli(root, argumentsList) {
  return childProcess.spawnSync(process.execPath, [fileURLToPath(new URL('../bin/quality-gate.js', import.meta.url)), 'crap', '--project', root, '--json', ...argumentsList], { encoding: 'utf8', timeout: 30000 });
}

test('CLI timeout flag overrides config and help documents unlimited coverage commands', (context) => {
  const root = project(context);
  fs.writeFileSync(path.join(root, 'subject.js'), 'export function one() { return 1; }\n');
  const command = coverageScript(root, "setTimeout(() => require('node:fs').writeFileSync(process.env.QUALITY_GATE_COVERAGE_DIR + '/lcov.info', " + JSON.stringify(commandReport) + '), 150);');
  const directory = path.join(root, '.claude/quality-gate');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'crap.json'), JSON.stringify({ sources: ['subject.js'], coverageCommand: command, coverageTimeoutMs: 50 }));
  const timedOut = cli(root, []);
  assert.equal(timedOut.status, 2, timedOut.stderr);
  assert.match(JSON.parse(timedOut.stdout).unverified[0].unverified, /ran out of time after 50 ms.*coverageTimeoutMs.*--coverage-timeout-ms/);
  const unlimited = cli(root, ['--coverage-timeout-ms', '0']);
  assert.equal(unlimited.status, 0, unlimited.stderr + unlimited.stdout);
  const overridden = cli(root, ['--coverage-timeout-ms', '25']);
  assert.equal(overridden.status, 2, overridden.stderr);
  assert.match(JSON.parse(overridden.stdout).unverified[0].unverified, /ran out of time after 25 ms/);
  const invalid = cli(root, ['--coverage-timeout-ms=-1']);
  assert.equal(invalid.status, 2);
  assert.match(JSON.parse(invalid.stdout).unverified[0].unverified, /must be an integer/);
  const help = cli(root, ['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--coverage-timeout-ms.*coverageTimeoutMs/);
  assert.match(help.stdout, /Default 0 means no limit/);
});
