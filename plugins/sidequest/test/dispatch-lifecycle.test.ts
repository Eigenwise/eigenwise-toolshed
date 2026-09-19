import './_temp-cleanup.js';
import './_gateway-catalog-freshness.js';
import './_sidequest-install-fixture.js';
import './_hook-runtime.js';
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { creationGeneration } = require('./_creation-generation.js');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-dispatch-lifecycle-home-'));
const PROJECT = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-dispatch-lifecycle-project-'));
const DISCOVERY = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-dispatch-lifecycle-catalog-'));
fs.mkdirSync(path.join(DISCOVERY, 'model-gateway'), { recursive: true });
fs.writeFileSync(path.join(DISCOVERY, 'model-gateway', 'catalog.json'), JSON.stringify({
  schemaVersion: 3,
  updatedAt: new Date().toISOString(),
  source: 'model-gateway',
  codexReadiness: { ready: true, state: 'ready', message: 'Codex readiness confirms the local gateway is ready.' },
  models: [
    { slug: 'codex-gpt-5-6-sol', id: 'claude-gpt-5.6-sol[1m]', label: 'GPT-5.6 Sol' },
    { slug: 'codex-gpt-5-6-terra', id: 'claude-gpt-5.6-terra[1m]', label: 'GPT-5.6 Terra' },
  ],
}));
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;
process.env.SIDEQUEST_DISCOVERY_DIRS = DISCOVERY;
process.env.CLAUDE_PROJECT_DIR = PROJECT;
execFileSync('git', ['init', '--quiet', '-b', 'main'], { cwd: PROJECT });
execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: PROJECT });
execFileSync('git', ['config', 'user.name', 'Dispatch Lifecycle Test'], { cwd: PROJECT });
fs.writeFileSync(path.join(PROJECT, 'tracked.js'), 'module.exports = 1;\n');
execFileSync('git', ['add', 'tracked.js'], { cwd: PROJECT });
execFileSync('git', ['commit', '--quiet', '-m', 'seed fixture'], { cwd: PROJECT });

const store = require('../lib/store.js');
const worktrees = require('../lib/worktrees.js');
const worktreeLease = require('../lib/kernel/worktree.js');
const agentsync = require('../lib/agentsync.js');
const { claimRefusalMessage } = require('../lib/refusal-guidance.js');
const { checkSidequestInstall, servingSidequestInstall } = require('../lib/dispatch-preflight.js');
const { collectGitSubmissionFacts } = require('../lib/mcp-lifecycle.js');
const sourceRevisionCapability = require('../lib/source-revision-capability.js');
const database = require('../lib/db.js');
const FORCE_EXEC_BYPASS = path.join(__dirname, '..', 'hooks', 'force-exec-bypass.js');
const SUBAGENT_START = path.join(__dirname, '..', 'hooks', 'subagent-start.js');
const SUBAGENT_STOP = path.join(__dirname, '..', 'hooks', 'subagent-stop.js');
const slug = store.ensureProject(PROJECT).slug;

function markCheckoutInstance(worktree: string): void {
  const gitDirectoryValue = execFileSync('git', ['rev-parse', '--git-dir'], { cwd: worktree, encoding: 'utf8', windowsHide: true }).trim();
  const gitDirectory = path.isAbsolute(gitDirectoryValue) ? gitDirectoryValue : path.resolve(worktree, gitDirectoryValue);
  worktreeLease.createCheckoutInstanceMarker(gitDirectory);
}

store.setCategory({
  id: 'dispatch.lifecycle',
  name: 'Dispatch lifecycle',
  route: { model: 'sonnet', effort: 'high' },
  fallback: null,
  enabled: true,
});

for (const id of ['codebase-exploration', 'research', 'review-audit', 'spike-investigation', 'visual-review']) {
  store.setCategory({ id, name: id, route: { model: 'sonnet', effort: 'high' }, fallback: null, readonly: true, artifactRoots: id === 'codebase-exploration' ? ['.claude/.codebase-info'] : [], enabled: true });
}

// store.js captures its collaborators at load, so a probe swaps the collaborator's
// exports and reloads store.js against them. Only store.js is reloaded: every other
// module keeps the collaborator reference it already holds.
function withReloadedStore(modulePath: string, patch: (original: any) => any, run: (patchedStore: any) => any) {
  const storePath = require.resolve('../lib/store.js');
  const collaboratorPath = require.resolve(modulePath);
  const cachedStore = require.cache[storePath];
  const collaborator = require.cache[collaboratorPath];
  if (!collaborator) throw new Error(`${modulePath} is not loaded, so store.js cannot be reloaded against it`);
  const originalExports = collaborator.exports;
  collaborator.exports = { ...originalExports, ...patch(originalExports) };
  delete require.cache[storePath];
  try {
    return run(require(storePath));
  } finally {
    collaborator.exports = originalExports;
    delete require.cache[storePath];
    if (cachedStore) require.cache[storePath] = cachedStore;
  }
}

function withSnapshotRevision(snapshotRevision: any, run: any) {
  return withReloadedStore('../lib/source-revision-capability.js', (original: any) => ({
    filesystemSnapshotRevision: snapshotRevision(original.filesystemSnapshotRevision),
  }), run);
}

function independentProjectWrite(projectSlug: string, patch: any) {
  const writer = database.openDb(SIDEQUEST_HOME);
  const meta = database.getRow(writer, 'projects', projectSlug);
  database.putRow(writer, 'projects', { slug: projectSlug, data: { ...meta, ...patch } });
}

function independentTicketWrite(projectSlug: string, ticketId: string, patch: any) {
  const writer = database.openDb(SIDEQUEST_HOME);
  const stored = { ...database.getRow(writer, 'tickets', ticketId), ...patch };
  database.putRow(writer, 'tickets', {
    id: stored.id,
    project: projectSlug,
    ref: stored.ref,
    status: stored.status,
    archived: 0,
    ord: stored.order,
    claim_by: stored.claim && stored.claim.by ? stored.claim.by : null,
    data: stored,
  });
}

function snapshotProjectFixture(snapshotStore: any, label: string, title: string) {
  const projectDirectory = fs.mkdtempSync(path.join(os.tmpdir(), `sq-dispatch-${label}-`));
  fs.writeFileSync(path.join(projectDirectory, 'page.md'), `${label}\n`);
  const projectSlug = snapshotStore.ensureProject(projectDirectory).slug;
  const ticket = snapshotStore.createTicket(projectSlug, { title, category: 'dispatch.lifecycle', files: ['page.md'], source: 'test' });
  return { projectDirectory, projectSlug, ticket };
}

function createFixture(title?: any, category = 'dispatch.lifecycle') {
  return store.createTicket(slug, {
    title,
    category,
    files: ['tracked.js'],
    source: 'test',
  });
}

test('preparing a plugin ticket pins its resolved suite requirement', () => {
  const pluginDirectory = path.join(PROJECT, 'plugins', 'verification-fixture');
  fs.mkdirSync(pluginDirectory, { recursive: true });
  fs.writeFileSync(path.join(pluginDirectory, 'package.json'), JSON.stringify({ scripts: { 'test:full': 'node --test test/*.test.js' } }));
  execFileSync('git', ['add', 'plugins/verification-fixture/package.json'], { cwd: PROJECT, windowsHide: true });
  execFileSync('git', ['commit', '--quiet', '-m', 'add verification fixture'], { cwd: PROJECT, windowsHide: true });

  const ticket = store.createTicket(slug, {
    title: 'pin the verification fixture suite',
    category: 'dispatch.lifecycle',
    files: ['plugins/verification-fixture/src/check.ts'],
    executorVerifyKind: 'suite',
    source: 'test',
  });
  assert.equal(store.readMeta(slug).path, PROJECT);
  assert.deepEqual(ticket.files, ['plugins/verification-fixture/src/check.ts']);
  assert.deepEqual(require('../lib/suite-resolver.js').resolveSuite(PROJECT, { name: 'verification-fixture', dir: 'plugins/verification-fixture' }), {
    plugin: 'verification-fixture',
    cwd: 'plugins/verification-fixture',
    setup: 'npm ci',
    command: 'npm run test:full',
  });
  const prepared = store.prepareDispatch(slug, ticket.ref);
  assert.deepEqual(prepared.ticket.files, ['plugins/verification-fixture/src/check.ts']);
  const requirement = prepared.ticket.dispatch.verificationRequirement;

  assert.deepEqual(requirement, {
    kind: 'suite',
    suite: { name: 'verification-fixture', cwd: 'plugins/verification-fixture', setup: 'npm ci', command: 'npm run test:full' },
    command: 'cd plugins/verification-fixture && npm ci && npm run test:full',
    evidenceContract: 'suite verification-fixture output',
  });
  assert.deepEqual(prepared.ticket.dispatch.lifecycleAttempt.verificationRequirement, requirement);
  assert.deepEqual(prepared.ticket.lifecycleAttempt.verificationRequirement, requirement);
  assert.equal(store.releaseTicket(slug, ticket.ref, 'verification-fixture-cleanup', { status: 'todo', source: 'test', force: true }).ok, true);
});

test('preparing a ticket without a recorded verifier pins the legacy custom requirement', () => {
  const ticket = createFixture('no verifier requirement');
  const prepared = store.prepareDispatch(slug, ticket.ref);

  assert.deepEqual(prepared.ticket.dispatch.verificationRequirement, {
    kind: 'custom',
    evidenceContract: 'legacy project verifier was not recorded',
  });
  assert.equal(store.releaseTicket(slug, ticket.ref, 'no-verifier-cleanup', { status: 'todo', source: 'test', force: true }).ok, true);
});

test('preparing a non-Git ticket uses its persisted dispatch snapshot', () => {
  const snapshotProject = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-dispatch-filesystem-snapshot-'));
  fs.writeFileSync(path.join(snapshotProject, 'page.md'), 'snapshot fixture\n');
  const snapshotSlug = store.ensureProject(snapshotProject).slug;
  const ticket = store.createTicket(snapshotSlug, {
    title: 'prepare a filesystem snapshot dispatch', category: 'dispatch.lifecycle', files: ['page.md'], source: 'test',
  });

  const prepared = store.prepareDispatch(snapshotSlug, ticket.ref);
  const baseline = prepared.ticket.dispatch.lifecycleAttempt.baseline;
  const persistedSnapshots = store.readMeta(snapshotSlug).sourceRevisionSnapshots;

  assert.equal(baseline.purpose, 'dispatch');
  assert.equal(baseline.revision.source, 'filesystem-snapshot');
  assert.equal(baseline.revision.value, sourceRevisionCapability.filesystemSnapshotRevision(snapshotProject, baseline.revision.observedAt)?.value);
  assert.equal(persistedSnapshots.filter((snapshot: any) => snapshot.value === baseline.revision.value).length, 1);
});

for (const limit of [
  { bound: 'path cap', observed: 501, cap: 500, unit: 'paths' },
  { bound: 'byte cap', observed: 65, cap: 64, unit: 'bytes' },
  { bound: 'deadline', observed: 11, cap: 10, unit: 'ms' },
]) {
  test(`preparing a non-Git ticket reports a ${limit.bound} refusal`, () => {
    withSnapshotRevision(() => () => {
      throw new sourceRevisionCapability.FilesystemSnapshotLimitError(limit.bound, limit.observed, limit.cap);
    }, (snapshotStore: any) => {
      const { projectSlug, ticket } = snapshotProjectFixture(snapshotStore, `snapshot-${limit.bound}`, `refuse ${limit.bound}`);

      assert.throws(
        () => snapshotStore.prepareDispatch(projectSlug, ticket.ref),
        new RegExp(`${limit.bound} reached ${limit.observed} ${limit.unit}; cap ${limit.cap} ${limit.unit}`),
      );
    });
  });
}

test('preparing a Git ticket does not capture a filesystem snapshot', () => {
  withSnapshotRevision(() => () => {
    throw new Error('Git-backed dispatch must not capture a filesystem snapshot');
  }, (snapshotStore: any) => {
    const ticket = snapshotStore.createTicket(slug, {
      title: 'prepare a Git dispatch without a filesystem snapshot', category: 'dispatch.lifecycle', files: ['tracked.js'], source: 'test',
    });

    const prepared = snapshotStore.prepareDispatch(slug, ticket.ref);

    assert.equal(prepared.ticket.dispatch.lifecycleAttempt.baseline.revision.source, 'git');
    // This is the one snapshot test that needs the shared Git-backed project, so its prepared
    // dispatch would otherwise survive to the TTL sweep further down and expire alongside it.
    assert.equal(snapshotStore.releaseTicket(slug, ticket.ref, 'git-baseline-snapshot-cleanup', {
      status: 'todo', source: 'test', force: true,
    }).ok, true);
  });
});

test('preparing a non-Git ticket hashes once before persisting its dispatch snapshot', () => {
  let hashCount = 0;
  withSnapshotRevision((originalRevision: any) => (projectPath: string, observedAt: string) => {
    hashCount += 1;
    return originalRevision(projectPath, observedAt);
  }, (snapshotStore: any) => {
    const { projectSlug, ticket } = snapshotProjectFixture(snapshotStore, 'single-hash', 'hash one filesystem snapshot');

    const prepared = snapshotStore.prepareDispatch(projectSlug, ticket.ref);

    assert.equal(hashCount, 1, 'one dispatch capture performs one filesystem hash');
    assert.equal(snapshotStore.readMeta(projectSlug).sourceRevisionSnapshots.filter((snapshot: any) => snapshot.value === prepared.ticket.dispatch.lifecycleAttempt.baseline.revision.value).length, 1);
  });
});

test('a launched non-Git dispatch refuses without capturing a replacement snapshot', () => {
  const snapshotProject = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-dispatch-launched-snapshot-'));
  fs.writeFileSync(path.join(snapshotProject, 'page.md'), 'before launch\n');
  const snapshotSlug = store.ensureProject(snapshotProject).slug;
  const ticket = store.createTicket(snapshotSlug, {
    title: 'refuse a launched filesystem snapshot dispatch', category: 'dispatch.lifecycle', files: ['page.md'], source: 'test',
  });
  const prepared = store.prepareDispatch(snapshotSlug, ticket.ref);
  assert.equal(store.recordDispatchLaunch(snapshotSlug, ticket.ref, { token: prepared.token, executor: prepared.ticket.dispatchExecutor }).ok, true);
  const before = store.getTicket(snapshotSlug, ticket.ref);
  const snapshots = store.readMeta(snapshotSlug).sourceRevisionSnapshots;
  fs.writeFileSync(path.join(snapshotProject, 'page.md'), 'after launch\n');

  assert.throws(() => store.prepareDispatch(snapshotSlug, ticket.ref), /already has a live dispatch attempt/);

  const after = store.getTicket(snapshotSlug, ticket.ref);
  assert.deepEqual(store.readMeta(snapshotSlug).sourceRevisionSnapshots, snapshots, 'refusal leaves no captured replacement hash');
  assert.equal(after.dispatchNonce, before.dispatchNonce, 'refusal keeps the existing nonce');
  assert.deepEqual(after.dispatch, before.dispatch, 'refusal keeps the existing dispatch');
  assert.equal(fs.existsSync(prepared.ticket.dispatch.tokenFile), true, 'refusal keeps the launched token file');
});

test('a recovery reuse avoids a replacement filesystem snapshot', () => {
  let hashCount = 0;
  withSnapshotRevision((originalRevision: any) => (projectPath: string, observedAt: string) => {
    hashCount += 1;
    return originalRevision(projectPath, observedAt);
  }, (snapshotStore: any) => {
    const { projectSlug, ticket } = snapshotProjectFixture(snapshotStore, 'recovery-snapshot', 'reuse a recovery filesystem dispatch');
    const prepared = snapshotStore.getTicket(projectSlug, ticket.ref);
    prepared.dispatchNonce = 'recovery-token';
    prepared.dispatchExecutor = 'sidequest-exec-dispatch';
    prepared.dispatch = {
      recovery: { kind: 'claude_quota_exhausted' }, outcome: 'prepared', executor: prepared.dispatchExecutor, launchSeq: 1, launchName: 'recovery',
    };
    independentTicketWrite(projectSlug, prepared.id, prepared);

    const reused = snapshotStore.prepareDispatch(projectSlug, ticket.ref);

    assert.equal(reused.reused, true);
    assert.equal(hashCount, 0, 'recovery reuse does not hash the project again');
    assert.deepEqual(snapshotStore.readMeta(projectSlug).sourceRevisionSnapshots || [], []);
    assert.equal(snapshotStore.getTicket(projectSlug, ticket.ref).dispatchNonce, 'recovery-token');
  });
});

test('a changed recovery route refuses before rehashing or mutating the prepared dispatch', () => {
  let hashCount = 0;
  withSnapshotRevision((originalRevision: any) => (projectPath: string, observedAt: string) => {
    hashCount += 1;
    return originalRevision(projectPath, observedAt);
  }, (snapshotStore: any) => {
    snapshotStore.setCategory({
      id: 'snapshot.recovery.route', name: 'Snapshot recovery route', route: { model: 'fable', effort: 'high' }, fallback: { model: 'codex-gpt-5-6-sol', effort: 'high' }, enabled: true,
    });
    const snapshotProject = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-dispatch-recovery-route-'));
    fs.writeFileSync(path.join(snapshotProject, 'page.md'), 'recovery route\n');
    const projectSlug = snapshotStore.ensureProject(snapshotProject).slug;
    const ticket = snapshotStore.createTicket(projectSlug, {
      title: 'refuse a changed recovery route', category: 'snapshot.recovery.route', files: ['page.md'], source: 'test',
    });
    const launched = snapshotStore.prepareDispatch(projectSlug, ticket.ref);
    assert.equal(snapshotStore.recordDispatchLaunch(projectSlug, ticket.ref, { token: launched.token, executor: launched.ticket.dispatchExecutor }).ok, true);
    const recovered = snapshotStore.recoverDispatchQuotaFailure(projectSlug, ticket.ref, {
      token: launched.token, executor: launched.ticket.dispatchExecutor, error: "You've reached your Fable limit",
    });
    assert.equal(recovered.ok, true);
    snapshotStore.updateTicket(projectSlug, ticket.ref, { route: { model: 'missing-provider-model', effort: 'high' } });
    const before = snapshotStore.getTicket(projectSlug, ticket.ref);
    const recoveryTokenFile = before.dispatch.tokenFile;
    const recoveryTokenBytes = fs.readFileSync(recoveryTokenFile);
    const snapshots = snapshotStore.readMeta(projectSlug).sourceRevisionSnapshots;

    assert.throws(
      () => snapshotStore.prepareDispatch(projectSlug, ticket.ref),
      /route override "missing-provider-model" crosses providers from category "snapshot\.recovery\.route" and was refused/,
    );

    const after = snapshotStore.getTicket(projectSlug, ticket.ref);
    assert.equal(hashCount, 1, 'the rejected recovery route does not rehash the project');
    assert.deepEqual(snapshotStore.readMeta(projectSlug).sourceRevisionSnapshots, snapshots, 'the rejected recovery route does not persist a snapshot');
    assert.equal(after.dispatchNonce, before.dispatchNonce, 'the rejected recovery route preserves the token');
    assert.deepEqual(after.dispatch, before.dispatch, 'the rejected recovery route preserves the prepared dispatch');
    assert.deepEqual(fs.readFileSync(recoveryTokenFile), recoveryTokenBytes, 'the rejected recovery route preserves the token bytes');
  });
});

// Every one of these mutations lands between the snapshot read and the final
// ticket lock, which is exactly where prepare used to have already deleted the
// token file the board still pointed at (SQ-2691).
const capturePreservationCases = [
  {
    label: 'source path',
    refusal: /changed while its filesystem snapshot was being captured/,
    mutate: (projectSlug: string) => independentProjectWrite(projectSlug, { path: fs.mkdtempSync(path.join(os.tmpdir(), 'sq-dispatch-replacement-')) }),
  },
  {
    label: 'source adapter',
    refusal: /source revision adapter "filesystem-snapshot" is not configured/,
    mutate: (projectSlug: string) => independentProjectWrite(projectSlug, { sourceRevisionAdapter: 'git' }),
  },
  {
    label: 'ticket ref',
    refusal: /changed while its filesystem snapshot was being captured/,
    mutate: (projectSlug: string, ticketId: string) => independentTicketWrite(projectSlug, ticketId, { ref: 'SQ-RENAMED-MID-CAPTURE' }),
  },
];

for (const capture of capturePreservationCases) {
  test(`an independent ${capture.label} writer during dispatch capture preserves the prepared token file`, () => {
    let captureCount = 0;
    let writerCommitted = false;
    let projectSlug = '';
    let ticketId = '';
    withSnapshotRevision((originalRevision: any) => (projectPath: string, observedAt: string) => {
      captureCount += 1;
      const revision = originalRevision(projectPath, observedAt);
      if (captureCount === 2) {
        capture.mutate(projectSlug, ticketId);
        writerCommitted = true;
      }
      return revision;
    }, (snapshotStore: any) => {
      const fixture = snapshotProjectFixture(snapshotStore, 'capture-preservation', `preserve the token past a ${capture.label} change`);
      projectSlug = fixture.projectSlug;
      ticketId = fixture.ticket.id;
      const prepared = snapshotStore.prepareDispatch(projectSlug, ticketId);
      const tokenFile = prepared.ticket.dispatch.tokenFile;
      const tokenBytes = fs.readFileSync(tokenFile);
      const before = snapshotStore.getTicket(projectSlug, ticketId);

      assert.throws(() => snapshotStore.prepareDispatch(projectSlug, ticketId), capture.refusal);

      const after = snapshotStore.getTicket(projectSlug, ticketId);
      assert.equal(writerCommitted, true, 'an independent SQLite writer committed while the project was being read');
      assert.equal(captureCount, 2, 'the refused attempt captured its own snapshot');
      assert.equal(after.dispatchNonce, before.dispatchNonce, 'the refusal keeps the authoritative nonce');
      assert.deepEqual(after.dispatch, before.dispatch, 'the refusal keeps the authoritative dispatch');
      assert.equal(fs.existsSync(tokenFile), true, 'the refusal keeps the token file the board still points at');
      assert.deepEqual(fs.readFileSync(tokenFile), tokenBytes, 'the refusal preserves the token bytes');
      assert.equal(snapshotStore.readDispatchBriefing(projectSlug, ticketId, null, tokenFile).ok, true, 'the preserved token still authenticates a briefing');
    });
  });
}

test('a final-lock claim mutation refuses the captured filesystem snapshot', () => {
  let projectSlug = '';
  let ticketId = '';
  withSnapshotRevision((originalRevision: any) => (projectPath: string, observedAt: string) => {
    const revision = originalRevision(projectPath, observedAt);
    independentTicketWrite(projectSlug, ticketId, { claim: { by: 'independent-writer', at: new Date().toISOString() } });
    return revision;
  }, (snapshotStore: any) => {
    const fixture = snapshotProjectFixture(snapshotStore, 'final-admission', 'reject final admission mutation');
    projectSlug = fixture.projectSlug;
    ticketId = fixture.ticket.id;
    const before = snapshotStore.getTicket(projectSlug, ticketId);

    assert.throws(() => snapshotStore.prepareDispatch(projectSlug, ticketId), /has a live claim by independent-writer/);

    const after = snapshotStore.getTicket(projectSlug, ticketId);
    assert.deepEqual(snapshotStore.readMeta(projectSlug).sourceRevisionSnapshots || [], [], 'refused final admission does not persist the captured hash');
    assert.equal(after.dispatchNonce, before.dispatchNonce);
    assert.deepEqual(after.dispatch, before.dispatch);
  });
});

test('a persistence failure after staging removes only the token that attempt staged', () => {
  let stagedTokenFile = '';
  let armed = false;
  withReloadedStore('../lib/db.js', (original: any) => ({
    putRow: (handle: any, table: string, row: any) => {
      if (armed && table === 'tickets') {
        stagedTokenFile = String(row?.data?.dispatch?.tokenFile || '');
        throw new Error('dispatch persistence failed');
      }
      return original.putRow(handle, table, row);
    },
  }), (patchedStore: any) => {
    const ticket = patchedStore.createTicket(slug, {
      title: 'roll back a staged dispatch token', category: 'dispatch.lifecycle', files: ['tracked.js'], source: 'test',
    });
    const prepared = patchedStore.prepareDispatch(slug, ticket.ref);
    const tokenFile = prepared.ticket.dispatch.tokenFile;
    const tokenBytes = fs.readFileSync(tokenFile);
    const before = patchedStore.getTicket(slug, ticket.id);

    armed = true;
    try {
      assert.throws(() => patchedStore.prepareDispatch(slug, ticket.id), /dispatch persistence failed/);
    } finally {
      armed = false;
    }

    const after = patchedStore.getTicket(slug, ticket.id);
    assert.notEqual(stagedTokenFile, '', 'the failed attempt staged a replacement token file');
    assert.notEqual(stagedTokenFile, tokenFile, 'the staged token file is the attempt\'s own, not the previous one');
    assert.equal(fs.existsSync(stagedTokenFile), false, 'the rollback removes the token this attempt staged');
    assert.equal(fs.existsSync(tokenFile), true, 'the rollback keeps the token file the board still points at');
    assert.deepEqual(fs.readFileSync(tokenFile), tokenBytes, 'the rollback preserves the previous token bytes');
    assert.equal(after.dispatchNonce, before.dispatchNonce, 'the rollback keeps the authoritative nonce');
    assert.deepEqual(after.dispatch, before.dispatch, 'the rollback keeps the authoritative dispatch');
    assert.equal(patchedStore.readDispatchBriefing(slug, ticket.id, null, tokenFile).ok, true, 'the preserved token still authenticates a briefing');
    assert.equal(patchedStore.releaseTicket(slug, ticket.ref, 'staged-token-rollback-cleanup', { status: 'todo', source: 'test', force: true }).ok, true);
  });
});

test('a deferred commit rollback removes only the staged dispatch token', () => {
  const ticket = createFixture('roll back a deferred dispatch commit');
  const first = store.prepareDispatch(slug, ticket.ref);
  const firstTokenFile = first.ticket.dispatch.tokenFile;
  const firstTokenBytes = fs.readFileSync(firstTokenFile);
  const before = store.getTicket(slug, ticket.id);
  const writer = database.openDb(SIDEQUEST_HOME);
  writer.exec('CREATE TABLE dispatch_commit_rollback_probe (ticket_id TEXT NOT NULL, FOREIGN KEY(ticket_id) REFERENCES tickets(id) DEFERRABLE INITIALLY DEFERRED)');
  writer.exec(`CREATE TRIGGER dispatch_commit_rollback_probe_ticket_update AFTER UPDATE OF data ON tickets WHEN NEW.id = '${ticket.id}' BEGIN INSERT INTO dispatch_commit_rollback_probe(ticket_id) VALUES ('missing-dispatch-commit-ticket'); END`);
  const unlinkSync = fs.unlinkSync;
  let removedTokenFile = '';
  let armed = false;
  fs.unlinkSync = (file: Parameters<typeof fs.unlinkSync>[0]) => {
    if (armed && String(file).endsWith('.token')) removedTokenFile = String(file);
    return unlinkSync(file);
  };
  try {
    armed = true;
    assert.throws(() => store.prepareDispatch(slug, ticket.id), /FOREIGN KEY constraint failed/);
  } finally {
    fs.unlinkSync = unlinkSync;
    writer.exec('DROP TRIGGER dispatch_commit_rollback_probe_ticket_update; DROP TABLE dispatch_commit_rollback_probe');
  }

  const after = store.getTicket(slug, ticket.id);
  assert.notEqual(removedTokenFile, '', 'the rolled-back attempt removes its staged token file');
  assert.notEqual(removedTokenFile, firstTokenFile, 'the rollback never removes the prior token file');
  assert.equal(fs.existsSync(removedTokenFile), false, 'the staged token file is removed after the failed commit');
  assert.equal(fs.existsSync(firstTokenFile), true, 'the prior token file survives the failed commit');
  assert.deepEqual(fs.readFileSync(firstTokenFile), firstTokenBytes, 'the prior token bytes survive the failed commit');
  assert.equal(after.dispatchNonce, before.dispatchNonce, 'the failed commit keeps the authoritative nonce');
  assert.deepEqual(after.dispatch, before.dispatch, 'the failed commit keeps the authoritative dispatch');
  assert.equal(store.readDispatchBriefing(slug, ticket.id, null, firstTokenFile).ok, true, 'the preserved token still authenticates a briefing');
  assert.equal(store.releaseTicket(slug, ticket.ref, 'deferred-commit-rollback-cleanup', { status: 'todo', source: 'test', force: true }).ok, true);
});

test('a durable replacement retires only the superseded token file', () => {
  const ticket = createFixture('retire the superseded dispatch token');
  const first = store.prepareDispatch(slug, ticket.ref);
  const firstTokenFile = first.ticket.dispatch.tokenFile;
  assert.equal(fs.readFileSync(firstTokenFile, 'utf8').trim(), first.token);

  const second = store.prepareDispatch(slug, ticket.ref);
  const secondTokenFile = second.ticket.dispatch.tokenFile;

  assert.notEqual(secondTokenFile, firstTokenFile);
  assert.equal(fs.existsSync(firstTokenFile), false, 'the durable replacement retires the superseded token file');
  assert.equal(fs.readFileSync(secondTokenFile, 'utf8').trim(), second.token);
  assert.equal(store.readDispatchBriefing(slug, ticket.ref, null, secondTokenFile).ok, true);
  assert.equal(store.releaseTicket(slug, ticket.ref, 'superseded-token-cleanup', { status: 'todo', source: 'test', force: true }).ok, true);
});

test('executors cannot prepare a shared-tree child dispatch while the orchestrator can', () => {
  const executorSessionId = `executor-dispatch-guard-${Date.now()}`;
  const orchestratorSessionId = `orchestrator-dispatch-guard-${Date.now()}`;
  const held = createFixture('executor-held dispatch guard');
  const heldDispatch = store.prepareDispatch(slug, held.ref, { sessionId: orchestratorSessionId });
  assert.equal(store.claimTicket(slug, held.ref, 'executor-dispatch-guard', {
    token: heldDispatch.token,
    executor: heldDispatch.ticket.dispatchExecutor,
    sessionId: executorSessionId,
  }).ok, true);

  const subordinate = createFixture('subordinate dispatch guard');
  assert.throws(
    () => store.prepareDispatch(slug, subordinate.ref, { sessionId: executorSessionId, sharedTree: true }),
    new RegExp(`dispatch: refused while you hold ${held.ref}\\. Executors cannot dispatch child tickets`),
  );
  assert.equal(store.getTicket(slug, subordinate.ref).dispatchNonce, null);

  const orchestrated = store.prepareDispatch(slug, subordinate.ref, { sessionId: orchestratorSessionId, sharedTree: true, runtimeCwd: PROJECT });
  assert.equal(orchestrated.ok, true);
  assert.equal(orchestrated.ticket.dispatch.sharedTree, true);
  assert.equal(store.releaseTicket(slug, held.ref, 'executor-dispatch-guard', { status: 'todo', source: 'test' }).ok, true);
  assert.equal(store.releaseTicket(slug, subordinate.ref, 'orchestrator-dispatch-guard', { force: true, status: 'todo', source: 'test' }).ok, true);
});

