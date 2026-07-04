'use strict';
/**
 * sidequest - storage layer
 *
 * One shared, dependency-free store used by the CLI, the capture hook, and the
 * dashboard server. Tickets live in a central home-directory store (not inside
 * each repo), keyed by the project's absolute path, so:
 *   - a repo never gets ticket JSON committed into it by accident, and
 *   - a single dashboard can show every project's board at once.
 *
 * Layout (root defaults to ~/.claude/sidequest, override with SIDEQUEST_HOME):
 *
 *   <root>/
 *     server.json                         # { port, pid, startedAt, url } of the live dashboard
 *     projects/
 *       <slug>/
 *         meta.json                       # { path, name, createdAt, seq }
 *         tickets/<id>.json               # one file per ticket
 *         assets/<id>/<file>              # images attached to a ticket
 *
 * <slug> is "<basename>-<8 hex of a hash of the absolute path>", so two
 * different folders that happen to share a basename never collide.
 *
 * Everything here is Node stdlib only and written to fail soft where a caller
 * (the hook) needs it to: a missing/corrupt file degrades to an empty result,
 * never a throw that could break a prompt.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

/* ------------------------------------------------------------------ *
 *  Roots and path helpers
 * ------------------------------------------------------------------ */

function homeRoot() {
  const env = process.env.SIDEQUEST_HOME;
  if (env && String(env).trim()) return path.resolve(String(env).trim());
  return path.join(os.homedir(), '.claude', 'sidequest');
}

function projectsRoot() {
  return path.join(homeRoot(), 'projects');
}

function serverFile() {
  return path.join(homeRoot(), 'server.json');
}

// Windows paths are case-insensitive; normalize case for a stable hash so the
// same folder always maps to the same slug regardless of how it was typed.
function normalizeForHash(absPath) {
  const p = path.resolve(absPath);
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

function slugify(absPath) {
  const base = path
    .basename(path.resolve(absPath))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'project';
  const hash = crypto.createHash('sha1').update(normalizeForHash(absPath)).digest('hex').slice(0, 8);
  return `${base}-${hash}`;
}

function projectDir(slug) {
  return path.join(projectsRoot(), slug);
}
function ticketsDir(slug) {
  return path.join(projectDir(slug), 'tickets');
}
function assetsDir(slug, id) {
  return path.join(projectDir(slug), 'assets', id);
}
function metaFile(slug) {
  return path.join(projectDir(slug), 'meta.json');
}

/* ------------------------------------------------------------------ *
 *  Low-level JSON IO (atomic-ish, fail-soft on read)
 * ------------------------------------------------------------------ */

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJson(file, obj) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Math.floor(process.hrtime()[1] % 1e6)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  try {
    fs.renameSync(tmp, file);
  } catch (_) {
    // Windows rename onto an existing file can fail; replace explicitly.
    try {
      fs.unlinkSync(file);
    } catch (_e) {
      /* ignore */
    }
    fs.renameSync(tmp, file);
  }
}

/* ------------------------------------------------------------------ *
 *  Ids
 * ------------------------------------------------------------------ */

function newTicketId() {
  const t = Date.now().toString(36);
  const r = crypto.randomBytes(4).toString('hex');
  return `tk_${t}_${r}`;
}

/* ------------------------------------------------------------------ *
 *  Projects
 * ------------------------------------------------------------------ */

const VALID_STATUS = ['todo', 'doing', 'done'];
const VALID_PRIORITY = ['low', 'normal', 'high', 'urgent'];

function defaultProjectName(absPath) {
  return path.basename(path.resolve(absPath)) || 'project';
}

