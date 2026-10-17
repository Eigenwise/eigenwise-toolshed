import './_temp-cleanup.js';
'use strict';
/**
 * Which folders may become a board (SQ-3179). Hooks and tool calls used to mint a
 * board for whatever cwd they ran in: Codex scratch dirs, temp run dirs, the board's
 * own storage directory. Implicit resolution now needs a git root outside the
 * Sidequest home, the Claude config directory and the system temp directory, while
 * an explicitly named plain folder can still register.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

process.env.SIDEQUEST_NO_HOT_RECYCLE = '1';

const store = require('../lib/store.js');
const { resolveProject } = require('../lib/mcp-shared.js');
const { start } = require('../lib/server.js');

const CLI = path.join(__dirname, '..', 'bin', 'sidequest.js');
const realTemp = os.tmpdir();
const fixtureRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(realTemp, 'sq-project-root-')));
const otherTemp = path.join(fixtureRoot, 'other-temp');
fs.mkdirSync(otherTemp);

function directory(...parts: string[]) {
  const dir = path.join(fixtureRoot, ...parts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function gitRepository(...parts: string[]) {
  const dir = directory(...parts);
  fs.mkdirSync(path.join(dir, '.git'));
  return dir;
}

const TEMP_VARIABLES = ['TEMP', 'TMP', 'TMPDIR'];

function withEnvironment(values: Record<string, string>) {
  const saved = Object.keys(values).map((name) => [name, process.env[name]] as const);
  Object.assign(process.env, values);
  return () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

// The suite's SIDEQUEST_HOME sits under the real temp dir, which makes it a throwaway
// store that accepts temp fixtures. Pointing os.tmpdir() at a fixture folder that
// does not hold the home gives the rules a real store to judge.
const fakeTemp = directory('fake-temp');
const tempEnvironment = (root: string) => Object.fromEntries(TEMP_VARIABLES.map((name) => [name, root]));

function withTempRoot<T>(root: string, run: () => T): T {
  const restore = withEnvironment(tempEnvironment(root));
  try {
    return run();
  } finally {
    restore();
  }
}

const outsideTemp = <T>(run: () => T): T => withTempRoot(otherTemp, run);

function assertNoBoard(dir: string) {
  assert.strictEqual(store.findProject(dir).ok, false, `no board may be registered for ${dir}`);
}

test('implicit resolution refuses a git repository inside the system temp directory', () => {
  const repo = gitRepository('fake-temp', 'codex-image', 'run-6TlOg9');
  const result = withTempRoot(fakeTemp, () => store.registerProject(repo, undefined, { implicit: true }));
  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /^not a project root: .* is inside the system temp directory/);
  assert.ok(result.reason.includes(repo), 'the refusal names the path');
  assertNoBoard(repo);
});

test('explicit registration still refuses the system temp directory', () => {
  const plain = directory('fake-temp', 'plain');
  const result = withTempRoot(fakeTemp, () => store.registerProject(plain));
  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /inside the system temp directory/);
  assertNoBoard(plain);
});

test('a store that itself lives in temp accepts temp fixture folders', () => {
  const fixture = directory('throwaway-fixture');
  const result = store.registerProject(fixture, undefined, { implicit: true });
  assert.strictEqual(result.ok, true, result.reason);
});

test('a folder inside the Sidequest home never becomes a board, even named explicitly', () => {
  const storage = path.join(store.homeRoot(), 'projects', 'eigenwise-toolshed-f61e9c29');
  fs.mkdirSync(path.join(storage, '.git'), { recursive: true });
  for (const implicit of [true, false]) {
    const result = store.registerProject(storage, undefined, { implicit });
    assert.strictEqual(result.ok, false);
    assert.match(result.reason, /is inside the Sidequest home/);
    assert.ok(result.reason.includes(storage), 'the refusal names the path');
  }
  assertNoBoard(storage);
});

test('a folder inside the Claude config directory never becomes a board', () => {
  const claudeHome = directory('claude-home');
  const gate = gitRepository('claude-home', 'quality', 'contractify');
  const restore = withEnvironment({ SIDEQUEST_CLAUDE_HOME: claudeHome });
  try {
    const result = outsideTemp(() => store.registerProject(gate));
    assert.strictEqual(result.ok, false);
    assert.match(result.reason, /is inside the Claude config directory/);
  } finally {
    restore();
  }
  assertNoBoard(gate);
});

test('a missing directory is refused with the path it named', () => {
  const missing = path.join(fixtureRoot, 'run-6TlOg9');
  const result = outsideTemp(() => store.registerProject(store.explicitProjectRoot(missing)));
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, `not a project root: ${missing} is not an existing directory.`);
  assertNoBoard(missing);
});

test('implicit resolution refuses an unregistered non-git scratch dir, explicit registration takes it', () => {
  const scratch = directory('Documents', 'Codex', '2026-09-30', 'x20-can-you-research');
  const implicit = outsideTemp(() => store.registerProject(scratch, undefined, { implicit: true }));
  assert.strictEqual(implicit.ok, false);
  assert.match(implicit.reason, /is not a git repository root and was never registered as a board/);
  assertNoBoard(scratch);

  const vault = directory('Life 2.0');
  const explicit = outsideTemp(() => store.registerProject(store.explicitProjectRoot(vault), 'Life 2.0'));
  assert.strictEqual(explicit.ok, true, explicit.reason);
  assert.strictEqual(explicit.meta.path, vault);
  assert.strictEqual(explicit.meta.name, 'Life 2.0');

  const reused = outsideTemp(() => store.registerProject(vault, undefined, { implicit: true }));
  assert.strictEqual(reused.ok, true, 'a registered plain folder resolves implicitly');
  assert.strictEqual(reused.slug, explicit.slug);
});

test('implicit resolution creates a board for a git repository root', () => {
  const repo = gitRepository('dev', 'real-project');
  const result = outsideTemp(() => store.registerProject(repo, undefined, { implicit: true }));
  assert.strictEqual(result.ok, true, result.reason);
  assert.strictEqual(store.findProject(repo).slug, result.slug);
});

test('the projects listing flags a board whose folder is gone without removing it', () => {
  const gone = store.ensureProject(path.join(fixtureRoot, 'codex-image', 'run-OORTJU'), 'run-OORTJU');
  const present = store.ensureProject(directory('present'), 'present');
  const listed = store.listProjectsFlaggingMissingPaths();
  const bySlug = new Map<string, any>(listed.map((project: any) => [project.slug, project]));
  assert.strictEqual(bySlug.get(gone.slug).missingPath, true);
  assert.strictEqual('missingPath' in bySlug.get(present.slug), false);
  assert.ok(store.readMeta(gone.slug), 'the board is surfaced, not deleted');
});

test('MCP resolution without a project refuses a temp cwd and lists the registered boards', () => {
  const registered = store.ensureProject(directory('named-board'), 'Named Board');
  const restore = withEnvironment({ ...tempEnvironment(fakeTemp), CLAUDE_PROJECT_DIR: directory('fake-temp', 'run-abc') });
  try {
    assert.throws(() => resolveProject(), (error: any) => {
      assert.match(error.message, /^not a project root: .*run-abc is inside the system temp directory/);
      assert.match(error.message, /Pass project to name a registered board: .*Named Board/);
      return true;
    });
    assert.strictEqual(resolveProject('Named Board').slug, registered.slug);
  } finally {
    restore();
  }
});

test('MCP resolution of an unknown absolute path refuses a missing directory', () => {
  const missing = path.join(fixtureRoot, 'typo');
  assert.throws(() => resolveProject(missing), /not a project root: .*typo is not an existing directory/);
  assert.throws(() => resolveProject('no-such-board'), /does not match any registered board/);
});

test('the CLI refuses an implicit temp cwd without a stack trace', () => {
  const cwd = directory('fake-temp', 'cli-scratch');
  const run = spawnSync(process.execPath, [CLI, 'list', '--json'], {
    encoding: 'utf8',
    env: { ...process.env, ...tempEnvironment(fakeTemp), CLAUDE_PROJECT_DIR: cwd },
  });
  assert.strictEqual(run.status, 1);
  assert.match(run.stderr, /^sidequest: not a project root: .*cli-scratch is inside the system temp directory/);
  assert.doesNotMatch(run.stderr, /\n\s+at /);
  assertNoBoard(cwd);

  const missing = path.join(fixtureRoot, 'cli-missing');
  const named = spawnSync(process.execPath, [CLI, 'list', '--json', '--project', missing], { encoding: 'utf8', env: process.env });
  assert.strictEqual(named.status, 1);
  assert.match(named.stderr, /cli-missing is not an existing directory/);
});

function postJson(port: number, endpoint: string, body: unknown) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request({ host: '127.0.0.1', port, path: endpoint, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, (response: any) => {
      let text = '';
      response.on('data', (chunk: string) => (text += chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(text) }));
    });
    request.on('error', reject);
    request.end(payload);
  });
}

function availablePort() {
  return new Promise<number>((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error?: Error) => error ? reject(error) : resolve(port));
    });
  });
}

test('the dashboard API refuses a temp projectPath with the reason and still takes a named board', async (t: any) => {
  const started = await start(await availablePort());
  t.after(() => started.server.close());
  const scratch = directory('fake-temp', 'dashboard-scratch');
  const notes = directory('dashboard-notes');
  const restore = withEnvironment(tempEnvironment(fakeTemp));
  try {
    for (const endpoint of ['/api/tickets', '/api/stories']) {
      const refused = await postJson(started.port, endpoint, { title: 'x', projectPath: scratch });
      assert.strictEqual(refused.status, 400, endpoint);
      assert.match(refused.body.error, /dashboard-scratch is inside the system temp directory/);
    }
    const registered = await postJson(started.port, '/api/stories', { title: 'notes', projectPath: notes, projectName: 'Notes' });
    assert.strictEqual(registered.status, 201, JSON.stringify(registered.body));
    assert.strictEqual(store.findProject(notes).meta.name, 'Notes');
  } finally {
    restore();
  }
  assertNoBoard(scratch);

  const board = store.ensureProject(directory('dashboard-board'), 'Dashboard Board');
  const story = await postJson(started.port, '/api/stories', { title: 'named', project: board.slug });
  assert.strictEqual(story.status, 201);
  const unnamed = await postJson(started.port, '/api/stories', { title: 'nothing' });
  assert.strictEqual(unnamed.status, 400);
  assert.match(unnamed.body.error, /a project is required/);
});

const moveDatabase = require('../lib/db.js').openDb(store.homeRoot());
const { reportFile: moveSweepReportFile } = require('../lib/sweep-state-path.js');
const { canonicalPath: moveCanonicalPath } = require('../lib/kernel/worktree.js');
const { execFileSync: moveGit } = require('node:child_process');

function movableBoard(name: string) {
  const repository = directory(name);
  moveGit('git', ['init', '-b', 'main', repository], { stdio: 'pipe' });
  const board = store.ensureProject(repository, name);
  return { repository, board };
}

function seedMoveTicket(slug: string, fields: Record<string, unknown>) {
  const ticket = store.createTicket(slug, { title: 'preserve me' });
  const stored = { ...ticket, ...fields };
  moveDatabase.prepare('UPDATE tickets SET data = ? WHERE id = ?').run(JSON.stringify(stored), ticket.id);
  return stored;
}

test('board move preserves refs, comments, pending submissions, routing and checkout registrations', () => {
  const { repository, board } = movableBoard('move-source');
  const destination = path.join(fixtureRoot, 'move-destination');
  moveGit('git', ['-C', repository, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'fixture'], { stdio: 'pipe' });
  const externalCheckout = path.join(fixtureRoot, 'move-external-checkout');
  moveGit('git', ['-C', repository, 'worktree', 'add', '--detach', externalCheckout], { stdio: 'pipe' });
  const story = store.createStory(board.slug, { title: 'keep the story' });
  const submission = { state: 'pending', commit: 'abc123', worktree: repository, review: { immutable: true } };
  const ticket = seedMoveTicket(board.slug, { submission, dispatch: { terminalAt: new Date().toISOString(), worktree: path.join(repository, 'checkout'), worktreeCommonGitDirectory: path.join(repository, '.git') } });
  store.addComment(board.slug, ticket.ref, { by: 'fixture', body: 'keep the history' });
  const before = store.getTicket(board.slug, ticket.ref);
  const profile = moveDatabase.prepare('SELECT profile_id FROM project_routing_profiles WHERE project = ?').get(board.slug).profile_id;
  const storage = store.projectDir(board.slug);
  fs.mkdirSync(path.join(storage, 'assets', ticket.id), { recursive: true });
  fs.writeFileSync(path.join(storage, 'assets', ticket.id, 'proof.txt'), 'asset');
  fs.mkdirSync(path.join(storage, 'verification'), { recursive: true });
  fs.writeFileSync(path.join(storage, 'verification', 'receipt'), 'immutable');
  fs.renameSync(repository, destination);
  const moved = store.moveProject(repository, destination);
  const preserved = store.getTicket(moved.slug, ticket.ref);
  assert.ok(preserved, 'moved ticket is registered under destination board');
  assert.strictEqual(preserved.ref, ticket.ref);
  assert.deepStrictEqual(preserved.comments, before.comments);
  assert.strictEqual(JSON.stringify(preserved.submission), JSON.stringify(submission));
  assert.strictEqual(moveCanonicalPath(preserved.dispatch.worktree), moveCanonicalPath(path.join(destination, 'checkout')));
  assert.strictEqual(moveCanonicalPath(preserved.dispatch.worktreeCommonGitDirectory), moveCanonicalPath(path.join(destination, '.git')));
  assert.strictEqual(store.getStory(moved.slug, story.ref).title, story.title);
  assert.strictEqual(store.createStory(moved.slug, { title: 'next story' }).ref, 'US-2');
  assert.strictEqual(moveGit('git', ['-C', externalCheckout, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim().replaceAll('\\', '/'), externalCheckout.replaceAll('\\', '/'));
  assert.ok(moveGit('git', ['-C', destination, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' }).includes(externalCheckout.replaceAll('\\', '/')));
  assert.strictEqual(moveDatabase.prepare('SELECT profile_id FROM project_routing_profiles WHERE project = ?').get(moved.slug).profile_id, profile);
  assert.strictEqual(fs.readFileSync(path.join(store.projectDir(moved.slug), 'assets', ticket.id, 'proof.txt'), 'utf8'), 'asset');
  assert.strictEqual(fs.readFileSync(path.join(storage, 'verification', 'receipt'), 'utf8'), 'immutable');
  assert.strictEqual(store.findProject(repository).ok, false);
  assert.strictEqual(store.findProject(destination).slug, moved.slug);
  assert.strictEqual(store.createTicket(moved.slug, { title: 'next' }).ref, 'SQ-2');
  assert.strictEqual(store.readMeta(moved.slug).moves[0].event, 'board.move');
});

test('board move refuses an occupied destination without changing either board', () => {
  const source = movableBoard('move-occupied-source');
  const destination = movableBoard('move-occupied-target');
  assert.throws(() => store.moveProject(source.repository, destination.repository), /already has a board/);
  assert.strictEqual(store.findProject(source.repository).slug, source.board.slug);
  assert.strictEqual(store.findProject(destination.repository).slug, destination.board.slug);
});

test('board move refuses a non-Git destination', () => {
  const source = movableBoard('move-no-git-source');
  assert.throws(() => store.moveProject(source.repository, directory('move-no-git-target')), /git|repository/i);
  assert.strictEqual(store.findProject(source.repository).slug, source.board.slug);
});

test('board move names active claims and nonterminal dispatches before moving anything', () => {
  const source = movableBoard('move-live-source');
  const destination = directory('move-live-target');
  moveGit('git', ['init', '-b', 'main', destination], { stdio: 'pipe' });
  const ticket = seedMoveTicket(source.board.slug, { claim: { by: 'active-worker' }, dispatch: { preparedAt: new Date().toISOString() } });
  assert.throws(() => store.moveProject(source.repository, destination), /SQ-1 claimed by active-worker; SQ-1 has a nonterminal dispatch/);
  assert.strictEqual(store.getTicket(source.board.slug, ticket.ref).claim.by, 'active-worker');
});

test('board move refuses an extant sweep flight and leaves its owner untouched', () => {
  const source = movableBoard('move-flight-source');
  const destination = directory('move-flight-target');
  moveGit('git', ['init', '-b', 'main', destination], { stdio: 'pipe' });
  const flight = moveSweepReportFile(source.repository).replace(/\.json$/, '.flight');
  fs.mkdirSync(path.dirname(flight), { recursive: true });
  fs.writeFileSync(flight, 'an existing owner');
  assert.throws(() => store.moveProject(source.repository, destination), /sweep flight/);
  assert.strictEqual(fs.readFileSync(flight, 'utf8'), 'an existing owner');
  fs.rmSync(flight);
});

test('shipped board move CLI repoints the board without creating a destination board first', () => {
  const source = movableBoard('move-cli-source');
  const destination = path.join(fixtureRoot, 'move-cli-target');
  fs.renameSync(source.repository, destination);
  const result = spawnSync(process.execPath, [CLI, 'board', 'move', source.repository, destination, '--json'], { encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(JSON.parse(result.stdout).slug, store.findProject(destination).slug);
});

test('board move relocates worker slugs and nested checkout identities without touching sibling paths', () => {
  const source = movableBoard('move-identities-source');
  const destination = path.join(fixtureRoot, 'move-identities-target');
  const outside = `${source.repository}-sibling`;
  const originalWorkers = moveDatabase.prepare("SELECT data FROM globals WHERE key = 'workers'").get();
  const workers = { sessions: { 'move-worker': { claims: [{ slug: source.board.slug }, { slug: 'unrelated-board' }] } } };
  moveDatabase.prepare("INSERT OR REPLACE INTO globals (key, data) VALUES ('workers', ?)").run(JSON.stringify(workers));
  const ticket = seedMoveTicket(source.board.slug, { dispatch: {
    terminalAt: new Date().toISOString(),
    worktree: path.join(source.repository, 'checkout'),
    continuation: { sourceWorktree: path.join(source.repository, 'retained'), lease: { observedWorktree: path.join(source.repository, 'retained'), checkoutInstance: 'immutable-checkout' } },
    lease: { boundWorktree: path.join(source.repository, 'bound'), commonGitDirectory: path.join(source.repository, '.git') },
    releaseObservedCheckout: { repository: source.repository, gitDirectory: path.join(source.repository, '.git') },
    ownedDependencyLinks: [{ target: path.join(source.repository, 'dependencies') }, { target: outside }],
  } });
  try {
    fs.renameSync(source.repository, destination);
    const moved = store.moveProject(source.repository, destination);
    const preserved = store.getTicket(moved.slug, ticket.ref);
    assert.ok(preserved, 'moved ticket is registered under destination board');
    const dispatch = preserved.dispatch;
    assert.strictEqual(moveCanonicalPath(dispatch.continuation.lease.observedWorktree), moveCanonicalPath(path.join(destination, 'retained')));
    assert.strictEqual(dispatch.continuation.lease.checkoutInstance, 'immutable-checkout');
    assert.strictEqual(moveCanonicalPath(dispatch.continuation.sourceWorktree), moveCanonicalPath(path.join(destination, 'retained')));
    assert.strictEqual(moveCanonicalPath(dispatch.lease.boundWorktree), moveCanonicalPath(path.join(destination, 'bound')));
    assert.strictEqual(moveCanonicalPath(dispatch.lease.commonGitDirectory), moveCanonicalPath(path.join(destination, '.git')));
    assert.strictEqual(moveCanonicalPath(dispatch.releaseObservedCheckout.repository), moveCanonicalPath(destination));
    assert.strictEqual(moveCanonicalPath(dispatch.ownedDependencyLinks[0].target), moveCanonicalPath(path.join(destination, 'dependencies')));
    assert.strictEqual(dispatch.ownedDependencyLinks[1].target, outside);
    assert.deepStrictEqual(JSON.parse(moveDatabase.prepare("SELECT data FROM globals WHERE key = 'workers'").get().data).sessions['move-worker'].claims, [{ slug: moved.slug }, { slug: 'unrelated-board' }]);
  } finally {
    moveDatabase.prepare("DELETE FROM globals WHERE key = 'workers'").run();
    if (originalWorkers) moveDatabase.prepare("INSERT INTO globals (key, data) VALUES ('workers', ?)").run(originalWorkers.data);
  }
});

test('board move rolls back database and stored assets when the project rekey fails', () => {
  const source = movableBoard('move-rollback-source');
  const destination = path.join(fixtureRoot, 'move-rollback-target');
  const ticket = seedMoveTicket(source.board.slug, { dispatch: { terminalAt: new Date().toISOString(), worktree: source.repository } });
  const asset = path.join(store.projectDir(source.board.slug), 'asset.txt');
  fs.writeFileSync(asset, 'keep this asset');
  moveDatabase.exec(`CREATE TRIGGER refuse_board_move BEFORE DELETE ON projects WHEN OLD.slug = '${source.board.slug}' BEGIN SELECT RAISE(ABORT, 'injected rekey failure'); END`);
  fs.renameSync(source.repository, destination);
  try {
    assert.throws(() => store.moveProject(source.repository, destination), /injected rekey failure/);
    assert.strictEqual(store.findProject(source.repository).slug, source.board.slug);
    assert.strictEqual(store.findProject(destination).ok, false);
    assert.strictEqual(store.getTicket(source.board.slug, ticket.ref).dispatch.worktree, source.repository);
    assert.strictEqual(fs.readFileSync(asset, 'utf8'), 'keep this asset');
    assert.strictEqual(fs.existsSync(store.projectDir(store.slugify(destination))), false);
    assert.strictEqual(fs.existsSync(moveSweepReportFile(source.repository).replace(/\.json$/, '.flight')), false);
    assert.strictEqual(fs.existsSync(moveSweepReportFile(destination).replace(/\.json$/, '.flight')), false);
  } finally {
    moveDatabase.exec('DROP TRIGGER refuse_board_move');
  }
});

test('moved-board checkout resolution follows successive moves and preserves external paths', () => {
  const { currentBoardPath } = require('../lib/store/move.js');
  const first = path.join(fixtureRoot, 'first-location');
  const second = path.join(fixtureRoot, 'second-location');
  const third = path.join(fixtureRoot, 'third-location');
  const meta = { moves: [{ from: first, to: second }, { from: second, to: third }] };
  assert.strictEqual(moveCanonicalPath(currentBoardPath(meta, path.join(first, 'checkout'))), moveCanonicalPath(path.join(third, 'checkout')));
  assert.strictEqual(currentBoardPath(meta, `${first}-sibling`), `${first}-sibling`);
  assert.strictEqual(currentBoardPath(meta, ''), '');
  assert.strictEqual(currentBoardPath({}, first), first);
});

function deletedIntegrationTargetFixture(name: string, landed: boolean, currentBranch: string) {
  const { repository, board } = movableBoard(name);
  const git = (argumentsList: string[]) => moveGit('git', argumentsList, { cwd: repository, encoding: 'utf8', stdio: 'pipe' }).trim();
  git(['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-m', 'base']);
  const base = git(['rev-parse', 'HEAD']);
  git(['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-m', 'candidate']);
  const candidate = git(['rev-parse', 'HEAD']);
  git(['update-ref', 'refs/remotes/origin/main', landed ? candidate : base]);
  git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
  git(['update-ref', 'refs/remotes/origin/deleted', base]);
  git(['update-ref', '-d', 'refs/remotes/origin/deleted']);
  git(['branch', 'deleted', base]);
  git(['reset', '--hard', landed ? candidate : base]);
  store.setBoardConfig(board.slug, { integrationMode: 'local', integrationBranch: currentBranch });
  const ticket = seedMoveTicket(board.slug, {
    status: 'todo',
    dispatch: { integrationTarget: { mode: 'remote', branch: 'deleted', upstream: 'origin/deleted' }, terminalAt: new Date().toISOString() },
    submission: { commit: candidate, base, integrationBranch: 'deleted' },
  });
  return { board, ticket };
}

for (const currentBranch of ['main', 'missing']) {
  test(`GH-556: deleted frozen target abandons an unreachable candidate via ${currentBranch}`, () => {
    const { board, ticket } = deletedIntegrationTargetFixture(`abandon-deleted-${currentBranch}`, false, currentBranch);
    const options = { by: 'orchestrator', purpose: 'grooming', reason: 'The deleted branch candidate never landed.' };
    const delivery = store.completeTicketAsControlPlane(board.slug, ticket.ref, options);
    assert.strictEqual(delivery.reason, 'integration_target_unavailable', 'delivery retains the frozen-target refusal');
    const abandoned = store.completeTicketAsControlPlane(board.slug, ticket.ref, { ...options, abandonSubmission: true });
    assert.strictEqual(abandoned.ok, true, abandoned.message);
    assert.strictEqual(abandoned.ticket.submission.integration.outcome, 'abandoned');
    assert.strictEqual(abandoned.ticket.submission.integration.candidateState, 'unreachable');
    assert.strictEqual(abandoned.ticket.submission.integration.evidence, options.reason);
    assert.strictEqual(store.pendingSubmission(store.getTicket(board.slug, ticket.ref)), false);
  });

  test(`GH-556: deleted frozen target refuses abandonment of a candidate landed via ${currentBranch}`, () => {
    const { board, ticket } = deletedIntegrationTargetFixture(`landed-deleted-${currentBranch}`, true, currentBranch);
    const before = JSON.stringify(store.getTicket(board.slug, ticket.ref));
    const refused = store.completeTicketAsControlPlane(board.slug, ticket.ref, {
      by: 'orchestrator', purpose: 'grooming', abandonSubmission: true, reason: 'Check whether this candidate landed.',
    });
    assert.strictEqual(refused.ok, false);
    assert.match(refused.message, /Candidate already landed on refs\/(heads|remotes\/origin)\/main/);
    assert.strictEqual(JSON.stringify(store.getTicket(board.slug, ticket.ref)), before, 'a landed candidate remains pending and unchanged');
  });
}

test('GH-567: siblings frozen on remote:origin/main and local:main resolve to one wave target; different branches still refuse', () => {
  const { repository, board } = movableBoard('gh-567-wave-target');
  const git = (argumentsList: string[]) => moveGit('git', argumentsList, { cwd: repository, encoding: 'utf8', stdio: 'pipe' }).trim();
  const commit = (message: string) => git(['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-m', message]);
  commit('base');
  git(['remote', 'add', 'origin', path.join(fixtureRoot, 'gh-567-unused-remote')]);
  git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  git(['config', 'branch.main.remote', 'origin']);
  git(['config', 'branch.main.merge', 'refs/heads/main']);
  git(['branch', 'other']);
  const frozenOn = (ref: string, integrationTarget: object) => ({ ref, dispatch: { integrationTarget } });
  const remoteSibling = frozenOn('SQ-1', { mode: 'remote', branch: 'main', upstream: 'origin/main' });
  const localSibling = frozenOn('SQ-2', { mode: 'local', branch: 'main', upstream: 'main' });

  const level = store.ticketIntegrationTargets(board.slug, [remoteSibling, localSibling]);
  assert.strictEqual(level.ok, true, level.message);
  assert.deepStrictEqual(level.target, { mode: 'remote', upstream: 'origin/main', branch: 'main' }, 'local main level with origin picks the remote form');

  commit('unpushed local work');
  const ahead = store.ticketIntegrationTargets(board.slug, [remoteSibling, localSibling]);
  assert.strictEqual(ahead.ok, true, ahead.message);
  assert.deepStrictEqual(ahead.target, { mode: 'local', upstream: 'main', branch: 'main' }, 'local main ahead of origin picks the local form');

  const otherBranch = frozenOn('SQ-3', { mode: 'local', branch: 'other', upstream: 'other' });
  const split = store.ticketIntegrationTargets(board.slug, [remoteSibling, otherBranch]);
  assert.strictEqual(split.ok, false);
  assert.strictEqual(split.reason, 'integration_target_mismatch');
  assert.match(split.message, /SQ-1=remote:origin\/main, SQ-3=local:other/);
  assert.match(split.message, /redispatch .* with integrationBranch main/);
});