test('shared-tree admission requires the project checkout while artifacts remain orchestrator-dispatchable', () => {
  const linkedWorktree = path.join(os.tmpdir(), `sq-shared-tree-runtime-${Date.now()}`);
  execFileSync('git', ['worktree', 'add', '--detach', linkedWorktree, 'HEAD'], { cwd: PROJECT });
  try {
    const rejected = createFixture('shared-tree linked runtime rejection');
    assert.throws(
      () => store.prepareDispatch(slug, rejected.ref, { sharedTree: true, runtimeCwd: linkedWorktree }),
      /sharedTree:true requires the spawning runtime to be rooted in the declared project checkout/,
    );
    assert.equal(store.getTicket(slug, rejected.ref).dispatchNonce, null);

    store.setCategory({ id: 'shared-tree-artifact', name: 'Shared tree artifact', route: { model: 'sonnet', effort: 'high' }, artifactRoots: ['tracked.js'] });
    const artifact = store.createTicket(slug, {
      title: 'orchestrator shared-tree artifact',
      category: 'shared-tree-artifact',
      description: store.SHARED_TREE_ARTIFACT_MARKER,
      files: ['tracked.js'],
      source: 'test',
    });
    const prepared = store.prepareDispatch(slug, artifact.ref, { sharedTree: true, runtimeCwd: PROJECT });
    assert.equal(prepared.ticket.dispatch.sharedTree, true);
    assert.equal(prepared.ticket.dispatch.artifactMode, true);
    assert.equal(store.releaseTicket(slug, artifact.ref, 'shared-tree-artifact-cleanup', { force: true, status: 'todo', source: 'test' }).ok, true);
  } finally {
    execFileSync('git', ['worktree', 'remove', '--force', linkedWorktree], { cwd: PROJECT });
  }
});

function windowsShortPathAlias(directory = '') {
  if (process.platform !== 'win32') return null;
  const result = spawnSync('cmd.exe', ['/d', '/s', '/c', `for %I in ("${directory}") do @echo %~sI`], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const alias = result.status === 0 ? result.stdout.trim() : '';
  if (!alias || alias.toLowerCase() === directory.toLowerCase()) return null;
  try {
    return fs.realpathSync.native(alias) === fs.realpathSync.native(directory) ? alias : null;
  } catch (error) {
    return null;
  }
}

function commitFixtureChange() {
  fs.appendFileSync(path.join(PROJECT, 'tracked.js'), 'module.exports = 1;\n');
  execFileSync('git', ['add', 'tracked.js'], { cwd: PROJECT });
  execFileSync('git', ['commit', '--quiet', '-m', 'fixture change'], { cwd: PROJECT });
}

function runForceBypass(payload?: any) {
  const output = execFileSync(process.execPath, [FORCE_EXEC_BYPASS], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: PROJECT },
  });
  return output.trim() ? JSON.parse(output) : null;
}

function runLifecycleHook(hook?: any, payload?: any) {
  const output = execFileSync(process.execPath, [hook], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: PROJECT },
  });
  return output.trim() ? JSON.parse(output) : null;
}

function dispatchBindingCounts(refs: any[]) {
  const launched = refs.map((ref) => store.getTicket(slug, ref).dispatch).filter((dispatch) => dispatch.launchedAt);
  return {
    launched: launched.length,
    unbound: launched.filter((dispatch) => !dispatch.boundAt).length,
    noAgentId: launched.filter((dispatch) => !dispatch.agentId).length,
  };
}

test('scope drift ignores always-in-scope paths and preserves declared casing for real drift', () => {
  const scopeDriftProject = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-scope-drift-project-'));
  execFileSync('git', ['init', '--quiet', '-b', 'main'], { cwd: scopeDriftProject });
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: scopeDriftProject });
  execFileSync('git', ['config', 'user.name', 'Scope Drift Test'], { cwd: scopeDriftProject });
  fs.writeFileSync(path.join(scopeDriftProject, 'tracked.js'), 'module.exports = 1;\n');
  execFileSync('git', ['add', 'tracked.js'], { cwd: scopeDriftProject });
  execFileSync('git', ['commit', '--quiet', '-m', 'seed fixture'], { cwd: scopeDriftProject });
  const scopeDriftSlug = store.ensureProject(scopeDriftProject).slug;
  assert.equal(store.setBoardConfig(scopeDriftSlug, { alwaysInScope: ['docs/'] }).ok, true);
  const docsOnly = store.createTicket(scopeDriftSlug, {
    title: 'always-in-scope scope fixture',
    category: 'dispatch.lifecycle',
    files: ['tracked.js'],
    source: 'test',
  });
  const realDrift = store.createTicket(scopeDriftSlug, {
    title: 'real scope drift fixture',
    category: 'dispatch.lifecycle',
    files: ['CamelCase.js'],
    source: 'test',
  });
  try {
    const preparedDocsOnly = store.prepareDispatch(scopeDriftSlug, docsOnly.ref, { sessionId: `scope-drift-docs-${Date.now()}` });
    assert.deepEqual(preparedDocsOnly.ticket.dispatch.declaredFiles, ['tracked.js', 'docs/', `.release/unreleased/${docsOnly.ref}.md`]);
    assert.deepEqual(store.pulsePayload(scopeDriftSlug, docsOnly.ref).scope.declared, ['tracked.js', 'docs/', `.release/unreleased/${docsOnly.ref}.md`]);
    assert.equal(store.pulsePayload(scopeDriftSlug, docsOnly.ref).warnings, undefined);

    store.prepareDispatch(scopeDriftSlug, realDrift.ref, { sessionId: `scope-drift-real-${Date.now()}` });
    assert.equal(store.setBoardConfig(scopeDriftSlug, { alwaysInScope: [] }).ok, true);
    assert.deepEqual(store.pulsePayload(scopeDriftSlug, realDrift.ref).warnings, [
      `Scope drift: this live dispatch enforces .release/unreleased/${realDrift.ref}.md, CamelCase.js, docs but the ticket declares .release/unreleased/${realDrift.ref}.md, CamelCase.js. Commits are gated on the dispatch set; re-run update --files to resync.`,
    ]);
  } finally {
    store.deleteTicket(scopeDriftSlug, docsOnly.ref);
    store.deleteTicket(scopeDriftSlug, realDrift.ref);
  }
});

test('batch launch records every prepared ticket and binds the shared native agent', () => {
  const first = createFixture('first batch lifecycle fixture');
  const second = createFixture('second batch lifecycle fixture');
  const sessionId = `batch-${Date.now()}`;
  const firstPrepared = store.prepareDispatch(slug, first.ref, { sessionId, sharedTree: true });
  const secondPrepared = store.prepareDispatch(slug, second.ref, { sessionId, sharedTree: true });
  const executor = firstPrepared.ticket.dispatchExecutor;
  assert.deepEqual(firstPrepared.ticket.dispatch.preparedBy, { sessionId, surface: 'store' });
  assert.equal(secondPrepared.ticket.dispatchExecutor, executor);

  const prompt = [
    `Ref: ${first.ref}`,
    `briefing ${first.ref} --token-file "${firstPrepared.ticket.dispatch.tokenFile}"`,
    `Ref: ${second.ref}`,
    `briefing ${second.ref} --token-file "${secondPrepared.ticket.dispatch.tokenFile}"`,
    `--project "${PROJECT}"`,
  ].join('\n');
  runForceBypass({
    session_id: sessionId,
    tool_name: 'Agent',
    tool_input: {
      subagent_type: executor,
      name: 'batch-lifecycle-worker',
      prompt,
    },
  });

  for (const ref of [first.ref, second.ref]) {
    const ticket = store.getTicket(slug, ref);
    assert.equal(ticket.dispatch.outcome, 'launched');
    assert.equal(ticket.lastEventType, 'dispatch');
  }

  runLifecycleHook(SUBAGENT_START, {
    session_id: sessionId,
    agent_type: executor,
    agent_name: 'batch-lifecycle-worker',
  });
  for (const ref of [first.ref, second.ref]) {
    const dispatch = store.getTicket(slug, ref).dispatch;
    assert.ok(dispatch.boundAt);
    assert.equal(dispatch.agentId ?? null, null);
  }

  const bound = store.bindDispatchAgent(sessionId, executor, 'native-batch-agent', 'batch-lifecycle-worker');
  assert.equal(bound.ok, true);
  assert.equal(bound.tickets.length, 2);
  for (const ref of [first.ref, second.ref]) {
    const pulse = store.pulsePayload(slug, ref);
    assert.equal(pulse.dispatch.state, 'bound');
    assert.ok(pulse.dispatch.boundAt);
    assert.equal(pulse.liveness, 'starting');
  }
});

test('one runtime agent cannot bind concurrently launched isolated dispatches', () => {
  const first = createFixture('first isolated runtime identity fixture');
  const second = createFixture('second isolated runtime identity fixture');
  const sessionId = `isolated-runtime-identity-${Date.now()}`;
  const agentName = 'isolated-runtime-identity-worker';
  const prepared = [
    store.prepareDispatch(slug, first.ref, { sessionId, sharedTree: false }),
    store.prepareDispatch(slug, second.ref, { sessionId, sharedTree: false }),
  ];
  const executor = prepared[0].ticket.dispatchExecutor;

  for (const launch of prepared) {
    assert.equal(store.recordDispatchLaunch(slug, launch.ticket.ref, {
      sessionId,
      token: launch.token,
      executor,
      agentName,
    }).ok, true);
  }

  const bound = store.bindDispatchAgent(sessionId, executor, 'isolated-runtime-agent', agentName);
  assert.equal(bound.reason, 'ambiguous');
  for (const ref of [first.ref, second.ref]) {
    const dispatch = store.getTicket(slug, ref).dispatch;
    assert.equal(dispatch.agentId ?? null, null);
    assert.equal(dispatch.worktree, undefined);
  }
});

test('claim-token binding accepts prepared and launched attempts', () => {
  const fixture = createFixture('claim token compatibility fixture');
  const sessionId = `claim-token-compatibility-${Date.now()}`;
  const prepared = store.prepareDispatch(slug, fixture.ref, { sessionId, sharedTree: false });
  const claimOptions = {
    sessionId,
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    requireBoundAgent: true,
  };

  assert.equal(store.claimTicket(slug, fixture.ref, 'claim-token-compatibility-worker', claimOptions).ok, true);
  const dispatch = store.getTicket(slug, fixture.ref).dispatch;
  assert.equal(dispatch.bindSource, 'claim_token');
  assert.ok(dispatch.boundAt);
  assert.equal(store.getTicket(slug, fixture.ref).lifecycleAttempt.state, 'claimed');
});

test('serving install snapshots refuse older builds and warn on newer ones', () => {
  const servingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-serving-install-'));
  const storeModulePath = path.join(servingRoot, 'lib', 'store.js');
  const servingVersion = '0.0.0';
  fs.mkdirSync(path.dirname(storeModulePath), { recursive: true });
  fs.mkdirSync(path.join(servingRoot, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(storeModulePath, '');
  fs.writeFileSync(path.join(servingRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: servingVersion }));
  const servingSnapshot = servingSidequestInstall(storeModulePath);
  const activeRegistry = checkSidequestInstall(PROJECT);
  assert.deepEqual(servingSnapshot, { installPath: servingRoot, version: servingVersion });
  assert.equal(activeRegistry.ok, true);
  assert.notEqual(servingSnapshot?.version, activeRegistry.version);

  try {
    withReloadedStore('../lib/dispatch-preflight.js', () => ({
      servingSidequestInstall: () => servingSnapshot,
    }), (snapshotStore: any) => {
      const ticket = createFixture('older serving build fixture');
      const launchTicket = createFixture('older serving launch fixture');
      const preparedLaunch = store.prepareDispatch(slug, launchTicket.ref, { sessionId: `older-serving-launch-${Date.now()}`, sharedTree: true });
      try {
        assert.throws(() => snapshotStore.prepareDispatch(slug, ticket.ref, { sessionId: `older-serving-${Date.now()}`, sharedTree: true }));
        const launchRefusal = snapshotStore.recordDispatchLaunch(slug, launchTicket.ref, {
          token: preparedLaunch.token,
          executor: preparedLaunch.ticket.dispatchExecutor,
          sessionId: `older-serving-launch-${Date.now()}`,
          agentName: 'older-serving-launch-worker',
        });
        assert.equal(launchRefusal.reason, 'prepared_compatibility_stale');
      } finally {
        snapshotStore.releaseTicket(slug, ticket.ref, 'older-serving-cleanup', { status: 'todo', source: 'test', force: true });
        snapshotStore.releaseTicket(slug, launchTicket.ref, 'older-serving-launch-cleanup', { status: 'todo', source: 'test', force: true });
      }
    });

    withReloadedStore('../lib/dispatch-preflight.js', () => ({
      servingSidequestInstall: () => ({ installPath: servingRoot, version: '999.0.0' }),
    }), (snapshotStore: any) => {
      const ticket = createFixture('newer serving build fixture');
      const launchTicket = createFixture('newer serving launch fixture');
      const preparedLaunch = store.prepareDispatch(slug, launchTicket.ref, { sessionId: `newer-serving-launch-${Date.now()}`, sharedTree: true });
      try {
        const prepared = snapshotStore.prepareDispatch(slug, ticket.ref, { sessionId: `newer-serving-${Date.now()}`, sharedTree: true });
        assert.equal(prepared.ok, true);
        assert.equal(prepared.ticket.dispatch.preparedCompatibility.servingVersion, '999.0.0');
        assert.equal(prepared.warnings.length, 1);
        const launch = snapshotStore.recordDispatchLaunch(slug, launchTicket.ref, {
          token: preparedLaunch.token,
          executor: preparedLaunch.ticket.dispatchExecutor,
          sessionId: `newer-serving-launch-${Date.now()}`,
          agentName: 'newer-serving-launch-worker',
        });
        assert.equal(launch.ok, true);
        assert.ok(launch.advisory);
      } finally {
        snapshotStore.releaseTicket(slug, ticket.ref, 'newer-serving-cleanup', { status: 'todo', source: 'test', force: true });
        snapshotStore.releaseTicket(slug, launchTicket.ref, 'newer-serving-launch-cleanup', { status: 'todo', source: 'test', force: true });
      }
    });
  } finally {
    fs.rmSync(servingRoot, { recursive: true, force: true });
  }
});

test('serving install lookup retries after a transient miss', () => {
  const activeRegistry = checkSidequestInstall(PROJECT);
  assert.equal(activeRegistry.ok, true);
  const servingSnapshot = { installPath: path.join(PROJECT, 'serving-install'), version: activeRegistry.version };
  let lookupAvailable = false;
  let lookupCalls = 0;

  withReloadedStore('../lib/dispatch-preflight.js', () => ({
    servingSidequestInstall: () => {
      lookupCalls += 1;
      return lookupAvailable ? servingSnapshot : null;
    },
  }), (snapshotStore: any) => {
    const missedTicket = createFixture('transient serving install lookup fixture');
    const resolvedTicket = createFixture('resolved serving install lookup fixture');
    try {
      const missed = snapshotStore.prepareDispatch(slug, missedTicket.ref, { sessionId: `transient-serving-install-${Date.now()}`, sharedTree: true });
      assert.equal(missed.ticket.dispatch.preparedCompatibility.servingVersion, undefined);

      lookupAvailable = true;
      const resolved = snapshotStore.prepareDispatch(slug, resolvedTicket.ref, { sessionId: `resolved-serving-install-${Date.now()}`, sharedTree: true });
      assert.equal(resolved.ticket.dispatch.preparedCompatibility.servingVersion, servingSnapshot.version);
      assert.ok(lookupCalls >= 3);
    } finally {
      snapshotStore.releaseTicket(slug, missedTicket.ref, 'transient-serving-install-cleanup', { status: 'todo', source: 'test', force: true });
      snapshotStore.releaseTicket(slug, resolvedTicket.ref, 'resolved-serving-install-cleanup', { status: 'todo', source: 'test', force: true });
    }
  });
});

test('serving build metadata drift refuses matching-precedence prepared versions', () => {
  const isolatedClaudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-build-metadata-home-'));
  const isolatedInstallPath = path.join(isolatedClaudeHome, 'sidequest-test-install');
  const sharedClaudeHome = process.env.SIDEQUEST_CLAUDE_HOME;
  fs.mkdirSync(path.join(isolatedClaudeHome, 'plugins'), { recursive: true });
  fs.mkdirSync(path.join(isolatedInstallPath, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(isolatedInstallPath, '.mcp.json'), JSON.stringify({ mcpServers: { board: {} } }));
  fs.writeFileSync(path.join(isolatedInstallPath, 'hooks', 'hooks.json'), JSON.stringify({ hooks: {} }));
  fs.writeFileSync(path.join(isolatedClaudeHome, 'plugins', 'installed_plugins.json'), JSON.stringify({
    plugins: { 'sidequest@eigenwise-toolshed': [{ scope: 'user', installPath: isolatedInstallPath, version: '5.1.14+new' }] },
  }));
  process.env.SIDEQUEST_CLAUDE_HOME = isolatedClaudeHome;

  try {
    withReloadedStore('../lib/dispatch-preflight.js', () => ({
      servingSidequestInstall: () => ({ installPath: isolatedInstallPath, version: '5.1.14+old' }),
    }), (snapshotStore: any) => {
      const ticket = createFixture('build metadata drift fixture');
      try {
        assert.throws(() => snapshotStore.prepareDispatch(slug, ticket.ref, { sessionId: `build-metadata-drift-${Date.now()}`, sharedTree: true }));
      } finally {
        snapshotStore.releaseTicket(slug, ticket.ref, 'build-metadata-drift-cleanup', { status: 'todo', source: 'test', force: true });
      }
    });
  } finally {
    if (sharedClaudeHome === undefined) delete process.env.SIDEQUEST_CLAUDE_HOME;
    else process.env.SIDEQUEST_CLAUDE_HOME = sharedClaudeHome;
    fs.rmSync(isolatedClaudeHome, { recursive: true, force: true });
  }
});

test('tokened stale compatibility refusals retire only proven mismatches', () => {
  // This test flips the install identity that checkSidequestInstall hashes. The full suite
  // shares one SIDEQUEST_CLAUDE_HOME across every test process (scripts/test-full.mjs), so
  // mutating the shared manifest turns concurrent launches in OTHER files into proven
  // mismatches and retires their healthy attempts — three v3.482.0 cut attempts failed on
  // exactly that. Same isolation pattern as test/claim-effort-guard.test.ts: a private
  // claude home for the duration, restored in finally, before any prepare snapshots it.
  const isolatedClaudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-stale-compat-home-'));
  const isolatedInstallPath = path.join(isolatedClaudeHome, 'sidequest-test-install');
  const manifestPath = path.join(isolatedInstallPath, '.mcp.json');
  const originalManifest = JSON.stringify({ mcpServers: { board: { command: 'node', args: ['bin/sidequest-mcp.js'] } } });
  fs.mkdirSync(path.join(isolatedClaudeHome, 'plugins'), { recursive: true });
  fs.mkdirSync(path.join(isolatedInstallPath, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(isolatedInstallPath, 'hooks', 'hooks.json'), JSON.stringify({ hooks: {} }));
  fs.writeFileSync(manifestPath, originalManifest);
  const loadedVersion = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.claude-plugin', 'plugin.json'), 'utf8')).version;
  fs.writeFileSync(path.join(isolatedClaudeHome, 'plugins', 'installed_plugins.json'), JSON.stringify({
    plugins: { 'sidequest@eigenwise-toolshed': [{ scope: 'user', installPath: isolatedInstallPath, version: loadedVersion }] },
  }));
  const sharedClaudeHome = process.env.SIDEQUEST_CLAUDE_HOME;
  process.env.SIDEQUEST_CLAUDE_HOME = isolatedClaudeHome;

  const claimTicket = createFixture('stale compatibility claim fixture');
  const launchTicket = createFixture('stale compatibility launch fixture');
  const transientLaunchTicket = createFixture('transient registry compatibility launch fixture');
  const transientClaimTicket = createFixture('transient registry compatibility claim fixture');
  const unreadableCurrentTicket = createFixture('unreadable current install fixture');
  const claimPrepared = store.prepareDispatch(slug, claimTicket.ref, { sessionId: `stale-compatibility-claim-${Date.now()}` });
  const launchPrepared = store.prepareDispatch(slug, launchTicket.ref, { sessionId: `stale-compatibility-launch-${Date.now()}` });
  const transientLaunchPrepared = store.prepareDispatch(slug, transientLaunchTicket.ref, { sessionId: `transient-registry-launch-${Date.now()}` });
  const transientClaimPrepared = store.prepareDispatch(slug, transientClaimTicket.ref, { sessionId: `transient-registry-claim-${Date.now()}` });
  const unreadableCurrentPrepared = store.prepareDispatch(slug, unreadableCurrentTicket.ref, { sessionId: `unreadable-current-install-${Date.now()}` });
  const preparedIdentity = claimPrepared.ticket.dispatch.preparedCompatibility.identity;

  try {
    fs.writeFileSync(manifestPath, JSON.stringify({ mcpServers: { board: { command: 'replacement-board' } } }));
    const replacementInstall = checkSidequestInstall(PROJECT);
    assert.equal(replacementInstall.ok, true);
    assert.notEqual(replacementInstall.identity, preparedIdentity);

    const originalReadFileSyncDescriptor = Object.getOwnPropertyDescriptor(fs, 'readFileSync');
    const originalReadFileSync = fs.readFileSync;
    const registryPath = path.join(isolatedClaudeHome, 'plugins', 'installed_plugins.json');
    let registryReadAttempts = 0;
    let transientReadPending = true;
    Object.defineProperty(fs, 'readFileSync', {
      ...originalReadFileSyncDescriptor,
      value: function (...arguments_: unknown[]) {
        if (arguments_[0] === registryPath) {
          registryReadAttempts += 1;
          if (transientReadPending) {
            transientReadPending = false;
            throw Object.assign(new Error('simulated transient registry replacement'), { code: 'ENOENT' });
          }
        }
        return Reflect.apply(originalReadFileSync, fs, arguments_);
      },
    });

    try {
      const launchRefusal = store.recordDispatchLaunch(slug, transientLaunchTicket.ref, {
        token: transientLaunchPrepared.token,
        executor: transientLaunchPrepared.ticket.dispatchExecutor,
        sessionId: `unreadable-compatibility-launch-${Date.now()}`,
        agentName: 'unreadable-compatibility-launch-worker',
      });
      assert.equal(launchRefusal.reason, 'prepared_compatibility_stale');

      transientReadPending = true;
      const claimRefusal = store.claimTicket(slug, transientClaimTicket.ref, 'unreadable-compatibility-claim-worker', {
        token: transientClaimPrepared.token,
        executor: transientClaimPrepared.ticket.dispatchExecutor,
      });
      assert.equal(claimRefusal.reason, 'prepared_compatibility_stale');
      assert.equal(registryReadAttempts, 4);
    } finally {
      Object.defineProperty(fs, 'readFileSync', originalReadFileSyncDescriptor!);
    }

    fs.writeFileSync(manifestPath, originalManifest);

    fs.writeFileSync(manifestPath, '');
    assert.equal(checkSidequestInstall(PROJECT).ok, false);
    const unreadableRefusal = store.claimTicket(slug, unreadableCurrentTicket.ref, 'unreadable-current-install-worker', {
      token: unreadableCurrentPrepared.token,
      executor: unreadableCurrentPrepared.ticket.dispatchExecutor,
    });
    assert.equal(unreadableRefusal.reason, 'prepared_compatibility_stale');
    fs.writeFileSync(manifestPath, originalManifest);

    const mcpBeforeVersionChange = fs.readFileSync(manifestPath, 'utf8');
    const registry = JSON.parse(fs.readFileSync(path.join(isolatedClaudeHome, 'plugins', 'installed_plugins.json'), 'utf8'));
    registry.plugins['sidequest@eigenwise-toolshed'][0].version = `${loadedVersion}-runtime-identity-test`;
    fs.writeFileSync(path.join(isolatedClaudeHome, 'plugins', 'installed_plugins.json'), JSON.stringify(registry));
    const versionChangedInstall = checkSidequestInstall(PROJECT);
    assert.equal(fs.readFileSync(manifestPath, 'utf8'), mcpBeforeVersionChange);
    assert.equal(versionChangedInstall.ok, true);
    assert.notEqual(versionChangedInstall.identity, preparedIdentity);

    const claimRefusal = store.claimTicket(slug, claimTicket.ref, 'stale-compatibility-worker', {
      token: claimPrepared.token,
      executor: claimPrepared.ticket.dispatchExecutor,
    });
    assert.equal(claimRefusal.reason, 'prepared_compatibility_stale');
    assert.match(claimRefusal.message, /attempt was retired.*Stop without claiming.*fresh token/);
    assert.match(claimRefusalMessage('prepared_compatibility_stale', claimTicket.ref), /retired.*Stop without claiming.*fresh token/);
    const retiredClaim = store.getTicket(slug, claimTicket.ref);
    assert.equal(retiredClaim.dispatch.outcome, 'failed');
    assert.equal(retiredClaim.dispatch.failureShape, 'prepared_compatibility_stale');
    assert.equal(retiredClaim.dispatch.terminalSource, 'tokened-claim-refusal');
    assert.ok(retiredClaim.dispatch.terminalAt);
    assert.equal(retiredClaim.dispatchNonce, null);
    assert.equal(retiredClaim.dispatchExecutor, null);
    assert.equal(retiredClaim.status, 'todo');
    const claimReplacement = store.prepareDispatch(slug, claimTicket.ref, { sessionId: `stale-compatibility-claim-replacement-${Date.now()}` });
    assert.notEqual(claimReplacement.token, claimPrepared.token);
    assert.equal(claimReplacement.ticket.dispatch.attempts.at(-1).failureShape, 'prepared_compatibility_stale');

    const launchRefusal = store.recordDispatchLaunch(slug, launchTicket.ref, {
      token: launchPrepared.token,
      executor: launchPrepared.ticket.dispatchExecutor,
      sessionId: `stale-compatibility-launch-${Date.now()}`,
      agentName: 'stale-compatibility-launch-worker',
    });
    assert.equal(launchRefusal.reason, 'prepared_compatibility_stale');
    const retiredLaunch = store.getTicket(slug, launchTicket.ref);
    assert.equal(retiredLaunch.dispatch.failureShape, 'prepared_compatibility_stale');
    assert.equal(retiredLaunch.dispatch.terminalSource, 'tokened-launch-refusal');
    assert.equal(retiredLaunch.dispatchNonce, null);
    const launchReplacement = store.prepareDispatch(slug, launchTicket.ref, { sessionId: `stale-compatibility-launch-replacement-${Date.now()}` });
    assert.notEqual(launchReplacement.token, launchPrepared.token);
  } finally {
    if (sharedClaudeHome === undefined) delete process.env.SIDEQUEST_CLAUDE_HOME;
    else process.env.SIDEQUEST_CLAUDE_HOME = sharedClaudeHome;
    for (const ticket of [claimTicket, launchTicket, transientLaunchTicket, transientClaimTicket, unreadableCurrentTicket]) {
      store.releaseTicket(slug, ticket.ref, 'stale-compatibility-cleanup', { status: 'todo', source: 'test', force: true });
    }
    fs.rmSync(isolatedClaudeHome, { recursive: true, force: true });
  }
});

test('a bound runtime without a claim keeps its recovery-evidence backstop', () => {
  const ticket = createFixture('bound unclaimed recovery backstop fixture');
  const sessionId = `bound-unclaimed-recovery-${Date.now()}`;
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId, sharedTree: true });
  const agentName = `bound-unclaimed-recovery-worker-${ticket.id}`;
  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    sessionId,
    agentName,
  }).ok, true);
  assert.equal(store.bindDispatchAgent(sessionId, prepared.ticket.dispatchExecutor, agentName, agentName).ok, true);

  const recoveryEvidence = 'The bound runtime has not claimed and must remain protected during the configured grace.';
  assert.throws(
    () => store.prepareDispatch(slug, ticket.ref, { recoveryEvidence }),
    /bound to a runtime .* ago and still unclaimed, which becomes retirable on evidence at .*, in \d+ minutes?, unless/,
  );
  const protectedAttempt = store.getTicket(slug, ticket.ref);
  assert.equal(protectedAttempt.dispatchNonce, prepared.token);
  assert.equal(protectedAttempt.dispatch.terminalAt, null);

  const originalIdleMinutes = process.env.SIDEQUEST_CLAIM_IDLE_MIN;
  process.env.SIDEQUEST_CLAIM_IDLE_MIN = '0.000001';
  try {
    const replacement = store.prepareDispatch(slug, ticket.ref, { recoveryEvidence });
    assert.equal(replacement.ticket.dispatch.attempts.at(-1).failureShape, 'stranded_bound_launch_superseded');
  } finally {
    if (originalIdleMinutes === undefined) delete process.env.SIDEQUEST_CLAIM_IDLE_MIN;
    else process.env.SIDEQUEST_CLAIM_IDLE_MIN = originalIdleMinutes;
    store.releaseTicket(slug, ticket.ref, 'bound-unclaimed-recovery-cleanup', { status: 'todo', source: 'test', force: true });
  }
});

function bindUnclaimedFixture(label: string) {
  const ticket = createFixture(`${label} fixture`);
  const sessionId = `${label}-${Date.now()}`;
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId, sharedTree: true });
  const agentName = `${label}-worker-${ticket.id}`;
  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    sessionId,
    agentName,
  }).ok, true);
  assert.equal(store.bindDispatchAgent(sessionId, prepared.ticket.dispatchExecutor, agentName, agentName).ok, true);
  return { ticket, prepared, sessionId, agentName, executor: prepared.ticket.dispatchExecutor };
}

const RUNTIME_SIGNAL_FIELDS = [
  'preparedAt',
  'launchedAt',
  'worktreeBoundAt',
  'worktreeCreationCompletedAt',
  'worktreeProvisionedAt',
  'boundAt',
  'briefedAt',
];

// The fake clock: every retirement decision and every printed deadline is measured from the newest board
// signal the runtime produced, so moving every recorded signal back is indistinguishable from letting that
// much wall time pass with the runtime silent.
function backdateRuntimeSignals(ticketId: string, elapsedMs: number) {
  const dispatch = store.getTicket(slug, ticketId).dispatch;
  const at = new Date(Date.now() - elapsedMs).toISOString();
  const attempt = Array.isArray(dispatch.attempts) ? dispatch.attempts.at(-1) : null;
  for (const field of RUNTIME_SIGNAL_FIELDS) {
    if (!dispatch[field]) continue;
    dispatch[field] = at;
    if (attempt && attempt[field]) attempt[field] = at;
  }
  independentTicketWrite(slug, ticketId, { dispatch });
  return at;
}

function stampRuntimeSignal(ticketId: string, field: string, elapsedMs: number) {
  const dispatch = store.getTicket(slug, ticketId).dispatch;
  const at = new Date(Date.now() - elapsedMs).toISOString();
  dispatch[field] = at;
  independentTicketWrite(slug, ticketId, { dispatch });
  return at;
}

// Pinned rather than read back from the store: the shipped defaults ARE the contract an orchestrator
// plans around, so changing either should fail here and be changed on purpose.
const CLAIM_GRACE_MS = 15 * 60 * 1000;
const CLAIM_IDLE_MS = 60 * 60 * 1000;

function retireOnGrace(ref: string, recoveryEvidence: string) {
  try {
    return store.prepareDispatch(slug, ref, { recoveryEvidence, retireOnly: true });
  } catch (error: any) {
    return { refusal: String(error.message) };
  }
}

function retirementOutcome(result: any) {
  return result?.refusal ? `refused: ${result.refusal}` : `retired=${result?.retired}`;
}

function printedDeadline(refusal: string) {
  const printed = /becomes retirable on evidence at (\S+?), in (\d+) minutes?, unless/.exec(refusal);
  assert.ok(printed, `the refusal must print its deadline and countdown, got: ${refusal}`);
  return { at: Date.parse(String(printed![1])), remaining: Number(printed![2]) };
}

