import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { measureFiles } from '../lib/measure.mjs';

const entry = fileURLToPath(new URL('../bin/quality-gate.js', import.meta.url));

function git(root, argumentsList) {
  const result = spawnSync('git', argumentsList, { cwd: root, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
}

function callback(title, complexity, returned = 'value') {
  return `test(${JSON.stringify(title)}, (value) => {\n${'if (value) value--;\n'.repeat(complexity - 1)}return ${returned};\n});\n`;
}

async function fixture(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'quality-callback-pairing-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'subject.mjs'), callback('existing', 8));
  git(root, ['init', '-q']);
  git(root, ['add', '.']);
  git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline']);
  const coverageDirectory = path.join(root, 'coverage');
  await fs.mkdir(coverageDirectory);
  assert.deepEqual(await fs.readdir(coverageDirectory), []);
  return { root, coverageDirectory };
}

for (const [scenario, oldCallback, expected, exitCode] of [
  ['unchanged', callback('existing', 8), [], 0],
  ['modified', callback('existing', 8, '0'), [[8, 'legacy-unchanged', 'call-site']], 0],
  ['raised', callback('existing', 9), [[9, 'modified-raised', 'call-site']], 1],
  ['genuinely new', callback('existing', 8) + callback('fresh', 8), [[8, 'new', null]], 1],
]) {
  test(`anonymous callback ${scenario} keeps its baseline after two test insertions`, async (context) => {
    const { root, coverageDirectory } = await fixture(context);
    const inserted = callback('first', 3) + callback('second', 3);
    await fs.writeFile(path.join(root, 'subject.mjs'), inserted + oldCallback);
    const execution = spawnSync(process.execPath, [entry, 'crap', '--project', root, '--base', 'HEAD~0', '--cc-only', '--json'], {
      cwd: root, encoding: 'utf8', timeout: 60000,
    });
    assert.equal(execution.status, exitCode, execution.stderr + execution.stdout);
    const crap = JSON.parse(execution.stdout);
    const measured = await measureFiles(['subject.mjs'], { projectRoot: root, base: 'HEAD', coverageDirectory });
    const rows = (report) => report.changedMetrics.map((metric) => [metric.complexity, metric.classification, metric.matchedBy]);
    assert.deepEqual(rows(crap), [[3, 'new', null], [3, 'new', null], ...expected]);
    assert.deepEqual(rows(measured), rows(crap));
    assert.equal(measured.failures.length, exitCode);
  });
}

test('named function edits retain positional pairing and report its rule', async (context) => {
  const { root, coverageDirectory } = await fixture(context);
  await fs.writeFile(path.join(root, 'subject.mjs'), 'function named(value) { return value; }\n');
  git(root, ['add', '.']);
  git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'named baseline']);
  await fs.writeFile(path.join(root, 'subject.mjs'), 'function named(value) { return value + 1; }\n');
  const report = await measureFiles(['subject.mjs'], { projectRoot: root, base: 'HEAD', coverageDirectory });
  assert.equal(report.changedMetrics[0].classification, 'legacy-unchanged');
  assert.equal(report.changedMetrics[0].matchedBy, 'position');
});
