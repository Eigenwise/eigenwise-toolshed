'use strict';
/** Regression coverage for SQ-213 native-only routed work. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const work = require('../lib/work.js');

test('routed work has no Claude-process launcher', () => {
  const source = fs.readFileSync(path.join(ROOT, 'lib', 'work.js'), 'utf8');
  assert.doesNotMatch(source, /require\(['"]child_process['"]\)/);
  assert.doesNotMatch(source, /\bclaude\b\s*-p/);
  assert.doesNotMatch(source, /\bspawn\s*\(/);
});

test('CLI work path is disabled rather than spawning a separate process', () => {
  const source = fs.readFileSync(path.join(ROOT, 'bin', 'sidequest.js'), 'utf8');
  const start = source.indexOf('async function cmdWork');
  const end = source.indexOf('\n// Release every claim', start);
  const cmdWork = source.slice(start, end);
  assert.match(cmdWork, /is disabled/);
  assert.doesNotMatch(cmdWork, /dispatchTicket|runWork|planWork|spawn\s*\(/);
});

test('work module directs routed execution to native_agent and Agent', () => {
  const source = fs.readFileSync(path.join(ROOT, 'lib', 'work.js'), 'utf8');
  assert.match(source, /native_agent/);
  assert.match(source, /Agent tool/);
  assert.deepStrictEqual(Object.keys(work), ['nativeDispatchRequired']);
});