// SQ-2932 finding 1: SubagentStart stamps boundAt before the model's first turn, so a grace measured from
// the bind alone retired executors that were reading their briefing. The briefing fetch is a board call
// the runtime makes before its claim, and it has to move the deadline.
test('SQ-2934: the claim grace runs from the briefing fetch, not from the bind that preceded it', () => {
  const { ticket, prepared } = bindUnclaimedFixture('grace-briefing');
  const recoveryEvidence = 'The host reported this agent terminated before its first claim.';

  try {
    assert.equal(store.readDispatchBriefing(slug, ticket.ref, prepared.token).ok, true);
    assert.ok(store.getTicket(slug, ticket.ref).dispatch.briefedAt, 'a served briefing must record itself as a runtime signal');

    backdateRuntimeSignals(ticket.id, 6 * 60000);
    const briefedAt = stampRuntimeSignal(ticket.id, 'briefedAt', 2 * 60000);

    const refused = retireOnGrace(ticket.ref, recoveryEvidence);
    assert.ok(refused.refusal, `six minutes after bind the executor is still protected, got ${retirementOutcome(refused)}`);
    assert.match(refused.refusal, /last runtime signal: briefing fetched at/);
    const printed = printedDeadline(refused.refusal);
    assert.equal(printed.at, Date.parse(briefedAt) + CLAIM_GRACE_MS, 'the deadline must be measured from the briefing fetch');
    assert.equal(printed.remaining, CLAIM_GRACE_MS / 60000 - 2);
    assert.equal(store.getTicket(slug, ticket.ref).dispatch.terminalAt, null);

    backdateRuntimeSignals(ticket.id, CLAIM_GRACE_MS + 4 * 60000);
    stampRuntimeSignal(ticket.id, 'briefedAt', CLAIM_GRACE_MS);
    const retired = retireOnGrace(ticket.ref, recoveryEvidence);
    assert.equal(retired.retired, true, 'a whole grace after the last signal, retirement is accepted');
    assert.equal(retired.ticket.dispatch.failureShape, 'stranded_bound_launch_superseded');
  } finally {
    store.releaseTicket(slug, ticket.ref, 'grace-briefing-cleanup', { status: 'todo', source: 'test', force: true });
  }
});

function worktreeCreationFixture(label: string) {
  const ticket = createFixture(`${label} fixture`);
  const sessionId = `${label}-${Date.now()}`;
  const worktree = worktrees.agentWorktreePath(PROJECT, `${label}-${ticket.id}`);
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId, sharedTree: false });
  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
    sessionId,
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
  }).ok, true);
  assert.equal(store.bindDispatchWorktreeCreation(slug, sessionId, worktree).ok, true);
  assert.ok(!store.getTicket(slug, ticket.ref).dispatch.worktreeProvisionedAt, 'the fixture must start with provisioning unfinished');
  return { ticket, sessionId, worktree };
}

// SQ-2932 finding 2: WorktreeCreate records its completed checkout before it runs provisioning, so a cold
// `npm ci` is minutes of board silence that used to read as a dead hook and retire immediately.
test('SQ-2934: an in-flight WorktreeCreate is never grace-retirable, and the idle backstop still reaches it', () => {
  const recoveryEvidence = 'The host reported no executor ever started in this checkout.';
  const provisioning = worktreeCreationFixture('grace-provisioning');
  const lifted = worktreeCreationFixture('grace-provisioned');

  try {
    backdateRuntimeSignals(provisioning.ticket.id, 30 * 60000);
    const refused = retireOnGrace(provisioning.ticket.ref, recoveryEvidence);
    assert.ok(refused.refusal, `an unfinished WorktreeCreate is not a dead hook, got ${retirementOutcome(refused)}`);
    assert.match(refused.refusal, /has not recorded finished provisioning, so only the idle backstop applies/);
    assert.equal(printedDeadline(refused.refusal).remaining, (CLAIM_IDLE_MS - 30 * 60000) / 60000);

    backdateRuntimeSignals(provisioning.ticket.id, CLAIM_IDLE_MS);
    const retired = retireOnGrace(provisioning.ticket.ref, recoveryEvidence);
    assert.equal(retired.retired, true, 'the idle backstop still reaches a WorktreeCreate nobody will finish');
    assert.equal(retired.ticket.dispatch.failureShape, 'stranded_bound_launch_superseded');

    // The provisioning stamp is what lifts the block, so the same elapsed time retires once it lands.
    assert.equal(store.recordDispatchWorktreeProvisioned(slug, lifted.sessionId, lifted.worktree, creationGeneration(slug, lifted.sessionId, lifted.worktree)).ok, true);
    backdateRuntimeSignals(lifted.ticket.id, 30 * 60000);
    assert.equal(retireOnGrace(lifted.ticket.ref, recoveryEvidence).retired, true);
  } finally {
    for (const fixture of [provisioning, lifted]) {
      store.releaseTicket(slug, fixture.ticket.ref, 'grace-provisioning-cleanup', { status: 'todo', source: 'test', force: true });
    }
  }
});

// pulse is what an orchestrator reads before reaching for recovery evidence, so a pulse saying stalled
// while retirement still refuses sends it looking for another route. Both read one helper (SQ-2932).
test('SQ-2934: pulse and the retirement refusal agree at the exact grace boundary', () => {
  const recoveryEvidence = 'The host reported this agent terminated before its first claim.';
  for (const offsetMs of [-5000, 0, 5000]) {
    const { ticket } = bindUnclaimedFixture(`grace-boundary${offsetMs}`);
    try {
      // The briefing fetch sits four minutes after the bind, so a deadline measured from the bind alone
      // would already be past at every offset and this boundary would move under both surfaces.
      backdateRuntimeSignals(ticket.id, CLAIM_GRACE_MS + offsetMs + 4 * 60000);
      stampRuntimeSignal(ticket.id, 'briefedAt', CLAIM_GRACE_MS + offsetMs);
      const pulse = store.pulsePayload(slug, ticket.ref);
      const stalled = pulse.liveness === 'stalled' && /passed its retirement deadline/.test(pulse.livenessEvidence);
      const retired = retireOnGrace(ticket.ref, recoveryEvidence).retired === true;
      assert.equal(stalled, retired, `pulse said ${pulse.liveness} (${pulse.livenessEvidence}) while retirement said ${retired} at ${offsetMs}ms past the deadline`);
      assert.equal(retired, offsetMs >= 0, `the deadline itself must be inclusive, and anything before it protected (${offsetMs}ms)`);
    } finally {
      store.releaseTicket(slug, ticket.ref, 'grace-boundary-cleanup', { status: 'todo', source: 'test', force: true });
    }
  }
});

test('SQ-2922: the unclaimed countdown names the instant retirement is actually accepted', () => {
  const { ticket } = bindUnclaimedFixture('grace-countdown');
  const recoveryEvidence = 'The host reported this agent terminated before its first claim.';
  let previousRemaining = Number.POSITIVE_INFINITY;

  try {
    for (let elapsedMinutes = 0; elapsedMinutes * 60000 < CLAIM_GRACE_MS; elapsedMinutes += 1) {
      const signalAt = backdateRuntimeSignals(ticket.id, elapsedMinutes * 60000);
      const refused = retireOnGrace(ticket.ref, recoveryEvidence);
      assert.ok(refused.refusal, `inside the grace retirement must be refused, got ${retirementOutcome(refused)}`);
      const printed = printedDeadline(refused.refusal);
      assert.equal(
        printed.at,
        Date.parse(signalAt) + CLAIM_GRACE_MS,
        'the printed deadline must be the same instant the gate uses, not a second computation',
      );
      assert.ok(printed.remaining < previousRemaining, `the countdown must fall, got ${printed.remaining} after ${previousRemaining}`);
      assert.equal(printed.remaining, Math.ceil((CLAIM_GRACE_MS - elapsedMinutes * 60000) / 60000));
      previousRemaining = printed.remaining;
      assert.equal(store.getTicket(slug, ticket.ref).dispatch.terminalAt, null);
    }
    assert.equal(previousRemaining, 1, 'the last refusal before the deadline must read one minute, not a clamped floor');

    backdateRuntimeSignals(ticket.id, CLAIM_GRACE_MS);
    const retired = retireOnGrace(ticket.ref, recoveryEvidence);
    assert.equal(retired.retired, true, 'the refusal must flip to acceptance at the instant it printed');
    assert.equal(retired.ticket.dispatch.failureShape, 'stranded_bound_launch_superseded');
  } finally {
    store.releaseTicket(slug, ticket.ref, 'grace-countdown-cleanup', { status: 'todo', source: 'test', force: true });
  }
});

test('SQ-2922: an attested unclaimed attempt retires past the grace, and a claimed one still does not', () => {
  const recoveryEvidence = 'Host task notification: the agent ended with status failed before its first claim.';
  const stranded = bindUnclaimedFixture('grace-retire');
  backdateRuntimeSignals(stranded.ticket.id, CLAIM_GRACE_MS);
  const retired = retireOnGrace(stranded.ticket.ref, recoveryEvidence);
  assert.equal(retired.retired, true);
  assert.equal(retired.ticket.dispatchNonce, null);
  assert.equal(retired.ticket.dispatch.failureShape, 'stranded_bound_launch_superseded');
  assert.equal(retired.ticket.dispatch.attempts.at(-1).recoveryEvidence, recoveryEvidence);
  const retirement = retired.ticket.dispatch.terminalAt;

  // The stop hook that never fired may still arrive late. It must find the retirement already recorded
  // and leave it alone rather than writing a second terminal outcome over the same attempt.
  const lateStop = store.markDispatchStopped(stranded.sessionId, stranded.executor, stranded.agentName, stranded.agentName);
  assert.notEqual(lateStop.stopped, true);
  const afterStop = store.getTicket(slug, stranded.ticket.ref);
  assert.equal(afterStop.dispatch.terminalAt, retirement);
  assert.equal(afterStop.dispatch.failureShape, 'stranded_bound_launch_superseded');

  const replacement = store.prepareDispatch(slug, stranded.ticket.ref, { sessionId: `grace-retire-replacement-${Date.now()}` });
  assert.notEqual(replacement.token, stranded.prepared.token);
  assert.equal(replacement.ticket.dispatch.terminalAt, null);
  store.releaseTicket(slug, stranded.ticket.ref, 'grace-retire-cleanup', { status: 'todo', source: 'test', force: true });

  // The reporter's dead end: work delivered by hand could not be closed while the attempt stayed bound.
  const delivered = bindUnclaimedFixture('grace-delivery');
  backdateRuntimeSignals(delivered.ticket.id, CLAIM_GRACE_MS);
  commitFixtureChange();
  const deliveredCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: PROJECT, encoding: 'utf8' }).trim();
  const closeOptions = {
    purpose: 'delivery',
    by: 'control-plane',
    reason: 'The contract shipped by hand after the runtime died unclaimed.',
    deliveryCommit: deliveredCommit,
    deliveryMethod: 'manual',
  };
  const blocked = store.completeTicketAsControlPlane(slug, delivered.ticket.ref, closeOptions);
  assert.equal(blocked.reason, 'active_dispatch');
  assert.match(blocked.message, /`sidequest dispatch .* --retire-only`/);
  assert.match(blocked.message, /close it with `groomClose .* --recoveryEvidence/);
  assert.equal(retireOnGrace(delivered.ticket.ref, recoveryEvidence).retired, true);
  assert.equal(store.completeTicketAsControlPlane(slug, delivered.ticket.ref, closeOptions).ok, true);
  assert.equal(store.getTicket(slug, delivered.ticket.ref).status, 'done');

  const claimed = createFixture('grace-claimed fixture');
  const claimedSession = `grace-claimed-${Date.now()}`;
  const claimedPrepared = store.prepareDispatch(slug, claimed.ref, { sessionId: claimedSession, sharedTree: true });
  assert.equal(store.claimTicket(slug, claimed.ref, 'grace-claimed-worker', {
    sessionId: claimedSession,
    token: claimedPrepared.token,
    executor: claimedPrepared.ticket.dispatchExecutor,
  }).ok, true);
  backdateRuntimeSignals(claimed.id, CLAIM_IDLE_MS * 10);
  try {
    assert.throws(
      () => store.prepareDispatch(slug, claimed.ref, { recoveryEvidence, retireOnly: true }),
      /claimed by grace-claimed-worker/,
      'the grace must never shorten the backstop for an attempt that did claim',
    );
  } finally {
    store.releaseTicket(slug, claimed.ref, 'grace-claimed-cleanup', { status: 'todo', source: 'test', force: true });
  }
});

// SQ-2951: one authority, four doors. SQ-2940 and SQ-2949 each found a door that had computed its own
// answer after the previous ticket patched the others, so this walks every attempt state through all four
// at the exact millisecond either side of the deadline and requires them to say the same thing.
const ORDERED_PRE_CLAIM_SIGNALS: ReadonlyArray<readonly [string, string]> = [
  ['launchedAt', 'launch recorded'],
  ['worktreeBoundAt', 'worktree creation started'],
  ['worktreeCreationCompletedAt', 'worktree checkout recorded'],
  ['worktreeProvisionedAt', 'worktree provisioning finished'],
  ['boundAt', 'runtime bound'],
  ['briefedAt', 'briefing fetched'],
  ['claimedAt', 'claim recorded'],
];

type AttemptStateCase = {
  name: string;
  window: number;
  verdict?: 'always' | 'never';
  // The one state whose deadline is not a runtime signal: pulse names no instant once it is retirable,
  // because the deadline is `dispatch.preparedAt` in the same payload and `changes` has no bytes to spare.
  noSignal?: boolean;
  shape: (dispatch: any, signalAt: string) => void;
};

// Each signal in turn as the newest, with every earlier one a minute behind it, so a deadline measured from
// anything but the newest signal lands on a different instant and fails here.
const LATEST_SIGNAL_CASES: AttemptStateCase[] = ORDERED_PRE_CLAIM_SIGNALS.map(([field, label], index) => ({
  name: `${label} is the newest signal`,
  window: CLAIM_GRACE_MS,
  // A claimed attempt is out of the authority's reach entirely: the grace never shortens the idle backstop.
  verdict: field === 'claimedAt' ? 'never' as const : undefined,
  shape: (dispatch: any, signalAt: string) => {
    ORDERED_PRE_CLAIM_SIGNALS.slice(0, index + 1).forEach(([earlierField], earlier) => {
      dispatch[earlierField] = new Date(Date.parse(signalAt) - (index - earlier) * 60000).toISOString();
    });
  },
}));

const ATTEMPT_STATE_CASES: AttemptStateCase[] = [
  ...LATEST_SIGNAL_CASES,
  {
    name: 'WorktreeCreate is still in flight',
    window: CLAIM_IDLE_MS,
    shape: (dispatch: any, signalAt: string) => {
      dispatch.launchedAt = new Date(Date.parse(signalAt) - 60000).toISOString();
      dispatch.worktreeBoundAt = signalAt;
      // Only the fields the authority reads. The end-to-end isolated fixture is covered by the SQ-2934
      // provisioning test and by the stale-generation test below.
      dispatch.worktree = 'authority-in-flight-checkout';
      dispatch.worktreeBindingSource = 'worktree-create';
    },
  },
  {
    // SQ-2955: this row used to backdate preparedAt two hours and declare the verdict `always`, so the one
    // state whose deadline is not a signal never reached the boundary this table exists for, and pulse
    // disagreeing with the other three doors at preparedAt-1 ms went unnoticed. A fresh attempt no runtime
    // touched is retirable AT its own prepare stamp, so the window is zero and -1/0/+1 ms means exactly
    // that, with nothing backdated.
    name: 'no runtime ever recorded a signal',
    window: 0,
    noSignal: true,
    shape: (dispatch: any, signalAt: string) => {
      dispatch.preparedAt = signalAt;
    },
  },
  {
    name: 'an unparseable stamp is one missing signal, not a poisoned comparison',
    window: CLAIM_GRACE_MS,
    shape: (dispatch: any, signalAt: string) => {
      dispatch.launchedAt = new Date(Date.parse(signalAt) - 60000).toISOString();
      dispatch.boundAt = 'not-a-timestamp';
      dispatch.briefedAt = signalAt;
    },
  },
  {
    name: 'a prior generation stamp never moves the live deadline',
    window: CLAIM_GRACE_MS,
    shape: (dispatch: any, signalAt: string) => {
      dispatch.launchedAt = new Date(Date.parse(signalAt) - 60000).toISOString();
      dispatch.briefedAt = signalAt;
      const fresh = new Date().toISOString();
      dispatch.attempts = [{
        outcome: 'failed',
        failureShape: 'unclaimed_launch_superseded',
        terminalAt: fresh,
        launchedAt: fresh,
        boundAt: fresh,
        briefedAt: fresh,
      }];
    },
  },
];

type RetirementProbe = { retirable: boolean; deadline: number | null };

function refusalProbe(message?: string): RetirementProbe {
  const printed = /becomes retirable on evidence at (\S+?), in \d+ minutes?, unless/.exec(String(message || ''));
  return { retirable: false, deadline: printed ? Date.parse(String(printed[1])) : null };
}

function pulseProbe(ref: string): RetirementProbe {
  const pulse = store.pulsePayload(slug, ref);
  const printed = /(?:still starting until|passed its retirement deadline at) (\S+?) \(/.exec(String(pulse.livenessEvidence || ''));
  return { retirable: pulse.liveness === 'stalled', deadline: printed ? Date.parse(String(printed[1])) : null };
}

// A millisecond either side of the deadline is not observable against a live clock: three fixtures and four
// board calls take longer than that, so every door would read a different instant and the boundary would be
// untested. Freezing the clock is what makes -1/0/+1 mean exactly that.
function atFrozenInstant<Result>(instant: number, probe: () => Result): Result {
  const realNow = Date.now;
  Date.now = () => instant;
  try {
    return probe();
  } finally {
    Date.now = realNow;
  }
}

// The signals a runtime would have left, written straight onto the record rather than waited for.
function attemptStateFixture(label: string, attemptCase: AttemptStateCase, retirableAt: number) {
  const ticket = createFixture(`${label} fixture`);
  store.prepareDispatch(slug, ticket.ref, { sessionId: `${label}-${ticket.id}`, sharedTree: true });
  const dispatch = store.getTicket(slug, ticket.ref).dispatch;
  for (const [field] of ORDERED_PRE_CLAIM_SIGNALS) dispatch[field] = null;
  dispatch.outcome = 'launched';
  attemptCase.shape(dispatch, new Date(retirableAt - attemptCase.window).toISOString());
  independentTicketWrite(slug, ticket.id, { dispatch });
  return ticket;
}

test('SQ-2951: every evidence door reads one retirement authority and agrees at the deadline', () => {
  const evidence = 'The host reported this agent gone before its first claim.';
  for (const attemptCase of ATTEMPT_STATE_CASES) {
    for (const offsetMs of [-1, 0, 1]) {
      const retirableAt = Date.now();
      const observedAt = retirableAt + offsetMs;
      const label = `authority-${ATTEMPT_STATE_CASES.indexOf(attemptCase)}-${offsetMs}`;
      const tickets = ['retire', 'replace', 'groom'].map((door) =>
        attemptStateFixture(`${label}-${door}`, attemptCase, retirableAt));
      const [retireTicket, replaceTicket, groomTicket] = tickets;
      try {
        // Read-only, so it runs before anything retires.
        const pulse = atFrozenInstant(observedAt, () => pulseProbe(retireTicket.ref));

        const retireOnly = atFrozenInstant(observedAt, () => retireOnGrace(retireTicket.ref, evidence));
        const retire: RetirementProbe = retireOnly.refusal
          ? refusalProbe(retireOnly.refusal)
          : { retirable: retireOnly.retired === true, deadline: null };

        const replace: RetirementProbe = atFrozenInstant(observedAt, () => {
          try {
            // This door retires and prepares the replacement in one call, so reaching a fresh token at all
            // is the acceptance; only retireOnly reports a `retired` flag.
            const prepared = store.prepareDispatch(slug, replaceTicket.ref, { recoveryEvidence: evidence });
            assert.ok(prepared.token, 'a retirement that prepares a replacement must return its token');
            return { retirable: true, deadline: null };
          } catch (error: any) {
            return refusalProbe(String(error.message));
          }
        });

        const cleared = atFrozenInstant(observedAt, () =>
          store.clearUnclaimedDispatch(slug, groomTicket.ref, { by: 'control-plane', evidence }));
        const groom: RetirementProbe = cleared.ok ? { retirable: true, deadline: null } : refusalProbe(cleared.message);

        const expected = attemptCase.verdict === 'never' ? false
          : attemptCase.verdict === 'always' ? true
            : offsetMs >= 0;
        const where = `${attemptCase.name} at ${offsetMs}ms`;
        assert.equal(retire.retirable, expected, `retireOnly disagreed: ${where} (${retirementOutcome(retireOnly)})`);
        assert.equal(replace.retirable, expected, `dispatch with evidence disagreed: ${where}`);
        assert.equal(groom.retirable, expected, `clearUnclaimedDispatch disagreed: ${where} (${cleared.reason || 'ok'})`);
        assert.equal(pulse.retirable, expected, `pulse disagreed: ${where}`);

        // Every door that printed an instant must have printed the SAME instant, and for a steered case
        // that instant is the deadline the table asked for.
        for (const [door, probe] of [['pulse', pulse], ['retireOnly', retire], ['dispatch', replace], ['groomClose', groom]] as const) {
          if (probe.deadline === null) continue;
          if (attemptCase.verdict) {
            assert.ok(Number.isFinite(probe.deadline), `${door} printed an unreadable deadline for ${where}`);
            continue;
          }
          assert.equal(probe.deadline, retirableAt, `${door} printed a different deadline for ${where}`);
        }
        if (!attemptCase.verdict) {
          // SQ-2955 narrowed this from "always" to "whenever pulse names an instant at all": a retirable
          // no-signal attempt deliberately names the retirement and not its prepare stamp, which the same
          // pulse payload already carries and the per-ticket `changes` line has no bytes for.
          if (!expected || !attemptCase.noSignal) {
            assert.ok(pulse.deadline !== null, `pulse must print the deadline it decided on for ${where}`);
          }
          if (!expected) {
            assert.ok(retire.deadline !== null, `the retireOnly refusal must carry the countdown for ${where}`);
            assert.ok(replace.deadline !== null, `the dispatch refusal must carry the countdown for ${where}`);
            assert.ok(groom.deadline !== null, `the groomClose refusal must carry the countdown for ${where}`);
          }
        }
      } finally {
        for (const ticket of tickets) {
          store.releaseTicket(slug, ticket.ref, `${label}-cleanup`, { status: 'todo', source: 'test', force: true });
        }
      }
    }
  }
});

// SQ-2949 finding 3: a WorktreeCreate callback carries only the session and the checkout path, both of which
// a replacement dispatch reuses, so a prior generation's late hook used to land its stamp on the live attempt
// and drop it from the idle backstop to the claim grace.
test('SQ-2951: a retired generation cannot stamp runtime signals onto its replacement', () => {
  const first = worktreeCreationFixture('stale-generation');
  const staleAttempt = store.getTicket(slug, first.ticket.ref).dispatch.preparedAt;
  try {
    backdateRuntimeSignals(first.ticket.id, CLAIM_IDLE_MS);
    assert.equal(retireOnGrace(first.ticket.ref, 'The host reported the WorktreeCreate host gone.').retired, true);

    const replacementPrepared = store.prepareDispatch(slug, first.ticket.ref, { sessionId: first.sessionId, sharedTree: false });
    assert.equal(store.recordDispatchLaunch(slug, first.ticket.ref, {
      sessionId: first.sessionId,
      token: replacementPrepared.token,
      executor: replacementPrepared.ticket.dispatchExecutor,
    }).ok, true);
    assert.equal(store.bindDispatchWorktreeCreation(slug, first.sessionId, first.worktree).ok, true);
    const liveAttempt = store.getTicket(slug, first.ticket.ref).dispatch.preparedAt;
    assert.notEqual(liveAttempt, staleAttempt, 'the replacement must be a different generation');

    const replayed = store.recordDispatchWorktreeProvisioned(slug, first.sessionId, first.worktree, staleAttempt);
    assert.equal(replayed.ok, false);
    assert.equal(replayed.reason, 'stale_attempt');
    const live = store.getTicket(slug, first.ticket.ref).dispatch;
    assert.ok(!live.worktreeProvisionedAt, 'the stale callback must stamp nothing on the live attempt');
    assert.equal(live.preparedAt, liveAttempt);

    // And the replacement keeps the idle backstop the stale stamp would have taken from it.
    backdateRuntimeSignals(first.ticket.id, CLAIM_GRACE_MS + 60000);
    const refused = retireOnGrace(first.ticket.ref, 'A replacement is still provisioning.');
    assert.ok(refused.refusal, `the replacement keeps its unfinished-WorktreeCreate protection, got ${retirementOutcome(refused)}`);
    assert.match(refused.refusal, /has not recorded finished provisioning, so only the idle backstop applies/);

    // The positive control: the live generation's own token still records, and that is what lifts the block.
    // Backdating rewrote preparedAt, which IS the generation token, so read the current one back.
    const backdatedAttempt = store.getTicket(slug, first.ticket.ref).dispatch.preparedAt;
    assert.equal(store.recordDispatchWorktreeProvisioned(slug, first.sessionId, first.worktree, backdatedAttempt).ok, true);
    assert.ok(store.getTicket(slug, first.ticket.ref).dispatch.worktreeProvisionedAt);
  } finally {
    store.releaseTicket(slug, first.ticket.ref, 'stale-generation-cleanup', { status: 'todo', source: 'test', force: true });
  }
});

// SQ-2953 finding 1: `stale_attempt` was only a NONEMPTY mismatch, so a caller that omitted the generation
// stamped the replacement through all four recorders, and the failure and dependency-link recorders asked
// whether the replacement had completed creation before they looked at the token at all - answering
// `dispatch_binding_unavailable` where the contract requires `stale_attempt`.
// The set is exactly the five POST-start callbacks. The start binding hands the generation out rather than
// presenting one, so it is covered by its own SQ-2961 test above instead of a row here.
test('SQ-2955: every post-start WorktreeCreate recorder demands its attempt generation and reads it first', () => {
  const first = worktreeCreationFixture('generation-mandatory');
  const staleAttempt = store.getTicket(slug, first.ticket.ref).dispatch.preparedAt;
  try {
    backdateRuntimeSignals(first.ticket.id, CLAIM_IDLE_MS);
    assert.equal(retireOnGrace(first.ticket.ref, 'The host reported the WorktreeCreate host gone.').retired, true);

    const replacementPrepared = store.prepareDispatch(slug, first.ticket.ref, { sessionId: first.sessionId, sharedTree: false });
    assert.equal(store.recordDispatchLaunch(slug, first.ticket.ref, {
      sessionId: first.sessionId,
      token: replacementPrepared.token,
      executor: replacementPrepared.ticket.dispatchExecutor,
    }).ok, true);
    assert.equal(store.bindDispatchWorktreeCreation(slug, first.sessionId, first.worktree).ok, true);
    const liveAttempt = store.getTicket(slug, first.ticket.ref).dispatch.preparedAt;
    assert.notEqual(liveAttempt, staleAttempt, 'the replacement must be a different generation');
    // The replacement has NOT completed creation, which is exactly the state that used to answer
    // `dispatch_binding_unavailable` ahead of the generation check.
    assert.ok(!store.getTicket(slug, first.ticket.ref).dispatch.worktreeCreationCompletedAt);

    const failure = { command: 'npm ci', reason: 'exit 1', stderrTail: 'ENOENT' };
    const link = { relativePath: 'node_modules', target: path.join(PROJECT, 'node_modules') };
    const recorders: [string, (attempt?: any) => any][] = [
      ['creation completed', (attempt?: any) => store.completeDispatchWorktreeCreation(slug, first.sessionId, first.worktree, attempt)],
      ['finished provisioning', (attempt?: any) => store.recordDispatchWorktreeProvisioned(slug, first.sessionId, first.worktree, attempt)],
      ['provisioning failure', (attempt?: any) => store.recordDispatchWorktreeProvisioningFailure(slug, first.sessionId, first.worktree, failure, attempt)],
      ['dependency link', (attempt?: any) => store.recordDispatchWorktreeDependencyLink(slug, first.sessionId, first.worktree, link, attempt)],
    ];
    const generations: [string, any, string][] = [
      ['a missing', undefined, 'missing_attempt'],
      ['an empty', '', 'missing_attempt'],
      ['a whitespace', '   ', 'missing_attempt'],
      ['a retired', staleAttempt, 'stale_attempt'],
    ];
    for (const [what, record] of recorders) {
      for (const [label, attempt, reason] of generations) {
        const result = record(attempt);
        assert.equal(result.ok, false, `${what} accepted ${label} generation`);
        assert.equal(result.reason, reason, `${what} with ${label} generation answered ${result.reason}`);
      }
    }
    const untouched = store.getTicket(slug, first.ticket.ref).dispatch;
    assert.equal(untouched.preparedAt, liveAttempt);
    assert.ok(!untouched.worktreeCreationCompletedAt, 'a refused callback must stamp nothing');
    assert.ok(!untouched.worktreeProvisionedAt, 'a refused callback must stamp nothing');
    assert.ok(!untouched.worktreeProvisioningFailure, 'a refused callback must stamp nothing');
    assert.deepEqual(untouched.ownedDependencyLinks || [], []);

    // The live generation is what makes any other refusal reachable at all: the two recorders that require
    // a completed creation now report that, rather than shadowing the generation with it.
    assert.equal(store.recordDispatchWorktreeProvisioningFailure(slug, first.sessionId, first.worktree, failure, liveAttempt).reason, 'dispatch_binding_unavailable');
    assert.equal(store.recordDispatchWorktreeDependencyLink(slug, first.sessionId, first.worktree, link, liveAttempt).reason, 'dispatch_binding_unavailable');
    const completion = store.completeDispatchWorktreeCreation(slug, first.sessionId, first.worktree, liveAttempt);
    assert.equal(completion.ok, false, 'this fixture never checks out the path, so completion still fails');
    assert.ok(!['missing_attempt', 'stale_attempt'].includes(String(completion.reason)), `completion stopped at the generation gate: ${completion.reason}`);

    // The positive control: the live generation records, and recovery refuses the retired one without
    // touching the replacement it would otherwise have terminalized.
    assert.equal(store.recordDispatchWorktreeProvisioned(slug, first.sessionId, first.worktree, liveAttempt).ok, true);
    assert.ok(store.getTicket(slug, first.ticket.ref).dispatch.worktreeProvisionedAt);
    for (const [label, attempt, reason] of generations) {
      const recovery = store.recoverDispatchWorktreeCreation(slug, first.sessionId, first.worktree, new Error('the old hook failed'), attempt);
      assert.equal(recovery.ok, false, `recovery accepted ${label} generation`);
      assert.equal(recovery.reason, reason, `recovery with ${label} generation answered ${recovery.reason}`);
    }
    const afterRecovery = store.getTicket(slug, first.ticket.ref);
    assert.equal(afterRecovery.dispatch.terminalAt, null, 'a retired hook must not terminalize its replacement');
    assert.ok(afterRecovery.dispatchNonce, 'a retired hook must not clear its replacement nonce');
  } finally {
    store.releaseTicket(slug, first.ticket.ref, 'generation-mandatory-cleanup', { status: 'todo', source: 'test', force: true });
  }
});

// SQ-2959 finding 2: the start binding is the one WorktreeCreate callback that cannot present a generation -
// the hook learns its generation FROM this call - so it is scoped to the session and the checkout instead. A
// delayed hook whose own attempt had been retired used to land on the replacement that reused both, acquire
// its generation, and stamp it. A caller that knows its generation is now held to it, and a generation-less
// second caller can no longer acquire the live one from a checkout that is still being created.
test('SQ-2961: the WorktreeCreate start binding is session-and-checkout scoped without handing out a live generation', () => {
  const ticket = createFixture('start-binding-scope fixture');
  const sessionId = `start-binding-scope-${Date.now()}`;
  const worktree = worktrees.agentWorktreePath(PROJECT, `start-binding-scope-${ticket.id}`);
  const launch = (token: string, executor: string) => store.recordDispatchLaunch(slug, ticket.ref, { sessionId, token, executor });
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId, sharedTree: false });
  assert.equal(launch(prepared.token, prepared.ticket.dispatchExecutor).ok, true);
  const staleAttempt = store.getTicket(slug, ticket.ref).dispatch.preparedAt;
  const sibling = createFixture('start-binding-sibling fixture');
  try {
    // The delayed hook's attempt is retired mid-setup and a replacement launches on the same session and the
    // same checkout: the exact sequence the review probe ran.
    backdateRuntimeSignals(ticket.id, CLAIM_IDLE_MS);
    assert.equal(retireOnGrace(ticket.ref, 'The host reported the WorktreeCreate host gone.').retired, true);
    const replacement = store.prepareDispatch(slug, ticket.ref, { sessionId, sharedTree: false });
    assert.equal(launch(replacement.token, replacement.ticket.dispatchExecutor).ok, true);
    const liveAttempt = store.getTicket(slug, ticket.ref).dispatch.preparedAt;
    assert.notEqual(liveAttempt, staleAttempt, 'the replacement must be a different generation');

    const stale = store.bindDispatchWorktreeCreation(slug, sessionId, worktree, staleAttempt);
    assert.equal(stale.ok, false, 'the retired generation bound the replacement');
    assert.equal(stale.reason, 'stale_attempt');
    assert.ok(!store.getTicket(slug, ticket.ref).dispatch.worktreeBoundAt, 'a refused start binding must stamp nothing');

    // The replacement's own hook carries no generation yet: this call is where it learns one.
    const live = store.bindDispatchWorktreeCreation(slug, sessionId, worktree);
    assert.equal(live.ok, true, `the replacement's own hook was refused: ${live.reason}`);
    assert.equal(live.attempt, liveAttempt);
    assert.ok(store.getTicket(slug, ticket.ref).dispatch.worktreeBoundAt);
    assert.ok(!store.getTicket(slug, ticket.ref).dispatch.worktreeCreationCompletedAt, 'creation must still be in flight here');

    // Now the checkout is held by a live attempt mid-creation. A second caller with no generation is a racing
    // hook, and the one thing it must never get back is that live generation.
    const racing = store.bindDispatchWorktreeCreation(slug, sessionId, worktree);
    assert.equal(racing.ok, false, 'a generation-less second start binding acquired the live generation');
    assert.equal(racing.reason, 'missing_attempt');
    assert.ok(!racing.attempt, 'a refused start binding must hand out no generation');
    assert.equal(store.bindDispatchWorktreeCreation(slug, sessionId, worktree, staleAttempt).reason, 'stale_attempt');
    assert.equal(store.bindDispatchWorktreeCreation(slug, sessionId, worktree, liveAttempt).ref, ticket.ref);
    assert.equal(store.recordDispatchWorktreeProvisioned(slug, sessionId, worktree, racing.attempt).reason, 'missing_attempt');

    // A retired attempt still holding this checkout is named as retired rather than silently binding some
    // other live attempt of the same session to it.
    backdateRuntimeSignals(ticket.id, CLAIM_IDLE_MS);
    assert.equal(retireOnGrace(ticket.ref, 'The host reported the replacement gone too.').retired, true);
    const siblingPrepared = store.prepareDispatch(slug, sibling.ref, { sessionId, sharedTree: false });
    assert.equal(store.recordDispatchLaunch(slug, sibling.ref, {
      sessionId,
      token: siblingPrepared.token,
      executor: siblingPrepared.ticket.dispatchExecutor,
    }).ok, true);
    const late = store.bindDispatchWorktreeCreation(slug, sessionId, worktree);
    assert.equal(late.ok, false, `a late hook bound ${late.ref} to a retired attempt's checkout`);
    assert.equal(late.reason, 'stale_attempt');
    assert.ok(!store.getTicket(slug, sibling.ref).dispatch.worktree, 'the unrelated sibling must stay unbound');
  } finally {
    store.releaseTicket(slug, ticket.ref, 'start-binding-scope-cleanup', { status: 'todo', source: 'test', force: true });
    store.releaseTicket(slug, sibling.ref, 'start-binding-sibling-cleanup', { status: 'todo', source: 'test', force: true });
  }
});

