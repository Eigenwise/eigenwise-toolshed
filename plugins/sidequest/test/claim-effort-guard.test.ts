'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-claim-effort-test-'));
const DISCOVERY_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-claim-effort-catalog-'));
const catalogDir = path.join(DISCOVERY_ROOT, 'codex-gateway');
fs.mkdirSync(catalogDir, { recursive: true });
fs.writeFileSync(path.join(catalogDir, 'catalog.json'), JSON.stringify({
  schemaVersion: 3, source: 'codex-gateway',
  models: [{ slug: 'codex-gpt-test', id: 'claude-codex-test', label: 'GPT Test' }],
}));
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;
process.env.SIDEQUEST_DISCOVERY_DIRS = DISCOVERY_ROOT;

const store = require('../lib/store.js');
const BIN = path.join(__dirname, '..', 'bin', 'sidequest.js');
const PROJ = path.join(os.tmpdir(), 'sq-claim-effort-fixtures', 'board');

store.setCategory({
  id: 'guard.codex', name: 'Codex guard',
  route: { model: 'codex-gpt-test', effort: 'high' },
  fallback: { model: 'opus', effort: 'medium' }, enabled: true,
});
store.setCategory({
  id: 'guard.claude', name: 'Claude guard',
  route: { model: 'sonnet', effort: 'high' }, enabled: true,
});
store.setCategory({
  id: 'guard.haiku', name: 'Haiku guard',
  route: { model: 'haiku', effort: 'medium' }, enabled: true,
});

function runCli(args?: any) {
  const env = Object.assign({}, process.env, { SIDEQUEST_HOME, SIDEQUEST_DISCOVERY_DIRS: process.env.SIDEQUEST_DISCOVERY_DIRS, CLAUDE_PROJECT_DIR: PROJ });
  const result = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function cliJson(args?: any) {
  const result = runCli(args.concat(['--json']));
  assert.equal(result.status, 0, `expected success: ${args.join(' ')}\n${result.stderr}${result.stdout}`);
  return JSON.parse(result.stdout);
}

function ticket(ref?: any) {
  const payload = cliJson(['list']);
  const tickets = Array.isArray(payload.tickets) ? payload.tickets : ([] as any[]).concat(...Object.values(payload).filter(Array.isArray) as any[]);
  const found = tickets.find((candidate?: any) => candidate.ref === ref);
  assert.ok(found, `ticket ${ref} not found`);
  return found;
}

function seed(category?: any) {
  return cliJson(['add', '-t', 'guard fixture', '-d', 'Where: claim guard fixture. Contract: exercise token-gated routed claims without changing state. Verify: inspect the claim response.', '--category', category]).ticket.ref;
}

function otherEffort(effort?: any) {
  return store.VALID_EFFORTS.find((candidate?: any) => candidate !== effort);
}

test('Codex category routes reject a generic executor even when effort matches', () => {
  const ref = seed('guard.codex');
  const derived = ticket(ref);
  const expected = `sidequest-exec-dispatch-${derived.effort}`;
  const rejected = runCli(['claim', ref, '--by', 'w1', '--effort', derived.effort, '--executor', `sidequest-exec-${derived.effort}`]);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stdout + rejected.stderr, new RegExp(expected));
  assert.equal(ticket(ref).status, 'todo');
  const prepared = store.prepareDispatch(store.ensureProject(PROJ).slug, ref);
  assert.equal(cliJson(['claim', ref, '--by', 'w2', '--effort', derived.effort, '--executor', expected, '--token', prepared.token]).ok, true);
});

test('a category-route effort mismatch refuses the claim without mutation', () => {
  const ref = seed('guard.claude');
  const derived = ticket(ref);
  const wrong = otherEffort(derived.effort);
  const result = runCli(['claim', ref, '--by', 'w1', '--effort', wrong]);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /sidequest-exec-high/);
  assert.equal(ticket(ref).status, 'todo');
  assert.equal(ticket(ref).claim, null);
});

test('JSON mismatch reports the category-resolved model and effort', () => {
  const ref = seed('guard.claude');
  const derived = ticket(ref);
  const wrong = otherEffort(derived.effort);
  const result = runCli(['claim', ref, '--by', 'w1', '--effort', wrong, '--json']);
  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.reason, 'effort_mismatch');
  assert.equal(payload.derivedEffort, derived.effort);
  assert.equal(payload.derivedModel, derived.model);
  assert.equal(payload.claimedEffort, wrong);
});

