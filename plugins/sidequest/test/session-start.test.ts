import { sweepWorktrees } from '../src/hooks/shared/worktree-sweep.js';
import { readSweepProgress, deferralNotice } from '../src/hooks/shared/sweep-handoff.js';
import type { SweepProgress } from '../src/hooks/shared/sweep-handoff.js';
import './_temp-cleanup.js';
import './_sidequest-install-fixture.js';
import './_hook-runtime.js';
'use strict';

// GH-467. /clear starts a new session id while the board server keeps the one it started with, so a
// dispatch from that server carried the old id and the isolation guard then refused the executor as if
// it had wandered off. The guard now names the stale session instead of blaming the executor.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const store = require('../lib/store.js');

const GUARD_ISOLATION = path.join(__dirname, '..', 'hooks', 'guard-worktree-isolation.js');

function initRepo() {
  const repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-session-clear-')));
  const git = (args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true });
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'Sidequest Test']);
  git(['config', 'user.email', 'sidequest-test@example.invalid']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'session clear fixture\n');
  git(['add', '.']);
  git(['commit', '-m', 'base']);
  const linked = path.join(fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-session-clear-linked-'))), 'checkout');
  git(['worktree', 'add', '-b', 'executor', linked]);
  return { repo, linked };
}

function guardDecision(sessionId: string, linked: string) {
  const out = execFileSync(process.execPath, [GUARD_ISOLATION], {
    input: JSON.stringify({
      session_id: sessionId,
      agent_id: 'cleared-executor',
      agent_type: 'sidequest-exec-high',
      cwd: linked,
      tool_name: 'Write',
      tool_input: { file_path: path.join(linked, 'README.md'), content: 'edit\n' },
    }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: linked },
    windowsHide: true,
  });
  return out.trim() ? JSON.parse(out).hookSpecificOutput : null;
}

test('SessionStart aggregates preparing progress and its reason before classification', async () => {
  const { repo } = initRepo();
  store.ensureProject(repo);
  const worktrees = require('../lib/worktrees.js');
  const originalSweep = worktrees.sweep;
  const snapshots: SweepProgress[] = [];
  worktrees.sweep = async (_repo: string, _tickets: unknown[], options: { onProgress: (progress: unknown) => void }) => {
    for (const reason of ['recovery_retention', 'listing_candidates']) {
      options.onProgress({ phase: 'preparing', reason, candidates: 0, observed: 0, current: null, planned: 0, removed: 0, keptByReason: {} });
      snapshots.push(readSweepProgress(repo));
    }
    return { entries: [] };
  };
  try {
    await sweepWorktrees({ cwd: repo }, false);
    assert.equal(snapshots.length, 2, 'both early sweep reports reach the hook aggregator');
    assert.deepEqual(snapshots.map(({ phase, reason }) => ({ phase, reason })), [
      { phase: 'preparing', reason: 'recovery_retention' },
      { phase: 'preparing', reason: 'listing_candidates' },
    ], 'preparing reports retain their phase and reason through aggregation');
    assert.match(deferralNotice(repo, snapshots[1]!), /Preparing \(listing_candidates\)\./);
    assert.equal(snapshots[1]!.observed, 0, 'preparation does not count as candidate classification');
  } finally {
    worktrees.sweep = originalSweep;
  }
});

test('GH-467: an unmatched executor is told the dispatch carries an older session id only when live dispatches exist', () => {
  const { repo, linked } = initRepo();
  const { slug } = store.ensureProject(repo);
  store.setCategory({ id: 'session-clear', name: 'Session clear', route: { model: 'sonnet', effort: 'high' } });

  const before = guardDecision('session-after-clear', linked);
  assert.equal(before.permissionDecision, 'deny');
  assert.match(before.permissionDecisionReason, /This isolated worktree matches no dispatch record/);

  const ticket = store.createTicket(slug, { title: 'dispatched before clear', category: 'session-clear', description: 'Fixture.', files: ['README.md'] });
  const prepared = store.prepareDispatch(slug, ticket.ref, { sharedTree: false, sessionId: 'session-before-clear' });
  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
    token: prepared.token, executor: prepared.ticket.dispatchExecutor, sessionId: 'session-before-clear', agentName: 'cleared-executor',
  }).ok, true);

  const after = guardDecision('session-after-clear', linked);
  assert.equal(after.permissionDecision, 'deny');
  assert.match(after.permissionDecisionReason, /No live dispatch record carries this session id\. The dispatch was likely recorded under an older one \(a board server started before \/clear\), not an executor fault\./);
  assert.match(after.permissionDecisionReason, /dispatch records: live 1, session 0/);
});
