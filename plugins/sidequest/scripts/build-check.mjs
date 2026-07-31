import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildResult = spawnSync(process.execPath, [path.join(pluginRoot, 'scripts', 'build.mjs')], {
  cwd: pluginRoot,
  stdio: 'inherit',
  windowsHide: true,
});

if (buildResult.error) throw buildResult.error;
if (buildResult.status !== 0) process.exit(buildResult.status ?? 1);

const statusResult = spawnSync('git', ['status', '--porcelain', '--untracked-files=all', '--', 'bin', 'lib', 'hooks'], {
  cwd: pluginRoot,
  encoding: 'utf8',
  windowsHide: true,
});

if (statusResult.error) throw statusResult.error;
if (statusResult.status !== 0) process.exit(statusResult.status ?? 1);
if (statusResult.stdout) {
  const paths = statusResult.stdout
    .trimEnd()
    .split('\n')
    .map((entry) => entry.slice(3));
  process.stderr.write(`Generated outputs differ from the repository:\n${paths.join('\n')}\n`);
  process.exitCode = 1;
}