// Register (or refresh) a project and return { slug, dir, meta }. Creates the
// directory tree on first use. `name` overrides the display name (defaults to
// the folder basename).
function ensureProject(absPath, name) {
  const resolved = path.resolve(absPath);
  const slug = slugify(resolved);
  const dir = projectDir(slug);
  ensureDir(ticketsDir(slug));
  const mf = metaFile(slug);
  let meta = readJson(mf, null);
  if (!meta || typeof meta !== 'object') {
    meta = { path: resolved, name: name || defaultProjectName(resolved), createdAt: new Date().toISOString(), seq: 0 };
    writeJson(mf, meta);
  } else {
    let dirty = false;
    if (meta.path !== resolved) { meta.path = resolved; dirty = true; }
    if (name && meta.name !== name) { meta.name = name; dirty = true; }
    if (!meta.name) { meta.name = defaultProjectName(resolved); dirty = true; }
    if (typeof meta.seq !== 'number') { meta.seq = 0; dirty = true; }
    if (dirty) writeJson(mf, meta);
  }
  return { slug, dir, meta };
}

function readMeta(slug) {
  return readJson(metaFile(slug), null);
}

function nextSeq(slug) {
  const mf = metaFile(slug);
  const meta = readJson(mf, null) || { seq: 0 };
  meta.seq = (typeof meta.seq === 'number' ? meta.seq : 0) + 1;
  writeJson(mf, meta);
  return meta.seq;
}

// List every registered project with live ticket counts. Sorted by most recent
// activity so the busiest board floats to the top of the switcher.
function listProjects() {
  const root = projectsRoot();
  let slugs = [];
  try {
    slugs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch (_) {
    return [];
  }
  const out = [];
  for (const slug of slugs) {
    const meta = readMeta(slug);
    if (!meta) continue;
    const tickets = listTickets(slug);
    const counts = { todo: 0, doing: 0, done: 0 };
    let lastActivity = meta.createdAt || null;
    for (const t of tickets) {
      if (counts[t.status] != null) counts[t.status]++;
      if (t.updatedAt && (!lastActivity || t.updatedAt > lastActivity)) lastActivity = t.updatedAt;
    }
    out.push({
      slug,
      name: meta.name || slug,
      path: meta.path || '',
      counts,
      total: tickets.length,
      open: counts.todo + counts.doing,
      lastActivity,
    });
  }
  out.sort((a, b) => String(b.lastActivity || '').localeCompare(String(a.lastActivity || '')));
  return out;
}

/* ------------------------------------------------------------------ *
 *  Assets (images attached to a ticket)
 * ------------------------------------------------------------------ */

function sanitizeFilename(name) {
  const base = path.basename(String(name || 'image')).replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+/, '');
  return base || 'image';
}

// Copy a source image into a ticket's asset folder and return the stored
// filename (deduped on collision). Throws on an unreadable source so the CLI
// can report it; callers that must not throw wrap this.
function copyAsset(slug, id, srcPath) {
  const src = path.resolve(srcPath);
  const data = fs.readFileSync(src); // throws if missing -> surfaced by CLI
  const dir = assetsDir(slug, id);
  ensureDir(dir);
  let fname = sanitizeFilename(path.basename(src));
  if (!path.extname(fname)) fname += '.png';
  let dest = path.join(dir, fname);
  let n = 1;
  while (fs.existsSync(dest)) {
    const ext = path.extname(fname);
    const stem = fname.slice(0, -ext.length || undefined);
    dest = path.join(dir, `${stem}-${n}${ext}`);
    n++;
  }
  fs.writeFileSync(dest, data);
  return path.basename(dest);
}

function assetPath(slug, id, filename) {
  // Guard against path traversal in a filename coming from the HTTP layer.
  const safe = path.basename(String(filename));
  return path.join(assetsDir(slug, id), safe);
}

// Save raw image bytes (e.g. a screenshot pasted into the dashboard) into a
// ticket's asset folder, deduping the filename. Returns the stored filename.
function saveAssetData(slug, id, name, buffer) {
  const dir = assetsDir(slug, id);
  ensureDir(dir);
  let fname = sanitizeFilename(name || 'pasted.png');
  if (!path.extname(fname)) fname += '.png';
  let dest = path.join(dir, fname);
  let n = 1;
  while (fs.existsSync(dest)) {
    const ext = path.extname(fname);
    const stem = fname.slice(0, -ext.length || undefined);
    dest = path.join(dir, `${stem}-${n}${ext}`);
    n++;
  }
  fs.writeFileSync(dest, buffer);
  return path.basename(dest);
}

