'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');
const { appendDecision, projectStateFile, readProjectState, recordSessionTally, statusFor, verifyDecisions } = require('../lib/state.js');

function fixture(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'quartermaster-tally-worktrees-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const project = path.join(directory, 'project');
  const linked = path.join(directory, 'linked');
  fs.mkdirSync(project);
  const git = (argumentsList) => execFileSync('git', ['-C', project, ...argumentsList], { stdio: 'pipe', windowsHide: true });
  git(['init']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture']);
  git(['worktree', 'add', '--detach', linked]);
  return { directory, project, linked, environment: { ...process.env, CLAUDE_PROJECT_DIR: '', CLAUDE_CONFIG_DIR: path.join(directory, 'config'), QUARTERMASTER_STATE_DIR: path.join(directory, 'state'), QUARTERMASTER_MIN_SESSIONS: '1' } };
}

function runSessionEnd(setup, sessionId, prompts) {
  const transcript = path.join(setup.directory, `${sessionId}.jsonl`);
  const rows = Array.from({ length: prompts }, () => JSON.stringify({ type: 'user', cwd: setup.linked, message: { role: 'user', content: 'no, use the existing form' } }));
  fs.writeFileSync(transcript, rows.join('\n'));
  execFileSync(process.execPath, [path.resolve(__dirname, '../hooks/session-end-tally.js')], {
    cwd: setup.linked, env: setup.environment, windowsHide: true,
    input: JSON.stringify({ cwd: setup.linked, session_id: sessionId, transcript_path: transcript }),
  });
}

test('SessionEnd worktree tallies share the main key and drive status, verify, and cooldowns', (context) => {
  const setup = fixture(context);
  runSessionEnd(setup, 'human-session', 2);
  assert.equal(projectStateFile(setup.linked, setup.environment), projectStateFile(setup.project, setup.environment));
  const status = statusFor(setup.project, setup.environment);
  assert.equal(status.trackedSessions, 1);
  assert.equal(status.worktreeSessions, 1);
  assert.equal(status.shouldNudge, true);
  assert.equal(status.shouldOffer, true);
  const { markNudged, markOffered } = require('../lib/state.js');
  markNudged(setup.linked, setup.environment);
  markOffered(setup.linked, 'offer-session', setup.environment);
  assert.equal(statusFor(setup.project, setup.environment).shouldNudge, false);
  assert.equal(statusFor(setup.project, setup.environment).shouldOffer, false);
  const report = JSON.parse(execFileSync(process.execPath, [path.resolve(__dirname, '../bin/quartermaster.js'), 'verify', '--project', setup.project], { env: setup.environment, encoding: 'utf8', windowsHide: true }));
  assert.equal(report.window.worktreeSessions, 1);
  assert.equal(report.window.sessions, 1);
  assert.deepEqual(report.decisions, []);
});

test('legacy worktree tallies merge on read without rewriting and verify improvement', (context) => {
  const setup = fixture(context);
  const now = Date.now();
  const sessions = Array.from({ length: 3 }, (_, index) => ({ sessionId: `before-${index}`, endedAt: new Date(now - 10000 + index).toISOString(), tally: { prompts: 2, denials: 4 } }));
  sessions.push({ sessionId: 'executor', endedAt: new Date(now).toISOString(), tally: { prompts: 1, denials: 20 } });
  const canonicalLinked = fs.realpathSync.native(setup.linked).replace(/\\/g, '/');
  const oldIdentity = process.platform === 'win32' ? canonicalLinked.toLowerCase() : canonicalLinked;
  const oldKey = crypto.createHash('sha256').update(oldIdentity).digest('hex').slice(0, 16);
  const legacyFile = path.join(setup.environment.QUARTERMASTER_STATE_DIR, 'projects', `${oldKey}.json`);
  fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
  const original = JSON.stringify({ projectDir: setup.linked, sessions });
  fs.writeFileSync(legacyFile, original);
  appendDecision({ title: 'reduce denials', status: 'applied', projectDir: setup.linked, signal: 'denials' }, setup.environment, now - 5000);
  assert.equal(readProjectState(setup.project, setup.environment).sessions.length, 3);
  assert.equal(fs.existsSync(projectStateFile(setup.project, setup.environment)), false, 'read does not create canonical storage');
  for (let index = 0; index < 3; index += 1) recordSessionTally(setup.project, `after-${index}`, { prompts: 2, denials: 0 }, setup.environment, now + index);
  const verdict = verifyDecisions(setup.project, setup.environment)[0];
  assert.equal(verdict.verdict, 'improved');
  assert.equal(verdict.sessionsBefore, 3);
  assert.equal(verdict.sessionsAfter, 3);
  assert.equal(readProjectState(setup.linked, setup.environment).sessions.length, 6, 'copied sessions are deduplicated on subsequent reads');
  assert.equal(statusFor(setup.project, setup.environment).worktreeSessions, 3);
  assert.equal(fs.readFileSync(legacyFile, 'utf8'), original);
});

test('SessionEnd excludes single-prompt executor worktree sessions', (context) => {
  const setup = fixture(context);
  runSessionEnd(setup, 'agent-session', 1);
  assert.equal(readProjectState(setup.linked, setup.environment).sessions.length, 0);
  assert.equal(statusFor(setup.project, setup.environment).trackedSessions, 0);
});
