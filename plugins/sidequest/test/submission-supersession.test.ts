import './_temp-cleanup.js';
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-supersession-home-'));
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;

const store = require('../lib/store.js');
const mcp = require('../lib/mcp.js');
const db = require('../lib/db.js');

function git(repository: string, args: string[]) {
  return execFileSync('git', args, { cwd: repository, encoding: 'utf8', windowsHide: true }).trim();
}

function commit(repository: string, filename: string, contents: string) {
  fs.mkdirSync(path.dirname(path.join(repository, filename)), { recursive: true });
  fs.writeFileSync(path.join(repository, filename), contents);
  git(repository, ['add', filename]);
  git(repository, ['commit', '-m', filename]);
  return git(repository, ['rev-parse', 'HEAD']);
}

function remove(repository: string, filename: string) {
  fs.unlinkSync(path.join(repository, filename));
  git(repository, ['add', filename]);
  git(repository, ['commit', '-m', `remove ${filename}`]);
  return git(repository, ['rev-parse', 'HEAD']);
}

function persist(slug: string, ticket: any) {
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

function fixture(label: string, retiredPaths: string[] = []) {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), `sq-supersession-${label}-`));
  git(repository, ['init']);
  git(repository, ['config', 'user.name', 'Sidequest Test']);
  git(repository, ['config', 'user.email', 'sidequest-test@example.invalid']);
  const base = commit(repository, 'README.md', 'base\n');
  let submitted = commit(repository, 'feature.txt', 'original delivery\n');
  for (const filename of retiredPaths) submitted = commit(repository, filename, 'obsolete delivery\n');
  let repaired = commit(repository, 'feature.txt', 'reviewed repair\n');
  for (const filename of retiredPaths) repaired = remove(repository, filename);
  const { slug } = store.ensureProject(repository);
  const source = store.createTicket(slug, {
    title: `source ${label}`,
    description: 'An earlier submitted range closed by a later repair.',
    files: ['feature.txt'],
  });
  source.status = 'doing';
  source.submission = {
    by: 'executor',
    at: new Date().toISOString(),
    commit: submitted,
    base,
    commits: [submitted],
    changedPaths: ['feature.txt'].concat(retiredPaths),
    verify: 'manual: fixture',
    integratedAt: null,
  };
  persist(slug, source);
  const repair = store.createTicket(slug, {
    title: `repair ${label}`,
    description: 'The integrated repair delivery.',
    files: ['feature.txt'],
  });
  repair.status = 'done';
  repair.submission = {
    commit: repaired,
    integratedAt: new Date().toISOString(),
    integration: {
      outcome: 'verified',
      resultingHead: repaired,
      deliveredAt: new Date().toISOString(),
      deliveredFiles: ['feature.txt'],
    },
  };
  persist(slug, repair);
  return { repository, slug, source, repair, base };
}

async function supersede(input: any) {
  const tool = mcp.TOOLS.find((candidate: any) => candidate.name === 'supersede_submission');
  assert.ok(tool, 'supersede_submission is exposed over MCP');
  return tool.handler(input);
}

function mergeDelivery(repository: string, base: string) {
  git(repository, ['branch', 'delivery-topic', 'HEAD^']);
  git(repository, ['reset', '--hard', base]);
  git(repository, ['merge', '--no-ff', '--no-edit', 'delivery-topic']);
  return git(repository, ['rev-parse', 'HEAD']);
}

function recoveredRepairFixture(label: string, purpose: string = 'delivery', prepareDelivery?: (repository: string, base: string) => string) {
  const { repository, slug, source, base } = fixture(`recovered-${label}`);
  const deliveryCommit = purpose === 'delivery'
    ? prepareDelivery ? prepareDelivery(repository, base) : git(repository, ['rev-parse', 'HEAD'])
    : undefined;
  const repair = store.createTicket(slug, {
    title: `recovered repair ${label}`,
    description: 'A reviewed repair closed after delivery recovery.',
    files: ['feature.txt'],
  });
  store.addComment(slug, repair.ref, { by: 'reviewer', source: 'test', body: 'reviewed-by: SQ-review' });
  const completed = store.completeTicketAsControlPlane(slug, repair.ref, {
    by: 'integrator',
    purpose,
    reason: 'The reviewed repair reached the integration branch.',
    ...(deliveryCommit ? { deliveryCommit } : {}),
  });
  return { repository, slug, source, repair, completed, deliveryCommit };
}

