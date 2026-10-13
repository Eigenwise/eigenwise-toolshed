"use strict";
function createNotifications(dependencies) {
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
    writeGlobal
  } = dependencies;
  const NOTIFICATION_KINDS = ["comment", "created", "status", "reminder"];
  const NOTIFY_PREF_DEFAULTS = { comment: true, created: true, status: true };
  const MAX_READ_KEPT = 100;
  const DAY_MS = 24 * 60 * 60 * 1e3;
  const PRUNED_ON_OPEN_KEY = "notifications-pruned-on-open";
  function notificationsLockPath() {
    return path.join(projectsRoot(), ".notifications.lock");
  }
  function newNotificationId() {
    return "nt_" + Date.now().toString(36) + "_" + crypto.randomBytes(3).toString("hex");
  }
  function readNotifications() {
    const data = readGlobal("notifications", null);
    return data && Array.isArray(data.notifications) ? data.notifications : [];
  }
  function writeNotifications(list) {
    writeGlobal("notifications", { notifications: boundUnreadList(list) });
  }
  function positiveNumberFromEnv(name, fallback) {
    const value = Number(process.env[name]);
    return value > 0 ? value : fallback;
  }
  function notificationTime(notification) {
    return String(notification.fireAt || notification.createdAt || "");
  }
  function boundUnreadList(list) {
    const maxUnread = positiveNumberFromEnv("SIDEQUEST_NOTIFICATIONS_MAX_UNREAD", 200);
    const maxAgeDays = positiveNumberFromEnv("SIDEQUEST_NOTIFICATIONS_MAX_AGE_DAYS", 30);
    const oldestKept = new Date(Date.now() - maxAgeDays * DAY_MS).toISOString();
    const keptUnread = list.filter((n) => !n.readAt).filter((n) => notificationTime(n) >= oldestKept).sort((a, b) => notificationTime(b).localeCompare(notificationTime(a))).slice(0, maxUnread);
    const kept = /* @__PURE__ */ new Set([...list.filter((n) => n.readAt), ...keptUnread]);
    return list.filter((n) => kept.has(n));
  }
  function pruneOversizedNotificationsOnce() {
    if (readGlobal(PRUNED_ON_OPEN_KEY, null)) return;
    transaction(() => {
      writeNotifications(readNotifications());
      writeGlobal(PRUNED_ON_OPEN_KEY, { at: (/* @__PURE__ */ new Date()).toISOString() });
    });
  }
  function withNotificationsLock(fn) {
    const lock = notificationsLockPath();
    const locked = acquireLock(lock);
    try {
      return transaction(fn);
    } finally {
      if (locked) releaseLock(lock, locked);
    }
  }
  function pruneReadList(list) {
    const read = list.filter((n) => n.readAt);
    if (read.length <= MAX_READ_KEPT) return list;
    read.sort((a, b) => String(b.readAt).localeCompare(String(a.readAt)));
    const dropIds = new Set(read.slice(MAX_READ_KEPT).map((n) => n.id));
    return list.filter((n) => !dropIds.has(n.id));
  }
  function listNotifications(opts) {
    opts = opts || {};
    const now = Date.now();
    let list = readNotifications();
    if (opts.projectSlug) list = list.filter((n) => n.projectSlug === opts.projectSlug);
    if (opts.kind) list = list.filter((n) => n.kind === opts.kind);
    if (opts.unreadOnly) list = list.filter((n) => !n.readAt);
    if (!opts.includePending) {
      list = list.filter((n) => !(n.fireAt && Number.isFinite(Date.parse(n.fireAt)) && Date.parse(n.fireAt) > now));
    }
    list.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    if (opts.limit != null && Number.isFinite(Number(opts.limit))) list = list.slice(0, Number(opts.limit));
    return list;
  }
  function addNotification(fields) {
    fields = fields || {};
    const kind = NOTIFICATION_KINDS.indexOf(String(fields.kind)) !== -1 ? String(fields.kind) : "comment";
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const notification = {
      id: newNotificationId(),
      kind,
      title: String(fields.title || "").slice(0, 300),
      body: String(fields.body || "").slice(0, 4e3),
      projectSlug: fields.projectSlug ? String(fields.projectSlug) : null,
      ticketRef: fields.ticketRef ? String(fields.ticketRef) : null,
      ticketId: fields.ticketId ? String(fields.ticketId) : null,
      createdAt: now,
      readAt: null,
      fireAt: fields.fireAt ? String(fields.fireAt) : null,
      ticketEventAt: fields.ticketEventAt ? String(fields.ticketEventAt) : null,
      firedAt: null
    };
    return withNotificationsLock(() => {
      const list = readNotifications();
      list.push(notification);
      writeNotifications(pruneReadList(list));
      return notification;
    });
  }
  function getNotifyPrefs() {
    const saved = readGlobal("notify-prefs", null);
    const merged = Object.assign({}, NOTIFY_PREF_DEFAULTS, saved && typeof saved === "object" ? saved : {});
    const out = {};
    for (const k of Object.keys(NOTIFY_PREF_DEFAULTS)) out[k] = merged[k] !== false;
    return out;
  }
  function setNotifyPrefs(patch) {
    const next = Object.assign({}, getNotifyPrefs(), patch || {});
    const out = {};
    for (const k of Object.keys(NOTIFY_PREF_DEFAULTS)) out[k] = next[k] !== false;
    writeGlobal("notify-prefs", out);
    return out;
  }
  function eventNotificationCopy(ticket, kind, extra) {
    extra = extra || {};
    const ref = ticket.ref;
    if (kind === "comment") {
      return { title: `💬 Comment · ${ref}`, body: extra.commentBody ? `${extra.commentBody}  —  ${ticket.title}` : ticket.title };
    }
    if (kind === "created") return { title: `New side quest · ${ref}`, body: ticket.title };
    return { title: `${ref} → ${ticket.status}`, body: ticket.title };
  }
  function eventNotificationWanted(slug, kind, source) {
    if (!source || String(source) === "dashboard") return false;
    return Boolean(getNotifyPrefs()[kind]) && readMeta(slug)?.notify !== false;
  }
  function ticketEventKey(notification) {
    return `${notification.ticketId}|${notification.kind}|${notification.ticketEventAt}`;
  }
  function saveEventNotification(event) {
    try {
      const duplicate = readNotifications().some((n) => ticketEventKey(n) === ticketEventKey(event));
      if (!duplicate) addNotification(event);
    } catch (error) {
      process.stderr.write(`sidequest: the ${event.kind} notification for ${event.ticketRef} was not saved: ${error}
`);
    }
  }
  function queueEventNotification(slug, ticket, kind, source, extra) {
    if (!ticket || !eventNotificationWanted(slug, kind, source)) return;
    const copy = eventNotificationCopy(ticket, kind, extra);
    const event = {
      kind,
      title: copy.title,
      body: copy.body,
      projectSlug: slug,
      ticketRef: ticket.ref,
      ticketId: ticket.id,
      ticketEventAt: ticket.updatedAt
    };
    afterCommit(() => saveEventNotification(event));
  }
  function markRead(id) {
    return withNotificationsLock(() => {
      const list = readNotifications();
      let updated = null;
      for (const n of list) {
        if (n.id === id) {
          if (!n.readAt) n.readAt = (/* @__PURE__ */ new Date()).toISOString();
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
      const now = (/* @__PURE__ */ new Date()).toISOString();
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
  function dismiss(id) {
    return withNotificationsLock(() => {
      const list = readNotifications();
      const kept = list.filter((n) => n.id !== id);
      if (kept.length === list.length) return false;
      writeNotifications(kept);
      return true;
    });
  }
  function pruneRead() {
    return withNotificationsLock(() => {
      const list = readNotifications();
      const pruned = pruneReadList(list);
      const removed = list.length - pruned.length;
      if (removed) writeNotifications(pruned);
      return removed;
    });
  }
  function pendingReminders() {
    const now = Date.now();
    const map = /* @__PURE__ */ new Map();
    for (const n of readNotifications()) {
      if (n.kind !== "reminder" || !n.ticketId) continue;
      if (!n.fireAt || !Number.isFinite(Date.parse(n.fireAt)) || Date.parse(n.fireAt) <= now) continue;
      const existing = map.get(n.ticketId);
      if (!existing || Date.parse(n.fireAt) < Date.parse(existing.fireAt)) map.set(n.ticketId, n);
    }
    return map;
  }
  function getPendingReminder(ticketId) {
    if (!ticketId) return null;
    return pendingReminders().get(ticketId) || null;
  }
  function setReminder(slug, idOrRef, fireAt) {
    const ticket = getTicket(slug, idOrRef);
    if (!ticket) return { ok: false, reason: "not_found" };
    const when = fireAt ? new Date(String(fireAt)) : null;
    if (!when || Number.isNaN(when.getTime())) return { ok: false, reason: "bad_fireAt" };
    if (when.getTime() <= Date.now()) return { ok: false, reason: "in_past" };
    cancelReminder(slug, ticket.id);
    const notification = addNotification({
      kind: "reminder",
      title: "Reminder: " + ticket.title,
      body: ticket.ref + " — " + ticket.title,
      projectSlug: slug,
      ticketRef: ticket.ref,
      ticketId: ticket.id,
      fireAt: when.toISOString()
    });
    return { ok: true, notification };
  }
  function cancelReminder(slug, idOrRef) {
    const ticket = getTicket(slug, idOrRef);
    if (!ticket) return { ok: false, reason: "not_found" };
    return withNotificationsLock(() => {
      const list = readNotifications();
      const now = Date.now();
      let removed = 0;
      const kept = list.filter((n) => {
        const pending = n.kind === "reminder" && n.ticketId === ticket.id && n.fireAt && Number.isFinite(Date.parse(n.fireAt)) && Date.parse(n.fireAt) > now;
        if (pending) {
          removed++;
          return false;
        }
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
        if (n.kind !== "reminder" || n.firedAt) continue;
        if (!n.fireAt || !Number.isFinite(Date.parse(n.fireAt)) || Date.parse(n.fireAt) > now) continue;
        n.firedAt = (/* @__PURE__ */ new Date()).toISOString();
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
    pruneOversizedNotificationsOnce,
    pruneRead,
    queueEventNotification,
    setNotifyPrefs,
    setReminder
  };
}
module.exports = { createNotifications };
