import './_temp-cleanup.js';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { DatabaseSync } = require('node:sqlite');
const store = require('../lib/store.js');

const DAY_MS = 24 * 60 * 60 * 1000;
const NOTIFICATION_ENV = ['SIDEQUEST_NOTIFICATIONS_MAX_UNREAD', 'SIDEQUEST_NOTIFICATIONS_UNREAD_MAX_AGE_DAYS'];

function freshBoard() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-notifications-home-'));
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-notifications-repo-'));
  execFileSync('git', ['init', '--quiet', '-b', 'main'], { cwd: repository, windowsHide: true });
  execFileSync('git', ['-c', 'user.name=Sidequest Tests', '-c', 'user.email=sidequest-test@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'fixture'], { cwd: repository, windowsHide: true });
  process.env.SIDEQUEST_HOME = home;
  process.env.CLAUDE_PROJECT_DIR = repository;
  for (const name of NOTIFICATION_ENV) delete process.env[name];
  const slug = store.ensureProject(repository).slug;
  const ticket = store.createTicket(slug, { title: 'Notification target', category: 'debugging' });
  return { home, slug, ticket };
}

function notificationEntry(index: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `nt_seed_${index}`,
    kind: 'comment',
    title: `Seeded ${index}`,
    // Real backlog entries carry a comment body, which is what made the row 9 MB.
    body: 'x'.repeat(1500),
    projectSlug: 'seeded',
    ticketRef: `SQ-${index}`,
    ticketId: `t_seed_${index}`,
    createdAt: new Date(Date.now() - (100000 - index) * 1000).toISOString(),
    readAt: null,
    fireAt: null,
    ticketEventAt: null,
    firedAt: null,
    ...overrides,
  };
}

function seedNotifications(home: string, list: unknown[]) {
  const raw = new DatabaseSync(path.join(home, 'sidequest.db'));
  try {
    raw.prepare("INSERT OR REPLACE INTO globals (key, data) VALUES ('notifications', ?)").run(JSON.stringify({ notifications: list }));
  } finally {
    raw.close();
  }
}

function storedNotifications(home: string): any[] {
  const raw = new DatabaseSync(path.join(home, 'sidequest.db'));
  try {
    const row = raw.prepare("SELECT data FROM globals WHERE key = 'notifications'").get() as { data: string } | undefined;
    return row ? JSON.parse(row.data).notifications : [];
  } finally {
    raw.close();
  }
}

test('an event notification is queued for the commenting source and readable afterwards', () => {
  const { slug, ticket } = freshBoard();
  const result = store.addComment(slug, ticket.ref, { by: 'agent-a', body: 'first finding', source: 'mcp' });
  assert.equal(result.ok, true);

  const listed = store.listNotifications({ projectSlug: slug, kind: 'comment' });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].ticketRef, ticket.ref);
  assert.equal(listed[0].ticketEventAt, result.ticket.updatedAt);
  assert.match(listed[0].body, /first finding/);

  const dashboard = store.addComment(slug, ticket.ref, { by: 'human', body: 'from the dashboard', source: 'dashboard' });
  assert.equal(dashboard.ok, true);
  assert.equal(store.listNotifications({ projectSlug: slug, kind: 'comment' }).length, 1, 'dashboard events never notify');
});

test('a repeated queue for the same ticket event does not duplicate the notification', () => {
  const globals = new Map<string, unknown>();
  const notifications = require('../lib/store/notifications.js').createNotifications({
    acquireLock: () => false,
    afterCommit: (fn: () => void) => fn(),
    crypto: require('node:crypto'),
    getTicket: () => null,
    path,
    projectsRoot: () => os.tmpdir(),
    readGlobal: (key: string, fallback: unknown) => (globals.has(key) ? globals.get(key) : fallback),
    readMeta: () => ({}),
    releaseLock: () => undefined,
    transaction: (fn: () => unknown) => fn(),
    writeGlobal: (key: string, value: unknown) => globals.set(key, value),
  });
  const ticket = { id: 't_1', ref: 'SQ-1', title: 'Once', status: 'doing', updatedAt: '2026-01-01T00:00:00.000Z' };
  notifications.queueEventNotification('p', ticket, 'status', 'mcp');
  notifications.queueEventNotification('p', ticket, 'status', 'mcp');
  assert.equal(notifications.listNotifications({}).length, 1);
});

