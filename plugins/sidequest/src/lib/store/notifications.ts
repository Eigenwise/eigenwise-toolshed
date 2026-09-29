'use strict';

function createNotifications(dependencies: any) {
  const {
    acquireLock,
    afterCommit,
    crypto,
    getTicket,
    path,
    projectsRoot,
    readGlobal,
    readMeta,
    releaseLock,
    transaction,
    writeGlobal,
  } = dependencies;
  const NOTIFICATION_KINDS = ['comment', 'created', 'status', 'reminder'];
  const NOTIFY_PREF_DEFAULTS: Record<string, boolean> = { comment: true, created: true, status: true };
  const MAX_READ_KEPT = 100;
  // The whole list is one store row that every event rewrites, so an unread backlog that only grows
  // makes each write slower (a 9 MB row with 6,062 unread entries held the write lock for hundreds of ms).
  const DEFAULT_MAX_UNREAD = 200;
  const DEFAULT_UNREAD_MAX_AGE_DAYS = 14;

  function envPositiveInt(name: string, fallback: number) {
    const value = Number(process.env[name]);
    return Number.isInteger(value) && value > 0 ? value : fallback;
  }
  function maxUnread() {
    return envPositiveInt('SIDEQUEST_NOTIFICATIONS_MAX_UNREAD', DEFAULT_MAX_UNREAD);
  }
  function unreadMaxAgeMs() {
    return envPositiveInt('SIDEQUEST_NOTIFICATIONS_UNREAD_MAX_AGE_DAYS', DEFAULT_UNREAD_MAX_AGE_DAYS) * 24 * 60 * 60 * 1000;
  }

  function notificationsLockPath() {
    return path.join(projectsRoot(), '.notifications.lock');
  }

  function newNotificationId() {
    return 'nt_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex');
  }

  function readNotifications() {
    const data = readGlobal('notifications', null);
    return data && Array.isArray(data.notifications) ? data.notifications : [];
  }
  function writeNotifications(list?: any) {
    writeGlobal('notifications', { notifications: list });
  }

  function withNotificationsLock(fn?: any) {
    const lock = notificationsLockPath();
    const locked = acquireLock(lock);
    try {
      return transaction(fn);
    } finally {
      if (locked) releaseLock(lock, locked);
    }
  }

  function pruneReadList(list?: any) {
    const read = list.filter((n?: any) => n.readAt);
    if (read.length <= MAX_READ_KEPT) return list;
    read.sort((a?: any, b?: any) => String(b.readAt).localeCompare(String(a.readAt)));
    const dropIds = new Set(read.slice(MAX_READ_KEPT).map((n?: any) => n.id));
    return list.filter((n?: any) => !dropIds.has(n.id));
  }

  function isPendingReminder(n?: any, now?: any) {
    return n.kind === 'reminder' && !n.firedAt && n.fireAt && Number.isFinite(Date.parse(n.fireAt)) && Date.parse(n.fireAt) > now;
  }

  // A pending reminder is the user's own future intent, so neither the age limit nor the count cap may drop it.
  function pruneUnreadList(list?: any) {
    const now = Date.now();
    const cutoff = now - unreadMaxAgeMs();
    const prunable = (n?: any) => !n.readAt && !isPendingReminder(n, now);
    const fresh = list.filter((n?: any) => !prunable(n) || !(Date.parse(n.createdAt) < cutoff));
    const unread = fresh.filter(prunable);
    const cap = maxUnread();
    if (unread.length <= cap) return fresh.length === list.length ? list : fresh;
    unread.sort((a?: any, b?: any) => String(b.createdAt).localeCompare(String(a.createdAt)));
    const dropIds = new Set(unread.slice(cap).map((n?: any) => n.id));
    return fresh.filter((n?: any) => !dropIds.has(n.id));
  }

  function pruneList(list?: any) {
    return pruneReadList(pruneUnreadList(list));
  }

  function listNotifications(opts?: any) {
    opts = opts || {};
    const now = Date.now();
    let list = readNotifications();
    if (opts.projectSlug) list = list.filter((n?: any) => n.projectSlug === opts.projectSlug);
    if (opts.kind) list = list.filter((n?: any) => n.kind === opts.kind);
    if (opts.unreadOnly) list = list.filter((n?: any) => !n.readAt);
    if (!opts.includePending) {
      list = list.filter((n?: any) => !(n.fireAt && Number.isFinite(Date.parse(n.fireAt)) && Date.parse(n.fireAt) > now));
    }
    list.sort((a?: any, b?: any) => String(b.createdAt).localeCompare(String(a.createdAt)));
    if (opts.limit != null && Number.isFinite(Number(opts.limit))) list = list.slice(0, Number(opts.limit));
    return list;
  }

  function addNotification(fields?: any) {
    return insertNotification(fields, false);
  }

  function insertNotification(fields?: any, skipDuplicateEvent?: any) {
    fields = fields || {};
    const kind = NOTIFICATION_KINDS.indexOf(String(fields.kind)) !== -1 ? String(fields.kind) : 'comment';
    const now = new Date().toISOString();
    const notification = {
      id: newNotificationId(),
      kind,
      title: String(fields.title || '').slice(0, 300),
      body: String(fields.body || '').slice(0, 4000),
      projectSlug: fields.projectSlug ? String(fields.projectSlug) : null,
      ticketRef: fields.ticketRef ? String(fields.ticketRef) : null,
      ticketId: fields.ticketId ? String(fields.ticketId) : null,
      createdAt: now,
      readAt: null,
      fireAt: fields.fireAt ? String(fields.fireAt) : null,
      ticketEventAt: fields.ticketEventAt ? String(fields.ticketEventAt) : null,
      firedAt: null,
    };
    return withNotificationsLock(() => {
      const list = readNotifications();
      if (skipDuplicateEvent && list.some((n?: any) => n.ticketId === notification.ticketId && n.kind === kind && n.ticketEventAt === notification.ticketEventAt)) return null;
      list.push(notification);
      writeNotifications(pruneList(list));
      return notification;
    });
  }

  function getNotifyPrefs() {
    const saved = readGlobal('notify-prefs', null);
    const merged = Object.assign({}, NOTIFY_PREF_DEFAULTS, saved && typeof saved === 'object' ? saved : {});
    const out: Record<string, any> = {};
    for (const k of Object.keys(NOTIFY_PREF_DEFAULTS)) out[k] = merged[k] !== false;
    return out;
  }

  function setNotifyPrefs(patch?: any) {
    const next = Object.assign({}, getNotifyPrefs(), patch || {});
    const out: Record<string, any> = {};
    for (const k of Object.keys(NOTIFY_PREF_DEFAULTS)) out[k] = next[k] !== false;
    writeGlobal('notify-prefs', out);
    return out;
  }

  function eventNotificationCopy(ticket?: any, kind?: any, extra?: any) {
    extra = extra || {};
    const ref = ticket.ref;
    if (kind === 'comment') {
      return { title: `💬 Comment · ${ref}`, body: extra.commentBody ? `${extra.commentBody}  —  ${ticket.title}` : ticket.title };
    }
    if (kind === 'created') return { title: `New side quest · ${ref}`, body: ticket.title };
    return { title: `${ref} → ${ticket.status}`, body: ticket.title };
  }

  function queueEventNotification(slug?: any, ticket?: any, kind?: any, source?: any, extra?: any) {
    if (!ticket || !source || String(source) === 'dashboard') return null;
    if (NOTIFY_PREF_DEFAULTS[kind] == null) return null;
    if (!getNotifyPrefs()[kind]) return null;
    const pmeta = readMeta(slug);
    if (pmeta && pmeta.notify === false) return null;
    // The copy is captured now because the caller keeps mutating its ticket until the transaction closes.
    const copy = eventNotificationCopy(ticket, kind, extra);
    const fields = {
      kind,
      title: copy.title,
      body: copy.body,
      projectSlug: slug,
      ticketRef: ticket.ref,
      ticketId: ticket.id,
      ticketEventAt: ticket.updatedAt,
    };
    // The event write must commit first and never wait on the notifications row, which is far larger than a ticket.
    // A crash between the two loses only the notification.
    afterCommit(() => insertNotification(fields, true));
    return null;
  }

  function markRead(id?: any) {
    return withNotificationsLock(() => {
      const list = readNotifications();
      let updated = null;
      for (const n of list) {
        if (n.id === id) {
          if (!n.readAt) n.readAt = new Date().toISOString();
          updated = n;
          break;
        }
      }
      if (updated) writeNotifications(list);
      return updated;
    });
  }

  function markAllRead() {
    return withNotificationsLock(() => {
      const list = readNotifications();
      const now = new Date().toISOString();
      let count = 0;
      for (const n of list) {
        if (!n.readAt) {
          n.readAt = now;
          count++;
        }
      }
      if (count) writeNotifications(list);
      return count;
    });
  }

  function dismiss(id?: any) {
    return withNotificationsLock(() => {
      const list = readNotifications();
      const kept = list.filter((n?: any) => n.id !== id);
      if (kept.length === list.length) return false;
      writeNotifications(kept);
      return true;
    });
  }

  function pruneRead() {
    return withNotificationsLock(() => {
      const list = readNotifications();
      const pruned = pruneList(list);
      const removed = list.length - pruned.length;
      if (removed) writeNotifications(pruned);
      return removed;
    });
  }

  function pendingReminders() {
    const now = Date.now();
    const map = new Map();
    for (const n of readNotifications()) {
      if (n.kind !== 'reminder' || !n.ticketId) continue;
      if (!n.fireAt || !Number.isFinite(Date.parse(n.fireAt)) || Date.parse(n.fireAt) <= now) continue;
      const existing = map.get(n.ticketId);
      if (!existing || Date.parse(n.fireAt) < Date.parse(existing.fireAt)) map.set(n.ticketId, n);
    }
    return map;
  }

  function getPendingReminder(ticketId?: any) {
    if (!ticketId) return null;
    return pendingReminders().get(ticketId) || null;
  }

  function setReminder(slug?: any, idOrRef?: any, fireAt?: any) {
    const ticket = getTicket(slug, idOrRef);
    if (!ticket) return { ok: false, reason: 'not_found' };
    const when = fireAt ? new Date(String(fireAt)) : null;
    if (!when || Number.isNaN(when.getTime())) return { ok: false, reason: 'bad_fireAt' };
    if (when.getTime() <= Date.now()) return { ok: false, reason: 'in_past' };
    cancelReminder(slug, ticket.id);
    const notification = addNotification({
      kind: 'reminder',
      title: 'Reminder: ' + ticket.title,
      body: ticket.ref + ' — ' + ticket.title,
      projectSlug: slug,
      ticketRef: ticket.ref,
      ticketId: ticket.id,
      fireAt: when.toISOString(),
    });
    return { ok: true, notification };
  }

  function cancelReminder(slug?: any, idOrRef?: any) {
    const ticket = getTicket(slug, idOrRef);
    if (!ticket) return { ok: false, reason: 'not_found' };
    return withNotificationsLock(() => {
      const list = readNotifications();
      const now = Date.now();
      let removed = 0;
      const kept = list.filter((n?: any) => {
        const pending = n.kind === 'reminder' && n.ticketId === ticket.id &&
          n.fireAt && Number.isFinite(Date.parse(n.fireAt)) && Date.parse(n.fireAt) > now;
        if (pending) { removed++; return false; }
        return true;
      });
      if (removed) writeNotifications(kept);
      return { ok: true, removed };
    });
  }

  function fireDueReminders() {
    return withNotificationsLock(() => {
      const list = readNotifications();
      const now = Date.now();
      let fired = 0;
      for (const n of list) {
        if (n.kind !== 'reminder' || n.firedAt) continue;
        if (!n.fireAt || !Number.isFinite(Date.parse(n.fireAt)) || Date.parse(n.fireAt) > now) continue;
        n.firedAt = new Date().toISOString();
        fired++;
      }
      if (fired) writeNotifications(list);
      return fired;
    });
  }

  return {
    NOTIFICATION_KINDS,
    addNotification,
    cancelReminder,
    dismiss,
    fireDueReminders,
    getNotifyPrefs,
    getPendingReminder,
    listNotifications,
    markAllRead,
    markRead,
    pendingReminders,
    pruneRead,
    queueEventNotification,
    setNotifyPrefs,
    setReminder,
  };
}

module.exports = { createNotifications };
