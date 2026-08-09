import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = path.join(pluginRoot, 'lib');

function outputHashes() {
  const hashes = new Map();
  function collect(directory) {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) collect(entryPath);
      if (entry.isFile()) {
        hashes.set(path.relative(pluginRoot, entryPath), createHash('sha256').update(fs.readFileSync(entryPath)).digest('hex'));
      }
    }
  }
  collect(outputDirectory);
  return hashes;
}

function changedOutputs(beforeBuild, afterBuild) {
  return [...new Set([...beforeBuild.keys(), ...afterBuild.keys()])]
    .filter((file) => beforeBuild.get(file) !== afterBuild.get(file))
    .sort();
}

const beforeBuild = outputHashes();
const buildResult = spawnSync(process.execPath, [path.join(pluginRoot, 'scripts', 'build.mjs')], {
  cwd: pluginRoot,
  stdio: 'inherit',
  windowsHide: true,
});

if (buildResult.error) throw buildResult.error;
if (buildResult.status !== 0) process.exit(buildResult.status ?? 1);

const changed = changedOutputs(beforeBuild, outputHashes());
if (changed.length > 0) {
  process.stderr.write(`Generated outputs changed during the build:\n${changed.join('\n')}\n`);
  process.exitCode = 1;
}
