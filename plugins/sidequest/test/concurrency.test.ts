import './_temp-cleanup.js';
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

export {};
