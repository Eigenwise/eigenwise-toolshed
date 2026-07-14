'use strict';
/**
 * sidequest - dashboard server
 *
 * A tiny, dependency-free HTTP server (Node stdlib only) that:
 *   - serves the single-file dashboard UI, and
 *   - exposes a small JSON API over the shared store.
 *
 * It binds to 127.0.0.1 only: the board is a local, internal tool and is never
 * exposed to the network. It picks the first free port at/after the requested
 * one and records { port, pid, url } in the store's server.json so the CLI can
 * find and reuse a running instance instead of starting a second one.
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const url = require('url');
const { spawn, spawnSync } = require('child_process');
const store = require('./store');
const agentsync = require('./agentsync');

const DASHBOARD_HTML = path.join(__dirname, '..', 'dashboard', 'index.html');

// The installed plugin version, stamped into the health payload and the
// server lockfile so a caller can tell "this running process is on-disk-code"
// apart from "this running process predates the last plugin update" (see
// SQ-92: a long-lived server keeps whatever routing logic was compiled in at
// its own startup — require() never re-reads a changed file for a process
// that's still alive). Missing/unreadable is fine; it just disables the
// staleness check on the CLI side.
let PLUGIN_VERSION = null;
try {
  PLUGIN_VERSION = require('../.claude-plugin/plugin.json').version || null;
} catch (_) {
  /* best effort */
}

