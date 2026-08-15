import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { runOwnedPhase } = require('./owned-process-tree.js');

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectories = ['bin', 'lib', 'hooks'];
// build:check runs inside `npm run test:full`, and esbuild builds behind its own service
// child, so an unbounded spawn here is a full-gate phase that can hang with nobody able to
// end it. Every child the gate starts gets an owner and a deadline.
const buildPhaseTimeoutMilliseconds = 300_000;

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
  for (const directory of outputDirectories) collect(path.join(pluginRoot, directory));
  return hashes;
}

function changedOutputs(before, after) {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((file) => before.get(file) !== after.get(file))
    .sort();
}

const beforeBuild = outputHashes();
const buildResult = await runOwnedPhase({
  command: process.execPath,
  args: [path.join(pluginRoot, 'scripts', 'build.mjs')],
  cwd: pluginRoot,
  timeoutMilliseconds: buildPhaseTimeoutMilliseconds,
});

if (buildResult.error) throw buildResult.error;
if (buildResult.timedOut) {
  process.stderr.write(`The build exceeded its ${buildPhaseTimeoutMilliseconds}ms budget and was terminated.\n`);
  process.exitCode = 1;
} else if (buildResult.cleanupError) {
  process.stderr.write(`${buildResult.cleanupError}\n`);
  process.exitCode = 1;
} else if (buildResult.status !== 0) {
  process.exitCode = buildResult.status ?? 1;
} else {
  const changed = changedOutputs(beforeBuild, outputHashes());
  if (changed.length) {
    process.stderr.write(`Generated outputs changed during the build:\n${changed.join('\n')}\n`);
    process.exitCode = 1;
  }
}
