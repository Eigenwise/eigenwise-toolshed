import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

type Notification = { id: string; kind: string; ticketId: string | null; body: string; createdAt: string; fireAt: string | null };

const db = require('../lib/db.js');
const store = require('../lib/store.js');

const DAY_MS = 24 * 60 * 60 * 1000;

// Each test gets a home the store has never opened, so the first store call is a real first open.
function withFreshHome(run: (home: string) => void, env: Record<string, string> = {}) {
  const home = fs.mkdtempSync(path.join(String(process.env.SIDEQUEST_HOME), 'notify-'));
  const prior = { ...process.env };
  Object.assign(process.env, env, { SIDEQUEST_HOME: home });
  try {
    run(home);
  } finally {
    for (const key of Object.keys(env)) delete process.env[key];
    process.env.SIDEQUEST_HOME = prior.SIDEQUEST_HOME;
  }
}

function unreadNotification(id: string, createdAt: number, fields: Partial<Notification> = {}) {
  return {
    id, kind: 'comment', title: id, body: 'x'.repeat(200), projectSlug: null, ticketRef: null, ticketId: null,
    createdAt: new Date(createdAt).toISOString(), readAt: null, fireAt: null, ticketEventAt: null, firedAt: null,
    ...fields,
  };
}

function unreadNotifications(count: number) {
  const newestAt = Date.now() - 1000;
  return Array.from({ length: count }, (_, index) => unreadNotification(`nt_seed_${index}`, newestAt - (count - 1 - index) * 1000));
}

function writeNotificationsRow(home: string, notifications: unknown[], extraGlobals: Record<string, unknown> = {}) {
  const raw = db.openDb(home);
  try {
    db.putRow(raw, 'globals', { key: 'notifications', data: { notifications } });
    for (const [key, data] of Object.entries(extraGlobals)) db.putRow(raw, 'globals', { key, data });
  } finally {
    raw.close();
  }
}

function storedNotificationIds(home: string): string[] {
  const raw = db.openDb(home);
  try {
    return db.getRow(raw, 'globals', 'notifications').notifications.map((notification: Notification) => notification.id);
  } finally {
    raw.close();
  }
}

function boardWithTicket(home: string) {
  const slug = store.ensureProject(fs.mkdtempSync(path.join(home, 'repo-')), 'notification bounds').slug;
  const ticket = store.createTicket(slug, { title: 'Notification bounds fixture' });
  return { slug, ticket };
}

test('7,000 unread notifications plus one new event keep only the newest, up to the default cap', () => withFreshHome((home) => {
  const { slug, ticket } = boardWithTicket(home);
  const seeds = unreadNotifications(7000);
  writeNotificationsRow(home, seeds);

  const added = store.addComment(slug, ticket.id, { by: 'tester', source: 'mcp', body: 'the newest event' });

  assert.equal(added.ok, true);
  const kept: Notification[] = store.listNotifications({ includePending: true });
  assert.equal(kept.length, 200);
  assert.equal(kept[0]?.ticketId, ticket.id, 'the new event is the newest entry and survives the cap');
  assert.deepEqual(kept.slice(1).map((notification) => notification.id), seeds.slice(-199).reverse().map((seed) => seed.id));
}));

test('the age and count bounds follow their env vars and never drop a pending reminder', () => withFreshHome((home) => {
  const { slug, ticket } = boardWithTicket(home);
  const now = Date.now();
  writeNotificationsRow(home, [
    unreadNotification('nt_stale', now - 10 * DAY_MS),
    unreadNotification('nt_reminder', now - 10 * DAY_MS, { kind: 'reminder', fireAt: new Date(now + DAY_MS).toISOString() }),
    unreadNotification('nt_recent_older', now - 3000),
    unreadNotification('nt_recent_newer', now - 2000),
  ]);

  store.addComment(slug, ticket.id, { by: 'tester', source: 'mcp', body: 'bounded by env' });

  const kept: Notification[] = store.listNotifications({ includePending: true });
  assert.equal(kept.length, 3);
  assert.ok(kept.some((notification) => notification.id === 'nt_reminder'), 'a reminder that has not fired yet is kept');
  assert.ok(kept.some((notification) => notification.id === 'nt_recent_newer'));
  assert.ok(kept.some((notification) => notification.ticketId === ticket.id && notification.kind === 'comment'));
  assert.equal(kept.some((notification) => notification.id === 'nt_stale'), false, 'older than SIDEQUEST_NOTIFICATIONS_MAX_AGE_DAYS');
  assert.equal(kept.some((notification) => notification.id === 'nt_recent_older'), false, 'over SIDEQUEST_NOTIFICATIONS_MAX_UNREAD');
}, { SIDEQUEST_NOTIFICATIONS_MAX_AGE_DAYS: '7', SIDEQUEST_NOTIFICATIONS_MAX_UNREAD: '3' }));

test('a ticket comment still commits when its notification write throws', () => withFreshHome((home) => {
  const { slug, ticket } = boardWithTicket(home);
  const raw = db.openDb(home);
  raw.exec(`
    CREATE TRIGGER refuse_notification_insert BEFORE INSERT ON globals WHEN NEW.key = 'notifications'
      BEGIN SELECT RAISE(ABORT, 'notification write refused'); END;
    CREATE TRIGGER refuse_notification_update BEFORE UPDATE ON globals WHEN NEW.key = 'notifications'
      BEGIN SELECT RAISE(ABORT, 'notification write refused'); END;
  `);
  raw.close();

  const added = store.addComment(slug, ticket.id, { by: 'tester', source: 'mcp', body: 'kept despite the refused notification' });

  assert.equal(added.ok, true);
  const comments = store.getTicket(slug, ticket.id).comments.map((comment: { body: string }) => comment.body);
  assert.ok(comments.includes('kept despite the refused notification'), 'the ticket event committed');
  assert.equal(store.listNotifications({}).some((notification: Notification) => notification.kind === 'comment'), false);
}));

test('opening a store with an oversized legacy notifications row prunes it to the newest under the cap', () => withFreshHome((home) => {
  const seeds = unreadNotifications(7000);
  writeNotificationsRow(home, seeds);

  store.listNotifications({});

  assert.deepEqual(storedNotificationIds(home), seeds.slice(-200).map((seed) => seed.id));
}));

test('a store already pruned on open is not pruned again by later opens', () => withFreshHome((home) => {
  const seeds = unreadNotifications(300);
  writeNotificationsRow(home, seeds, { 'notifications-pruned-on-open': { at: new Date().toISOString() } });

  store.listNotifications({});

  assert.equal(storedNotificationIds(home).length, 300);
}));