test('a reviewed hand-delivered repair supersedes the earlier submission over MCP', async () => {
  const { repository, slug, source, repair, completed } = recoveredRepairFixture('reachable');
  assert.equal(completed.ok, true, completed.message);
  assert.equal(completed.ticket.completion.delivery.commit, git(repository, ['rev-parse', 'HEAD']));

  const result = await supersede({
    project: repository,
    ref: source.ref,
    by: 'orchestrator',
    supersededBy: repair.ref,
    reason: 'The reviewed recovery delivery replaces the rejected submitted range.',
    reviewedReplacements: [{ path: 'feature.txt', reviewedBy: 'SQ-review', reason: 'The reviewed repair replaces the submitted feature.' }],
  });

  assert.equal(result.ok, true, result.message);
  assert.equal(store.getTicket(slug, source.ref).submission.supersededBy.resultingHead, completed.ticket.completion.delivery.integrationRevision.value);
});

test('a reviewed merge delivery uses its first-parent lineage over MCP', async () => {
  const { repository, source, repair, completed, deliveryCommit } = recoveredRepairFixture('merge', 'delivery', mergeDelivery);
  assert.equal(completed.ok, true, completed.message);
  assert.equal(git(repository, ['show', '-s', '--format=%P', deliveryCommit!]).split(/\s+/).length, 2, 'fixture delivery is a merge commit');

  const parentlessPaths = git(repository, ['diff-tree', '--no-commit-id', '--name-only', '-r', deliveryCommit!]).split(/\r?\n/).filter(Boolean);
  assert.deepEqual(parentlessPaths, [], 'negative control: parentless diff-tree loses a merge delivery delta');

  const result = await supersede({
    project: repository,
    ref: source.ref,
    by: 'orchestrator',
    supersededBy: repair.ref,
    reason: 'The reviewed merge delivery replaces the rejected submitted range.',
  });

  assert.equal(result.ok, true, result.message);
});

test('missing or unreachable recovery delivery cannot supersede a submission', async () => {
  const missing = recoveredRepairFixture('missing', 'grooming');
  assert.equal(missing.completed.ok, true, missing.completed.message);
  const missingResult = await supersede({
    project: missing.repository,
    ref: missing.source.ref,
    by: 'orchestrator',
    supersededBy: missing.repair.ref,
    reason: 'A grooming closure does not establish delivery.',
    reviewedReplacements: [{ path: 'feature.txt', reviewedBy: 'SQ-review', reason: 'The repair was reviewed.' }],
  });
  assert.equal(missingResult.reason, 'repair_not_integrated');

  const unreachable = recoveredRepairFixture('unreachable');
  const storedRepair = store.getTicket(unreachable.slug, unreachable.repair.ref);
  storedRepair.completion.delivery.integrationRevision.value = git(unreachable.repository, ['rev-parse', `${storedRepair.completion.delivery.commit}^`]);
  persist(unreachable.slug, storedRepair);
  const unreachableResult = await supersede({
    project: unreachable.repository,
    ref: unreachable.source.ref,
    by: 'orchestrator',
    supersededBy: unreachable.repair.ref,
    reason: 'Delivery evidence must stay reachable from its recorded integration revision.',
    reviewedReplacements: [{ path: 'feature.txt', reviewedBy: 'SQ-review', reason: 'The repair was reviewed.' }],
  });
  assert.equal(unreachableResult.reason, 'repair_not_integrated');
  assert.equal(store.getTicket(unreachable.slug, unreachable.source.ref).status, 'doing');
});

test('a reviewed integrated repair closes the earlier submission and unblocks dependents', async () => {
  const { repository, slug, source, repair } = fixture('happy');
  const dependent = store.createTicket(slug, {
    title: 'dependent',
    description: 'Waits for the original submission.',
    files: ['dependent.txt'],
  });
  assert.equal(store.linkTickets(slug, source.ref, 'blocks', dependent.ref).ok, true);

  const result = await supersede({
    project: repository,
    ref: source.ref,
    by: 'orchestrator',
    supersededBy: repair.ref,
    reason: 'Repair range was reviewed and integrated after the original replay conflicted.',
    reviewedReplacements: [{ path: 'feature.txt', reviewedBy: 'SQ-review', reason: 'The repair keeps the delivered feature and fixes its conflict.' }],
  });

  assert.equal(result.ok, true, result.message);
  const closed = store.getTicket(slug, source.ref);
  assert.equal(closed.status, 'done');
  assert.equal(closed.submission.integration.outcome, 'superseded');
  assert.equal(closed.submission.supersededBy.ref, repair.ref);
  assert.ok(closed.submission.integratedAt);
  assert.ok(!store.submissionsPayload(slug).tickets.some((ticket: any) => ticket.ref === source.ref), 'pending submission no longer appears in stop summaries');
  assert.ok(store.readyTickets(slug).some((ticket: any) => ticket.ref === dependent.ref), 'dependents become ready');

  const repeated = await supersede({
    project: repository,
    ref: source.ref,
    by: 'orchestrator',
    supersededBy: repair.ref,
    reason: 'Repeat remains safe.',
  });
  assert.equal(repeated.ok, true);
  assert.equal(repeated.idempotent, true);
});

