import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function generatedPaths(directory) {
  const sourceDirectory = path.join(pluginRoot, 'src', directory);
  try {
    const entries = await fs.readdir(sourceDirectory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
      .map((entry) => path.join(directory, `${path.basename(entry.name, '.ts')}.js`));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
}

const paths = [
  ...await generatedPaths('lib'),
  ...await generatedPaths('bin'),
  ...await generatedPaths('hooks'),
].sort();

if (!paths.length) process.exit(0);
const result = spawnSync('git', ['diff', '--exit-code', '--', ...paths], {
  cwd: pluginRoot,
  stdio: 'inherit',
  windowsHide: true,
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