/* ------------------------------------------------------------------ *
 *  Tickets
 * ------------------------------------------------------------------ */

function ticketFile(slug, id) {
  return path.join(ticketsDir(slug), `${path.basename(String(id))}.json`);
}

function listTickets(slug) {
  let files = [];
  try {
    files = fs.readdirSync(ticketsDir(slug)).filter((f) => f.endsWith('.json'));
  } catch (_) {
    return [];
  }
  const out = [];
  for (const f of files) {
    const t = readJson(path.join(ticketsDir(slug), f), null);
    if (t && t.id) out.push(t);
  }
  // Newest first by order (falls back to createdAt); the UI re-groups by column.
  out.sort((a, b) => (b.order || 0) - (a.order || 0));
  return out;
}

function getTicket(slug, idOrRef) {
  const direct = readJson(ticketFile(slug, idOrRef), null);
  if (direct && direct.id) return direct;
  // Allow lookup by human ref like "SQ-4" (case-insensitive).
  const wanted = String(idOrRef).toUpperCase();
  for (const t of listTickets(slug)) {
    if (String(t.ref).toUpperCase() === wanted) return t;
  }
  return null;
}

function coerceStatus(s, fallback) {
  s = String(s || '').toLowerCase();
  return VALID_STATUS.includes(s) ? s : fallback;
}
function coercePriority(p, fallback) {
  p = String(p || '').toLowerCase();
  return VALID_PRIORITY.includes(p) ? p : fallback;
}

function createTicket(slug, fields) {
  fields = fields || {};
  const id = newTicketId();
  const seq = nextSeq(slug);
  const now = new Date().toISOString();

  const assets = [];
  const imgs = Array.isArray(fields.images) ? fields.images : [];
  for (const src of imgs) {
    try {
      assets.push(copyAsset(slug, id, src));
    } catch (e) {
      // Record which image could not be attached; the CLI surfaces this.
      if (fields.onAssetError) fields.onAssetError(src, e);
    }
  }
  for (const d of asDataImages(fields.imagesData)) {
    try {
      assets.push(saveAssetData(slug, id, d.name, d.buffer));
    } catch (_) {
      /* skip a bad upload */
    }
  }

  const ticket = {
    id,
    ref: `SQ-${seq}`,
    title: String(fields.title || 'Untitled').trim().slice(0, 300) || 'Untitled',
    description: String(fields.description || '').trim(),
    status: coerceStatus(fields.status, 'todo'),
    priority: coercePriority(fields.priority, 'normal'),
    labels: normalizeLabels(fields.labels),
    assets,
    source: String(fields.source || 'manual'),
    // Who/what last touched this ticket, and how. The dashboard uses these to
    // decide whether a change was made by the user (source "dashboard") or by
    // Claude/the CLI in the background, and whether it was a status change.
    lastEventType: 'created',
    lastEventSource: String(fields.source || 'manual'),
    createdAt: now,
    updatedAt: now,
    order: Date.now(),
  };
  writeJson(ticketFile(slug, id), ticket);
  return ticket;
}

// Decode an optional [{ name, base64 }] list (dashboard image paste/drop) into
// [{ name, buffer }]. Data-URL prefixes are stripped. Bad entries are dropped.
function asDataImages(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const d of list) {
    if (!d || typeof d.base64 !== 'string') continue;
    const b64 = d.base64.replace(/^data:[^;]+;base64,/, '');
    try {
      const buffer = Buffer.from(b64, 'base64');
      if (buffer.length) out.push({ name: d.name, buffer });
    } catch (_) {
      /* skip */
    }
  }
  return out;
}

