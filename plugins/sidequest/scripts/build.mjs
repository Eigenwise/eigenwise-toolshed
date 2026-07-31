import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function sourceEntries(directory) {
  const absolute = path.join(pluginRoot, 'src', directory);
  async function collectEntries(root) {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const collected = await Promise.all(entries.map(async (entry) => {
      const entryPath = path.join(root, entry.name);
      if (entry.isDirectory()) return collectEntries(entryPath);
      return entry.isFile() && entry.name.endsWith('.ts') ? [entryPath] : [];
    }));
    return collected.flat();
  }
  try {
    return (await collectEntries(absolute)).sort();
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
}

async function buildNonBundled(directory, banner) {
  const entryPoints = await sourceEntries(directory);
  if (!entryPoints.length) return;
  await build({
    entryPoints,
    outdir: path.join(pluginRoot, directory),
    outbase: path.join(pluginRoot, 'src', directory),
    bundle: false,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    charset: 'utf8',
    legalComments: 'none',
    sourcemap: false,
    banner: banner ? { js: banner } : undefined,
  });
}

async function buildHooks() {
  const entryPoints = await sourceEntries('hooks');
  for (const entryPoint of entryPoints) {
    await build({
      entryPoints: [entryPoint],
      outfile: path.join(pluginRoot, 'hooks', `${path.basename(entryPoint, '.ts')}.js`),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      charset: 'utf8',
      legalComments: 'none',
      sourcemap: false,
      external: ['node:*'],
    });
  }
}

await buildNonBundled('lib');
await buildNonBundled('bin', '#!/usr/bin/env node');
await buildHooks();
