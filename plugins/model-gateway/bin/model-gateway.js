#!/usr/bin/env node
'use strict';

async function runCommand(command) {
  if (command === 'readiness-gate') return require('../lib/readiness-gate.js').readinessGate();
  const { commands, usage } = require('../lib/commands.js');
  if (commands[command]) return commands[command]();
  console.log(usage);
  process.exitCode = command ? 1 : 0;
}

if (require.main === module) {
  runCommand(process.argv[2]).catch((error) => {
    console.error('model-gateway: ' + error.message);
    process.exitCode = 1;
  });
} else {
  module.exports = require('../lib/commands.js');
}