const CONTENT_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const START_TIME = new Date().toISOString();

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, code, text, type) {
  res.writeHead(code, { 'Content-Type': type || 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > (limitBytes || 25 * 1024 * 1024)) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const raw = await readBody(req);
  if (!raw.length) return {};
  const parsed = JSON.parse(raw.toString('utf8'));
  // A body of "null"/"42"/"\"x\"" parses without throwing but isn't an object —
  // callers do body.foo unconditionally, so coerce here instead of 500ing.
  return parsed && typeof parsed === 'object' ? parsed : {};
}

/* ------------------------------------------------------------------ *
 *  Aggregate ticket listing (used by the "All projects" view)
 * ------------------------------------------------------------------ */

function aggregateTickets(archivedOnly) {
  const projects = store.listProjects();
  const out = [];
  for (const p of projects) {
    for (const t of store.listTickets(p.slug)) {
      if (archivedOnly ? !t.archived : t.archived) continue;
      out.push(Object.assign({}, t, { project: p.slug, projectName: p.name }));
    }
  }
  return out;
}

// Stories for one project, each annotated with how many (non-archived) tickets
// belong to it and which board it lives on — the shape the dashboard's story
// legend/filter and the "All boards" aggregate consume.
function storiesWithCounts(slug) {
  const counts = {};
  for (const t of store.listTickets(slug)) {
    if (t.archived || !t.storyId) continue;
    counts[t.storyId] = (counts[t.storyId] || 0) + 1;
  }
  const meta = store.readMeta(slug);
  return store.listStories(slug).map((s) =>
    Object.assign({}, s, { projectSlug: slug, projectName: meta ? meta.name : slug, ticketCount: counts[s.id] || 0 })
  );
}

// Stamp each ticket with its pending reminder (or null), computed from one
// read of the notifications file rather than one per ticket. The reminder
// itself lives in the notifications store, not the ticket file, so this is
// purely a response-shape convenience for the dashboard's "bell in 1h" chip.
function annotateReminders(tickets) {
  const map = store.pendingReminders();
  for (const t of tickets) t.reminder = map.get(t.id) || null;
  return tickets;
}

/* ------------------------------------------------------------------ *
 *  Routing
 * ------------------------------------------------------------------ */

async function handle(req, res) {
  const parsed = url.parse(req.url, true);
  const pathname = decodeURIComponent(parsed.pathname);
  const q = parsed.query || {};

  // --- Static: dashboard ---
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    fs.readFile(DASHBOARD_HTML, (err, data) => {
      if (err) {
        sendText(res, 500, 'sidequest dashboard file is missing. Reinstall the plugin.', 'text/plain; charset=utf-8');
        return;
      }
      sendText(res, 200, data, 'text/html; charset=utf-8');
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }

  // --- Health / handshake ---
  if (req.method === 'GET' && pathname === '/api/health') {
    sendJson(res, 200, { ok: true, name: 'sidequest', pid: process.pid, startedAt: START_TIME, version: PLUGIN_VERSION });
    return;
  }

  // --- Projects ---
  if (req.method === 'GET' && pathname === '/api/projects') {
    sendJson(res, 200, { projects: store.listProjects() });
    return;
  }

  // --- Archived boards ---
  if (req.method === 'GET' && pathname === '/api/projects/archived') {
    sendJson(res, 200, { projects: store.listProjects({ archived: true }) });
    return;
  }

  // Board archive is reversible; permanent deletion accepts only an exact slug.
  const projectAction = /^\/api\/projects\/([^/]+)\/(archive|unarchive)$/.exec(pathname);
  if (req.method === 'POST' && projectAction) {
    const result = projectAction[2] === 'archive'
      ? store.archiveProject(projectAction[1])
      : store.unarchiveProject(projectAction[1]);
    sendJson(res, result.ok ? 200 : 404, result);
    return;
  }
  const projectDelete = /^\/api\/projects\/([^/]+)$/.exec(pathname);
  if (req.method === 'DELETE' && projectDelete) {
    const result = store.deleteProjectExact(projectDelete[1]);
    sendJson(res, result.ok ? 200 : 404, result);
    return;
  }

  // --- Per-project notification switch (/api/projects/:slug/notify) ---
  const pn = /^\/api\/projects\/([^/]+)\/notify$/.exec(pathname);
  if ((req.method === 'POST' || req.method === 'PUT') && pn) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      sendJson(res, 400, { error: 'bad JSON body' });
      return;
    }
    const result = store.setProjectNotify(pn[1], body.on);
    sendJson(res, result.ok ? 200 : 404, result);
    return;
  }

  // --- Stories: list (?project=slug|all) ---
  if (req.method === 'GET' && pathname === '/api/stories') {
    const project = q.project ? String(q.project) : 'all';
    if (project === 'all' || project === '') {
      const out = [];
      for (const p of store.listProjects()) out.push(...storiesWithCounts(p.slug));
      sendJson(res, 200, { project: 'all', stories: out });
    } else {
      if (!store.readMeta(project)) {
        sendJson(res, 404, { error: 'unknown project' });
        return;
      }
      sendJson(res, 200, { project, stories: storiesWithCounts(project) });
    }
    return;
  }

  // --- Stories: create ---
  if (req.method === 'POST' && pathname === '/api/stories') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      sendJson(res, 400, { error: 'bad JSON body' });
      return;
    }
    let slug = body.project && String(body.project);
    if ((!slug || slug === 'all') && body.projectPath) {
      slug = store.ensureProject(body.projectPath, body.projectName).slug;
    }
    if (!slug || slug === 'all') {
      sendJson(res, 400, { error: 'a project is required to create a story' });
      return;
    }
    if (!store.readMeta(slug)) {
      sendJson(res, 404, { error: 'unknown project' });
      return;
    }
    const story = store.createStory(slug, { title: body.title, description: body.description, color: body.color });
    sendJson(res, 201, { story });
    return;
  }

  // --- Stories: update / delete (/api/stories/:id) ---
  const sm = /^\/api\/stories\/([^/]+)$/.exec(pathname);
  if (sm) {
    const idOrRef = sm[1];
    const slug = q.project ? String(q.project) : null;
    if (!slug || slug === 'all') {
      sendJson(res, 400, { error: 'project query param is required' });
      return;
    }
    if (req.method === 'PATCH' || req.method === 'PUT') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (e) {
        sendJson(res, 400, { error: 'bad JSON body' });
        return;
      }
      const updated = store.updateStory(slug, idOrRef, body);
      if (!updated) {
        sendJson(res, 404, { error: 'story not found' });
        return;
      }
      sendJson(res, 200, { story: updated });
      return;
    }
    if (req.method === 'DELETE') {
      const ok = store.deleteStory(slug, idOrRef);
      sendJson(res, ok ? 200 : 404, { ok });
      return;
    }
  }

  // --- Tickets: list ---
  if (req.method === 'GET' && pathname === '/api/tickets') {
    const project = q.project ? String(q.project) : 'all';
    // Board shows active tickets; ?archived=1 returns the archive instead.
    const archivedOnly = q.archived === '1' || q.archived === 'true';
    if (project === 'all' || project === '') {
      sendJson(res, 200, { project: 'all', archived: archivedOnly, tickets: annotateReminders(aggregateTickets(archivedOnly)) });
    } else {
      const meta = store.readMeta(project);
      if (!meta) {
        sendJson(res, 404, { error: 'unknown project' });
        return;
      }
      const tickets = store.listTickets(project).filter((t) => (archivedOnly ? t.archived : !t.archived));
      sendJson(res, 200, { project, archived: archivedOnly, tickets: annotateReminders(tickets) });
    }
    return;
  }

  // --- Tickets: create ---
  if (req.method === 'POST' && pathname === '/api/tickets') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      sendJson(res, 400, { error: 'bad JSON body' });
      return;
    }
    let slug = body.project && String(body.project);
    if ((!slug || slug === 'all') && body.projectPath) {
      slug = store.ensureProject(body.projectPath, body.projectName).slug;
    }
    if (!slug || slug === 'all') {
      sendJson(res, 400, { error: 'a project is required to create a ticket' });
      return;
    }
    if (!store.readMeta(slug)) {
      sendJson(res, 404, { error: 'unknown project' });
      return;
    }
    // Model and effort are mandatory at every entry point — sidequest never
    // defaults either; the filing side judges the task's complexity and picks.
    // (PATCH stays permissive: the store guard ignores invalid values there.)
    if (!store.coerceComplexity(body.complexity)) {
      sendJson(res, 400, { error: 'complexity is required (an integer 1-10; routing is derived from it)' });
      return;
    }
    if (!body.complexityWhy || String(body.complexityWhy).trim().length < 20) {
      sendJson(res, 400, { error: 'complexityWhy is required — motivate the score against the actual task (min 20 chars)' });
      return;
    }
    const ticket = store.createTicket(slug, {
      title: body.title,
      description: body.description,
      status: body.status,
      priority: body.priority,
      labels: body.labels,
      storyId: body.storyId,
      complexity: body.complexity,
      complexityWhy: body.complexityWhy,
      files: body.files,
      executorAnchors: body.executorAnchors,
      executorVerify: body.executorVerify,
      assignee: body.assignee,
      imagesData: body.imagesData,
      source: 'dashboard',
    });
    // Re-read so the response carries the derived model/effort (derivation is
    // read-time; createTicket returns the raw stored shape).
    const created = store.getTicket(slug, ticket.id) || ticket;
    sendJson(res, 201, { ticket: created, warnings: store.ticketPlanningWarnings(created) });
    return;
  }

  // --- Tickets: update / delete (/api/tickets/:id) ---
  const m = /^\/api\/tickets\/([^/]+)$/.exec(pathname);
  if (m) {
    const idOrRef = m[1];
    const slug = q.project ? String(q.project) : null;
    if (!slug || slug === 'all') {
      sendJson(res, 400, { error: 'project query param is required' });
      return;
    }
    if (req.method === 'PATCH' || req.method === 'PUT') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (e) {
        sendJson(res, 400, { error: 'bad JSON body' });
        return;
      }
      // Force the source: a change through the dashboard API is a user action,
      // so it must never trigger a "Claude changed it" notification. The body is
      // passed through wholesale, so a completing client can ride a `workedBy`
      // provenance stamp along the same patch; the store validates it permissively
      // and the returned payload carries workedBy like every other ticket field.
      const updated = store.updateTicket(slug, idOrRef, Object.assign({}, body, { source: 'dashboard' }));
      if (!updated) {
        sendJson(res, 404, { error: 'ticket not found' });
        return;
      }
      updated.reminder = store.getPendingReminder(updated.id);
      sendJson(res, 200, { ticket: updated, warnings: store.ticketPlanningWarnings(updated) });
      return;
    }
    if (req.method === 'DELETE') {
      const ok = store.deleteTicket(slug, idOrRef);
      sendJson(res, ok ? 200 : 404, { ok });
      return;
    }
  }

  // --- Tickets: add a comment (/api/tickets/:id/comment) ---
  const cm = /^\/api\/tickets\/([^/]+)\/comment$/.exec(pathname);
  if (req.method === 'POST' && cm) {
    const slug = q.project ? String(q.project) : null;
    if (!slug || slug === 'all') {
      sendJson(res, 400, { error: 'project query param is required' });
      return;
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      sendJson(res, 400, { error: 'bad JSON body' });
      return;
    }
    // A comment posted through the dashboard is the user's own; source "dashboard"
    // so it doesn't notify them about their own message.
    const result = store.addComment(slug, cm[1], { by: body.by || 'you', body: body.body, kind: body.kind, source: 'dashboard' });
    if (!result.ok) {
      const payload = { error: result.reason };
      if (result.reason === 'too_long') { payload.max = result.max; payload.length = result.length; }
      sendJson(res, result.reason === 'not_found' ? 404 : 400, payload);
      return;
    }
    sendJson(res, 201, result);
    return;
  }

  // --- Tickets: reminder (/api/tickets/:id/reminder) ---
  const rm = /^\/api\/tickets\/([^/]+)\/reminder$/.exec(pathname);
  if (rm) {
    const slug = q.project ? String(q.project) : null;
    if (!slug || slug === 'all') {
      sendJson(res, 400, { error: 'project query param is required' });
      return;
    }
    if (req.method === 'POST') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (e) {
        sendJson(res, 400, { error: 'bad JSON body' });
        return;
      }
      const result = store.setReminder(slug, rm[1], body.fireAt);
      if (!result.ok) {
        sendJson(res, result.reason === 'not_found' ? 404 : 400, { error: result.reason });
        return;
      }
      sendJson(res, 201, result);
      return;
    }
    if (req.method === 'DELETE') {
      const result = store.cancelReminder(slug, rm[1]);
      sendJson(res, result.ok ? 200 : 404, result);
      return;
    }
  }

  // --- Tickets: link (/api/tickets/:id/link) ---
  const lk = /^\/api\/tickets\/([^/]+)\/link$/.exec(pathname);
  if (req.method === 'POST' && lk) {
    const slug = q.project ? String(q.project) : null;
    if (!slug || slug === 'all') {
      sendJson(res, 400, { error: 'project query param is required' });
      return;
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      sendJson(res, 400, { error: 'bad JSON body' });
      return;
    }
    const result = store.linkTickets(slug, lk[1], body.verb, body.to);
    sendJson(res, result.ok ? 200 : 400, result);
    return;
  }

  // --- Tickets: unlink (/api/tickets/:id/link/:other) ---
  const ulk = /^\/api\/tickets\/([^/]+)\/link\/([^/]+)$/.exec(pathname);
  if (req.method === 'DELETE' && ulk) {
    const slug = q.project ? String(q.project) : null;
    if (!slug || slug === 'all') {
      sendJson(res, 400, { error: 'project query param is required' });
      return;
    }
    const result = store.unlinkTickets(slug, ulk[1], ulk[2]);
    sendJson(res, result.ok ? 200 : 404, result);
    return;
  }

  // --- Tickets: archive / unarchive (/api/tickets/:id/archive|unarchive) ---
  const ar = /^\/api\/tickets\/([^/]+)\/(archive|unarchive)$/.exec(pathname);
  if (req.method === 'POST' && ar) {
    const slug = q.project ? String(q.project) : null;
    if (!slug || slug === 'all') {
      sendJson(res, 400, { error: 'project query param is required' });
      return;
    }
    const fn = ar[2] === 'archive' ? store.archiveTicket : store.unarchiveTicket;
    const result = fn(slug, ar[1], { source: 'dashboard' });
    sendJson(res, result.ok ? 200 : 404, result);
    return;
  }

  // --- Archive all done in a project (/api/archive-done) ---
  if (req.method === 'POST' && pathname === '/api/archive-done') {
    const slug = q.project ? String(q.project) : 'all';
    if (slug === 'all') {
      // Archive done across every project.
      const all = [];
      for (const p of store.listProjects()) all.push(...store.archiveAllDone(p.slug, { source: 'dashboard' }).archived);
      sendJson(res, 200, { ok: true, archived: all });
      return;
    }
    if (!store.readMeta(slug)) {
      sendJson(res, 404, { error: 'unknown project' });
      return;
    }
    sendJson(res, 200, store.archiveAllDone(slug, { source: 'dashboard' }));
    return;
  }

  // --- Notifications: list (?project=slug&unread=1&kind=&limit=) ---
  if (req.method === 'GET' && pathname === '/api/notifications') {
    const opts = {};
    if (q.project && q.project !== 'all') opts.projectSlug = String(q.project);
    if (q.kind) opts.kind = String(q.kind);
    if (q.unread === '1' || q.unread === 'true') opts.unreadOnly = true;
    if (q.includePending === '1' || q.includePending === 'true') opts.includePending = true;
    if (q.limit) opts.limit = Number(q.limit);
    const notifications = store.listNotifications(opts);
    // Unread counts are computed server-wide (kind-agnostic, no limit) so the bell
    // badge, its "question" urgency cue, and the inbox category tabs stay correct
    // even when the newest-N page the client holds doesn't include an older unread
    // question — otherwise a blocking question aged past the page would read as
    // routine. "Needs you" = questions + due reminders; the rest is activity.
    const unreadList = store.listNotifications(Object.assign({}, opts, { unreadOnly: true, kind: undefined, limit: undefined }));
    const unread = unreadList.length;
    const unreadQuestions = unreadList.filter((n) => n.kind === 'question').length;
    const unreadNeeds = unreadList.filter((n) => n.kind === 'question' || n.kind === 'reminder').length;
    sendJson(res, 200, { notifications, unread, unreadQuestions, unreadNeeds });
    return;
  }

  // --- Notifications: mark read ({ id } or { all: true }) ---
  if (req.method === 'POST' && pathname === '/api/notifications/read') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      sendJson(res, 400, { error: 'bad JSON body' });
      return;
    }
    if (body.all) {
      const count = store.markAllRead();
      sendJson(res, 200, { ok: true, count });
      return;
    }
    if (!body.id) {
      sendJson(res, 400, { error: 'id or all is required' });
      return;
    }
    const updated = store.markRead(String(body.id));
    if (!updated) {
      sendJson(res, 404, { error: 'notification not found' });
      return;
    }
    sendJson(res, 200, { ok: true, notification: updated });
    return;
  }

  // --- Notifications: dismiss (/api/notifications/:id) ---
  const nm = /^\/api\/notifications\/([^/]+)$/.exec(pathname);
  if (req.method === 'DELETE' && nm) {
    const ok = store.dismiss(nm[1]);
    sendJson(res, ok ? 200 : 404, { ok });
    return;
  }

  // --- Notify prefs: which background-event kinds get queued as notifications
  // (question/comment/created/status). Kept server-side (not just the
  // dashboard's localStorage) so the queue can honor an opt-out even with no
  // dashboard tab open — see store.queueEventNotification(). ---
  if (req.method === 'GET' && pathname === '/api/notify-prefs') {
    sendJson(res, 200, { prefs: store.getNotifyPrefs() });
    return;
  }
  if ((req.method === 'PUT' || req.method === 'POST') && pathname === '/api/notify-prefs') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      sendJson(res, 400, { error: 'bad JSON body' });
      return;
    }
    sendJson(res, 200, { prefs: store.setNotifyPrefs(body) });
    return;
  }

  // --- Model prefs: which agent tiers the user wants offered (allowlist over
  // opus/sonnet/haiku/fable). Read by the dashboard's Model picker and by the
  // orchestrator (via the CLI) when choosing an executor tier. ---
  if (req.method === 'GET' && pathname === '/api/model-prefs') {
    sendJson(res, 200, { prefs: store.getModelPrefs() });
    return;
  }

  // --- Routing ladder: the live complexity(1-10) -> model·effort mapping,
  // derived from the enabled tiers. The dashboard renders it in the ticket
  // editor (derived-routing line) and the settings popover. ---
  if (req.method === 'GET' && pathname === '/api/routing-ladder') {
    sendJson(res, 200, { ladder: store.routingLadder(), prefs: store.getModelPrefs() });
    return;
  }
  if ((req.method === 'PUT' || req.method === 'POST') && pathname === '/api/model-prefs') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      sendJson(res, 400, { error: 'bad JSON body' });
      return;
    }
    const prefs = store.setModelPrefs(body);
    // Keep the runtime sidequest-exec-<slug>-<effort>.md agent files (SQ-158)
    // in sync with whatever custom models are now enabled. Fail-soft: a sync
    // problem (e.g. an unwritable agents dir) must never block saving prefs.
    let agentSync = null;
    let message;
    try {
      agentSync = agentsync.syncExecAgents(prefs);
      const changed = agentSync.written + agentSync.removed;
      if (changed > 0) {
        message = `${changed} exec agent file(s) changed (${agentSync.written} written, ${agentSync.removed} removed) — ${agentsync.RESTART_NOTICE}`;
      }
    } catch (e) {
      agentSync = { error: (e && e.message) || String(e) };
    }
    sendJson(res, 200, Object.assign({ prefs, agentSync }, message ? { message } : {}));
    return;
  }

  // --- Assets: /api/asset/:slug/:id/:filename ---
  const am = /^\/api\/asset\/([^/]+)\/([^/]+)\/(.+)$/.exec(pathname);
  if (req.method === 'GET' && am) {
    const [, slug, id, filename] = am;
    const file = store.assetPath(slug, id, filename);
    fs.readFile(file, (err, data) => {
      if (err) {
        sendText(res, 404, 'not found');
        return;
      }
      const type = CONTENT_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Content-Length': data.length });
      res.end(data);
    });
    return;
  }

  sendJson(res, 404, { error: 'not found' });
}

