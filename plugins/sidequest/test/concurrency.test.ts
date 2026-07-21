'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-concurrency-test-'));
const PROJECT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-concurrency-project-'));
const BIN = path.join(__dirname, '..', 'bin', 'sidequest.js');
const WORKER_COUNT = 12;

function runCli(args?: any, extraEnv?: any) {
  const env = Object.assign({}, process.env, {
    SIDEQUEST_HOME,
    CLAUDE_PROJECT_DIR: PROJECT_DIR,
  }, extraEnv);
  return new Promise<any>((resolve?: any) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: PROJECT_DIR,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk?: any) => { stdout += chunk; });
    child.stderr.on('data', (chunk?: any) => { stderr += chunk; });
    child.on('close', (status?: any, signal?: any) => resolve({ status, signal, stdout, stderr }));
  });
}

function parseJson(result?: any, label?: any): any {
  assert.ok(result.stdout.trim(), `${label} produced no JSON\nstderr: ${result.stderr}`);
  try {
    return JSON.parse(result.stdout);
  } catch (error: any) {
    assert.fail(`${label} produced invalid JSON: ${error.message}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  }
}

async function addTicket(index?: any) {
  const result = await runCli([
    'add',
    '-t', `parallel ticket ${index}`,
    '--complexity', '1',
    '--why', 'concurrent subprocess fixture for SQLite writer safety',
    '--label', 'direct-ok',
    '--json',
  ]);
  assert.strictEqual(result.status, 0, `add ${index} failed\n${result.stderr}\n${result.stdout}`);
  return parseJson(result, `add ${index}`);
}

async function claimTicket(ref?: any, by?: any, extraEnv?: any) {
  const result = await runCli(['claim', ref, '--by', by, '--direct', '--reason', 'The concurrency fixture requires parallel local claims.', '--json'], extraEnv);
  return { result, payload: parseJson(result, `claim ${by}`) };
}

async function claimDuringWriteContention(ref?: any, index?: any) {
  const extraEnv = { SIDEQUEST_TEST_CLAIM_LOCK_DELAY_MS: '400' };
  return Promise.all([
    claimTicket(ref, `claim-contention-${index}-a`, extraEnv),
    claimTicket(ref, `claim-contention-${index}-b`, extraEnv),
  ]);
}

test('concurrent CLI writers keep sequential refs and claim exactly once', async () => {
  const initialized = await runCli(['list', '--json']);
  assert.strictEqual(initialized.status, 0, `board initialization failed\\n${initialized.stderr}\\n${initialized.stdout}`);

  const added = await Promise.all(Array.from({ length: WORKER_COUNT }, (_?: any, index?: any) => addTicket(index)));

  assert.strictEqual(added.length, WORKER_COUNT);
  assert.ok(added.every((entry?: any) => entry.ok === true), 'every add must report ok:true');

  const listed = await runCli(['list', '--json']);
  assert.strictEqual(listed.status, 0, `list failed\n${listed.stderr}\n${listed.stdout}`);
  const board = parseJson(listed, 'list');
  assert.strictEqual(board.tickets.length, WORKER_COUNT, 'parallel adds must not lose tickets');

  const refs = board.tickets.map((ticket?: any) => ticket.ref);
  assert.strictEqual(new Set(refs).size, WORKER_COUNT, 'parallel adds must not duplicate refs');
  assert.deepStrictEqual(
    refs.map((ref?: any) => Number.parseInt(ref.replace(/^SQ-/, ''), 10)).sort((a?: any, b?: any) => a - b),
    Array.from({ length: WORKER_COUNT }, (_?: any, index?: any) => index + 1),
    'parallel refs must be sequential',
  );

  const claims = await Promise.all([claimTicket('SQ-1', 'claim-race-a'), claimTicket('SQ-1', 'claim-race-b')]);
  const winners = claims.filter(({ payload }: any) => payload.ok === true);
  const losers = claims.filter(({ payload }: any) => payload.ok !== true);
  assert.strictEqual(winners.length, 1, 'exactly one concurrent claimant must win');
  assert.strictEqual(losers.length, 1, 'exactly one concurrent claimant must lose');
  assert.strictEqual(losers[0]!.payload.reason, 'claimed', 'loser must receive the not-claimable result');
});

test('concurrent CLI claim loser waits for a contended winner commit', async () => {
  for (let index = 0; index < 4; index += 1) {
    const target = await addTicket(`claim contention target ${index}`);
    const claims = await claimDuringWriteContention(target.ticket.ref, index);
    const winners = claims.filter(({ payload }: any) => payload.ok === true);
    const losers = claims.filter(({ payload }: any) => payload.ok !== true);
    assert.strictEqual(winners.length, 1, `round ${index} must have one claim winner`);
    assert.strictEqual(losers.length, 1, `round ${index} must have one claim loser`);
    assert.strictEqual(losers[0]!.payload.reason, 'claimed', `round ${index} loser must wait for the winner result`);
  }
});

test('concurrent done retries share one terminal comment', async () => {
  const target = await addTicket('done race target');
  const ref = target.ticket.ref;
  const by = 'done-race-worker';
  const body = 'Concurrent close evidence: `node --test` passed.';
  const claimed = await claimTicket(ref, by);
  assert.strictEqual(claimed.payload.ok, true);

  const calls = await Promise.all([
    runCli(['done', ref, '--by', by, '--body', body, '--json']),
    runCli(['done', ref, '--by', by, '--body', body, '--json']),
  ]);
  assert.ok(calls.every((result?: any) => result.status === 0), `done race failed: ${calls.map((result?: any) => result.stderr).join('\n')}`);
  const completions = calls.map((result?: any, index?: any) => parseJson(result, `done race ${index}`));
  assert.strictEqual(completions.filter((result?: any) => result.idempotent === true).length, 1);
  assert.strictEqual(completions.filter((result?: any) => result.idempotent !== true).length, 1);

  const commentsResult = await runCli(['comments', ref, '--json']);
  assert.strictEqual(commentsResult.status, 0, commentsResult.stderr);
  const comments = parseJson(commentsResult, 'done race comments').comments;
  assert.strictEqual(comments.filter((comment?: any) => comment.body === body && comment.by === by).length, 1);
});

export {};
