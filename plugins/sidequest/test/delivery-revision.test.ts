import './_temp-cleanup.js';
'use strict';
/**
 * Manual delivery of a candidate that was rebased or squash-merged before it
 * landed (GitHub #144). The working-tree byte compare cannot record these: the
 * landed tree legitimately differs from the candidate blob, and later merges keep
 * moving it. These fixtures are shaped like the reported ones — one file with
 * drift from an earlier merge, one conflict resolved by hand at landing, and
 * candidate deletions.
 *
 * Run: node --import tsx --test plugins/sidequest/test/delivery-revision.test.ts
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-delivery-revision-home-'));
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;

const store = require('../lib/store.js');
const commitScope = require('../lib/commit-scope.js');
const { makeCliRunner } = require('./_helpers.js');

const BIN = path.join(__dirname, '..', 'bin', 'sidequest.js');
const exploration = store.getCategory('codebase-exploration');
store.setCategory(Object.assign({}, exploration, { route: { model: 'sonnet', effort: 'medium' }, fallback: null }));

const DRIFTED_FILE = 'src/feature.test.js';
const DELETED_FILE = 'src/legacy-helper.js';
const ADDED_FILE = 'src/added-note.md';

function git(args: string[], cwd: string) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

function head(cwd: string, revision = 'HEAD') {
  return git(['rev-parse', revision], cwd);
}

function nodeVerify(source: string) {
  return `"${process.execPath}" -e "${source.replace(/"/g, '\\"')}"`;
}

function baseLines() {
  return Array.from({ length: 40 }, (_, index) => `const step${index + 1} = ${index + 1};`);
}

function writeLines(cwd: string, file: string, lines: string[]) {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), `${lines.join('\n')}\n`);
}

function commitAll(cwd: string, message: string) {
  git(['add', '-A'], cwd);
  git(['commit', '-m', message], cwd);
  return head(cwd);
}

/**
 * main never merges the candidate: it lands rebased (or hand-resolved) on top of
 * an earlier merge that already touched the same file, and one later commit moves
 * main past the landing so the current working tree matches neither side.
 */
function deliveryFixture(label: string, opts: { landedStep20?: string; keepDeletedFile?: boolean } = {}) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), `sq-delivery-revision-${label}-`));
  git(['init', '-b', 'main'], repo);
  git(['config', 'user.name', 'Sidequest Test'], repo);
  git(['config', 'user.email', 'sidequest-test@example.invalid'], repo);
  fs.writeFileSync(path.join(repo, '.gitignore'), '.claude/*\n');
  writeLines(repo, DRIFTED_FILE, baseLines());
  writeLines(repo, DELETED_FILE, ['module.exports = { legacy: true };']);
  const base = commitAll(repo, 'base');

  const worktree = path.join(repo, '.claude', 'worktrees', 'agent-candidate');
  git(['worktree', 'add', '-b', 'worktree-agent-candidate', worktree, 'main'], repo);
  const candidateLines = baseLines();
  candidateLines[19] = "const step20 = 'candidate';";
  writeLines(worktree, DRIFTED_FILE, candidateLines);
  writeLines(worktree, ADDED_FILE, ['candidate note']);
  fs.rmSync(path.join(worktree, DELETED_FILE));
  const candidate = commitAll(worktree, 'candidate work');

  const { slug } = store.ensureProject(repo);
  const ticket = store.createTicket(slug, {
    title: `rebased manual delivery ${label}`,
    category: 'codebase-exploration',
    description: 'A reviewed candidate that landed upstream after a rebase over concurrent work on the same file.',
    files: ['src'],
  });
  const gitRef = `refs/sidequest/${ticket.ref}`;
  git(['update-ref', gitRef, candidate], worktree);
  const target = store.integrationTarget(slug);
  const range = commitScope.submissionRange(worktree, {
    commit: candidate,
    gitRef,
    upstream: target.upstream,
    integrationBranch: target.branch,
  });
  assert.equal(range.ok, true, JSON.stringify(range));
  assert.equal(store.claimTicket(slug, ticket.ref, 'candidate-worker', {
    direct: true,
    reason: 'The rebased delivery fixture requires a local direct claim.',
  }).ok, true);
  assert.equal(store.submitTicket(slug, ticket.ref, 'candidate-worker', {
    commit: candidate,
    gitRef,
    range,
    worktree,
    verify: nodeVerify('process.exit(0)'),
  }).ok, true, 'the fixture candidate is submitted before it lands');

  const driftedLines = baseLines();
  driftedLines[2] = "const step3 = 'earlier merge drift';";
  writeLines(repo, DRIFTED_FILE, driftedLines);
  commitAll(repo, 'earlier merge touches the same file');

  const landedLines = driftedLines.slice();
  landedLines[19] = opts.landedStep20 ?? "const step20 = 'candidate';";
  writeLines(repo, DRIFTED_FILE, landedLines);
  writeLines(repo, ADDED_FILE, ['candidate note']);
  if (!opts.keepDeletedFile) fs.rmSync(path.join(repo, DELETED_FILE));
  const landed = commitAll(repo, 'squash-merge the rebased candidate');

  const laterLines = landedLines.slice();
  laterLines[39] = "const step40 = 'later merge';";
  writeLines(repo, DRIFTED_FILE, laterLines);
  const laterHead = commitAll(repo, 'a later merge moves main past the landing');

  assert.notEqual(git(['merge-base', candidate, 'HEAD'], repo), candidate, 'the candidate never became reachable');
  return { repo, worktree, slug, ticket, base, candidate, landed, laterHead, submittedPaths: range.changedPaths };
}