/* ------------------------------------------------------------------ *
 *  Reminder scheduler
 *
 *  Reminders already surface themselves: listNotifications() treats a
 *  reminder's fireAt as a live/pending switch evaluated fresh on every read,
 *  so a poll from the dashboard after fireAt has passed shows it unread with
 *  no help from the server. What a poll alone *can't* do is fire while nobody
 *  is polling (dashboard closed, tab backgrounded past its throttled timer).
 *  This tick exists for that gap: a small idempotent sweep, run on its own
 *  timer independent of any client, that stamps reminders as fired the moment
 *  their time comes due. It reads the persisted fireAt fresh each time, so a
 *  restart never loses a scheduled reminder — the very first tick after boot
 *  catches anything that came due while the process was down.
 * ------------------------------------------------------------------ */

const REMINDER_TICK_MS = 15 * 1000;

function startReminderScheduler() {
  const tick = () => {
    try {
      store.fireDueReminders();
    } catch (_) {
      /* best effort — never let a scheduler hiccup take the server down */
    }
  };
  tick(); // catch anything that fired while the server was down
  return setInterval(tick, REMINDER_TICK_MS);
}

/* ------------------------------------------------------------------ *
 *  Hot reload: self-recycle to a newer installed plugin version
 *
 *  A long-lived dashboard server keeps whatever code was require()'d at its
 *  own startup — a plugin update on disk never takes effect for a process
 *  that's still alive (see SQ-92, PLUGIN_VERSION above). Rather than make
 *  the user remember to restart it, the server polls for a strictly-newer
 *  sibling install on a timer and hands its port off: spawn the newer
 *  version's `serve`, then free our own port so the successor binds the
 *  SAME port deterministically (no surprise URL for an open browser tab).
 * ------------------------------------------------------------------ */

