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
  fs.writeFileSync(path.join(repository, filename), contents);
  git(repository, ['add', filename]);
  git(repository, ['commit', '-m', filename]);
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

function fixture(label: string) {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), `sq-supersession-${label}-`));
  git(repository, ['init']);
  git(repository, ['config', 'user.name', 'Sidequest Test']);
  git(repository, ['config', 'user.email', 'sidequest-test@example.invalid']);
  const base = commit(repository, 'README.md', 'base\n');
  const submitted = commit(repository, 'feature.txt', 'original delivery\n');
  const repaired = commit(repository, 'feature.txt', 'reviewed repair\n');
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
    changedPaths: ['feature.txt'],
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
  return { repository, slug, source, repair };
}

async function supersede(input: any) {
  const tool = mcp.TOOLS.find((candidate: any) => candidate.name === 'supersede_submission');
  assert.ok(tool, 'supersede_submission is exposed over MCP');
  return tool.handler(input);
}

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