function normalizeLabels(labels) {
  if (!labels) return [];
  const arr = Array.isArray(labels) ? labels : String(labels).split(',');
  const seen = new Set();
  const out = [];
  for (const l of arr) {
    const v = String(l).trim().slice(0, 40);
    if (v && !seen.has(v.toLowerCase())) {
      seen.add(v.toLowerCase());
      out.push(v);
    }
  }
  return out.slice(0, 12);
}

// Apply a partial update. Only known fields are written; unknown keys ignored.
function updateTicket(slug, idOrRef, patch) {
  const t = getTicket(slug, idOrRef);
  if (!t) return null;
  patch = patch || {};
  const prevStatus = t.status;
  if (patch.title != null) t.title = String(patch.title).trim().slice(0, 300) || t.title;
  if (patch.description != null) t.description = String(patch.description).trim();
  if (patch.status != null) t.status = coerceStatus(patch.status, t.status);
  if (patch.priority != null) t.priority = coercePriority(patch.priority, t.priority);
  if (patch.labels != null) t.labels = normalizeLabels(patch.labels);
  if (patch.order != null && Number.isFinite(Number(patch.order))) t.order = Number(patch.order);
  // Attach any newly supplied images (by path from the CLI, or base64 from the
  // dashboard). Also allow removing an attached asset by filename.
  const imgs = Array.isArray(patch.images) ? patch.images : [];
  for (const src of imgs) {
    try {
      t.assets.push(copyAsset(slug, t.id, src));
    } catch (e) {
      if (patch.onAssetError) patch.onAssetError(src, e);
    }
  }
  for (const d of asDataImages(patch.imagesData)) {
    try {
      t.assets.push(saveAssetData(slug, t.id, d.name, d.buffer));
    } catch (_) {
      /* skip */
    }
  }
  if (Array.isArray(patch.removeAssets) && patch.removeAssets.length) {
    const drop = new Set(patch.removeAssets.map((f) => path.basename(String(f))));
    t.assets = t.assets.filter((a) => {
      if (!drop.has(a)) return true;
      try {
        fs.unlinkSync(assetPath(slug, t.id, a));
      } catch (_) {
        /* ignore */
      }
      return false;
    });
  }
  // Record the event: a status move vs. a plain edit, and who made it. Source
  // defaults to "cli" (the CLI / a subagent), so only the dashboard tags itself.
  t.lastEventType = t.status !== prevStatus ? 'status' : 'edit';
  t.lastEventSource = patch.source ? String(patch.source) : 'cli';
  t.updatedAt = new Date().toISOString();
  writeJson(ticketFile(slug, t.id), t);
  return t;
}

function deleteTicket(slug, idOrRef) {
  const t = getTicket(slug, idOrRef);
  if (!t) return false;
  try {
    fs.unlinkSync(ticketFile(slug, t.id));
  } catch (_) {
    return false;
  }
  try {
    fs.rmSync(assetsDir(slug, t.id), { recursive: true, force: true });
  } catch (_) {
    /* best effort */
  }
  return true;
}

/* ------------------------------------------------------------------ *
 *  Server lockfile (used by CLI + server to find/reuse a running dashboard)
 * ------------------------------------------------------------------ */

function readServerInfo() {
  return readJson(serverFile(), null);
}
function writeServerInfo(info) {
  writeJson(serverFile(), info);
}
function clearServerInfo() {
  try {
    fs.unlinkSync(serverFile());
  } catch (_) {
    /* ignore */
  }
}

module.exports = {
  VALID_STATUS,
  VALID_PRIORITY,
  homeRoot,
  projectsRoot,
  serverFile,
  slugify,
  projectDir,
  ensureProject,
  readMeta,
  listProjects,
  copyAsset,
  saveAssetData,
  assetPath,
  listTickets,
  getTicket,
  createTicket,
  updateTicket,
  deleteTicket,
  normalizeLabels,
  readServerInfo,
  writeServerInfo,
  clearServerInfo,
};