const VERSION_WATCH_MS = Number(process.env.SIDEQUEST_VERSION_WATCH_MS) || 20 * 1000;
const CLEAN_SEMVER_RE = /^\d+\.\d+\.\d+$/;

// Runs the handoff at most once per process — a second tick firing mid-spawn
// (or after a failed spawn already reset it) must not race a second child.
let recycling = false;

// Pure: pick the highest sibling install strictly newer than selfVersion,
// with a runnable bin, that is a clean (non-prerelease) semver. Never
// auto-hops to a prerelease, and returns null when the newest install is
// already selfVersion or older — so a fully-updated fleet never loops.
// Exported so ladder-style tests can hit it directly (see test/server.test.js).
function pickNewerInstall(entries, selfVersion) {
  if (!Array.isArray(entries) || typeof selfVersion !== 'string' || !CLEAN_SEMVER_RE.test(selfVersion)) return null;
  const self = selfVersion.split('.').map(Number);
  let best = null; // { name, parts }
  for (const entry of entries) {
    if (!entry || entry.hasBin !== true) continue;
    const version = entry.version;
    if (typeof version !== 'string' || !CLEAN_SEMVER_RE.test(version)) continue;
    const parts = version.split('.').map(Number);
    let cmp = 0;
    for (let i = 0; i < 3 && cmp === 0; i++) cmp = parts[i] - self[i];
    if (cmp <= 0) continue; // strictly greater than self only
    if (!best) {
      best = { name: entry.name, parts };
      continue;
    }
    let cmpBest = 0;
    for (let i = 0; i < 3 && cmpBest === 0; i++) cmpBest = parts[i] - best.parts[i];
    if (cmpBest > 0) best = { name: entry.name, parts };
  }
  return best ? best.name : null;
}