// SQ-2953 finding 2: two bound-unclaimed executors whose seven stamps were two hours old were still posting
// board comments, and retireOnly and groomClose retired both. A write is the runtime talking, so it is the
// eighth signal, attributed by the launcher session the dispatch recorded plus its bound runtime identity.
// SQ-2959 finding 1: matching the launcher session alone trusted every writer on it. Fan-out siblings and the
// orchestrator share that one session and the MCP transport carries no per-agent identity, so a foreign
// ticket's agent - and the orchestrator's own progress comments - refreshed all four doors and could strand a
// dead attempt forever. The launcher session is still the trust boundary, but the write must also carry the
// exact runtime name SubagentStart bound, land on this attempt's own ticket, and fall between launch and the
// first claim. A same-session caller writing under that bound name is deliberately trusted as that runtime.
test('SQ-2961: only a board write under the bound runtime name on the launcher session is a runtime signal', () => {
  const evidence = 'The host reported this agent gone before its first claim.';
  type Writer = (agentName: string, sessionId: string) => { by: string; sourceSession: string };
  const BOUND_RUNTIME: Writer = (agentName, sessionId) => ({ by: agentName, sourceSession: sessionId });
  const FOREIGN_SIBLING: Writer = (agentName, sessionId) => ({ by: `${agentName}-sibling`, sourceSession: sessionId });
  const ORCHESTRATOR: Writer = (_agentName, sessionId) => ({ by: 'orchestrator', sourceSession: sessionId });
  const OTHER_SESSION: Writer = (agentName, sessionId) => ({ by: agentName, sourceSession: `${sessionId}-someone-else` });
  const TRAILING_SPACE: Writer = (agentName, sessionId) => ({ by: `${agentName} `, sourceSession: sessionId });

  // One `wroteAt` across all three fixtures, so every door's printed deadline is the same instant.
  function writingFixture(label: string, wroteAt: string, identity: Writer) {
    const fixture = bindUnclaimedFixture(label);
    backdateRuntimeSignals(fixture.ticket.id, 2 * 60 * 60 * 1000);
    const sessionId = store.getTicket(slug, fixture.ticket.ref).dispatch.sessionId;
    const writer = identity(fixture.agentName, sessionId);
    const posted = store.addComment(slug, fixture.ticket.ref, {
      by: writer.by,
      body: `${label}: still working, mid-run`,
      kind: 'comment',
      source: 'mcp',
      sourceSession: writer.sourceSession,
      // The transport stamps this from the caller, so it can never authenticate anyone; the contract reads
      // `by` against the bound name instead, and this proves the foreign actor label changes nothing.
      actor: 'a foreign actor label the transport cannot authenticate',
    });
    assert.equal(posted.ok, true);
    const ticket = store.getTicket(slug, fixture.ticket.ref);
    ticket.comments = ticket.comments.map((comment: any) => (comment.id === posted.comment.id ? { ...comment, at: wroteAt } : comment));
    independentTicketWrite(slug, fixture.ticket.id, { comments: ticket.comments });
    return fixture;
  }

  function doorVerdicts(label: string, wroteAgoMs: number, identity: Writer) {
    const wroteAt = new Date(Date.now() - wroteAgoMs).toISOString();
    const retireFixture = writingFixture(`${label}-retire`, wroteAt, identity);
    const replaceFixture = writingFixture(`${label}-replace`, wroteAt, identity);
    const groomFixture = writingFixture(`${label}-groom`, wroteAt, identity);
    const fixtures = [retireFixture, replaceFixture, groomFixture];
    try {
      const pulse = store.pulsePayload(slug, retireFixture.ticket.ref);
      const retire = retireOnGrace(retireFixture.ticket.ref, evidence);
      let replace: any;
      try {
        replace = { retired: Boolean(store.prepareDispatch(slug, replaceFixture.ticket.ref, { recoveryEvidence: evidence }).token) };
      } catch (error: any) {
        replace = { refusal: String(error.message) };
      }
      const groom = store.clearUnclaimedDispatch(slug, groomFixture.ticket.ref, { by: 'control-plane', evidence });
      return { wroteAt, pulse, retire, replace, groom };
    } finally {
      for (const fixture of fixtures) {
        store.releaseTicket(slug, fixture.ticket.ref, `${label}-cleanup`, { status: 'todo', source: 'test', force: true });
      }
    }
  }

  const writing = doorVerdicts('board-write-live', 60000, BOUND_RUNTIME);
  const deadline = Date.parse(writing.wroteAt) + CLAIM_GRACE_MS;
  assert.ok(writing.retire.refusal, `retireOnly retired a writing executor: ${retirementOutcome(writing.retire)}`);
  assert.equal(printedDeadline(writing.retire.refusal).at, deadline, 'the countdown must run from the board write');
  assert.match(writing.retire.refusal, /last runtime signal: board write recorded at/);
  assert.ok(writing.replace.refusal, 'dispatch with evidence retired a writing executor');
  assert.equal(printedDeadline(writing.replace.refusal).at, deadline);
  assert.equal(writing.groom.ok, false, 'groomClose retired a writing executor');
  assert.equal(writing.groom.reason, 'unclaimed_launch_not_supersedable');
  assert.equal(printedDeadline(writing.groom.message).at, deadline);
  assert.equal(writing.pulse.liveness, 'starting', `pulse called a writing executor ${writing.pulse.liveness}`);
  assert.match(String(writing.pulse.livenessEvidence), /board write recorded/);

  // Past the grace the same attempt retires at every door: a write protects a runtime, it does not immunize one.
  const silent = doorVerdicts('board-write-silent', CLAIM_GRACE_MS + 60000, BOUND_RUNTIME);
  assert.equal(silent.retire.retired, true, retirementOutcome(silent.retire));
  assert.equal(silent.replace.retired, true, silent.replace.refusal);
  assert.equal(silent.groom.ok, true, silent.groom.reason);
  assert.equal(silent.pulse.liveness, 'stalled');

  // The reviewer's live-comment matrix. Every one of these writes lands one minute ago - well inside the
  // grace - and none of them may hold the attempt open.
  const notTheRuntime: Array<[string, Writer]> = [
    ['board-write-foreign-sibling', FOREIGN_SIBLING],
    ['board-write-orchestrator', ORCHESTRATOR],
    ['board-write-other-session', OTHER_SESSION],
    ['board-write-trailing-space', TRAILING_SPACE],
  ];
  for (const [label, identity] of notTheRuntime) {
    const foreign = doorVerdicts(label, 60000, identity);
    assert.equal(foreign.retire.retired, true, `${label}: ${retirementOutcome(foreign.retire)}`);
    assert.equal(foreign.replace.retired, true, `${label}: ${foreign.replace.refusal}`);
    assert.equal(foreign.groom.ok, true, `${label}: ${foreign.groom.reason}`);
    assert.equal(foreign.pulse.liveness, 'stalled', label);
  }

  // A write dated before the attempt launched belongs to an earlier generation of the same ticket, so the
  // bound name and the launcher session together still do not make it this runtime's.
  const preLaunch = doorVerdicts('board-write-pre-launch', 2 * 60 * 60 * 1000 + 60000, BOUND_RUNTIME);
  assert.equal(preLaunch.retire.retired, true, retirementOutcome(preLaunch.retire));
  assert.equal(preLaunch.replace.retired, true, preLaunch.replace.refusal);
  assert.equal(preLaunch.groom.ok, true, preLaunch.groom.reason);
  assert.equal(preLaunch.pulse.liveness, 'stalled');
});


test('direct claim release records the terminal lifecycle state', () => {
  const ticket = createFixture('direct release lifecycle fixture');
  const owner = 'direct-release-lifecycle-worker';
  assert.equal(store.claimTicket(slug, ticket.ref, owner, {
    direct: true,
    reason: 'The lifecycle fixture requires an exact local direct claim.',
  }).ok, true);
  assert.equal(store.getTicket(slug, ticket.ref).lifecycleAttempt.state, 'claimed');

  assert.equal(store.releaseTicket(slug, ticket.ref, owner, {
    status: 'todo',
    source: 'test',
  }).ok, true);
  const released = store.getTicket(slug, ticket.ref);
  assert.equal(released.claim, null);
  assert.equal(released.lifecycleAttempt.state, 'released');
});

test('dispatched claim release records one terminal lifecycle state', () => {
  const ticket = createFixture('dispatched release lifecycle fixture');
  const owner = 'dispatched-release-lifecycle-worker';
  const prepared = store.prepareDispatch(slug, ticket.ref, {
    sessionId: 'dispatched-release-lifecycle',
    sharedTree: true,
  });
  assert.equal(store.claimTicket(slug, ticket.ref, owner, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    sessionId: 'dispatched-release-lifecycle',
  }).ok, true);

  assert.equal(store.releaseTicket(slug, ticket.ref, owner, {
    status: 'todo',
    source: 'test',
  }).ok, true);
  const released = store.getTicket(slug, ticket.ref);
  assert.equal(released.lifecycleAttempt.state, 'released');
  assert.equal(released.dispatch.lifecycleAttempt.state, 'released');
});

test('one runtime cannot claim two isolated dispatches at once', () => {
  const first = createFixture('first runtime claim fixture');
  const second = createFixture('second runtime claim fixture');
  const sessionId = `runtime-claim-${Date.now()}`;
  const prepared = [
    store.prepareDispatch(slug, first.ref, { sessionId, sharedTree: false }),
    store.prepareDispatch(slug, second.ref, { sessionId, sharedTree: false }),
  ];

  for (const launch of prepared) {
    assert.equal(store.recordDispatchLaunch(slug, launch.ticket.ref, {
      sessionId,
      token: launch.token,
      executor: launch.ticket.dispatchExecutor,
      agentName: `runtime-claim-worker-${launch.ticket.id}`,
    }).ok, true);
  }

  assert.equal(store.claimTicket(slug, first.ref, 'runtime-claim-worker', {
    sessionId,
    token: prepared[0].token,
    executor: prepared[0].ticket.dispatchExecutor,
    requireBoundAgent: true,
  }).ok, true);
  const refused = store.claimTicket(slug, second.ref, 'runtime-claim-worker', {
    sessionId,
    token: prepared[1].token,
    executor: prepared[1].ticket.dispatchExecutor,
    requireBoundAgent: true,
  });
  assert.equal(refused.reason, 'runtime_claimed');
  assert.match(refused.message, new RegExp(`already holds ${first.ref}`));
  assert.equal(store.releaseTicket(slug, first.ref, 'runtime-claim-worker', { status: 'todo', source: 'test' }).ok, true);
  assert.equal(store.claimTicket(slug, second.ref, 'runtime-claim-worker', {
    sessionId,
    token: prepared[1].token,
    executor: prepared[1].ticket.dispatchExecutor,
    requireBoundAgent: true,
  }).ok, true);
  assert.equal(store.releaseTicket(slug, second.ref, 'runtime-claim-worker', { status: 'todo', source: 'test' }).ok, true);
});

test('launched dispatches inside their runtime-signal grace are starting', () => {
  const ticket = createFixture('stalled dispatch fixture');
  const sessionId = `stalled-${Date.now()}`;
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId });
  const executor = prepared.ticket.dispatchExecutor;
  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
    sessionId,
    token: prepared.token,
    executor,
    agentName: `stalled-agent-${ticket.id}`,
  }).ok, true);

  const pulse = store.pulsePayload(slug, ticket.ref);
  assert.equal(pulse.liveness, 'starting');
  assert.match(pulse.livenessEvidence, /starting until/);
  const changed = store.changesPayload(slug, new Date(0).toISOString()).tickets.find((entry?: any) => entry.ref === ticket.ref);
  assert.equal(changed.liveness, 'starting');

  assert.equal(store.bindDispatchAgent(sessionId, executor, `stalled-agent-${ticket.id}`, `stalled-agent-${ticket.id}`).ok, true);
  assert.equal(store.pulsePayload(slug, ticket.ref).liveness, 'starting');
});

test('same-name launches on different projects remain ambiguous', () => {
  const otherProject = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-dispatch-lifecycle-other-project-'));
  const otherSlug = store.ensureProject(otherProject).slug;
  const first = store.createTicket(slug, { title: 'cross-project identity fixture', category: 'dispatch.lifecycle', files: ['tracked.js'], source: 'test' });
  const second = store.createTicket(otherSlug, { title: 'cross-project identity fixture', category: 'dispatch.lifecycle', files: ['tracked.js'], source: 'test' });
  const sessionId = `cross-project-${Date.now()}`;
  const agentName = 'same-project-local-launch-name';
  const firstPrepared = store.prepareDispatch(slug, first.ref, { sessionId, sharedTree: true });
  const secondPrepared = store.prepareDispatch(otherSlug, second.ref, { sessionId, sharedTree: true });
  const prepared: Array<[string, any]> = [
    [slug, firstPrepared],
    [otherSlug, secondPrepared],
  ];
  const executor = firstPrepared.ticket.dispatchExecutor;

  for (const [projectSlug, launch] of prepared) {
    assert.equal(launch.ticket.dispatchExecutor, executor);
    assert.equal(store.recordDispatchLaunch(projectSlug, launch.ticket.ref, {
      sessionId,
      token: launch.token,
      executor,
      agentName,
    }).ok, true);
  }

  runLifecycleHook(SUBAGENT_START, {
    session_id: sessionId,
    agent_type: executor,
    agent_name: agentName,
  });
  assert.equal(store.bindDispatchAgent(sessionId, executor, null, agentName).reason, 'ambiguous');
  assert.equal(store.markDispatchStopped(sessionId, executor, 'cross-project-agent', agentName).reason, 'ambiguous');
  for (const [projectSlug, launch] of prepared) {
    const dispatch = store.getTicket(projectSlug, launch.ticket.ref).dispatch;
    assert.equal(dispatch.boundAt, null);
    assert.equal(dispatch.agentId ?? null, null);
    assert.equal(dispatch.outcome, 'launched');
  }
});

test('shared-tree agents bind by name before SubagentStop supplies their id', () => {
  const ticket = createFixture('shared-tree identity fallback fixture');
  const sessionId = `shared-tree-${Date.now()}`;
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId, sharedTree: true });
  const executor = prepared.ticket.dispatchExecutor;
  const agentName = `shared-tree-agent-${ticket.id}`;
  const agentId = `shared-tree-native-${ticket.id}`;
  assert.equal(prepared.ticket.dispatch.sharedTree, true);
  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
    sessionId,
    token: prepared.token,
    executor,
    agentName,
  }).ok, true);
  assert.deepEqual(dispatchBindingCounts([ticket.ref]), { launched: 1, unbound: 1, noAgentId: 1 });

  runLifecycleHook(SUBAGENT_START, {
    session_id: sessionId,
    agent_type: executor,
    agent_name: agentName,
  });
  let dispatch = store.getTicket(slug, ticket.ref).dispatch;
  assert.deepEqual(dispatchBindingCounts([ticket.ref]), { launched: 1, unbound: 0, noAgentId: 1 });
  assert.ok(dispatch.boundAt);
  assert.equal(dispatch.agentId ?? null, null);
  assert.equal(dispatch.worktree, undefined);
  const boundAt = dispatch.boundAt;

  const by = `shared-tree-worker-${ticket.id}`;
  assert.equal(store.claimTicket(slug, ticket.ref, by, {
    sessionId,
    token: prepared.token,
    executor,
  }).ok, true);
  commitFixtureChange();
  assert.equal(store.submitTicket(slug, ticket.ref, by, {
    commit: 'abc1234def5678',
    sessionId,
    source: 'test',
  }).ok, true);
  dispatch = store.getTicket(slug, ticket.ref).dispatch;
  assert.deepEqual(dispatchBindingCounts([ticket.ref]), { launched: 1, unbound: 0, noAgentId: 1 });
  assert.equal(dispatch.outcome, 'submitted');
  assert.equal(dispatch.agentId ?? null, null);
  const terminalAt = dispatch.terminalAt;
  const terminalSource = dispatch.terminalSource;
  assert.equal(store.markDispatchStopped(sessionId, executor, 'unrelated-id', 'unrelated-name').reason, 'not_found');
  const verdict = runLifecycleHook(SUBAGENT_STOP, {
    session_id: sessionId,
    agent_type: executor,
    agent_id: agentId,
    agent_name: agentName,
  });

  dispatch = store.getTicket(slug, ticket.ref).dispatch;
  assert.match(JSON.stringify(verdict), new RegExp(`${ticket.ref} READY_FOR_INTEGRATION`));
  assert.deepEqual(dispatchBindingCounts([ticket.ref]), { launched: 1, unbound: 0, noAgentId: 0 });
  assert.equal(dispatch.agentId, agentId);
  assert.equal(dispatch.boundAt, boundAt);
  assert.equal(dispatch.outcome, 'submitted');
  assert.equal(dispatch.terminalAt, terminalAt);
  assert.equal(dispatch.terminalSource, terminalSource);
});

test('a resumed live claim re-mints its token and re-binds the linked worktree', () => {
  const ticket = createFixture('resumed live claim fixture');
  const originalSession = `resumed-live-claim-${Date.now()}`;
  const resumedSession = `${originalSession}-resumed`;
  const agentName = `resumed-live-agent-${ticket.id}`;
  const resumedAgentId = `${agentName}-resumed`;
  const claimHolder = `resumed-live-worker-${ticket.id}`;
  const worktree = worktrees.agentWorktreePath(PROJECT, agentName);
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId: originalSession, sharedTree: false });
  const executor = prepared.ticket.dispatchExecutor;
  try {
    assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
      sessionId: originalSession,
      token: prepared.token,
      executor,
      agentName,
    }).ok, true);
    assert.equal(store.claimTicket(slug, ticket.ref, claimHolder, {
      sessionId: originalSession,
      token: prepared.token,
      executor,
      requireBoundAgent: true,
    }).ok, true);
    assert.equal(store.readDispatchBriefing(slug, ticket.ref, undefined, prepared.ticket.dispatch.tokenFile).ok, true);
    assert.equal(store.pulsePayload(slug, ticket.ref).dispatch.worktreeBound, false);

    fs.mkdirSync(path.dirname(worktree), { recursive: true });
    execFileSync('git', ['worktree', 'add', '--detach', worktree, 'HEAD'], { cwd: PROJECT });
    markCheckoutInstance(worktree);
    fs.rmSync(prepared.ticket.dispatch.tokenFile);
    assert.equal(store.readDispatchBriefing(slug, ticket.ref, undefined, prepared.ticket.dispatch.tokenFile).reason, 'token');

    const recovered = store.recoverLiveClaimDispatch(slug, ticket.ref, {
      by: claimHolder,
      executor,
      worktree,
      recoveryEvidence: 'The resumed executor lost its token file and worktree binding after an API failure.',
      sessionId: resumedSession,
    });
    assert.equal(recovered.ok, true);
    assert.notEqual(recovered.token, prepared.token);
    assert.equal(store.readDispatchBriefing(slug, ticket.ref, undefined, prepared.ticket.dispatch.tokenFile).token, recovered.token);
    assert.equal(store.pulsePayload(slug, ticket.ref).dispatch.worktreeBound, true);
    assert.equal(store.bindDispatchAgent(resumedSession, executor, resumedAgentId, agentName, worktree).ok, true);
    assert.equal(store.claimTicket(slug, ticket.ref, claimHolder, {
      sessionId: resumedSession,
      token: recovered.token,
      executor,
      requireBoundAgent: true,
    }).ok, true);

    fs.appendFileSync(path.join(worktree, 'tracked.js'), 'module.exports = 3;\n');
    execFileSync('git', ['add', 'tracked.js'], { cwd: worktree });
    execFileSync('git', ['commit', '--quiet', '-m', 'resumed live claim fixture'], { cwd: worktree });
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8' }).trim();
    assert.equal(store.submitTicket(slug, ticket.ref, claimHolder, {
      commit,
      worktree,
      sessionId: resumedSession,
      source: 'test',
    }).ok, true);
  } finally {
    store.releaseTicket(slug, ticket.ref, claimHolder, { status: 'todo', source: 'test', force: true });
    if (fs.existsSync(worktree)) execFileSync('git', ['worktree', 'remove', '--force', worktree], { cwd: PROJECT });
  }
});

test('SubagentStop backfills identity but never invents a worktree binding', () => {
  const ticket = createFixture('isolated stop fallback fixture');
  const sessionId = `isolated-stop-${Date.now()}`;
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId, sharedTree: false });
  const executor = prepared.ticket.dispatchExecutor;
  const agentName = `isolated-stop-agent-${ticket.id}`;
  const agentId = `isolated-stop-native-${ticket.id}`;
  assert.equal(prepared.ticket.dispatch.sharedTree, false);
  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
    sessionId,
    token: prepared.token,
    executor,
    agentName,
  }).ok, true);
  assert.deepEqual(dispatchBindingCounts([ticket.ref]), { launched: 1, unbound: 1, noAgentId: 1 });
  assert.equal(store.claimTicket(slug, ticket.ref, `token-bound-isolated-worker-${ticket.id}`, {
    sessionId,
    token: prepared.token,
    executor,
    requireBoundAgent: true,
  }).ok, true);
  assert.equal(store.getTicket(slug, ticket.ref).dispatch.bindSource, 'claim_token');

  runLifecycleHook(SUBAGENT_STOP, {
    session_id: sessionId,
    agent_type: executor,
    agent_id: agentId,
    agent_name: agentName,
  });

  const dispatch = store.getTicket(slug, ticket.ref).dispatch;
  assert.deepEqual(dispatchBindingCounts([ticket.ref]), { launched: 1, unbound: 0, noAgentId: 0 });
  assert.equal(dispatch.agentId, agentId);
  assert.ok(dispatch.boundAt);
  assert.equal(dispatch.worktree, undefined);
  assert.equal(dispatch.outcome, 'claimed');
  assert.ok(dispatch.turnEndedAt);
});

test('zero-scope read-only dispatches isolate by default and preserve explicit checkout choice', () => {
  const ticket = store.createTicket(slug, {
    title: 'zero-scope read-only isolated checkout',
    category: 'research',
    source: 'test',
  });
  const sessionId = `zero-scope-readonly-${Date.now()}`;
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId });
  assert.equal(prepared.ticket.dispatch.readonly, true);
  assert.equal(prepared.ticket.dispatch.sharedTree, false);
  assert.equal(prepared.ticket.dispatchExecutor, 'sidequest-exec-readonly-high');
  assert.equal(agentsync.ticketIsolation(prepared.ticket, prepared.ticket.dispatch.sharedTree), 'worktree');
  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
    sessionId,
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    agentName: 'zero-scope-readonly-worker',
  }).ok, true);
  assert.equal(store.bindDispatchAgent(sessionId, prepared.ticket.dispatchExecutor, 'zero-scope-readonly-agent', 'zero-scope-readonly-worker').ok, true);
  assert.equal(store.getTicket(slug, ticket.ref).dispatch.worktree, undefined);
  assert.equal(store.claimTicket(slug, ticket.ref, 'zero-scope-readonly-worker', {
    sessionId,
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    source: 'test',
  }).ok, true);
  assert.equal(store.releaseTicket(slug, ticket.ref, 'zero-scope-readonly-worker', { status: 'todo', source: 'test' }).ok, true);

  const explicitlyShared = store.prepareDispatch(slug, ticket.ref, { sharedTree: true, runtimeCwd: PROJECT });
  assert.equal(explicitlyShared.ticket.dispatch.sharedTree, true);
  assert.equal(agentsync.ticketIsolation(explicitlyShared.ticket, explicitlyShared.ticket.dispatch.sharedTree), null);
  assert.equal(store.releaseTicket(slug, ticket.ref, 'zero-scope-readonly-shared-cleanup', { status: 'todo', source: 'test', force: true }).ok, true);

  const explicitlyIsolated = store.prepareDispatch(slug, ticket.ref, { sharedTree: false });
  assert.equal(explicitlyIsolated.ticket.dispatch.sharedTree, false);
  assert.equal(store.getTicket(slug, ticket.ref).lifecycleAttempt.state, 'prepared');
  assert.equal(store.getTicket(slug, ticket.ref).dispatch.lifecycleAttempt.state, 'prepared');
  assert.equal(store.releaseTicket(slug, ticket.ref, 'zero-scope-readonly-cleanup', { status: 'todo', source: 'test', force: true }).ok, true);
});

test('review-audit dispatches inspect immutable commits from isolated worktrees by default', () => {
  const ticket = createFixture('review isolated checkout default', 'review-audit');
  const prepared = store.prepareDispatch(slug, ticket.ref);
  assert.equal(prepared.ticket.dispatch.sharedTree, false);
  assert.equal(agentsync.ticketIsolation(prepared.ticket, prepared.ticket.dispatch.sharedTree), 'worktree');

  assert.equal(store.releaseTicket(slug, ticket.ref, 'review-isolated-cleanup', { status: 'todo', source: 'test', force: true }).ok, true);
  const explicitlyShared = store.prepareDispatch(slug, ticket.ref, { sharedTree: true, runtimeCwd: PROJECT });
  assert.equal(explicitlyShared.ticket.dispatch.sharedTree, true);
  assert.equal(store.releaseTicket(slug, ticket.ref, 'review-shared-cleanup', { status: 'todo', source: 'test', force: true }).ok, true);
});

