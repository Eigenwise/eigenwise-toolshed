import './_temp-cleanup.js';
import './_sidequest-install-fixture.js';
import './_hook-runtime.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const store = require('../lib/store.js');
const worktrees = require('../lib/worktrees.js');
const pluginRoot = path.resolve(__dirname, '..');

function fixture() {
  const repository = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-placement-')));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-b', 'main');
  git('config', 'user.name', 'Sidequest Test');
  git('config', 'user.email', 'sidequest-test@example.invalid');
  fs.writeFileSync(path.join(repository, 'README.md'), 'fixture\n');
  git('add', 'README.md');
  git('commit', '-m', 'fixture');
  fs.appendFileSync(path.join(repository, '.git/info/exclude'), '\n/.worktrees/\n/.other-worktrees/\n');
  for (const directory of ['.worktrees', '.other-worktrees', 'not-ignored']) fs.mkdirSync(path.join(repository, directory));
  const { slug } = store.ensureProject(repository);
  return { repository, slug, git };
}

function prepare(repository: string, slug: string, sessionId: string) {
  store.setCategory({ id: 'placement-fixture', name: 'Placement fixture', route: { model: 'sonnet', effort: 'medium' }, readonly: true });
  const ticket = store.createTicket(slug, {
    title: sessionId, category: 'placement-fixture', description: 'Verify an isolated fixture checkout.', files: ['README.md'],
  });
  const previous = process.cwd();
  process.chdir(repository);
  try {
    const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId });
    assert.equal(prepared.ok, true);
    assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
      token: prepared.token, executor: prepared.ticket.dispatchExecutor, sessionId, agentName: sessionId,
    }).ok, true);
    return prepared.ticket;
  } finally {
    process.chdir(previous);
  }
}

function create(repository: string, sessionId: string, name: string) {
  return execFileSync(process.execPath, [path.join(pluginRoot, 'hooks/worktree-create.js')], {
    cwd: repository,
    env: { ...process.env, CLAUDE_PROJECT_DIR: repository, CLAUDE_PLUGIN_ROOT: pluginRoot },
    input: JSON.stringify({ hook_event_name: 'WorktreeCreate', cwd: repository, session_id: sessionId, name }),
    encoding: 'utf8', stdio: 'pipe',
  }).trim();
}

test('placement defaults stay outside the repository and configured roots round-trip', () => {
  const { repository, slug } = fixture();
  const original = worktrees.worktreeRoot(repository);
  assert.equal(path.relative(repository, original).startsWith('..'), true);
  assert.equal(store.setBoardConfig(slug, { worktreeDirectory: '.worktrees' }).ok, true);
  assert.equal(store.boardConfig(slug).worktreeDirectory, '.worktrees');
  assert.equal(worktrees.worktreeRoot(repository), path.join(repository, '.worktrees'));
  assert.equal(store.setBoardConfig(slug, { worktreeDirectory: null }).ok, true);
  assert.equal(worktrees.worktreeRoot(repository), original);
});