// Best-effort FS wrapper: look at sibling install dirs next to this plugin's
// own version dir and return the absolute path to a newer install's
// bin/sidequest.js, or null if there is none (or recycling is disabled/unsafe
// for this process). Wrapped so any readdir/fs surprise degrades to "no
// newer install" rather than taking the server down.
function findNewerInstall() {
  try {
    const selfRoot = path.resolve(__dirname, '..');
    const parent = path.dirname(selfRoot);
    const selfName = path.basename(selfRoot);
    // Repo-source checkouts (basename e.g. "sidequest", not a version dir)
    // must never self-recycle — there's no "sibling install" concept there.
    if (!CLEAN_SEMVER_RE.test(selfName)) return null;
    // Tests and the isolated verify-server opt out explicitly.
    if (process.env.SIDEQUEST_NO_HOT_RECYCLE) return null;
    const names = fs.readdirSync(parent);
    const entries = names.map((name) => {
      const dir = path.join(parent, name);
      const hasBin =
        fs.existsSync(path.join(dir, 'bin', 'sidequest.js')) &&
        fs.existsSync(path.join(dir, '.claude-plugin', 'plugin.json'));
      return { name, version: name, hasBin };
    });
    const target = pickNewerInstall(entries, selfName);
    return target ? path.join(parent, target, 'bin', 'sidequest.js') : null;
  } catch (_) {
    return null; // best effort — an unreadable install list just disables the check
  }
}

