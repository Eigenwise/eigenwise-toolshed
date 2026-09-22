import './_temp-cleanup.js';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { stubSidequestInstall } from './_sidequest-install-fixture.js';

stubSidequestInstall();

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'sidequest.js');
const DECLARED_PATH = 'plugins/sidequest/src/lib/store/tickets.ts';
const REFUSED_PATH = 'plugins/other/src/a.ts';
const SECOND_REFUSED_PATH = 'plugins/other/src/b.ts';

// GitHub #173: the orchestrator's scopeRequest was refused with not_owner, so there
// was no append-only path for it at all. grantScope grants the paths a claim still
// has refused and widens declaredFiles for the live dispatch's next scopeRequest —
// no redispatch needed. The claim holder cannot grant its own request.
function createClaimedDispatch(options: { files?: string[]; worker?: string } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-scope-grant-home-'));
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-scope-grant-repo-'));
  execFileSync('git', ['init', '--quiet', '-b', 'main'], { cwd: repository, windowsHide: true });
  execFileSync('git', ['-c', 'user.name=Sidequest Tests', '-c', 'user.email=sidequest-test@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'fixture'], { cwd: repository, windowsHide: true });
  process.env.SIDEQUEST_HOME = home;
  process.env.CLAUDE_PROJECT_DIR = repository;
  const store = require('../lib/store.js');
  const project = store.ensureProject(repository).slug;
  const ticket = store.createTicket(project, {
    title: 'Grant a refused scope request',
    category: 'debugging',
    files: options.files === undefined ? [DECLARED_PATH] : options.files,
  });
  const worker = options.worker || 'scope-grant-worker';
  claimAs(store, project, ticket.ref, repository, worker);
  return { project, ticket: store.getTicket(project, ticket.ref), store, home, repository, worker };
}

function claimAs(store: any, project: string, ref: string, repository: string, worker: string) {
  const sessionId = `${worker}-${process.pid}`;
  const prepared = store.prepareDispatch(project, ref, { allowUnscoped: true, sessionId });
  assert.equal(store.recordDispatchLaunch(project, ref, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    sessionId,
    agentName: worker,
  }).ok, true);
  assert.equal(store.bindDispatchWorktreeCreation(project, sessionId, path.join(repository, worker)).ok, true);
  assert.equal(store.claimTicket(project, ref, worker, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
  }).ok, true);
}

function refusalBody(result: any) {
  return String(result.comment.body);
}

test('grantScope has nothing to grant before any scope request is refused', () => {
  const fixture = createClaimedDispatch();
  const result = fixture.store.grantScope(fixture.project, fixture.ticket.ref, 'orchestrator');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no_pending_scope_request');
});

test('grantScope resolves a refused request and widens declaredFiles without redispatch', () => {
  const fixture = createClaimedDispatch();
  const refusal = fixture.store.requestScope(fixture.project, fixture.ticket.ref, fixture.worker, [REFUSED_PATH]);
  assert.equal(refusal.state, 'refused');

  const granted = fixture.store.grantScope(fixture.project, fixture.ticket.ref, 'scope-grant-orchestrator');
  assert.equal(granted.ok, true);
  assert.deepEqual(granted.granted, [REFUSED_PATH]);

  const ticket = fixture.store.getTicket(fixture.project, fixture.ticket.ref);
  assert.ok(ticket.files.some((f: string) => f.toLowerCase() === REFUSED_PATH.toLowerCase()));
  assert.equal(ticket.scopeResolution.state, 'granted');
  assert.equal(ticket.scopeResolution.grantedBy, 'scope-grant-orchestrator');
  // No redispatch: the same live dispatch's declaredFiles already carries it.
  assert.ok(ticket.dispatch.declaredFiles.some((f: string) => f.toLowerCase() === REFUSED_PATH.toLowerCase()));

  // Granted once; nothing outstanding remains to grant again.
  const again = fixture.store.grantScope(fixture.project, fixture.ticket.ref, 'scope-grant-orchestrator');
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'no_pending_scope_request');
});

test('the claim holder cannot grant its own refused request', () => {
  const fixture = createClaimedDispatch();
  assert.equal(fixture.store.requestScope(fixture.project, fixture.ticket.ref, fixture.worker, ['.github/workflows/release.yml']).state, 'refused');

  const granted = fixture.store.grantScope(fixture.project, fixture.ticket.ref, fixture.worker);
  assert.equal(granted.ok, false);
  assert.equal(granted.reason, 'claim_holder_cannot_grant');

  // The deliberate refusal stands: neither the ticket nor the live dispatch took it.
  const ticket = fixture.store.getTicket(fixture.project, fixture.ticket.ref);
  assert.equal(ticket.files.some((f: string) => f.includes('release.yml')), false);
  assert.equal(ticket.dispatch.declaredFiles.some((f: string) => f.includes('release.yml')), false);
  assert.equal(fixture.store.requestScope(fixture.project, fixture.ticket.ref, fixture.worker, ['.github/workflows/release.yml']).state, 'refused');
});