test('placement rejects unsafe or unignored directories without changing board policy', () => {
  const { repository, slug } = fixture();
  store.setBoardConfig(slug, { worktreeDirectory: '.worktrees' });
  for (const directory of ['.', '..', '../escape', '.worktrees/../escape', '/absolute', 'C:\\absolute', '.git', 'not-ignored']) {
    assert.throws(() => store.setBoardConfig(slug, { worktreeDirectory: directory }), /worktreeDirectory/, directory);
    assert.equal(store.boardConfig(slug).worktreeDirectory, '.worktrees');
  }
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-placement-outside-'));
  fs.rmdirSync(path.join(repository, '.worktrees'));
  fs.symlinkSync(outside, path.join(repository, '.worktrees'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => prepare(repository, slug, 'placement-symlink-refused'), /symlink|reparse/i);
});

test('placement refuses a missing configured directory without creating it', () => {
  const { repository, slug } = fixture();
  const target = path.join(repository, '.worktrees');
  fs.rmdirSync(target);
  assert.throws(() => store.setBoardConfig(slug, { worktreeDirectory: '.worktrees' }), /must already exist/);
  assert.equal(fs.existsSync(target), false);
  assert.equal(store.boardConfig(slug).worktreeDirectory, null);
});

test('placement requires the directory itself to be ignored, not just a probe child', () => {
  const { repository, slug } = fixture();
  fs.appendFileSync(path.join(repository, '.git/info/exclude'), '/partial-worktrees/*\n!/partial-worktrees/agent-*\n');
  fs.mkdirSync(path.join(repository, 'partial-worktrees'));
  assert.throws(() => store.setBoardConfig(slug, { worktreeDirectory: 'partial-worktrees' }), /Git-ignored/);
});

test('placement refuses tracked content even when the directory is ignored', () => {
  const { repository, slug, git } = fixture();
  fs.writeFileSync(path.join(repository, '.worktrees/owned.txt'), 'do not overwrite\n');
  git('add', '-f', '.worktrees/owned.txt');
  assert.throws(() => store.setBoardConfig(slug, { worktreeDirectory: '.worktrees' }), /tracked/i);
  assert.equal(fs.readFileSync(path.join(repository, '.worktrees/owned.txt'), 'utf8'), 'do not overwrite\n');
});

test('placement is pinned before creation and old roots remain discoverable after a config change', () => {
  const { repository, slug } = fixture();
  store.setBoardConfig(slug, { worktreeDirectory: '.worktrees' });
  const ticket = prepare(repository, slug, 'placement-pinned');
  assert.equal(store.getTicket(slug, ticket.ref).dispatch.worktreeRoot, path.join(repository, '.worktrees'));
  store.setBoardConfig(slug, { worktreeDirectory: '.other-worktrees' });
  const created = create(repository, 'placement-pinned', 'agent-placement-pinned');
  assert.equal(fs.realpathSync.native(created), path.join(repository, '.worktrees/agent-placement-pinned'));
  const bound = store.getTicket(slug, ticket.ref).dispatch;
  assert.equal(bound.worktree, created);
  assert.ok(bound.worktreeCheckoutInstance);
  assert.ok(worktrees.agentWorktreeRoots(repository).includes(path.join(repository, '.worktrees')));
  assert.equal(store.markDispatchStopped('placement-pinned', ticket.dispatchExecutor, null, 'placement-pinned').ok, true);
  const previous = process.cwd();
  process.chdir(repository);
  try {
    assert.equal(store.prepareDispatch(slug, ticket.ref, { sessionId: 'placement-replacement' }).ok, true);
  } finally {
    process.chdir(previous);
  }
  assert.ok(worktrees.agentWorktreeRoots(repository).includes(path.join(repository, '.worktrees')), 'terminal attempt retains its placement root');
});

test('placement discovery retains valid roots when the current configured directory disappears', () => {
  const { repository, slug } = fixture();
  const external = worktrees.defaultWorktreeRoot(repository);
  store.setBoardConfig(slug, { worktreeDirectory: '.worktrees' });
  assert.ok(worktrees.agentWorktreeRoots(repository).includes(external));
  fs.rmdirSync(path.join(repository, '.worktrees'));
  assert.ok(worktrees.agentWorktreeRoots(repository).includes(external));
});

test('placement creation uses its valid pin when a newer configured root disappears', () => {
  const { repository, slug } = fixture();
  store.setBoardConfig(slug, { worktreeDirectory: '.worktrees' });
  prepare(repository, slug, 'placement-valid-old-pin');
  store.setBoardConfig(slug, { worktreeDirectory: '.other-worktrees' });
  fs.rmdirSync(path.join(repository, '.other-worktrees'));
  assert.equal(create(repository, 'placement-valid-old-pin', 'agent-valid-old-pin'), path.join(repository, '.worktrees/agent-valid-old-pin'));
});

test('placement terminal history retains checkout identity, not just the directory name', () => {
  const { repository, slug } = fixture();
  store.setBoardConfig(slug, { worktreeDirectory: '.worktrees' });
  const ticket = prepare(repository, slug, 'placement-identity-history');
  create(repository, 'placement-identity-history', 'agent-identity-history');
  const bound = store.getTicket(slug, ticket.ref).dispatch;
  assert.ok(bound.worktreeCheckoutInstance);
  assert.equal(store.markDispatchStopped('placement-identity-history', ticket.dispatchExecutor, null, 'placement-identity-history').ok, true);
  const attempt = store.getTicket(slug, ticket.ref).dispatch.attempts.at(-1);
  for (const field of ['worktree', 'worktreeGitDirectory', 'worktreeCommonGitDirectory', 'worktreeCheckoutInstance']) {
    assert.equal(attempt[field], bound[field], field);
  }
});

test('placement historical cleanup verifies identity and preserves live, changed, or replaced checkouts', async () => {
  const { repository, slug, git } = fixture();
  store.setBoardConfig(slug, { worktreeDirectory: '.worktrees' });
  const ticket = prepare(repository, slug, 'placement-history-cleanup');
  const target = create(repository, 'placement-history-cleanup', 'agent-history-cleanup');
  assert.equal(store.bindDispatchAgent('placement-history-cleanup', ticket.dispatchExecutor, 'placement-history-agent', 'placement-history-cleanup', target).ok, true);
  assert.equal(store.claimTicket(slug, ticket.ref, 'placement-history-worker', {
    token: store.getTicket(slug, ticket.ref).dispatchNonce, executor: ticket.dispatchExecutor,
  }).ok, true);
  assert.equal(store.releaseTicket(slug, ticket.ref, 'placement-history-worker', { status: 'todo', source: 'test' }).ok, true);
  const previous = process.cwd();
  process.chdir(repository);
  try {
    assert.equal(store.prepareDispatch(slug, ticket.ref, { sessionId: 'placement-history-next' }).ok, true);
  } finally {
    process.chdir(previous);
  }
  const current = store.getTicket(slug, ticket.ref);
  const classify = (tickets = [current], livePaths: string[] = [], locked = false) => worktrees.classifyWorktree(repository, tickets, {
    worktree: target, branch: 'refs/heads/worktree-agent-history-cleanup', head: git('rev-parse', 'HEAD'), locked,
  }, repository, 0, 'main', livePaths, 0, [repository, target]);
  assert.equal(fs.existsSync(path.join(target, 'README.md')), true, 'a claimed then released checkout survives redispatch');
  const settled = await classify();
  assert.equal(settled.action, 'remove', JSON.stringify({ reason: settled.reason, leaseDecision: settled.leaseDecision,
    repository: settled.lease?.canonicalRepository, commonGitDirectory: settled.lease?.canonicalCommonGitDirectory,
    boundCommonGitDirectory: settled.lease?.canonicalBoundCommonGitDirectory, worktree: settled.lease?.canonicalWorktree }));
  assert.equal(settled.reason, 'branch_reachable');
  assert.equal((await classify([current], [target])).action, 'keep');
  assert.equal((await classify([{ ...current, claimLive: true }])).action, 'keep');
  assert.equal((await classify([current], [], true)).reason, 'locked');
  fs.writeFileSync(path.join(target, 'README.md'), 'uncommitted historical work\n');
  assert.equal((await classify()).reason, 'tracked_changes');
  fs.writeFileSync(path.join(target, 'README.md'), 'fixture\n');
  const incomplete = structuredClone(current);
  delete incomplete.dispatch.attempts.at(-1).worktreeCheckoutInstance;
  assert.equal((await classify([incomplete])).action, 'keep');
  const nonterminal = structuredClone(current);
  delete nonterminal.dispatch.attempts.at(-1).terminalSource;
  assert.equal((await classify([nonterminal])).action, 'keep');
  fs.writeFileSync(path.join(target, 'README.md'), 'undelivered historical commit\n');
  execFileSync('git', ['add', 'README.md'], { cwd: target, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'historical fixture work'], { cwd: target, stdio: 'pipe' });
  const laterClosure = await classify([{ ...current, status: 'done', archived: true }]);
  assert.equal(laterClosure.action, 'salvage', 'a later closure cannot discard undelivered historical commits');
  git('worktree', 'remove', target);
  git('worktree', 'add', target, 'worktree-agent-history-cleanup');
  const gitDirectory = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: target, encoding: 'utf8' }).trim();
  require('../lib/kernel/worktree.js').createCheckoutInstanceMarker(gitDirectory);
  const replaced = await classify();
  assert.equal(replaced.action, 'keep');
  assert.equal(replaced.reason, 'checkout_instance_mismatch');
  assert.equal(fs.existsSync(path.join(target, 'README.md')), true);
});

