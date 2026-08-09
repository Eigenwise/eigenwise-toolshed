import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceDirectory = path.join(pluginRoot, 'src', 'lib');

async function sourceEntries(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const nestedEntries = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceEntries(entryPath);
    return entry.isFile() && entry.name.endsWith('.ts') ? [entryPath] : [];
  }));
  return nestedEntries.flat().sort();
}

const entryPoints = await sourceEntries(sourceDirectory);
if (entryPoints.length > 0) {
  await build({
    entryPoints,
    outdir: path.join(pluginRoot, 'lib'),
    outbase: sourceDirectory,
    bundle: false,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    charset: 'utf8',
    legalComments: 'none',
    sourcemap: false,
  });
}
