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
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const url = require('url');
const { spawn } = require('child_process');
const store = require('./store');

const DASHBOARD_DIST = path.join(__dirname, '..', 'dashboard', 'dist');

// The installed plugin version, stamped into the health payload and the
// server lockfile so a caller can tell "this running process is on-disk-code"
// apart from "this running process predates the last plugin update" (see
// SQ-92: a long-lived server keeps whatever routing logic was compiled in at
// its own startup — require() never re-reads a changed file for a process
// that's still alive). Missing/unreadable is fine; it just disables the
// staleness check on the CLI side.
let PLUGIN_VERSION: string | null = null;
try {
  PLUGIN_VERSION = require('../.claude-plugin/plugin.json').version || null;
} catch (_: any) {
  /* best effort */
}

const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const START_TIME = new Date().toISOString();
const CATEGORY_DRAFT_CLI = process.env.SIDEQUEST_CLAUDE_BIN || 'claude';
const CATEGORY_DRAFT_TIMEOUT_MS = 60 * 1000;
let categoryDraftTimeoutMs = CATEGORY_DRAFT_TIMEOUT_MS;
const CATEGORY_DRAFT_MAX_OUTPUT = 64 * 1024;
let categoryDraftAvailable = false;
let categoryDraftSpawn = spawn;

function probeCategoryDraft() {
  return new Promise<any>((resolve?: any) => {
    let settled = false;
    let child: any;
    const finish = (available?: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(Boolean(available));
    };
    const timeout = setTimeout(() => {
      if (child) child.kill();
      finish(false);
    }, 3000);
    try {
      child = spawn(CATEGORY_DRAFT_CLI, ['--version'], { stdio: 'ignore', windowsHide: true });
      child.once('error', () => finish(false));
      child.once('close', (code?: any) => finish(code === 0));
    } catch (_: any) {
      finish(false);
    }
  });
}

const categoryDraftProbe = probeCategoryDraft().then((available?: any) => {
  categoryDraftAvailable = available;
});

function sendJson(res?: any, code?: any, obj?: any) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res?: any, code?: any, text?: any, type?: any) {
  res.writeHead(code, { 'Content-Type': type || 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

function staticCacheControl(pathname?: any) {
  return pathname.startsWith('/assets/') && /-[a-zA-Z0-9_-]{8,}\.[^/]+$/.test(pathname)
    ? 'public, max-age=31536000, immutable'
    : 'no-store';
}

async function readStaticFile(file?: any) {
  try {
    return await fsp.readFile(file);
  } catch (error: any) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return null;
    throw error;
  }
}

async function serveStatic(pathname?: any, res?: any) {
  if (pathname === '/' || pathname === '/index.html') {
    const shell = await readStaticFile(path.join(DASHBOARD_DIST, 'index.html'));
    if (!shell) {
      sendText(res, 500, 'sidequest dashboard file is missing. Reinstall the plugin.', 'text/plain; charset=utf-8');
      return true;
    }
    sendText(res, 200, shell, 'text/html; charset=utf-8');
    return true;
  }

  const parts = pathname.split('/');
  if (!pathname.startsWith('/') || parts.includes('..') || pathname.includes('\0')) return false;
  const relative = parts.filter(Boolean).join(path.sep);
  if (!relative) return false;
  const file = path.resolve(DASHBOARD_DIST, relative);
  if (file !== DASHBOARD_DIST && !file.startsWith(`${DASHBOARD_DIST}${path.sep}`)) return false;
  const data = await readStaticFile(file);
  if (!data) return false;
  const type = CONTENT_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    'Cache-Control': staticCacheControl(pathname),
    'Content-Length': data.length,
  });
  res.end(data);
  return true;
}

