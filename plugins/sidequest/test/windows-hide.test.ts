import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

interface ChildProcessCall {
  hidden: boolean;
}

const { inspectPlugin, inspectSource, unhiddenCalls } = require('../../test-support/windows-hide.js') as {
  inspectPlugin(root: string): ChildProcessCall[];
  inspectSource(source: string, file: string): ChildProcessCall[];
  unhiddenCalls(calls: ChildProcessCall[]): ChildProcessCall[];
};

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
