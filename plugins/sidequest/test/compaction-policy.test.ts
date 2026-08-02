import './_temp-cleanup.js';
import './_sidequest-install-fixture.js';
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

function createDoing(title: string): { ticket: any; story: any } {
  const story = store.createStory(slug, { title: 'Compaction policy story' });
  const ticket = store.createTicket(slug, { title, storyId: story.ref, source: 'test' });
  // Claims went with the orchestration strip; a tracker moves status directly, and
  // updateTicket returns the updated ticket rather than an {ok} result.
  assert.equal(store.updateTicket(slug, ticket.ref, { status: 'doing' }).status, 'doing');
  return { ticket, story };
}

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

// 4.1.0 briefly injected a "not a stopping point" instruction here and 4.1.2 reverted it:
// countering a Claude Code summarization behavior with prompt text was unmeasured. This
// pins the hook to board state only, so it does not creep back without a decision.
test('PreCompact pins board state and nothing else', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'hooks', 'shared', 'compaction-policy.ts'), 'utf8');
  const body = source.replace(/^\/\/.*$/gm, '');
  assert.doesNotMatch(body, /Summarization is how this session continues|never as a handoff/);
});

test('the Stop-hook suggestion never reads as permission to finish', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'hooks', 'shared', 'compaction.ts'), 'utf8');
  assert.match(source, /compaction checkpoint, not a stopping point/);
  assert.match(source, /Keep working; summarization is how a long session continues/);
  // The strip removed dispatch and submissions; the message outlived them.
  for (const dead of [/dispatch chatter/, /pending submission/]) {
    assert.doesNotMatch(source, dead, 'compaction message still carries orchestration vocabulary');
  }
});

// The strip left createDoing orphaned, so nothing covered the pin path it exists for.
test('PreCompact pins doing tickets into the summary', () => {
  const { ticket } = createDoing('Pinned through compaction');
  const out = run({ hook_event_name: 'PreCompact', trigger: 'auto', cwd: boardPath, session_id: 'pin' }).stdout;
  assert.match(out, /Preserve verbatim in the summary:/);
  assert.ok(out.includes(ticket.ref), `expected ${ticket.ref} in the pin block`);
  assert.ok(out.includes('Pinned through compaction'), 'expected the ticket title in the pin block');
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