function readBody(req?: any, limitBytes?: any) {
  return new Promise<any>((resolve?: any, reject?: any) => {
    const chunks: any[] = [];
    let size = 0;
    req.on('data', (c?: any) => {
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

async function readJsonBody(req?: any) {
  const raw = await readBody(req);
  if (!raw.length) return {};
  const parsed = JSON.parse(raw.toString('utf8'));
  // A body of "null"/"42"/"\"x\"" parses without throwing but isn't an object —
  // callers do body.foo unconditionally, so coerce here instead of 500ing.
  return parsed && typeof parsed === 'object' ? parsed : {};
}

function categoryDraftPrompt(sentence?: any, project?: any) {
  const catalog = store.modelsPayload(project ? { project, full: true } : { full: true });
  const examples = catalog.categories.slice(0, 4).map((category?: any) => ({ id: category.id, name: category.name, description: category.description, contract: category.contract, route: category.route, fallback: category.fallback }));
  const positioning = 'Haiku is for fast straightforward work; Sonnet for coding and analysis; Opus for complex autonomous work; Fable for the most demanding long-running work. Luna is clear repeatable high-volume work; Terra is the everyday tool-using workhorse; Sol is complex open-ended work.';
  return 'Return strict JSON only, with no markdown. Draft one Sidequest category from the user sentence. The JSON schema is {"id":string,"name":string,"description":string,"contract":string,"route":{"model":string,"effort":string},"fallback":{"model":string,"effort":string}|null}. The id must be lowercase kebab-case or dot-namespaced. The description must classify requested work, not restate a title. The contract is executor instructions. Pick route and optional fallback only from the live catalog.\n\nUser sentence:\n' + JSON.stringify(String(sentence || '').trim()) + '\n\nLive catalog:\n' + JSON.stringify({ models: catalog.models, efforts: catalog.efforts, discovered: catalog.discovered, positioning }) + '\n\nStyle examples:\n' + JSON.stringify(examples);
}

function validateCategoryDraft(raw?: any, project?: any) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Claude returned a non-object draft.');
  const id = String(raw.id || '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(id)) throw new Error('Claude returned an invalid category id.');
  for (const field of ['name', 'description', 'contract']) {
    if (typeof raw[field] !== 'string' || !raw[field].trim()) throw new Error(`Claude omitted ${field}.`);
  }
  const catalog = store.modelsPayload(project ? { project, full: true } : { full: true });
  const isRoute = (route?: any) => route && typeof route === 'object' && !Array.isArray(route) && typeof route.model === 'string' && typeof route.effort === 'string' && catalog.models.includes(route.model) && catalog.efforts.includes(route.effort);
  if (!isRoute(raw.route)) throw new Error('Claude returned a route outside the live catalog.');
  if (raw.fallback !== null && !isRoute(raw.fallback)) throw new Error('Claude returned a fallback outside the live catalog.');
  return { id, name: String(raw.name).trim(), description: String(raw.description).trim(), contract: String(raw.contract).trim(), route: { model: raw.route.model, effort: raw.route.effort }, fallback: raw.fallback === null ? null : { model: raw.fallback.model, effort: raw.fallback.effort } };
}

function parseCategoryDraft(stdout?: any) {
  const text = String(stdout || '').trim();
  const fenced = text.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
  return JSON.parse(fenced ? fenced[1]! : text);
}

function draftCategory(sentence?: any, project?: any) {
  return new Promise<any>((resolve?: any, reject?: any) => {
    let child: any;
    try {
      child = categoryDraftSpawn(CATEGORY_DRAFT_CLI, ['-p', '--model', 'haiku', categoryDraftPrompt(sentence, project)], { windowsHide: true });
    } catch (error: any) {
      reject(error);
      return;
    }
    let stdout = '', stderr = '', finished = false;
    const finish = (error?: any, value?: any) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      if (error) reject(error); else resolve(value);
    };
    const timeout = setTimeout(() => { child.kill(); finish(new Error('Category draft timed out after 60 seconds.')); }, categoryDraftTimeoutMs);
    child.stdout.on('data', (chunk?: any) => { stdout += chunk; if (stdout.length > CATEGORY_DRAFT_MAX_OUTPUT) { child.kill(); finish(new Error('Category draft was too large.')); } });
    child.stderr.on('data', (chunk?: any) => { stderr += chunk; });
    child.once('error', (error?: any) => finish(error));
    child.once('close', (code?: any) => {
      if (code !== 0) { finish(new Error(stderr.trim() || 'Claude could not draft this category.')); return; }
      try { finish(null, validateCategoryDraft(parseCategoryDraft(stdout), project)); } catch (error: any) { finish(error); }
    });
  });
}

function categoryUsageCounts(project?: any) {
  const counts: any = {};
  const projects = project && project !== 'all' ? [{ slug: project }] : store.listProjects();
  for (const entry of projects) {
    for (const ticket of store.listTickets(entry.slug)) {
      const id = ticket.categoryId || (ticket.category && ticket.category.id) || ticket.category;
      if (typeof id === 'string' && id.trim()) counts[id.trim().toLowerCase()] = (counts[id.trim().toLowerCase()] || 0) + 1;
    }
  }
  return counts;
}

function categoriesPayload(project?: any, profileId?: any) {
  const profileScope = profileId ? store.routingProfileDetails(profileId) : null;
  if (profileId && !profileScope) throw new Error(`routing profile "${profileId}" not found`);
  const selected = !profileScope && project && project !== 'all' ? store.projectRoutingProfile(project) : null;
  const profile = profileScope || (selected ? store.routingProfileDetails(selected.profile.id) : store.routingProfileDetails(store.routingProfileSettings().newProjectProfileId));
  const usage = categoryUsageCounts(project);
  const local = selected ? store.getProjectCategories(project) : { rows: [], warnings: [] };
  const localById = new Map<any, any>(local.rows.map((row?: any) => [row.id, row]));
  const baseById = new Map<any, any>((profile?.categories || []).map((category?: any) => [category.id, category]));
  const effectiveById = new Map<any, any>((selected ? store.getCategories({ project, withState: true }) : profile?.categories || []).map((category?: any) => [category.id, category]));
  const ids = new Set([...baseById.keys(), ...localById.keys(), ...effectiveById.keys()]);

  return {
    profile: profile && { id: profile.id, name: profile.name, revision: profile.revision, entryCount: profile.entryCount },
    localChangeCount: local.rows.length,
    warnings: local.warnings,
    categories: [...ids].map((id?: any) => {
      const base = baseById.get(id) || null;
      const layer = localById.get(id) || null;
      const category = effectiveById.get(id) || base || (layer && (layer.kind === 'ADD' || layer.kind === 'DETACH') ? layer.data : null);
      if (!category) return null;
      const resolved = store.resolveCategoryRoute(category);
      const disabled = Boolean(layer && layer.kind === 'DISABLE');
      return Object.assign({}, category, {
        origin: disabled ? 'disabled' : (category.origin || 'profile'),
        usageCount: usage[id] || 0,
        resolved: { model: resolved.model, effort: resolved.effort },
        warnings: resolved.warnings.concat(local.warnings.filter((warning?: any) => warning.id === id)),
        layer: layer && { kind: layer.kind, data: layer.data, base },
        disabled,
      });
    }).filter(Boolean).sort((a?: any, b?: any) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
  };
}

function routingPreview(project?: any, profileId?: any) {
  const selected = store.projectRoutingProfile(project);
  const target = store.routingProfileDetails(profileId);
  if (!selected || !target) throw new Error('A board and target routing profile are required.');
  const current = new Map(store.getCategories({ project, withState: true }).map((category?: any) => [category.id, category]));
  const next = new Map(target.categories.map((category?: any) => [category.id, category]));
  const local = store.getProjectCategories(project);
  const addCollisions: string[] = [];
  const foreignBase: any[] = [];
  for (const row of local.rows) {
    if (row.kind === 'ADD' && next.has(row.id)) addCollisions.push(row.id);
    if (row.baseProfileId && row.baseProfileId !== target.id) foreignBase.push({ id: row.id, baseProfileId: row.baseProfileId, profileId: target.id, kind: row.kind });
    if (row.kind === 'ADD' || row.kind === 'DETACH') next.set(row.id, row.data);
    else if (row.kind === 'OVERRIDE') next.set(row.id, Object.assign({}, next.get(row.id) || row.baseData || {}, row.data, { id: row.id }));
    else if (row.kind === 'DISABLE') next.delete(row.id);
  }
  const currentIds = new Set(current.keys());
  const nextIds = new Set(next.keys());
  const changed = [...nextIds].filter((id) => currentIds.has(id) && JSON.stringify(current.get(id)) !== JSON.stringify(next.get(id)));
  const preparedDispatches = store.listTickets(project).filter((ticket?: any) => ticket.dispatch?.outcome === 'prepared' && ticket.dispatchNonce && !ticket.dispatch?.terminalAt && !ticket.dispatch?.launchedAt && !ticket.dispatch?.boundAt && !ticket.dispatch?.claimedAt).map((ticket?: any) => ({ id: ticket.id, ref: ticket.ref, title: ticket.title }));
  return {
    project,
    from: { id: selected.profile.id, name: selected.profile.name, revision: selected.profile.revision },
    to: { id: target.id, name: target.name, revision: target.revision },
    drift: { changed, missing: [...currentIds].filter((id) => !nextIds.has(id)), added: [...nextIds].filter((id) => !currentIds.has(id)) },
    addCollisions,
    foreignBase,
    preparedDispatches,
  };
}

// Stories for one project, each annotated with how many (non-archived) tickets
// belong to it and which board it lives on — the shape the dashboard's story
// legend/filter and the "All boards" aggregate consume.
function storiesWithCounts(slug?: any) {
  const counts: any = {};
  for (const t of store.listTickets(slug)) {
    if (t.archived || !t.storyId) continue;
    counts[t.storyId] = (counts[t.storyId] || 0) + 1;
  }
  const meta = store.readMeta(slug);
  return store.listStories(slug).map((s?: any) =>
    Object.assign({}, s, { projectSlug: slug, projectName: meta ? meta.name : slug, ticketCount: counts[s.id] || 0 })
  );
}

// Stamp each ticket with its pending reminder (or null), computed from one
// read of the notifications file rather than one per ticket. The reminder
// itself lives in the notifications store, not the ticket file, so this is
// purely a response-shape convenience for the dashboard's "bell in 1h" chip.
function annotateReminders(tickets?: any) {
  const map = store.pendingReminders();
  for (const t of tickets) t.reminder = map.get(t.id) || null;
  return tickets;
}

/* ------------------------------------------------------------------ *
 *  Routing
 * ------------------------------------------------------------------ */

async function handle(req?: any, res?: any) {
  const parsed = url.parse(req.url, true);
  const pathname = decodeURIComponent(parsed.pathname);
  const q = parsed.query || {};

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

  // --- Per-board routing switch (/api/projects/:slug/routing) ---
  const pr = /^\/api\/projects\/([^/]+)\/routing$/.exec(pathname);
  if ((req.method === 'POST' || req.method === 'PUT') && pr) {
    let body: any;
    try {
      body = await readJsonBody(req);
      if (!['enabled', 'disabled'].includes(body.routing)) throw new Error();
    } catch (_: any) {
      sendJson(res, 400, { error: 'routing must be enabled or disabled' });
      return;
    }
    const result = store.setProjectRouting(pr[1], body.routing);
    sendJson(res, result.ok ? 200 : 404, result);
    return;
  }

  // --- Routing profiles and board profile pointers ---
  const projectProfile = /^\/api\/projects\/([^/]+)\/routing-profile$/.exec(pathname);
  if (projectProfile) {
    const project = projectProfile[1];
    if (!store.readMeta(project)) { sendJson(res, 404, { error: 'unknown project' }); return; }
    if (req.method === 'GET') {
      const selected = store.projectRoutingProfile(project);
      sendJson(res, 200, { project, profile: store.routingProfileDetails(selected.profile.id), warnings: selected.warnings });
      return;
    }
    if (req.method === 'PUT' || req.method === 'PATCH') {
      try {
        const body = await readJsonBody(req);
        const result = store.setProjectRoutingProfile(project, body.profileId || body.profile, 'dashboard');
        sendJson(res, 200, { result, profile: store.routingProfileDetails(result.profileId), preview: routingPreview(project, result.profileId) });
      } catch (error: any) { sendJson(res, 400, { error: error.message }); }
      return;
    }
  }
  const projectProfilePreview = /^\/api\/projects\/([^/]+)\/routing-profile\/preview$/.exec(pathname);
  if (req.method === 'GET' && projectProfilePreview) {
    try {
      const profileId = String(q.profile || '');
      sendJson(res, 200, routingPreview(projectProfilePreview[1], profileId));
    } catch (error: any) { sendJson(res, 400, { error: error.message }); }
    return;
  }
  if (req.method === 'GET' && pathname === '/api/routing-profiles') {
    const profiles = store.listRoutingProfiles({ retired: q.retired === 'true' });
    sendJson(res, 200, { profiles, newBoardProfile: store.routingProfileSettings().newProjectProfileId });
    return;
  }
  if (req.method === 'POST' && pathname === '/api/routing-profiles') {
    try {
      const body = await readJsonBody(req);
      const result = store.createRoutingProfile(body.id, body);
      sendJson(res, 201, { result, profile: store.routingProfileDetails(result.id) });
    } catch (error: any) { sendJson(res, 400, { error: error.message }); }
    return;
  }
  if (req.method === 'POST' && pathname === '/api/routing-profiles/repoint') {
    try {
      const body = await readJsonBody(req);
      sendJson(res, 200, { result: store.repointRoutingProfiles(body.from, body.to, { dryRun: body.dryRun === true, assignedBy: 'dashboard' }) });
    } catch (error: any) { sendJson(res, 400, { error: error.message }); }
    return;
  }
  if (req.method === 'POST' && pathname === '/api/routing-profiles/promote') {
    try {
      const body = await readJsonBody(req);
      const result = store.promoteRoutingProfile(body.id, body.fromProject, body.projects, { name: body.name, description: body.description, assignedBy: 'dashboard' });
      sendJson(res, 201, { result, profile: store.routingProfileDetails(result.id) });
    } catch (error: any) { sendJson(res, 400, { error: error.message }); }
    return;
  }
  const routingProfile = /^\/api\/routing-profiles\/([^/]+)$/.exec(pathname);
  if (routingProfile) {
    const id = routingProfile[1];
    if (req.method === 'GET') {
      const profile = store.routingProfileDetails(id);
      if (!profile) { sendJson(res, 404, { error: 'routing profile not found' }); return; }
      const boards = [...store.listProjects(), ...store.listProjects({ archived: true })].filter((project?: any) => store.projectRoutingProfile(project.slug)?.profile.id === profile.id);
      sendJson(res, 200, { profile, boards, boardCount: boards.length });
      return;
    }
    if (req.method === 'PATCH' || req.method === 'PUT') {
      try {
        const result = store.editRoutingProfile(id, await readJsonBody(req));
        sendJson(res, 200, { result, profile: store.routingProfileDetails(id) });
      } catch (error: any) { sendJson(res, 400, { error: error.message }); }
      return;
    }
    if (req.method === 'DELETE') {
      try { sendJson(res, 200, { result: store.retireRoutingProfile(id) }); }
      catch (error: any) { sendJson(res, 400, { error: error.message }); }
      return;
    }
  }

  // --- Per-project notification switch (/api/projects/:slug/notify) ---
  const pn = /^\/api\/projects\/([^/]+)\/notify$/.exec(pathname);
  if ((req.method === 'POST' || req.method === 'PUT') && pn) {
    let body: any;
    try {
      body = await readJsonBody(req);
    } catch (e: any) {
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
    let body: any;
    try {
      body = await readJsonBody(req);
    } catch (e: any) {
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
      let body: any;
      try {
        body = await readJsonBody(req);
      } catch (e: any) {
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

  // --- Categories: taxonomy, CRUD, and live per-scope usage counts ---
  if (req.method === 'GET' && pathname === '/api/categories') {
    const project = q.project ? String(q.project) : 'all';
    const profile = q.profile ? String(q.profile) : null;
    if (project !== 'all' && !store.readMeta(project)) {
      sendJson(res, 404, { error: 'unknown project' });
      return;
    }
    try {
      const payload = categoriesPayload(project, profile);
      sendJson(res, 200, { project, profile: payload.profile, localChangeCount: payload.localChangeCount, categories: payload.categories, warnings: payload.warnings });
    } catch (error: any) { sendJson(res, 404, { error: error.message }); }
    return;
  }

  if (req.method === 'POST' && pathname === '/api/categories/draft') {
    if (!categoryDraftAvailable) {
      sendJson(res, 503, { error: 'Category drafting needs the claude CLI on PATH.' });
      return;
    }
    let body: any;
    try {
      body = await readJsonBody(req);
    } catch (_: any) {
      sendJson(res, 400, { error: 'bad JSON body' });
      return;
    }
    const sentence = String(body.sentence || '').trim();
    const project = body.project && body.project !== 'all' ? String(body.project) : null;
    if (!sentence) { sendJson(res, 400, { error: 'A category sentence is required.' }); return; }
    if (project && !store.readMeta(project)) { sendJson(res, 404, { error: 'unknown project' }); return; }
    try {
      sendJson(res, 200, { draft: await draftCategory(sentence, project) });
    } catch (error: any) {
      sendJson(res, 422, { error: error.message || 'Claude returned an invalid category draft.' });
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/api/categories') {
    let body: any;
    try {
      body = await readJsonBody(req);
    } catch (e: any) {
      sendJson(res, 400, { error: 'bad JSON body' });
      return;
    }
    const project = body.project ? String(body.project) : null;
    const profile = body.profile ? String(body.profile) : null;
    if (project && profile) { sendJson(res, 400, { error: 'choose a board or routing profile, not both' }); return; }
    if (project && !store.readMeta(project)) {
      sendJson(res, 404, { error: 'unknown project' });
      return;
    }
    try {
      if (profile) {
        const category = store.setRoutingProfileCategory(profile, {
          id: body.id, name: body.name, description: body.description, route: body.route, fallback: body.fallback,
          contract: body.contract, artifactRoots: body.artifactRoots, enabled: body.enabled,
        });
        const payload = categoriesPayload('all', profile);
        sendJson(res, 201, { category: payload.categories.find((entry?: any) => entry.id === category.id), profile: payload.profile });
        return;
      }
      if (project) {
        const id = String(body.id || '').trim().toLowerCase();
        const selected = store.projectRoutingProfile(project);
        const base = store.routingProfileCategory(selected.profile.id, id);
        const data = {
          id,
          name: body.name,
          description: body.description,
          route: body.route,
          fallback: body.fallback,
          contract: body.contract,
          artifactRoots: body.artifactRoots,
          enabled: body.enabled !== false,
        };
        store.setProjectCategory(project, id, base ? 'DETACH' : 'ADD', data);
        const payload = categoriesPayload(project);
        sendJson(res, 201, { category: payload.categories.find((category?: any) => category.id === id), profile: payload.profile, warnings: payload.warnings });
        return;
      }
      const category = store.setCategory({
        id: body.id,
        name: body.name,
        description: body.description,
        route: body.route,
        fallback: body.fallback,
        contract: body.contract,
        artifactRoots: body.artifactRoots,
        enabled: body.enabled,
      });
      sendJson(res, 201, { category: Object.assign({}, category, { usageCount: categoryUsageCounts('all')[category.id] || 0 }) });
    } catch (e: any) {
      sendJson(res, 400, { error: e.message });
    }
    return;
  }

  const categoryActionMatch = /^\/api\/categories\/([^/]+)\/(pin|detach|relink)$/.exec(pathname);
  if (categoryActionMatch && req.method === 'POST') {
    const id = categoryActionMatch[1]!;
    const action = categoryActionMatch[2];
    let body: any;
    try {
      body = await readJsonBody(req);
    } catch (_: any) {
      sendJson(res, 400, { error: 'bad JSON body' });
      return;
    }
    const project = body.project ? String(body.project) : null;
    if (!project || !store.readMeta(project)) {
      sendJson(res, 404, { error: 'unknown project' });
      return;
    }
    try {
      if (action === 'detach' || action === 'pin') store.detachCategory(project, id);
      else {
        const row = store.getProjectCategories(project).rows.find((entry?: any) => entry.id === id);
        if (!row) throw new Error(`Category "${id}" has no local change.`);
        store.removeProjectCategory(project, id);
      }
      const payload = categoriesPayload(project);
      sendJson(res, 200, { category: payload.categories.find((category?: any) => category.id === id) || null, warnings: payload.warnings });
    } catch (error: any) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  const categoryMatch = /^\/api\/categories\/([^/]+)$/.exec(pathname);
  if (categoryMatch) {
    const id = categoryMatch[1]!;
    if (req.method === 'PATCH' || req.method === 'PUT') {
      let body: any;
      try {
        body = await readJsonBody(req);
      } catch (e: any) {
        sendJson(res, 400, { error: 'bad JSON body' });
        return;
      }
      const project = q.project ? String(q.project) : null;
      const profile = q.profile ? String(q.profile) : null;
      if (project && profile) { sendJson(res, 400, { error: 'choose a board or routing profile, not both' }); return; }
      if (project && !store.readMeta(project)) {
        sendJson(res, 404, { error: 'unknown project' });
        return;
      }
      try {
        if (profile) {
          const patch = Object.assign({}, body);
          delete patch.id;
          const category = store.setRoutingProfileCategory(profile, id, patch);
          const payload = categoriesPayload('all', profile);
          sendJson(res, 200, { category: payload.categories.find((entry?: any) => entry.id === category.id), profile: payload.profile });
          return;
        }
        if (project) {
          if (body.disable === true) {
            store.setProjectCategory(project, id, 'DISABLE', {});
          } else {
            const selected = store.projectRoutingProfile(project);
            const base = store.routingProfileCategory(selected.profile.id, id);
            const current = store.getCategory(id, { project });
            const data = Object.assign({}, current || {}, body, { id, enabled: body.enabled !== false });
            delete data.project;
            delete data.disable;
            store.setProjectCategory(project, id, base ? 'DETACH' : 'ADD', data);
          }
          const payload = categoriesPayload(project);
          sendJson(res, 200, { category: payload.categories.find((category?: any) => category.id === id), warnings: payload.warnings });
          return;
        }
        if (!store.getCategory(id)) {
          sendJson(res, 404, { error: 'category not found' });
          return;
        }
        const patch = Object.assign({}, body);
        delete patch.id;
        const category = store.setCategory(id, patch);
        sendJson(res, 200, { category: Object.assign({}, category, { usageCount: categoryUsageCounts('all')[category.id] || 0 }) });
      } catch (e: any) {
        sendJson(res, 400, { error: e.message });
      }
      return;
    }
    if (req.method === 'DELETE') {
      const project = q.project ? String(q.project) : null;
      const profile = q.profile ? String(q.profile) : null;
      if (project && profile) { sendJson(res, 400, { error: 'choose a board or routing profile, not both' }); return; }
      if (project && !store.readMeta(project)) {
        sendJson(res, 404, { error: 'unknown project' });
        return;
      }
      try {
        if (profile) {
          const existed = store.removeRoutingProfileCategory(profile, id);
          sendJson(res, existed ? 200 : 404, { ok: existed });
          return;
        }
        if (project) {
          const existed = store.removeProjectCategory(project, id);
          sendJson(res, existed ? 200 : 404, { ok: existed });
          return;
        }
        const existed = store.removeCategory(id);
        sendJson(res, existed ? 200 : 404, { ok: existed, usageCount: categoryUsageCounts('all')[id] || 0 });
      } catch (e: any) {
        sendJson(res, 400, { error: e.message });
      }
      return;
    }
  }

  // --- Routing fallback: global final policy for unavailable category routes ---
  if (req.method === 'GET' && pathname === '/api/routing-fallback') {
    sendJson(res, 200, { fallback: store.getRoutingFallback(), catalog: store.routingModels() });
    return;
  }
  if ((req.method === 'PUT' || req.method === 'POST') && pathname === '/api/routing-fallback') {
    let body: any;
    try {
      body = await readJsonBody(req);
      const fallback = store.setRoutingFallback(body.fallback || body);
      sendJson(res, 200, { fallback, catalog: store.routingModels() });
    } catch (e: any) {
      sendJson(res, 400, { error: e.message });
    }
    return;
  }

  // --- Routing catalog: models available to category and fallback controls ---
  if (req.method === 'GET' && pathname === '/api/routing-models') {
    const project = q.project ? String(q.project) : null;
    const payload = store.modelsPayload(project ? { project } : undefined);
    payload.categoryDraftAvailable = categoryDraftAvailable;
    sendJson(res, 200, payload);
    return;
  }

  if (req.method === 'GET' && pathname === '/api/tickets') {
    const project = q.project ? String(q.project) : 'all';
    // Board shows active tickets; ?archived=1 returns the archive instead.
    const archivedOnly = q.archived === '1' || q.archived === 'true';
    if (project === 'all' || project === '') {
      sendJson(res, 200, { project: 'all', archived: archivedOnly, tickets: annotateReminders(store.listAllProjectTickets(archivedOnly)) });
    } else {
      const meta = store.readMeta(project);
      if (!meta) {
        sendJson(res, 404, { error: 'unknown project' });
        return;
      }
      const tickets = store.listTickets(project).filter((t?: any) => (archivedOnly ? t.archived : !t.archived));
      sendJson(res, 200, { project, archived: archivedOnly, tickets: annotateReminders(tickets) });
    }
    return;
  }

  // --- Tickets: create ---
  if (req.method === 'POST' && pathname === '/api/tickets') {
    let body: any;
    try {
      body = await readJsonBody(req);
    } catch (e: any) {
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
    // A category replaces the legacy complexity requirement. Deliberately
    // unclassified tickets remain possible for intake flows that opt in.
    const category = body.category == null ? null : String(body.category).trim().toLowerCase();
    if (category && !store.getCategory(category)) {
      sendJson(res, 400, { error: 'unknown category' });
      return;
    }
    if (!category && !body.unclassified && !store.coerceComplexity(body.complexity)) {
      sendJson(res, 400, { error: 'choose a category or provide a complexity score' });
      return;
    }
    if (!category && !body.unclassified && (!body.complexityWhy || String(body.complexityWhy).trim().length < 20)) {
      sendJson(res, 400, { error: 'complexityWhy is required with a complexity score (min 20 chars)' });
      return;
    }
    const ticket = store.createTicket(slug, {
      title: body.title,
      description: body.description,
      status: body.status,
      priority: body.priority,
      labels: body.labels,
      storyId: body.storyId,
      category,
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
    sendJson(res, 201, { ticket: created, warnings: store.ticketPlanningWarnings(created, (store.readMeta(slug) || {}).path) });
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
      let body: any;
      try {
        body = await readJsonBody(req);
      } catch (e: any) {
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
      sendJson(res, 200, { ticket: updated, warnings: store.ticketPlanningWarnings(updated, (store.readMeta(slug) || {}).path) });
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
    let body: any;
    try {
      body = await readJsonBody(req);
    } catch (e: any) {
      sendJson(res, 400, { error: 'bad JSON body' });
      return;
    }
    // A comment posted through the dashboard is the user's own; source "dashboard"
    // so it doesn't notify them about their own message.
    const result = store.addComment(slug, cm[1], { by: body.by || 'you', body: body.body, kind: body.kind, source: 'dashboard' });
    if (!result.ok) {
      const payload: any = { error: result.reason };
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
      let body: any;
      try {
        body = await readJsonBody(req);
      } catch (e: any) {
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
    let body: any;
    try {
      body = await readJsonBody(req);
    } catch (e: any) {
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
    const opts: any = {};
    if (q.project && q.project !== 'all') opts.projectSlug = String(q.project);
    if (q.kind) opts.kind = String(q.kind);
    if (q.unread === '1' || q.unread === 'true') opts.unreadOnly = true;
    if (q.includePending === '1' || q.includePending === 'true') opts.includePending = true;
    if (q.limit) opts.limit = Number(q.limit);
    const notifications = store.listNotifications(opts);
    // Unread counts are computed server-wide (kind-agnostic, no limit) so the bell
    // badge and inbox category tabs stay correct even when the newest-N page the
    // client holds doesn't include an older unread event.
    const unreadList = store.listNotifications(Object.assign({}, opts, { unreadOnly: true, kind: undefined, limit: undefined }));
    const unread = unreadList.length;
    const unreadNeeds = unreadList.filter((n?: any) => n.kind === 'reminder').length;
    sendJson(res, 200, { notifications, unread, unreadNeeds });
    return;
  }

  // --- Notifications: mark read ({ id } or { all: true }) ---
  if (req.method === 'POST' && pathname === '/api/notifications/read') {
    let body: any;
    try {
      body = await readJsonBody(req);
    } catch (e: any) {
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
  // (comment/created/status). Kept server-side (not just the
  // dashboard's localStorage) so the queue can honor an opt-out even with no
  // dashboard tab open — see store.queueEventNotification(). ---
  if (req.method === 'GET' && pathname === '/api/notify-prefs') {
    sendJson(res, 200, { prefs: store.getNotifyPrefs() });
    return;
  }
  if ((req.method === 'PUT' || req.method === 'POST') && pathname === '/api/notify-prefs') {
    let body: any;
    try {
      body = await readJsonBody(req);
    } catch (e: any) {
      sendJson(res, 400, { error: 'bad JSON body' });
      return;
    }
    sendJson(res, 200, { prefs: store.setNotifyPrefs(body) });
    return;
  }

  // --- Assets: /api/asset/:slug/:id/:filename ---
  const am = /^\/api\/asset\/([^/]+)\/([^/]+)\/(.+)$/.exec(pathname);
  if (req.method === 'GET' && am) {
    const [, slug, id, filename] = am;
    const file = store.assetPath(slug, id, filename);
    try {
      const data = await fsp.readFile(file);
      const type = CONTENT_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Content-Length': data.length });
      res.end(data);
    } catch (_: any) {
      sendText(res, 404, 'not found');
    }
    return;
  }

  if (req.method === 'GET' && await serveStatic(pathname, res)) return;

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
    } catch (_: any) {
      /* best effort — never let a scheduler hiccup take the server down */
    }
  };
  tick(); // catch anything that fired while the server was down
  const timer = setInterval(tick, REMINDER_TICK_MS);
  timer.unref();
  return timer;
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
function pickNewerInstall(entries?: any, selfVersion?: any) {
  if (!Array.isArray(entries) || typeof selfVersion !== 'string' || !CLEAN_SEMVER_RE.test(selfVersion)) return null;
  const self = selfVersion.split('.').map(Number);
  let best = null; // { name, parts }
  for (const entry of entries) {
    if (!entry || entry.hasBin !== true) continue;
    const version = entry.version;
    if (typeof version !== 'string' || !CLEAN_SEMVER_RE.test(version)) continue;
    const parts = version.split('.').map(Number);
    let cmp = 0;
    for (let i = 0; i < 3 && cmp === 0; i++) cmp = parts[i]! - self[i]!;
    if (cmp <= 0) continue; // strictly greater than self only
    if (!best) {
      best = { name: entry.name, parts };
      continue;
    }
    let cmpBest = 0;
    for (let i = 0; i < 3 && cmpBest === 0; i++) cmpBest = parts[i]! - best.parts[i]!;
    if (cmpBest > 0) best = { name: entry.name, parts };
  }
  return best ? best.name : null;
}

// Best-effort FS wrapper: look at sibling install dirs next to this plugin's
// own version dir and return the absolute path to a newer install's
// bin/sidequest.js, or null if there is none (or recycling is disabled/unsafe
// for this process). Wrapped so any readdir/fs surprise degrades to "no
// newer install" rather than taking the server down.
async function pathExists(file?: any) {
  try {
    await fsp.access(file);
    return true;
  } catch (_: any) {
    return false;
  }
}

async function runnableInstall(root?: any) {
  if (typeof root !== 'string') return false;
  const [hasBin, hasManifest] = await Promise.all([
    pathExists(path.join(root, 'bin', 'sidequest.js')),
    pathExists(path.join(root, '.claude-plugin', 'plugin.json')),
  ]);
  return hasBin && hasManifest;
}

async function findNewerInstall(options?: any) {
  try {
    const opts = options || {};
    const selfRoot = opts.selfRoot || path.resolve(__dirname, '..');
    const selfVersion = opts.selfVersion || path.basename(selfRoot);
    if (!CLEAN_SEMVER_RE.test(selfVersion)) return null;
    if (process.env.SIDEQUEST_NO_HOT_RECYCLE && !opts.ignoreOptOut) return null;

    const claudeHome = opts.claudeHome || process.env.SIDEQUEST_CLAUDE_HOME || path.join(os.homedir(), '.claude');
    const registryPath = opts.registryPath || path.join(claudeHome, 'plugins', 'installed_plugins.json');
    let registry: any;
    try { registry = JSON.parse(await fsp.readFile(registryPath, 'utf8')); } catch (_: any) { registry = null; }
    const installed = registry && registry.plugins && registry.plugins['sidequest@eigenwise-toolshed'];
    if (Array.isArray(installed)) {
      const entries = await Promise.all(installed.map(async (install?: any) => {
        const root = install && install.installPath;
        return {
          name: root,
          version: install && install.version,
          hasBin: await runnableInstall(root),
        };
      }));
      const target = pickNewerInstall(entries, selfVersion);
      if (target) return path.join(target, 'bin', 'sidequest.js');
    }

    const parent = path.dirname(selfRoot);
    const names = await fsp.readdir(parent);
    const entries = await Promise.all(names.map(async (name?: any) => {
      const dir = path.join(parent, name);
      return { name, version: name, hasBin: await runnableInstall(dir) };
    }));
    const target = pickNewerInstall(entries, selfVersion);
    return target ? path.join(parent, target, 'bin', 'sidequest.js') : null;
  } catch (_: any) {
    return null;
  }
}

function runNodeCheck(file?: any) {
  return new Promise<any>((resolve?: any) => {
    let settled = false;
    const finish = (ok?: any) => {
      if (settled) return;
      settled = true;
      resolve(Boolean(ok));
    };
    try {
      const child = spawn(process.execPath, ['--check', file], { stdio: 'ignore', windowsHide: true });
      child.once('error', () => finish(false));
      child.once('close', (code?: any) => finish(code === 0));
    } catch (_: any) {
      finish(false);
    }
  });
}

async function canRunInstall(targetBin?: any) {
  try {
    const targetRoot = path.resolve(targetBin, '..', '..');
    const checks = await Promise.all([
      runNodeCheck(targetBin),
      runNodeCheck(path.join(targetRoot, 'lib', 'server.js')),
    ]);
    return checks.every(Boolean);
  } catch (_: any) {
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
function startVersionWatch(server?: any, ownPort?: any, reminderTimer?: any) {
  let checkingForUpdate = false;
  const watchTimer = setInterval(async () => {
    try {
      if (recycling || checkingForUpdate) return;
      checkingForUpdate = true;
      const targetBin = await findNewerInstall();
      if (!targetBin) return;
      if (!await canRunInstall(targetBin)) {
        try {
          process.stderr.write(`sidequest: newer install failed preflight (${targetBin}) — keeping the current dashboard\n`);
        } catch (_: any) {
          /* best effort */
        }
        return;
      }
      recycling = true;
      try {
        process.stderr.write(`sidequest: newer install found (${targetBin}) — handing off port ${ownPort}\n`);
      } catch (_: any) {
        /* best effort */
      }
      let child: any;
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
      } catch (_: any) {
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
        } catch (_: any) {
          /* best effort */
        }
        process.exit(0);
      });
    } catch (_: any) {
      /* fail-soft: a watch hiccup must never take the server down */
    } finally {
      checkingForUpdate = false;
    }
  }, VERSION_WATCH_MS);
  watchTimer.unref();
  return watchTimer;
}

/* ------------------------------------------------------------------ *
 *  Listen with automatic free-port selection
 * ------------------------------------------------------------------ */

function listenOn(server?: any, port?: any, host?: any, triesLeft?: any) {
  return new Promise<any>((resolve?: any, reject?: any) => {
    const onError = (err?: any) => {
      server.removeListener('listening', onListening);
      // EACCES: Windows excluded port ranges (netsh show excludedportrange)
      // refuse the bind outright; walk past them like an occupied port.
      if (err && (err.code === 'EADDRINUSE' || err.code === 'EACCES') && triesLeft > 0) {
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
async function start(requestedPort?: any) {
  await categoryDraftProbe;
  const host = '127.0.0.1';
  const startPort = Number(requestedPort) || Number(process.env.SIDEQUEST_PORT) || 41730;
  const server = http.createServer((req?: any, res?: any) => {
    handle(req, res).catch((err?: any) => {
      try {
        sendJson(res, 500, { error: String((err && err.message) || err) });
      } catch (_: any) {
        /* response already sent */
      }
    });
  });
  const port = await listenOn(server, startPort, host, 700);
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

module.exports = { start, listenOn, pickNewerInstall, findNewerInstall, categoryDraftPrompt, validateCategoryDraft, draftCategory, setCategoryDraftSpawn: (value?: any) => { categoryDraftSpawn = value || spawn; }, setCategoryDraftAvailable: (value?: any) => { categoryDraftAvailable = value; }, setCategoryDraftTimeout: (value?: any) => { categoryDraftTimeoutMs = value || CATEGORY_DRAFT_TIMEOUT_MS; } };
