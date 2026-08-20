'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { checkCi, parseArgs } = require('../bin/check-ci.js');

function commandRunner(workflowResponses, overrides = {}) {
  let workflowCall = 0;
  return (command) => {
    if (command.command === 'gh' && command.args[0] === 'auth') return overrides.authentication ?? { status: 0, stdout: 'Logged in' };
    if (command.command === 'gh' && command.args[0] === 'repo') return overrides.repository ?? { status: 0, stdout: '{"nameWithOwner":"Eigenwise/eigenwise-toolshed"}' };
    if (command.command === 'git') return overrides.sha ?? { status: 0, stdout: 'abc123\n' };
    if (command.command === 'gh' && command.args[0] === 'run') {
      const response = workflowResponses[Math.min(workflowCall, workflowResponses.length - 1)];
      workflowCall += 1;
      return response;
    }
    throw new Error(`Unexpected command: ${command.command} ${command.args.join(' ')}`);
  };
}

function workflowRun({ conclusion = null, name = 'Test', status = 'completed', url = 'https://github.test/runs/1' } = {}) {
  return { status: 0, stdout: JSON.stringify([{ conclusion, status, workflowName: name, url }]) };
}

function clock() {
  let milliseconds = 0;
  return {
    now: () => milliseconds,
    wait: (duration) => { milliseconds += duration; return Promise.resolve(); },
  };
}

test('fails when no workflow run was ever observed', async () => {
  const output = [];
  const time = clock();
  const result = await checkCi({
    options: { sha: 'HEAD', timeoutSeconds: 2, intervalSeconds: 1 },
    report: (message) => output.push(message),
    run: commandRunner([{ status: 0, stdout: '[]' }]),
    now: time.now,
    wait: time.wait,
  });

  assert.equal(result.ok, false);
  assert.equal(output.at(-1), 'no workflow runs found for abc123 after 2s');
});

test('passes only after a workflow run completes successfully', async () => {
  const output = [];
  const time = clock();
  const result = await checkCi({
    options: { timeoutSeconds: 2, intervalSeconds: 1 },
    report: (message) => output.push(message),
    run: commandRunner([
      workflowRun({ status: 'in_progress', conclusion: null, name: 'Test' }),
      workflowRun({ status: 'completed', conclusion: 'success', name: 'Test' }),
    ]),
    now: time.now,
    wait: time.wait,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(output, ['waiting (1): Test', 'CI passed for abc123: Test']);
});

test('names failed workflows and their URLs', async () => {
  const output = [];
  const result = await checkCi({
    report: (message) => output.push(message),
    run: commandRunner([workflowRun({ conclusion: 'failure', name: 'Release guard', url: 'https://github.test/runs/42' })]),
  });

  assert.equal(result.ok, false);
  assert.deepEqual(output, [
    'CI failed for abc123:',
    '- Release guard (failure): https://github.test/runs/42',
  ]);
});

test('reports unauthenticated gh separately', async () => {
  await assert.rejects(
    checkCi({
      run: commandRunner([], { authentication: { status: 1, stderr: 'not logged in' } }),
    }),
    /gh is not authenticated/,
  );
});

test('reports a missing GitHub remote separately', async () => {
  await assert.rejects(
    checkCi({
      run: commandRunner([], { repository: { status: 1, stderr: 'no GitHub remote' } }),
    }),
    /does not have a GitHub remote/,
  );
});

test('reports the timeout bound after observing unfinished workflows', async () => {
  const output = [];
  const time = clock();
  const result = await checkCi({
    options: { timeoutSeconds: 2, intervalSeconds: 1 },
    report: (message) => output.push(message),
    run: commandRunner([workflowRun({ status: 'in_progress', conclusion: null })]),
    now: time.now,
    wait: time.wait,
  });

  assert.equal(result.ok, false);
  assert.equal(output.at(-1), 'timed out waiting for workflow runs for abc123 after 2s (bound: 2s)');
});

test('uses HEAD by default and validates timing options', () => {
  assert.deepEqual(parseArgs([]), { intervalSeconds: 10, sha: 'HEAD', timeoutSeconds: 600 });
  assert.deepEqual(parseArgs(['deadbeef', '--timeout', '30', '--interval', '2']), {
    intervalSeconds: 2,
    sha: 'deadbeef',
    timeoutSeconds: 30,
  });
  assert.throws(() => parseArgs(['--timeout', '0']), /positive whole number/);
});
