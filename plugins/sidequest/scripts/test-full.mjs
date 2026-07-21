import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testDirectory = path.join(pluginRoot, 'test');
const performanceTest = path.join(testDirectory, 'hooks.perf.test.ts');
const testFiles = (await fs.readdir(testDirectory))
  .filter((name) => name.endsWith('.test.ts'))
  .map((name) => path.join(testDirectory, name))
  .filter((file) => file !== performanceTest);

function runTests(files) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...files], {
    cwd: pluginRoot,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

runTests(testFiles);
runTests([performanceTest]);
