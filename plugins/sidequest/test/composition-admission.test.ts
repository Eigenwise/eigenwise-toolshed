import './_gateway-catalog-freshness.js';
import './_sidequest-install-fixture.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { proveCompositionRange, type CompositionRangeInput, type CompositionSourceRange } from '../src/lib/store/composition-range';
import { compositionCaptureRefusal, compositionIncludesSource, compositionSubmissionScope, exactCompositionSubmissionRefusal } from '../src/lib/store/composition-admission';
import type { CompositionAdmissionInput, CompositionExpected, CompositionAdmissionResult, CompositionTicket } from '../src/lib/store/composition-admission';
const store = require('../lib/store.js');
const mcp = require('../lib/mcp.js');
const worktrees = require('../lib/worktrees.js');
const capture = require('../lib/verify-capture.js');
const { canonicalPath, createCheckoutInstanceMarker } = require('../lib/kernel/worktree.js');

store.setCategory({ id: 'composition.fixture', name: 'Composition fixture',
  route: { model: 'sonnet', effort: 'high' }, fallback: null, enabled: true });

let project: string;
let rootTicket: CompositionTicket;
let admissionInput: CompositionAdmissionInput;
let rootReleasedSnapshot: string;
let sourceSnapshots: readonly string[];
let oldRootCheckout: string;
let oldRootProof: string;
let oldRootToken: string;
let sourceReviewRef: string;
const SESSION = 'composition-public-fixture-session';
let requestNumber = 0;
const fixtureWorktrees: string[] = [];

let repository: string;
let originalBase: string;
let candidate: string;
let input: CompositionRangeInput;
let sourceARange: CompositionSourceRange;
let sourceBRange: CompositionSourceRange;
let compositionMerge: string;

