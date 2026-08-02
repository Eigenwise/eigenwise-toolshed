'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { inspectPlugin, inspectSource, unhiddenCalls } = require('../../test-support/windows-hide.js');

const pluginRoot = path.join(__dirname, '..');

test('production child processes hide Windows command windows', () => {
  const calls = inspectPlugin(pluginRoot);
  assert.ok(calls.length > 0, 'expected at least one child_process call site');
  assert.deepEqual(unhiddenCalls(calls), []);
});

test('window visibility lint catches an unhidden child process fixture', () => {
  const calls = inspectSource("const cp = require('node:child_process');\ncp.spawn('command', []);", 'fixture.js');
  assert.equal(unhiddenCalls(calls).length, 1);
});
