import './_temp-cleanup.js';
import './_sidequest-install-fixture.js';
import './_hook-runtime.js';
import assert from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-compaction-policy-test-'));
process.env.SIDEQUEST_HOME = HOME;

const store = require('../lib/store.js');
const boardPath = path.join(HOME, 'board');
fs.mkdirSync(boardPath, { recursive: true });
execFileSync('git', ['init', '--quiet'], { cwd: boardPath, windowsHide: true });
const { slug } = store.ensureProject(boardPath);
const hookPath = path.join(__dirname, '..', 'hooks', 'compaction-policy.js');

function run(payload: unknown, env: Record<string, string> = {}) {
  const inheritedEnv = { ...process.env };
  delete inheritedEnv.SIDEQUEST_COMPACTION_POLICY;
  return spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...inheritedEnv, ...env },
  });
}

function compactionDecision(output: string): unknown {
  try {
    return JSON.parse(output).decision;
  } catch {
    return undefined;
  }
}

function createDoing(title: string, sessionId?: string): { ticket: any; story: any } {
  const story = store.createStory(slug, { title: 'Compaction policy story' });
  const ticket = store.createTicket(slug, { title, storyId: story.ref, source: 'test' });
  assert.equal(store.claimTicket(slug, ticket.ref, 'policy-executor', sessionId ? { sessionId } : undefined).ok, true);
  return { ticket, story };
}

test('PreCompact pinning preserves active board identifiers within its prompt budget', () => {
  const { ticket, story } = createDoing('Keep this active ticket intact');
  const result = run({ hook_event_name: 'PreCompact', trigger: 'auto', cwd: boardPath, session_id: 'pinning-shape' });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.ok(Buffer.byteLength(result.stdout, 'utf8') <= 1500);
  assert.match(result.stdout, /^Preserve verbatim in the summary:/);
  assert.match(result.stdout, new RegExp(ticket.ref));
  assert.match(result.stdout, /Keep this active ticket intact/);
  assert.match(result.stdout, /policy-executor/);
  assert.match(result.stdout, new RegExp(story.ref));
  assert.match(result.stdout, /Compaction policy story/);
});

test('PreCompact pinning stays within the prompt budget for crowded boards', () => {
  for (let index = 0; index < 12; index += 1) createDoing(`Crowded active ticket ${index}: ${'detail '.repeat(60)}`);
  const result = run({ hook_event_name: 'PreCompact', trigger: 'auto', cwd: boardPath, session_id: 'pinning-budget' });

  assert.equal(result.status, 0);
  assert.ok(Buffer.byteLength(result.stdout, 'utf8') <= 1500);
  assert.match(result.stdout, /^Preserve verbatim in the summary:/);
});

test('PreCompact veto allows an executor session to compact', () => {
  const sessionId = 'executor-session';
  createDoing('Executor claim permits compaction', sessionId);
  const result = run({ hook_event_name: 'PreCompact', trigger: 'auto', cwd: boardPath, session_id: sessionId }, { SIDEQUEST_COMPACTION_POLICY: 'veto' });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /^Preserve verbatim in the summary:/);
  assert.equal(compactionDecision(result.stdout), undefined);
});

test('PreCompact veto emits bounded JSON before falling back to pinning', () => {
  const { ticket } = createDoing('Veto while this claim is fresh');
  const payload = { hook_event_name: 'PreCompact', trigger: 'auto', cwd: boardPath, session_id: 'bounded-veto' };
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const result = run(payload, { SIDEQUEST_COMPACTION_POLICY: 'veto' });
    assert.equal(result.status, 0);
    assert.ok(Buffer.byteLength(result.stdout, 'utf8') <= 1500);
    assert.equal(compactionDecision(result.stdout), 'block');
    assert.match(JSON.parse(result.stdout).reason, new RegExp(ticket.ref));
  }

  const delayed = run(payload, { SIDEQUEST_COMPACTION_POLICY: 'veto' });
  assert.equal(delayed.status, 0);
  assert.match(delayed.stdout, /^Preserve verbatim in the summary:/);
  assert.ok(!delayed.stdout.includes('"decision":"block"'));
});

test('PreCompact ignores manual compaction', () => {
  const result = run({ hook_event_name: 'PreCompact', trigger: 'manual', cwd: boardPath, session_id: 'manual-compaction' }, { SIDEQUEST_COMPACTION_POLICY: 'veto' });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('PreCompact off stays silent and a board read failure stays non-blocking', () => {
  const payload = { hook_event_name: 'PreCompact', trigger: 'auto', cwd: boardPath, session_id: 'no-op' };
  const off = run(payload, { SIDEQUEST_COMPACTION_POLICY: 'off' });
  assert.equal(off.status, 0);
  assert.equal(off.stdout, '');

  const unavailable = run(payload, { CLAUDE_PLUGIN_ROOT: path.join(HOME, 'missing-plugin-root') });
  assert.equal(unavailable.status, 0);
  assert.equal(unavailable.stdout, '');
  assert.match(unavailable.stderr, /could not read board state/);
});

test('PreCompact registers without a matcher', () => {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'hooks', 'hooks.json'), 'utf8'));
  assert.deepEqual(config.hooks.PreCompact, [{
    hooks: [{
      type: 'command',
      command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/compaction-policy.js"',
      timeout: 10,
    }],
  }]);
});
