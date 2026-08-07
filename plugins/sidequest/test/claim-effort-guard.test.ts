import './_temp-cleanup.js';
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-claim-effort-test-'));
const DISCOVERY_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-claim-effort-catalog-'));
const catalogDir = path.join(DISCOVERY_ROOT, 'model-gateway');
fs.mkdirSync(catalogDir, { recursive: true });
fs.writeFileSync(path.join(catalogDir, 'catalog.json'), JSON.stringify({
  schemaVersion: 3, source: 'model-gateway',
  codexReadiness: {
    ready: true,
    state: 'ready',
    message: 'Codex readiness confirms local binary, /v1/models, authentication, shim, and serving-version checks.',
  },
  models: [{ slug: 'codex-gpt-test', id: 'claude-test', label: 'GPT Test' }],
}));
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;
process.env.SIDEQUEST_DISCOVERY_DIRS = DISCOVERY_ROOT;

const store = require('../lib/store.js');
const dispatchPreflight = require('../lib/dispatch-preflight.js');
const BIN = path.join(__dirname, '..', 'bin', 'sidequest.js');
const PROJ = path.join(os.tmpdir(), 'sq-claim-effort-fixtures', 'board');

// SQ-1017: dispatch and native-agent now refuse before spawning unless
// Claude Code's plugin registry has a runnable, board-MCP-capable
// sidequest@eigenwise-toolshed install for the target project. This file
// dispatches PROJ throughout, so it needs its own isolated
// SIDEQUEST_CLAUDE_HOME with an exact-project-scoped install registered for
// PROJ — distinct from the other suites' shared 'user'-scope stub
// (test/_sidequest-install-fixture.ts) so the tests below in this file can
// also exercise the exact-match, stale, and unreadable-registry refusal
// paths against a registry they control.
const CLAUDE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-claim-effort-claude-home-'));
process.env.SIDEQUEST_CLAUDE_HOME = CLAUDE_HOME;
const REGISTRY_PATH = path.join(CLAUDE_HOME, 'plugins', 'installed_plugins.json');

function writeRegistry(installs?: any) {
  fs.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true });
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify({ plugins: { 'sidequest@eigenwise-toolshed': installs } }));
}

function fakeInstall(withBoardMcp = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-claim-effort-install-'));
  if (withBoardMcp) {
    fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { board: { command: 'node', args: ['bin/sidequest-mcp.js'] } } }));
  }
  return dir;
}

// A valid project-scoped install for PROJ, so the pre-existing dispatch
// tests below (which predate SQ-1017) keep exercising the happy path.
writeRegistry([{ scope: 'project', projectPath: PROJ, installPath: fakeInstall(), version: '9.9.9' }]);

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

function prepareBoundDispatch(slug: string, ref: string) {
  const sessionId = `bound-claim-${ref}`;
  const agentName = `bound-claim-agent-${ref}`;
  const agentId = `bound-claim-id-${ref}`;
  const prepared = store.prepareDispatch(slug, ref, { sessionId });
  assert.equal(store.recordDispatchLaunch(slug, ref, {
    sessionId,
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    agentName,
  }).ok, true);
  assert.equal(store.bindDispatchAgent(sessionId, prepared.ticket.dispatchExecutor, agentId, agentName).ok, true);
  return prepared;
}

function otherEffort(effort?: any) {
  return store.VALID_EFFORTS.find((candidate?: any) => candidate !== effort);
}