test('grantScope refuses when no live claim holds the ticket', () => {
  const fixture = createClaimedDispatch();
  assert.equal(fixture.store.requestScope(fixture.project, fixture.ticket.ref, fixture.worker, [REFUSED_PATH]).state, 'refused');
  assert.equal(fixture.store.releaseTicket(fixture.project, fixture.ticket.ref, fixture.worker, {
    status: 'todo',
    releaseKind: 'handback',
    releaseReason: 'refused scope',
  }).ok, true);

  const granted = fixture.store.grantScope(fixture.project, fixture.ticket.ref, 'scope-grant-orchestrator');
  assert.equal(granted.ok, false);
  assert.equal(granted.reason, 'not_claimed');
});

test('a refusal from a released attempt cannot land in the next executor scope', () => {
  const fixture = createClaimedDispatch();
  assert.equal(fixture.store.requestScope(fixture.project, fixture.ticket.ref, fixture.worker, [REFUSED_PATH]).state, 'refused');
  assert.equal(fixture.store.releaseTicket(fixture.project, fixture.ticket.ref, fixture.worker, {
    status: 'todo',
    releaseKind: 'handback',
    releaseReason: 'refused scope',
  }).ok, true);
  claimAs(fixture.store, fixture.project, fixture.ticket.ref, fixture.repository, 'scope-grant-worker-two');

  const granted = fixture.store.grantScope(fixture.project, fixture.ticket.ref, 'scope-grant-orchestrator');
  assert.equal(granted.ok, false);
  assert.equal(granted.reason, 'stale_scope_request');
  const ticket = fixture.store.getTicket(fixture.project, fixture.ticket.ref);
  assert.equal(ticket.dispatch.declaredFiles.some((f: string) => f.toLowerCase() === REFUSED_PATH.toLowerCase()), false);
});

test('a grant covers every path the claim still has refused, not just the newest', () => {
  const fixture = createClaimedDispatch();
  assert.equal(fixture.store.requestScope(fixture.project, fixture.ticket.ref, fixture.worker, [REFUSED_PATH]).state, 'refused');
  const second = fixture.store.requestScope(fixture.project, fixture.ticket.ref, fixture.worker, [SECOND_REFUSED_PATH]);
  assert.equal(second.state, 'refused');
  // The second refusal says so, so acting on the first comment is not a silent surprise.
  assert.match(refusalBody(second), /Earlier requests on this claim are still refused/);
  assert.ok(refusalBody(second).includes(REFUSED_PATH));

  const granted = fixture.store.grantScope(fixture.project, fixture.ticket.ref, 'scope-grant-orchestrator');
  assert.equal(granted.ok, true);
  assert.deepEqual(granted.granted, [REFUSED_PATH, SECOND_REFUSED_PATH]);
  const ticket = fixture.store.getTicket(fixture.project, fixture.ticket.ref);
  for (const file of [REFUSED_PATH, SECOND_REFUSED_PATH]) {
    assert.ok(ticket.dispatch.declaredFiles.some((f: string) => f.toLowerCase() === file.toLowerCase()), `${file} reached the live dispatch`);
  }
});

test('an already covered request does not discard what is still outstanding', () => {
  const fixture = createClaimedDispatch();
  assert.equal(fixture.store.requestScope(fixture.project, fixture.ticket.ref, fixture.worker, [REFUSED_PATH]).state, 'refused');
  assert.equal(fixture.store.requestScope(fixture.project, fixture.ticket.ref, fixture.worker, [DECLARED_PATH]).state, 'granted');

  const granted = fixture.store.grantScope(fixture.project, fixture.ticket.ref, 'scope-grant-orchestrator');
  assert.equal(granted.ok, true);
  assert.deepEqual(granted.granted, [REFUSED_PATH]);
});

