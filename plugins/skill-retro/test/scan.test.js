'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const { describeWindow, resolveWindow, slugForProject } = require('../lib/scan.js');
const { createTranscript, makeRoot } = require('./helpers/transcripts.js');

test('a project path becomes its transcript directory name', () => {
  assert.equal(slugForProject('C:\\dev\\eigenwise-public\\eigenwise-toolshed'), 'C--dev-eigenwise-public-eigenwise-toolshed');
  assert.equal(slugForProject('/home/kenny/dev/app'), '-home-kenny-dev-app');
  assert.equal(slugForProject('C:\\dev\\repo\\.claude\\worktrees\\x'), 'C--dev-repo--claude-worktrees-x');
});

function seed(root, slug, count, { now }) {
  for (let index = 0; index < count; index += 1) {
    const sessionId = `session-${index}`;
    createTranscript({ root, slug, sessionId }).prompt('hi').write();
    const file = path.join(root, slug, `${sessionId}.jsonl`);
    const age = now - index * 3600000;
    fs.utimesSync(file, new Date(age), new Date(age));
  }
}

test('the session cap wins when a day range holds more sessions than it', () => {
  const root = makeRoot();
  const now = Date.now();
  seed(root, 'proj', 9, { now });

  const window = resolveWindow({ root, slug: 'proj', days: 7, sessions: 5, now });
  assert.equal(window.sessionsAvailable, 9);
  assert.equal(window.sessionsScanned, 5);
  assert.equal(window.skippedSessions, 4);
  assert.equal(window.boundBy, 'sessions');
  assert.match(describeWindow(window), /capped at 5 sessions \(4 older ones/);
});

test('the day cutoff wins when it is the tighter limit', () => {
  const root = makeRoot();
  const now = Date.now();
  seed(root, 'proj', 4, { now });
  const stale = path.join(root, 'proj', 'session-0.jsonl');
  const old = now - 30 * 86400000;
  fs.utimesSync(stale, new Date(old), new Date(old));

  const window = resolveWindow({ root, slug: 'proj', days: 7, sessions: 5, now });
  assert.equal(window.sessionsScanned, 3);
  assert.equal(window.boundBy, 'days');
  assert.equal(window.skippedSessions, 0);
});

test('subagent transcripts and their metadata are discovered under the session directory', () => {
  const root = makeRoot();
  const now = Date.now();
  createTranscript({ root, slug: 'proj', sessionId: 'main-1' }).prompt('go').write();
  createTranscript({
    root,
    slug: 'proj',
    sessionId: 'main-1',
    agent: { id: 'agent-a1', type: 'sidequest-exec-dispatch-high', model: 'claude-codex-auto' },
  }).tool('Bash', { command: 'npm ci' }).write();

  const window = resolveWindow({ root, slug: 'proj', days: 7, sessions: 5, now });
  assert.equal(window.sessionsScanned, 1);
  assert.equal(window.subagentsScanned, 1);
  const [subagent] = window.sessions[0].subagents;
  assert.equal(subagent.agentType, 'sidequest-exec-dispatch-high');
  assert.equal(subagent.model, 'claude-codex-auto');
  assert.equal(subagent.scope, 'subagent');
});

test('subagents can be excluded, since they are usually the larger half', () => {
  const root = makeRoot();
  createTranscript({ root, slug: 'proj', sessionId: 'main-1' }).prompt('go').write();
  createTranscript({ root, slug: 'proj', sessionId: 'main-1', agent: { id: 'agent-a1', type: 'Explore' } })
    .tool('Read', { file_path: '/x' })
    .write();

  const window = resolveWindow({ root, slug: 'proj', days: 7, sessions: 5, includeSubagents: false, now: Date.now() });
  assert.equal(window.subagentsScanned, 0);
  assert.equal(window.files.length, 1);
});

test('an empty window is reported honestly rather than as a clean result', () => {
  const root = makeRoot();
  const window = resolveWindow({ root, slug: 'nothing-here', days: 7, sessions: 5, now: Date.now() });
  assert.equal(window.sessionsScanned, 0);
  assert.match(describeWindow(window), /No transcripts found/);
});