test('a category-routed claim requires a prepared token even with its resolved executor and effort', () => {
  const ref = seed('guard.claude');
  const derived = ticket(ref);
  const rejected = runCli(['claim', ref, '--by', 'w1', '--effort', derived.effort, '--executor', derived.exec.agent, '--json']);
  assert.notEqual(rejected.status, 0);
  const payload = JSON.parse(rejected.stdout);
  assert.equal(payload.reason, 'dispatch_required');
  assert.match(payload.message, /dispatch/i);
  assert.match(payload.message, /--direct/i);
  assert.equal(ticket(ref).status, 'todo');
  const prepared = store.prepareDispatch(store.ensureProject(PROJ).slug, ref);
  const claim = cliJson(['claim', ref, '--by', 'w1', '--effort', derived.effort, '--executor', derived.exec.agent, '--token', prepared.token]);
  assert.equal(claim.ticket.status, 'doing');
});

test('the store requires a dispatch nonce, rejects a wrong one, and accepts its prepared executor', () => {
  const ref = seed('guard.claude');
  const slug = store.ensureProject(PROJ).slug;
  const routed = store.getTicket(slug, ref);
  const missing = store.claimTicket(slug, ref, 'store-no-token', { executor: routed.exec.agent, effort: routed.effort });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'dispatch_required');
  const prepared = store.prepareDispatch(slug, ref);
  const wrong = store.claimTicket(slug, ref, 'store-wrong-token', { token: 'wrong-token', executor: prepared.ticket.dispatchExecutor });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.reason, 'token');
  const accepted = store.claimTicket(slug, ref, 'store-prepared', { token: prepared.token, executor: prepared.ticket.dispatchExecutor });
  assert.equal(accepted.ok, true);
});

test('CLI requires direct-ok for routed direct claims and records approved bypasses', () => {
  const ref = cliJson(['add', '-t', 'research fixture', '--category', 'guard.claude']).ticket.ref;
  const before = ticket(ref);
  assert.deepEqual(before.files, []);
  const reason = 'No executor can access this isolated local fixture.';
  const deniedResult = runCli(['claim', ref, '--by', 'inline-worker', '--direct', '--reason', reason, '--json']);
  assert.equal(deniedResult.status, 1);
  const denied = JSON.parse(deniedResult.stdout);
  assert.equal(denied.reason, 'direct_not_allowed');
  assert.match(denied.message, new RegExp(`${before.model}\\s*·\\s*${before.effort}`));
  assert.match(denied.message, /context already loaded/i);
  assert.match(denied.message, /small change/i);
  assert.match(denied.message, /handoff\/transfer cost/i);
  assert.match(denied.message, /retroactively legitimize prior inline investigation/i);
  assert.equal(ticket(ref).claim, null);

  store.updateTicket(store.ensureProject(PROJ).slug, ref, { labels: ['direct-ok'] });
  const missingReasonResult = runCli(['claim', ref, '--by', 'inline-worker', '--direct', '--json']);
  assert.equal(missingReasonResult.status, 1);
  const missingReason = JSON.parse(missingReasonResult.stdout);
  assert.equal(missingReason.reason, 'direct_reason_required');
  const claim = cliJson(['claim', ref, '--by', 'inline-worker', '--direct', '--reason', reason]);
  assert.equal(claim.ticket.directClaim.model, before.model);
  assert.equal(claim.ticket.directClaim.effort, before.effort);
  const pulse = cliJson(['pulse', ref]);
  assert.equal(pulse.direct.by, 'inline-worker');
  assert.equal(pulse.direct.model, before.model);
  assert.equal(pulse.direct.reason, reason);
  const brief = cliJson(['list', '--brief']).tickets.find((candidate?: any) => candidate.ref === ref);
  assert.equal(brief.direct.by, 'inline-worker');
  assert.equal(brief.direct.reason, reason);
});

