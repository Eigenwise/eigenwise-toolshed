import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const nonBundledBuildDirectories = ['lib', 'bin'];
export const bundledBuildOutputs = [{
  sourceDirectory: 'src/hooks',
  outputDirectory: 'hooks',
  sourceExtension: '.ts',
  outputExtension: '.js',
}];

// Only lib and bin mirror nested sources into output. Hook entry points stay top-level:
// src/hooks/shared/* are bundled into each hook, and emitting them would flatten distinct
// nested paths onto colliding basenames in hooks/.
async function sourceEntries(directory, { recursive = true } = {}) {
  const absolute = path.join(pluginRoot, 'src', directory);
  async function collectEntries(root) {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const collected = await Promise.all(entries.map(async (entry) => {
      const entryPath = path.join(root, entry.name);
      if (entry.isDirectory()) return recursive ? collectEntries(entryPath) : [];
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
  for (const { sourceDirectory, outputDirectory, outputExtension } of bundledBuildOutputs) {
    const entryPoints = await sourceEntries(sourceDirectory.replace(/^src\//, ''), { recursive: false });
    for (const entryPoint of entryPoints) {
      await build({
        entryPoints: [entryPoint],
        outfile: path.join(pluginRoot, outputDirectory, `${path.basename(entryPoint, '.ts')}${outputExtension}`),
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
}

for (const directory of nonBundledBuildDirectories) {
  await buildNonBundled(directory, directory === 'bin' ? '#!/usr/bin/env node' : undefined);
}
await buildHooks();