test('Codex category routes reject a generic executor even when effort matches', () => {
  const ref = seed('guard.codex');
  const derived = ticket(ref);
  const expected = 'sidequest-exec-dispatch';
  const rejected = runCli(['claim', ref, '--by', 'w1', '--effort', derived.effort, '--executor', `sidequest-exec-${derived.effort}`]);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stdout + rejected.stderr, new RegExp(expected));
  assert.equal(ticket(ref).status, 'todo');
  const prepared = prepareBoundDispatch(store.ensureProject(PROJ).slug, ref);
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
  const prepared = prepareBoundDispatch(store.ensureProject(PROJ).slug, ref);
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

test('CLI refuses invalid direct rationales and records inline-safe direct claims', () => {
  const ref = cliJson(['add', '-t', 'research fixture', '--category', 'guard.claude']).ticket.ref;
  const before = ticket(ref);
  assert.deepEqual(before.files, []);
  const reason = 'Integration gate pinpoints this exact one-line mechanical diff.';
  const invalidReason = 'Context already loaded in this session for these files.';
  const deniedResult = runCli(['claim', ref, '--by', 'inline-worker', '--direct', '--reason', invalidReason, '--json']);
  assert.equal(deniedResult.status, 1);
  const denied = JSON.parse(deniedResult.stdout);
  assert.equal(denied.reason, 'direct_not_allowed');
  assert.match(denied.message, new RegExp(`${before.model}\\s*·\\s*${before.effort}`));
  assert.match(denied.message, /inline-safe allowlist/i);
  assert.match(denied.message, /context already loaded/i);
  assert.match(denied.message, /small change/i);
  assert.match(denied.message, /handoff\/transfer cost/i);
  assert.equal(ticket(ref).claim, null);

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
  const reason = 'This work is a small change with the context already loaded here.';
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
  assert.match(nextCli.stdout, /inline-safe allowlist/);
  assert.doesNotMatch(nextCli.stdout, /No available tickets/);

  const missingReason = store.claimTicket(slug, created.ref, 'store-bypass', { direct: true, source: 'store' });
  assert.equal(missingReason.ok, false);
  assert.equal(missingReason.reason, 'direct_reason_required');
});

test('instant dispatch targets the stable executor, gates the claim, and clears on done and release without deleting the stable def', () => {
  const slug = store.ensureProject(PROJ).slug;
  const agents = path.join(SIDEQUEST_HOME, 'agents');
  fs.mkdirSync(agents, { recursive: true });

  const doneRef = seed('guard.codex');
  const preparedDone = prepareBoundDispatch(slug, doneRef);
  assert.equal(preparedDone.ok, true);
  assert.ok(preparedDone.token);
  // Instant dispatch points the guard at the STABLE per-model executor, not a
  // fresh per-ticket definition, and writes no def file.
  assert.equal(preparedDone.ticket.dispatchExecutor, 'sidequest-exec-dispatch');
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
  const preparedRelease = prepareBoundDispatch(slug, releaseRef);
  assert.equal(preparedRelease.ticket.dispatchExecutor, 'sidequest-exec-dispatch');
  assert.equal(cliJson(['claim', releaseRef, '--by', 'release-token', '--token', preparedRelease.token, '--executor', preparedRelease.ticket.dispatchExecutor]).ok, true);
  const released = cliJson(['release', releaseRef, '--by', 'release-token', '--status', 'todo']);
  assert.equal(released.ticket.dispatchNonce, null);
  assert.equal(released.ticket.dispatchExecutor, null);
  assert.ok(fs.existsSync(stableDef));
});

test('claims sweep releases idle unassociated claims, audits release, and leaves fresh claims alone', () => {
  const slug = store.ensureProject(PROJ).slug;
  const staleRef = seed('guard.claude');
  const freshRef = seed('guard.claude');
  store.updateTicket(slug, staleRef, { labels: ['direct-ok'] });
  store.updateTicket(slug, freshRef, { labels: ['direct-ok'] });
  const reason = 'The claim sweep fixture needs an approved inline claim.';
  assert.equal(store.claimTicket(slug, staleRef, 'stale-worker', { direct: true, reason }).ok, true);
  assert.equal(store.claimTicket(slug, freshRef, 'fresh-worker', { direct: true, reason }).ok, true);
  const stale = store.getTicket(slug, staleRef);
  stale.claim.at = new Date(Date.now() - store.claimIdleMs() - 1).toISOString();
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
  assert.equal(swept.released.some((entry?: any) => entry.ref === staleRef && entry.kind === 'idle'), true);
  assert.equal(ticket(staleRef).status, 'todo');
  assert.equal(ticket(staleRef).claim, null);
  assert.match(ticket(staleRef).comments.at(-1).body, /no board activity from `stale-worker`.*no executor dispatch/);
  assert.equal(ticket(freshRef).claim.by, 'fresh-worker');
});

test('a re-dispatch rotates the token against a constant stable executor and rejects the stale token', () => {
  const slug = store.ensureProject(PROJ).slug;
  const ref = seed('guard.codex');
  const first = store.prepareDispatch(slug, ref);
  const second = prepareBoundDispatch(slug, ref);

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

  // These pre-SQ-1017 tests exercise CLI dispatch's spawn/payload shape, not
  // the transport gate, so they use the escape hatch to keep the CLI path
  // exercised without simulating a real MCP-connected session.
  const dispatched = cliJson(['dispatch', created.ref, '--unverified-transport']);
  const serializedSpawn = JSON.stringify(dispatched.spawn);
  const spawnBytes = Buffer.byteLength(serializedSpawn, 'utf8');
  const launchPayloadCeiling = 32 * 1024 * 1024;
  assert.ok(spawnBytes < launchPayloadCeiling, `serialized dispatched.spawn is ${spawnBytes} bytes`);
  assert.ok(spawnBytes < 2000, `bounded orientation keeps dispatched.spawn at ${spawnBytes} bytes`);
  assert.match(serializedSpawn, /description-marker-/);
  assert.match(serializedSpawn, /Description excerpt capped/);
  assert.doesNotMatch(serializedSpawn, /d{1000}|First comment marker|asset-0-/);

  const briefing = runCli(['briefing', created.ref, '--token', dispatched.token]);
  assert.equal(briefing.status, 0, briefing.stderr);
  assert.match(briefing.stdout, /description-marker-/);
  assert.match(briefing.stdout, /Description truncated at 8 KB/);
  assert.doesNotMatch(briefing.stdout, new RegExp(`d{${hugeDescription.length - 1000}}`));
  assert.match(briefing.stdout, /First comment marker/);
  assert.match(briefing.stdout, /Second comment marker/);
  assert.match(briefing.stdout, /Comment packet truncated/);
  assert.match(briefing.stdout, /compact comments reads \(latest-first\)/);
  assert.match(briefing.stdout, /asset-0-/);
  assert.match(briefing.stdout, /asset-119-/);
});

test('instant dispatch returns a stable executor, fetch stub, and token', () => {
  const ref = seed('guard.codex');
  const dispatched = cliJson(['dispatch', ref, '--unverified-transport']);
  assert.equal(dispatched.ref, ref);
  assert.equal(dispatched.mode, 'instant');
  assert.equal(dispatched.agent, 'sidequest-exec-dispatch');
  assert.equal(dispatched.spawn.subagent_type, dispatched.agent);
  assert.equal(dispatched.tokenPrefix, dispatched.token.slice(0, 12));
  assert.equal(Object.hasOwn(dispatched, 'briefing'), false);
  assert.ok(Buffer.byteLength(dispatched.spawn.prompt) < 1200);
  assert.match(dispatched.spawn.prompt, /Title: guard fixture/);
  assert.match(dispatched.spawn.prompt, /Where: claim guard fixture/);
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
  const dispatched = cliJson(['dispatch', ref, '--unverified-transport']);
  assert.equal(dispatched.mode, 'instant');
  assert.equal(dispatched.agent, 'sidequest-exec-dispatch');
  assert.equal(ticket(ref).dispatchExecutor, dispatched.agent);
  assert.ok(!fs.existsSync(path.join(agents, `sidequest-ticket-${ref.toLowerCase()}.md`)));
  assert.doesNotMatch(JSON.stringify(dispatched), /ephemeral/);
});

test('instant dispatch sends Haiku through its stable executor with a Haiku spawn model', () => {
  const ref = seed('guard.haiku');
  const dispatched = cliJson(['dispatch', ref, '--unverified-transport']);
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

test('an unavailable primary retains its configured effort guard', () => {
  const ref = seed('guard.codex');
  process.env.SIDEQUEST_DISCOVERY_DIRS = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-claim-effort-empty-'));
  const derived = ticket(ref);
  assert.equal(derived.model, 'codex-gpt-test');
  assert.equal(derived.effort, 'high');
  const wrong = runCli(['claim', ref, '--by', 'w1', '--effort', 'medium']);
  assert.notEqual(wrong.status, 0);
  assert.match(wrong.stdout + wrong.stderr, /sidequest-exec-high/);
  store.updateTicket(store.ensureProject(PROJ).slug, ref, { labels: ['direct-ok'] });
  assert.equal(cliJson(['claim', ref, '--by', 'w2', '--effort', 'high', '--direct', '--reason', 'The fixture validates direct effort handling.']).ok, true);
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

// SQ-1017 regression matrix: dispatch/native-agent must refuse before
// mutating ticket state when the target project has no runnable,
// board-MCP-capable Sidequest install, and must say so instead of silently
// handing back a claim-first spawn spec nothing can execute.

test('SQ-1017: dispatch refuses when the target project has no Sidequest install registered anywhere', () => {
  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-1017-missing-claude-home-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-1017-missing-project-'));
  process.env.SIDEQUEST_CLAUDE_HOME = claudeHome; // no plugins/installed_plugins.json at all
  try {
    const slug = store.ensureProject(project).slug;
    const ref = cliJson(['add', '-t', 'no install fixture', '-d', 'Where: SQ-1017 fixture. Contract: refuse dispatch cleanly. Verify: inspect the thrown message.', '--category', 'guard.claude', '--project', project]).ticket.ref;
    assert.throws(
      () => store.prepareDispatch(slug, ref),
      (err?: any) => {
        assert.match(err.message, /no install/i);
        assert.match(err.message, /claude plugin install sidequest@eigenwise-toolshed --scope project/);
        assert.match(err.message, /reload-plugins|start a new session/);
        return true;
      },
    );
    assert.equal(store.getTicket(slug, ref).dispatchNonce, null, 'a refused preflight must not mutate the ticket');
  } finally {
    process.env.SIDEQUEST_CLAUDE_HOME = CLAUDE_HOME;
  }
});

test('SQ-1017: dispatch succeeds once an exact-project install advertising the board MCP is registered', () => {
  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-1017-ok-claude-home-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-1017-ok-project-'));
  fs.mkdirSync(path.join(claudeHome, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(claudeHome, 'plugins', 'installed_plugins.json'), JSON.stringify({
    plugins: { 'sidequest@eigenwise-toolshed': [{ scope: 'project', projectPath: project, installPath: fakeInstall(), version: '9.9.9' }] },
  }));
  process.env.SIDEQUEST_CLAUDE_HOME = claudeHome;
  try {
    const slug = store.ensureProject(project).slug;
    const ref = cliJson(['add', '-t', 'good install fixture', '-d', 'Where: SQ-1017 fixture. Contract: allow dispatch through. Verify: inspect the prepared token.', '--category', 'guard.claude', '--project', project]).ticket.ref;
    const prepared = store.prepareDispatch(slug, ref);
    assert.equal(prepared.ok, true);
    assert.ok(prepared.token);
  } finally {
    process.env.SIDEQUEST_CLAUDE_HOME = CLAUDE_HOME;
  }
});

test('SQ-1017: dispatch refuses a stale registry entry whose install path no longer exists', () => {
  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-1017-stale-claude-home-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-1017-stale-project-'));
  const goneInstall = fakeInstall();
  fs.rmSync(goneInstall, { recursive: true, force: true });
  fs.mkdirSync(path.join(claudeHome, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(claudeHome, 'plugins', 'installed_plugins.json'), JSON.stringify({
    plugins: { 'sidequest@eigenwise-toolshed': [{ scope: 'project', projectPath: project, installPath: goneInstall, version: '9.9.9' }] },
  }));
  process.env.SIDEQUEST_CLAUDE_HOME = claudeHome;
  try {
    const slug = store.ensureProject(project).slug;
    const ref = cliJson(['add', '-t', 'stale install fixture', '-d', 'Where: SQ-1017 fixture. Contract: refuse a dangling install path. Verify: inspect the thrown message.', '--category', 'guard.claude', '--project', project]).ticket.ref;
    assert.throws(() => store.prepareDispatch(slug, ref), /claude plugin install sidequest@eigenwise-toolshed --scope project/);
  } finally {
    process.env.SIDEQUEST_CLAUDE_HOME = CLAUDE_HOME;
  }
});

test('SQ-1017: dispatch refuses an install whose manifest no longer declares the board MCP server', () => {
  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-1017-nomcp-claude-home-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-1017-nomcp-project-'));
  fs.mkdirSync(path.join(claudeHome, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(claudeHome, 'plugins', 'installed_plugins.json'), JSON.stringify({
    plugins: { 'sidequest@eigenwise-toolshed': [{ scope: 'project', projectPath: project, installPath: fakeInstall(false), version: '9.9.9' }] },
  }));
  process.env.SIDEQUEST_CLAUDE_HOME = claudeHome;
  try {
    const slug = store.ensureProject(project).slug;
    const ref = cliJson(['add', '-t', 'no mcp fixture', '-d', 'Where: SQ-1017 fixture. Contract: refuse an install with no board MCP. Verify: inspect the thrown message.', '--category', 'guard.claude', '--project', project]).ticket.ref;
    assert.throws(() => store.prepareDispatch(slug, ref), /board MCP server/);
  } finally {
    process.env.SIDEQUEST_CLAUDE_HOME = CLAUDE_HOME;
  }
});

test('SQ-1017: dispatch fails loud, naming the registry path, when the registry cannot be parsed', () => {
  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-1017-corrupt-claude-home-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-1017-corrupt-project-'));
  fs.mkdirSync(path.join(claudeHome, 'plugins'), { recursive: true });
  const registryPath = path.join(claudeHome, 'plugins', 'installed_plugins.json');
  fs.writeFileSync(registryPath, '{ not json');
  process.env.SIDEQUEST_CLAUDE_HOME = claudeHome;
  try {
    const slug = store.ensureProject(project).slug;
    const ref = cliJson(['add', '-t', 'corrupt registry fixture', '-d', 'Where: SQ-1017 fixture. Contract: fail loud on an unreadable registry. Verify: inspect the thrown message.', '--category', 'guard.claude', '--project', project]).ticket.ref;
    assert.throws(
      () => store.prepareDispatch(slug, ref),
      (err?: any) => {
        assert.match(err.message, new RegExp(registryPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        return true;
      },
    );
  } finally {
    process.env.SIDEQUEST_CLAUDE_HOME = CLAUDE_HOME;
  }
});

test('SQ-1017: native-agent refuses the same way dispatch does when the project has no Sidequest install', () => {
  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-1017-native-claude-home-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-1017-native-project-'));
  process.env.SIDEQUEST_CLAUDE_HOME = claudeHome;
  try {
    const ref = cliJson(['add', '-t', 'native-agent fixture', '-d', 'Where: SQ-1017 fixture. Contract: refuse native-agent cleanly. Verify: inspect the CLI stderr.', '--category', 'guard.claude', '--project', project]).ticket.ref;
    const env = Object.assign({}, process.env, { SIDEQUEST_HOME, SIDEQUEST_CLAUDE_HOME: claudeHome, CLAUDE_PROJECT_DIR: project });
    const result = spawnSync(process.execPath, [BIN, 'native-agent', ref, '--project', project], { encoding: 'utf8', env });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /claude plugin install sidequest@eigenwise-toolshed --scope project/);
  } finally {
    process.env.SIDEQUEST_CLAUDE_HOME = CLAUDE_HOME;
  }
});

// SQ-1017 correction: a registered install only proves a FUTURE fresh
// session would get the board MCP. It does not prove THIS invocation's
// session has it connected — the second SQ-1016 dispatch attempt showed a
// project install registered mid-conversation still handed a fresh native
// Agent zero board tools. So CLI transport must refuse even when the
// install check above passes, unless the caller explicitly acknowledges the
// gap; MCP transport is trusted because reaching the MCP handler is itself
// proof the board MCP is connected in this session.

function goodTransportRegistry(project?: any) {
  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-1017-transport-claude-home-'));
  fs.mkdirSync(path.join(claudeHome, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(claudeHome, 'plugins', 'installed_plugins.json'), JSON.stringify({
    plugins: { 'sidequest@eigenwise-toolshed': [{ scope: 'project', projectPath: project, installPath: fakeInstall(), version: '9.9.9' }] },
  }));
  return claudeHome;
}

test('SQ-1017: CLI dispatch refuses unverified transport even when the target project has a valid install', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-1017-transport-project-'));
  const claudeHome = goodTransportRegistry(project);
  process.env.SIDEQUEST_CLAUDE_HOME = claudeHome;
  try {
    const slug = store.ensureProject(project).slug;
    const ref = cliJson(['add', '-t', 'transport fixture', '-d', 'Where: SQ-1017 fixture. Contract: refuse unverified CLI transport. Verify: inspect the CLI stderr.', '--category', 'guard.claude', '--project', project]).ticket.ref;
    const env = Object.assign({}, process.env, { SIDEQUEST_HOME, SIDEQUEST_CLAUDE_HOME: claudeHome, CLAUDE_PROJECT_DIR: project });
    const refused = spawnSync(process.execPath, [BIN, 'dispatch', ref, '--project', project], { encoding: 'utf8', env });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stdout + refused.stderr, /unverified-transport/);
    assert.match(refused.stdout + refused.stderr, /reload-plugins/);
    assert.equal(store.getTicket(slug, ref).dispatchNonce, null, 'a refused CLI transport preflight must not mutate the ticket');

    const allowed = spawnSync(process.execPath, [BIN, 'dispatch', ref, '--project', project, '--unverified-transport', '--json'], { encoding: 'utf8', env });
    assert.equal(allowed.status, 0, allowed.stderr + allowed.stdout);
    const payload = JSON.parse(allowed.stdout);
    assert.ok(payload.token);
    assert.ok(Array.isArray(payload.warnings) && payload.warnings.some((w: any) => /unverified-transport/.test(w)));
  } finally {
    process.env.SIDEQUEST_CLAUDE_HOME = CLAUDE_HOME;
  }
});

test('SQ-1017: store.prepareDispatch succeeds for MCP transport against the same registry that refuses unverified CLI transport', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-1017-mcp-transport-project-'));
  const claudeHome = goodTransportRegistry(project);
  process.env.SIDEQUEST_CLAUDE_HOME = claudeHome;
  try {
    const slug = store.ensureProject(project).slug;
    const ref = cliJson(['add', '-t', 'mcp transport fixture', '-d', 'Where: SQ-1017 fixture. Contract: MCP transport is trusted. Verify: inspect the prepared token.', '--category', 'guard.claude', '--project', project]).ticket.ref;
    assert.throws(() => store.prepareDispatch(slug, ref, { transport: 'cli' }), /unverified-transport/);
    const prepared = store.prepareDispatch(slug, ref, { transport: 'mcp' });
    assert.equal(prepared.ok, true);
    assert.ok(prepared.token);
  } finally {
    process.env.SIDEQUEST_CLAUDE_HOME = CLAUDE_HOME;
  }
});

test('SQ-1017: CLI native-agent refuses unverified transport even when the target project has a valid install', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-1017-native-transport-project-'));
  const claudeHome = goodTransportRegistry(project);
  process.env.SIDEQUEST_CLAUDE_HOME = claudeHome;
  try {
    const ref = cliJson(['add', '-t', 'native-agent transport fixture', '-d', 'Where: SQ-1017 fixture. Contract: refuse unverified CLI transport. Verify: inspect the CLI stderr.', '--category', 'guard.claude', '--project', project]).ticket.ref;
    const env = Object.assign({}, process.env, { SIDEQUEST_HOME, SIDEQUEST_CLAUDE_HOME: claudeHome, CLAUDE_PROJECT_DIR: project });
    const refused = spawnSync(process.execPath, [BIN, 'native-agent', ref, '--project', project], { encoding: 'utf8', env });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stdout + refused.stderr, /unverified-transport/);
    assert.match(refused.stdout + refused.stderr, /reload-plugins/);

    const allowed = spawnSync(process.execPath, [BIN, 'native-agent', ref, '--project', project, '--unverified-transport', '--json'], { encoding: 'utf8', env });
    assert.equal(allowed.status, 0, allowed.stderr + allowed.stdout);
    const payload = JSON.parse(allowed.stdout);
    assert.ok(Array.isArray(payload.warnings) && payload.warnings.some((w: any) => /unverified-transport/.test(w)));
  } finally {
    process.env.SIDEQUEST_CLAUDE_HOME = CLAUDE_HOME;
  }
});

test('assertDispatchTransport is directly usable: cli refuses without the escape hatch, mcp and the escape hatch both pass', () => {
  assert.throws(() => dispatchPreflight.assertDispatchTransport('cli'), /unverified-transport/);
  assert.doesNotThrow(() => dispatchPreflight.assertDispatchTransport('cli', { allowUnverifiedTransport: true }));
  assert.doesNotThrow(() => dispatchPreflight.assertDispatchTransport('mcp'));
  assert.doesNotThrow(() => dispatchPreflight.assertDispatchTransport());
});

test('checkSidequestInstall is directly usable for a pure ok:true/false check without throwing', () => {
  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-1017-pure-check-'));
  const missing = dispatchPreflight.checkSidequestInstall('/nowhere/at/all', { claudeHome });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'missing');

  const installPath = fakeInstall();
  fs.mkdirSync(path.join(claudeHome, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(claudeHome, 'plugins', 'installed_plugins.json'), JSON.stringify({
    plugins: { 'sidequest@eigenwise-toolshed': [{ scope: 'project', projectPath: '/nowhere/at/all', installPath, version: '1.0.0' }] },
  }));
  const found = dispatchPreflight.checkSidequestInstall('/nowhere/at/all', { claudeHome });
  assert.equal(found.ok, true);
  assert.equal(found.installPath, installPath);
});

export {};
