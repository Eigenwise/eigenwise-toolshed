import './_temp-cleanup.js';
import './_sidequest-install-fixture.js';
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-claims-home-'));
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;

const store = require('../lib/store.js');
const db = require('../lib/db.js');
const agentsync = require('../lib/agentsync.js');
const { runCapturedVerification } = require('../lib/verify-capture.js');

const projects = new Set<string>();

store.setCategory({
  id: 'repository-write',
  name: 'Repository write',
  route: { model: 'sonnet', effort: 'medium' },
  artifactRoots: [],
});

test.after(() => {
  for (const project of projects) fs.rmSync(project, { recursive: true, force: true });
});

function git(project: string, arguments_: string[]) {
  return execFileSync('git', arguments_, { cwd: project, encoding: 'utf8', windowsHide: true }).trim();
}

function createProject(withRootCommit = true) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-claims-project-'));
  projects.add(project);
  git(project, ['init', '-b', 'main', '--quiet']);
  if (withRootCommit) {
    git(project, ['-c', 'user.name=Sidequest Tests', '-c', 'user.email=sidequest@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'fixture']);
  }
  return { project, slug: store.ensureProject(project).slug };
}

function writeProjectFile(project: string, relativePath: string, body: string) {
  const output = path.join(project, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, body);
}

function persistTicket(slug: string, ticket: any) {
  db.putRow(db.openDb(SIDEQUEST_HOME), 'tickets', {
    id: ticket.id,
    project: slug,
    ref: ticket.ref,
    status: ticket.status,
    archived: ticket.archived ? 1 : 0,
    ord: ticket.order,
    claim_by: ticket.claim ? ticket.claim.by : null,
    data: ticket,
  });
}

function backdateClaim(slug: string, ref: string) {
  const ticket = store.getTicket(slug, ref);
  ticket.claim.at = '2000-01-01T00:00:00.000Z';
  persistTicket(slug, ticket);
}

function prepareWorkingTreeClaim(project: string, slug: string, by: string) {
  const verificationCommand = 'node -e "process.exit(0)"';
  const foreignPath = 'catalogue/euro.json';
  writeProjectFile(project, foreignPath, '{"source":"caller"}\n');
  git(project, ['add', '--', foreignPath]);
  const foreignIndexIdentity = git(project, ['rev-parse', `:${foreignPath}`]);
  const created = store.createTicket(slug, {
    title: 'write a scoped working-tree deliverable',
    description: 'Leave the declared output uncommitted.',
    category: 'repository-write',
    files: ['deliverable'],
    workingTreeDelivery: true,
    executorVerifyKind: 'command',
    executorVerify: verificationCommand,
    source: 'mcp',
  });
  const prepared = store.prepareDispatch(slug, created.ref, { sharedTree: true });
  const claimed = store.claimTicket(slug, created.ref, by, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    source: 'mcp',
  });
  return { created, prepared, claimed, foreignIndexIdentity, foreignPath, verificationCommand };
}

function assertForeignStageUnchanged(project: string, foreignPath: string, foreignIndexIdentity: string) {
  assert.strictEqual(git(project, ['rev-parse', `:${foreignPath}`]), foreignIndexIdentity);
  assert.deepStrictEqual(git(project, ['diff', '--cached', '--name-only']).split(/\r?\n/), [foreignPath]);
}