function cleanupCollisionFixture() {
  const { repository, slug, git } = fixture();
  const ticket = prepare(repository, slug, `placement-collision-history-${slug}`);
  const target = create(repository, `placement-collision-history-${slug}`, 'agent-collision-history');
  assert.equal(path.relative(repository, target).startsWith('..'), true, 'exercise external legacy cleanup');
  assert.equal(store.markDispatchStopped(`placement-collision-history-${slug}`, ticket.dispatchExecutor, null, `placement-collision-history-${slug}`).ok, true);
  const terminal = store.getTicket(slug, ticket.ref);
  const historical = { ...terminal, dispatch: { ...terminal.dispatch, worktree: null } };
  const live = { ...terminal, ref: 'SQ-live', status: 'doing', archived: false, claimLive: true,
    dispatch: { ...terminal.dispatch, outcome: 'claimed', terminalAt: null, terminalSource: null, attempts: [] } };
  const classify = (tickets: any[]) => worktrees.classifyWorktree(repository, tickets, {
    worktree: target, branch: 'refs/heads/worktree-agent-collision-history', head: git('rev-parse', 'HEAD'),
  }, repository, 0, 'main', [], 0, [repository, target]);
  return { target, historical, live, classify };
}

test('placement cleanup keeps a live current checkout despite another ticket history at its path', async () => {
  const { target, historical, live, classify } = cleanupCollisionFixture();
  assert.equal((await classify([historical])).action, 'remove', 'unique completed history still authorizes settled cleanup');
  assert.equal((await classify([live])).action, 'keep', 'positive live-claim control');
  for (const tickets of [[live, historical], [historical, live]]) {
    const result = await classify(tickets);
    assert.equal(result.action, 'keep', JSON.stringify({ ticket: result.ticket, reason: result.reason }));
    assert.equal(result.ticket, live.ref);
    assert.equal(result.lease.liveness.status, 'live');
  }
  assert.equal(fs.existsSync(path.join(target, 'README.md')), true);
});

