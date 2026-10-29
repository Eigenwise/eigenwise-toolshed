import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runProcessVerification } = require('../lib/ports/process.js');
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reportsDirectory = path.resolve(process.env.QUALITY_GATE_COVERAGE_DIR || path.join(pluginRoot, 'coverage'));
const testFiles = process.argv.slice(2);
process.argv.push('--sourcemap=external');
await import('./build.mjs');
fs.mkdirSync(reportsDirectory, { recursive: true });
const argumentsList = [process.execPath, '--import', 'tsx', '--import', './test/_sidequest-test-home.ts', '--test', `--test-concurrency=${process.env.COVERAGE_LCOV_CONCURRENCY || 2}`, '--test-timeout=120000', '--experimental-test-coverage', '--test-coverage-include=lib/**', '--test-coverage-include=hooks/**', '--test-coverage-include=bin/**', '--test-reporter=lcov', '--test-reporter-destination=' + path.join(reportsDirectory, 'lcov.info'), '--test-reporter=spec', '--test-reporter-destination=stdout', ...testFiles];
const command = argumentsList.map((argument) => JSON.stringify(argument)).join(' ');
const childEnvironment = { ...process.env };
delete childEnvironment.NODE_TEST_CONTEXT;
const result = runProcessVerification({ kind: 'command', command, evidenceContract: 'LCOV producer suites' }, {
  cwd: pluginRoot,
  environment: childEnvironment,
  timeoutMilliseconds: Number(process.env.COVERAGE_LCOV_TIMEOUT_MS) || 300000,
  logPath: path.join(reportsDirectory, 'coverage-tests.log'),
});
if (result.status !== 'passed') {
  process.stderr.write(result.evidence + '\nDetails: ' + path.join(reportsDirectory, 'coverage-tests.log') + '\n');
  process.exitCode = 1;
}