// Confirm that the successor's entrypoint can at least load before we stop
// serving. A half-written or corrupt cached install is the common failed-upgrade
// case; leave the current dashboard alone and retry after the next watch tick.
function canRunInstall(targetBin) {
  try {
    const targetRoot = path.resolve(targetBin, '..', '..');
    for (const file of [targetBin, path.join(targetRoot, 'lib', 'server.js')]) {
      const result = spawnSync(process.execPath, ['--check', file], {
        stdio: 'ignore',
        windowsHide: true,
      });
      if (result.error || result.status !== 0) return false;
    }
    return true;
  } catch (_) {
    return false;
  }
}

// Poll for a newer sibling install and hand the port off exactly once.
// The successor waits for this process rather than reaping it: server.close()
// stops new connections but lets active API requests complete before the old
// process exits. A bad cached install fails the preflight above, so the current
// dashboard keeps serving instead of disappearing mid-upgrade.
// Returns the interval handle so start() can fold it into its cleanup
// alongside the reminder timer.
function startVersionWatch(server, ownPort, reminderTimer) {
  const watchTimer = setInterval(() => {
    try {
      if (recycling) return;
      const targetBin = findNewerInstall();
      if (!targetBin) return;
      if (!canRunInstall(targetBin)) {
        try {
          process.stderr.write(`sidequest: newer install failed preflight (${targetBin}) — keeping the current dashboard\n`);
        } catch (_) {
          /* best effort */
        }
        return;
      }
      recycling = true;
      try {
        process.stderr.write(`sidequest: newer install found (${targetBin}) — handing off port ${ownPort}\n`);
      } catch (_) {
        /* best effort */
      }
      let child;
      try {
        child = spawn(process.execPath, [targetBin, 'serve', '--port', String(ownPort), '--handoff-pid', String(process.pid)], {
          cwd: os.homedir(),
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        });
        child.once('error', () => {
          // Before close() begins, an OS-level spawn failure leaves this server
          // healthy and lets a later watch tick retry the install.
          recycling = false;
        });
        child.unref();
      } catch (_) {
        // A broken/unspawnable newer install must not kill the working dashboard.
        recycling = false;
        return;
      }
      clearInterval(reminderTimer);
      clearInterval(watchTimer);
      server.close(() => {
        try {
          const cur = store.readServerInfo();
          if (cur && cur.pid === process.pid) store.clearServerInfo();
        } catch (_) {
          /* best effort */
        }
        process.exit(0);
      });
    } catch (_) {
      /* fail-soft: a watch hiccup must never take the server down */
    }
  }, VERSION_WATCH_MS);
  watchTimer.unref();
  return watchTimer;
}