test('placement cleanup does not treat ambiguous ticket ownership as an unowned legacy checkout', async () => {
  const { target, historical, live, classify } = cleanupCollisionFixture();
  for (const tickets of [[historical, { ...historical, ref: 'SQ-other-history' }],
    [live, { ...live, ref: 'SQ-other-current', claimLive: false }]]) {
    const result = await classify(tickets);
    assert.equal(result.action, 'keep', JSON.stringify({ ticket: result.ticket, reason: result.reason }));
    assert.equal(result.ticket, null, 'ambiguity grants no individual ticket authority');
  }
  assert.equal(fs.existsSync(path.join(target, 'README.md')), true);
});

test('placement creation refuses a missing or symlinked pinned directory', () => {
  for (const symlink of [false, true]) {
    const { repository, slug } = fixture();
    store.setBoardConfig(slug, { worktreeDirectory: '.worktrees' });
    const session = `placement-invalid-pin-${symlink}`;
    prepare(repository, slug, session);
    fs.rmdirSync(path.join(repository, '.worktrees'));
    if (symlink) fs.symlinkSync(path.join(repository, '.other-worktrees'), path.join(repository, '.worktrees'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => create(repository, session, 'agent-invalid-pin'), /must already exist|symlink|reparse/);
    assert.equal(fs.existsSync(path.join(repository, '.other-worktrees/agent-invalid-pin')), false);
  }
});

test('placement MCP descriptor exposes setup requirements and null reset', async () => {
  const mcp = require('../lib/mcp.js');
  const response = await mcp.handleRequest({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
  const property = response.result.tools.find((tool: any) => tool.name === 'board_config').inputSchema.properties.worktreeDirectory;
  assert.deepEqual(property.type, ['string', 'null']);
  assert.match(property.description, /existing/i);
  assert.match(property.description, /Git-ignored/);
  assert.match(property.description, /null.*external/);
});

test('placement refuses a pre-existing destination without removing foreign content', () => {
  const { repository, slug } = fixture();
  store.setBoardConfig(slug, { worktreeDirectory: '.worktrees' });
  prepare(repository, slug, 'placement-collision');
  const target = path.join(repository, '.worktrees/agent-placement-collision');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'foreign.txt'), 'preserve\n');
  assert.throws(() => create(repository, 'placement-collision', 'agent-placement-collision'), /destination existed/);
  assert.equal(fs.readFileSync(path.join(target, 'foreign.txt'), 'utf8'), 'preserve\n');
});

test('placement is configurable through CLI and MCP without changing unrelated board fields', async () => {
  const { repository, slug } = fixture();
  const before = store.boardConfig(slug);
  const cli = JSON.parse(execFileSync(process.execPath, [path.join(pluginRoot, 'bin/sidequest.js'),
    'board-config', '--project', repository, '--worktree-directory', '.worktrees', '--json'], {
    cwd: repository, env: { ...process.env, CLAUDE_PROJECT_DIR: repository }, encoding: 'utf8', stdio: 'pipe',
  }));
  assert.equal(cli.worktreeDirectory, '.worktrees');
  const mcp = require('../lib/mcp.js');
  const response = await mcp.handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'board_config', arguments: { project: repository, worktreeDirectory: null },
  } });
  assert.notEqual(response.result.isError, true);
  const after = JSON.parse(response.result.content[0].text);
  assert.equal(after.worktreeDirectory, null);
  assert.equal(after.integrationBranch, before.integrationBranch);
  assert.equal(after.worktreeIsolation, before.worktreeIsolation);
});

