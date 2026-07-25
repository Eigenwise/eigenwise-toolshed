'use strict';

const path = require('node:path');
const rules = require('../hooks/lib/rules');

function projectDirectory(args) {
  const index = args.indexOf('--project');
  if (index === -1) return process.cwd();
  if (!args[index + 1]) throw new Error('--project needs a directory path.');
  return path.resolve(args[index + 1]);
}

try {
  const projectDir = projectDirectory(process.argv.slice(2));
  const manifest = rules.syncAtomicRuleSet(projectDir);
  process.stdout.write(`Synced ${manifest.rules.length} live rule(s) from disk.\n`);
} catch (error) {
  process.stderr.write(`live-rules sync failed: ${error.message}\n`);
  process.exitCode = 1;
}
