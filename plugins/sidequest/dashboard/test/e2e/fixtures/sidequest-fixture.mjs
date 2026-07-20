import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { execFileSync, spawn } from 'node:child_process';
import net from 'node:net';

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '..', '..', '..', '..', '..', '..');
const bin = join(root, 'plugins', 'sidequest', 'bin', 'sidequest.js');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

async function freePort() {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolveClose, rejectClose) => probe.close((error) => error ? rejectClose(error) : resolveClose()));
  return port;
}

function seed(home, projectRoot) {
  process.env.SIDEQUEST_HOME = home;
  process.env.CLAUDE_PROJECT_DIR = projectRoot;
  const store = require(join(root, 'plugins', 'sidequest', 'lib', 'store.js'));
  const db = require(join(root, 'plugins', 'sidequest', 'lib', 'db.js'));
  const database = db.openDb(home);
  const first = store.ensureProject(join(projectRoot, 'alpha'), 'Alpha board');
  const second = store.ensureProject(join(projectRoot, 'beta'), 'Beta board');
  const archived = store.ensureProject(join(projectRoot, 'retired'), 'Retired board');
  store.setProjectNotify(second.slug, false);
  store.setProjectRouting(first.slug, 'enabled');
  const story = store.createStory(first.slug, { title: 'Parity rollout', description: 'Seeded story', color: '#8c6cff' });
  const todo = store.createTicket(first.slug, {
    title: 'Ship the dashboard parity suite',
    description: '# Acceptance\n\nSeeded **markdown** details with [a link](https://example.com).',
    priority: 'urgent',
    labels: ['acceptance', 'synthetic'],
    files: ['dashboard/e2e/dashboard.spec.ts'],
    category: 'general',
    storyId: story.id,
    assignee: 'you',
    imagesData: [{ name: 'fixture.png', base64: `data:image/png;base64,${png}` }],
    source: 'cli'
  });
  const doing = store.createTicket(first.slug, {
    title: 'Investigate stale agent claim',
    description: 'A blocked implementation.',
    priority: 'high',
    category: 'general',
    assignee: 'agent',
    source: 'cli'
  });
  const done = store.createTicket(first.slug, { title: 'Completed seeded work', status: 'done', priority: 'low', category: 'general', source: 'cli' });
  const betaTicket = store.createTicket(second.slug, { title: 'Beta board ticket', priority: 'normal', category: 'general', source: 'cli' });
  const archivedTicket = store.createTicket(archived.slug, { title: 'Archived ticket', status: 'done', category: 'general', source: 'cli' });
  store.archiveTicket(archived.slug, archivedTicket.id, { source: 'cli' });
  store.addComment(first.slug, todo.id, { by: 'fixture', body: 'A regular seeded comment.', source: 'background' });
  store.addComment(first.slug, doing.id, { by: 'fixture', body: 'This is a blocked comment.', source: 'background' });
  store.linkTickets(first.slug, todo.ref, 'blocks', doing.ref);
  store.setReminder(first.slug, todo.id, new Date(Date.now() + 60 * 60 * 1000).toISOString());

  const current = store.getTicket(first.slug, todo.id);
  current.comments.push({ id: 'legacy-question', by: 'legacy-agent', body: 'Legacy question should render as a plain comment.', kind: 'question', source: 'background', at: new Date().toISOString() });
  db.putRow(database, 'tickets', {
    id: current.id,
    project: first.slug,
    ref: current.ref,
    status: current.status,
    archived: current.archived ? 1 : 0,
    ord: current.order,
    claim_by: null,
    data: current
  });
  db.putRow(database, 'globals', { key: 'notify-prefs', data: { comment: true, created: true, status: true } });
  database.close();
  return { first, second, archived, todo, doing, done, betaTicket, archivedTicket };
}

export async function startFixture() {
  const home = await mkdtemp(join(tmpdir(), 'sidequest-dashboard-e2e-'));
  const projectRoot = await mkdtemp(join(tmpdir(), 'sidequest-dashboard-project-'));
  await mkdir(join(projectRoot, 'alpha'), { recursive: true });
  await mkdir(join(projectRoot, 'beta'), { recursive: true });
  await mkdir(join(projectRoot, 'retired'), { recursive: true });
  const seeded = execFileSync(process.execPath, [join(import.meta.dirname, 'seed.mjs'), home, projectRoot, root], {
    cwd: root,
    env: { ...process.env, SIDEQUEST_HOME: home, CLAUDE_PROJECT_DIR: projectRoot },
    encoding: 'utf8'
  });
  const port = await freePort();
  const child = spawn(process.execPath, [bin, 'serve', '--port', String(port)], {
    cwd: root,
    env: { ...process.env, SIDEQUEST_HOME: home, CLAUDE_PROJECT_DIR: join(projectRoot, 'alpha'), SIDEQUEST_NO_HOT_RECYCLE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  let output = '';
  child.stdout?.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr?.on('data', (chunk) => { output += chunk.toString(); });
  const baseURL = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseURL}/api/health`);
      if (response.ok) break;
    } catch { /* server is still binding */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  const health = await fetch(`${baseURL}/api/health`);
  if (!health.ok) throw new Error(`dashboard server did not start: ${output}`);
  return {
    baseURL,
    home,
    projectRoot,
    seeded,
    child,
    async stop() {
      if (!child.killed) {
        child.kill('SIGTERM');
        await Promise.race([once(child, 'exit'), new Promise((resolveWait) => setTimeout(resolveWait, 2_000))]);
      }
      if (child.exitCode === null && process.platform === 'win32') {
        try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ }
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      await rm(home, { recursive: true, force: true });
      await rm(projectRoot, { recursive: true, force: true });
    }
  };
}