function git(argumentsList: readonly string[]): string {
  return execFileSync('git', [...argumentsList], {
    cwd: repository, encoding: 'utf8', timeout: 30_000, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function write(relative: string, contents: string): void {
  const target = path.join(repository, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

function commit(message: string): string {
  git(['add', '.']);
  git(['commit', '-m', message]);
  return git(['rev-parse', 'HEAD']);
}

function rootOwnChange(): string {
  write('src/first.test.ts', 'export const first = 2;\n');
  write('src/second.test.ts', 'export const second = 2;\n');
  write('.release/unreleased/SQ-3.md', 'Root composition fragment\n');
  return commit('Root changes two pre-existing tests');
}

async function boardTool(name: string, arguments_: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await mcp.handleRequest({ jsonrpc: '2.0', id: ++requestNumber, method: 'tools/call', params: { name, arguments: { project, ...arguments_ } } });
  assert.equal(response.result.isError, undefined, response.result.content[0].text);
  return JSON.parse(response.result.content[0].text);
}

// A refusal may surface as an MCP error or a refused acknowledgement; callers assert its reason in the text.
async function boardToolText(name: string, arguments_: Record<string, unknown>): Promise<string> {
  const response = await mcp.handleRequest({ jsonrpc: '2.0', id: ++requestNumber, method: 'tools/call', params: { name, arguments: { project, ...arguments_ } } });
  return String(response.result.content[0].text);
}

function gitIn(directory: string, arguments_: readonly string[]): string {
  return execFileSync('git', [...arguments_], { cwd: directory, encoding: 'utf8', timeout: 30_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

type ClaimProbe = { token: string; executor: string; checkout: string };

function freshNativeCheckout(ref: string, by: string, role: string, probes: {
  beforeBinding?: () => void; beforeCompletion?: (checkout: string, attempt: string) => void; beforeClaim?: (claim: ClaimProbe) => void;
} = {}): string {
  const prepared = store.prepareDispatch(project, ref, { sharedTree: false, sessionId: SESSION, runtimeCwd: repository });
  assert.equal(store.recordDispatchLaunch(project, ref, { token: prepared.token, executor: prepared.ticket.dispatchExecutor, sessionId: SESSION }).ok, true);
  const checkout = worktrees.agentWorktreePath(repository, `composition-${role}`);
  probes.beforeBinding?.();
  const bound = store.bindDispatchWorktreeCreation(project, SESSION, checkout);
  assert.equal(bound.ok, true, JSON.stringify(bound));
  fs.mkdirSync(path.dirname(checkout), { recursive: true });
  git(['worktree', 'add', '-b', `composition-${role}`, checkout, bound.baseline]);
  fixtureWorktrees.push(checkout);
  createCheckoutInstanceMarker(gitIn(checkout, ['rev-parse', '--absolute-git-dir']));
  probes.beforeCompletion?.(checkout, bound.attempt);
  assert.equal(store.completeDispatchWorktreeCreation(project, SESSION, checkout, bound.attempt).ok, true);
  assert.deepEqual(store.completeDispatchWorktreeCreation(project, SESSION, checkout, bound.attempt), { ok: true, alreadyCompleted: true });
  assert.equal(store.bindDispatchWorktreeCreation(project, SESSION, checkout, bound.attempt).baseline, bound.baseline);
  const boundRuntime = store.bindDispatchAgent(SESSION, prepared.ticket.dispatchExecutor, worktrees.agentIdFromWorktreePath(repository, checkout), by, checkout);
  assert.equal(boundRuntime.ok, true, JSON.stringify(boundRuntime));
  probes.beforeClaim?.({ token: prepared.token, executor: prepared.ticket.dispatchExecutor, checkout });
  assert.equal(store.claimTicket(project, ref, by, { token: prepared.token, executor: prepared.ticket.dispatchExecutor, sessionId: SESSION }).ok, true);
  return checkout;
}

function fixtureTicket(title: string, files: readonly string[]): CompositionTicket {
  return store.createTicket(project, { title, description: 'Public disposable exact composition fixture. Verify: inspect immutable range and native lifecycle.',
    files, category: 'composition.fixture', route: { model: 'sonnet', effort: 'high' } });
}

async function submitSource(ticket: CompositionTicket, file: string, role: string): Promise<CompositionSourceRange> {
  const by = `composition-source-${role}`;
  const checkout = freshNativeCheckout(ticket.ref, by, role);
  fs.writeFileSync(path.join(checkout, file), `export const source${role.toUpperCase()} = true;\n`);
  const committed = await boardTool('commit', { ref: ticket.ref, by, worktree: checkout, message: `Source ${role} immutable candidate` });
  assert.equal(typeof committed.commit, 'string', JSON.stringify(committed));
  gitIn(checkout, ['update-ref', `refs/sidequest/${ticket.ref}`, String(committed.commit)]);
  const submitted = await boardTool('submit', { ref: ticket.ref, by, worktree: checkout, commit: committed.commit,
    verify: 'manual: immutable public source fixture was checked', body: 'Public source remains pending for its own independent acceptance.' });
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  const recorded: CompositionTicket = store.getTicket(project, ticket.ref);
  const submission = recorded.submission;
  assert.ok(submission?.base && submission.commit && submission.commits && submission.admittedScope);
  return { ref: ticket.ref, base: submission.base, commit: submission.commit, commits: submission.commits, admittedScope: submission.admittedScope };
}

async function prepareReleasedRoot(): Promise<void> {
  rootTicket = fixtureTicket('Released root adopts a composition now', ['src/first.test.ts', 'src/second.test.ts']);
  oldRootCheckout = freshNativeCheckout(rootTicket.ref, 'composition-old-root', 'old-root', { beforeClaim: claim => { oldRootToken = claim.token; } });
  const live = store.getTicket(project, rootTicket.ref);
  oldRootProof = path.join(live.dispatch.evidenceDirectory, 'original-proof.txt');
  fs.writeFileSync(oldRootProof, 'Original released proof input, never fresh evidence.\n');
  assert.equal(store.releaseTicket(project, rootTicket.ref, 'composition-old-root', { status: 'todo', source: 'test' }).ok, true);
  rootTicket = store.getTicket(project, rootTicket.ref);
  rootReleasedSnapshot = JSON.stringify(rootTicket.dispatch);
  assert.notEqual(rootTicket.dispatch?.baseCommit, candidate);
}

// Source B keeps an open, unaccepted independent review so later tests can race its authoritative state.
async function bindOpenSourceReview(range: CompositionSourceRange): Promise<string> {
  const added = await boardTool('add', { title: `Independent review of pending ${range.ref}`, category: 'review-audit',
    files: ['src/b.ts'], route: { model: 'sonnet', effort: 'high' }, reviewTarget: { ref: range.ref, commit: range.commit } });
  assert.equal(added.ok, true, JSON.stringify(added));
  return String(added.ref);
}

function setSourceReviewStatus(status: 'todo' | 'awaiting-oracle'): void {
  store.updateTicket(project, sourceReviewRef, { status });
  assert.equal(store.getTicket(project, sourceReviewRef).status, status);
}

async function whileSourceReviewChanged(check: () => unknown): Promise<void> {
  setSourceReviewStatus('awaiting-oracle');
  try {
    await check();
  } finally {
    setSourceReviewStatus('todo');
  }
}

function initializeAdmissionInput(): void {
  assert.equal(store.linkTickets(project, rootTicket.ref, 'related', sourceARange.ref).ok, true);
  assert.equal(store.linkTickets(project, rootTicket.ref, 'related', sourceBRange.ref).ok, true);
  const sources = [sourceARange, sourceBRange].map(range => {
    const source: CompositionTicket = store.getTicket(project, range.ref);
    return { ref: range.ref, commit: range.commit, submittedAt: source.submission?.at ?? '' };
  });
  admissionInput = { authority: 'main-attestation', historicalCheckout: false, by: 'composition-current-main',
    evidence: 'Current exact immutable adoption; old terminal C ownership remains unverified.',
    base: originalBase, candidate, ownCommits: input.ownCommits, ownPaths: input.ownPaths, sources };
  sourceSnapshots = sources.map(source => JSON.stringify(store.getTicket(project, source.ref)));
}

before(async () => {
  repository = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-ca-'));
  git(['init', '-b', 'main']);
  git(['config', 'core.longpaths', 'true']);
  git(['config', 'user.name', 'Composition Fixture']);
  git(['config', 'user.email', 'composition@example.invalid']);
  write('src/first.test.ts', 'export const first = 1;\n');
  write('src/second.test.ts', 'export const second = 1;\n');
  originalBase = commit('Original base');
  process.env.CLAUDE_CODE_SESSION_ID = SESSION;
  process.env.CLAUDE_PROJECT_DIR = repository;
  project = store.ensureProject(repository).slug;
  store.setBoardConfig(project, { integrationMode: 'local', integrationBranch: 'main', worktreeBase: 'local-main' });
  const sourceATicket = fixtureTicket('Pending source A', ['src/a.ts']);
  const sourceBTicket = fixtureTicket('Pending source B', ['src/b.ts']);
  sourceARange = await submitSource(sourceATicket, 'src/a.ts', 'a');
  sourceBRange = await submitSource(sourceBTicket, 'src/b.ts', 'b');
  await prepareReleasedRoot();
  sourceReviewRef = await bindOpenSourceReview(sourceBRange);
  git(['checkout', '-b', 'root', sourceARange.commit]);
  git(['merge', '--no-ff', sourceBRange.commit, '-m', 'Compose complete source ranges']);
  compositionMerge = git(['rev-parse', 'HEAD']);
  candidate = rootOwnChange();
  input = {
    base: originalBase, candidate, ownCommits: [compositionMerge, candidate],
    ownPaths: ['.release/unreleased/SQ-3.md', 'src/first.test.ts', 'src/second.test.ts'],
    rootScope: ['src', '.release/unreleased/SQ-3.md'],
    sources: [sourceARange, sourceBRange],
  };
  initializeAdmissionInput();
});

function removeDisposableCheckout(checkout: string, registered: ReadonlySet<string>): void {
  if (registered.has(canonicalPath(checkout))) {
    git(['worktree', 'remove', '--force', checkout]);
  } else {
    assert.equal(fs.existsSync(checkout), false, 'Ordinary delivered checkout disposal must remove its directory too.');
  }
}

function cleanupNativeFixtures(): void {
  const registered = new Set<string>(git(['worktree', 'list', '--porcelain']).split(/\r?\n/)
    .filter(line => line.startsWith('worktree ')).map(line => canonicalPath(line.slice('worktree '.length))));
  for (const checkout of fixtureWorktrees) removeDisposableCheckout(checkout, registered);
  fs.rmSync(repository, { recursive: true, force: true });
}
after(cleanupNativeFixtures);

function expectRefusal(request: CompositionRangeInput, reason: string): void {
  const result = proveCompositionRange(repository, request);
  assert.equal(result.ok, false);
  assert.equal(result.reason, reason, result.message);
}

test('composition admission: range proof preserves the full original BASE..C and both existing own tests', () => {
  const proof = proveCompositionRange(repository, input);
  assert.equal(proof.ok, true);
  assert.deepEqual([...proof.commits].sort(), git(['rev-list', `${originalBase}..${candidate}`]).split(/\r?\n/).sort());
  assert.deepEqual(proof.ownPaths, input.ownPaths);
  assert.equal(proof.commits.length, 4);
  assert.notEqual(input.base, input.candidate);
});

test('composition admission: hidden commit assertion refuses an unaccounted range member', () => {
  expectRefusal({ ...input, ownCommits: [candidate] }, 'hidden_commit');
});

test('composition admission: full-range assertion refuses candidate as the submission floor', () => {
  expectRefusal({ ...input, base: candidate }, 'empty_range');
});

test('composition admission: a commit may belong to only one accounted range', () => {
  expectRefusal({ ...input, ownCommits: [...input.ownCommits, sourceARange.commit] }, 'duplicate_commit');
});

test('composition admission: source ranges cannot omit their own immutable commits', () => {
  const source = { ...sourceARange, commits: [] };
  expectRefusal({ ...input, sources: [source, sourceBRange] }, 'stale_source');
});

test('composition admission: empty source ranges provide no ownership', () => {
  const source = { ...sourceARange, base: sourceARange.commit, commits: [] };
  expectRefusal({ ...input, sources: [source, sourceBRange] }, 'source_range_missing');
});

test('composition admission: ownPaths cannot conceal a changed existing file', () => {
  expectRefusal({ ...input, ownPaths: ['.release/unreleased/SQ-3.md', 'src/first.test.ts'] }, 'own_delta_mismatch');
});

test('composition admission: own changes must remain in the original root scope', () => {
  expectRefusal({ ...input, rootScope: ['src/first.test.ts', '.release/unreleased/SQ-3.md'] }, 'own_delta_out_of_scope');
});

test('composition admission: absolute and parent paths cannot expand original scope', () => {
  expectRefusal({ ...input, rootScope: ['../foreign'] }, 'own_delta_out_of_scope');
});

test('composition admission: the base must be an exact reachable immutable commit', () => {
  expectRefusal({ ...input, base: 'HEAD' }, 'composition_git_error');
});

test('composition admission: unilateral own merge edits cannot hide behind a clean combined diff', () => {
  git(['checkout', '--detach', compositionMerge]);
  write('foreign/hidden.ts', 'export const hidden = true;\n');
  git(['add', '.']);
  const tree = git(['write-tree']);
  const evilMerge = git(['commit-tree', tree, '-p', sourceARange.commit, '-p', sourceBRange.commit, '-m', 'Unilateral merge edit']);
  expectRefusal({ ...input, candidate: evilMerge, ownCommits: [evilMerge], ownPaths: [] }, 'own_merge_unsupported');
});

test('composition admission: rename ownership includes the deleted and added paths', () => {
  git(['checkout', '--detach', candidate]);
  git(['mv', 'src/first.test.ts', 'src/renamed.test.ts']);
  const renamed = commit('Rename first test');
  expectRefusal({ ...input, candidate: renamed, ownCommits: [...input.ownCommits, renamed] }, 'own_delta_mismatch');
});

function assertOriginalProofsAndSources(): void {
  assert.equal(JSON.stringify(store.getTicket(project, rootTicket.ref).dispatch), rootReleasedSnapshot);
  assertRetainedProofsAndSources();
}

function assertRetainedProofsAndSources(): void {
  assert.equal(gitIn(oldRootCheckout, ['rev-parse', 'HEAD']), originalBase);
  assert.equal(fs.readFileSync(oldRootProof, 'utf8'), 'Original released proof input, never fresh evidence.\n');
  assert.deepEqual(admissionInput.sources.map(source => JSON.stringify(store.getTicket(project, source.ref))), sourceSnapshots);
}

function expectedFromProbe(result: CompositionAdmissionResult): CompositionExpected {
  assert.ok('observed' in result, JSON.stringify(result));
  return { attemptCount: result.observed.attemptCount, releasedAt: result.observed.releasedAt, preparedAt: result.observed.preparedAt,
    sources: result.observed.sources.map(source => ({ ref: source.ref, reviewTicketId: source.reviewTicketId,
      reviewOutcome: source.reviewOutcome, correctedAt: source.correctedAt, snapshot: source.snapshot })) };
}

async function admissionTool(input: CompositionAdmissionInput): Promise<CompositionAdmissionResult> {
  const response = await mcp.handleRequest({ jsonrpc: '2.0', id: ++requestNumber, method: 'tools/call',
    params: { name: 'update', arguments: { project, ref: rootTicket.ref, admitComposition: input } } });
  assert.equal(response.result.isError, undefined, response.result.content[0].text);
  return JSON.parse(response.result.content[0].text);
}

test('composition admission: internal grant and actual runtime session are required, labels lend no authority', async () => {
  const before = JSON.stringify(store.getTicket(project, rootTicket.ref));
  const denied: CompositionAdmissionResult = store.admitComposition(project, rootTicket.ref, admissionInput, SESSION);
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, 'admission_unauthorized');
  const prior = process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.CLAUDE_CODE_SESSION_ID;
  try {
    const missing = await admissionTool(admissionInput);
    assert.equal(missing.ok, false);
    assert.equal(missing.reason, 'identity_unavailable');
  } finally {
    process.env.CLAUDE_CODE_SESSION_ID = prior;
  }
  assert.equal(JSON.stringify(store.getTicket(project, rootTicket.ref)), before);
  assertOriginalProofsAndSources();
});

async function assertForeignLiveCompositionRefusal(role: string, file: string): Promise<void> {
  const ticket = fixtureTicket(`Unrelated live ${role}`, [file]);
  const by = `composition-live-${role}`;
  const checkout = freshNativeCheckout(ticket.ref, by, role);
  fs.writeFileSync(path.join(checkout, file), `export const ${role === 's' ? 'first' : 'second'} = 2;\n`);
  const committed = await boardTool('commit', { ref: ticket.ref, by, worktree: checkout, message: `Unrelated live ${role} candidate` });
  assert.equal(typeof committed.commit, 'string', JSON.stringify(committed));
  git(['checkout', '-b', `composition-foreign-${role}`, candidate]);
  git(['merge', '--no-ff', String(committed.commit), '-m', `Include unrelated live ${role}`]);
  const foreignCandidate = git(['rev-parse', 'HEAD']);
  const request = { ...admissionInput, candidate: foreignCandidate, ownCommits: [...admissionInput.ownCommits, String(committed.commit), foreignCandidate] };
  const expected = expectedFromProbe(await admissionTool(request));
  const before = JSON.stringify(store.getTicket(project, rootTicket.ref));
  const foreignBefore = JSON.stringify(store.getTicket(project, ticket.ref));
  const denied = await admissionTool({ ...request, expected });
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, 'foreign_commit', JSON.stringify(denied));
  assert.equal(JSON.stringify(store.getTicket(project, rootTicket.ref)), before);
  assert.equal(JSON.stringify(store.getTicket(project, ticket.ref)), foreignBefore);
  assertOriginalProofsAndSources();
  assertLiveTicketCannotJoinComposition(ticket.ref, String(committed.commit));
  assert.equal(store.releaseTicket(project, ticket.ref, by, { status: 'todo', source: 'test' }).ok, true);
}

// A claimed ticket can neither adopt a composition as its root nor lend itself as a source.
function assertLiveTicketCannotJoinComposition(ref: string, commit: string): void {
  const snapshot = () => JSON.stringify([store.getTicket(project, ref), store.getTicket(project, rootTicket.ref)]);
  const grant = { allowCompositionAdmission: true };
  const unlinked = snapshot();
  assert.equal(store.admitComposition(project, ref, admissionInput, SESSION, grant).reason, 'root_active');
  assert.equal(snapshot(), unlinked);
  assert.equal(store.linkTickets(project, rootTicket.ref, 'related', ref).ok, true);
  try {
    const linked = snapshot();
    const request = { ...admissionInput, sources: [...admissionInput.sources, { ref, commit, submittedAt: '' }] };
    assert.equal(store.admitComposition(project, rootTicket.ref, request, SESSION, grant).reason, 'source_active');
    assert.equal(snapshot(), linked);
  } finally {
    assert.equal(store.unlinkTickets(project, rootTicket.ref, ref).ok, true);
  }
  assertOriginalProofsAndSources();
}

for (const [role, file] of [['s', 'src/first.test.ts'], ['d', 'src/second.test.ts']] as const) {
  test(`composition admission: unrelated live ${role.toUpperCase()} sanctioned commits cannot become root own attribution`, async () => {
    await assertForeignLiveCompositionRefusal(role, file);
  });
}

test('composition admission: nested audit and authority extras are refused without ordinary field writes', async () => {
  const before = JSON.stringify(store.getTicket(project, rootTicket.ref));
  const request = { ...admissionInput, sources: admissionInput.sources.map(source => ({ ...source, authority: 'main-attestation' })) };
  const denied = await admissionTool(request);
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, 'invalid_admission');
  const mixed = await boardTool('update', { ref: rootTicket.ref, title: 'Must not change', admitComposition: admissionInput });
  assert.equal(mixed.reason, 'invalid_admission');
  assert.equal(JSON.stringify(store.getTicket(project, rootTicket.ref)), before);
  assertOriginalProofsAndSources();
});

test('composition admission: root state, base and source membership refusals write nothing', () => {
  const unsubmitted = fixtureTicket('Unsubmitted ticket that never dispatched', ['src/c.ts']);
  const refusal = (ref: string, request: CompositionAdmissionInput) => store.admitComposition(project, ref, request, SESSION, { allowCompositionAdmission: true }).reason;
  const before = JSON.stringify(store.getTicket(project, rootTicket.ref));
  const unsubmittedSource = { ref: unsubmitted.ref, commit: candidate, submittedAt: '' };
  assert.equal(refusal(rootTicket.ref, { ...admissionInput, sources: [] }), 'invalid_sources');
  assert.equal(refusal(rootTicket.ref, { ...admissionInput, sources: [...admissionInput.sources, unsubmittedSource] }), 'source_unrelated');
  assert.equal(refusal(rootTicket.ref, { ...admissionInput, base: candidate }), 'composition_base_mismatch');
  assert.equal(refusal(unsubmitted.ref, admissionInput), 'root_not_released');
  assert.equal(refusal(sourceARange.ref, admissionInput), 'root_submitted');
  assert.equal(JSON.stringify(store.getTicket(project, rootTicket.ref)), before);
  assert.equal(store.linkTickets(project, rootTicket.ref, 'related', unsubmitted.ref).ok, true);
  try {
    const linked = JSON.stringify(store.getTicket(project, rootTicket.ref));
    assert.equal(refusal(rootTicket.ref, { ...admissionInput, sources: [...admissionInput.sources, unsubmittedSource] }), 'source_unavailable');
    assert.equal(JSON.stringify(store.getTicket(project, rootTicket.ref)), linked);
  } finally {
    assert.equal(store.unlinkTickets(project, rootTicket.ref, unsubmitted.ref).ok, true);
  }
  assertOriginalProofsAndSources();
});

// The board's ticket lock is a file owned by a live pid, so holding it here makes the grant wait out its
// bounded acquisition and report busy rather than writing around the referenced review.
function assertHeldReviewLockRefusesGrant(request: CompositionAdmissionInput, before: string): void {
  const review = JSON.stringify(store.getTicket(project, sourceReviewRef));
  const lock = path.join(store.projectDir(project), 'tickets', `.${store.getTicket(project, sourceReviewRef).id}.lock`);
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'composition-fixture-held-review-lock' }), { flag: 'wx' });
  try {
    const busy: { ok: boolean; reason: string } = store.admitComposition(project, rootTicket.ref, request, SESSION, { allowCompositionAdmission: true });
    assert.equal(busy.reason, 'busy', JSON.stringify(busy));
  } finally {
    fs.unlinkSync(lock);
  }
  assert.equal(JSON.stringify(store.getTicket(project, rootTicket.ref)), before);
  assert.equal(JSON.stringify(store.getTicket(project, sourceReviewRef)), review);
  assertOriginalProofsAndSources();
}

test('composition admission: existing MCP probe grants nothing, exact current main adoption and retry preserve sources and old proofs', async () => {
  const before = JSON.stringify(store.getTicket(project, rootTicket.ref));
  const probe = await admissionTool(admissionInput);
  assert.equal(probe.ok, false);
  assert.equal(probe.reason, 'expected_required');
  assert.equal(JSON.stringify(store.getTicket(project, rootTicket.ref)), before, 'expected-less probe is write-free');
  const expected = expectedFromProbe(probe);
  assert.equal(expected.sources[0]?.reviewOutcome, null, 'unknown source acceptance stays unknown');
  assert.equal(expected.sources[1]?.reviewTicketId, store.getTicket(project, sourceReviewRef).id, 'the probe names the authoritative bound review');
  const request = { ...admissionInput, expected };
  await whileSourceReviewChanged(async () => {
    const raced = await admissionTool(request);
    assert.equal(raced.ok, false);
    assert.equal(raced.reason, 'stale_source', JSON.stringify(raced));
  });
  assert.equal(JSON.stringify(store.getTicket(project, rootTicket.ref)), before, 'a review change between probe and grant writes nothing');
  assertHeldReviewLockRefusesGrant(request, before);
  const admitted = await admissionTool(request);
  assert.equal(admitted.ok, true, JSON.stringify(admitted));
  assert.equal(admitted.admission.base, originalBase);
  assert.equal(admitted.admission.candidate, candidate);
  assert.equal(admitted.admission.historicalCheckout, false);
  const stored = JSON.stringify(store.getTicket(project, rootTicket.ref));
  const retry = await admissionTool(request);
  assert.equal(retry.ok, true, JSON.stringify(retry));
  assert.equal(retry.idempotent, true);
  assert.equal(retry.admission.id, admitted.admission.id);
  assert.equal(JSON.stringify(store.getTicket(project, rootTicket.ref)), stored, 'exact validated retry is write-free');
  assertOriginalProofsAndSources();
});

function assertCompositionCreationRefusals(): void {
  const prepared: CompositionTicket = store.getTicket(project, rootTicket.ref);
  assert.equal(prepared.dispatch?.baseCommit, originalBase, 'Fresh composition dispatch preserves the original BASE.');
  const before = JSON.stringify(prepared);
  const reused = store.bindDispatchWorktreeCreation(project, SESSION, oldRootCheckout);
  assert.equal(reused.ok, false);
  assert.equal(reused.reason, 'composition_checkout_reused');
  const occupied = worktrees.agentWorktreePath(repository, 'composition-occupied');
  fs.mkdirSync(occupied, { recursive: true });
  try {
    const denied = store.bindDispatchWorktreeCreation(project, SESSION, occupied);
    assert.equal(denied.ok, false);
    assert.equal(denied.reason, 'composition_checkout_occupied');
    assert.equal(JSON.stringify(store.getTicket(project, rootTicket.ref)), before);
  } finally {
    fs.rmdirSync(occupied);
  }
  assertRetainedProofsAndSources();
}

function assertCompositionCompletionRefusals(checkout: string, attempt: string): void {
  const before = JSON.stringify(store.getTicket(project, rootTicket.ref));
  const oldAttempt = JSON.parse(rootReleasedSnapshot).preparedAt;
  assert.equal(store.completeDispatchWorktreeCreation(project, SESSION, checkout, oldAttempt).reason, 'stale_attempt');
  assert.equal(store.completeDispatchWorktreeCreation(project, SESSION, checkout).reason, 'missing_attempt');
  const dirty = path.join(checkout, 'unclaimed-dirty.txt');
  fs.writeFileSync(dirty, 'A dirty new checkout cannot complete composition admission.\n');
  try {
    assert.equal(store.completeDispatchWorktreeCreation(project, SESSION, checkout, attempt).reason, 'composition_checkout_dirty');
    assert.equal(JSON.stringify(store.getTicket(project, rootTicket.ref)), before);
  } finally {
    fs.unlinkSync(dirty);
  }
  assertRetainedProofsAndSources();
}

// Provisioning callbacks and the claim must name this generation's preparedAt and nonce, and the claim
// revalidates the bound source review under the composition locks.
function assertCompositionClaimFences(claim: ClaimProbe): void {
  const before = JSON.stringify(store.getTicket(project, rootTicket.ref));
  const oldAttempt = JSON.parse(rootReleasedSnapshot).preparedAt;
  assert.equal(store.recordDispatchWorktreeProvisioned(project, SESSION, claim.checkout, oldAttempt).reason, 'stale_attempt');
  const options = { executor: claim.executor, sessionId: SESSION };
  assert.equal(store.claimTicket(project, rootTicket.ref, 'composition-new-root', { ...options, token: oldRootToken }).reason, 'token');
  setSourceReviewStatus('awaiting-oracle');
  try {
    assert.equal(store.claimTicket(project, rootTicket.ref, 'composition-new-root', { ...options, token: claim.token }).reason, 'stale_source');
  } finally {
    setSourceReviewStatus('todo');
  }
  assert.equal(JSON.stringify(store.getTicket(project, rootTicket.ref)), before);
  assertRetainedProofsAndSources();
}

function assertExactCompositionSubmissionFacts(root: CompositionTicket): void {
  const commits = git(['rev-list', `${originalBase}..${candidate}`]).split(/\r?\n/);
  const submitted = { base: originalBase, commit: candidate, commits };
  assert.equal(exactCompositionSubmissionRefusal(root, submitted), undefined);
  assert.equal(exactCompositionSubmissionRefusal(root, { ...submitted, base: candidate })?.reason, 'composition_submission_mismatch');
  assert.equal(exactCompositionSubmissionRefusal(root, { ...submitted, commits: [candidate] })?.reason, 'composition_submission_mismatch');
  assert.equal(exactCompositionSubmissionRefusal(root, { ...submitted, commit: sourceARange.commit })?.reason, 'composition_submission_mismatch');
  const scope = compositionSubmissionScope(root);
  assert.ok(scope);
  assert.deepEqual([...scope].sort(), ['.release/unreleased/SQ-1.md', '.release/unreleased/SQ-2.md', '.release/unreleased/SQ-3.md', 'src/a.ts', 'src/b.ts', 'src/first.test.ts', 'src/second.test.ts']);
  const source = store.getTicket(project, sourceARange.ref);
  assert.equal(compositionIncludesSource(root, source, commits), true);
  assert.equal(compositionIncludesSource(root, source, [candidate]), false);
  assert.equal(compositionIncludesSource(root, root, commits), false);
  assertOnlyTheConsumedGenerationAdmitsSources(root, source, commits);
}

function assertOnlyTheConsumedGenerationAdmitsSources(root: CompositionTicket, source: CompositionTicket, commits: readonly string[]): void {
  assert.ok(root.compositionAdmission && root.dispatch);
  const unconsumed: CompositionTicket = { ...root, compositionAdmission: { ...root.compositionAdmission, consumedBy: null } };
  const otherGeneration: CompositionTicket = { ...root, dispatch: { ...root.dispatch, preparedAt: JSON.parse(rootReleasedSnapshot).preparedAt } };
  for (const stale of [unconsumed, otherGeneration]) {
    assert.equal(compositionSubmissionScope(stale), null);
    assert.equal(compositionIncludesSource(stale, source, commits), false);
  }
}

async function prepareCompositionVerifier(): Promise<string> {
  const command = "node -e \"const assert = require('node:assert/strict'); const fs = require('node:fs'); assert.equal(fs.readFileSync('src/first.test.ts', 'utf8').trim(), 'export const first = 2;'); assert.equal(fs.readFileSync('src/second.test.ts', 'utf8').trim(), 'export const second = 2;'); assert.equal(fs.readFileSync('src/a.ts', 'utf8').trim(), 'export const sourceA = true;', 'source A at exact C'); assert.equal(fs.readFileSync('src/b.ts', 'utf8').trim(), 'export const sourceB = true;'); console.log('Current exact composition checked');\"";
  const updated = await boardTool('update', { ref: rootTicket.ref, verify: command, verifyKind: 'command', verifyCwd: '.' });
  assert.equal(updated.ok, true, JSON.stringify(updated));
  return command;
}

async function recordCompositionNegativeControl(checkout: string, command: string): Promise<void> {
  const sourceFile = path.join(checkout, 'src/a.ts');
  const original = fs.readFileSync(sourceFile, 'utf8');
  fs.writeFileSync(sourceFile, 'export const sourceA = false;\n');
  try {
    const control = spawnSync(command, { cwd: checkout, shell: true, encoding: 'utf8', timeout: 30_000, windowsHide: true });
    assert.equal(control.error, undefined);
    assert.equal(control.status, 1);
    assert.match(control.stderr, /AssertionError/);
    assert.match(control.stderr, /source A at exact C/);
    const recorded = await boardTool('comment', { ref: rootTicket.ref, by: 'composition-new-root',
      body: `[sidequest:negative-control] target=src/a.ts sourceA at exact C; assertion=source A at exact C; ${command} failed=1 failure-kind=assertion` });
    assert.equal(recorded.ok, true, JSON.stringify(recorded));
  } finally {
    fs.writeFileSync(sourceFile, original);
  }
  assert.equal(gitIn(checkout, ['status', '--porcelain']), '');
  assertRetainedProofsAndSources();
}

// A capture of exact C still has to come from this generation's own native checkout instance.
function assertCompositionCaptureCheckoutFences(root: CompositionTicket, checkout: string): void {
  const fresh = { candidate: { source: 'git', value: candidate }, completedAt: new Date().toISOString(), cleanWorktree: true };
  assert.equal(compositionCaptureRefusal(root, { ...fresh, worktree: checkout }), undefined);
  assert.equal(compositionCaptureRefusal(root, { ...fresh, worktree: repository })?.reason, 'composition_capture_checkout_mismatch');
  assert.equal(compositionCaptureRefusal(root, { ...fresh, worktree: oldRootCheckout })?.reason, 'composition_capture_checkout_mismatch');
  assert.equal(compositionCaptureRefusal(root, { ...fresh, worktree: path.join(repository, 'missing-checkout') })?.reason, 'composition_capture_checkout_unavailable');
  assert.equal(compositionCaptureRefusal(root, fresh)?.reason, 'composition_capture_checkout_unavailable');
}

// After submit the generation has no live nonce, so the active boundary refuses before any claim logic.
function assertSubmittedGenerationCannotBeClaimed(): void {
  const submitted = store.getTicket(project, rootTicket.ref);
  const reclaimed = store.claimTicket(project, rootTicket.ref, 'composition-new-root', { token: oldRootToken, executor: submitted.dispatchExecutor, sessionId: SESSION });
  assert.equal(reclaimed.reason, 'stale_generation', JSON.stringify(reclaimed));
  assert.equal(JSON.stringify(store.getTicket(project, rootTicket.ref)), JSON.stringify(submitted));
}

async function captureAndSubmitComposition(checkout: string, command: string): Promise<void> {
  gitIn(checkout, ['update-ref', `refs/sidequest/${rootTicket.ref}`, candidate]);
  const target = { project: repository, ticket: rootTicket.ref };
  const resolved = capture.captureCommand([], target);
  assert.equal(resolved.command, command, JSON.stringify(resolved));
  const current = store.getTicket(project, rootTicket.ref);
  await whileSourceReviewChanged(async () => {
    const raced = await capture.runCapturedVerification(resolved.command, target, checkout, fs, checkout);
    assert.equal(raced.recorded?.reason, 'stale_source', JSON.stringify(raced));
  });
  assert.equal(JSON.stringify(store.getTicket(project, rootTicket.ref)), JSON.stringify(current), 'a refused capture records nothing');
  const verified = await capture.runCapturedVerification(resolved.command, target, checkout, fs, checkout);
  assert.equal(verified.refusal, null, JSON.stringify(verified));
  assert.equal(verified.capture.status, 'passed', JSON.stringify(verified));
  assert.equal(verified.recorded.ok, true, JSON.stringify(verified));
  const fresh = store.getTicket(project, rootTicket.ref).verificationCaptures.at(-1);
  assert.equal(fresh.candidate.value, candidate);
  assert.equal(fresh.dispatchNonce, current.dispatchNonce);
  assert.notEqual(fresh.logPath, oldRootProof);
  const submission = { ref: rootTicket.ref, by: 'composition-new-root', worktree: checkout,
    commit: candidate, verify: command, body: 'Current isolated native holder captured exact C and submits the complete original range. Included sources remain pending.' };
  const captured = JSON.stringify(store.getTicket(project, rootTicket.ref));
  await whileSourceReviewChanged(async () => assert.match(await boardToolText('submit', submission), /stale_source/));
  assert.equal(JSON.stringify(store.getTicket(project, rootTicket.ref)), captured, 'a refused submit writes nothing');
  const submitted = await boardTool('submit', submission);
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  const root: CompositionTicket = store.getTicket(project, rootTicket.ref);
  assert.equal(exactCompositionSubmissionRefusal(root, root.submission), undefined);
  assert.equal(root.submission?.base, originalBase);
  assert.equal(root.dispatch?.outcome, 'submitted');
  assertRetainedProofsAndSources();
}

// A multi-participant wave would deliver without the composition locks, and a source review change after
// the root's review still refuses delivery. Neither moves the target branch or writes the root.
async function assertDeliveryBoundaryRefusals(): Promise<void> {
  const reviewed = JSON.stringify(store.getTicket(project, rootTicket.ref));
  const wave = store.integrateSubmissionWave(project, [rootTicket.ref, sourceBRange.ref], { mode: 'merge' });
  assert.equal(wave.reason, 'composition_wave_unsupported', JSON.stringify(wave));
  await whileSourceReviewChanged(async () => {
    const raced = await boardTool('integrate', { ref: rootTicket.ref, by: 'composition-current-main', mode: 'merge' });
    assert.equal(raced.reason, 'stale_source', JSON.stringify(raced));
  });
  assert.equal(JSON.stringify(store.getTicket(project, rootTicket.ref)), reviewed);
  assert.equal(git(['rev-parse', 'HEAD']), originalBase);
  assertRetainedProofsAndSources();
}

async function reviewAndDeliverComposition(): Promise<void> {
  git(['checkout', 'main']);
  const submitted = JSON.stringify(store.getTicket(project, rootTicket.ref));
  const unreviewed = await boardTool('integrate', { ref: rootTicket.ref, by: 'composition-current-main', mode: 'merge' });
  assert.equal(unreviewed.reason, 'candidate_review_required', JSON.stringify(unreviewed));
  assert.equal(JSON.stringify(store.getTicket(project, rootTicket.ref)), submitted);
  assert.equal(git(['rev-parse', 'HEAD']), originalBase);
  const added = await boardTool('add', { title: 'Independent review of submitted exact composition', category: 'review-audit',
    files: ['src'], route: { model: 'sonnet', effort: 'high' }, reviewTarget: { ref: rootTicket.ref, commit: candidate } });
  assert.equal(added.ok, true, JSON.stringify(added));
  const reviewRef = String(added.ref);
  const reviewCheckout = freshNativeCheckout(reviewRef, 'composition-independent-reviewer', 'reviewer');
  assert.equal(gitIn(reviewCheckout, ['rev-parse', 'HEAD']), candidate);
  assert.equal(fs.readFileSync(path.join(reviewCheckout, 'src/first.test.ts'), 'utf8'), 'export const first = 2;\n');
  assert.equal(fs.readFileSync(path.join(reviewCheckout, 'src/second.test.ts'), 'utf8'), 'export const second = 2;\n');
  const completed = await boardTool('done', { ref: reviewRef, by: 'composition-independent-reviewer',
    body: 'Checked submitted exact C in the independent native checkout, including both existing root tests and the complete source range. No oracle verdict is claimed.' });
  assert.equal(completed.ok, true, JSON.stringify(completed));
  const relation = store.submissionReviewRelation(project, store.getTicket(project, rootTicket.ref));
  assert.equal(relation.reviewTicket.status, 'done');
  assert.equal(relation.mirror.outcome, 'planned');
  assert.equal(relation.reviewTarget.candidate.value, candidate);
  await assertDeliveryBoundaryRefusals();
  const integrated = await boardTool('integrate', { ref: rootTicket.ref, by: 'composition-current-main', mode: 'merge' });
  assert.equal(integrated.ok, true, JSON.stringify(integrated));
  git(['merge-base', '--is-ancestor', candidate, 'HEAD']);
  const delivered: CompositionTicket = store.getTicket(project, rootTicket.ref);
  assert.equal(delivered.submission?.base, originalBase);
  assert.equal(delivered.submission?.commit, candidate);
  assert.ok(delivered.submission?.integratedAt);
  assertRetainedProofsAndSources();
}

// The index bytes are read before any git command, and only read-only plumbing runs, so a refresh cannot rewrite them.
function compositionRecoveryWitness(checkout: string): string {
  const indexFile = gitIn(checkout, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
  const index = createHash('sha256').update(fs.readFileSync(indexFile)).digest('hex');
  const root = store.getTicket(project, rootTicket.ref);
  return JSON.stringify({ index, tickets: store.listTickets(project), token: fs.readFileSync(root.dispatch.tokenFile, 'utf8'),
    proof: fs.readFileSync(oldRootProof, 'utf8'), head: gitIn(checkout, ['rev-parse', 'HEAD']),
    branch: gitIn(checkout, ['symbolic-ref', 'HEAD']), staged: gitIn(checkout, ['ls-files', '--stage']) });
}

// Same-holder recovery would re-mint the nonce the consumed admission names, stranding the claim as stale_generation.
async function assertConsumedCompositionRecoveryRefusal(checkout: string): Promise<void> {
  const before = compositionRecoveryWitness(checkout);
  const refused = await boardToolText('dispatch', { ref: rootTicket.ref, claimHolder: 'composition-new-root', worktree: checkout,
    recoveryEvidence: 'composition-new-root holds the live claim in this bound native checkout and asks for its token to be re-minted.' });
  assert.match(refused, /Composition admission was already consumed\. A new dispatch cannot replay it\. Live-claim recovery would re-mint the dispatch nonce/);
  assert.equal(compositionRecoveryWitness(checkout), before, 'a refused composition recovery writes nothing');
  assertRetainedProofsAndSources();
}

test('composition admission: fresh native checkout capture full-range submit independent review and delivery preserve sources, consumption cannot replay', async () => {
  const command = await prepareCompositionVerifier();
  const before = JSON.stringify(store.getTicket(project, rootTicket.ref));
  assert.throws(() => store.prepareDispatch(project, rootTicket.ref, { sharedTree: true, sessionId: SESSION, runtimeCwd: repository }), /native isolated/);
  assert.equal(JSON.stringify(store.getTicket(project, rootTicket.ref)), before);
  const checkout = freshNativeCheckout(rootTicket.ref, 'composition-new-root', 'new-root', {
    beforeBinding: assertCompositionCreationRefusals, beforeCompletion: assertCompositionCompletionRefusals,
    beforeClaim: assertCompositionClaimFences,
  });
  await assertConsumedCompositionRecoveryRefusal(checkout);
  const root = store.getTicket(project, rootTicket.ref);
  assert.equal(root.dispatch.baseCommit, originalBase);
  assert.equal(root.dispatch.compositionAdmission.rangeBase, originalBase);
  assert.equal(root.dispatch.compositionAdmission.checkoutCommit, candidate);
  assert.equal(gitIn(checkout, ['rev-parse', 'HEAD']), candidate);
  assert.equal(gitIn(checkout, ['status', '--porcelain']), '');
  assert.notEqual(checkout, oldRootCheckout);
  assert.notEqual(root.dispatch.worktreeCheckoutInstance, JSON.parse(rootReleasedSnapshot).worktreeCheckoutInstance);
  assert.equal(root.compositionAdmission.consumedBy.preparedAt, root.dispatch.preparedAt);
  assert.equal(JSON.stringify(root.compositionAdmission.releasedDispatch), rootReleasedSnapshot);
  assert.equal(root.compositionAdmission.consumedBy.nonceDigest, createHash('sha256').update(root.dispatchNonce.replace(/[\s-]/g, '').toLowerCase()).digest('hex'));
  assertExactCompositionSubmissionFacts(root);
  assertCompositionCaptureCheckoutFences(root, checkout);
  assertRetainedProofsAndSources();
  await recordCompositionNegativeControl(checkout, command);
  await captureAndSubmitComposition(checkout, command);
  assertSubmittedGenerationCannotBeClaimed();
  const submitted = JSON.stringify(store.getTicket(project, rootTicket.ref));
  assert.throws(() => store.prepareDispatch(project, rootTicket.ref, { sharedTree: false, sessionId: SESSION, runtimeCwd: repository }), /admission_consumed/);
  assert.equal(JSON.stringify(store.getTicket(project, rootTicket.ref)), submitted, 'replay is write-free');
  assertRetainedProofsAndSources();
  await reviewAndDeliverComposition();
});