function record(fixture: any, opts: any) {
  return store.recordDeliveredSubmission(fixture.slug, fixture.ticket.ref, Object.assign({
    target: store.integrationTarget(fixture.slug),
    deliveryCommit: fixture.candidate,
    deliveryMethod: 'manual',
    by: 'orchestrator',
    reason: 'The candidate landed through an upstream merge request after a rebase over concurrent work.',
  }, opts));
}

test('a rebased candidate records against the tree at deliveryRevision with per-path proof', () => {
  const fixture = deliveryFixture('rebased');
  assert.deepEqual(fixture.submittedPaths.slice().sort(), [ADDED_FILE, DRIFTED_FILE, DELETED_FILE]);

  const withoutRevision = record(fixture, {});
  assert.equal(withoutRevision.ok, false, 'the working-tree compare still refuses a rebased candidate');
  assert.equal(withoutRevision.reason, 'delivery_content_missing');
  assert.match(withoutRevision.message, new RegExp(DRIFTED_FILE.replace(/\//g, '\\/')));
  assert.match(withoutRevision.message, /deliveryRevision/);

  const delivered = record(fixture, { deliveryRevision: fixture.landed });
  assert.equal(delivered.ok, true, delivered.message);
  assert.equal(delivered.integration.mode, 'recorded-working-tree');
  assert.equal(delivered.integration.contentEvidence, 'delivery_revision_contains_candidate');
  assert.equal(delivered.integration.deliveryIdentity.revision, fixture.landed);
  assert.equal(delivered.integration.deliveryIdentity.method, 'manual');
  assert.equal(delivered.integration.contentProof.revision, fixture.landed);
  assert.deepEqual(delivered.integration.contentProof.identical, [ADDED_FILE]);
  assert.deepEqual(delivered.integration.contentProof.reverseApplied, [DRIFTED_FILE]);
  assert.deepEqual(delivered.integration.contentProof.deleted, [DELETED_FILE]);
  assert.deepEqual(delivered.integration.contentProof.resolved, []);
  assert.deepEqual(delivered.integration.deliveredFiles.slice().sort(), [ADDED_FILE, DRIFTED_FILE, DELETED_FILE]);
  assert.equal(delivered.integration.verify.status, 'passed');
});

test('a hand-resolved landing refuses until resolvedPaths attests exactly the diverging paths', () => {
  const fixture = deliveryFixture('conflicted', { landedStep20: "const step20 = 'resolved at landing';" });

  const diverged = record(fixture, { deliveryRevision: fixture.landed });
  assert.equal(diverged.ok, false);
  assert.equal(diverged.reason, 'delivery_content_diverged');
  assert.deepEqual(diverged.divergingPaths, [DRIFTED_FILE]);
  assert.match(diverged.message, new RegExp(DRIFTED_FILE.replace(/\//g, '\\/')));
  assert.match(diverged.message, /resolvedPaths/);

  const padded = record(fixture, { deliveryRevision: fixture.landed, resolvedPaths: [DRIFTED_FILE, ADDED_FILE] });
  assert.equal(padded.ok, false, 'a path the proof already preserved cannot be attested');
  assert.equal(padded.reason, 'resolved_paths_invalid');
  assert.match(padded.message, new RegExp(ADDED_FILE.replace(/\//g, '\\/')));

  const unsubmitted = record(fixture, { deliveryRevision: fixture.landed, resolvedPaths: ['src/never-submitted.js'] });
  assert.equal(unsubmitted.ok, false);
  assert.equal(unsubmitted.reason, 'resolved_paths_invalid');
  assert.match(unsubmitted.message, /src\/never-submitted\.js/);

  const withoutRevision = record(fixture, { resolvedPaths: [DRIFTED_FILE] });
  assert.equal(withoutRevision.ok, false);
  assert.equal(withoutRevision.reason, 'resolved_paths_invalid');
  assert.match(withoutRevision.message, /deliveryRevision/);

  const attested = record(fixture, { deliveryRevision: fixture.landed, resolvedPaths: [DRIFTED_FILE] });
  assert.equal(attested.ok, true, attested.message);
  assert.equal(attested.integration.contentEvidence, 'delivery_revision_contains_candidate:operator_resolved');
  assert.deepEqual(attested.integration.contentProof.reverseApplied, []);
  assert.deepEqual(attested.integration.contentProof.deleted, [DELETED_FILE]);
  assert.equal(attested.integration.contentProof.resolved.length, 1);
  assert.equal(attested.integration.contentProof.resolved[0].path, DRIFTED_FILE);
  assert.equal(attested.integration.contentProof.resolved[0].by, 'orchestrator');
  assert.match(attested.integration.contentProof.resolved[0].reason, /landed through an upstream merge request/);
  assert.match(attested.integration.contentProof.resolved[0].at, /^\d{4}-\d{2}-\d{2}T/);
});

test('deliveryRevision must resolve in the integration checkout and be reachable from the target', () => {
  const fixture = deliveryFixture('unreachable');

  const unknown = record(fixture, { deliveryRevision: 'a'.repeat(40) });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.reason, 'delivery_revision_not_reachable');
  assert.match(unknown.message, /main/);

  const unreachable = record(fixture, { deliveryRevision: fixture.candidate });
  assert.equal(unreachable.ok, false);
  assert.equal(unreachable.reason, 'delivery_revision_not_reachable');
  assert.match(unreachable.message, new RegExp(fixture.candidate));
  assert.match(unreachable.message, /main/);
});

test('a candidate deletion absent from the integration working tree stays preserved content', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-delivery-revision-deletion-'));
  git(['init', '-b', 'main'], repo);
  git(['config', 'user.name', 'Sidequest Test'], repo);
  git(['config', 'user.email', 'sidequest-test@example.invalid'], repo);
  fs.writeFileSync(path.join(repo, '.gitignore'), '.claude/*\n');
  fs.writeFileSync(path.join(repo, 'README.md'), 'deletion fixture\n');
  writeLines(repo, DELETED_FILE, ['module.exports = { legacy: true };']);
  commitAll(repo, 'base');

  const worktree = path.join(repo, '.claude', 'worktrees', 'agent-deletion');
  git(['worktree', 'add', '-b', 'worktree-agent-deletion', worktree, 'main'], repo);
  fs.rmSync(path.join(worktree, DELETED_FILE));
  const candidate = commitAll(worktree, 'retire the legacy helper');

  const { slug } = store.ensureProject(repo);
  const ticket = store.createTicket(slug, {
    title: 'manual delivery of a candidate deletion',
    category: 'codebase-exploration',
    description: 'A candidate whose only change deletes a path the integration branch also retired.',
    files: ['src'],
  });
  const gitRef = `refs/sidequest/${ticket.ref}`;
  git(['update-ref', gitRef, candidate], worktree);
  const target = store.integrationTarget(slug);
  const range = commitScope.submissionRange(worktree, {
    commit: candidate,
    gitRef,
    upstream: target.upstream,
    integrationBranch: target.branch,
  });
  assert.equal(range.ok, true, JSON.stringify(range));
  assert.deepEqual(range.changedPaths, [DELETED_FILE]);
  assert.equal(store.claimTicket(slug, ticket.ref, 'deletion-worker', {
    direct: true,
    reason: 'The deletion delivery fixture requires a local direct claim.',
  }).ok, true);
  assert.equal(store.submitTicket(slug, ticket.ref, 'deletion-worker', {
    commit: candidate,
    gitRef,
    range,
    worktree,
    verify: nodeVerify('process.exit(0)'),
  }).ok, true);

  fs.rmSync(path.join(repo, DELETED_FILE));
  commitAll(repo, 'retire the legacy helper upstream');
  fs.writeFileSync(path.join(repo, 'README.md'), 'a later merge moves main on\n');
  commitAll(repo, 'later merge');
  assert.notEqual(git(['merge-base', candidate, 'HEAD'], repo), candidate, 'the candidate never became reachable');

  const delivered = store.recordDeliveredSubmission(slug, ticket.ref, {
    target: store.integrationTarget(slug),
    deliveryCommit: candidate,
    deliveryMethod: 'manual',
    by: 'orchestrator',
    reason: 'The legacy helper is retired on the integration branch exactly as the candidate retired it.',
  });
  assert.equal(delivered.ok, true, delivered.message);
  assert.equal(delivered.integration.contentEvidence, 'working_tree_matches_candidate');
});

test('CLI groom-close threads --delivery-revision and --resolved-path through to the recorded proof', () => {
  const fixture = deliveryFixture('cli', { landedStep20: "const step20 = 'resolved at landing';" });
  const { runCli } = makeCliRunner(BIN, { SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: fixture.repo }, { cwd: fixture.repo });

  const refused = runCli(['groom-close', fixture.ticket.ref, '--by', 'orchestrator', '--json',
    '--delivery-commit', fixture.candidate, '--delivery-method', 'manual',
    '--delivery-revision', fixture.landed,
    '--reason', 'The candidate landed through an upstream merge request after a rebase.']);
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.match(refused.stdout, /delivery_content_diverged/);

  const closed = runCli(['groom-close', fixture.ticket.ref, '--by', 'orchestrator', '--json',
    '--delivery-commit', fixture.candidate, '--delivery-method', 'manual',
    '--delivery-revision', fixture.landed,
    '--resolved-path', DRIFTED_FILE,
    '--reason', 'The import conflict was resolved by hand at landing; the merge request carries the review.']);
  assert.equal(closed.status, 0, closed.stdout + closed.stderr);
  const integration = store.getTicket(fixture.slug, fixture.ticket.ref).submission.integration;
  assert.equal(integration.contentEvidence, 'delivery_revision_contains_candidate:operator_resolved');
  assert.equal(integration.contentProof.revision, fixture.landed);
  assert.deepEqual(integration.contentProof.resolved.map((entry: any) => entry.path), [DRIFTED_FILE]);
  assert.equal(integration.contentProof.resolved[0].by, 'orchestrator');
});