test('read-only category classes dispatch through restricted stable executors', () => {
  for (const category of ['codebase-exploration', 'research', 'review-audit', 'spike-investigation', 'visual-review']) {
    const ticket = createFixture(`${category} fixture`, category);
    const prepared = store.prepareDispatch(slug, ticket.ref);
    assert.equal(prepared.ticket.dispatch.readonly, true);
    assert.equal(prepared.ticket.dispatchExecutor, 'sidequest-exec-readonly-high');
    assert.equal(store.claimTicket(slug, ticket.ref, 'read-only-test-worker', {
      token: prepared.token,
      executor: prepared.ticket.dispatchExecutor,
      source: 'test',
    }).ok, true);
    assert.equal(store.releaseTicket(slug, ticket.ref, 'read-only-test-worker', { source: 'test' }).ok, true);
  }

  const override = store.createTicket(slug, {
    title: 'mutable spike fixture',
    category: 'spike-investigation',
    readonly: false,
    files: ['tracked.js'],
    source: 'test',
  });
  assert.equal(store.getTicket(slug, override.ref).readonlyOverride, false);
  assert.equal(store.listPayload(slug, { brief: true }).tickets.find((ticket?: any) => ticket.ref === override.ref).readonlyOverride, false);
  const overridePrepared = store.prepareDispatch(slug, override.ref);
  assert.equal(overridePrepared.ticket.dispatchExecutor, 'sidequest-exec-high');
  assert.match(store.dispatchWarnings(overridePrepared.ticket).join('\n'), /readonly override active/);
  assert.equal(store.claimTicket(slug, override.ref, 'override-test-worker', {
    token: overridePrepared.token,
    executor: overridePrepared.ticket.dispatchExecutor,
    source: 'test',
  }).ok, true);
  assert.equal(store.releaseTicket(slug, override.ref, 'override-test-worker', { source: 'test' }).ok, true);

  const readOnlyOverride = store.createTicket(slug, {
    title: 'read-only coding fixture',
    category: 'coding.normal',
    readonly: true,
    source: 'test',
  });
  assert.equal(store.getTicket(slug, readOnlyOverride.ref).readonlyOverride, true);
  const readOnlyOverridePrepared = store.prepareDispatch(slug, readOnlyOverride.ref);
  assert.equal(readOnlyOverridePrepared.ticket.dispatch.readonly, true);
  assert.match(readOnlyOverridePrepared.ticket.dispatchExecutor, /readonly/);
  assert.match(store.dispatchWarnings(readOnlyOverridePrepared.ticket).join('\n'), /readonly override active/);
  assert.equal(store.claimTicket(slug, readOnlyOverride.ref, 'read-only-override-worker', {
    token: readOnlyOverridePrepared.token,
    executor: readOnlyOverridePrepared.ticket.dispatchExecutor,
    source: 'test',
  }).ok, true);
  assert.equal(store.releaseTicket(slug, readOnlyOverride.ref, 'read-only-override-worker', { source: 'test' }).ok, true);

  const contradiction = store.createTicket(slug, {
    title: 'contradictory spike fixture',
    category: 'spike-investigation',
    files: ['tracked.js'],
    source: 'test',
  });
  assert.match(store.ticketPlanningWarnings(store.getTicket(slug, contradiction.ref)).join('\n'), /Readonly category contradicts declared write intent/);
  const contradictionPrepared = store.prepareDispatch(slug, contradiction.ref);
  assert.match(store.dispatchWarnings(contradictionPrepared.ticket).join('\n'), /Readonly category contradicts declared write intent/);
  assert.equal(store.claimTicket(slug, contradiction.ref, 'contradiction-worker', {
    token: contradictionPrepared.token,
    executor: contradictionPrepared.ticket.dispatchExecutor,
    source: 'test',
  }).ok, true);
  assert.equal(store.releaseTicket(slug, contradiction.ref, 'contradiction-worker', { source: 'test' }).ok, true);

  const artifactWrite = store.createTicket(slug, {
    title: 'codebase artifact fixture',
    category: 'codebase-exploration',
    files: ['.claude\\.codebase-info\\modules.md'],
    contracts: { changes: ['.claude/.codebase-info/INDEX.md'] },
    source: 'test',
  });
  const artifactTicket = store.getTicket(slug, artifactWrite.ref);
  assert.equal(artifactTicket.readonlyOverride, null);
  assert.doesNotMatch(store.ticketPlanningWarnings(artifactTicket).join('\n'), /Readonly category contradicts declared write intent/);
  assert.doesNotMatch(store.dispatchWarnings(artifactTicket).join('\n'), /readonly override active|Readonly category contradicts declared write intent/);

  const outsideArtifactRoot = store.createTicket(slug, {
    title: 'outside codebase artifact fixture',
    category: 'codebase-exploration',
    files: ['.claude/.codebase-info/modules.md', 'src/index.ts', '.claude/.codebase-infoXYZ/not-a-map.md'],
    source: 'test',
  });
  const outsideWarning = store.ticketPlanningWarnings(store.getTicket(slug, outsideArtifactRoot.ref)).join('\n');
  assert.match(outsideWarning, /Readonly category contradicts declared write intent/);
  assert.match(outsideWarning, /src\/index\.ts/);
  assert.match(outsideWarning, /\.claude\/\.codebase-infoXYZ\/not-a-map\.md/);

  const updatedOverride = createFixture('updated mutable spike fixture', 'spike-investigation');
  assert.equal(store.updateTicket(slug, updatedOverride.ref, { readonly: false, source: 'test' }).readonlyOverride, false);
  const updatedPrepared = store.prepareDispatch(slug, updatedOverride.ref);
  assert.equal(updatedPrepared.ticket.dispatchExecutor, 'sidequest-exec-high');
  assert.equal(store.claimTicket(slug, updatedOverride.ref, 'updated-override-test-worker', {
    token: updatedPrepared.token,
    executor: updatedPrepared.ticket.dispatchExecutor,
    source: 'test',
  }).ok, true);
  assert.equal(store.releaseTicket(slug, updatedOverride.ref, 'updated-override-test-worker', { source: 'test' }).ok, true);
});

test('dispatch warnings flag WebSearch only for constrained Claude routes', () => {
  const warning = /WebSearch is unavailable on this Claude xhigh\/max route.*research-category ticket/;
  for (const [model, effort] of [['opus', 'xhigh'], ['sonnet', 'max'], ['fable', 'xhigh']]) {
    assert.match(store.dispatchWarnings({ model, effort }).join('\n'), warning, `${model}/${effort}`);
  }
  for (const [model, effort] of [['codex-gpt-5-6-terra', 'xhigh'], ['opus', 'high']]) {
    assert.doesNotMatch(store.dispatchWarnings({ model, effort }).join('\n'), warning, `${model}/${effort}`);
  }
});

test('pulse reports derived activity and dispatch changes without leaking a nonce', () => {
  const ticket = createFixture('complete lifecycle fixture');
  const sessionId = `lifecycle-${Date.now()}`;
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId });
  const executor = prepared.ticket.dispatchExecutor;
  const since = new Date(Date.now() - 1000).toISOString();

  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
    sessionId,
    token: prepared.token,
    executor,
    agentName: 'complete-lifecycle-worker',
  }).ok, true);
  const worktree = worktrees.agentWorktreePath(PROJECT, 'native-complete-agent');
  assert.equal(store.bindDispatchWorktreeCreation(slug, sessionId, worktree).ok, true);
  assert.equal(store.bindDispatchAgent(sessionId, executor, 'native-complete-agent', 'complete-lifecycle-worker').ok, true);
  assert.equal(worktrees.canonicalPath(store.getTicket(slug, ticket.ref).dispatch.worktree), worktrees.canonicalPath(worktree));
  fs.mkdirSync(worktree, { recursive: true });
  let pulse = store.pulsePayload(slug, ticket.ref);
  assert.equal(pulse.dispatch.state, 'bound');
  assert.equal(Object.hasOwn(pulse, 'dispatchNonce'), false);
  assert.equal(JSON.stringify(pulse).includes(prepared.token), false);
  assert.equal(pulse.dispatch.tokenPrefix, prepared.token.slice(0, 12));

  assert.equal(store.claimTicket(slug, ticket.ref, 'lifecycle-worker', {
    sessionId,
    token: prepared.token,
    executor,
  }).ok, true);
  pulse = store.pulsePayload(slug, ticket.ref);
  assert.equal(pulse.dispatch.state, 'claimed');
  assert.equal(pulse.liveness, 'unknown');
  assert.match(pulse.livenessEvidence, /no process heartbeat/);
  assert.equal(pulse.claim.lastBoardActivityAt, pulse.claim.at);
  assert.equal(typeof pulse.claim.boardQuietMs, 'number');
  assert.match(pulse.claim.boardQuietNote, /not process liveness/);
  assert.equal(store.changesPayload(slug, since).tickets.find((entry?: any) => entry.ref === ticket.ref).lastEventType, 'dispatch');

  store.addComment(slug, ticket.ref, {
    by: 'lifecycle-worker',
    body: 'Verified the scoped lifecycle fixture.',
    source: 'test',
  });
  pulse = store.pulsePayload(slug, ticket.ref);
  assert.equal(pulse.claim.lastBoardActivityAt, store.getTicket(slug, ticket.ref).comments.at(-1).at);

  assert.equal(store.completeTicket(slug, ticket.ref, 'lifecycle-worker', {
    model: 'sonnet',
    effort: 'high',
    source: 'test',
  }).ok, false);
  assert.equal(store.releaseTicket(slug, ticket.ref, 'lifecycle-worker', { status: 'todo', source: 'test' }).ok, true);
  assert.equal(store.getTicket(slug, ticket.ref).lifecycleAttempt.state, 'released');
  assert.equal(store.completeTicketAsControlPlane(slug, ticket.ref, {
    purpose: 'grooming',
    by: 'board-groomer',
    reason: 'Verified the lifecycle fixture as complete.',
  }).ok, true);
  pulse = store.pulsePayload(slug, ticket.ref);
  assert.equal(pulse.dispatch.state, 'done');
  assert.equal(pulse.dispatch.outcome, 'done');
  assert.equal(store.getTicket(slug, ticket.ref).lastEventType, 'dispatch');
  fs.rmSync(worktree, { recursive: true, force: true });
});

test('oracle releases park awaiting-oracle without repeat guard and retain their worktree continuation', () => {
  const ticket = createFixture('oracle projection fixture');
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId: `oracle-projection-${Date.now()}` });
  assert.equal(store.claimTicket(slug, ticket.ref, 'oracle-projection-worker', {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
  }).ok, true);

  assert.equal(store.releaseTicket(slug, ticket.ref, 'oracle-projection-worker', {
    status: 'awaiting-oracle',
    releaseKind: 'oracle',
    oracle: 'Rank the candidates best to worst.',
    candidate: 'abc1234',
    deliverable: 'artifacts/round-1.wav',
    source: 'test',
  }).ok, true);

  const stored = store.getTicket(slug, ticket.ref);
  assert.equal(stored.status, 'awaiting-oracle');
  assert.equal(stored.oracle.round, 1);
  const expected = `awaiting oracle since ${stored.oracle.at}, round 1, candidate abc1234, ask: Rank the candidates best to worst.`;
  assert.equal(store.pulsePayload(slug, ticket.ref).status, 'awaiting-oracle');
  assert.equal(store.pulsePayload(slug, ticket.ref).oracle.summary, expected);
  assert.equal(store.changesPayload(slug, new Date(0).toISOString()).tickets.find((entry?: any) => entry.ref === ticket.ref).oracle.summary, expected);
  assert.equal(store.listPayload(slug, { brief: true, all: true }).tickets.find((entry?: any) => entry.ref === ticket.ref).status, 'awaiting-oracle');
  assert.equal(store.prepareDispatch(slug, ticket.ref, { sessionId: `oracle-redispatch-${Date.now()}` }).ok, true);
  assert.equal(store.releaseTicket(slug, ticket.ref, 'oracle-projection-cleanup', { status: 'todo', source: 'test', force: true }).ok, true);
});

test('worktree dispatch warnings name ignored missing paths without flagging installed dependencies', () => {
  const ignoredArtifact = 'missing-visibility-artifact/output.json';
  fs.appendFileSync(path.join(PROJECT, '.git', 'info', 'exclude'), `\nmissing-visibility-artifact/\nnode_modules\n`);
  fs.mkdirSync(path.join(PROJECT, 'node_modules'), { recursive: true });
  const missing = store.createTicket(slug, {
    title: 'ignored worktree visibility fixture',
    category: 'dispatch.lifecycle',
    files: [ignoredArtifact],
    description: 'Where: missing-visibility-artifact/output.json. Contract: inspect generated output. Verify: node --test test/dispatch-lifecycle.test.ts.',
    source: 'test',
  });
  const installed = store.createTicket(slug, {
    title: 'installed dependency visibility fixture',
    category: 'dispatch.lifecycle',
    files: ['node_modules'],
    description: 'Where: node_modules. Contract: inspect installed dependencies. Verify: node --test test/dispatch-lifecycle.test.ts.',
    source: 'test',
  });

  const missingPrepared = store.prepareDispatch(slug, missing.ref, { sessionId: `visibility-missing-${Date.now()}` });
  const installedPrepared = store.prepareDispatch(slug, installed.ref, { sessionId: `visibility-installed-${Date.now()}` });
  const missingWarnings = store.dispatchWarnings(missingPrepared.ticket, slug).join('\n');
  const installedWarnings = store.dispatchWarnings(installedPrepared.ticket, slug).join('\n');

  assert.match(missingWarnings, /missing-visibility-artifact\/output\.json/);
  assert.match(missingWarnings, /sharedTree: true, or run inline/);
  assert.doesNotMatch(installedWarnings, /Worktree visibility warning/);
  assert.equal(store.releaseTicket(slug, missing.ref, 'visibility-cleanup', { status: 'todo', source: 'test', force: true }).ok, true);
  assert.equal(store.releaseTicket(slug, installed.ref, 'visibility-cleanup', { status: 'todo', source: 'test', force: true }).ok, true);
});

test('worktree dispatch warns when ignored scoped fixtures are absent from the linked worktree', () => {
  const fixtureDirectory = 'capture-app/data';
  const linkedWorktree = path.join(PROJECT, '.claude', 'worktrees', `visibility-${Date.now()}`);
  fs.appendFileSync(path.join(PROJECT, '.git', 'info', 'exclude'), `\ncapture-app/data/\ncapture-app/node_modules/\n`);
  fs.mkdirSync(path.join(PROJECT, fixtureDirectory), { recursive: true });
  fs.writeFileSync(path.join(PROJECT, fixtureDirectory, 'capture.json'), '{}\n');
  fs.mkdirSync(path.join(PROJECT, 'capture-app', 'node_modules'), { recursive: true });
  fs.mkdirSync(linkedWorktree, { recursive: true });
  const ticket = store.createTicket(slug, {
    title: 'linked worktree fixture visibility',
    category: 'dispatch.lifecycle',
    files: ['capture-app'],
    source: 'test',
  });

  try {
    const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId: `linked-visibility-${Date.now()}` });
    const dispatched = {
      ...prepared.ticket,
      dispatch: { ...prepared.ticket.dispatch, worktree: linkedWorktree },
    };
    const warnings = store.dispatchWarnings(dispatched, slug).join('\n');

    assert.match(warnings, /capture-app\/data/);
    assert.match(warnings, /test results can differ from integration/);
    assert.doesNotMatch(warnings, /capture-app\/node_modules/);
  } finally {
    assert.equal(store.releaseTicket(slug, ticket.ref, 'linked-visibility-cleanup', { status: 'todo', source: 'test', force: true }).ok, true);
    fs.rmSync(path.join(PROJECT, 'capture-app'), { recursive: true, force: true });
    fs.rmSync(path.join(PROJECT, '.claude', 'worktrees'), { recursive: true, force: true });
  }
});

test('dispatch warns when compose bind-mounts the repository root into an isolated worktree', () => {
  const compose = path.join(PROJECT, 'compose.yaml');
  fs.writeFileSync(compose, 'services:\n  app:\n    volumes:\n      - .:/workspace\n');
  const ticket = createFixture('compose worktree compatibility fixture');
  try {
    const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId: `compose-worktree-${Date.now()}` });
    const warnings = store.dispatchWarnings(prepared.ticket, slug).join('\n');
    assert.match(warnings, /compose\.yaml bind-mounts the repository root/);
    assert.match(warnings, /worktreeIsolation: false/);
  } finally {
    assert.equal(store.releaseTicket(slug, ticket.ref, 'compose-worktree-cleanup', { status: 'todo', source: 'test', force: true }).ok, true);
    fs.rmSync(compose, { force: true });
  }
});

test('dispatch ignores unbound terminal attempts and explains the binding failure', () => {
  const ticket = createFixture('unbound repeat failure fixture');
  for (const number of [1, 2]) {
    const sessionId = `unbound-repeat-${number}-${Date.now()}`;
    const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId });
    assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
      sessionId,
      token: prepared.token,
      executor: prepared.ticket.dispatchExecutor,
      agentName: `unbound-repeat-worker-${number}`,
    }).ok, true);
    assert.equal(store.recordDispatchAgentFailure(slug, ticket.ref, {
      token: prepared.token,
      executor: prepared.ticket.dispatchExecutor,
      sessionId,
      taskName: `unbound-repeat-worker-${number}`,
      error: 'Agent stopped after max_tokens',
    }).ok, true);
  }

  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId: `unbound-repeat-3-${Date.now()}` });
  assert.equal(prepared.ticket.dispatch.repeatFailureOverride, undefined);
  assert.match(store.dispatchWarnings(prepared.ticket, slug).join('\n'), /last dispatches never bound.*binding.*no allowRepeatFailure/i);
  assert.equal(store.releaseTicket(slug, ticket.ref, 'unbound-repeat-cleanup', { status: 'todo', source: 'test', force: true }).ok, true);
});

test('dispatch blocks a third terminal no-commit attempt unless explicitly overridden', () => {
  const ticket = createFixture('repeat no-commit dispatch fixture');
  for (const number of [1, 2]) {
    const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId: `repeat-no-commit-${number}-${Date.now()}` });
    const worker = `repeat-no-commit-worker-${number}`;
    assert.equal(store.claimTicket(slug, ticket.ref, worker, {
      token: prepared.token,
      executor: prepared.ticket.dispatchExecutor,
    }).ok, true);
    assert.equal(store.releaseTicket(slug, ticket.ref, worker, { status: 'todo', source: 'test' }).ok, true);
  }

  assert.throws(() => store.prepareDispatch(slug, ticket.ref), (error: any) => {
    assert.match(error.message, /two prior terminal no-commit dispatches.*released at/);
    assert.doesNotMatch(error.message, /Environment visibility/);
    return true;
  });
  const overridden = store.prepareDispatch(slug, ticket.ref, { allowRepeatFailure: true });
  assert.equal(overridden.ticket.dispatch.repeatFailureOverride.priorAttempts, 2);
  assert.equal(store.releaseTicket(slug, ticket.ref, 'repeat-no-commit-cleanup', { status: 'todo', source: 'test', force: true }).ok, true);
});

// The breaker is meant to catch a run that keeps dying with nothing to show,
// and its remedy is an environment hypothesis. An attempt that checkpointed a
// commit disproves that hypothesis: it read the environment fine and simply ran
// out of runway, which is the opposite situation (the-bot-resurrection SQ-611).
test('repeat contradiction releases identify the ticket premise as the likely problem', () => {
  const ticket = createFixture('repeat contradiction dispatch fixture');
  for (const number of [1, 2]) {
    const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId: `repeat-contradiction-${number}-${Date.now()}` });
    const worker = `repeat-contradiction-worker-${number}`;
    assert.equal(store.claimTicket(slug, ticket.ref, worker, {
      token: prepared.token,
      executor: prepared.ticket.dispatchExecutor,
    }).ok, true);
    assert.equal(store.releaseTicket(slug, ticket.ref, worker, {
      status: 'todo',
      source: 'mcp',
      releaseKind: 'contradiction',
      releaseReason: 'The named behavior does not occur.',
      releaseEvidence: { kind: 'contradiction', command: 'node test/probe.js', outputTail: 'observed behavior differs' },
    }).ok, true);
  }

  assert.throws(() => store.prepareDispatch(slug, ticket.ref), (error: any) => {
    assert.match(error.message, /two contradiction releases/);
    assert.match(error.message, /ticket premise is likely wrong, not the executor environment/);
    assert.match(error.message, /Measure the claim, then rewrite the ticket/);
    return true;
  });
  const overridden = store.prepareDispatch(slug, ticket.ref, { allowRepeatFailure: true });
  assert.equal(overridden.ticket.dispatch.repeatFailureOverride.priorAttempts, 2);
  assert.equal(store.releaseTicket(slug, ticket.ref, 'repeat-contradiction-cleanup', { status: 'todo', source: 'test', force: true }).ok, true);
});

test('dispatch does not count an attempt that checkpointed a commit toward the repeat-failure breaker', () => {
  const ticket = createFixture('checkpointed attempt fixture');
  const checkpointCommit = '1590b92abc1234def5678abc1234def5678abcd';
  for (const number of [1, 2]) {
    const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId: `checkpointed-${number}-${Date.now()}` });
    const worker = `checkpointed-worker-${number}`;
    assert.equal(store.claimTicket(slug, ticket.ref, worker, {
      token: prepared.token,
      executor: prepared.ticket.dispatchExecutor,
    }).ok, true);
    if (number === 2) {
      assert.equal(store.checkpointTicket(slug, ticket.ref, worker, {
        commit: checkpointCommit,
        verify: 'Reproduced all six anchors and ran the gate.',
      }).ok, true);
    }
    assert.equal(store.releaseTicket(slug, ticket.ref, worker, { status: 'todo', source: 'test' }).ok, true);
  }

  const attempts = store.getTicket(slug, ticket.ref).dispatch.attempts;
  assert.equal(attempts.at(-1).commit, checkpointCommit);
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId: `checkpointed-3-${Date.now()}` });
  assert.equal(prepared.ticket.dispatch.repeatFailureOverride, undefined);
  assert.equal(store.releaseTicket(slug, ticket.ref, 'checkpointed-cleanup', { status: 'todo', source: 'test', force: true }).ok, true);
});



test('dispatch counts terminal Agent failures toward the repeat-failure breaker', () => {
  const ticket = createFixture('repeat terminal failure dispatch fixture');
  for (const number of [1, 2]) {
    const sessionId = `repeat-terminal-failure-${number}-${Date.now()}`;
    const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId });
    const executor = prepared.ticket.dispatchExecutor;
    const worker = `repeat-terminal-failure-worker-${number}`;
    assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
      sessionId,
      token: prepared.token,
      executor,
      agentName: worker,
    }).ok, true);
    assert.equal(store.bindDispatchAgent(sessionId, executor, `repeat-terminal-failure-agent-${number}`, worker).ok, true);
    assert.equal(store.claimTicket(slug, ticket.ref, worker, {
      sessionId,
      token: prepared.token,
      executor,
    }).ok, true);
    assert.equal(store.recordDispatchAgentFailure(slug, ticket.ref, {
      token: prepared.token,
      executor,
      sessionId,
      taskName: worker,
      agentId: `repeat-terminal-failure-agent-${number}`,
      agentName: worker,
      error: 'Agent stopped after max_tokens',
    }).ok, true);
    assert.equal(store.getTicket(slug, ticket.ref).dispatch.outcome, 'died');
    assert.equal(store.releaseTicket(slug, ticket.ref, worker, { status: 'todo', source: 'test' }).ok, true);
  }

  assert.throws(() => store.prepareDispatch(slug, ticket.ref), /two prior terminal no-commit dispatches.*died at/);
});

test('repeat failures identify isolated missing-app errors as worktree-shaped', () => {
  const ticket = createFixture('repeat worktree-shaped failure fixture');
  for (const number of [1, 2]) {
    const sessionId = `repeat-worktree-failure-${number}-${Date.now()}`;
    const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId });
    const executor = prepared.ticket.dispatchExecutor;
    const worker = `repeat-worktree-failure-worker-${number}`;
    assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
      sessionId,
      token: prepared.token,
      executor,
      agentName: worker,
    }).ok, true);
    assert.equal(store.bindDispatchAgent(sessionId, executor, `repeat-worktree-failure-agent-${number}`, worker).ok, true);
    assert.equal(store.claimTicket(slug, ticket.ref, worker, {
      sessionId,
      token: prepared.token,
      executor,
    }).ok, true);
    assert.equal(store.recordDispatchAgentFailure(slug, ticket.ref, {
      token: prepared.token,
      executor,
      sessionId,
      taskName: worker,
      agentId: `repeat-worktree-failure-agent-${number}`,
      agentName: worker,
      error: 'Vite returned 404 because the app service is missing.',
    }).ok, true);
    assert.equal(store.releaseTicket(slug, ticket.ref, worker, { status: 'todo', source: 'test' }).ok, true);
  }

  assert.throws(() => store.prepareDispatch(slug, ticket.ref), /isolated no-commit dispatches.*died at.*--shared-tree.*sharedTree:true/);
  const overridden = store.prepareDispatch(slug, ticket.ref, { allowRepeatFailure: true });
  assert.equal(store.releaseTicket(slug, ticket.ref, 'repeat-worktree-failure-cleanup', { status: 'todo', source: 'test', force: true }).ok, true);
  assert.equal(overridden.ticket.dispatch.repeatFailureOverride.priorAttempts, 2);
});

test('release and submission clear retain structured rework attempts', () => {
  const ticket = createFixture('structured rework fixture');
  const firstSession = `rework-first-${Date.now()}`;
  const first = store.prepareDispatch(slug, ticket.ref, { sessionId: firstSession });
  const executor = first.ticket.dispatchExecutor;
  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
    sessionId: firstSession,
    token: first.token,
    executor,
    agentName: 'rework-first-worker',
  }).ok, true);
  assert.equal(store.bindDispatchAgent(firstSession, executor, 'rework-agent-1', 'rework-first-worker').ok, true);
  assert.equal(store.claimTicket(slug, ticket.ref, 'rework-first-worker', {
    sessionId: firstSession,
    token: first.token,
    executor,
  }).ok, true);
  assert.equal(store.releaseTicket(slug, ticket.ref, 'rework-first-worker', {
    status: 'todo',
    source: 'test',
  }).ok, true);

  let after = store.getTicket(slug, ticket.ref);
  assert.equal(after.reworkEvents.length, 1);
  assert.equal(after.reworkEvents[0].kind, 'released_to_todo');
  assert.equal(after.reworkEvents[0].attempt.agentId, 'rework-agent-1');
  assert.deepEqual(after.reworkEvents[0].attempt.route, { model: 'sonnet', effort: 'high' });
  assert.equal(after.reworkEvents[0].attempt.outcome, 'released');
  assert.equal(store.releaseTicket(slug, ticket.ref, 'rework-first-worker', {
    status: 'todo',
    source: 'test',
  }).ok, true);
  assert.equal(store.getTicket(slug, ticket.ref).reworkEvents.length, 1);

  const secondSession = `rework-second-${Date.now()}`;
  const second = store.prepareDispatch(slug, ticket.ref, { sessionId: secondSession });
  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
    sessionId: secondSession,
    token: second.token,
    executor,
    agentName: 'rework-second-worker',
  }).ok, true);
  assert.equal(store.bindDispatchAgent(secondSession, executor, 'rework-agent-2', 'rework-second-worker').ok, true);
  assert.equal(store.claimTicket(slug, ticket.ref, 'rework-second-worker', {
    sessionId: secondSession,
    token: second.token,
    executor,
  }).ok, true);
  assert.equal(store.submitTicket(slug, ticket.ref, 'rework-second-worker', {
    commit: 'abc1234def5678',
    source: 'test',
  }).ok, true);
  assert.equal(store.clearSubmission(slug, ticket.ref, { by: 'rework-second-worker', status: 'todo', source: 'test' }).ok, true);

  after = store.getTicket(slug, ticket.ref);
  assert.equal(after.reworkEvents.length, 2);
  assert.equal(after.reworkEvents[1].kind, 'submission_cleared');
  assert.equal(after.reworkEvents[1].attempt.agentId, 'rework-agent-2');
  assert.equal(after.reworkEvents[1].attempt.outcome, 'submitted');
  assert.equal(Object.hasOwn(after.reworkEvents[1], 'submission'), false);
});

test('creation bindings reserve one launched dispatch each within a shared session', () => {
  const sessionId = `creation-allocation-${Date.now()}`;
  const tickets = [createFixture('first creation allocation'), createFixture('second creation allocation')];
  for (const [index, ticket] of tickets.entries()) {
    const dispatch = store.prepareDispatch(slug, ticket.ref, { sessionId });
    assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
      sessionId,
      token: dispatch.token,
      executor: dispatch.ticket.dispatchExecutor,
      agentName: `creation-allocation-${index}`,
    }).ok, true);
  }
  const targets = tickets.map((_, index) => path.join(SIDEQUEST_HOME, 'worktrees', `creation-allocation-${Date.now()}-${index}`));
  const bindings = targets.map((target) => store.bindDispatchWorktreeCreation(slug, sessionId, target));
  assert.equal(bindings.every((binding: any) => binding.ok), true);
  assert.deepEqual(new Set(bindings.map((binding: any) => binding.ref)), new Set(tickets.map((ticket) => ticket.ref)));
  // Re-binding the same checkout is generation-scoped: the owning hook's generation still resolves to its own
  // reservation, and a second caller that carries none is refused rather than handed the live one (SQ-2961).
  assert.equal(store.bindDispatchWorktreeCreation(slug, sessionId, targets[0], bindings[0].attempt).ref, bindings[0].ref);
  assert.equal(store.bindDispatchWorktreeCreation(slug, sessionId, targets[0]).reason, 'missing_attempt');
  assert.equal(store.bindDispatchWorktreeCreation(slug, sessionId, targets[0], bindings[1].attempt).reason, 'stale_attempt');
  assert.equal(store.bindDispatchWorktreeCreation(slug, sessionId, path.join(SIDEQUEST_HOME, 'worktrees', 'creation-allocation-extra')).reason, 'dispatch_binding_unavailable');
  for (let index = 0; index < tickets.length; index += 1) {
    assert.equal(store.releaseTicket(slug, tickets[index].ref, `creation-allocation-${index}`, { status: 'todo', source: 'test', force: true }).ok, true);
  }
});

// SQ-2570/SQ-2884. WorktreeCreate used to resolve the board from the spawning
// session's own checkout, so a worktree dispatch prepared for another repository
// handed back a spawn spec whose lease refused creation and an executor that
// never started. The hook now follows the session id to the board that reserved
// the creation, so a foreign spawning runtime is no longer a refusal while this
// session owns isolated dispatches on one board. Each runtime shape runs as its
// own prepared dispatch with its own catch, so one refusal cannot hide the others.
test('isolated dispatch admits a spawning runtime outside the board repository', () => {
  const foreign = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-dispatch-foreign-repo-'));
  execFileSync('git', ['init', '--quiet', '-b', 'main'], { cwd: foreign });
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: foreign });
  execFileSync('git', ['config', 'user.name', 'Foreign Repository'], { cwd: foreign });
  fs.writeFileSync(path.join(foreign, 'foreign.js'), 'module.exports = 2;\n');
  execFileSync('git', ['add', 'foreign.js'], { cwd: foreign });
  execFileSync('git', ['commit', '--quiet', '-m', 'seed foreign repository'], { cwd: foreign });
  const branch = `cross-project-runtime-${Date.now()}`;
  const linked = path.join(SIDEQUEST_HOME, 'worktrees', branch);
  execFileSync('git', ['worktree', 'add', '--quiet', '-b', branch, linked, 'main'], { cwd: PROJECT });

  const cases = [
    { name: 'another repository', runtimeCwd: foreign },
    { name: 'the project root', runtimeCwd: PROJECT },
    { name: 'a linked worktree of the project', runtimeCwd: linked },
    { name: 'an unreported runtime', runtimeCwd: undefined },
  ];
  const dispatched: string[] = [];
  const outcomes = cases.map((runtime) => {
    const ticket = createFixture(`cross-project runtime ${runtime.name}`);
    try {
      const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId: `cross-project-${Date.now()}`, runtimeCwd: runtime.runtimeCwd });
      dispatched.push(ticket.ref);
      return { name: runtime.name, outcome: prepared.ticket.dispatch.sharedTree === false ? 'isolated' : 'shared' };
    } catch (error: any) {
      return { name: runtime.name, outcome: 'refused', message: String(error?.message || error) };
    }
  });

  try {
    assert.deepEqual(outcomes.map((entry: any) => `${entry.name}: ${entry.outcome}`), [
      'another repository: isolated',
      'the project root: isolated',
      'a linked worktree of the project: isolated',
      'an unreported runtime: isolated',
    ]);
  } finally {
    for (const ref of dispatched) {
      assert.equal(store.releaseTicket(slug, ref, 'cross-project-runtime-cleanup', { status: 'todo', source: 'test', force: true }).ok, true);
    }
    execFileSync('git', ['worktree', 'remove', '--force', linked], { cwd: PROJECT, windowsHide: true });
    execFileSync('git', ['branch', '-D', branch], { cwd: PROJECT, windowsHide: true });
    fs.rmSync(foreign, { recursive: true, force: true });
  }
});

// SQ-2570/SQ-2739. A creation that finds only a prepared dispatch for its session
// is still refused, but it has to say so: "dispatch_binding_unavailable" sent the
// orchestrator hunting for a missing dispatch that was sitting right there.
test('creation binding separates an unrecorded launch from a missing dispatch', () => {
  const sessionId = `creation-refusal-${Date.now()}`;
  const target = path.join(SIDEQUEST_HOME, 'worktrees', `creation-refusal-${Date.now()}`);
  assert.equal(store.bindDispatchWorktreeCreation(slug, sessionId, target).reason, 'dispatch_binding_unavailable');
  const ticket = createFixture('unrecorded launch creation fixture');
  store.prepareDispatch(slug, ticket.ref, { sessionId });
  try {
    const refused = store.bindDispatchWorktreeCreation(slug, sessionId, target);
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'dispatch_launch_unrecorded');
    assert.equal(store.getTicket(slug, ticket.ref).dispatch.outcome, 'prepared');
  } finally {
    assert.equal(store.releaseTicket(slug, ticket.ref, 'unrecorded-launch-cleanup', { status: 'todo', source: 'test', force: true }).ok, true);
  }
});