test('CLI --source cannot bypass direct authority and next preserves its refusal guidance', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-direct-authority-'));
  const slug = store.ensureProject(project).slug;
  const created = store.createTicket(slug, { title: 'authority fixture', category: 'guard.claude' });
  const reason = 'The authority guard fixture needs an approved direct claim.';
  const bypass = runCli(['claim', created.ref, '--by', 'source-bypass', '--direct', '--reason', reason, '--source', 'store', '--project', project, '--json']);
  assert.equal(bypass.status, 1);
  assert.equal(JSON.parse(bypass.stdout).reason, 'direct_not_allowed');

  const direct = store.claimTicket(slug, created.ref, 'store-bypass', { direct: true, reason, source: 'store' });
  assert.equal(direct.ok, false);
  assert.equal(direct.reason, 'direct_not_allowed');

  const next = store.claimNext(slug, 'next-bypass', { direct: true, reason, source: 'store' });
  assert.equal(next.ok, false);
  assert.equal(next.reason, 'direct_not_allowed');
  assert.equal(next.ticket.ref, created.ref);

  const nextCli = runCli(['next', '--by', 'next-bypass', '--direct', '--reason', reason, '--project', project]);
  assert.equal(nextCli.status, 1);
  assert.match(nextCli.stdout, /user-granted `direct-ok` label/);
  assert.doesNotMatch(nextCli.stdout, /No available tickets/);

  store.updateTicket(slug, created.ref, { labels: ['DIRECT-OK'] });
  const missingReason = store.claimTicket(slug, created.ref, 'store-bypass', { direct: true, source: 'store' });
  assert.equal(missingReason.ok, false);
  assert.equal(missingReason.reason, 'direct_reason_required');
});

test('instant dispatch targets the stable executor, gates the claim, and clears on done and release without deleting the stable def', () => {
  const slug = store.ensureProject(PROJ).slug;
  const agents = path.join(SIDEQUEST_HOME, 'agents');
  fs.mkdirSync(agents, { recursive: true });

  const doneRef = seed('guard.codex');
  const preparedDone = store.prepareDispatch(slug, doneRef);
  assert.equal(preparedDone.ok, true);
  assert.ok(preparedDone.token);
  // Instant dispatch points the guard at the STABLE per-model executor, not a
  // fresh per-ticket definition, and writes no def file.
  assert.equal(preparedDone.ticket.dispatchExecutor, 'sidequest-exec-dispatch-high');
  assert.equal(preparedDone.ticket.dispatchExecutor, ticket(doneRef).exec.agent);
  // The stable executor is registered from session start; closeout on done/release
  // must never delete it (it is not a per-ticket temp def).
  const stableDef = path.join(agents, `${preparedDone.ticket.dispatchExecutor}.md`);
  fs.writeFileSync(stableDef, '<!-- generated-by: sidequest-agentsync -->\nstable exec body\n');

  const missing = runCli(['claim', doneRef, '--by', 'missing-token', '--json']);
  assert.notEqual(missing.status, 0);
  assert.equal(JSON.parse(missing.stdout).reason, 'token');
  const wrong = runCli(['claim', doneRef, '--by', 'wrong-executor', '--token', preparedDone.token, '--executor', 'sidequest-exec-high', '--json']);
  assert.notEqual(wrong.status, 0);
  assert.equal(JSON.parse(wrong.stdout).reason, 'executor_mismatch');
  assert.equal(cliJson(['claim', doneRef, '--by', 'right-token', '--token', preparedDone.token, '--executor', preparedDone.ticket.dispatchExecutor]).ok, true);
  const done = cliJson(['done', doneRef, '--by', 'right-token']);
  assert.equal(done.ticket.dispatchNonce, null);
  assert.equal(done.ticket.dispatchExecutor, null);
  assert.ok(fs.existsSync(stableDef));

  const releaseRef = seed('guard.codex');
  const preparedRelease = store.prepareDispatch(slug, releaseRef);
  assert.equal(preparedRelease.ticket.dispatchExecutor, 'sidequest-exec-dispatch-high');
  assert.equal(cliJson(['claim', releaseRef, '--by', 'release-token', '--token', preparedRelease.token, '--executor', preparedRelease.ticket.dispatchExecutor]).ok, true);
  const released = cliJson(['release', releaseRef, '--by', 'release-token', '--status', 'todo']);
  assert.equal(released.ticket.dispatchNonce, null);
  assert.equal(released.ticket.dispatchExecutor, null);
  assert.ok(fs.existsSync(stableDef));
});

