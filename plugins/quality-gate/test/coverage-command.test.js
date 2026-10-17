import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { gateSettings } from '../lib/crap-inputs.mjs';
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

test('a POSIX-style coverage command reaches spawn with its coverage directory already expanded on any platform (GH-543)', (context) => {
  const root = project(context);
  const spawned = [];
  context.mock.method(childProcess, 'spawnSync', (command, options) => {
    spawned.push({ command, directory: options.env.QUALITY_GATE_COVERAGE_DIR });
    fs.writeFileSync(path.join(options.env.QUALITY_GATE_COVERAGE_DIR, 'lcov.info'), commandReport);
    return { status: 0 };
  });
  syncBuiltinESMExports();
  try {
    const coverage = acquireCoverage(root, { coverageCommand: 'c8 --reports-dir "$QUALITY_GATE_COVERAGE_DIR" --temp ${QUARTERMASTER_COVERAGE_DIR}/raw npm test' }, ['subject.js']);
    assert.equal(coverage.text, commandReport);
  } finally {
    context.mock.restoreAll();
    syncBuiltinESMExports();
  }
  const [{ command, directory }] = spawned;
  assert.equal(command, `c8 --reports-dir "${directory}" --temp ${directory}/raw npm test`);
});

test('a real shell runs a $VAR coverage command against the isolated directory, on Windows too (GH-543)', (context) => {
  const root = project(context);
  const coverage = acquireCoverage(root, { coverageCommand: `${writeReportInto} "$QUALITY_GATE_COVERAGE_DIR"` }, ['subject.js']);
  assert.equal(coverage.text, commandReport);
  assert.deepEqual(fs.readdirSync(root), ['subject.js'], 'no literal $QUALITY_GATE_COVERAGE_DIR folder is created');
});

test('with both config lcov and coverageCommand set, the report the command wrote is the one scored (GH-519)', (context) => {
  const root = project(context);
  fs.writeFileSync(path.join(root, 'configured.info'), 'SF:subject.js\nDA:1,0\nend_of_record\n');
  const settings = gateSettings({}, { lcov: 'configured.info', coverageCommand: `${writeReportInto} "\${QUARTERMASTER_COVERAGE_DIR}"` });
  assert.equal(acquireCoverage(root, settings, ['subject.js']).text, commandReport);
});
