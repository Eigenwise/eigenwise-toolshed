import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as measurement from '../lib/measure.mjs';
import { measureFiles, gateVerdict } from '../lib/measure.mjs';

const entry = fileURLToPath(new URL('../bin/quality-gate.js', import.meta.url));

function git(root, argumentsList) {
  const result = spawnSync('git', argumentsList, { cwd: root, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function source(complexity) {
  return `export function subject(value) {\n${'if (value) value--;\n'.repeat(complexity - 1)}return value;\n}\n`;
}

async function fixture(context, baseline = '') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'quality-measure-floor-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'project');
  const coverageDirectory = path.join(directory, 'coverage');
  await fs.mkdir(root);
  await fs.mkdir(coverageDirectory);
  assert.deepEqual(await fs.readdir(coverageDirectory), []);
  git(root, ['init', '-q']);
  await fs.writeFile(path.join(root, 'subject.mjs'), baseline);
  git(root, ['add', '.']);
  git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline']);
  return { root, directory, coverageDirectory, head: git(root, ['rev-parse', 'HEAD']) };
}

for (const [classification, baseline] of [['new', ''], ['modified-raised', source(2)]]) {
  for (const complexity of [5, 6, 7]) {
    test(`measure ${classification} cc-${complexity} preserves unverified coverage and enforces the floor`, async (context) => {
      const setup = await fixture(context, baseline);
      await fs.writeFile(path.join(setup.root, 'subject.mjs'), source(complexity));
      const report = await measureFiles(['subject.mjs'], { projectRoot: setup.root, base: 'HEAD', coverageDirectory: setup.coverageDirectory });
      assert.equal(report.changedMetrics[0].classification, classification);
      assert.equal(report.changedMetrics[0].complexity, complexity);
      assert.match(report.changedMetrics[0].unverified, /no suite loaded/);
      assert.equal(report.changedMetrics[0].coverage, undefined);
      assert.equal(report.unverified.length, 1);
      assert.equal(report.failures.length, Number(complexity >= 6));
      assert.equal(report.failures.some((row) => row.includes('failure: complexity floor') && row.includes('coverage=UNVERIFIED')), complexity >= 6);
    });
  }
}

test('measure equal complexity legacy body remains informational with unverified coverage', async (context) => {
  const setup = await fixture(context, source(7));
  await fs.writeFile(path.join(setup.root, 'subject.mjs'), source(7).replace('return value;', 'return 0;'));
  const report = await measureFiles(['subject.mjs'], { projectRoot: setup.root, base: 'HEAD', coverageDirectory: setup.coverageDirectory });
  assert.equal(report.changedMetrics[0].classification, 'legacy-unchanged');
  assert.deepEqual(report.failures, []);
  assert.deepEqual(report.unverified, []);
});

for (const command of ['crap', 'measure']) {
  for (const selection of ['flag', 'environment']) {
    test(`${command} redirects receipts through ${selection} without writing project receipts`, async (context) => {
      const setup = await fixture(context);
      await fs.writeFile(path.join(setup.root, 'subject.mjs'), source(5));
      const receipts = path.join(setup.directory, 'receipts');
      const ignored = path.join(setup.directory, 'ignored');
      const argumentsList = ['--project', setup.root, '--base', setup.head];
      const commandArguments = { crap: ['--cc-only', '--json'], measure: ['--coverage', setup.coverageDirectory, 'subject.mjs'] };
      const redirectArguments = { flag: ['--receipts-dir', receipts], environment: [] };
      argumentsList.push(...commandArguments[command], ...redirectArguments[selection]);
      const execution = spawnSync(process.execPath, [entry, command, ...argumentsList], {
        cwd: setup.directory, encoding: 'utf8', timeout: 60000,
        env: { ...process.env, QUALITY_GATE_RECEIPTS_DIR: selection === 'flag' ? ignored : receipts },
      });
      assert.equal(execution.status, Number(command === 'measure'), execution.stderr);
      const report = JSON.parse(execution.stdout);
      assert.equal(report.receipt, path.join(receipts, setup.head + '.json'));
      const receipt = JSON.parse(await fs.readFile(report.receipt, 'utf8'));
      assert.equal(receipt.head, setup.head);
      assert.equal(receipt.verdict, command === 'measure' ? 'unverified' : 'passed');
      assert.equal(receipt.files['subject.mjs'].length, 64);
      await assert.rejects(fs.access(path.join(setup.root, '.claude/quality-gate/receipts')), { code: 'ENOENT' });
      await assert.rejects(fs.access(ignored), { code: 'ENOENT' });
    });
  }
}

for (const [complexity, exitCode, boundVerdict, verdict, unresolved, failures] of [
  [1, 0, 'pass', 'passed', 0, 0],
  [2, 1, undefined, 'unverified', 1, 0],
  [3, 1, undefined, 'unverified', 1, 0],
  [6, 1, undefined, 'failed', 1, 1],
]) {
  test(`GH-628 measure cc-${complexity} resolves only coverage-independent verdicts`, async (context) => {
    const setup = await fixture(context);
    await fs.writeFile(path.join(setup.root, 'subject.mjs'), source(complexity));
    const execution = spawnSync(process.execPath, [entry, 'measure', '--project', setup.root, '--base', setup.head, '--coverage', setup.coverageDirectory, '--receipts-dir', path.join(setup.directory, 'receipts'), 'subject.mjs'], {
      cwd: setup.directory, encoding: 'utf8', timeout: 60000,
    });
    assert.equal(execution.status, exitCode, execution.stderr);
    const report = JSON.parse(execution.stdout);
    const metric = report.changedMetrics[0];
    assert.equal(metric.complexity, complexity);
    assert.match(metric.unverified, /no suite loaded/);
    assert.equal(metric.coverage, undefined);
    assert.equal(metric.crap, undefined);
    assert.equal(metric.boundVerdict, boundVerdict);
    assert.equal(report.unverified.length, unresolved);
    assert.equal(report.failures.length, failures);
    const receipt = JSON.parse(await fs.readFile(report.receipt, 'utf8'));
    assert.equal(receipt.verdict, verdict);
  });
}

test('GH-628 bound passes preserve independent branch obligations and reject unknown complexity', () => {
  assert.equal(typeof measurement.withCoverageBound, 'function');
  const { withCoverageBound } = measurement;
  const metric = { complexity: 1, classification: 'new', unverified: 'coverage missing', relativePath: 'subject.mjs', line: 1, name: 'subject' };
  assert.equal(withCoverageBound(metric).boundVerdict, 'pass');
  for (const complexity of [null, undefined, NaN, 0, -1, 2, 6]) {
    assert.equal(withCoverageBound({ ...metric, complexity }).boundVerdict, undefined);
  }
  assert.equal(withCoverageBound({ ...metric, informational: true }).boundVerdict, undefined);
  const branch = { line: 1, text: 'condition', untaken: [], unverified: 'branch missing' };
  assert.equal(gateVerdict([{ ...metric, branches: [branch] }]).unverified.length, 1);
  assert.equal(gateVerdict([{ ...metric, unverified: undefined, coverage: 1, crap: 1, branches: [{ ...branch, unverified: undefined, untaken: ['false'] }] }]).failures.length, 1);
});