test('a prepared sibling cannot supply authority for a launched dispatch checkout', () => {
  const sessionId = `prepared-sibling-${Date.now()}`;
  const preparedTicket = createFixture('prepared sibling isolation fixture');
  const launchedTicket = createFixture('launched sibling isolation fixture');
  store.prepareDispatch(slug, preparedTicket.ref, { sessionId });
  const launched = store.prepareDispatch(slug, launchedTicket.ref, { sessionId });
  const executor = launched.ticket.dispatchExecutor;
  assert.equal(store.recordDispatchLaunch(slug, launchedTicket.ref, {
    sessionId,
    token: launched.token,
    executor,
    agentName: 'launched-sibling',
  }).ok, true);
  const worktree = path.join(SIDEQUEST_HOME, 'worktrees', `launched-sibling-${Date.now()}`);
  try {
    assert.equal(store.bindDispatchWorktreeCreation(slug, sessionId, worktree).ref, launchedTicket.ref);
    const expectation = store.dispatchIsolationExpectation({ sessionId, executor });
    assert.equal(expectation.ref, launchedTicket.ref);
    assert.equal(expectation.expectedWorktree, worktrees.canonicalPath(worktree));
    assert.equal(store.getTicket(slug, preparedTicket.ref).dispatch.outcome, 'prepared');
  } finally {
    assert.equal(store.releaseTicket(slug, preparedTicket.ref, 'prepared-sibling-cleanup', { status: 'todo', source: 'test', force: true }).ok, true);
    assert.equal(store.releaseTicket(slug, launchedTicket.ref, 'launched-sibling-cleanup', { status: 'todo', source: 'test', force: true }).ok, true);
  }
});

test('ordinary isolated dispatches preserve native worktree isolation', () => {
  const ticket = createFixture('ordinary isolation fixture');
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId: `ordinary-isolation-${Date.now()}` });
  prepared.ticket.dispatch.integrationTarget = { mode: 'local', branch: 'main' };
  const briefing = agentsync.renderTicketBriefing(prepared.ticket, prepared.token, slug, PROJECT);
  const spawn = agentsync.agentSpawn(
    prepared.ticket.dispatch.launchName,
    agentsync.ticketIsolation(prepared.ticket, prepared.ticket.dispatch.sharedTree),
    null,
    prepared.ticket.dispatchExecutor,
    'Implement the ticket.',
    'ordinary isolation fixture',
  );
  assert.equal(spawn.isolation, 'worktree');
  assert.match(briefing, new RegExp(`git reset --hard ${prepared.ticket.dispatch.baseCommit}`));
  assert.doesNotMatch(briefing, /git rebase --onto/);
  assert.equal(store.releaseTicket(slug, ticket.ref, 'ordinary-isolation-cleanup', { status: 'todo', source: 'test', force: true }).ok, true);
});

test('released handbacks carry registered native worktrees into continuation dispatches', () => {
  const ticket = createFixture('continuation checkpoint fixture');
  const sessionId = `continuation-${Date.now()}`;
  const agentId = `continuation-${Date.now()}`;
  const branch = `worktree-agent-${agentId}`;
  const worktree = worktrees.canonicalPath(path.join(SIDEQUEST_HOME, 'worktrees', `agent-native-parent-${agentId}`, `agent-${agentId}`));
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId });
  const executor = prepared.ticket.dispatchExecutor;
  try {
    assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
      sessionId,
      token: prepared.token,
      executor,
      agentName: agentId,
    }).ok, true);
    assert.equal(store.bindDispatchWorktreeCreation(slug, sessionId, worktree).ok, true);
    execFileSync('git', ['worktree', 'add', '-b', branch, worktree, 'HEAD'], { cwd: PROJECT });
    markCheckoutInstance(worktree);
    assert.equal(store.completeDispatchWorktreeCreation(slug, sessionId, worktree, creationGeneration(slug, sessionId, worktree)).ok, true);
    assert.equal(store.bindDispatchAgent(sessionId, executor, agentId, agentId, worktree).ok, true);
    assert.equal(store.getTicket(slug, ticket.ref).dispatch.worktree, worktrees.canonicalPath(worktree));
    assert.equal(store.claimTicket(slug, ticket.ref, 'continuation-worker', {
      sessionId,
      token: prepared.token,
      executor,
    }).ok, true);
    fs.appendFileSync(path.join(worktree, 'tracked.js'), 'module.exports = 2;\n');
    execFileSync('git', ['add', 'tracked.js'], { cwd: worktree });
    execFileSync('git', ['commit', '--quiet', '-m', 'continuation checkpoint'], { cwd: worktree });
    const checkpoint = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8' }).trim();
    assert.equal(store.releaseTicket(slug, ticket.ref, 'continuation-worker', {
      status: 'todo',
      source: 'test',
      releaseKind: 'handback',
      releaseReason: 'Continue verification in another executor.',
    }).ok, true);
    const releasedDispatch = store.getTicket(slug, ticket.ref).dispatch;
    const releasedAt = releasedDispatch.terminalAt;

    const continued = store.prepareDispatch(slug, ticket.ref, { sessionId: `${sessionId}-next` });
    continued.ticket.dispatch.integrationTarget = { mode: 'local', branch: 'main' };
    const { lease, ...continuation } = continued.ticket.dispatch.continuation;
    assert.deepEqual(continuation, {
      mode: 'retained_worktree_resume',
      ticketRef: ticket.ref,
      sourceWorktree: worktree,
      sourceBranch: branch,
      baseCommit: prepared.ticket.dispatch.baseCommit,
      commit: checkpoint,
      commits: [checkpoint],
      clean: true,
      releasedAt,
      releaseKind: 'handback',
    }, JSON.stringify(continued.ticket.dispatch.continuationFallback));
    assert.equal(lease.dispatchBaseline, prepared.ticket.dispatch.baseCommit);
    assert.equal(lease.observedRevision, checkpoint);
    assert.equal(lease.boundRevision, checkpoint);
    assert.equal(lease.boundGitDirectory, releasedDispatch.worktreeGitDirectory);
    assert.equal(lease.boundCommonGitDirectory, releasedDispatch.worktreeCommonGitDirectory);
    const briefing = agentsync.renderTicketBriefing(continued.ticket, continued.token, slug, PROJECT);
    const spawn = agentsync.agentSpawn(
      continued.ticket.dispatch.launchName,
      agentsync.ticketIsolation(continued.ticket, continued.ticket.dispatch.sharedTree),
      null,
      continued.ticket.dispatchExecutor,
      agentsync.renderDispatchStub(continued.ticket, PROJECT),
      'retained continuation fixture',
    );
    assert.equal(Object.hasOwn(spawn, 'isolation'), false);
    // SQ-2183. The contract used to open with an EnterWorktree call that cannot reach a board-retained
    // worktree, so continuations released without doing any work. The retained tree is reachable by
    // absolute path, which is what the contract must say instead.
    assert.doesNotMatch(briefing, /call EnterWorktree with/);
    assert.match(briefing, /do NOT call EnterWorktree/);
    assert.ok(briefing.includes(`git -C ${worktree} rev-parse HEAD\` equals \`${checkpoint}\``));
    assert.match(briefing, new RegExp(`git rebase --onto ${continued.ticket.dispatch.baseCommit} ${continued.ticket.dispatch.continuation.baseCommit}`));
    assert.match(briefing, /If the rebase conflicts, stop and report the conflict/);
    assert.doesNotMatch(briefing, new RegExp(`git reset --hard ${continued.ticket.dispatch.baseCommit}`));
    assert.doesNotMatch(briefing, /git cherry-pick/);
    assert.ok(store.dispatchWarnings(continued.ticket, slug).some((warning?: any) => warning.includes(`at ${checkpoint}`)));

    const continuationExecutor = continued.ticket.dispatchExecutor;
    const continuationAgentId = `${agentId}-next`;
    assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
      sessionId: `${sessionId}-next`,
      token: continued.token,
      executor: continuationExecutor,
      agentName: continuationAgentId,
    }).ok, true);
    assert.equal(store.bindDispatchAgent(`${sessionId}-next`, continuationExecutor, continuationAgentId, continuationAgentId).ok, true);
    assert.equal(store.claimTicket(slug, ticket.ref, 'continuation-second-worker', {
      sessionId: `${sessionId}-next`,
      token: continued.token,
      executor: continuationExecutor,
    }).ok, true);
    assert.equal(store.getTicket(slug, ticket.ref).dispatch.worktree, worktrees.canonicalPath(worktree));
    assert.equal(store.submitTicket(slug, ticket.ref, 'continuation-second-worker', {
      commit: checkpoint,
      worktree,
      source: 'test',
    }).ok, true);
    assert.equal(store.getTicket(slug, ticket.ref).submission.worktree, worktree);
  } finally {
    store.releaseTicket(slug, ticket.ref, 'continuation-cleanup', { status: 'todo', source: 'test', force: true });
    execFileSync('git', ['worktree', 'remove', '--force', worktree], { cwd: PROJECT });
    execFileSync('git', ['branch', '-D', branch], { cwd: PROJECT });
  }
});

test('continuation refuses a same-path replacement linked checkout', () => {
  const ticket = createFixture('continuation replacement fixture');
  const sessionId = `continuation-replacement-${Date.now()}`;
  const agentId = `continuation-replacement-${Date.now()}`;
  const branch = `worktree-agent-${agentId}`;
  const worktree = worktrees.agentWorktreePath(PROJECT, agentId);
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId });
  const executor = prepared.ticket.dispatchExecutor;
  try {
    assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
      sessionId,
      token: prepared.token,
      executor,
      agentName: agentId,
    }).ok, true);
    assert.equal(store.bindDispatchWorktreeCreation(slug, sessionId, worktree).ok, true);
    execFileSync('git', ['worktree', 'add', '-b', branch, worktree, 'HEAD'], { cwd: PROJECT });
    markCheckoutInstance(worktree);
    assert.equal(store.completeDispatchWorktreeCreation(slug, sessionId, worktree, creationGeneration(slug, sessionId, worktree)).ok, true);
    assert.equal(store.bindDispatchAgent(sessionId, executor, agentId, agentId, worktree).ok, true);
    assert.equal(store.claimTicket(slug, ticket.ref, 'continuation-replacement-worker', {
      sessionId,
      token: prepared.token,
      executor,
    }).ok, true);
    fs.appendFileSync(path.join(worktree, 'tracked.js'), 'module.exports = 8;\n');
    execFileSync('git', ['add', 'tracked.js'], { cwd: worktree });
    execFileSync('git', ['commit', '--quiet', '-m', 'replacement checkpoint'], { cwd: worktree });
    const checkpoint = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8' }).trim();
    assert.equal(store.releaseTicket(slug, ticket.ref, 'continuation-replacement-worker', {
      status: 'todo',
      source: 'test',
      releaseKind: 'handback',
    }).ok, true);
    const releasedDispatch = store.getTicket(slug, ticket.ref).dispatch;
    assert.equal(releasedDispatch.terminalWorktreeRevision, checkpoint);
    const boundGitDirectory = worktrees.canonicalPath(releasedDispatch.worktreeGitDirectory);

    execFileSync('git', ['worktree', 'remove', '--force', worktree], { cwd: PROJECT });
    execFileSync('git', ['worktree', 'add', '--detach', worktree, checkpoint], { cwd: PROJECT });
    const replacementGitDirectory = worktrees.canonicalPath(path.resolve(worktree, execFileSync('git', ['rev-parse', '--git-dir'], {
      cwd: worktree,
      encoding: 'utf8',
    }).trim()));
    assert.equal(replacementGitDirectory, boundGitDirectory);

    const continued = store.prepareDispatch(slug, ticket.ref, { sessionId: `${sessionId}-next` });
    assert.equal(continued.ticket.dispatch.continuation, undefined);
    assert.equal(continued.ticket.dispatch.continuationFallback.reason, 'released_worktree_identity_unavailable');
  } finally {
    store.releaseTicket(slug, ticket.ref, 'continuation-replacement-cleanup', { status: 'todo', source: 'test', force: true });
    if (fs.existsSync(worktree)) execFileSync('git', ['worktree', 'remove', '--force', worktree], { cwd: PROJECT });
    try { execFileSync('git', ['branch', '-D', branch], { cwd: PROJECT }); } catch (_) {}
  }
});

test('dirty released worktrees without commits resume in place for a continuation', () => {
  const ticket = createFixture('dirty continuation fixture');
  const sessionId = `dirty-continuation-${Date.now()}`;
  const agentId = `dirty-continuation-${Date.now()}`;
  const branch = `worktree-agent-${agentId}`;
  const worktree = worktrees.agentWorktreePath(PROJECT, agentId);
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId });
  const executor = prepared.ticket.dispatchExecutor;
  try {
    assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
      sessionId,
      token: prepared.token,
      executor,
      agentName: agentId,
    }).ok, true);
    assert.equal(store.bindDispatchWorktreeCreation(slug, sessionId, worktree).ok, true);
    execFileSync('git', ['worktree', 'add', '-b', branch, worktree, 'HEAD'], { cwd: PROJECT });
    markCheckoutInstance(worktree);
    assert.equal(store.completeDispatchWorktreeCreation(slug, sessionId, worktree, creationGeneration(slug, sessionId, worktree)).ok, true);
    assert.equal(store.bindDispatchAgent(sessionId, executor, agentId, agentId, worktree).ok, true);
    assert.equal(store.claimTicket(slug, ticket.ref, 'dirty-continuation-worker', {
      sessionId,
      token: prepared.token,
      executor,
    }).ok, true);
    fs.appendFileSync(path.join(worktree, 'tracked.js'), 'module.exports = 4;\n');
    assert.equal(store.releaseTicket(slug, ticket.ref, 'dirty-continuation-worker', {
      status: 'todo',
      source: 'test',
    }).ok, true);

    // An integration target is what makes the briefing render its worktree-synchronization step, and that
    // step is the one that used to say discard. Without a target here the fixture silently skipped the
    // section entirely, which is how the instruction shipped uncovered (SQ-2180).
    const continued = store.prepareDispatch(slug, ticket.ref, {
      sessionId: `${sessionId}-next`,
      integrationMode: 'local',
      integrationBranch: 'main',
    });
    assert.equal(continued.ticket.dispatch.continuation.mode, 'dirty_worktree_resume');
    const briefing = agentsync.renderTicketBriefing(continued.ticket, continued.token, slug, PROJECT);
    const spawn = agentsync.agentSpawn(
      continued.ticket.dispatch.launchName,
      agentsync.ticketIsolation(continued.ticket, continued.ticket.dispatch.sharedTree),
      null,
      continued.ticket.dispatchExecutor,
      agentsync.renderDispatchStub(continued.ticket, PROJECT),
      'dirty continuation fixture',
    );
    assert.equal(Object.hasOwn(spawn, 'isolation'), false);
    assert.match(briefing, /with uncommitted work in retained worktree/);
    // SQ-2183, same unreachable contract on the dirty-resume path, where the retained tree is the only
    // copy of the work, so being unable to enter it stranded the ticket outright.
    assert.doesNotMatch(briefing, /call EnterWorktree with/);
    assert.match(briefing, /do NOT call EnterWorktree/);
    assert.ok(briefing.includes(`git -C ${continued.ticket.dispatch.continuation.sourceWorktree} status --porcelain`));
    assert.match(briefing, /never committed and never stashed, so that worktree is the only copy/);
    assert.doesNotMatch(briefing, /git cherry-pick/);
    // SQ-2180. This continuation exists BECAUSE the tree holds uncommitted work, so the sync step must
    // never hand the executor a discard. One did read that instruction and stopped rather than lose 11
    // files that were committed nowhere and stashed nowhere.
    assert.match(briefing, /this worktree holds uncommitted work retained from the previous attempt/);
    assert.match(briefing, /preserve before moving/);
    assert.match(briefing, /git rebase --onto/);
    assert.match(briefing, /never use `git stash`/);
    assert.match(briefing, /Rebase, never merge/);
    assert.doesNotMatch(briefing, /reset --hard/);
    assert.doesNotMatch(briefing, /git checkout --/);

    const continuationExecutor = continued.ticket.dispatchExecutor;
    const continuationAgentId = `${agentId}-next`;
    assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
      sessionId: `${sessionId}-next`,
      token: continued.token,
      executor: continuationExecutor,
      agentName: continuationAgentId,
    }).ok, true);
    assert.equal(store.bindDispatchAgent(`${sessionId}-next`, continuationExecutor, continuationAgentId, continuationAgentId).ok, true);
    assert.equal(store.claimTicket(slug, ticket.ref, 'dirty-continuation-second-worker', {
      sessionId: `${sessionId}-next`,
      token: continued.token,
      executor: continuationExecutor,
    }).ok, true);
    assert.equal(store.getTicket(slug, ticket.ref).dispatch.worktree, worktrees.canonicalPath(worktree));
    assert.deepEqual(store.completionTreeCheck(slug, store.getTicket(slug, ticket.ref)).changedPaths, ['tracked.js']);
  } finally {
    store.releaseTicket(slug, ticket.ref, 'dirty-continuation-cleanup', { status: 'todo', source: 'test', force: true });
    execFileSync('git', ['worktree', 'remove', '--force', worktree], { cwd: PROJECT });
    execFileSync('git', ['branch', '-D', branch], { cwd: PROJECT });
  }
});

// SQ-2938 / GH-125. Baseline A, preserved candidate B on A, newer main C from A. The recovery dispatch
// cherry-picked B into a checkout at C, the cherry-pick conflicted, and the executor released on the
// conflict. Redispatching with an explicit recovery base at A then handed that conflicted checkout to the
// replacement executor: HEAD was C, A was an ancestor of it, so the briefing read the old base's ancestry
// as proof the candidate had been recovered and told the executor to change nothing.
test('a retained checkout with unmerged entries is refused as a continuation even with an explicit recovery base', () => {
  const ticket = createFixture('conflicted recovery checkout fixture');
  const marker = `sq2938-${Date.now()}`;
  const sessionId = `conflicted-recovery-${marker}`;
  const agentId = `conflicted-recovery-${marker}`;
  const branch = `worktree-agent-${agentId}`;
  const candidateBranch = `${marker}-candidate`;
  const recoveryBaseBranch = `${marker}-recovery-base`;
  const manifest = `${marker}-manifest.json`;
  const worktree = worktrees.agentWorktreePath(PROJECT, agentId);
  const project = (args: string[]) => execFileSync('git', args, { cwd: PROJECT, encoding: 'utf8', windowsHide: true });
  const baselineA = project(['rev-parse', 'HEAD']).trim();
  project(['branch', recoveryBaseBranch, baselineA]);
  project(['checkout', '--quiet', '-b', candidateBranch, baselineA]);
  fs.writeFileSync(path.join(PROJECT, manifest), '{"generated":"B"}\n');
  project(['add', manifest]);
  project(['commit', '--quiet', '-m', 'candidate B']);
  project(['checkout', '--quiet', 'main']);
  fs.writeFileSync(path.join(PROJECT, manifest), '{"generated":"C"}\n');
  project(['add', manifest]);
  project(['commit', '--quiet', '-m', 'newer main C']);

  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId });
  const executor = prepared.ticket.dispatchExecutor;
  try {
    assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
      sessionId,
      token: prepared.token,
      executor,
      agentName: agentId,
    }).ok, true);
    assert.equal(store.bindDispatchWorktreeCreation(slug, sessionId, worktree).ok, true);
    execFileSync('git', ['worktree', 'add', '-b', branch, worktree, 'HEAD'], { cwd: PROJECT });
    markCheckoutInstance(worktree);
    assert.equal(store.completeDispatchWorktreeCreation(slug, sessionId, worktree, creationGeneration(slug, sessionId, worktree)).ok, true);
    assert.equal(store.bindDispatchAgent(sessionId, executor, agentId, agentId, worktree).ok, true);
    assert.equal(store.claimTicket(slug, ticket.ref, 'conflicted-recovery-worker', {
      sessionId,
      token: prepared.token,
      executor,
    }).ok, true);

    // The replay the previous recovery attempt was dispatched to run. It conflicts and leaves HEAD where it
    // was, which is exactly why the checkout still looks like a healthy dirty continuation.
    assert.equal(spawnSync('git', ['cherry-pick', candidateBranch], { cwd: worktree, encoding: 'utf8', windowsHide: true }).status === 0, false);
    const conflicted = execFileSync('git', ['status', '--porcelain'], { cwd: worktree, encoding: 'utf8', windowsHide: true });
    assert.match(conflicted, new RegExp(`^AA ${manifest}$`, 'm'));
    assert.equal(store.releaseTicket(slug, ticket.ref, 'conflicted-recovery-worker', {
      status: 'todo',
      source: 'test',
      releaseKind: 'technical_blocker',
      releaseReason: 'the cherry-pick conflicted, so nothing was resolved',
    }).ok, true);

    const continued = store.prepareDispatch(slug, ticket.ref, {
      sessionId: `${sessionId}-next`,
      integrationMode: 'local',
      integrationBranch: recoveryBaseBranch,
      allowRepeatFailure: true,
    });
    assert.equal(continued.ticket.dispatch.continuation, undefined, 'the conflicted checkout is never handed out');
    const fallback = continued.ticket.dispatch.continuationFallback;
    assert.equal(fallback.reason, 'released_worktree_lease_refused');
    assert.ok(fallback.cause.includes(worktrees.canonicalPath(worktree)), 'names the checkout');
    assert.match(fallback.cause, new RegExp(`unmerged paths: ${manifest}`));
    assert.match(fallback.cause, /unfinished cherry-pick/);
    assert.match(fallback.cause, /worktree isolation/);
    assert.match(fallback.cause, /do not auto-resolve or discard/);

    const spawn = agentsync.agentSpawn(
      continued.ticket.dispatch.launchName,
      agentsync.ticketIsolation(continued.ticket, continued.ticket.dispatch.sharedTree),
      null,
      continued.ticket.dispatchExecutor,
      agentsync.renderDispatchStub(continued.ticket, PROJECT),
      'conflicted recovery checkout fixture',
    );
    assert.equal(spawn.isolation, 'worktree', 'the replacement runs in a fresh checkout, not the conflicted one');
    const briefing = agentsync.renderTicketBriefing(continued.ticket, continued.token, slug, PROJECT);
    assert.doesNotMatch(briefing, /change nothing if it passes/);
    assert.match(briefing, /Validation evidence: the retained checkout/);

    // Never auto-resolve or discard: the conflicted checkout and its staged replay stay exactly as released.
    assert.match(execFileSync('git', ['status', '--porcelain'], { cwd: worktree, encoding: 'utf8', windowsHide: true }), new RegExp(`^AA ${manifest}$`, 'm'));
  } finally {
    store.releaseTicket(slug, ticket.ref, 'conflicted-recovery-cleanup', { status: 'todo', source: 'test', force: true });
    execFileSync('git', ['worktree', 'remove', '--force', worktree], { cwd: PROJECT });
    execFileSync('git', ['branch', '-D', branch], { cwd: PROJECT });
    project(['reset', '--hard', baselineA]);
    project(['branch', '-D', candidateBranch, recoveryBaseBranch]);
  }
});

test('dirty released worktrees with checkpoints fall back to cherry-picking the commit range', () => {
  const ticket = createFixture('dirty checkpoint fallback fixture');
  const sessionId = `dirty-checkpoint-${Date.now()}`;
  const agentId = `dirty-checkpoint-${Date.now()}`;
  const branch = `worktree-agent-${agentId}`;
  const worktree = worktrees.agentWorktreePath(PROJECT, agentId);
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId });
  const executor = prepared.ticket.dispatchExecutor;
  try {
    assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
      sessionId,
      token: prepared.token,
      executor,
      agentName: agentId,
    }).ok, true);
    assert.equal(store.bindDispatchWorktreeCreation(slug, sessionId, worktree).ok, true);
    execFileSync('git', ['worktree', 'add', '-b', branch, worktree, 'HEAD'], { cwd: PROJECT });
    markCheckoutInstance(worktree);
    assert.equal(store.completeDispatchWorktreeCreation(slug, sessionId, worktree, creationGeneration(slug, sessionId, worktree)).ok, true);
    assert.equal(store.bindDispatchAgent(sessionId, executor, agentId, agentId, worktree).ok, true);
    assert.equal(store.claimTicket(slug, ticket.ref, 'dirty-checkpoint-worker', {
      sessionId,
      token: prepared.token,
      executor,
    }).ok, true);
    fs.appendFileSync(path.join(worktree, 'tracked.js'), 'module.exports = 5;\n');
    execFileSync('git', ['add', 'tracked.js'], { cwd: worktree });
    execFileSync('git', ['commit', '--quiet', '-m', 'dirty continuation checkpoint'], { cwd: worktree });
    const checkpoint = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8' }).trim();
    fs.appendFileSync(path.join(worktree, 'tracked.js'), 'module.exports = 6;\n');
    assert.equal(store.releaseTicket(slug, ticket.ref, 'dirty-checkpoint-worker', {
      status: 'todo',
      source: 'test',
      releaseKind: 'handback',
      releaseReason: 'Continue from the committed checkpoint.',
    }).ok, true);

    const continued = store.prepareDispatch(slug, ticket.ref, { sessionId: `${sessionId}-next` });
    assert.equal(continued.ticket.dispatch.continuation, undefined);
    assert.deepEqual(continued.ticket.dispatch.continuationFallback.commits, [checkpoint]);
    const briefing = agentsync.renderTicketBriefing(continued.ticket, continued.token, slug, PROJECT);
    assert.match(briefing, new RegExp(`git cherry-pick ${checkpoint}`));
  } finally {
    store.releaseTicket(slug, ticket.ref, 'dirty-checkpoint-cleanup', { status: 'todo', source: 'test', force: true });
    execFileSync('git', ['worktree', 'remove', '--force', worktree], { cwd: PROJECT });
    execFileSync('git', ['branch', '-D', branch], { cwd: PROJECT });
  }
});

test('released handbacks carry checkpoints through 8.3 project aliases', { skip: process.platform !== 'win32' }, (context: { skip: (reason: string) => void }) => {
  const projectAlias = windowsShortPathAlias(PROJECT);
  if (!projectAlias) {
    context.skip('8.3 aliases are disabled for this filesystem.');
    return;
  }
  const aliasSlug = store.ensureProject(projectAlias).slug;
  const ticket = store.createTicket(aliasSlug, {
    title: '8.3 continuation checkpoint fixture',
    category: 'dispatch.lifecycle',
    files: ['tracked.js'],
    source: 'test',
  });
  const sessionId = `continuation-short-path-${Date.now()}`;
  const agentId = `continuation-short-path-${Date.now()}`;
  const branch = `worktree-agent-${agentId}`;
  const worktree = worktrees.agentWorktreePath(projectAlias, agentId);
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  const prepared = store.prepareDispatch(aliasSlug, ticket.ref, { sessionId });
  const executor = prepared.ticket.dispatchExecutor;
  try {
    assert.equal(store.recordDispatchLaunch(aliasSlug, ticket.ref, {
      sessionId,
      token: prepared.token,
      executor,
      agentName: agentId,
    }).ok, true);
    assert.equal(store.bindDispatchWorktreeCreation(aliasSlug, sessionId, worktree).ok, true);
    execFileSync('git', ['worktree', 'add', '-b', branch, worktree, 'HEAD'], { cwd: PROJECT });
    markCheckoutInstance(worktree);
    assert.equal(store.completeDispatchWorktreeCreation(aliasSlug, sessionId, worktree, creationGeneration(aliasSlug, sessionId, worktree)).ok, true);
    assert.equal(store.bindDispatchAgent(sessionId, executor, agentId, agentId, worktree).ok, true);
    assert.equal(store.claimTicket(aliasSlug, ticket.ref, 'continuation-short-path-worker', {
      sessionId,
      token: prepared.token,
      executor,
    }).ok, true);
    fs.appendFileSync(path.join(worktree, 'tracked.js'), 'module.exports = 3;\n');
    execFileSync('git', ['add', 'tracked.js'], { cwd: worktree });
    execFileSync('git', ['commit', '--quiet', '-m', '8.3 continuation checkpoint'], { cwd: worktree });
    const checkpoint = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8' }).trim();
    assert.equal(store.releaseTicket(aliasSlug, ticket.ref, 'continuation-short-path-worker', {
      status: 'todo',
      source: 'test',
      releaseKind: 'handback',
      releaseReason: 'Continue verification in another executor.',
    }).ok, true);

    const continued = store.prepareDispatch(aliasSlug, ticket.ref, { sessionId: `${sessionId}-next` });
    assert.deepEqual(continued.ticket.dispatch.continuation, {
      mode: 'retained_worktree_resume',
      ticketRef: ticket.ref,
      sourceWorktree: worktree,
      sourceBranch: branch,
      baseCommit: prepared.ticket.dispatch.baseCommit,
      commit: checkpoint,
      commits: [checkpoint],
      clean: true,
      releasedAt: store.getTicket(aliasSlug, ticket.ref).dispatch.terminalAt,
      releaseKind: 'handback',
    });
  } finally {
    store.releaseTicket(aliasSlug, ticket.ref, 'continuation-short-path-cleanup', { status: 'todo', source: 'test', force: true });
    execFileSync('git', ['worktree', 'remove', '--force', worktree], { cwd: PROJECT });
    execFileSync('git', ['branch', '-D', branch], { cwd: PROJECT });
  }
});

test('reclaiming an unclaimed isolated dispatch preserves its unknown lease', () => {
  const ticket = createFixture('reclaim unclaimed isolated worktree');
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId: `reclaim-unclaimed-${Date.now()}` });
  const agentId = `reclaim-unclaimed-agent-${ticket.id}`;
  const worktree = worktrees.agentWorktreePath(PROJECT, agentId);
  const branch = `worktree-agent-${agentId}`;
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  execFileSync('git', ['worktree', 'add', '-b', branch, worktree, prepared.ticket.dispatch.baseCommit], { cwd: PROJECT });
  markCheckoutInstance(worktree);
  try {
    const reclaimed = worktrees.reclaimUnclaimedDispatchWorktree(PROJECT, {
      sharedTree: false,
      worktree,
      baseCommit: prepared.ticket.dispatch.baseCommit,
    });
    assert.equal(reclaimed.reclaimed, false);
    assert.equal(reclaimed.reason, 'lease_refused');
    assert.equal(fs.existsSync(worktree), true);
    assert.equal(execFileSync('git', ['rev-parse', '--verify', branch], { cwd: PROJECT, encoding: 'utf8' }).trim().length > 0, true);
  } finally {
    store.releaseTicket(slug, ticket.ref, 'reclaim-unclaimed-cleanup', { status: 'todo', source: 'test', force: true });
    if (fs.existsSync(worktree)) execFileSync('git', ['worktree', 'remove', '--force', worktree], { cwd: PROJECT });
    try { execFileSync('git', ['branch', '-D', branch], { cwd: PROJECT }); } catch (_) {}
  }
});

test('prepared dispatches expire on the configured TTL with an audit comment', () => {
  const ticket = createFixture('prepared expiry fixture');
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId: 'prepared-expiry' });
  const expiresAt = Date.parse(prepared.ticket.dispatch.preparedAt) + store.preparedDispatchTtlMs() + 1;

  const swept = store.sweepStaleDispatches({ project: slug, now: expiresAt, source: 'test' });
  assert.deepEqual(swept.expired.map((entry?: any) => entry.ref), [ticket.ref]);
  const after = store.getTicket(slug, ticket.ref);
  assert.equal(after.dispatch.outcome, 'expired');
  assert.equal(after.dispatchNonce, null);
  assert.equal(after.dispatchExecutor, null);
  assert.match(after.comments.at(-1).body, /Auto-expired prepared dispatch/);
});

