#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { refreshSessionProbes } = require('./session-start-freshness.js');

function main() {
  process.stdout.write(`${JSON.stringify({ async: true, asyncTimeout: 15_000 })}\n`);
  const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  refreshSessionProbes(input);
}

if (require.main === module) {
  try {
    main();
  } catch {
    // Cached health is advisory; a failed refresh leaves the previous observation intact.
  }
}

module.exports = { main };