test('a declared list that cannot grow reports a reason instead of throwing', () => {
  const files = Array.from({ length: 100 }, (_, index) => `plugins/sidequest/src/lib/store/generated-${index}.ts`);
  const fixture = createClaimedDispatch({ files });
  assert.equal(fixture.store.requestScope(fixture.project, fixture.ticket.ref, fixture.worker, [REFUSED_PATH]).state, 'refused');

  const granted = fixture.store.grantScope(fixture.project, fixture.ticket.ref, 'scope-grant-orchestrator');
  assert.equal(granted.ok, false);
  assert.equal(granted.reason, 'invalid_scope');
  assert.match(granted.message, /declared file scope accepts at most 100 entries/);
});

test('the refusal comment names remedies that work under a live claim and never says redispatch', () => {
  const fixture = createClaimedDispatch();
  const refusal = fixture.store.requestScope(fixture.project, fixture.ticket.ref, fixture.worker, [REFUSED_PATH]);
  const body = refusalBody(refusal);
  assert.ok(body.includes('MCP `update` with addFiles'), body);
  assert.ok(body.includes('grant:true'), body);
  assert.ok(body.includes(`sidequest scope-grant ${fixture.ticket.ref}`), body);
  assert.ok(body.includes('only applies once the claim is released'), body);
  // The two promises this refusal used to make and could not keep.
  assert.doesNotMatch(body, /then redispatch/);
  assert.doesNotMatch(body, /release with kind "handback"/);
  assert.equal(refusal.noBounce, true);
});

test('a refusal with no live-claim remedy still tells the executor to hand back', () => {
  const fixture = createClaimedDispatch({ files: [] });
  const refusal = fixture.store.requestScope(fixture.project, fixture.ticket.ref, fixture.worker, [REFUSED_PATH]);
  assert.equal(refusal.state, 'refused');
  assert.equal(refusal.noBounce, false);
  assert.match(refusalBody(refusal), /release with kind "handback"/);
});

test('MCP scopeRequest grants with grant:true and refuses files alongside it', async () => {
  const fixture = createClaimedDispatch();
  const { makeMcpCaller } = require('./_helpers.js');
  const { callTool, callToolRaw } = makeMcpCaller(require('../lib/mcp.js'));
  assert.equal(fixture.store.requestScope(fixture.project, fixture.ticket.ref, fixture.worker, [REFUSED_PATH]).state, 'refused');

  const mixed = await callToolRaw('scopeRequest', { ref: fixture.ticket.ref, by: 'mcp-orchestrator', grant: true, files: [REFUSED_PATH] });
  assert.equal(mixed?.isError, true);
  assert.match(String(mixed?.content?.[0]?.text), /grant cannot be combined with files/);

  const held = await callTool('scopeRequest', { ref: fixture.ticket.ref, by: fixture.worker, grant: true });
  assert.equal(held.ok, false);
  assert.equal(held.reason, 'claim_holder_cannot_grant');

  const granted = await callTool('scopeRequest', { ref: fixture.ticket.ref, by: 'mcp-orchestrator', grant: true });
  assert.equal(granted.ok, true);
  assert.deepEqual(granted.granted, [REFUSED_PATH]);
  assert.equal(granted.resolution.state, 'granted');

  // The granted path now reads as covered on the same live dispatch.
  const covered = await callTool('scopeRequest', { ref: fixture.ticket.ref, by: fixture.worker, files: [REFUSED_PATH] });
  assert.equal(covered.state, 'granted');
  assert.deepEqual(covered.covered, [REFUSED_PATH]);
  assert.equal(covered.instruction, undefined);
});

test('MCP scopeRequest tells a refused executor to bounce only when nothing else can widen scope', async () => {
  const fixture = createClaimedDispatch();
  const { makeMcpCaller } = require('./_helpers.js');
  const { callTool, callToolRaw } = makeMcpCaller(require('../lib/mcp.js'));

  const missingFiles = await callToolRaw('scopeRequest', { ref: fixture.ticket.ref, by: fixture.worker });
  assert.equal(missingFiles?.isError, true);
  assert.match(String(missingFiles?.content?.[0]?.text), /pass files, or grant:true/);

  const refused = await callTool('scopeRequest', { ref: fixture.ticket.ref, by: fixture.worker, files: [REFUSED_PATH] });
  assert.equal(refused.state, 'refused');
  assert.deepEqual(refused.refused, [REFUSED_PATH]);
  assert.match(refused.instruction, /Do not bounce/);

  // A ticket that declares nothing has no declared list to widen, so the bounce stands.
  const undeclared = createClaimedDispatch({ files: [] });
  const bounced = await callTool('scopeRequest', { ref: undeclared.ticket.ref, by: undeclared.worker, files: [REFUSED_PATH] });
  assert.equal(bounced.state, 'refused');
  assert.match(bounced.instruction, /release with kind "handback"/);
});