test('claims sweep marks stale claims, audits release, and leaves fresh claims alone', () => {
  const slug = store.ensureProject(PROJ).slug;
  const staleRef = seed('guard.claude');
  const freshRef = seed('guard.claude');
  store.updateTicket(slug, staleRef, { labels: ['direct-ok'] });
  store.updateTicket(slug, freshRef, { labels: ['direct-ok'] });
  const reason = 'The claim sweep fixture needs an approved inline claim.';
  assert.equal(store.claimTicket(slug, staleRef, 'stale-worker', { direct: true, reason }).ok, true);
  assert.equal(store.claimTicket(slug, freshRef, 'fresh-worker', { direct: true, reason }).ok, true);
  const stale = store.getTicket(slug, staleRef);
  stale.claim.at = new Date(Date.now() - store.claimTtlMs() - 1).toISOString();
  stale.updatedAt = stale.claim.at;
  const dbModule = require('../lib/db.js');
  const db = dbModule.openDb(SIDEQUEST_HOME);
  dbModule.putRow(db, 'tickets', {
    id: stale.id, project: slug, ref: stale.ref, status: stale.status,
    archived: stale.archived ? 1 : 0, ord: stale.order, claim_by: stale.claim.by, data: stale,
  });

  const before = cliJson(['list', '--brief']);
  assert.equal(before.tickets.find((ticket?: any) => ticket.ref === staleRef).claim.stale, true);
  assert.equal(before.tickets.find((ticket?: any) => ticket.ref === freshRef).claim.stale, false);
  const swept = cliJson(['claims', 'sweep']);
  assert.equal(swept.released.length, 1);
  assert.equal(ticket(staleRef).status, 'todo');
  assert.equal(ticket(staleRef).claim, null);
  assert.match(ticket(staleRef).comments.at(-1).body, /claim exceeded the/);
  assert.equal(ticket(freshRef).claim.by, 'fresh-worker');
});

test('a re-dispatch rotates the token against a constant stable executor and rejects the stale token', () => {
  const slug = store.ensureProject(PROJ).slug;
  const ref = seed('guard.codex');
  const first = store.prepareDispatch(slug, ref);
  const second = store.prepareDispatch(slug, ref);

  assert.equal(first.ticket.dispatchExecutor, second.ticket.dispatchExecutor);
  assert.notEqual(first.token, second.token);
  assert.equal(store.getTicket(slug, ref).dispatchNonce, second.token);
  const stale = runCli(['claim', ref, '--by', 'stale', '--token', first.token, '--executor', first.ticket.dispatchExecutor, '--json']);
  assert.notEqual(stale.status, 0);
  assert.equal(JSON.parse(stale.stdout).reason, 'token');
  assert.equal(cliJson(['claim', ref, '--by', 'latest', '--token', second.token, '--executor', second.ticket.dispatchExecutor]).ok, true);
});