test('a repair missing an original path leaves the earlier submission pending', async () => {
  const { repository, slug, source, repair } = fixture('missing-path');
  const storedRepair = store.getTicket(slug, repair.ref);
  storedRepair.submission.integration.deliveredFiles = [];
  persist(slug, storedRepair);

  const result = await supersede({
    project: repository,
    ref: source.ref,
    by: 'orchestrator',
    supersededBy: repair.ref,
    reason: 'Attempting a closure with incomplete lineage.',
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'lineage_paths_missing');
  assert.match(result.message, /feature\.txt/);
  assert.equal(store.getTicket(slug, source.ref).status, 'doing');
  assert.ok(store.submissionsPayload(slug).tickets.some((ticket: any) => ticket.ref === source.ref));
});

test('content changes require reviewed replacement evidence', async () => {
  const { repository, slug, source, repair } = fixture('unreviewed-content');

  const result = await supersede({
    project: repository,
    ref: source.ref,
    by: 'orchestrator',
    supersededBy: repair.ref,
    reason: 'Attempting a closure without replacement review evidence.',
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'lineage_content_diverged');
  assert.match(result.message, /feature\.txt/);
  assert.equal(store.getTicket(slug, source.ref).status, 'doing');
});

test('reviewed retirement closes a submission with obsolete fragment and non-fragment paths', async () => {
  const retiredPaths = ['.release/unreleased/SQ-obsolete.md', 'obsolete-path.txt'];
  const { repository, slug, source, repair } = fixture('reviewed-retirement', retiredPaths);
  const reviewedReplacements = [
    { path: 'feature.txt', reviewedBy: 'SQ-review', reason: 'The repair content replaces the original implementation.' },
    { path: '.release/unreleased/SQ-obsolete.md', reviewedBy: 'SQ-review', reason: 'The integrated repair supersedes this obsolete release fragment.' },
    { path: 'obsolete-path.txt', reviewedBy: 'SQ-review', reason: 'The integrated repair intentionally retires this obsolete path.' },
  ];

  const result = await supersede({
    project: repository,
    ref: source.ref,
    by: 'orchestrator',
    supersededBy: repair.ref,
    reason: 'The reviewed integrated repair replaces and retires the original delivery paths.',
    reviewedReplacements,
  });

  assert.equal(result.ok, true, result.message);
  assert.deepEqual(store.getTicket(slug, source.ref).submission.supersededBy.reviewedReplacements, reviewedReplacements);
});

test('retirement evidence must match every omitted original path', async () => {
  const retiredPaths = ['.release/unreleased/SQ-obsolete.md', 'obsolete-path.txt'];
  const { repository, slug, source, repair } = fixture('retirement-wrong-path', retiredPaths);

  const result = await supersede({
    project: repository,
    ref: source.ref,
    by: 'orchestrator',
    supersededBy: repair.ref,
    reason: 'Attempting a closure with evidence for the wrong omitted path.',
    reviewedReplacements: [
      { path: '.release/unreleased/SQ-obsolete.md', reviewedBy: 'SQ-review', reason: 'This fragment is intentionally retired.' },
      { path: 'wrong-path.txt', reviewedBy: 'SQ-review', reason: 'This does not authorize the omitted original path.' },
    ],
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'lineage_paths_missing');
  assert.match(result.message, /obsolete-path\.txt/);
  assert.equal(store.getTicket(slug, source.ref).status, 'doing');
});

test('replacement evidence rejects empty review details and unintegrated repairs', async () => {
  const { repository, source, repair } = fixture('retirement-validation');
  const emptyReview = await supersede({
    project: repository,
    ref: source.ref,
    by: 'orchestrator',
    supersededBy: repair.ref,
    reason: 'Attempting a closure with incomplete review evidence.',
    reviewedReplacements: [{ path: 'feature.txt', reviewedBy: '', reason: 'A reviewer is required.' }],
  });

  assert.equal(emptyReview.ok, false);
  assert.equal(emptyReview.reason, 'invalid_replacements');

  const { repository: unintegratedRepository, slug, source: unintegratedSource, repair: unintegratedRepairTicket } = fixture('unintegrated-repair');
  const storedRepair = store.getTicket(slug, unintegratedRepairTicket.ref);
  storedRepair.status = 'doing';
  persist(slug, storedRepair);
  const unintegratedResult = await supersede({
    project: unintegratedRepository,
    ref: unintegratedSource.ref,
    by: 'orchestrator',
    supersededBy: unintegratedRepairTicket.ref,
    reason: 'Attempting a closure before the repair is integrated.',
    reviewedReplacements: [{ path: 'feature.txt', reviewedBy: 'SQ-review', reason: 'The repair is reviewed but not yet integrated.' }],
  });

  assert.equal(unintegratedResult.ok, false);
  assert.equal(unintegratedResult.reason, 'repair_not_integrated');
});
