import './_temp-cleanup.js';
import './_sidequest-install-fixture.js';
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-artifact-lifecycle-home-'));
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;

const store = require('../lib/store.js');
const { runCapturedVerification } = require('../lib/verify-capture.js');
const sourceRevisionCapability = require('../lib/source-revision-capability.js');
const agentsync = require('../lib/agentsync.js');

const BIN = path.join(__dirname, '..', 'bin', 'sidequest.js');
const PROJECT = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-artifact-lifecycle-project-'));
execFileSync('git', ['init', '-b', 'main', '--quiet'], { cwd: PROJECT, windowsHide: true });
execFileSync('git', ['-c', 'user.name=Sidequest Tests', '-c', 'user.email=sidequest@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'fixture'], { cwd: PROJECT, windowsHide: true });
const { slug } = store.ensureProject(PROJECT);
const exploration = store.getCategory('codebase-exploration');
store.setCategory(Object.assign({}, exploration, { route: { model: 'sonnet', effort: 'medium' }, fallback: null }));
store.setCategory({
  id: 'repository-write',
  name: 'Repository write',
  route: { model: 'sonnet', effort: 'medium' },
  artifactRoots: [],
});

test.afterEach(() => {
  execFileSync('git', ['reset', '--hard', '--quiet'], { cwd: PROJECT, windowsHide: true });
  execFileSync('git', ['clean', '-fdq'], { cwd: PROJECT, windowsHide: true });
});

function ticket(title: any, description: any, files?: any) {
  return store.createTicket(slug, {
    title,
    description,
    category: 'codebase-exploration',
    complexity: 2,
    complexityWhy: 'exercise the bounded shared-tree artifact lifecycle',
    files: files === undefined ? ['.claude/.codebase-info/'] : files,
    source: 'mcp',
  });
}

function claim(prepared: any, by: any) {
  return store.claimTicket(slug, prepared.ticket.ref, by, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    source: 'mcp',
  });
}

function submitSourceRevision(project: string, ticketRef: string, by: string, options: any) {
  const currentTicket = store.getTicket(project, ticketRef);
  const admissionFacts = sourceRevisionCapability.sourceRevisionAdapterFacts(
    project,
    options.sourceRevision,
    sourceRevisionCapability.sourceRevisionBaseline(currentTicket),
  );
  return store.submitTicket(project, ticketRef, by, { ...options, admissionFacts });
}

function runCli(args: any) {
  const result = spawnSync(process.execPath, [BIN, ...args, '--project', PROJECT], {
    cwd: PROJECT,
    encoding: 'utf8',
    env: Object.assign({}, process.env, { SIDEQUEST_HOME }),
  });
  return {
    status: result.status,
    output: `${result.stdout || ''}${result.stderr || ''}`,
  };
}

function writeProjectFile(relativePath: string, body: string) {
  const output = path.join(PROJECT, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, body);
}

function commitProjectFile(relativePath: string, body: string) {
  writeProjectFile(relativePath, body);
  execFileSync('git', ['add', '--', relativePath], { cwd: PROJECT, windowsHide: true });
  execFileSync('git', ['-c', 'user.name=Sidequest Tests', '-c', 'user.email=sidequest@example.invalid', 'commit', '--quiet', '-m', `commit ${relativePath}`], { cwd: PROJECT, windowsHide: true });
}

function preparedArtifact(title: string, by: string) {
  const created = ticket(title, store.SHARED_TREE_ARTIFACT_MARKER);
  const prepared = store.prepareDispatch(slug, created.ref, { sharedTree: true });
  assert.strictEqual(claim(prepared, by).ok, true);
  return created;
}

function assertArtifactPathRejected(created: any, by: string, relativePath: string) {
  const done = store.completeTicket(slug, created.ref, by, { source: 'mcp' });
  assert.strictEqual(done.ok, false);
  assert.strictEqual(done.reason, 'artifact_scope_violation');
  assert.deepStrictEqual(done.unscopedPaths, [relativePath]);
  assert.match(done.message, new RegExp(relativePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}

test('an explicitly marked shared-tree artifact ticket may close with done after writing its scope', () => {
  writeProjectFile('pre-existing-local.txt', 'caller dirt\n');
  const created = ticket('write a codebase map', [
    'Map the visible working tree into the declared documentation directory.',
    store.SHARED_TREE_ARTIFACT_MARKER,
  ].join('\n'));
  const prepared = store.prepareDispatch(slug, created.ref, { sharedTree: true });
  assert.strictEqual(prepared.ticket.dispatch.sharedTree, true);
  assert.strictEqual(prepared.ticket.dispatch.artifactMode, true);
  assert.strictEqual(prepared.ticket.dispatch.artifactRoot, '.claude/.codebase-info');
  assert.strictEqual(prepared.ticket.dispatch.artifactScope, '.claude/.codebase-info');
  assert.strictEqual(prepared.ticket.dispatch.readonly, true);
  assert.strictEqual(prepared.ticket.dispatchExecutor, store.resolveExec(prepared.ticket.model, prepared.ticket.effort).agent, 'artifactRoots authorizes this writable executor only because artifact mode pins one bounded shared-tree scope');
  const briefing = agentsync.renderTicketBriefing(prepared.ticket, prepared.token, slug, PROJECT);
  assert.match(briefing, /shared checkout is the dispatch contract/i);
  assert.match(briefing, /may write only \.claude\/\.codebase-info/i);
  assert.match(briefing, /do not apply the linked-worktree self-check/i);
  assert.doesNotMatch(briefing, /Worktree isolation contract:/);
  assert.deepStrictEqual(prepared.ticket.dispatch.declaredFiles, ['.claude/.codebase-info']);
  assert.ok(prepared.ticket.dispatch.artifactDirtyBaseline.some((entry: any) => entry.path === 'pre-existing-local.txt' && /^[a-f0-9]{64}$/.test(entry.identity)));
  assert.strictEqual(claim(prepared, 'artifact-worker').ok, true);

  writeProjectFile('.claude/.codebase-info/INDEX.md', '# Codebase map\n');

  const done = store.completeTicket(slug, created.ref, 'artifact-worker', { source: 'mcp' });
  assert.strictEqual(done.ok, true);
  assert.strictEqual(done.ticket.status, 'done');
  assert.strictEqual(done.ticket.submission == null, true);
});

test('artifact completion permits untouched pre-existing dirt', () => {
  const relativePath = 'untouched-caller-dirt.txt';
  writeProjectFile(relativePath, 'untouched caller dirt\n');
  const created = preparedArtifact('preserve untouched caller dirt', 'untouched-dirt-worker');
  writeProjectFile('.claude/.codebase-info/untouched.md', '# Generated map\n');

  const done = store.completeTicket(slug, created.ref, 'untouched-dirt-worker', { source: 'mcp' });
  assert.strictEqual(done.ok, true);
});

test('artifact completion refuses modified pre-existing dirt', () => {
  const relativePath = 'modified-caller-dirt.txt';
  writeProjectFile(relativePath, 'before dispatch\n');
  const created = preparedArtifact('detect modified caller dirt', 'modified-dirt-worker');
  writeProjectFile(relativePath, 'after dispatch\n');

  assertArtifactPathRejected(created, 'modified-dirt-worker', relativePath);
});

test('artifact completion refuses deleted pre-existing dirt', () => {
  const relativePath = 'deleted-caller-dirt.txt';
  writeProjectFile(relativePath, 'before dispatch\n');
  const created = preparedArtifact('detect deleted caller dirt', 'deleted-dirt-worker');
  fs.unlinkSync(path.join(PROJECT, relativePath));

  assertArtifactPathRejected(created, 'deleted-dirt-worker', relativePath);
});

test('artifact completion refuses replaced pre-existing dirt', () => {
  const relativePath = 'replaced-caller-dirt.txt';
  const absolutePath = path.join(PROJECT, relativePath);
  writeProjectFile(relativePath, 'before dispatch\n');
  const created = preparedArtifact('detect replaced caller dirt', 'replaced-dirt-worker');
  fs.unlinkSync(absolutePath);
  writeProjectFile(relativePath, 'replacement\n');

  assertArtifactPathRejected(created, 'replaced-dirt-worker', relativePath);
});

test('artifact completion refuses restaged pre-existing dirt', () => {
  const relativePath = 'restaged-caller-dirt.txt';
  writeProjectFile(relativePath, 'staged before dispatch\n');
  execFileSync('git', ['add', '--', relativePath], { cwd: PROJECT, windowsHide: true });
  const created = preparedArtifact('detect restaged caller dirt', 'restaged-dirt-worker');
  writeProjectFile(relativePath, 'staged after dispatch\n');
  execFileSync('git', ['add', '--', relativePath], { cwd: PROJECT, windowsHide: true });

  assertArtifactPathRejected(created, 'restaged-dirt-worker', relativePath);
});

test('read-only dispatches with in-repo declared files may close with done', () => {
  const created = ticket('read in-repo scope', 'Inspect the declared repository files.', ['.claude/.codebase-info']);
  const prepared = store.prepareDispatch(slug, created.ref, { sharedTree: true });
  assert.strictEqual(prepared.ticket.dispatch.readonly, true);
  assert.strictEqual(claim(prepared, 'readonly-worker').ok, true);

  const done = store.completeTicket(slug, created.ref, 'readonly-worker', { source: 'mcp' });

  assert.strictEqual(done.ok, true);
  assert.strictEqual(done.ticket.status, 'done');
  assert.strictEqual(done.ticket.submission == null, true);
});

test('shared-tree done ignores unrelated dirty files after scoped work is committed', () => {
  const scoped = '.claude/.codebase-info/committed.md';
  const bystander = 'caller-dirt.txt';
  const created = store.createTicket(slug, {
    title: 'commit a scoped composition result',
    description: 'Commit the declared composition result.',
    category: 'repository-write',
    files: ['.claude/.codebase-info'],
    source: 'mcp',
  });
  const prepared = store.prepareDispatch(slug, created.ref, { sharedTree: true });
  assert.strictEqual(claim(prepared, 'committed-worker').ok, true);

  commitProjectFile(scoped, '# Committed result\n');
  writeProjectFile(bystander, 'caller dirt\n');

  const done = store.completeTicket(slug, created.ref, 'committed-worker', { source: 'mcp' });

  assert.strictEqual(done.ok, true);
  assert.strictEqual(done.ticket.status, 'done');
  assert.strictEqual(done.unscopedPaths, undefined);
  assert.doesNotMatch(JSON.stringify(done), new RegExp(bystander));
});

test('shared-tree done refuses dirty files inside its declared scope', () => {
  const scoped = '.claude/.codebase-info/uncommitted.md';
  const created = store.createTicket(slug, {
    title: 'finish a scoped composition result',
    description: 'Commit the declared composition result.',
    category: 'repository-write',
    files: ['.claude/.codebase-info'],
    source: 'mcp',
  });
  const prepared = store.prepareDispatch(slug, created.ref, { sharedTree: true });
  assert.strictEqual(claim(prepared, 'shared-scoped-dirty-worker').ok, true);
  writeProjectFile(scoped, 'unfinished change\n');

  const done = store.completeTicket(slug, created.ref, 'shared-scoped-dirty-worker', { source: 'mcp' });

  assert.strictEqual(done.ok, false);
  assert.strictEqual(done.reason, 'submission_required');
  assert.strictEqual(store.getTicket(slug, created.ref).status, 'doing');
});

test('a shared-tree working-tree deliverable closes with its scoped paths and pinned verification capture', async () => {
  const command = 'cd';
  const created = store.createTicket(slug, {
    title: 'leave a scoped working-tree deliverable',
    description: 'The declared paths must remain uncommitted in the shared checkout.',
    category: 'repository-write',
    files: ['.claude/.codebase-info'],
    workingTreeDelivery: true,
    executorVerifyKind: 'command',
    executorVerify: command,
    source: 'mcp',
  });
  const prepared = store.prepareDispatch(slug, created.ref, { sharedTree: true });
  assert.strictEqual(prepared.ticket.dispatch.workingTreeDelivery, true);
  assert.strictEqual(claim(prepared, 'working-tree-worker').ok, true);
  writeProjectFile('.claude/.codebase-info/working-tree.md', '# Uncommitted deliverable\n');

  const candidate = store.workingTreeDeliveryCandidate(slug, store.getTicket(slug, created.ref));
  assert.ok(candidate);
  assert.deepStrictEqual(candidate.changedPaths, ['.claude/.codebase-info/working-tree.md']);
  const { capture, recorded } = await runCapturedVerification(command, { project: PROJECT, ticket: created.ref }, os.tmpdir());
  try {
    assert.strictEqual(capture.status, 'passed', capture.evidence);
    assert.match(fs.readFileSync(capture.logPath, 'utf8'), new RegExp(PROJECT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.strictEqual(recorded?.ok, true);
  } finally {
    fs.rmSync(capture.logPath, { force: true });
  }

  const done = store.completeTicket(slug, created.ref, 'working-tree-worker', { source: 'mcp' });
  assert.strictEqual(done.ok, true);
  assert.strictEqual(done.ticket.completion.purpose, 'working-tree');
  assert.deepStrictEqual(done.ticket.completion.workingTree.changedPaths, ['.claude/.codebase-info/working-tree.md']);
  assert.strictEqual(done.ticket.completion.workingTree.candidate.source, 'working-tree');
  assert.strictEqual(done.ticket.completion.workingTree.verification.status, 'passed');
});

test('read-only done ignores dirty paths outside its declared scope', () => {
  const relativePath = 'readonly-undisclosed.txt';
  const created = ticket('read clean repository', 'Inspect without modifying the repository.', ['.claude/.codebase-info']);
  const prepared = store.prepareDispatch(slug, created.ref, { sharedTree: true });
  assert.strictEqual(claim(prepared, 'readonly-dirty-worker').ok, true);
  writeProjectFile(relativePath, 'caller change\n');
  execFileSync('git', ['add', '--', relativePath], { cwd: PROJECT, windowsHide: true });

  const done = store.completeTicket(slug, created.ref, 'readonly-dirty-worker', { source: 'mcp' });

  assert.strictEqual(done.ok, true);
  assert.strictEqual(done.ticket.status, 'done');
  assert.strictEqual(done.unscopedPaths, undefined);
  assert.doesNotMatch(JSON.stringify(done), new RegExp(relativePath));
});

test('readonly override allows external output to dispatch and close with done', () => {
  const outside = path.join(os.tmpdir(), `sq-nonrepo-delta-${process.pid}.html`);
  const created = store.createTicket(slug, {
    title: 'external report',
    description: 'Write an external report only.',
    category: 'repository-write',
    readonly: true,
    files: [outside],
    source: 'mcp',
  });
  const prepared = store.prepareDispatch(slug, created.ref, { sharedTree: false });
  assert.strictEqual(prepared.ticket.dispatch.nonRepoOutput, true);
  assert.strictEqual(claim(prepared, 'nonrepo-output-worker').ok, true);

  const done = store.completeTicket(slug, created.ref, 'nonrepo-output-worker', { source: 'mcp' });

  assert.strictEqual(done.ok, true);
  assert.strictEqual(done.ticket.status, 'done');
});

test('read-only dispatches without declared files may close with done', () => {
  const created = ticket('read unscoped repository', 'Inspect the repository without a file declaration.', []);
  const prepared = store.prepareDispatch(slug, created.ref, { sharedTree: false });
  assert.strictEqual(prepared.ticket.dispatch.readonly, true);
  assert.strictEqual(claim(prepared, 'readonly-unscoped-worker').ok, true);

  const done = store.completeTicket(slug, created.ref, 'readonly-unscoped-worker', { source: 'mcp' });

  assert.strictEqual(done.ok, true);
  assert.strictEqual(done.ticket.status, 'done');
});

test('ordinary scoped dispatches still require commit and submit', () => {
  const created = store.createTicket(slug, {
    title: 'ordinary repository edit',
    description: 'Change the declared repository files.',
    category: 'repository-write',
    files: ['.claude/.codebase-info'],
    source: 'mcp',
  });
  const prepared = store.prepareDispatch(slug, created.ref, { sharedTree: true });
  assert.strictEqual(prepared.ticket.dispatch.readonly, false);
  assert.strictEqual(claim(prepared, 'ordinary-worker').ok, true);

  const done = store.completeTicket(slug, created.ref, 'ordinary-worker', { source: 'mcp' });

  assert.strictEqual(done.ok, false);
  assert.strictEqual(done.reason, 'submission_required');
  assert.match(done.message, /read-only dispatch may close with done/i);
  assert.match(done.message, /workingTreeDelivery:true/);
  assert.strictEqual(store.getTicket(slug, created.ref).claim.by, 'ordinary-worker');
});

test('readonly:false selects the submission-required write path', () => {
  const created = store.createTicket(slug, {
    title: 'mutable exploration',
    description: 'Change the declared repository files.',
    category: 'codebase-exploration',
    readonly: false,
    files: ['.claude/.codebase-info'],
    source: 'mcp',
  });
  const prepared = store.prepareDispatch(slug, created.ref, { sharedTree: true });
  assert.strictEqual(prepared.ticket.dispatch.readonly, false);
  assert.strictEqual(claim(prepared, 'readonly-override-worker').ok, true);

  const done = store.completeTicket(slug, created.ref, 'readonly-override-worker', { source: 'mcp' });

  assert.strictEqual(done.ok, false);
  assert.strictEqual(done.reason, 'submission_required');
  assert.match(done.message, /readonly:false selects this write path/i);
});

test('readonly category external output may dispatch and close with done', () => {
  const outside = path.join(os.tmpdir(), `sq-external-audition-${process.pid}.html`);
  const created = ticket('external HTML audition', 'Write an external HTML audition.', [outside]);
  const prepared = store.prepareDispatch(slug, created.ref, { sharedTree: false });
  assert.strictEqual(prepared.ticket.dispatch.nonRepoOutput, true);
  assert.strictEqual(claim(prepared, 'external-output-worker').ok, true);

  const done = store.completeTicket(slug, created.ref, 'external-output-worker', { source: 'mcp' });

  assert.strictEqual(done.ok, true);
  assert.strictEqual(done.ticket.status, 'done');
  assert.strictEqual(done.ticket.submission == null, true);
});

test('repository-category external output is refused at declaration time', () => {
  store.setCategory({
    id: 'repository-external-output',
    name: 'Repository external output',
    route: { model: 'sonnet', effort: 'medium' },
    artifactRoots: [],
  });
  const outside = path.join(os.tmpdir(), `sq-repository-external-${process.pid}.html`);

  assert.throws(
    () => store.createTicket(slug, {
      title: 'repository external output',
      description: 'Write external output from a repository-changing category.',
      category: 'repository-external-output',
      files: [outside],
      source: 'mcp',
    }),
    /classify as non-repo\/artifact work/,
  );
});

test('the artifact marker alone does not bypass submit from an isolated dispatch', () => {
  const created = store.createTicket(slug, {
    title: 'isolated artifact attempt',
    description: store.SHARED_TREE_ARTIFACT_MARKER,
    category: 'repository-write',
    files: ['.claude/.codebase-info'],
    source: 'mcp',
  });
  const prepared = store.prepareDispatch(slug, created.ref, { sharedTree: false });
  assert.strictEqual(prepared.ticket.dispatch.artifactMode, false);
  assert.strictEqual(claim(prepared, 'isolated-worker').ok, true);

  const done = store.completeTicket(slug, created.ref, 'isolated-worker', { source: 'mcp' });
  assert.strictEqual(done.ok, false);
  assert.strictEqual(done.reason, 'submission_required');
});

test('marker text cannot grant artifact authority to a category or scope', () => {
  store.setCategory({
    id: 'review-audit-artifact-attempt',
    name: 'Review audit artifact attempt',
    route: { model: 'sonnet', effort: 'medium' },
    artifactRoots: [],
  });
  const arbitraryCategory = store.createTicket(slug, {
    title: 'arbitrary category artifact attempt',
    description: store.SHARED_TREE_ARTIFACT_MARKER,
    category: 'review-audit-artifact-attempt',
    files: ['.claude/.codebase-info'],
    source: 'mcp',
  });
  const categoryDispatch = store.prepareDispatch(slug, arbitraryCategory.ref, { sharedTree: true });
  assert.strictEqual(categoryDispatch.ticket.dispatch.artifactMode, false);
  assert.strictEqual(claim(categoryDispatch, 'arbitrary-category-worker').ok, true);
  assert.strictEqual(store.completeTicket(slug, arbitraryCategory.ref, 'spoofed-groomer', { source: 'control-plane-grooming' }).reason, 'submission_required');

  const arbitraryScope = store.createTicket(slug, {
    title: 'arbitrary scope artifact attempt',
    description: store.SHARED_TREE_ARTIFACT_MARKER,
    category: 'review-audit-artifact-attempt',
    files: ['src'],
    source: 'mcp',
  });
  const scopeDispatch = store.prepareDispatch(slug, arbitraryScope.ref, { sharedTree: true });
  assert.strictEqual(scopeDispatch.ticket.dispatch.artifactMode, false);
  assert.strictEqual(claim(scopeDispatch, 'arbitrary-scope-worker').ok, true);
  assert.strictEqual(store.completeTicket(slug, arbitraryScope.ref, 'arbitrary-scope-worker', { source: 'mcp' }).reason, 'submission_required');
});

test('update status done cannot bypass claimed, dispatched, or submitted lifecycle state', () => {
  const claimed = ticket('claimed scoped work', 'Claimed work must use its executor completion path.');
  const claimedDispatch = store.prepareDispatch(slug, claimed.ref, { sharedTree: false });
  assert.strictEqual(claim(claimedDispatch, 'claimed-worker').ok, true);
  assert.throws(
    () => store.updateTicket(slug, claimed.ref, { status: 'done' }),
    /done\/completeTicket.*commit and submit/
  );

  const dispatched = ticket('dispatched scoped work', 'Prepared work must preserve its dispatch lifecycle.');
  store.prepareDispatch(slug, dispatched.ref, { sharedTree: false });
  assert.throws(
    () => store.updateTicket(slug, dispatched.ref, { status: 'done' }),
    /active dispatch.*done\/completeTicket or commit and submit/
  );

  const submitted = ticket('submitted scoped work', 'Submitted work waits for integration.');
  const submittedDispatch = store.prepareDispatch(slug, submitted.ref, { sharedTree: false });
  assert.strictEqual(claim(submittedDispatch, 'submitted-worker').ok, true);
  assert.strictEqual(store.submitTicket(slug, submitted.ref, 'submitted-worker', {
    commit: 'abcdef0',
    source: 'mcp',
  }).ok, true);
  assert.throws(
    () => store.updateTicket(slug, submitted.ref, { status: 'done' }),
    /pending submission.*integration lifecycle/
  );
});

test('released routed work refuses executor completion and allows explicit control-plane grooming', () => {
  const created = ticket('released scoped work', 'Released routed work keeps its lifecycle authority.');
  const prepared = store.prepareDispatch(slug, created.ref, { sharedTree: false });
  assert.strictEqual(claim(prepared, 'released-worker').ok, true);

  const released = store.releaseTicket(slug, created.ref, 'released-worker', { status: 'todo', source: 'mcp' });
  assert.strictEqual(released.ok, true);
  assert.strictEqual(released.ticket.dispatch.outcome, 'released');
  assert.ok(released.ticket.dispatch.terminalAt);
  assert.strictEqual(released.ticket.dispatchNonce, null);
  assert.throws(
    () => store.updateTicket(slug, created.ref, { status: 'done' }),
    /routed dispatch history.*control-plane grooming closure/
  );

  for (const attempt of [
    store.completeTicket(slug, created.ref, 'released-worker', { source: 'mcp' }),
    store.completeTicket(slug, created.ref, 'board-groomer', { source: 'mcp' }),
    store.completeTicket(slug, created.ref, 'board-groomer', { source: 'control-plane-grooming' }),
  ]) {
    assert.strictEqual(attempt.ok, false);
    assert.strictEqual(attempt.reason, 'submission_required');
  }
  const groomed = store.closeTicketForGrooming(slug, created.ref, {
    by: 'board-groomer',
    reason: 'Verified obsolete against the integrated implementation.',
  });
  assert.strictEqual(groomed.ok, true);
  assert.strictEqual(groomed.ticket.status, 'done');
  assert.strictEqual(groomed.ticket.completion.by, 'board-groomer');
  assert.strictEqual(groomed.ticket.completion.authority, 'control-plane');
  assert.strictEqual(groomed.ticket.completion.purpose, 'grooming');
  assert.strictEqual(groomed.ticket.completion.reason, 'Verified obsolete against the integrated implementation.');
  assert.ok(groomed.ticket.completion.at);
});

test('released routed work refuses CLI update status done', () => {
  const created = ticket('released CLI scoped work', 'CLI updates must keep released dispatch authority.');
  const prepared = store.prepareDispatch(slug, created.ref, { sharedTree: false });
  assert.strictEqual(claim(prepared, 'released-cli-worker').ok, true);
  assert.strictEqual(store.releaseTicket(slug, created.ref, 'released-cli-worker', { status: 'todo', source: 'mcp' }).ok, true);

  const updated = runCli(['update', created.ref, '--status', 'done']);
  assert.notStrictEqual(updated.status, 0);
  assert.match(updated.output, /routed dispatch history.*control-plane grooming closure/);
  assert.strictEqual(store.getTicket(slug, created.ref).status, 'todo');

  const spoofed = runCli(['done', created.ref, '--groom', 'true', '--body', 'Worker tried the old generic completion flag.']);
  assert.notStrictEqual(spoofed.status, 0);
  assert.strictEqual(store.getTicket(slug, created.ref).status, 'todo');

  const missingReason = runCli(['groom-close', created.ref]);
  assert.notStrictEqual(missingReason.status, 0);
  assert.match(missingReason.output, /pass --reason/);

  const groomed = runCli(['groom-close', created.ref, '--reason', 'Verified as already shipped during board grooming.', '--by', 'cli-board-groomer']);
  assert.strictEqual(groomed.status, 0, groomed.output);
  const closed = store.getTicket(slug, created.ref);
  assert.strictEqual(closed.status, 'done');
  assert.strictEqual(closed.completion.by, 'cli-board-groomer');
  assert.strictEqual(closed.completion.reason, 'Verified as already shipped during board grooming.');
});

test('update status done still closes a plain unclaimed and undispatched ticket', () => {
  const created = ticket('administrative closure', 'Close this ticket during ordinary board grooming.');
  const updated = store.updateTicket(slug, created.ref, { status: 'done' });
  assert.strictEqual(updated.status, 'done');
});

test('a claimed ticket cannot be rewritten and redispatched into artifact mode', () => {
  const created = ticket('ordinary claimed ticket', 'Start as ordinary scoped repository work.');
  const prepared = store.prepareDispatch(slug, created.ref, { sharedTree: false });
  assert.strictEqual(claim(prepared, 'rewrite-worker').ok, true);
  store.updateTicket(slug, created.ref, {
    description: store.SHARED_TREE_ARTIFACT_MARKER,
    files: ['.claude/.codebase-info/'],
    by: 'control-plane',
  });

  assert.throws(
    () => store.prepareDispatch(slug, created.ref, { sharedTree: true }),
    /has a live claim.*Release it .*before dispatching again/
  );
  assert.strictEqual(store.sharedTreeArtifactMode(store.getTicket(slug, created.ref)), false);
});

test('description and files mutations after dispatch do not flip pinned artifact authority', () => {
  const ordinary = store.createTicket(slug, {
    title: 'pinned ordinary dispatch',
    description: 'Start without artifact authority.',
    category: 'repository-write',
    files: ['.claude/.codebase-info'],
    source: 'mcp',
  });
  const ordinaryDispatch = store.prepareDispatch(slug, ordinary.ref, { sharedTree: true });
  assert.strictEqual(claim(ordinaryDispatch, 'ordinary-mutation-worker').ok, true);
  const ordinaryPatch = {
    description: store.SHARED_TREE_ARTIFACT_MARKER,
    files: [],
  };
  assert.throws(
    () => store.updateTicket(slug, ordinary.ref, ordinaryPatch),
    new RegExp(`${ordinary.ref}: refusing active-claim scope change for \\.claude/\\.codebase-info\\. Re-run \`sidequest update ${ordinary.ref} --files <paths> --by <your-id>\` using your own control-plane identity`),
  );
  store.updateTicket(slug, ordinary.ref, { ...ordinaryPatch, by: 'control-plane' });
  const mutatedOrdinary = store.getTicket(slug, ordinary.ref);
  assert.strictEqual(store.sharedTreeArtifactMode(mutatedOrdinary), false);
  assert.strictEqual(store.completeTicket(slug, ordinary.ref, 'ordinary-mutation-worker', { source: 'mcp' }).reason, 'submission_required');

  const artifact = ticket('pinned artifact dispatch', store.SHARED_TREE_ARTIFACT_MARKER);
  const artifactDispatch = store.prepareDispatch(slug, artifact.ref, { sharedTree: true });
  assert.strictEqual(claim(artifactDispatch, 'artifact-mutation-worker').ok, true);
  writeProjectFile('.claude/.codebase-info/pinned.md', 'pinned authority\n');
  const artifactPatch = {
    description: 'The marker was removed after dispatch.',
    files: [],
  };
  assert.throws(
    () => store.updateTicket(slug, artifact.ref, artifactPatch),
    new RegExp(`${artifact.ref}: refusing active-claim scope change for \\.claude/\\.codebase-info\\. Re-run \`sidequest update ${artifact.ref} --files <paths> --by <your-id>\` using your own control-plane identity`),
  );
  store.updateTicket(slug, artifact.ref, { ...artifactPatch, by: 'control-plane' });
  const mutatedArtifact = store.getTicket(slug, artifact.ref);
  assert.strictEqual(store.sharedTreeArtifactMode(mutatedArtifact), true);
  assert.strictEqual(store.completeTicket(slug, artifact.ref, 'artifact-mutation-worker', { source: 'mcp' }).ok, true);
});

test('artifact completion refuses filesystem indirection created after dispatch', () => {
  const scope = '.claude/.codebase-info/post-dispatch-link';
  const created = ticket('post-dispatch junction artifact', store.SHARED_TREE_ARTIFACT_MARKER, [scope]);
  const prepared = store.prepareDispatch(slug, created.ref, { sharedTree: true });
  assert.strictEqual(prepared.ticket.dispatch.artifactMode, true);
  assert.strictEqual(claim(prepared, 'junction-worker').ok, true);

  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-artifact-outside-'));
  const link = path.join(PROJECT, ...scope.split('/'));
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  fs.writeFileSync(path.join(link, 'escaped.txt'), 'outside project\n');

  const done = store.completeTicket(slug, created.ref, 'junction-worker', { source: 'mcp' });
  assert.strictEqual(done.ok, false);
  assert.strictEqual(done.reason, 'artifact_scope_indirection');
  assert.deepStrictEqual(done.indirectPaths, [scope]);
  assert.strictEqual(fs.readFileSync(path.join(outside, 'escaped.txt'), 'utf8'), 'outside project\n');
  assert.strictEqual(store.getTicket(slug, created.ref).status, 'doing');
  fs.unlinkSync(link);
});

test('artifact completion refuses a newly dirty path outside its artifact root', () => {
  const created = ticket('out of root artifact', store.SHARED_TREE_ARTIFACT_MARKER);
  const prepared = store.prepareDispatch(slug, created.ref, { sharedTree: true });
  assert.strictEqual(prepared.ticket.dispatch.artifactRoot, '.claude/.codebase-info');
  assert.strictEqual(claim(prepared, 'out-of-root-worker').ok, true);
  writeProjectFile('.claude/other-artifact.md', 'must not survive completion\n');

  const done = store.completeTicket(slug, created.ref, 'out-of-root-worker', { source: 'mcp' });
  assert.strictEqual(done.ok, false);
  assert.strictEqual(done.reason, 'artifact_scope_violation');
  assert.deepStrictEqual(done.unscopedPaths, ['.claude/other-artifact.md']);
  assert.match(done.message, /changed paths outside artifact scope \.claude\/\.codebase-info/);
});

test('artifact completion refuses a newly dirty path outside the dispatch scope', () => {
  const created = ticket('out of scope artifact', store.SHARED_TREE_ARTIFACT_MARKER);
  const prepared = store.prepareDispatch(slug, created.ref, { sharedTree: true });
  assert.strictEqual(claim(prepared, 'out-of-scope-worker').ok, true);
  writeProjectFile('outside-declared-scope.txt', 'must not survive completion\n');

  const done = store.completeTicket(slug, created.ref, 'out-of-scope-worker', { source: 'mcp' });
  assert.strictEqual(done.ok, false);
  assert.strictEqual(done.reason, 'artifact_scope_violation');
  assert.deepStrictEqual(done.unscopedPaths, ['outside-declared-scope.txt']);
  assert.match(done.message, /Revert those changes or release the ticket/);
  assert.strictEqual(store.getTicket(slug, created.ref).claim.by, 'out-of-scope-worker');
});


test('a Git project cannot self-declare no-Git source revision delivery', () => {
  const created = store.createTicket(slug, {
    title: 'reject false no-Git capability',
    category: 'repository-write',
    files: ['docs/wiki.md'],
    source: 'mcp',
  });
  const prepared = store.prepareDispatch(slug, created.ref, { sharedTree: true });
  assert.strictEqual(claim(prepared, 'false-capability-worker').ok, true);

  assert.throws(() => submitSourceRevision(slug, created.ref, 'false-capability-worker', {
    sourceRevision: { source: 'wiki', value: 'invented-revision', observedAt: '2026-08-14T00:00:00.000Z' },
    changedSurfaces: ['docs/wiki.md'],
    projectCapabilities: { git: false, process: false, worktree: false, review: true },
    verify: 'attestation: invented-revision | self-approved | caller asserted delivery',
    source: 'mcp',
  }), /require a project outside Git/);
  const refused = store.getTicket(slug, created.ref);
  assert.strictEqual(refused.submission, undefined);
  assert.strictEqual(refused.claim.by, 'false-capability-worker');
});

test('a rejected no-Git source revision reopens without Git quarantine', (context: any) => {
  const noGitProject = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-document-rework-project-'));
  const noGitBoard = store.ensureProject(noGitProject).slug;
  const unregister = store.registerSourceRevisionCapability(noGitBoard, () => ({ candidateExists: true, containsCandidate: true }));
  context.after(unregister);
  const created = store.createTicket(noGitBoard, {
    title: 'revise rejected wiki revision',
    category: 'repository-write',
    files: ['docs/wiki.md'],
    executorVerifyKind: 'attestation',
    executorAttestationArtifact: 'wiki-revision-42',
    source: 'mcp',
  });
  const prepared = store.prepareDispatch(noGitBoard, created.ref, { sharedTree: true });
  assert.strictEqual(store.claimTicket(noGitBoard, created.ref, 'wiki-worker', {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
  }).ok, true);
  assert.strictEqual(submitSourceRevision(noGitBoard, created.ref, 'wiki-worker', {
    sourceRevision: { source: 'wiki', value: 'wiki-revision-42', observedAt: '2026-08-13T20:00:00.000Z' },
    changedSurfaces: ['docs/wiki.md'],
    projectCapabilities: { review: true, process: false, worktree: false },
    verify: 'attestation: wiki-revision-42 | review-884 | editor reviewed the immutable revision',
    source: 'mcp',
  }).ok, true);

  const reworked = store.reworkSubmission(noGitBoard, created.ref, {
    by: 'wiki-worker',
    review: 'review-885 found a broken reference',
    reason: 'Replace the broken reference in a new immutable wiki revision.',
    source: 'mcp',
  });
  assert.strictEqual(reworked.ok, true, reworked.message);
  const reopened = store.getTicket(noGitBoard, created.ref);
  assert.strictEqual(reopened.status, 'todo');
  assert.strictEqual(reopened.submission, null);
  assert.strictEqual(reopened.rejectedSubmissions[0].preservationState, 'preserved');
  assert.deepStrictEqual(reopened.rejectedSubmissions[0].sourceRevision, {
    source: 'wiki', value: 'wiki-revision-42', observedAt: '2026-08-13T20:00:00.000Z',
  });
  assert.strictEqual(Object.hasOwn(reopened.rejectedSubmissions[0], 'quarantineRef'), false);
  assert.strictEqual(store.pendingSubmission(reopened), false);

  const repairDispatch = store.prepareDispatch(noGitBoard, created.ref, { sharedTree: true });
  assert.strictEqual(store.claimTicket(noGitBoard, created.ref, 'wiki-worker', {
    token: repairDispatch.token,
    executor: repairDispatch.ticket.dispatchExecutor,
  }).ok, true);
  const reused = submitSourceRevision(noGitBoard, created.ref, 'wiki-worker', {
    sourceRevision: { source: 'wiki', value: 'wiki-revision-42', observedAt: '2026-08-13T20:00:00.000Z' },
    changedSurfaces: ['docs/wiki.md'],
    projectCapabilities: { review: true, process: false, worktree: false },
    verify: 'attestation: wiki-revision-42 | review-886 | editor reviewed the unchanged revision',
    source: 'mcp',
  });
  assert.strictEqual(reused.ok, false);
  assert.strictEqual(reused.reason, 'rejected_submission_reused');
  assert.strictEqual(store.getTicket(noGitBoard, created.ref).claim.by, 'wiki-worker');

  const replacement = submitSourceRevision(noGitBoard, created.ref, 'wiki-worker', {
    sourceRevision: { source: 'wiki', value: 'wiki-revision-43', observedAt: '2026-08-13T21:00:00.000Z' },
    changedSurfaces: ['docs/wiki.md'],
    projectCapabilities: { review: true, process: false, worktree: false },
    verify: 'attestation: wiki-revision-43 | review-887 | editor approved the corrected immutable revision',
    source: 'mcp',
  });
  assert.strictEqual(replacement.ok, true, replacement.message);
  assert.deepStrictEqual(
    replacement.ticket.rejectedSubmissions[0].supersededBy.sourceRevision,
    { source: 'wiki', value: 'wiki-revision-43', observedAt: '2026-08-13T21:00:00.000Z' },
  );
});

test('disjoint candidate changes integrate while an automatic scope grant overlaps a live sibling', (context: any) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-wave-scope-project-'));
  const board = store.ensureProject(project).slug;
  const unregister = store.registerSourceRevisionCapability(board, () => ({ candidateExists: true, containsCandidate: true }));
  context.after(unregister);
  assert.strictEqual(store.setBoardConfig(board, { alwaysInScope: ['docs/', '.release/unreleased/'] }).ok, true);
  const participant = store.createTicket(board, {
    title: 'publish guide revision',
    description: 'Publish one immutable guide revision.',
    category: 'repository-write',
    files: ['guides/overview.md'],
    executorVerifyKind: 'attestation',
    executorAttestationArtifact: 'guide-revision-7',
    source: 'test',
  });
  const sibling = store.createTicket(board, {
    title: 'edit access tiers',
    description: 'Keep the sibling docs work live.',
    category: 'repository-write',
    files: ['docs/access-tiers.md'],
    executorVerifyKind: 'attestation',
    executorAttestationArtifact: 'access-tier-revision-3',
    source: 'test',
  });
  const siblingDispatch = store.prepareDispatch(board, sibling.ref, { sharedTree: false });
  assert.strictEqual(store.claimTicket(board, sibling.ref, 'access-tiers-worker', {
    token: siblingDispatch.token,
    executor: siblingDispatch.ticket.dispatchExecutor,
    source: 'test',
  }).ok, true);
  const prepared = store.prepareDispatch(board, participant.ref, { sharedTree: false });
  assert.strictEqual(store.claimTicket(board, participant.ref, 'guide-worker', {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    source: 'test',
  }).ok, true);
  const submitted = submitSourceRevision(board, participant.ref, 'guide-worker', {
    sourceRevision: { source: 'wiki', value: 'guide-revision-7', observedAt: '2026-08-19T00:00:00.000Z' },
    changedSurfaces: ['guides/overview.md'],
    projectCapabilities: { review: true, process: false, worktree: false },
    verify: 'attestation: guide-revision-7 | review-7 | editor approved the immutable revision',
    source: 'test',
  });
  assert.strictEqual(submitted.ok, true, submitted.message);
  assert.deepStrictEqual(submitted.ticket.submission.changedPaths, ['guides/overview.md']);

  const integrated = store.integrateSubmission(board, participant.ref, { mode: 'apply' });

  assert.strictEqual(integrated.ok, true, integrated.message);
  assert.strictEqual(integrated.integration.outcome, 'delivered');
  assert.strictEqual(store.getTicket(board, sibling.ref).claim.by, 'access-tiers-worker');
});

test('candidate changes overlapping a live sibling declared file refuse with the surface named', (context: any) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-wave-declared-overlap-project-'));
  const board = store.ensureProject(project).slug;
  const unregister = store.registerSourceRevisionCapability(board, () => ({ candidateExists: true, containsCandidate: true }));
  context.after(unregister);
  assert.strictEqual(store.setBoardConfig(board, { alwaysInScope: ['docs/', '.release/unreleased/'] }).ok, true);
  const participant = store.createTicket(board, {
    title: 'publish store revision',
    description: 'Publish one immutable store revision.',
    category: 'repository-write',
    files: ['plugins/sidequest/src/lib/store.ts'],
    executorVerifyKind: 'attestation',
    executorAttestationArtifact: 'store-revision-8',
    source: 'test',
  });
  const sibling = store.createTicket(board, {
    title: 'edit store revision',
    description: 'Keep overlapping store work live.',
    category: 'repository-write',
    files: ['plugins/sidequest/src/lib/store.ts'],
    executorVerifyKind: 'attestation',
    executorAttestationArtifact: 'store-revision-9',
    source: 'test',
  });
  const siblingDispatch = store.prepareDispatch(board, sibling.ref, { sharedTree: false });
  assert.strictEqual(store.claimTicket(board, sibling.ref, 'overlapping-store-worker', {
    token: siblingDispatch.token,
    executor: siblingDispatch.ticket.dispatchExecutor,
    source: 'test',
  }).ok, true);
  const prepared = store.prepareDispatch(board, participant.ref, { sharedTree: false });
  assert.strictEqual(store.claimTicket(board, participant.ref, 'store-worker', {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    source: 'test',
  }).ok, true);
  assert.strictEqual(submitSourceRevision(board, participant.ref, 'store-worker', {
    sourceRevision: { source: 'wiki', value: 'store-revision-8', observedAt: '2026-08-19T01:00:00.000Z' },
    changedSurfaces: ['plugins/sidequest/src/lib/store.ts'],
    projectCapabilities: { review: true, process: false, worktree: false },
    verify: 'attestation: store-revision-8 | review-8 | editor approved the immutable revision',
    source: 'test',
  }).ok, true);

  const refused = store.assembleSubmissionWave(board, [participant.ref]);

  assert.strictEqual(refused.ok, false);
  assert.strictEqual(refused.reason, 'wave_scope_overlap');
  assert.deepStrictEqual(refused.conflicts, [{
    participant: participant.ref,
    sibling: sibling.ref,
    surfaces: ['plugins/sidequest/src/lib/store.ts'],
  }]);
  assert.match(refused.message, /plugins\/sidequest\/src\/lib\/store\.ts/);
  assert.strictEqual(store.getTicket(board, participant.ref).submission.wave, undefined);
});

test('a no-Git document submission uses source revision through submit and integration closure', (context: any) => {
  const noGitProject = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-document-lifecycle-project-'));
  const noGitBoard = store.ensureProject(noGitProject).slug;
  const unregister = store.registerSourceRevisionCapability(noGitBoard, () => ({ candidateExists: true, containsCandidate: true }));
  context.after(unregister);
  const created = store.createTicket(noGitBoard, {
    title: 'publish reviewed wiki revision',
    description: 'Publish the reviewed documentation revision.',
    category: 'repository-write',
    files: ['docs/wiki.md'],
    executorVerifyKind: 'attestation',
    executorAttestationArtifact: 'wiki-revision-42',
    source: 'mcp',
  });
  const prepared = store.prepareDispatch(noGitBoard, created.ref, { sharedTree: false });
  const claimed = store.claimTicket(noGitBoard, created.ref, 'wiki-worker', {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    source: 'mcp',
  });
  assert.strictEqual(claimed.ok, true);

  const submitted = submitSourceRevision(noGitBoard, created.ref, 'wiki-worker', {
    sourceRevision: { source: 'wiki', value: 'wiki-revision-42', observedAt: '2026-08-13T20:00:00.000Z' },
    changedSurfaces: ['docs/wiki.md'],
    projectCapabilities: { review: true, process: false, worktree: false },
    verify: 'attestation: wiki-revision-42 | review-884 | editor approved the immutable revision',
    source: 'mcp',
  });
  assert.strictEqual(submitted.ok, true);
  assert.deepStrictEqual(submitted.ticket.submission.sourceRevision, {
    source: 'wiki', value: 'wiki-revision-42', observedAt: '2026-08-13T20:00:00.000Z',
  });
  assert.deepStrictEqual(submitted.ticket.submission.changedPaths, ['docs/wiki.md']);
  assert.strictEqual(submitted.ticket.lifecycleAttempt.state, 'submitted');

  const delivered = store.integrateSubmission(noGitBoard, created.ref, { mode: 'apply' });
  assert.strictEqual(delivered.ok, true);
  assert.strictEqual(delivered.integration.mode, 'source-revision');
  assert.strictEqual(delivered.integration.outcome, 'delivered');
  assert.deepStrictEqual(delivered.integration.deliveredFiles, ['docs/wiki.md']);
  assert.deepStrictEqual(delivered.integration.sourceRevision, {
    source: 'wiki', value: 'wiki-revision-42', observedAt: '2026-08-13T20:00:00.000Z',
  });

  const verified = store.verifyIntegration(noGitBoard, created.ref, { by: 'wiki-publisher' });
  assert.strictEqual(verified.ok, true);
  assert.strictEqual(verified.verify.status, 'attestation');

  const closed = store.completeTicketAsControlPlane(noGitBoard, created.ref, {
    by: 'wiki-publisher',
    purpose: 'integration',
    reason: 'Reviewed wiki revision published without Git, process, or worktree capabilities.',
  });
  assert.strictEqual(closed.ok, true);
  assert.strictEqual(closed.ticket.lifecycleAttempt.state, 'closed');
  assert.strictEqual(closed.ticket.submission.integration.outcome, 'verified');
  assert.ok(closed.ticket.submission.integratedAt);
});