test('unread notifications are capped by count, keeping the newest and every pending reminder', () => {
  const { home } = freshBoard();
  process.env.SIDEQUEST_NOTIFICATIONS_MAX_UNREAD = '5';
  const future = new Date(Date.now() + DAY_MS).toISOString();
  seedNotifications(home, [
    notificationEntry(1, { kind: 'reminder', fireAt: future }),
    ...Array.from({ length: 12 }, (_, index) => notificationEntry(index + 2)),
  ]);

  store.addNotification({ kind: 'comment', title: 'newest', projectSlug: 'seeded' });

  const stored = storedNotifications(home);
  const unread = stored.filter((n: any) => !n.readAt && n.kind !== 'reminder');
  assert.equal(unread.length, 5);
  assert.ok(unread.some((n: any) => n.title === 'newest'));
  assert.ok(unread.some((n: any) => n.id === 'nt_seed_13'), 'the newest seeded entries survive');
  assert.ok(!unread.some((n: any) => n.id === 'nt_seed_2'), 'the oldest seeded entries are dropped');
  assert.ok(stored.some((n: any) => n.id === 'nt_seed_1'), 'a pending reminder is never pruned');
});

test('unread notifications older than the age limit are pruned and read ones follow the read cap', () => {
  const { home } = freshBoard();
  process.env.SIDEQUEST_NOTIFICATIONS_UNREAD_MAX_AGE_DAYS = '7';
  const old = new Date(Date.now() - 8 * DAY_MS).toISOString();
  const recent = new Date(Date.now() - 2 * DAY_MS).toISOString();
  seedNotifications(home, [
    notificationEntry(1, { createdAt: old }),
    notificationEntry(2, { createdAt: recent }),
    notificationEntry(3, { createdAt: old, readAt: old }),
  ]);

  store.addNotification({ kind: 'comment', title: 'fresh', projectSlug: 'seeded' });

  const ids = storedNotifications(home).map((n: any) => n.id);
  assert.ok(!ids.includes('nt_seed_1'), 'stale unread entry pruned');
  assert.ok(ids.includes('nt_seed_2'), 'recent unread entry kept');
  assert.ok(ids.includes('nt_seed_3'), 'read entries stay governed by the read cap');
});

test('a 6,000-entry unread backlog does not inflate the ticket write transaction', (t) => {
  const { home, slug, ticket } = freshBoard();
  seedNotifications(home, Array.from({ length: 6000 }, (_, index) => notificationEntry(index)));
  assert.ok(fs.statSync(path.join(home, 'sidequest.db')).size > 8 * 1024 * 1024, 'the fixture reproduces a multi-megabyte row');

  const proto = DatabaseSync.prototype;
  const originalExec = proto.exec;
  const holds: number[] = [];
  let beganAt = 0;
  proto.exec = function patched(this: any, sql: string) {
    if (sql === 'BEGIN IMMEDIATE') beganAt = performance.now();
    const outcome = originalExec.call(this, sql);
    if (sql === 'COMMIT') holds.push(performance.now() - beganAt);
    return outcome;
  };
  try {
    assert.equal(store.addComment(slug, ticket.ref, { by: 'agent-a', body: 'event under backlog', source: 'mcp' }).ok, true);
  } finally {
    proto.exec = originalExec;
  }

  // Unfixed, this transaction also parsed and rewrote the whole row: 320-470 ms measured on a 9.46 MB row.
  // The bound is generous for a slow CI disk while staying far below that.
  assert.ok(holds.length >= 2, `the event and its notification commit separately (${holds.length} transactions)`);
  const ticketHold = holds[0] ?? Infinity;
  t.diagnostic(`transaction holds (ms): ${holds.map((hold) => hold.toFixed(1)).join(', ')}`);
  assert.ok(ticketHold < 200, `ticket write transaction held the lock for ${ticketHold.toFixed(0)} ms`);
  assert.ok(storedNotifications(home).length <= 300, 'the backlog was pruned by the notification write');
  assert.equal(store.listNotifications({ projectSlug: slug, kind: 'comment' }).length, 1);
});

test('an existing oversized row is pruned on first open without losing entries under the cap', () => {
  const { home } = freshBoard();
  const future = new Date(Date.now() + DAY_MS).toISOString();
  const entries = [
    notificationEntry(0, { kind: 'reminder', fireAt: future }),
    ...Array.from({ length: 3000 }, (_, index) => notificationEntry(index + 1)),
  ];
  seedNotifications(home, entries);

  const opened = spawnSync(process.execPath, ['-e', "require(process.argv[1]).listNotifications({});", path.resolve(__dirname, '..', 'lib', 'store.js')], {
    env: Object.assign({}, process.env, { SIDEQUEST_HOME: home }),
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(opened.status, 0, opened.stderr);

  const stored = storedNotifications(home);
  assert.ok(stored.length < entries.length, 'the oversized row shrank on open');
  assert.ok(stored.length <= 201);
  assert.ok(stored.some((n: any) => n.id === 'nt_seed_0'), 'the pending reminder survived');
  const newestKept = stored.filter((n: any) => n.kind !== 'reminder').map((n: any) => n.id);
  assert.ok(newestKept.includes('nt_seed_3000'), 'the newest entries survived');
  assert.ok(!newestKept.includes('nt_seed_1'), 'the oldest entries were dropped');
});