test('fresh redispatch briefing includes every comment added after preparation and refuses a foreign project', () => {
  const slug = store.ensureProject(PROJ).slug;
  const ref = seed('guard.codex');
  store.prepareDispatch(slug, ref);
  const first = store.addComment(slug, ref, { by: 'scout', kind: 'comment', body: 'First comment added before redispatch.' });
  const second = store.addComment(slug, ref, { by: 'reviewer', kind: 'warning', body: 'Second comment added before redispatch.' });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  const redispatched = store.prepareDispatch(slug, ref);
  const briefing = runCli(['briefing', ref, '--token', redispatched.token]);
  assert.equal(briefing.status, 0, briefing.stderr);
  assert.ok(briefing.stdout.includes(first.comment.body));
  assert.ok(briefing.stdout.includes(second.comment.body));
  assert.ok(briefing.stdout.indexOf(first.comment.body) < briefing.stdout.indexOf(second.comment.body));

  const foreignProject = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-briefing-foreign-'));
  const foreign = runCli(['briefing', ref, '--token', redispatched.token, '--project', foreignProject]);
  assert.notEqual(foreign.status, 0);
  assert.match(foreign.stdout + foreign.stderr, /no ticket/i);
});
test('briefing rejects invalid, terminal, and prior-dispatch tokens without leaking ticket content', () => {
  const slug = store.ensureProject(PROJ).slug;
  const assertRefused = (ref: string, token: string, secret: string) => {
    const result = runCli(['briefing', ref, '--token', token]);
    assert.equal(result.status, 1);
    assert.match(result.stdout + result.stderr, /dispatch token was refused/);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(secret));
  };

  const invalid = store.createTicket(slug, {
    title: 'Invalid token packet',
    description: 'invalid-token-secret-測試',
    category: 'guard.codex',
  });
  const invalidDispatch = store.prepareDispatch(slug, invalid.ref);
  assertRefused(invalid.ref, 'definitely-invalid-token', 'invalid-token-secret-測試');

  const terminal = store.createTicket(slug, {
    title: 'Terminal token packet',
    description: 'terminal-token-secret-測試',
    category: 'guard.codex',
  });
  const terminalDispatch = store.prepareDispatch(slug, terminal.ref);
  assert.equal(store.claimTicket(slug, terminal.ref, 'terminal-worker', {
    token: terminalDispatch.token,
    executor: terminalDispatch.ticket.dispatchExecutor,
  }).ok, true);
  assert.equal(store.releaseTicket(slug, terminal.ref, 'terminal-worker', { status: 'todo' }).ok, true);
  assertRefused(terminal.ref, terminalDispatch.token, 'terminal-token-secret-測試');

  const prior = store.createTicket(slug, {
    title: 'Prior token packet',
    description: 'prior-token-secret-測試',
    category: 'guard.codex',
  });
  const first = store.prepareDispatch(slug, prior.ref);
  const second = store.prepareDispatch(slug, prior.ref);
  assert.notEqual(first.token, second.token);
  assertRefused(prior.ref, first.token, 'prior-token-secret-測試');
  const current = runCli(['briefing', prior.ref, '--token', second.token]);
  assert.equal(current.status, 0, current.stderr);
  assert.match(current.stdout, /prior-token-secret-測試/);
});

test('serialized dispatch spawn stays below the launch ceiling while briefing keeps a huge packet', () => {
  const slug = store.ensureProject(PROJ).slug;
  const hugeDescription = [
    '# Durable packet fixture',
    '',
    '- markdown must remain in the fetched briefing',
    '- Unicode: 測試 🧪 λ',
    '',
    'description-marker-',
    'd'.repeat(500000),
  ].join('\n');
  const imageData = Array.from({ length: 120 }, (_value, index) => ({
    name: `asset-${index}-${'x'.repeat(80)}.png`,
    base64: 'eA==',
  }));
  const created = store.createTicket(slug, {
    title: 'Huge briefing packet',
    description: hugeDescription,
    category: 'guard.codex',
    imagesData: imageData,
  });
  const comments = [
    `First comment marker:\n\n**markdown** and Unicode 測試 🧪\n${'a'.repeat(15000)}`,
    `Second comment marker:\n\nKeep this blank line.\n${'b'.repeat(15000)}`,
  ];
  for (const body of comments) assert.equal(store.addComment(slug, created.ref, { by: 'packet-worker', body }).ok, true);

  const dispatched = cliJson(['dispatch', created.ref]);
  const serializedSpawn = JSON.stringify(dispatched.spawn);
  const spawnBytes = Buffer.byteLength(serializedSpawn, 'utf8');
  const launchPayloadCeiling = 32 * 1024 * 1024;
  assert.ok(spawnBytes < launchPayloadCeiling, `serialized dispatched.spawn is ${spawnBytes} bytes`);
  assert.ok(spawnBytes < 2000, `briefing fetch keeps dispatched.spawn at ${spawnBytes} bytes`);
  assert.doesNotMatch(serializedSpawn, /description-marker-|First comment marker|asset-0-/);

  const briefing = runCli(['briefing', created.ref, '--token', dispatched.token]);
  assert.equal(briefing.status, 0, briefing.stderr);
  assert.match(briefing.stdout, /description-marker-/);
  assert.ok(briefing.stdout.includes(hugeDescription));
  for (const body of comments) assert.ok(briefing.stdout.includes(body));
  assert.match(briefing.stdout, /asset-0-/);
  assert.match(briefing.stdout, /asset-119-/);
});

