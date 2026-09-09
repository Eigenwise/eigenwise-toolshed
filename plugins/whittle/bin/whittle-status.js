#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { activeMode, formatStatusline } = require('../hooks/lib/runtime');

function argument(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? '' : process.argv[index + 1] || '';
}

const project = argument('--project') || process.cwd();
const session = argument('--session');
const mode = activeMode({ project_directory: path.resolve(project), session_id: session });

if (process.argv.includes('--statusline')) process.stdout.write(formatStatusline(mode) + '\n');
else process.stdout.write(mode + '\n');