test('working-tree claim preserves staged foreign baseline and attributes only post-dispatch writes', () => {
  const { project, slug } = createProject();
  const by = 'working-tree-claimant';
  const { created, prepared, claimed, foreignIndexIdentity, foreignPath } = prepareWorkingTreeClaim(project, slug, by);

  assert.strictEqual(claimed.ok, true);
  assert.ok(prepared.ticket.dispatch.workingTreeDirtyBaseline.some((entry: any) => entry.path === foreignPath));

  const outputPath = 'deliverable/result.txt';
  writeProjectFile(project, outputPath, 'ticket output\n');
  const candidate = store.workingTreeDeliveryCandidate(slug, store.getTicket(slug, created.ref));
  assert.deepStrictEqual(candidate.changedPaths, [outputPath]);
  assertForeignStageUnchanged(project, foreignPath, foreignIndexIdentity);

  backdateClaim(slug, created.ref);
  const refused = store.releaseTicket(slug, created.ref, by, {
    status: 'todo',
    source: 'test',
    requireReleaseVerdict: true,
    claimRelease: { kind: 'abandoned', reason: 'test backstop' },
  });
  assert.strictEqual(refused.ok, false);
  assert.strictEqual(refused.reason, 'dirty_shared_tree');
  assert.deepStrictEqual(refused.paths, [outputPath]);
  assert.deepStrictEqual(refused.preExistingPaths, [foreignPath]);
  assert.deepStrictEqual(refused.newlyChangedPaths, [outputPath]);
  assert.match(refused.message, /Pre-existing unchanged paths: catalogue\/euro\.json\. Newly changed paths: deliverable\/result\.txt\./);
  assertForeignStageUnchanged(project, foreignPath, foreignIndexIdentity);
});

test('untouched staged foreign baseline does not block a dead shared-tree claim release', () => {
  const { project, slug } = createProject();
  const by = 'unchanged-foreign-claimant';
  const { created, claimed, foreignIndexIdentity, foreignPath } = prepareWorkingTreeClaim(project, slug, by);

  assert.strictEqual(claimed.ok, true);
  backdateClaim(slug, created.ref);
  const swept = store.sweepStaleClaims({ project: slug, source: 'test' });

  assert.strictEqual(swept.blocked.some((entry: any) => entry.ref === created.ref), false);
  assert.strictEqual(swept.released.some((entry: any) => entry.ref === created.ref), true);
  assertForeignStageUnchanged(project, foreignPath, foreignIndexIdentity);
});

test('working-tree briefing tells the executor to preserve and continue past staged baseline paths', () => {
  const { project, slug } = createProject();
  const { prepared } = prepareWorkingTreeClaim(project, slug, 'briefed-working-tree-claimant');

  const briefing = agentsync.renderTicketBriefing(prepared.ticket, prepared.token, slug, project);

  assert.match(briefing, /pre-existing dirty or staged paths were recorded at dispatch; leave them untouched and continue/i);
});

test('unborn repository supports a working-tree claim with a staged foreign baseline', async () => {
  const { project, slug } = createProject(false);
  const by = 'unborn-working-tree-claimant';
  const { created, claimed, foreignIndexIdentity, foreignPath, verificationCommand } = prepareWorkingTreeClaim(project, slug, by);

  assert.strictEqual(claimed.ok, true);
  const outputPath = 'deliverable/unborn-result.txt';
  writeProjectFile(project, outputPath, 'ticket output before first commit\n');
  assert.deepStrictEqual(
    store.workingTreeDeliveryCandidate(slug, store.getTicket(slug, created.ref)).changedPaths,
    [outputPath],
  );

  backdateClaim(slug, created.ref);
  const refused = store.releaseTicket(slug, created.ref, by, {
    status: 'todo',
    source: 'test',
    requireReleaseVerdict: true,
    claimRelease: { kind: 'abandoned', reason: 'test backstop' },
  });
  assert.strictEqual(refused.ok, false);
  assert.strictEqual(refused.reason, 'dirty_shared_tree');
  assert.deepStrictEqual(refused.paths, [outputPath]);
  assert.deepStrictEqual(refused.preExistingPaths, [foreignPath]);
  assert.deepStrictEqual(refused.newlyChangedPaths, [outputPath]);

  const { capture, recorded } = await runCapturedVerification(
    verificationCommand,
    { project, ticket: created.ref },
    os.tmpdir(),
  );
  try {
    assert.strictEqual(capture.status, 'passed', capture.evidence);
    assert.strictEqual(recorded?.ok, true);
    const completed = store.completeTicket(slug, created.ref, by, { source: 'mcp' });
    assert.strictEqual(completed.ok, true, completed.message);
    assert.deepStrictEqual(completed.ticket.completion.workingTree.changedPaths, [outputPath]);
  } finally {
    fs.rmSync(capture.logPath, { force: true });
  }
  assertForeignStageUnchanged(project, foreignPath, foreignIndexIdentity);
});
