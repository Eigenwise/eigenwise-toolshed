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
