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
const path = require('path');
const url = require('url');
const store = require('./store');

const DASHBOARD_HTML = path.join(__dirname, '..', 'dashboard', 'index.html');

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
    sendJson(res, 200, { ok: true, name: 'sidequest', pid: process.pid, startedAt: START_TIME });
    return;
  }

  // --- Projects ---
  if (req.method === 'GET' && pathname === '/api/projects') {
    sendJson(res, 200, { projects: store.listProjects() });
    return;
  }

  // --- Tickets: list ---
  if (req.method === 'GET' && pathname === '/api/tickets') {
    const project = q.project ? String(q.project) : 'all';
    // Board shows active tickets; ?archived=1 returns the archive instead.
    const archivedOnly = q.archived === '1' || q.archived === 'true';
    if (project === 'all' || project === '') {
      sendJson(res, 200, { project: 'all', archived: archivedOnly, tickets: aggregateTickets(archivedOnly) });
    } else {
      const meta = store.readMeta(project);
      if (!meta) {
        sendJson(res, 404, { error: 'unknown project' });
        return;
      }
      const tickets = store.listTickets(project).filter((t) => (archivedOnly ? t.archived : !t.archived));
      sendJson(res, 200, { project, archived: archivedOnly, tickets });
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
    const ticket = store.createTicket(slug, {
      title: body.title,
      description: body.description,
      status: body.status,
      priority: body.priority,
      labels: body.labels,
      imagesData: body.imagesData,
      source: 'dashboard',
    });
    sendJson(res, 201, { ticket });
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
      // so it must never trigger a "Claude changed it" notification.
      const updated = store.updateTicket(slug, idOrRef, Object.assign({}, body, { source: 'dashboard' }));
      if (!updated) {
        sendJson(res, 404, { error: 'ticket not found' });
        return;
      }
      sendJson(res, 200, { ticket: updated });
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
      sendJson(res, result.reason === 'not_found' ? 404 : 400, { error: result.reason });
      return;
    }
    sendJson(res, 201, result);
    return;
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
  const info = { port, pid: process.pid, url: `http://${host}:${port}`, startedAt: START_TIME };
  store.writeServerInfo(info);

  const cleanup = () => {
    const cur = store.readServerInfo();
    if (cur && cur.pid === process.pid) store.clearServerInfo();
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));

  return { server, port, url: info.url };
}

module.exports = { start };