test('placement-only MCP changes still require mutation freshness', async () => {
  const { repository, slug } = fixture();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-placement-stale-'));
  const claudeHome = path.join(root, 'claude');
  const plugin = path.join(root, 'plugin');
  fs.mkdirSync(path.join(claudeHome, 'plugins'), { recursive: true });
  fs.mkdirSync(path.join(plugin, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(plugin, '.claude-plugin/plugin.json'), JSON.stringify({ version: '4.48.0' }));
  fs.writeFileSync(path.join(claudeHome, 'plugins/installed_plugins.json'), JSON.stringify({
    plugins: { 'sidequest@eigenwise-toolshed': [{ scope: 'project', projectPath: repository, version: 'not-semver' }] },
  }));
  const previousHome = process.env.SIDEQUEST_CLAUDE_HOME;
  const previousPlugin = process.env.CLAUDE_PLUGIN_ROOT;
  try {
    process.env.SIDEQUEST_CLAUDE_HOME = claudeHome;
    process.env.CLAUDE_PLUGIN_ROOT = plugin;
    const mcp = require('../lib/mcp.js');
    const response = await mcp.handleRequest({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
      name: 'board_config', arguments: { project: repository, worktreeDirectory: '.worktrees' },
    } });
    assert.equal(response.result.isError, true);
    assert.equal(store.boardConfig(slug).worktreeDirectory, null);
  } finally {
    if (previousHome == null) delete process.env.SIDEQUEST_CLAUDE_HOME;
    else process.env.SIDEQUEST_CLAUDE_HOME = previousHome;
    if (previousPlugin == null) delete process.env.CLAUDE_PLUGIN_ROOT;
    else process.env.CLAUDE_PLUGIN_ROOT = previousPlugin;
  }
});

test('placement cleanup retains an unowned operator worktree under the configured directory', async () => {
  const { repository, slug, git } = fixture();
  store.setBoardConfig(slug, { worktreeDirectory: '.worktrees' });
  const target = path.join(repository, '.worktrees/agent-operator');
  git('worktree', 'add', '-b', 'operator-integration', target, 'main');
  assert.equal(worktrees.isAgentWorktree(repository, target), true, 'an operator can use an agent-prefixed directory too');
  const decision = await worktrees.classifyWorktree(repository, [], {
    worktree: target, branch: 'refs/heads/operator-integration', head: git('rev-parse', 'HEAD'),
  }, repository, 0, 'main', [], 0, [repository, target]);
  assert.equal(decision.action, 'keep');
  assert.equal(decision.reason, 'unowned_worktree');
  assert.equal(fs.existsSync(path.join(target, 'README.md')), true);
});