test('instant dispatch returns a stable executor, fetch stub, and token', () => {
  const ref = seed('guard.codex');
  const dispatched = cliJson(['dispatch', ref]);
  assert.equal(dispatched.ref, ref);
  assert.equal(dispatched.mode, 'instant');
  assert.equal(dispatched.agent, 'sidequest-exec-dispatch-high');
  assert.equal(dispatched.spawn.subagent_type, dispatched.agent);
  assert.equal(dispatched.tokenPrefix, dispatched.token.slice(0, 12));
  assert.equal(Object.hasOwn(dispatched, 'briefing'), false);
  assert.ok(Buffer.byteLength(dispatched.spawn.prompt) < 600);
  assert.match(dispatched.spawn.prompt, new RegExp(`briefing ${ref} --token ${dispatched.token}`));
  assert.match(dispatched.spawn.prompt, /FIRST action:/);
  assert.doesNotMatch(dispatched.spawn.prompt, /## This ticket/);
  assert.doesNotMatch(dispatched.spawn.prompt, /You are a sidequest ticket executor/);
  assert.doesNotMatch(dispatched.spawn.prompt, /^---$/m);
  assert.equal(ticket(ref).dispatchExecutor, dispatched.agent);
});

test('dispatch always returns the stable executor and does not write a ticket definition', () => {
  const ref = seed('guard.codex');
  const agents = path.join(SIDEQUEST_HOME, 'agents');
  const dispatched = cliJson(['dispatch', ref]);
  assert.equal(dispatched.mode, 'instant');
  assert.equal(dispatched.agent, 'sidequest-exec-dispatch-high');
  assert.equal(ticket(ref).dispatchExecutor, dispatched.agent);
  assert.ok(!fs.existsSync(path.join(agents, `sidequest-ticket-${ref.toLowerCase()}.md`)));
  assert.doesNotMatch(JSON.stringify(dispatched), /ephemeral/);
});

test('instant dispatch sends Haiku through its stable executor with a Haiku spawn model', () => {
  const ref = seed('guard.haiku');
  const dispatched = cliJson(['dispatch', ref]);
  assert.equal(dispatched.mode, 'instant');
  assert.equal(dispatched.agent, 'sidequest-exec-medium');
  assert.equal(dispatched.spawn.subagent_type, 'sidequest-exec-medium');
  assert.equal(dispatched.spawn.model, 'haiku');
  assert.equal(ticket(ref).dispatchExecutor, 'sidequest-exec-medium');
});

test('prepare dispatch rejects unknown ticket refs loudly', () => {
  const slug = store.ensureProject(PROJ).slug;
  assert.throws(() => store.prepareDispatch(slug, 'SQ-999999'), /no ticket/);
});

test('an unavailable primary uses the category fallback effort for the guard', () => {
  const ref = seed('guard.codex');
  process.env.SIDEQUEST_DISCOVERY_DIRS = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-claim-effort-empty-'));
  const derived = ticket(ref);
  assert.equal(derived.model, 'opus');
  assert.equal(derived.effort, 'medium');
  const wrong = runCli(['claim', ref, '--by', 'w1', '--effort', 'high']);
  assert.notEqual(wrong.status, 0);
  assert.match(wrong.stdout + wrong.stderr, /sidequest-exec-medium/);
  store.updateTicket(store.ensureProject(PROJ).slug, ref, { labels: ['direct-ok'] });
  assert.equal(cliJson(['claim', ref, '--by', 'w2', '--effort', 'medium', '--direct', '--reason', 'The fixture validates direct effort handling.']).ok, true);
});

test('a concrete Haiku category keeps its configured effort guard', () => {
  const ref = seed('guard.haiku');
  const derived = ticket(ref);
  assert.equal(derived.model, 'haiku');
  assert.equal(derived.effort, 'medium');
  const wrong = runCli(['claim', ref, '--by', 'w1', '--effort', 'high']);
  assert.notEqual(wrong.status, 0);
  store.updateTicket(store.ensureProject(PROJ).slug, ref, { labels: ['direct-ok'] });
  assert.equal(cliJson(['claim', ref, '--by', 'w2', '--effort', 'medium', '--direct', '--reason', 'The fixture validates direct effort handling.']).ok, true);
});

export {};