test('MCP update refuses a patch that mixes files with addFiles', async () => {
  const fixture = createClaimedDispatch();
  const { makeMcpCaller } = require('./_helpers.js');
  const { callToolRaw } = makeMcpCaller(require('../lib/mcp.js'));
  const mixed = await callToolRaw('update', { ref: fixture.ticket.ref, files: ['z.ts'], addFiles: ['b.ts'] });
  assert.equal(mixed?.isError, true);
  assert.match(String(mixed?.content?.[0]?.text), /cannot mix files with addFiles\/removeFiles/);
});

function cliEnv(fixture: { home: string; repository: string }) {
  return {
    ...process.env,
    CLAUDE_PLUGIN_ROOT: ROOT,
    SIDEQUEST_HOME: fixture.home,
    CLAUDE_PROJECT_DIR: fixture.repository,
  };
}

function cli(env: NodeJS.ProcessEnv, args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', windowsHide: true, env });
}

test('the scope-grant CLI command grants the outstanding request', () => {
  const fixture = createClaimedDispatch();
  assert.equal(fixture.store.requestScope(fixture.project, fixture.ticket.ref, fixture.worker, [REFUSED_PATH]).state, 'refused');
  const env = cliEnv(fixture);

  const held = cli(env, ['scope-grant', fixture.ticket.ref, '--by', fixture.worker, '--json']);
  assert.equal(held.status, 1, held.stderr);
  assert.equal(JSON.parse(held.stdout).reason, 'claim_holder_cannot_grant');

  const granted = cli(env, ['scope-grant', fixture.ticket.ref, '--by', 'cli-orchestrator']);
  assert.equal(granted.status, 0, granted.stderr);
  assert.ok(granted.stdout.includes(`scope granted: ${REFUSED_PATH}`), granted.stdout);

  const nothingLeft = cli(env, ['scope-grant', fixture.ticket.ref, '--by', 'cli-orchestrator', '--json']);
  assert.equal(nothingLeft.status, 1, nothingLeft.stderr);
  assert.equal(JSON.parse(nothingLeft.stdout).reason, 'no_pending_scope_request');

  // scope-grant names no paths; --file belongs to scope-request.
  const withFile = cli(env, ['scope-grant', fixture.ticket.ref, '--file', REFUSED_PATH]);
  assert.equal(withFile.status, 1);
  assert.match(withFile.stderr + withFile.stdout, /unknown or unsupported flag --file/);
});

test('the scope-request CLI prints the next step that actually applies', () => {
  const fixture = createClaimedDispatch();
  const refused = cli(cliEnv(fixture), ['scope-request', fixture.ticket.ref, '--file', REFUSED_PATH, '--by', fixture.worker]);
  assert.equal(refused.status, 0, refused.stderr);
  assert.match(refused.stdout, /scope expansion refused/);
  assert.match(refused.stdout, /the orchestrator can widen this live claim in place/);
  assert.doesNotMatch(refused.stdout, /--release-kind handback/);

  const undeclared = createClaimedDispatch({ files: [] });
  const bounced = cli(cliEnv(undeclared), ['scope-request', undeclared.ticket.ref, '--file', REFUSED_PATH, '--by', undeclared.worker]);
  assert.equal(bounced.status, 0, bounced.stderr);
  assert.match(bounced.stdout, /release with --release-kind handback/);
});

test('scope-request --grant refuses paths and routes to the same grant', () => {
  const fixture = createClaimedDispatch();
  assert.equal(fixture.store.requestScope(fixture.project, fixture.ticket.ref, fixture.worker, [REFUSED_PATH]).state, 'refused');
  const env = {
    ...process.env,
    CLAUDE_PLUGIN_ROOT: ROOT,
    SIDEQUEST_HOME: fixture.home,
    CLAUDE_PROJECT_DIR: fixture.repository,
  };

  const mixed = spawnSync(process.execPath, [CLI, 'scope-request', fixture.ticket.ref, '--grant', '--file', REFUSED_PATH], { encoding: 'utf8', windowsHide: true, env });
  assert.equal(mixed.status, 1);
  assert.match(mixed.stderr + mixed.stdout, /cannot be combined with --file/);

  const granted = spawnSync(process.execPath, [CLI, 'scope-request', fixture.ticket.ref, '--grant', '--by', 'cli-orchestrator', '--json'], { encoding: 'utf8', windowsHide: true, env });
  assert.equal(granted.status, 0, granted.stderr);
  assert.deepEqual(JSON.parse(granted.stdout).granted, [REFUSED_PATH]);
});