test('reconciliation fails unbound launches and preserves bound agents', () => {
  const unboundTicket = createFixture('unbound reload fixture');
  const boundTicket = createFixture('bound reload fixture');
  const sessionId = `restart-${Date.now()}`;
  const unbound = store.prepareDispatch(slug, unboundTicket.ref, { sessionId });
  const bound = store.prepareDispatch(slug, boundTicket.ref, { sessionId });
  const executor = unbound.ticket.dispatchExecutor;

  for (const prepared of [unbound, bound]) {
    assert.equal(store.recordDispatchLaunch(slug, prepared.ticket.ref, {
      sessionId,
      token: prepared.token,
      executor,
      agentName: prepared.ticket.ref,
    }).ok, true);
  }
  assert.equal(store.bindDispatchAgent(sessionId, executor, 'bound-agent', boundTicket.ref).ok, true);

  const reconciled = store.reconcileLaunchedDispatches(sessionId, { source: 'session-start' });
  assert.deepEqual(reconciled.reconciled, [unboundTicket.ref]);
  assert.equal(store.getTicket(slug, unboundTicket.ref).dispatch.outcome, 'failed');
  const survived = store.getTicket(slug, boundTicket.ref);
  assert.equal(survived.dispatch.boundAt != null, true);
  assert.equal(survived.dispatch.outcome, 'launched');
  assert.ok(survived.dispatchNonce);
});

test('re-dispatch supersedes stale tokens and terminal cleanup removes active credentials', () => {
  const ticket = createFixture('superseded dispatch fixture');
  const first = store.prepareDispatch(slug, ticket.ref, { sessionId: 'superseded' });
  const second = store.prepareDispatch(slug, ticket.ref, { sessionId: 'superseded' });
  assert.notEqual(first.token, second.token);
  assert.equal(store.claimTicket(slug, ticket.ref, 'stale-worker', {
    token: first.token,
    executor: first.ticket.dispatchExecutor,
  }).reason, 'token');
  const staleTokenFile = path.join(SIDEQUEST_HOME, `${ticket.ref}-stale.token`);
  fs.writeFileSync(staleTokenFile, `${first.token}\n`);
  const staleClaim = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'sidequest.js'), 'claim', ticket.ref,
    '--project', PROJECT, '--by', 'stale-worker', '--token-file', staleTokenFile, '--executor', first.ticket.dispatchExecutor], {
    encoding: 'utf8',
    env: { ...process.env, SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: PROJECT },
  });
  assert.equal(staleClaim.status, 1);
  assert.match(staleClaim.stdout, /dispatch was superseded by a newer preparation/);
  assert.equal(store.claimTicket(slug, ticket.ref, 'current-worker', {
    token: second.token,
    executor: second.ticket.dispatchExecutor,
  }).ok, true);
  assert.equal(store.completeTicket(slug, ticket.ref, 'current-worker', {
    model: 'sonnet',
    effort: 'high',
    source: 'test',
  }).ok, false);
  assert.equal(store.releaseTicket(slug, ticket.ref, 'current-worker', { status: 'todo', source: 'test' }).ok, true);
  assert.equal(store.completeTicketAsControlPlane(slug, ticket.ref, {
    purpose: 'grooming',
    by: 'board-groomer',
    reason: 'Verified the superseded-token lifecycle fixture.',
  }).ok, true);
  const after = store.getTicket(slug, ticket.ref);
  assert.equal(after.dispatchNonce, null);
  assert.equal(after.dispatchExecutor, null);
  assert.equal(after.dispatch.terminalAt != null, true);
  assert.equal(after.dispatch.supersededTokens, undefined);
});

test('a stopped attempt cannot invalidate the next dispatch token', () => {
  const ticket = createFixture('attempt-isolated token recovery fixture');
  const firstSession = `attempt-isolation-first-${Date.now()}`;
  const first = store.prepareDispatch(slug, ticket.ref, { sessionId: firstSession });
  const executor = first.ticket.dispatchExecutor;
  const firstAgent = `attempt-isolation-agent-${ticket.id}`;

  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
    sessionId: firstSession,
    token: first.token,
    executor,
    agentName: firstAgent,
  }).ok, true);
  assert.equal(store.bindDispatchAgent(firstSession, executor, firstAgent, firstAgent).ok, true);
  assert.throws(() => store.prepareDispatch(slug, ticket.ref, { sessionId: `attempt-isolation-second-${Date.now()}` }), /live dispatch attempt.*Wait for that executor's terminal hook/);
  assert.equal(store.releaseTicket(slug, ticket.ref, 'first-attempt-worker', { source: 'test' }).reason, 'unclaimed_active_dispatch');

  assert.equal(store.markDispatchStopped(firstSession, executor, firstAgent, firstAgent).stopped, true);
  const stopped = store.getTicket(slug, ticket.ref);
  assert.equal(stopped.dispatch.outcome, 'failed');
  assert.equal(stopped.dispatchNonce, null);

  const second = store.prepareDispatch(slug, ticket.ref, { sessionId: `attempt-isolation-second-${Date.now()}` });
  assert.equal(store.readDispatchBriefing(slug, ticket.ref, second.token).ok, true);
  assert.equal(store.releaseTicket(slug, ticket.ref, 'first-attempt-worker', { source: 'test' }).reason, 'unclaimed_active_dispatch');
  assert.equal(store.readDispatchBriefing(slug, ticket.ref, second.token).ok, true);
  assert.equal(store.releaseTicket(slug, ticket.ref, 'attempt-isolation-cleanup', { status: 'todo', source: 'test', force: true }).ok, true);
});

test('control plane records an abandoned candidate after recovering the dead unclaimed retry', () => {
  const ticket = createFixture('hand-delivered candidate recovery fixture');
  // The dead attempt has to happen before the submission exists. A claim is refused while a submission is
  // pending (reason `submitted`), so a dispatch prepared after one could never be claimed, and SQ-2117 is why
  // preparation refuses there now.
  const deadSession = `dead-retry-${Date.now()}`;
  const dead = store.prepareDispatch(slug, ticket.ref, { sessionId: deadSession });
  const agentName = `dead-retry-agent-${ticket.id}`;
  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
    sessionId: deadSession,
    token: dead.token,
    executor: dead.ticket.dispatchExecutor,
    agentName,
  }).ok, true);
  assert.equal(store.releaseTicket(slug, ticket.ref, 'orchestrator', { source: 'test' }).reason, 'unclaimed_active_dispatch');
  // SQ-2949 finding 1: grooming reads the same retirement authority as dispatch, so a runtime silent
  // for a whole claim grace is what makes this attempt clearable at all.
  backdateRuntimeSignals(ticket.id, CLAIM_GRACE_MS);
  assert.equal(store.clearUnclaimedDispatch(slug, ticket.ref, {
    by: 'orchestrator',
    agentName,
    evidence: 'TaskStop reported this exact agent terminal after its claim refusal.',
  }).ok, true);

  const candidate = store.prepareDispatch(slug, ticket.ref, { sessionId: `candidate-${Date.now()}`, allowRepeatFailure: true });
  const owner = `candidate-owner-${ticket.id}`;
  assert.equal(store.claimTicket(slug, ticket.ref, owner, {
    token: candidate.token,
    executor: candidate.ticket.dispatchExecutor,
  }).ok, true);
  commitFixtureChange();
  assert.equal(store.submitTicket(slug, ticket.ref, owner, {
    commit: 'abcdef1234567',
    source: 'test',
  }).ok, true);

  const recordedCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: PROJECT, encoding: 'utf8' }).trim();
  const closed = store.completeTicketAsControlPlane(slug, ticket.ref, {
    purpose: 'grooming',
    by: 'orchestrator',
    reason: 'Resolved the candidate conflict by hand, then confirmed this candidate never landed.',
    deliveryCommit: recordedCommit,
    abandonSubmission: true,
  });
  assert.equal(closed.ok, true);
  assert.equal(closed.ticket.status, 'done');
  assert.equal(closed.ticket.submission.commit, 'abcdef1234567');
  assert.equal(closed.ticket.submission.integration.outcome, 'abandoned');
  assert.equal(closed.ticket.submission.integration.candidateState, 'unresolvable');
  assert.equal(closed.ticket.completion.delivery, undefined);
});

test('unclaimed pre-runtime delivery names and preserves its manual recovery path', () => {
  const ticket = createFixture('manual pre-runtime delivery fixture');
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId: `manual-pre-runtime-${Date.now()}` });
  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    sessionId: `manual-pre-runtime-${Date.now()}`,
    agentName: `manual-pre-runtime-${ticket.id}`,
  }).ok, true);
  commitFixtureChange();
  const deliveredCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: PROJECT, encoding: 'utf8' }).trim();

  const bareGroomClose = store.completeTicketAsControlPlane(slug, ticket.ref, {
    purpose: 'delivery',
    by: 'control-plane',
    reason: 'The executor ended before its first claim.',
    deliveryCommit: deliveredCommit,
  });
  assert.equal(bareGroomClose.reason, 'active_dispatch');
  assert.match(bareGroomClose.message, /deliveryMethod manual/);
  assert.match(bareGroomClose.message, /recoveryEvidence/);
  assert.match(bareGroomClose.message, /reachable from the recorded integration branch/);
  assert.throws(
    () => store.updateTicket(slug, ticket.ref, { status: 'done' }),
    /deliveryMethod manual[\s\S]*recoveryEvidence/,
  );

  const release = store.releaseTicket(slug, ticket.ref, 'control-plane', { source: 'test' });
  assert.equal(release.reason, 'unclaimed_active_dispatch');
  assert.match(release.message, /deliveryMethod manual/);
  assert.match(release.message, /recoveryEvidence/);
  assert.match(release.message, /reachable from the recorded integration branch/);

  // SQ-2949 finding 1: grooming reads the same retirement authority as dispatch, so a runtime silent
  // for a whole claim grace is what makes this attempt clearable at all.
  backdateRuntimeSignals(ticket.id, CLAIM_GRACE_MS);
  assert.equal(store.clearUnclaimedDispatch(slug, ticket.ref, {
    by: 'control-plane',
    evidence: 'The dispatched executor exited before its first claim.',
  }).ok, true);
  const closed = store.completeTicketAsControlPlane(slug, ticket.ref, {
    purpose: 'delivery',
    by: 'control-plane',
    reason: 'The executor ended before its first claim.',
    deliveryCommit: deliveredCommit,
    deliveryMethod: 'manual',
  });
  assert.equal(closed.ok, true);
  assert.equal(closed.ticket.status, 'done');

  const retireOnly = createFixture('retire-only pre-runtime delivery fixture');
  const retirePrepared = store.prepareDispatch(slug, retireOnly.ref, { sessionId: `retire-only-${Date.now()}` });
  assert.equal(store.recordDispatchLaunch(slug, retireOnly.ref, {
    token: retirePrepared.token,
    executor: retirePrepared.ticket.dispatchExecutor,
    agentName: `retire-only-${retireOnly.id}`,
  }).ok, true);
  const noRuntimeSignal = store.getTicket(slug, retireOnly.ref).dispatch;
  noRuntimeSignal.preparedAt = 'unreadable';
  noRuntimeSignal.launchedAt = 'unreadable';
  independentTicketWrite(slug, retireOnly.id, { dispatch: noRuntimeSignal });
  const retired = store.prepareDispatch(slug, retireOnly.ref, {
    recoveryEvidence: 'The executor exited before its first claim.',
    retireOnly: true,
  });
  assert.equal(retired.ok, true);
  assert.equal(retired.retired, true);
  assert.equal(retired.ticket.dispatchNonce, null);
  assert.equal(retired.ticket.dispatch.failureShape, 'unclaimed_launch_superseded');
  const retireClosed = store.completeTicketAsControlPlane(slug, retireOnly.ref, {
    purpose: 'delivery',
    by: 'control-plane',
    reason: 'The executor ended before its first claim.',
    deliveryCommit: deliveredCommit,
    deliveryMethod: 'manual',
  });
  assert.equal(retireClosed.ok, true);

  const bound = createFixture('bound manual delivery guard fixture');
  const boundSession = `bound-manual-delivery-${Date.now()}`;
  const boundPrepared = store.prepareDispatch(slug, bound.ref, { sessionId: boundSession, sharedTree: true });
  const boundAgent = `bound-manual-delivery-${bound.id}`;
  assert.equal(store.recordDispatchLaunch(slug, bound.ref, {
    token: boundPrepared.token,
    executor: boundPrepared.ticket.dispatchExecutor,
    sessionId: boundSession,
    agentName: boundAgent,
  }).ok, true);
  assert.equal(store.bindDispatchAgent(boundSession, boundPrepared.ticket.dispatchExecutor, boundAgent, boundAgent).ok, true);
  const boundGroomClose = store.completeTicketAsControlPlane(slug, bound.ref, {
    purpose: 'delivery',
    by: 'control-plane',
    reason: 'The executor is still live.',
    deliveryCommit: deliveredCommit,
    deliveryMethod: 'manual',
  });
  assert.equal(boundGroomClose.reason, 'active_dispatch');
  assert.doesNotMatch(boundGroomClose.message, /deliveryMethod manual/);
  // Grooming reaches a bound-unclaimed attempt through the same authority as dispatch now, so a live one is
  // refused by its countdown rather than by a blanket "bound" rule (SQ-2951).
  const boundClear = store.clearUnclaimedDispatch(slug, bound.ref, {
    by: 'control-plane',
    evidence: 'A live bound executor must not be retired by grooming.',
  });
  assert.equal(boundClear.ok, false);
  assert.equal(boundClear.reason, 'unclaimed_launch_not_supersedable');
  assert.match(boundClear.message, /becomes retirable on evidence at .*, in \d+ minutes?, unless/);
  assert.equal(store.getTicket(slug, bound.ref).dispatch.terminalAt, null);
  assert.equal(store.releaseTicket(slug, bound.ref, 'control-plane', { force: true, source: 'test' }).ok, true);

  const unreachable = createFixture('unreachable manual delivery fixture');
  const unreachablePrepared = store.prepareDispatch(slug, unreachable.ref, { sessionId: `unreachable-manual-${Date.now()}` });
  assert.equal(store.recordDispatchLaunch(slug, unreachable.ref, {
    token: unreachablePrepared.token,
    executor: unreachablePrepared.ticket.dispatchExecutor,
    agentName: `unreachable-manual-${unreachable.id}`,
  }).ok, true);
  // SQ-2949 finding 1: grooming reads the same retirement authority as dispatch, so a runtime silent
  // for a whole claim grace is what makes this attempt clearable at all.
  backdateRuntimeSignals(unreachable.id, CLAIM_GRACE_MS);
  assert.equal(store.clearUnclaimedDispatch(slug, unreachable.ref, {
    by: 'control-plane',
    evidence: 'The executor ended before its first claim.',
  }).ok, true);
  const unreachableGroomClose = store.completeTicketAsControlPlane(slug, unreachable.ref, {
    purpose: 'delivery',
    by: 'control-plane',
    reason: 'The delivery has not reached the integration branch.',
    deliveryCommit: 'deadbeef',
    deliveryMethod: 'manual',
  });
  assert.equal(unreachableGroomClose.reason, 'delivery_not_reachable');
  assert.match(unreachableGroomClose.message, /not reachable from this ticket's recorded local integration branch/);
});

test('SQ-2117: a pending submission refuses preparation instead of minting an unclaimable attempt', () => {
  const ticket = createFixture('pending submission dispatch refusal fixture');
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId: `pending-submission-${Date.now()}` });
  const owner = `pending-submission-owner-${ticket.id}`;
  assert.equal(store.claimTicket(slug, ticket.ref, owner, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
  }).ok, true);
  commitFixtureChange();
  // Rework preserves the rejected candidate into a quarantine ref, so this one has to be a real commit.
  const candidateCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: PROJECT, encoding: 'utf8' }).trim();
  assert.equal(store.submitTicket(slug, ticket.ref, owner, { commit: candidateCommit, source: 'test' }).ok, true);
  const submitted = store.getTicket(slug, ticket.ref);

  assert.throws(
    () => store.prepareDispatch(slug, ticket.ref, { sessionId: `pending-submission-retry-${Date.now()}` }),
    new RegExp(`has a pending submission \\(${candidateCommit}\\)[\\s\\S]*sidequest integrate[\\s\\S]*sidequest rework[\\s\\S]*--abandon-submission`),
  );

  // The refusal has to leave the submitted attempt on top, because provenance readers take the agent from the
  // current dispatch and a fresh prepared attempt would name one that never touched the candidate.
  const afterRefusal = store.getTicket(slug, ticket.ref);
  assert.equal(afterRefusal.dispatchNonce, submitted.dispatchNonce, 'a refused preparation mints no new token');
  assert.deepEqual(afterRefusal.dispatch, submitted.dispatch, 'the submitted dispatch projection is untouched');
  assert.equal(afterRefusal.submission.commit, candidateCommit);

  // Rework is the path that dispatches again: it clears the submission first, so the same call then works.
  const reworked = store.reworkSubmission(slug, ticket.ref, {
    by: owner,
    review: 'Reviewer found the candidate needs repair.',
    reason: 'Repair the candidate and resubmit.',
    source: 'test',
  });
  assert.equal(reworked.ok, true, `rework must clear the submission: ${reworked.reason || ''} ${reworked.message || ''}`);
  assert.equal(store.getTicket(slug, ticket.ref).submission, null);
  const replacement = store.prepareDispatch(slug, ticket.ref, { sessionId: `pending-submission-rework-${Date.now()}` });
  assert.equal(replacement.ok, true);
  assert.equal(store.releaseTicket(slug, ticket.ref, 'pending-submission-cleanup', { status: 'todo', source: 'test', force: true }).ok, true);
});

test('claim holders can release routed write scope without submitting first', () => {
  const ticket = createFixture('claim-holder release fixture');
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId: `claim-holder-release-${Date.now()}` });
  const owner = `claim-holder-${ticket.id}`;
  assert.equal(store.claimTicket(slug, ticket.ref, owner, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
  }).ok, true);

  assert.equal(store.releaseTicket(slug, ticket.ref, owner, { status: 'todo', source: 'test' }).ok, true);
  const released = store.getTicket(slug, ticket.ref);
  assert.equal(released.claim, null);
  assert.equal(released.dispatchNonce, null);
});

test('ordinary, resumed, and reworked launches all carry a readable name and the route prefix', () => {
  const ticket = createFixture('Rebuild the release engine safely');
  const sessionId = `launch-name-${Date.now()}`;
  const ordinary = store.prepareDispatch(slug, ticket.ref, { sessionId });
  const executor = ordinary.ticket.dispatchExecutor;
  assert.equal(ordinary.ticket.dispatch.launchName, `${ticket.ref.toLowerCase()}-rebuild-release-engine-sonnet-high`);
  assert.equal(ordinary.ticket.dispatch.description, `Claude Sonnet, high · ${ticket.title}`);

  // Re-preparing before anything launched keeps the name: no agent wears it yet.
  const resumed = store.prepareDispatch(slug, ticket.ref, { sessionId });
  assert.notEqual(resumed.token, ordinary.token);
  assert.equal(resumed.ticket.dispatch.launchName, ordinary.ticket.dispatch.launchName);
  assert.equal(resumed.ticket.dispatch.launchSeq, 1);

  // The hook only corrects a launch it can recognise, and recognition is the
  // exact prepared briefing line, so the prompt has to be the prepared stub.
  const prompt = agentsync.renderDispatchStub(resumed.ticket, PROJECT);
  const launch = runForceBypass({
    session_id: sessionId,
    cwd: PROJECT,
    tool_name: 'Agent',
    tool_input: { subagent_type: executor, model: 'sonnet', name: 'orchestrator-invented-name', description: 'paraphrased', prompt },
  });
  assert.equal(launch.hookSpecificOutput.updatedInput.name, resumed.ticket.dispatch.launchName);
  assert.equal(launch.hookSpecificOutput.updatedInput.description, resumed.ticket.dispatch.description);
  assert.match(launch.systemMessage, /corrected prepared dispatch description and name/);

  assert.equal(store.claimTicket(slug, ticket.ref, 'launch-name-worker', {
    sessionId, token: resumed.token, executor,
  }).ok, true);
  assert.equal(store.releaseTicket(slug, ticket.ref, 'launch-name-worker', { status: 'todo', source: 'test' }).ok, true);

  // Rework redispatch: an agent already ran under sequence 1, so the name counts up.
  const rework = store.prepareDispatch(slug, ticket.ref, { sessionId });
  assert.equal(rework.ticket.dispatch.launchSeq, 2);
  assert.equal(rework.ticket.dispatch.launchName, `${ticket.ref.toLowerCase()}-rebuild-release-engine-sonnet-high-2`);
  const reworkLaunch = runForceBypass({
    session_id: sessionId,
    cwd: PROJECT,
    tool_name: 'Agent',
    tool_input: {
      subagent_type: executor,
      model: 'sonnet',
      name: rework.ticket.dispatch.launchName,
      description: rework.ticket.dispatch.description,
      prompt: `Ref: ${ticket.ref}\nbriefing ${ticket.ref} --token-file "${rework.ticket.dispatch.tokenFile}" --project "${PROJECT}"`,
    },
  });
  assert.equal(reworkLaunch.hookSpecificOutput.permissionDecision, undefined);
  assert.equal(reworkLaunch.systemMessage, undefined);
  assert.equal(store.pulsePayload(slug, ticket.ref).dispatch.agentName, rework.ticket.dispatch.launchName);
});

test('a launch whose board record is unreachable still names itself after the ref', () => {
  const unregistered = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-unregistered-'));
  const launch = runForceBypass({
    session_id: 'orphan-launch',
    cwd: PROJECT,
    tool_name: 'Agent',
    tool_input: {
      subagent_type: 'sidequest-exec-high',
      model: 'sonnet',
      description: 'orphan launch',
      prompt: `Work SQ-999999 briefing SQ-999999 --token-file "${path.join(unregistered, 'missing.token')}" --project "${unregistered}"`,
    },
  });
  assert.equal(launch.hookSpecificOutput.updatedInput.name, 'sq-999999');
});

const TEAMMATE_IDLE = path.join(__dirname, '..', 'hooks', 'teammate-idle.js');

// What the harness actually sends: base hook input plus `teammate_name` and
// `team_name`, with no agent id, the idle teammate's own session, and an agent
// type that is not the dispatch executor.
function runTeammateIdle(teammateName?: any) {
  const output = execFileSync(process.execPath, [TEAMMATE_IDLE], {
    input: JSON.stringify({
      session_id: 'the-teammate-own-session',
      transcript_path: path.join(PROJECT, 'teammate.jsonl'),
      cwd: PROJECT,
      permission_mode: 'bypassPermissions',
      agent_type: 'general-purpose',
      hook_event_name: 'TeammateIdle',
      teammate_name: teammateName,
      team_name: 'sidequest',
    }),
    encoding: 'utf8',
    env: { ...process.env, SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: PROJECT },
  });
  return output.trim() ? JSON.parse(output) : null;
}

// Those same fields must not be able to veto a match: only an exact agent id or
// an exact agent name may prove identity.
function finishDispatch(title?: any, options: any = {}) {
  const ticket = store.createTicket(slug, { title, category: 'dispatch.lifecycle', source: 'test' });
  const sessionId = options.sessionId || `idle-${ticket.id}`;
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId, allowUnscoped: true });
  const executor = prepared.ticket.dispatchExecutor;
  const agentName = options.agentName || `idle-teammate-${ticket.id}`;
  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, { sessionId, token: prepared.token, executor, agentName }).ok, true);
  if (options.agentId) assert.equal(store.bindDispatchAgent(sessionId, executor, options.agentId, agentName).ok, true);
  const by = `idle-worker-${ticket.id}`;
  assert.equal(store.claimTicket(slug, ticket.ref, by, { sessionId, token: prepared.token, executor }).ok, true);
  if (options.terminal !== false) {
    const done = store.completeTicket(slug, ticket.ref, by, { sessionId });
    assert.equal(done.ok, true, `completeTicket refused: ${done.reason}`);
  }
  return { ref: ticket.ref, sessionId, executor, agentName };
}

test('an unbound terminal dispatch is matched by teammate name alone', () => {
  const dispatch = finishDispatch('unbound terminal dispatch');
  assert.equal(store.pulsePayload(slug, dispatch.ref).dispatch.agentId, null);

  const matched = store.terminalDispatchForIdle({
    sessionId: 'the-teammate-own-session',
    agentId: '',
    agentName: dispatch.agentName,
    executor: 'general-purpose',
  });
  assert.equal(matched?.ref, dispatch.ref);
  assert.equal(matched.outcome, 'done');
});

test('a bound terminal dispatch still matches on agent id', () => {
  const agentId = `bound-agent-${Date.now()}`;
  const dispatch = finishDispatch('bound terminal dispatch', { agentId });
  assert.equal(store.terminalDispatchForIdle({ sessionId: '', agentId, agentName: '', executor: '' })?.ref, dispatch.ref);
});

test('session and executor alone never identify a teammate', () => {
  const dispatch = finishDispatch('terminal dispatch with no name evidence');
  assert.equal(store.terminalDispatchForIdle({
    sessionId: dispatch.sessionId,
    agentId: 'some-unrelated-agent-id',
    agentName: 'some-unrelated-teammate',
    executor: dispatch.executor,
  }), null);
});

test('an ambiguous teammate name leaves both teammates alone', () => {
  const agentName = `shared-idle-name-${Date.now()}`;
  finishDispatch('first dispatch sharing a name', { agentName });
  finishDispatch('second dispatch sharing a name', { agentName });
  assert.equal(store.terminalDispatchForIdle({ sessionId: '', agentId: '', agentName, executor: '' }), null);
});

test('a working dispatch is never matched, however well its identity lines up', () => {
  const dispatch = finishDispatch('still working dispatch', { terminal: false });
  assert.equal(store.terminalDispatchForIdle({
    sessionId: dispatch.sessionId,
    agentId: '',
    agentName: dispatch.agentName,
    executor: dispatch.executor,
  }), null);
});

test('the former TeammateIdle payload does not wake a terminal executor', () => {
  const dispatch = finishDispatch('terminal dispatch meeting the former payload');
  assert.equal(runTeammateIdle(dispatch.agentName), null);
});

test('the harness TeammateIdle payload leaves a working executor alone', () => {
  const dispatch = finishDispatch('working dispatch meeting the real payload', { terminal: false });
  assert.equal(runTeammateIdle(dispatch.agentName), null);
});

test('SQ-971: TeammateIdle leaves a claimed rejected-submission checkpoint active', () => {
  const ticket = createFixture('rejected submission idle checkpoint');
  const sessionId = `rejected-idle-${ticket.id}`;
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId });
  const executor = prepared.ticket.dispatchExecutor;
  const agentName = `rejected-idle-agent-${ticket.id}`;
  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, { sessionId, token: prepared.token, executor, agentName }).ok, true);
  const by = `rejected-idle-worker-${ticket.id}`;
  assert.equal(store.claimTicket(slug, ticket.ref, by, { sessionId, token: prepared.token, executor }).ok, true);
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: PROJECT, encoding: 'utf8' }).trim();
  execFileSync('git', ['update-ref', `refs/sidequest/${ticket.ref}-rejected`, commit], { cwd: PROJECT });
  assert.equal(store.checkpointTicket(slug, ticket.ref, by, {
    commit,
    worktree: PROJECT,
    verify: 'npm test passed',
    kind: 'submission_rejected',
    gitRef: `refs/sidequest/${ticket.ref}-rejected`,
    failure: { reason: 'base_not_reachable', message: 'fixture' },
  }).ok, true);

  assert.equal(runTeammateIdle(agentName), null);
  const after = store.getTicket(slug, ticket.ref);
  assert.equal(after.claim.by, by);
  assert.equal(after.dispatch.terminalAt, null);
  assert.equal(after.checkpoint.kind, 'submission_rejected');
});

// SQ-923: a shared-tree executor commits on the integration branch itself, so
// "wrote nothing" and "committed and never submitted" look identical after the
// fact unless the dispatch remembers where the run started.
test('a prepared dispatch records the commit its run starts from, and where its executor works', () => {
  const ticket = createFixture('dispatch baseline for closeout proof');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: PROJECT, encoding: 'utf8' }).trim();
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId: 'baseline-session' });
  assert.equal(prepared.ticket.dispatch.baseCommit, head);

  assert.equal(store.dispatchWorkspace(slug, prepared.ticket), null, 'an unbound isolated dispatch has no locatable worktree');
  const worktree = worktrees.agentWorktreePath(PROJECT, 'a923baseline');
  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    sessionId: 'baseline-session',
    agentName: 'baseline-agent',
  }).ok, true);
  assert.equal(store.bindDispatchWorktreeCreation(slug, 'baseline-session', worktree).ok, true);
  assert.equal(store.dispatchWorkspace(slug, store.getTicket(slug, ticket.ref)), null, 'a bound worktree that is not there is not a workspace');
  execFileSync('git', ['worktree', 'add', '--quiet', '-b', 'agent-a923baseline', worktree, 'HEAD'], { cwd: PROJECT });
  markCheckoutInstance(worktree);
  assert.equal(store.bindDispatchAgent('baseline-session', prepared.ticket.dispatchExecutor, 'a923baseline', 'baseline-agent', worktree).ok, true);
  assert.deepEqual(store.dispatchWorkspace(slug, store.getTicket(slug, ticket.ref)), { root: worktrees.canonicalPath(worktree), base: head });

  const shared = createFixture('shared-tree dispatch baseline');
  const preparedShared = store.prepareDispatch(slug, shared.ref, { sharedTree: true });
  assert.deepEqual(store.dispatchWorkspace(slug, preparedShared.ticket), { root: PROJECT, base: head });
});

test('SQ-971: a dispatch records its feature integration target separately from board config', () => {
  const branch = `feature-target-${Date.now()}`;
  const defaultHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: PROJECT, encoding: 'utf8' }).trim();
  const featureHead = execFileSync('git', ['commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'feature target base'], { cwd: PROJECT, encoding: 'utf8' }).trim();
  execFileSync('git', ['update-ref', `refs/heads/${branch}`, featureHead], { cwd: PROJECT });
  const ticket = createFixture('feature integration target');
  const prepared = store.prepareDispatch(slug, ticket.ref, {
    sessionId: 'feature-target-session',
    integrationBranch: branch,
    integrationMode: 'local',
  });
  assert.deepEqual(prepared.ticket.dispatch.integrationTarget, {
    mode: 'local',
    upstream: branch,
    branch,
  });
  assert.equal(prepared.ticket.dispatch.baseCommit, featureHead);
  assert.notEqual(prepared.ticket.dispatch.baseCommit, defaultHead);
  assert.notEqual(store.boardConfig(slug).integrationBranch, branch);
});

test('a dispatch records the configured local integration branch without an override', () => {
  const branch = `configured-target-${Date.now()}`;
  const defaultHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: PROJECT, encoding: 'utf8' }).trim();
  const targetHead = execFileSync('git', ['commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'configured target base'], { cwd: PROJECT, encoding: 'utf8' }).trim();
  execFileSync('git', ['update-ref', `refs/heads/${branch}`, targetHead], { cwd: PROJECT });
  store.setBoardConfig(slug, { integrationMode: 'local', integrationBranch: branch });
  try {
    const ticket = createFixture('configured local integration target');
    const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId: 'configured-target-session' });
    assert.deepEqual(prepared.ticket.dispatch.integrationTarget, {
      mode: 'local',
      upstream: branch,
      branch,
    });
    assert.equal(prepared.ticket.dispatch.baseCommit, targetHead);
    assert.notEqual(prepared.ticket.dispatch.baseCommit, defaultHead);
  } finally {
    store.setBoardConfig(slug, { integrationMode: 'auto', integrationBranch: 'main' });
  }
});

