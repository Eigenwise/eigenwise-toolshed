#!/usr/bin/env node
'use strict';

const { commands, usage } = require('../lib/commands.js');

const cmd = process.argv[2];

if (require.main === module) {
  Promise.resolve(commands[cmd]?.()).then(() => {
    if (commands[cmd]) return;
    console.log(usage);
    process.exit(cmd ? 1 : 0);
  }).catch((error) => {
    console.error('model-gateway: ' + error.message);
    process.exit(1);
  });
}

module.exports = require('../lib/commands.js');