/* ------------------------------------------------------------------ *
 *  Listen with automatic free-port selection
 * ------------------------------------------------------------------ */

function listenOn(server, port, host, triesLeft) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener('listening', onListening);
      if (err && err.code === 'EADDRINUSE' && triesLeft > 0) {
        resolve(listenOn(server, port + 1, host, triesLeft - 1));
      } else {
        reject(err);
      }
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve(port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

// Start the dashboard server. Resolves to { port, url } once listening.
async function start(requestedPort) {
  const host = '127.0.0.1';
  const startPort = Number(requestedPort) || Number(process.env.SIDEQUEST_PORT) || 41730;
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      try {
        sendJson(res, 500, { error: String((err && err.message) || err) });
      } catch (_) {
        /* response already sent */
      }
    });
  });
  const port = await listenOn(server, startPort, host, 40);
  const info = { port, pid: process.pid, url: `http://${host}:${port}`, startedAt: START_TIME, version: PLUGIN_VERSION };
  store.writeServerInfo(info);

  const reminderTimer = startReminderScheduler();
  const watchTimer = startVersionWatch(server, port, reminderTimer);

  const cleanup = () => {
    clearInterval(reminderTimer);
    clearInterval(watchTimer);
    const cur = store.readServerInfo();
    if (cur && cur.pid === process.pid) store.clearServerInfo();
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));

  return { server, port, url: info.url };
}

module.exports = { start, pickNewerInstall, findNewerInstall };