test('configured worktree bases apply to readonly isolated dispatches without changing current-tree defaults', () => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-dispatch-worktree-base-'));
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-dispatch-worktree-base-remote-'));
  const executorParent = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-dispatch-worktree-executor-'));
  let worktreeSequence = 0;
  try {
    execFileSync('git', ['init', '--quiet', '-b', 'main'], { cwd: repository });
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: repository });
    execFileSync('git', ['config', 'user.name', 'Dispatch Lifecycle Test'], { cwd: repository });
    fs.writeFileSync(path.join(repository, 'tracked.js'), 'module.exports = "origin";\n');
    execFileSync('git', ['add', 'tracked.js'], { cwd: repository });
    execFileSync('git', ['commit', '--quiet', '-m', 'origin sentinel'], { cwd: repository });
    execFileSync('git', ['init', '-b', 'main', '--bare', remote], { windowsHide: true });
    execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: repository });
    execFileSync('git', ['push', '--quiet', '-u', 'origin', 'main'], { cwd: repository });
    const originMain = execFileSync('git', ['rev-parse', 'origin/main'], { cwd: repository, encoding: 'utf8' }).trim();

    fs.writeFileSync(path.join(repository, 'tracked.js'), 'module.exports = "local";\n');
    execFileSync('git', ['commit', '--quiet', '-am', 'local sentinel'], { cwd: repository });
    const localMain = execFileSync('git', ['rev-parse', 'main'], { cwd: repository, encoding: 'utf8' }).trim();

    execFileSync('git', ['checkout', '--quiet', '-b', 'feature'], { cwd: repository });
    fs.writeFileSync(path.join(repository, 'tracked.js'), 'module.exports = "feature";\n');
    execFileSync('git', ['commit', '--quiet', '-am', 'feature sentinel'], { cwd: repository });
    const featureHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();

    execFileSync('git', ['checkout', '--quiet', '-b', 'candidate'], { cwd: repository });
    fs.writeFileSync(path.join(repository, 'tracked.js'), 'module.exports = "candidate";\n');
    execFileSync('git', ['commit', '--quiet', '-am', 'candidate sentinel'], { cwd: repository });
    const candidateCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
    execFileSync('git', ['checkout', '--quiet', 'feature'], { cwd: repository });

    const baseSlug = store.ensureProject(repository, 'dispatch worktree base').slug;
    const localTarget = { mode: 'local', upstream: 'main', branch: 'main' };
    const remoteTarget = { mode: 'remote', upstream: 'origin/main', branch: 'main' };
    const assertCreatedWorktree = (dispatch: { ticket: { dispatch: { baseCommit: string } } }, expectedBase: string) => {
      const worktree = path.join(executorParent, `executor-${worktreeSequence++}`);
      execFileSync('git', ['worktree', 'add', '--quiet', '--detach', worktree, dispatch.ticket.dispatch.baseCommit], { cwd: repository });
      try {
        assert.equal(dispatch.ticket.dispatch.baseCommit, expectedBase);
        assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8' }).trim(), expectedBase);
      } finally {
        execFileSync('git', ['worktree', 'remove', '--force', worktree], { cwd: repository, windowsHide: true });
      }
    };
    const prepare = (title: string, category: string, expectedBase: string, options: Record<string, unknown> = {}) => {
      const ticket = store.createTicket(baseSlug, { title, category, files: ['tracked.js'] });
      const dispatch = store.prepareDispatch(baseSlug, ticket.ref, { sessionId: `${title}-${Date.now()}-${worktreeSequence}`, ...options });
      assertCreatedWorktree(dispatch, expectedBase);
      return dispatch;
    };

    store.setBoardConfig(baseSlug, { worktreeBase: 'local-main' });
    const writerLocal = prepare('writer configured local main', 'dispatch.lifecycle', localMain);
    assert.deepEqual(writerLocal.ticket.dispatch.integrationTarget, localTarget);
    const submissionWorktree = path.join(executorParent, `submission-${worktreeSequence++}`);
    execFileSync('git', ['worktree', 'add', '--quiet', '-b', `submission-${Date.now()}`, submissionWorktree, writerLocal.ticket.dispatch.baseCommit], { cwd: repository });
    try {
      fs.appendFileSync(path.join(submissionWorktree, 'tracked.js'), 'module.exports = "submission";\n');
      execFileSync('git', ['commit', '--quiet', '-am', 'submission sentinel'], { cwd: submissionWorktree });
      const submissionCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: submissionWorktree, encoding: 'utf8' }).trim();
      const gitRef = `refs/sidequest/${writerLocal.ticket.ref}`;
      execFileSync('git', ['update-ref', gitRef, submissionCommit], { cwd: submissionWorktree });
      const submissionFacts = collectGitSubmissionFacts({
        slug: baseSlug,
        ticket: writerLocal.ticket,
        root: submissionWorktree,
        commit: submissionCommit,
        gitRef,
      });
      assert.equal(submissionFacts.range.ok, true);
      assert.equal(submissionFacts.range.base, localMain);
      assert.equal(submissionFacts.range.upstream, 'main');
    } finally {
      execFileSync('git', ['worktree', 'remove', '--force', submissionWorktree], { cwd: repository, windowsHide: true });
    }
    const readonlyLocal = prepare('readonly configured local main', 'research', localMain);
    assert.deepEqual(readonlyLocal.ticket.dispatch.integrationTarget, localTarget);

    store.setBoardConfig(baseSlug, { worktreeBase: 'origin-main' });
    const writerRemote = prepare('writer configured origin main', 'dispatch.lifecycle', originMain);
    assert.deepEqual(writerRemote.ticket.dispatch.integrationTarget, remoteTarget);
    const readonlyRemote = prepare('readonly configured origin main', 'research', originMain);
    assert.deepEqual(readonlyRemote.ticket.dispatch.integrationTarget, remoteTarget);

    store.setBoardConfig(baseSlug, { worktreeBase: 'auto' });
    const writerAuto = prepare('writer auto worktree base', 'dispatch.lifecycle', localMain);
    assert.deepEqual(writerAuto.ticket.dispatch.integrationTarget, localTarget);
    const readonlyAuto = prepare('readonly auto worktree base', 'research', featureHead);
    assert.equal(readonlyAuto.ticket.dispatch.integrationTarget, undefined);

    store.setBoardConfig(baseSlug, { worktreeBase: 'origin-main' });
    const writerExplicitLocal = prepare('writer explicit local override', 'dispatch.lifecycle', localMain, { integrationMode: 'local' });
    assert.deepEqual(writerExplicitLocal.ticket.dispatch.integrationTarget, localTarget);
    const readonlyExplicitLocal = prepare('readonly explicit local override', 'research', localMain, { integrationMode: 'local' });
    assert.deepEqual(readonlyExplicitLocal.ticket.dispatch.integrationTarget, localTarget);

    store.setBoardConfig(baseSlug, { worktreeBase: 'local-main' });
    const writerExplicitRemote = prepare('writer explicit remote override', 'dispatch.lifecycle', originMain, { integrationMode: 'remote' });
    assert.deepEqual(writerExplicitRemote.ticket.dispatch.integrationTarget, remoteTarget);
    const readonlyExplicitRemote = prepare('readonly explicit remote override', 'research', originMain, { integrationMode: 'remote' });
    assert.deepEqual(readonlyExplicitRemote.ticket.dispatch.integrationTarget, remoteTarget);

    execFileSync('git', ['push', '--quiet', 'origin', 'main'], { cwd: repository });
    store.setBoardConfig(baseSlug, { worktreeBase: 'auto' });
    const writerAutoSynced = prepare('writer auto synced worktree base', 'dispatch.lifecycle', localMain);
    assert.deepEqual(writerAutoSynced.ticket.dispatch.integrationTarget, remoteTarget);

    const sharedArtifact = store.createTicket(baseSlug, {
      title: 'shared tree artifact keeps checkout base',
      description: 'Shared-tree artifact mode: leave the generated map as working-tree output; verify, comment, and close with done. Do not commit, submit, push, or edit source.',
      category: 'codebase-exploration',
      files: ['.claude/.codebase-info'],
    });
    const sharedArtifactDispatch = store.prepareDispatch(baseSlug, sharedArtifact.ref, { sessionId: 'shared-tree-artifact-base', sharedTree: true, runtimeCwd: repository });
    assertCreatedWorktree(sharedArtifactDispatch, featureHead);
    assert.equal(sharedArtifactDispatch.ticket.dispatch.artifactMode, true);
    assert.equal(sharedArtifactDispatch.ticket.dispatch.integrationTarget, undefined);

    const source = store.createTicket(baseSlug, { title: 'candidate source', category: 'dispatch.lifecycle', files: ['tracked.js'] });
    const terminalAt = new Date().toISOString();
    Object.assign(source, {
      status: 'doing',
      claim: null,
      dispatch: {
        terminalAt,
        outcome: 'submitted',
        agentId: 'candidate-source-agent',
        attempts: [{ outcome: 'submitted', commit: candidateCommit, agentId: 'candidate-source-agent', terminalAt }],
      },
      submission: {
        by: 'candidate-source-worker',
        at: terminalAt,
        commit: candidateCommit,
        verify: 'manual: synthetic candidate',
        changedPaths: ['tracked.js'],
        integratedAt: null,
      },
    });
    const db = require('../lib/db.js');
    db.putRow(db.openDb(SIDEQUEST_HOME), 'tickets', {
      id: source.id,
      project: baseSlug,
      ref: source.ref,
      status: source.status,
      archived: 0,
      ord: source.order,
      claim_by: null,
      data: source,
    });
    const candidateReview = store.createTicket(
      baseSlug,
      { title: 'candidate base wins over configured and explicit target', category: 'review-audit', files: ['tracked.js'] },
      { ref: source.ref, commit: candidateCommit },
    );
    const candidateReviewDispatch = store.prepareDispatch(baseSlug, candidateReview.ref, {
      sessionId: 'candidate-review-base',
      integrationMode: 'remote',
    });
    assertCreatedWorktree(candidateReviewDispatch, candidateCommit);
    assert.deepEqual(candidateReviewDispatch.ticket.dispatch.integrationTarget, remoteTarget);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(remote, { recursive: true, force: true });
    fs.rmSync(executorParent, { recursive: true, force: true });
  }
});

test('SQ-2777: a dispatch refuses to baseline on an unpublished release tip, and the teardown it names restores a clean submission range', () => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-release-tip-'));
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-release-tip-remote-'));
  const executorParent = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-release-tip-executor-'));
  const git = (args: string[], cwd: string = repository) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
  try {
    git(['init', '--quiet', '-b', 'main']);
    git(['config', 'user.email', 'test@example.invalid']);
    git(['config', 'user.name', 'Dispatch Lifecycle Test']);
    fs.writeFileSync(path.join(repository, 'tracked.js'), 'module.exports = "base";\n');
    git(['add', 'tracked.js']);
    git(['commit', '--quiet', '-m', 'pushed base']);
    execFileSync('git', ['init', '-b', 'main', '--bare', remote], { windowsHide: true });
    git(['remote', 'add', 'origin', remote]);
    git(['push', '--quiet', '-u', 'origin', 'main']);
    const pushedBase = git(['rev-parse', 'origin/main']);

    // What `cut.mjs` has done by the time it starts the release suites: the version
    // and changelog commit, then its annotated tag set. Nothing is pushed yet. This is
    // the ordinary shape, where a plugin moved and so carries its own tag too.
    fs.writeFileSync(path.join(repository, 'release.txt'), 'sidequest 9.9.9\n');
    git(['add', 'release.txt']);
    git(['commit', '--quiet', '-m', 'release v9.9.9: sidequest 9.9.9 (SQ-0001)']);
    const releaseTip = git(['rev-parse', 'main']);
    git(['tag', '-a', 'v9.9.9', '-m', 'release v9.9.9: sidequest 9.9.9 (SQ-0001)']);
    git(['tag', '-a', 'sidequest-v9.9.9', '-m', 'sidequest 9.9.9 (v9.9.9)']);

    const tipSlug = store.ensureProject(repository, 'unpublished release tip').slug;
    const refused = store.createTicket(tipSlug, { title: 'dispatched while a cut is in flight', category: 'dispatch.lifecycle', files: ['tracked.js'] });
    // Every tag on the tip is named, not just the one that decided the match: the
    // refusal tells the reader to delete "those tags", so an incomplete list leaves
    // `sidequest-v9.9.9` behind to collide with the retry cut (SQ-2787).
    assert.throws(
      () => store.prepareDispatch(tipSlug, refused.ref, { sessionId: 'release-tip-refused' }),
      /unpublished release commit, tagged sidequest-v9\.9\.9, v9\.9\.9 and not yet on the remote branch/,
    );
    // Only a DIRECT cut can leave this state. Preparation creates no tag and finalize
    // tags a commit the remote already carries, so naming the flow generically sent
    // operators looking for a failed finalize that cannot produce it (SQ-2826).
    assert.throws(
      () => store.prepareDispatch(tipSlug, refused.ref, { sessionId: 'release-tip-refused' }),
      /A direct release cut tags its commit before running its suites[\s\S]*prepare\/finalize flow never reaches this state/,
    );
    assert.equal(store.getTicket(tipSlug, refused.ref).dispatch, undefined);

    // What the refusal averts, measured through the wire it would have used:
    // WorktreeCreate forks the executor checkout from dispatch.baseCommit, which
    // here would have been the release tip, so the candidate stays descended from a
    // commit the branch rewinds past and the range picks up the release commit too.
    const forked = path.join(executorParent, 'forked-from-release-tip');
    git(['worktree', 'add', '--quiet', '-b', 'forked-candidate', forked, releaseTip]);
    fs.writeFileSync(path.join(forked, 'tracked.js'), 'module.exports = "candidate";\n');
    git(['commit', '--quiet', '-am', 'candidate sentinel'], forked);
    const forkedCandidate = git(['rev-parse', 'HEAD'], forked);
    git(['update-ref', `refs/sidequest/${refused.ref}`, forkedCandidate], forked);

    // The teardown the refusal names: delete the tag, reset the branch.
    git(['tag', '-d', 'v9.9.9']);
    git(['reset', '--hard', '--quiet', pushedBase]);

    const avertedFacts = collectGitSubmissionFacts({
      slug: tipSlug,
      ticket: store.getTicket(tipSlug, refused.ref),
      root: forked,
      commit: forkedCandidate,
      gitRef: `refs/sidequest/${refused.ref}`,
    });
    assert.equal(avertedFacts.range.ok, true);
    assert.deepEqual(avertedFacts.range.commits, [releaseTip, forkedCandidate]);
    assert.ok(avertedFacts.range.changedPaths.includes('release.txt'));
    git(['worktree', 'remove', '--force', forked]);

    // After the teardown the same dispatch prepares, and the same WorktreeCreate-shaped
    // fork of the recorded baseline submits a range holding only its own commit.
    const recovered = store.createTicket(tipSlug, { title: 'dispatched after the teardown', category: 'dispatch.lifecycle', files: ['tracked.js'] });
    const prepared = store.prepareDispatch(tipSlug, recovered.ref, { sessionId: 'release-tip-recovered' });
    assert.equal(prepared.ticket.dispatch.baseCommit, pushedBase);
    const recoveredWorktree = path.join(executorParent, 'forked-after-teardown');
    git(['worktree', 'add', '--quiet', '-b', 'recovered-candidate', recoveredWorktree, prepared.ticket.dispatch.baseCommit]);
    fs.writeFileSync(path.join(recoveredWorktree, 'tracked.js'), 'module.exports = "recovered";\n');
    git(['commit', '--quiet', '-am', 'recovered candidate sentinel'], recoveredWorktree);
    const recoveredCandidate = git(['rev-parse', 'HEAD'], recoveredWorktree);
    git(['update-ref', `refs/sidequest/${recovered.ref}`, recoveredCandidate], recoveredWorktree);
    const recoveredFacts = collectGitSubmissionFacts({
      slug: tipSlug,
      ticket: prepared.ticket,
      root: recoveredWorktree,
      commit: recoveredCandidate,
      gitRef: `refs/sidequest/${recovered.ref}`,
    });
    assert.equal(recoveredFacts.range.ok, true);
    assert.equal(recoveredFacts.range.base, pushedBase);
    assert.deepEqual(recoveredFacts.range.commits, [recoveredCandidate]);
    assert.deepEqual(recoveredFacts.range.changedPaths, ['tracked.js']);
    git(['worktree', 'remove', '--force', recoveredWorktree]);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(remote, { recursive: true, force: true });
    fs.rmSync(executorParent, { recursive: true, force: true });
  }
});

test('an unpushed local commit without an annotated marketplace release tag keeps its local baseline', () => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-release-tip-ordinary-'));
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-release-tip-ordinary-remote-'));
  const git = (args: string[], cwd: string = repository) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
  try {
    git(['init', '--quiet', '-b', 'main']);
    git(['config', 'user.email', 'test@example.invalid']);
    git(['config', 'user.name', 'Dispatch Lifecycle Test']);
    fs.writeFileSync(path.join(repository, 'tracked.js'), 'module.exports = "base";\n');
    git(['add', 'tracked.js']);
    git(['commit', '--quiet', '-m', 'pushed base']);
    execFileSync('git', ['init', '-b', 'main', '--bare', remote], { windowsHide: true });
    git(['remote', 'add', 'origin', remote]);
    git(['push', '--quiet', '-u', 'origin', 'main']);

    fs.writeFileSync(path.join(repository, 'tracked.js'), 'module.exports = "local";\n');
    git(['commit', '--quiet', '-am', 'ordinary unpushed commit']);
    const localMain = git(['rev-parse', 'main']);

    const ordinarySlug = store.ensureProject(repository, 'ordinary unpushed commit').slug;
    const ticket = store.createTicket(ordinarySlug, { title: 'dispatched over an ordinary unpushed commit', category: 'dispatch.lifecycle', files: ['tracked.js'] });
    const prepared = store.prepareDispatch(ordinarySlug, ticket.ref, { sessionId: 'ordinary-unpushed-baseline' });
    assert.equal(prepared.ticket.dispatch.baseCommit, localMain);
    assert.deepEqual(prepared.ticket.dispatch.integrationTarget, { mode: 'local', upstream: 'main', branch: 'main' });
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(remote, { recursive: true, force: true });
  }
});

// SQ-2779 added repo-scoped fragments, so a window carrying only those releases no
// published plugin and `cut.mjs` creates the marketplace tag alone. That window was
// the one shape the guard did not cover (SQ-2787).
test('SQ-2787: a repo-only release tip carrying just the marketplace tag still refuses the dispatch baseline', () => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-release-tip-repo-only-'));
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-release-tip-repo-only-remote-'));
  const git = (args: string[], cwd: string = repository) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
  try {
    git(['init', '--quiet', '-b', 'main']);
    git(['config', 'user.email', 'test@example.invalid']);
    git(['config', 'user.name', 'Dispatch Lifecycle Test']);
    fs.writeFileSync(path.join(repository, 'tracked.js'), 'module.exports = "base";\n');
    git(['add', 'tracked.js']);
    git(['commit', '--quiet', '-m', 'pushed base']);
    execFileSync('git', ['init', '-b', 'main', '--bare', remote], { windowsHide: true });
    git(['remote', 'add', 'origin', remote]);
    git(['push', '--quiet', '-u', 'origin', 'main']);

    fs.writeFileSync(path.join(repository, 'release.txt'), 'repo-only release\n');
    git(['add', 'release.txt']);
    git(['commit', '--quiet', '-m', 'release v9.9.9 (SQ-0002)']);
    const releaseTip = git(['rev-parse', 'main']);
    git(['tag', '-a', 'v9.9.9', '-m', 'release v9.9.9 (SQ-0002)']);

    const repoOnlySlug = store.ensureProject(repository, 'repo-only release tip').slug;
    const refused = store.createTicket(repoOnlySlug, { title: 'dispatched during a repo-only cut', category: 'dispatch.lifecycle', files: ['tracked.js'] });
    assert.throws(
      () => store.prepareDispatch(repoOnlySlug, refused.ref, { sessionId: 'repo-only-release-tip' }),
      /unpublished release commit, tagged v9\.9\.9 and not yet on the remote branch/,
    );
    assert.equal(store.getTicket(repoOnlySlug, refused.ref).dispatch, undefined);
    assert.equal(git(['rev-parse', 'main']), releaseTip);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(remote, { recursive: true, force: true });
  }
});

test('a lightweight marketplace release tag does not narrow an unpushed local baseline', () => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-release-tip-lightweight-'));
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-release-tip-lightweight-remote-'));
  const git = (args: string[], cwd: string = repository) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
  try {
    git(['init', '--quiet', '-b', 'main']);
    git(['config', 'user.email', 'test@example.invalid']);
    git(['config', 'user.name', 'Dispatch Lifecycle Test']);
    fs.writeFileSync(path.join(repository, 'tracked.js'), 'module.exports = "base";\n');
    git(['add', 'tracked.js']);
    git(['commit', '--quiet', '-m', 'pushed base']);
    execFileSync('git', ['init', '-b', 'main', '--bare', remote], { windowsHide: true });
    git(['remote', 'add', 'origin', remote]);
    git(['push', '--quiet', '-u', 'origin', 'main']);

    fs.writeFileSync(path.join(repository, 'tracked.js'), 'module.exports = "local";\n');
    git(['commit', '--quiet', '-am', 'lightweight tag sentinel']);
    git(['tag', 'v9.9.9']);
    const localMain = git(['rev-parse', 'main']);

    const lightweightSlug = store.ensureProject(repository, 'lightweight marketplace tag').slug;
    const ticket = store.createTicket(lightweightSlug, { title: 'dispatched over a lightweight marketplace tag', category: 'dispatch.lifecycle', files: ['tracked.js'] });
    const prepared = store.prepareDispatch(lightweightSlug, ticket.ref, { sessionId: 'lightweight-marketplace-tag' });
    assert.equal(prepared.ticket.dispatch.baseCommit, localMain);
    assert.deepEqual(prepared.ticket.dispatch.integrationTarget, { mode: 'local', upstream: 'main', branch: 'main' });
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(remote, { recursive: true, force: true });
  }
});

test('a published marketplace-only release tip keeps its local baseline', () => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-release-tip-published-'));
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-release-tip-published-remote-'));
  const git = (args: string[], cwd: string = repository) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
  try {
    git(['init', '--quiet', '-b', 'main']);
    git(['config', 'user.email', 'test@example.invalid']);
    git(['config', 'user.name', 'Dispatch Lifecycle Test']);
    fs.writeFileSync(path.join(repository, 'tracked.js'), 'module.exports = "base";\n');
    git(['add', 'tracked.js']);
    git(['commit', '--quiet', '-m', 'pushed base']);
    execFileSync('git', ['init', '-b', 'main', '--bare', remote], { windowsHide: true });
    git(['remote', 'add', 'origin', remote]);
    git(['push', '--quiet', '-u', 'origin', 'main']);

    fs.writeFileSync(path.join(repository, 'release.txt'), 'release\n');
    git(['add', 'release.txt']);
    git(['commit', '--quiet', '-m', 'published release']);
    git(['tag', '-a', 'v9.9.9', '-m', 'release v9.9.9']);
    git(['push', '--quiet', 'origin', 'main', 'v9.9.9']);
    const publishedTip = git(['rev-parse', 'main']);

    const publishedSlug = store.ensureProject(repository, 'published marketplace release tip').slug;
    const ticket = store.createTicket(publishedSlug, { title: 'dispatched after marketplace release publish', category: 'dispatch.lifecycle', files: ['tracked.js'] });
    const prepared = store.prepareDispatch(publishedSlug, ticket.ref, { sessionId: 'published-marketplace-release-tip' });
    assert.equal(prepared.ticket.dispatch.baseCommit, publishedTip);
    assert.deepEqual(prepared.ticket.dispatch.integrationTarget, { mode: 'remote', upstream: 'origin/main', branch: 'main' });
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(remote, { recursive: true, force: true });
  }
});

test('an explicit missing integration branch refuses with its exact ref', () => {
  const branch = `missing-target-${Date.now()}`;
  const ticket = createFixture('missing feature integration target');
  assert.throws(() => store.prepareDispatch(slug, ticket.ref, {
    integrationBranch: branch,
    integrationMode: 'local',
  }), new RegExp(`refs/heads/${branch}`));
  assert.equal(store.getTicket(slug, ticket.ref).dispatch, undefined);
});

test('a re-dispatch after a handback picks up files declared since the release', () => {
  const sessionId = `released-binding-expansion-${Date.now()}`;
  const ticket = createFixture('released binding unions with expanded scope');
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId });
  assert.deepEqual(prepared.ticket.dispatch.declaredFiles, ['tracked.js', `.release/unreleased/${ticket.ref}.md`]);
  assert.equal(store.claimTicket(slug, ticket.ref, 'expansion-worker', {
    sessionId,
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
  }).ok, true);
  assert.equal(store.releaseTicket(slug, ticket.ref, 'expansion-worker', {
    status: 'todo',
    source: 'test',
    releaseKind: 'handback',
    releaseReason: 'A stale pin outside the dispatched binding blocks verify.',
  }).ok, true);
  assert.ok(store.getTicket(slug, ticket.ref).dispatch.terminalAt);
  store.updateTicket(slug, ticket.ref, { files: ['tracked.js', 'late-addition.js'] });
  assert.deepEqual(store.getTicket(slug, ticket.ref).files, ['tracked.js', 'late-addition.js']);
  const redispatched = store.prepareDispatch(slug, ticket.ref, { sessionId: `${sessionId}-next` });
  assert.deepEqual(redispatched.ticket.dispatch.declaredFiles.slice().sort(), [`.release/unreleased/${ticket.ref}.md`, 'late-addition.js', 'tracked.js']);
});

test('dispatch token files authenticate the briefing and claim without transcribing a secret', () => {
  const ticket = createFixture('token file dispatch');
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId: `token-file-${Date.now()}` });
  const tokenFile = prepared.ticket.dispatch.tokenFile;

  assert.ok(path.isAbsolute(tokenFile));
  assert.equal(fs.readFileSync(tokenFile, 'utf8').trim(), prepared.token);
  assert.equal(store.readDispatchBriefing(slug, ticket.ref, undefined, tokenFile).ok, true);

  // The store seam above went green while the shipped CLI threw "dispatch
  // briefing nonce is required" on every token-file call because cmdBriefing
  // failed to pass the token resolved from the file into the renderer. Only
  // running the executor's actual first command catches that wiring.
  const cliBriefing = spawnSync(process.execPath, [
    path.join(__dirname, '..', 'bin', 'sidequest.js'),
    'briefing', ticket.ref, '--token-file', tokenFile, '--project', PROJECT,
  ], { encoding: 'utf8', env: Object.assign({}, process.env, { SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: PROJECT }) });
  assert.equal(cliBriefing.status, 0, `briefing --token-file must render: ${cliBriefing.stderr}${cliBriefing.stdout}`);
  assert.match(cliBriefing.stdout, new RegExp(ticket.ref));
  assert.equal(store.claimTicket(slug, ticket.ref, 'token-file-worker', {
    tokenFile,
    executor: prepared.ticket.dispatchExecutor,
  }).ok, true);
  assert.equal(store.readDispatchBriefing(slug, ticket.ref, undefined, `${tokenFile}.missing`).reason, 'token');
});

test('dispatch token files reject altered credentials with recovery guidance', () => {
  const ticket = createFixture('dispatch token file validation');
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId: `token-file-validation-${Date.now()}` });
  const alteredTokenFile = path.join(SIDEQUEST_HOME, `${ticket.ref}-altered.token`);
  const firstTokenGroup = prepared.token.slice(0, 4);
  const swappedIndex = firstTokenGroup.split('').findIndex((character: string, index: number) => character !== firstTokenGroup[index + 1]);
  assert.notEqual(swappedIndex, -1);
  const alteredToken = `${prepared.token.slice(0, swappedIndex)}${prepared.token[swappedIndex + 1]}${prepared.token[swappedIndex]}${prepared.token.slice(swappedIndex + 2)}`;
  fs.writeFileSync(alteredTokenFile, `${alteredToken}\n`);

  assert.match(prepared.token, /^[abcdefghjkmnpqrstuvwxyz23456789]{4}(?:-[abcdefghjkmnpqrstuvwxyz23456789]{4}){7}$/);
  assert.equal(store.readDispatchBriefing(slug, ticket.ref, undefined, prepared.ticket.dispatch.tokenFile).ok, true);
  assert.equal(store.claimTicket(slug, ticket.ref, 'altered-token-file-worker', {
    tokenFile: alteredTokenFile,
    executor: prepared.ticket.dispatchExecutor,
  }).reason, 'token');
  assert.match(claimRefusalMessage('token', ticket.ref), /token file was missing, unreadable, or invalid/);
  assert.match(claimRefusalMessage('token', ticket.ref), /do not transcribe the token/);
});

test('story membership records the current decision-log revision', () => {
  const story = store.createStory(slug, { title: 'Story membership revision' });
  store.appendStoryLogEntry(slug, story.ref, { by: 'orchestrator', entry: 'DECISION: creation baseline' });
  const ticket = store.createTicket(slug, {
    title: 'story membership revision', category: 'dispatch.lifecycle', files: ['tracked.js'], storyId: story.ref, source: 'test',
  });

  assert.equal(ticket.storyLogSeenSeq, 1);
  assert.equal(store.pulsePayload(slug, ticket.ref).warnings, undefined);
});

test('prepared dispatch pins decisions added after story membership', () => {
  const story = store.createStory(slug, { title: 'Prepared story revision' });
  store.appendStoryLogEntry(slug, story.ref, { by: 'orchestrator', entry: 'DECISION: creation baseline' });
  const ticket = store.createTicket(slug, {
    title: 'prepared story revision', category: 'dispatch.lifecycle', files: ['tracked.js'], storyId: story.ref, source: 'test',
  });
  store.appendStoryLogEntry(slug, story.ref, { by: 'orchestrator', entry: 'CONSTRAINT: prepare boundary includes this' });

  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId: `story-log-boundary-${Date.now()}` });

  assert.equal(prepared.ticket.dispatch.storyLogRevision, 2);
  assert.equal(prepared.ticket.storyLogSeenSeq, 2);
  assert.equal(store.pulsePayload(slug, ticket.ref).warnings, undefined);
});

test('dispatch briefing includes each pinned decision once and reports later deltas', () => {
  const story = store.createStory(slug, { title: 'Briefed story revision' });
  store.appendStoryLogEntry(slug, story.ref, { by: 'orchestrator', entry: 'DECISION: creation baseline' });
  const ticket = store.createTicket(slug, {
    title: 'briefed story revision', category: 'dispatch.lifecycle', files: ['tracked.js'], storyId: story.ref, source: 'test',
  });
  store.appendStoryLogEntry(slug, story.ref, { by: 'orchestrator', entry: 'CONSTRAINT: prepare boundary includes this' });
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId: `story-log-brief-${Date.now()}` });
  store.appendStoryLogEntry(slug, story.ref, { by: 'orchestrator', entry: 'DISCOVERY: post-prepare delta' });

  const briefing = agentsync.renderTicketBriefing(store.getTicket(slug, ticket.ref), prepared.token, slug, PROJECT);
  const warnings = store.pulsePayload(slug, ticket.ref).warnings.join('\n');

  assert.equal((briefing.match(/#1 DECISION \(orchestrator, orchestrator\): creation baseline/g) || []).length, 1);
  assert.equal((briefing.match(/#2 CONSTRAINT \(orchestrator, orchestrator\): prepare boundary includes this/g) || []).length, 1);
  assert.doesNotMatch(briefing, /#3 DISCOVERY \(orchestrator, orchestrator\): post-prepare delta/);
  assert.match(warnings, /decision log gained 1 entry \(#3\) since .* was prepared/);
  assert.doesNotMatch(warnings, /was claimed/);
});

export {};
