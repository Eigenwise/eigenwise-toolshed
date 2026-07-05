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

// The agent tier a ticket wants working it — the same aliases Claude Code's Task
// tool accepts, so the orchestrator can pass a ticket's tag straight through as a
// subagent's model (plan with the top tier, execute a tier down). null = any.
// sidequest can't *force* a model (only the orchestrator picks one at spawn
// time); this tag drives that routing and the `next`/`ready` --model filter.
const VALID_MODELS = ['opus', 'sonnet', 'haiku', 'fable'];

// Normalize a requested model tier to one of VALID_MODELS, or null (any). Blank
// / "any" / "none" / an unknown alias all clear it to null.
function coerceModel(v) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  if (!s || s === 'any' || s === 'none' || s === 'null') return null;
  return VALID_MODELS.indexOf(s) !== -1 ? s : null;
}

// A user story groups several tickets. Its colour is what the board uses to tint
// every member card, so the eight defaults are muted, distinct hues that read on
// the cream paper (and against each other). New stories cycle through them; the
// user can override with any hex or one of the named aliases below.
const STORY_PALETTE = ['#c2683f', '#3f8f8a', '#7a5ba8', '#7d8a3f', '#b45573', '#4a72a8', '#c19a3e', '#4f8f6a'];
const STORY_COLOR_NAMES = {
  terracotta: '#c2683f', teal: '#3f8f8a', violet: '#7a5ba8', olive: '#7d8a3f',
  rose: '#b45573', steel: '#4a72a8', amber: '#c19a3e', green: '#4f8f6a',
};

// Normalize a requested story colour to a #rrggbb string, or null if it isn't a
// hex (#rgb / #rrggbb) or a known name — callers fall back to autoStoryColor().
function parseStoryColor(input) {
  if (input == null) return null;
  const s = String(input).trim().toLowerCase();
  if (!s) return null;
  if (STORY_COLOR_NAMES[s]) return STORY_COLOR_NAMES[s];
  if (/^#?[0-9a-f]{6}$/.test(s)) return '#' + s.replace(/^#/, '');
  if (/^#?[0-9a-f]{3}$/.test(s)) {
    const h = s.replace(/^#/, '');
    return '#' + h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  }
  return null;
}
function autoStoryColor(index) {
  const n = STORY_PALETTE.length;
  return STORY_PALETTE[(((index || 0) % n) + n) % n];
}

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
    meta = { path: resolved, name: name || defaultProjectName(resolved), createdAt: new Date().toISOString(), seq: 0, storySeq: 0 };
    writeJson(mf, meta);
  } else {
    let dirty = false;
    if (meta.path !== resolved) { meta.path = resolved; dirty = true; }
    if (name && meta.name !== name) { meta.name = name; dirty = true; }
    if (!meta.name) { meta.name = defaultProjectName(resolved); dirty = true; }
    if (typeof meta.seq !== 'number') { meta.seq = 0; dirty = true; }
    if (typeof meta.storySeq !== 'number') { meta.storySeq = 0; dirty = true; }
    if (dirty) writeJson(mf, meta);
  }
  return { slug, dir, meta };
}

function readMeta(slug) {
  return readJson(metaFile(slug), null);
}

function metaLockPath(slug) {
  return path.join(projectDir(slug), '.meta.lock');
}

// Locked read-modify-write so two concurrent createTicket calls never mint the
// same human-facing SQ-N ref (a bare read+increment+write here would race).
// acquireLock already retries internally on contention; if it still can't get
// the lock (e.g. a wedged/unwritable dir), fall back to an unlocked bump rather
// than blocking ticket creation entirely.
function nextSeq(slug) {
  const lock = metaLockPath(slug);
  const locked = acquireLock(lock);
  try {
    const mf = metaFile(slug);
    const meta = readJson(mf, null) || { seq: 0 };
    meta.seq = (typeof meta.seq === 'number' ? meta.seq : 0) + 1;
    writeJson(mf, meta);
    return meta.seq;
  } finally {
    if (locked) releaseLock(lock);
  }
}

// The story counter is a second monotonic sequence on the same meta.json,
// minting US-1, US-2, … independently of the SQ-N ticket refs. Shares the meta
// lock with nextSeq so a concurrent ticket + story creation can't clobber each
// other's write.
function nextStorySeq(slug) {
  const lock = metaLockPath(slug);
  const locked = acquireLock(lock);
  try {
    const mf = metaFile(slug);
    const meta = readJson(mf, null) || { storySeq: 0 };
    meta.storySeq = (typeof meta.storySeq === 'number' ? meta.storySeq : 0) + 1;
    writeJson(mf, meta);
    return meta.storySeq;
  } finally {
    if (locked) releaseLock(lock);
  }
}

// Turn a board's per-project notifications on or off. When off, the board is
// muted: queueEventNotification below drops every background event for it, even
// with a dashboard tab open. Stored on meta.json (absent == on), behind the meta
// lock so it can't race a seq bump.
function setProjectNotify(slug, on) {
  const lock = metaLockPath(slug);
  const locked = acquireLock(lock);
  try {
    const mf = metaFile(slug);
    const meta = readJson(mf, null);
    if (!meta) return { ok: false, reason: 'not_found' };
    meta.notify = on !== false;
    writeJson(mf, meta);
    return { ok: true, notify: meta.notify };
  } finally {
    if (locked) releaseLock(lock);
  }
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
    let archived = 0;
    let lastActivity = meta.createdAt || null;
    for (const t of tickets) {
      if (t.updatedAt && (!lastActivity || t.updatedAt > lastActivity)) lastActivity = t.updatedAt;
      if (t.archived) { archived++; continue; } // archived tickets don't count toward the board
      if (counts[t.status] != null) counts[t.status]++;
    }
    out.push({
      slug,
      name: meta.name || slug,
      path: meta.path || '',
      counts,
      total: tickets.length - archived,
      archived,
      open: counts.todo + counts.doing,
      lastActivity,
      notify: meta.notify !== false, // per-project notification switch (absent == on)
      stories: listStories(slug).length,
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
    storyId: coerceStoryId(slug, fields.storyId), // the user story this ticket belongs to (null = none)
    model: coerceModel(fields.model),             // the agent tier that should work it (null = any)
    assets,
    comments: [],              // [{ id, by, body, kind: 'comment'|'question', at }]
    links: [],                 // [{ type: 'blocks'|'blocked-by'|'related', ref }]
    claim: null,               // { by, at } when an agent has claimed it to work on
    assignee: normalizeAssignee(fields.assignee), // who it's assigned to (usually the human "you"); distinct from an agent claim
    archived: false,           // hidden from the board (kept, restorable) once true
    archivedAt: null,
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
  queueEventNotification(slug, ticket, 'created', ticket.lastEventSource);
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

// An assignee is a free-form name (the human "you", or an agent). Empty/blank
// clears it back to null (unassigned).
function normalizeAssignee(v) {
  if (v == null) return null;
  const s = String(v).trim().slice(0, 60);
  return s || null;
}

// Apply a partial update. Only known fields are written; unknown keys ignored.
// Locked (like every other mutator) so a concurrent comment/claim/link append
// can never be silently overwritten by an update whose read predates it.
function updateTicket(slug, idOrRef, patch) {
  const found = getTicket(slug, idOrRef);
  if (!found) return null;
  patch = patch || {};
  const apply = (t) => {
    const prevStatus = t.status;
    if (patch.title != null) t.title = String(patch.title).trim().slice(0, 300) || t.title;
    if (patch.description != null) t.description = String(patch.description).trim();
    if (patch.status != null) t.status = coerceStatus(patch.status, t.status);
    if (patch.priority != null) t.priority = coercePriority(patch.priority, t.priority);
    if (patch.labels != null) t.labels = normalizeLabels(patch.labels);
    if (patch.storyId !== undefined) t.storyId = coerceStoryId(slug, patch.storyId);
    if (patch.model !== undefined) t.model = coerceModel(patch.model);
    if (patch.assignee !== undefined) t.assignee = normalizeAssignee(patch.assignee);
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
    queueEventNotification(slug, t, t.lastEventType, t.lastEventSource);
    return t;
  };
  const lock = ticketLockPath(slug, found.id);
  const locked = acquireLock(lock); // best-effort: still applies the update if contention outlasts the retries
  try {
    const t = getTicket(slug, found.id); // fresh read, under the lock when we have it
    if (!t) return null;
    return apply(t);
  } finally {
    if (locked) releaseLock(lock);
  }
}

// Locked so a delete can never yank the ticket/lock file out from under a
// concurrent addComment/claimTicket that still believes it holds the lock.
function deleteTicket(slug, idOrRef) {
  const found = getTicket(slug, idOrRef);
  if (!found) return false;
  const deletedRef = found.ref;
  const lock = ticketLockPath(slug, found.id);
  const locked = acquireLock(lock);
  let ok = true;
  try {
    try {
      fs.unlinkSync(ticketFile(slug, found.id));
    } catch (_) {
      ok = false;
    }
    if (ok) {
      try {
        fs.rmSync(assetsDir(slug, found.id), { recursive: true, force: true });
      } catch (_) {
        /* best effort */
      }
    }
  } finally {
    if (locked) releaseLock(lock); // also removes the lock file itself
  }
  if (!ok) return false;
  // Drop any links other tickets had pointing at the one we just removed, so no
  // dangling "blocked-by SQ-deleted" leaves a ticket falsely blocked forever.
  try {
    for (const other of listTickets(slug)) {
      if (Array.isArray(other.links) && other.links.some((l) => upperRef(l.ref) === upperRef(deletedRef))) {
        stripLinksTo(slug, other.id, deletedRef);
      }
    }
  } catch (_) {
    /* best effort */
  }
  return true;
}

/* ------------------------------------------------------------------ *
 *  Archiving: put finished work out of the way without deleting it
 *
 *  An archived ticket is kept (and fully restorable) but hidden from the board,
 *  the counts, and `next`. This is how "clear out the Done column" works without
 *  losing the record.
 * ------------------------------------------------------------------ */

function setArchived(slug, idOrRef, archived, opts) {
  opts = opts || {};
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: 'not_found' };
  return withTicketLock(slug, found.id, () => {
    const t = getTicket(slug, found.id);
    if (!t) return { ok: false, reason: 'not_found' };
    t.archived = !!archived;
    t.archivedAt = archived ? new Date().toISOString() : null;
    t.lastEventType = archived ? 'archived' : 'restored';
    t.lastEventSource = opts.source ? String(opts.source) : 'cli';
    t.updatedAt = new Date().toISOString();
    writeJson(ticketFile(slug, t.id), t);
    return { ok: true, ticket: t };
  });
}

function archiveTicket(slug, idOrRef, opts) {
  return setArchived(slug, idOrRef, true, opts);
}
function unarchiveTicket(slug, idOrRef, opts) {
  return setArchived(slug, idOrRef, false, opts);
}

// Archive every done, not-yet-archived ticket in a project. Returns the refs.
function archiveAllDone(slug, opts) {
  const refs = [];
  for (const t of listTickets(slug)) {
    if (t.status === 'done' && !t.archived) {
      const res = setArchived(slug, t.id, true, opts);
      if (res.ok) refs.push(res.ticket.ref);
    }
  }
  return { ok: true, archived: refs };
}

function listArchived(slug) {
  return listTickets(slug).filter((t) => t.archived);
}
function listActive(slug) {
  return listTickets(slug).filter((t) => !t.archived);
}

/* ------------------------------------------------------------------ *
 *  Claiming: safe hand-off of a ticket to a worker (agent)
 *
 *  Several agents (or Claude sessions / dashboard tabs) can share a board, so a
 *  ticket must be *claimed* before anyone works it, and the claim must be
 *  atomic: two workers can never both win the same ticket. We serialize the
 *  check-and-set with a per-ticket lock file created via O_EXCL (an atomic
 *  "create only if absent" on every mainstream filesystem). The lock is held
 *  only for the few milliseconds it takes to re-read the ticket and stamp the
 *  claim; the claim itself lives on the ticket as `claim: { by, at }`.
 *
 *  Because the claim is checked against a *fresh* read under the lock, "don't
 *  pick it up before checking it's still there" is guaranteed: if the ticket was
 *  deleted, finished, or grabbed by another worker in the meantime, the claim
 *  fails instead of double-working it.
 * ------------------------------------------------------------------ */

const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, low: 3 };

function priorityRank(p) {
  return Object.prototype.hasOwnProperty.call(PRIORITY_RANK, p) ? PRIORITY_RANK[p] : 9;
}

// How long a claim stays valid without being refreshed before another worker
// may take it over (a crashed/abandoned worker must never wedge a ticket).
function claimTtlMs() {
  const min = Number(process.env.SIDEQUEST_CLAIM_TTL_MIN);
  return (Number.isFinite(min) && min > 0 ? min : 60) * 60 * 1000;
}

function isClaimStale(claim) {
  if (!claim || !claim.at) return true;
  const t = Date.parse(claim.at);
  if (!Number.isFinite(t)) return true;
  return Date.now() - t > claimTtlMs();
}

function ticketLockPath(slug, id) {
  return path.join(ticketsDir(slug), '.' + path.basename(String(id)) + '.lock');
}

// A tiny synchronous pause. The lock is contended only under genuinely
// simultaneous claims and is held for microseconds, so this never runs long.
function busyWait(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    /* spin */
  }
}

// Acquire a short-lived exclusive lock for a ticket. A lock file older than a
// few seconds is treated as abandoned (holder crashed mid-claim) and reclaimed,
// so a crash can never permanently wedge a ticket.
function acquireLock(lockPath) {
  const STALE_LOCK_MS = 5000;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try {
        fs.writeSync(fd, String(process.pid) + ' ' + new Date().toISOString());
      } catch (_) {
        /* ignore */
      }
      fs.closeSync(fd);
      return true;
    } catch (e) {
      if (!e || e.code !== 'EEXIST') return false;
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > STALE_LOCK_MS) {
          try {
            fs.unlinkSync(lockPath);
          } catch (_) {
            /* ignore */
          }
          continue;
        }
      } catch (_) {
        continue; // lock vanished between open and stat: retry immediately
      }
      busyWait(5);
    }
  }
  return false;
}

function releaseLock(lockPath) {
  try {
    fs.unlinkSync(lockPath);
  } catch (_) {
    /* ignore */
  }
}

function withTicketLock(slug, id, fn) {
  const lock = ticketLockPath(slug, id);
  if (!acquireLock(lock)) return { ok: false, reason: 'busy' };
  try {
    return fn();
  } finally {
    releaseLock(lock);
  }
}

// Atomically claim a ticket for worker `by`. Refuses (ok:false) if the ticket is
// gone, already done, or actively claimed by someone else — unless that claim is
// stale or opts.force is set. On success sets claim and moves it to "doing"
// (unless opts.status === false).
function claimTicket(slug, idOrRef, by, opts) {
  opts = opts || {};
  by = String(by || 'agent');
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: 'not_found' };
  return withTicketLock(slug, found.id, () => {
    const t = getTicket(slug, found.id); // fresh read, under the lock
    if (!t) return { ok: false, reason: 'not_found' };
    if (t.status === 'done') return { ok: false, reason: 'done', ticket: t };
    const held = t.claim;
    if (held && held.by && held.by !== by && !isClaimStale(held) && !opts.force) {
      return { ok: false, reason: 'claimed', ticket: t, claim: held };
    }
    t.claim = { by, at: new Date().toISOString() };
    if (opts.status !== false) t.status = coerceStatus(opts.status || 'doing', t.status);
    t.lastEventType = 'status';
    t.lastEventSource = opts.source ? String(opts.source) : 'cli';
    t.updatedAt = new Date().toISOString();
    writeJson(ticketFile(slug, t.id), t);
    queueEventNotification(slug, t, t.lastEventType, t.lastEventSource);
    return { ok: true, ticket: t };
  });
}

// Release a claim. Only the owner (or a stale claim) may release unless
// opts.force; opts.status optionally moves the ticket at the same time.
function releaseTicket(slug, idOrRef, by, opts) {
  opts = opts || {};
  by = String(by || 'agent');
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: 'not_found' };
  return withTicketLock(slug, found.id, () => {
    const t = getTicket(slug, found.id);
    if (!t) return { ok: false, reason: 'not_found' };
    const held = t.claim;
    if (held && held.by && held.by !== by && !isClaimStale(held) && !opts.force) {
      return { ok: false, reason: 'not_owner', ticket: t, claim: held };
    }
    t.claim = null;
    if (opts.status) t.status = coerceStatus(opts.status, t.status);
    t.lastEventType = 'status';
    t.lastEventSource = opts.source ? String(opts.source) : 'cli';
    t.updatedAt = new Date().toISOString();
    writeJson(ticketFile(slug, t.id), t);
    queueEventNotification(slug, t, t.lastEventType, t.lastEventSource);
    return { ok: true, ticket: t };
  });
}

// Complete a ticket: mark it done and clear its claim.
function completeTicket(slug, idOrRef, by, opts) {
  opts = opts || {};
  return releaseTicket(slug, idOrRef, by, Object.assign({}, opts, { status: 'done' }));
}

// True when a ticket may be handed to a worker running as tier `want`: either the
// worker didn't specify a tier, or the ticket is untagged (anyone can take it), or
// the tags match. So a tier-X worker never grabs a ticket reserved for a different
// tier, but untagged work stays available to everyone.
function modelMatches(ticketModel, want) {
  return !want || !ticketModel || ticketModel === want;
}

// The tickets that are ready to be worked right now: not done, not archived, not
// actively claimed, and not blocked by an unfinished ticket. This is the set to
// fan subagents out over (each still claims before working). Priority-ordered.
// opts.model restricts to that tier's work (tagged-for-it or untagged).
function readyTickets(slug, opts) {
  opts = opts || {};
  const want = coerceModel(opts.model);
  return listTickets(slug)
    .filter((t) => !t.archived)
    .filter((t) => t.status !== 'done')
    .filter((t) => !t.claim || isClaimStale(t.claim))
    .filter((t) => !isBlocked(slug, t))
    .filter((t) => modelMatches(t.model, want))
    .sort((a, b) => {
      const pr = priorityRank(a.priority) - priorityRank(b.priority);
      if (pr !== 0) return pr;
      return String(a.createdAt).localeCompare(String(b.createdAt));
    });
}

// Atomically claim the best available ticket in a project: highest priority
// first, oldest-first within a priority. Skips done tickets and ones actively
// claimed by another worker. Returns { ok:true, ticket } or { reason:'empty' }.
function claimNext(slug, by, opts) {
  opts = opts || {};
  by = String(by || 'agent');
  const want = coerceModel(opts.model);
  const candidates = listTickets(slug)
    .filter((t) => !t.archived)
    .filter((t) => t.status !== 'done')
    .filter((t) => !t.claim || isClaimStale(t.claim) || t.claim.by === by)
    .filter((t) => !opts.priority || t.priority === String(opts.priority).toLowerCase())
    .filter((t) => modelMatches(t.model, want)) // a tier-X worker only claims X-tagged or untagged work
    .filter((t) => opts.includeBlocked || !isBlocked(slug, t)) // never auto-hand-out blocked work
    .sort((a, b) => {
      const pr = priorityRank(a.priority) - priorityRank(b.priority);
      if (pr !== 0) return pr;
      return String(a.createdAt).localeCompare(String(b.createdAt));
    });
  for (const cand of candidates) {
    const res = claimTicket(slug, cand.id, by, { source: opts.source });
    if (res.ok) return res;
    // Lost the race or it changed under us — try the next candidate.
  }
  return { ok: false, reason: 'empty' };
}

// Assign (or, with a null/blank assignee, unassign) a ticket. Assignment is a
// persistent "who owns this" marker — unlike claimTicket it has no TTL, does not
// move the ticket to "doing", and does not gate ready/next. It's how a human
// takes a ticket for themselves (assignee "you") or an agent hands one back.
function assignTicket(slug, idOrRef, assignee, opts) {
  opts = opts || {};
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: 'not_found' };
  return withTicketLock(slug, found.id, () => {
    const t = getTicket(slug, found.id);
    if (!t) return { ok: false, reason: 'not_found' };
    t.assignee = normalizeAssignee(assignee);
    t.lastEventType = 'edit';
    t.lastEventSource = opts.source ? String(opts.source) : 'cli';
    t.updatedAt = new Date().toISOString();
    writeJson(ticketFile(slug, t.id), t);
    return { ok: true, ticket: t };
  });
}

/* ------------------------------------------------------------------ *
 *  Stories (a user story groups tickets and tints their cards)
 *
 *  Stored one JSON file per story under projects/<slug>/stories/, minted US-1,
 *  US-2, … from meta.storySeq — deliberately parallel to how tickets live under
 *  tickets/ with SQ-N refs. A ticket points at its story by the story's stable
 *  id (ticket.storyId), never its ref, so renumbering or ref lookups can't orphan
 *  the link. Lower-contention than tickets (created/edited rarely, one human),
 *  so these use a plain read-modify-write rather than the per-item lock tickets need.
 * ------------------------------------------------------------------ */

function storiesDir(slug) {
  return path.join(projectDir(slug), 'stories');
}
function storyFile(slug, id) {
  return path.join(storiesDir(slug), `${path.basename(String(id))}.json`);
}
function newStoryId() {
  return 'st_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex');
}

// Every story in a project, oldest-first (US-1 before US-2) so a legend/filter
// reads in creation order. Fail-soft to [] when the folder doesn't exist yet.
function listStories(slug) {
  let files = [];
  try {
    files = fs.readdirSync(storiesDir(slug)).filter((f) => f.endsWith('.json'));
  } catch (_) {
    return [];
  }
  const out = [];
  for (const f of files) {
    const s = readJson(path.join(storiesDir(slug), f), null);
    if (s && s.id) out.push(s);
  }
  out.sort((a, b) => (a.order || 0) - (b.order || 0));
  return out;
}

// Look up a story by its stable id or its human ref (US-4, case-insensitive).
function getStory(slug, idOrRef) {
  const direct = readJson(storyFile(slug, idOrRef), null);
  if (direct && direct.id) return direct;
  const wanted = String(idOrRef).toUpperCase();
  for (const s of listStories(slug)) {
    if (String(s.ref).toUpperCase() === wanted) return s;
  }
  return null;
}

// Resolve a caller-supplied story reference (a US-ref, a raw id, "none"/"null",
// or null) to a valid story id in this project, or null if it clears / doesn't
// resolve. This is the single guard both createTicket and updateTicket run
// storyId through, so a ticket can never point at a story that isn't there.
function coerceStoryId(slug, val) {
  if (val == null) return null;
  const s = String(val).trim();
  if (!s || s.toLowerCase() === 'none' || s.toLowerCase() === 'null') return null;
  const story = getStory(slug, s);
  return story ? story.id : null;
}

function createStory(slug, fields) {
  fields = fields || {};
  const id = newStoryId();
  const seq = nextStorySeq(slug);
  const now = new Date().toISOString();
  const story = {
    id,
    ref: `US-${seq}`,
    title: String(fields.title || 'Untitled story').trim().slice(0, 200) || 'Untitled story',
    description: String(fields.description || '').trim(),
    // A requested colour wins if it parses; otherwise cycle the palette by the
    // sequence number so successive stories stay visually distinct.
    color: parseStoryColor(fields.color) || autoStoryColor(seq - 1),
    createdAt: now,
    updatedAt: now,
    order: Date.now(),
  };
  writeJson(storyFile(slug, id), story);
  return story;
}

// Apply a partial update to a story. An unparseable colour is ignored rather
// than blanking the existing one.
function updateStory(slug, idOrRef, patch) {
  const s = getStory(slug, idOrRef);
  if (!s) return null;
  patch = patch || {};
  if (patch.title != null) s.title = String(patch.title).trim().slice(0, 200) || s.title;
  if (patch.description != null) s.description = String(patch.description).trim();
  if (patch.color != null) {
    const c = parseStoryColor(patch.color);
    if (c) s.color = c;
  }
  if (patch.order != null && Number.isFinite(Number(patch.order))) s.order = Number(patch.order);
  s.updatedAt = new Date().toISOString();
  writeJson(storyFile(slug, s.id), s);
  return s;
}

// Delete a story and detach it from its member tickets (clearing storyId, the
// same way deleteTicket strips dangling links) so no card is left tinted by a
// story that no longer exists.
function deleteStory(slug, idOrRef) {
  const s = getStory(slug, idOrRef);
  if (!s) return false;
  try {
    fs.unlinkSync(storyFile(slug, s.id));
  } catch (_) {
    return false;
  }
  try {
    for (const t of listTickets(slug)) {
      if (t.storyId === s.id) updateTicket(slug, t.id, { storyId: null, source: 'cli' });
    }
  } catch (_) {
    /* best effort — the story file is already gone */
  }
  return true;
}

/* ------------------------------------------------------------------ *
 *  Comments
 *
 *  Each ticket carries a thread of comments. A comment of kind "question" is how
 *  an agent (or the user) flags that it needs a reply — the dashboard treats it
 *  as a higher-signal notification. Appends happen under the ticket lock so two
 *  simultaneous comments never clobber each other.
 * ------------------------------------------------------------------ */

const COMMENT_KINDS = ['comment', 'question'];

function newCommentId() {
  return 'c_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex');
}

function addComment(slug, idOrRef, fields) {
  fields = fields || {};
  const body = String(fields.body || '').trim();
  if (!body) return { ok: false, reason: 'empty' };
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: 'not_found' };
  return withTicketLock(slug, found.id, () => {
    const t = getTicket(slug, found.id);
    if (!t) return { ok: false, reason: 'not_found' };
    if (!Array.isArray(t.comments)) t.comments = [];
    const kind = COMMENT_KINDS.indexOf(String(fields.kind)) !== -1 ? String(fields.kind) : 'comment';
    const source = fields.source ? String(fields.source) : 'cli';
    const comment = {
      id: newCommentId(),
      by: String(fields.by || 'agent'),
      kind,
      body: body.slice(0, 4000),
      source, // 'cli' (agent) or 'dashboard' (the human) — who needsResponse() listens for
      at: new Date().toISOString(),
    };
    t.comments.push(comment);
    t.lastEventType = kind === 'question' ? 'question' : 'comment';
    t.lastEventSource = source;
    t.updatedAt = comment.at;
    writeJson(ticketFile(slug, t.id), t);
    queueEventNotification(slug, t, t.lastEventType, t.lastEventSource, { commentBody: comment.body });
    return { ok: true, ticket: t, comment };
  });
}

// True while the most recent agent-asked question (kind=question, source=cli)
// has not yet been followed by any comment from the dashboard (the human). An
// agent-authored follow-up comment in between (e.g. a note-to-self) does not
// count as an answer — only the human replying does.
function needsResponse(ticket) {
  const comments = (ticket && Array.isArray(ticket.comments)) ? ticket.comments : [];
  for (let i = comments.length - 1; i >= 0; i--) {
    const c = comments[i];
    if (c.source === 'dashboard') return false;
    if (c.kind === 'question') return true;
  }
  return false;
}

/* ------------------------------------------------------------------ *
 *  Links / dependencies
 *
 *  A link is stored on both tickets with the correct direction, so either side
 *  can see the relationship. User-facing verbs map onto three stored types:
 *  blocks / blocked-by / related. "A depends-on B" == "A blocked-by B" (B must
 *  finish first) == "B blocks A".
 * ------------------------------------------------------------------ */

const LINK_TYPES = ['blocks', 'blocked-by', 'related'];

// Map a user verb to [typeStoredOnFrom, typeStoredOnTo].
function linkTypePair(verb) {
  switch (String(verb || '').toLowerCase().replace(/_/g, '-')) {
    case 'blocks':
    case 'blocking':
      return ['blocks', 'blocked-by'];
    case 'blocked-by':
    case 'blockedby':
    case 'depends-on':
    case 'dependson':
    case 'depends':
    case 'needs':
    case 'after':
      return ['blocked-by', 'blocks'];
    case 'related':
    case 'related-to':
    case 'relates-to':
    case 'relates':
      return ['related', 'related'];
    default:
      return null;
  }
}

function upperRef(r) {
  return String(r).toUpperCase();
}

// Add one directed link to a single ticket (idempotent), under its lock.
function addLinkToTicket(slug, idOrRef, type, otherRef) {
  const found = getTicket(slug, idOrRef);
  if (!found) return;
  withTicketLock(slug, found.id, () => {
    const t = getTicket(slug, found.id);
    if (!t) return;
    if (!Array.isArray(t.links)) t.links = [];
    const ref = upperRef(otherRef);
    if (!t.links.some((l) => l.type === type && upperRef(l.ref) === ref)) {
      t.links.push({ type, ref });
      t.updatedAt = new Date().toISOString();
      writeJson(ticketFile(slug, t.id), t);
    }
  });
}

// Link two tickets by a verb, writing the correct direction on each side.
function linkTickets(slug, fromRef, verb, toRef) {
  const pair = linkTypePair(verb);
  if (!pair) return { ok: false, reason: 'bad_type' };
  const from = getTicket(slug, fromRef);
  const to = getTicket(slug, toRef);
  if (!from) return { ok: false, reason: 'from_not_found' };
  if (!to) return { ok: false, reason: 'to_not_found' };
  if (from.id === to.id) return { ok: false, reason: 'self' };
  addLinkToTicket(slug, from.id, pair[0], to.ref);
  addLinkToTicket(slug, to.id, pair[1], from.ref);
  return { ok: true, from: getTicket(slug, from.id), to: getTicket(slug, to.id), type: pair[0] };
}

// Remove every link between two tickets (both directions).
function unlinkTickets(slug, aRef, bRef) {
  const a = getTicket(slug, aRef);
  const b = getTicket(slug, bRef);
  if (!a || !b) return { ok: false, reason: 'not_found' };
  stripLinksTo(slug, a.id, b.ref);
  stripLinksTo(slug, b.id, a.ref);
  return { ok: true };
}

function stripLinksTo(slug, idOrRef, otherRef) {
  const found = getTicket(slug, idOrRef);
  if (!found) return;
  withTicketLock(slug, found.id, () => {
    const t = getTicket(slug, found.id);
    if (!t || !Array.isArray(t.links)) return;
    const ref = upperRef(otherRef);
    const kept = t.links.filter((l) => upperRef(l.ref) !== ref);
    if (kept.length !== t.links.length) {
      t.links = kept;
      t.updatedAt = new Date().toISOString();
      writeJson(ticketFile(slug, t.id), t);
    }
  });
}

// The refs a ticket is blocked-by that are not yet done (i.e. genuinely blocking).
function openBlockers(slug, ticket) {
  if (!ticket || !Array.isArray(ticket.links)) return [];
  const out = [];
  for (const l of ticket.links) {
    if (l.type !== 'blocked-by') continue;
    const blocker = getTicket(slug, l.ref);
    if (blocker && blocker.status !== 'done') out.push(blocker.ref);
  }
  return out;
}

function isBlocked(slug, ticket) {
  return openBlockers(slug, ticket).length > 0;
}

/* ------------------------------------------------------------------ *
 *  Notifications
 *
 *  A single, persistent, per-user queue (one notifications.json under
 *  projectsRoot(), a sibling to the project dirs). Unlike the old client-side
 *  toasts/badges — which were derived on the fly from ticket diffs and lost on
 *  reload — these survive a server restart, because reminders must be able to
 *  fire even when no dashboard tab is open. Appends/mutations go through a single
 *  queue lock so two writers can never clobber each other, mirroring the
 *  read-modify-write-under-lock pattern used for tickets.
 * ------------------------------------------------------------------ */

const NOTIFICATION_KINDS = ['question', 'comment', 'created', 'status', 'reminder'];

// The four background-event kinds a user can opt in/out of from the dashboard's
// settings popover (a 'reminder' notification isn't optional this way — only
// *when* it fires is, via fireAt). Kept server-side, not just in the dashboard's
// localStorage, so the queue below can honor the same opt-outs even when no
// dashboard tab is open to gate on the client's behalf.
const NOTIFY_PREF_DEFAULTS = { question: true, comment: true, created: true, status: true };

// How many *read* notifications to retain. Unread ones are always kept; this
// only caps the tail of already-seen history so the file can't grow forever.
const MAX_READ_KEPT = 100;

function notificationsFile() {
  return path.join(projectsRoot(), 'notifications.json');
}
function notificationsLockPath() {
  return path.join(projectsRoot(), '.notifications.lock');
}

function newNotificationId() {
  return 'nt_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex');
}

// Fail-soft read: a missing/corrupt file degrades to an empty queue.
function readNotifications() {
  const data = readJson(notificationsFile(), null);
  return data && Array.isArray(data.notifications) ? data.notifications : [];
}
function writeNotifications(list) {
  writeJson(notificationsFile(), { notifications: list });
}

// Serialize every mutation on the queue behind one lock (best-effort, like the
// ticket mutators: still applies if contention outlasts the retries).
function withNotificationsLock(fn) {
  const lock = notificationsLockPath();
  const locked = acquireLock(lock);
  try {
    return fn();
  } finally {
    if (locked) releaseLock(lock);
  }
}

// Drop the oldest read notifications past the cap; never touches unread ones.
function pruneReadList(list) {
  const read = list.filter((n) => n.readAt);
  if (read.length <= MAX_READ_KEPT) return list;
  read.sort((a, b) => String(b.readAt).localeCompare(String(a.readAt)));
  const dropIds = new Set(read.slice(MAX_READ_KEPT).map((n) => n.id));
  return list.filter((n) => !dropIds.has(n.id));
}

// List notifications, newest first. opts: { projectSlug, kind, unreadOnly,
// includePending, limit }. A reminder scheduled for the future (fireAt > now) is
// hidden until it's due unless includePending is set.
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

// Append a notification and return it. Unknown kinds coerce to "comment".
// fireAt is only meaningful for reminders (a scheduled future time); everything
// else leaves it null. Prunes read history in the same locked write.
function addNotification(fields) {
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
    // Only set by queueEventNotification(), purely to dedupe a background-event
    // notification against the ticket mutation that produced it; unused/null
    // for a manually-scheduled reminder.
    ticketEventAt: fields.ticketEventAt ? String(fields.ticketEventAt) : null,
    // Set by fireDueReminders() the first tick after a reminder's fireAt has
    // passed. Purely bookkeeping — visibility in the live queue already follows
    // from fireAt <= now (see listNotifications), so nothing reads this to
    // decide whether to show the notification. It just marks "the scheduler has
    // seen this one go off", which is what a restart-safe scheduler needs to be
    // idempotent about.
    firedAt: null,
  };
  return withNotificationsLock(() => {
    const list = readNotifications();
    list.push(notification);
    writeNotifications(pruneReadList(list));
    return notification;
  });
}

/* ------------------------------------------------------------------ *
 *  Notify prefs (server-side mirror of the dashboard's opt-in/out settings)
 *
 *  A tiny sibling file to notifications.json. The dashboard used to keep this
 *  purely in localStorage, which meant the client had to be open to gate a
 *  background event; now the queue below checks the same server-side copy so
 *  an opted-out kind is never enqueued in the first place, tab or no tab.
 * ------------------------------------------------------------------ */

function notifyPrefsFile() {
  return path.join(projectsRoot(), 'notify-prefs.json');
}

// Read the saved opt-in/out settings. Missing/corrupt file -> all on, matching
// the dashboard's own NOTIFY_DEFAULTS.
function getNotifyPrefs() {
  const saved = readJson(notifyPrefsFile(), null);
  const merged = Object.assign({}, NOTIFY_PREF_DEFAULTS, saved && typeof saved === 'object' ? saved : {});
  const out = {};
  for (const k of Object.keys(NOTIFY_PREF_DEFAULTS)) out[k] = merged[k] !== false;
  return out;
}

// Persist a partial or full set of opt-in/out prefs. Unknown keys are dropped.
function setNotifyPrefs(patch) {
  const next = Object.assign({}, getNotifyPrefs(), patch || {});
  const out = {};
  for (const k of Object.keys(NOTIFY_PREF_DEFAULTS)) out[k] = next[k] !== false;
  writeJson(notifyPrefsFile(), out);
  return out;
}

// Build the title/body for a background-event notification, mirroring the
// dashboard's own maybeNotify() toast copy so a persisted inbox entry reads the
// same as the desktop toast the user may also have seen for the same event.
function eventNotificationCopy(ticket, kind, extra) {
  extra = extra || {};
  const ref = ticket.ref;
  if (kind === 'question') return { title: `❓ Question · ${ref}`, body: extra.commentBody || ticket.title };
  if (kind === 'comment') {
    return { title: `💬 Comment · ${ref}`, body: extra.commentBody ? `${extra.commentBody}  —  ${ticket.title}` : ticket.title };
  }
  if (kind === 'created') return { title: `New side quest · ${ref}`, body: ticket.title };
  return { title: `${ref} → ${ticket.status}`, body: ticket.title }; // 'status'
}

// The server-side counterpart to the dashboard's old isBackgroundChange(): a
// mutation made by something other than the dashboard itself (Claude/the CLI),
// of a kind the user hasn't opted out of, gets a durable inbox entry. Called
// right where each mutator below stamps lastEventType/lastEventSource, so it
// fires exactly once per real event — no polling/diffing needed — and works
// even with no dashboard tab open (the whole point: reminders and this queue
// now share one seam instead of the client deriving toasts from ticket diffs).
// Dedupes on ticketId+kind+the ticket's own updatedAt so a retried mutation (or
// any other double-call) can never enqueue the same event twice.
function queueEventNotification(slug, ticket, kind, source, extra) {
  if (!ticket || !source || String(source) === 'dashboard') return null; // your own action never notifies you
  if (NOTIFY_PREF_DEFAULTS[kind] == null) return null; // not an opt-in-able kind (e.g. 'edit'/'archived')
  if (!getNotifyPrefs()[kind]) return null; // opted out for this kind, globally
  const pmeta = readMeta(slug);
  if (pmeta && pmeta.notify === false) return null; // this whole board is muted
  const eventAt = ticket.updatedAt;
  const dup = readNotifications().some((n) => n.ticketId === ticket.id && n.kind === kind && n.ticketEventAt === eventAt);
  if (dup) return null;
  const copy = eventNotificationCopy(ticket, kind, extra);
  return addNotification({
    kind,
    title: copy.title,
    body: copy.body,
    projectSlug: slug,
    ticketRef: ticket.ref,
    ticketId: ticket.id,
    ticketEventAt: eventAt,
  });
}

// Mark one notification read (idempotent). Returns the updated record, or null
// if no such id.
function markRead(id) {
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

// Mark every unread notification read. Returns how many were flipped.
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

// Remove a notification outright. Returns true if one was removed.
function dismiss(id) {
  return withNotificationsLock(() => {
    const list = readNotifications();
    const kept = list.filter((n) => n.id !== id);
    if (kept.length === list.length) return false;
    writeNotifications(kept);
    return true;
  });
}

// Trim read history down to the cap. Returns how many were removed.
function pruneRead() {
  return withNotificationsLock(() => {
    const list = readNotifications();
    const pruned = pruneReadList(list);
    const removed = list.length - pruned.length;
    if (removed) writeNotifications(pruned);
    return removed;
  });
}

/* ------------------------------------------------------------------ *
 *  Reminders
 *
 *  A reminder *is* a notification (kind: 'reminder') whose fireAt is set in
 *  the future — listNotifications() above already hides those from the normal
 *  feed and shows them (unread) the instant fireAt passes. That means the
 *  "pending -> live" transition needs no explicit step: it's a pure function
 *  of the wall clock re-evaluated on every read, so it survives a server
 *  restart for free (nothing in memory to lose — it's re-derived from the
 *  persisted fireAt every time). What's left for this section: a per-ticket
 *  lookup so the dashboard can render a "bell in 1h" chip and offer to cancel
 *  it, and a small idempotent tick the running server can call periodically.
 * ------------------------------------------------------------------ */

// ticketId -> the single soonest still-pending (fireAt in the future) reminder
// for that ticket, built from one read of the notifications file. A ticket
// only ever has at most one pending reminder (setReminder enforces that), but
// this tolerates more turning up (e.g. hand-edited data) by picking the
// earliest.
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

// The pending reminder for a single ticket, or null.
function getPendingReminder(ticketId) {
  if (!ticketId) return null;
  return pendingReminders().get(ticketId) || null;
}

// Schedule (or reschedule) a reminder on a ticket. fireAt must parse to a
// moment in the future. At most one pending reminder per ticket — setting a
// new one cancels whatever was pending, same as "snoozing" it.
function setReminder(slug, idOrRef, fireAt) {
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

// Cancel whatever reminder is currently pending on a ticket. Not finding one
// isn't an error — cancelling a reminder that already fired (or never
// existed) is a no-op the caller can treat as success.
function cancelReminder(slug, idOrRef) {
  const ticket = getTicket(slug, idOrRef);
  if (!ticket) return { ok: false, reason: 'not_found' };
  return withNotificationsLock(() => {
    const list = readNotifications();
    const now = Date.now();
    let removed = 0;
    const kept = list.filter((n) => {
      const pending = n.kind === 'reminder' && n.ticketId === ticket.id &&
        n.fireAt && Number.isFinite(Date.parse(n.fireAt)) && Date.parse(n.fireAt) > now;
      if (pending) { removed++; return false; }
      return true;
    });
    if (removed) writeNotifications(kept);
    return { ok: true, removed };
  });
}

// Called periodically (and once at boot) by the running dashboard server.
// Marks any reminder whose fireAt has passed as fired — idempotent bookkeeping
// only, since the notification is already showing up (unread) in the live
// feed by virtue of fireAt <= now (see listNotifications). Re-reading the
// persisted fireAt on every call is what makes this restart-safe: a reminder
// due while the server was down is caught on the very next tick after it
// comes back up, with no separate "replay" logic needed.
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
  VALID_MODELS,
  homeRoot,
  projectsRoot,
  serverFile,
  slugify,
  projectDir,
  ensureProject,
  readMeta,
  listProjects,
  setProjectNotify,
  copyAsset,
  saveAssetData,
  assetPath,
  listTickets,
  getTicket,
  createTicket,
  updateTicket,
  deleteTicket,
  claimTicket,
  releaseTicket,
  completeTicket,
  claimNext,
  assignTicket,
  readyTickets,
  STORY_PALETTE,
  STORY_COLOR_NAMES,
  listStories,
  getStory,
  createStory,
  updateStory,
  deleteStory,
  addComment,
  needsResponse,
  linkTickets,
  unlinkTickets,
  openBlockers,
  isBlocked,
  archiveTicket,
  unarchiveTicket,
  archiveAllDone,
  listArchived,
  listActive,
  isClaimStale,
  normalizeLabels,
  NOTIFICATION_KINDS,
  listNotifications,
  addNotification,
  markRead,
  markAllRead,
  dismiss,
  pruneRead,
  getNotifyPrefs,
  setNotifyPrefs,
  pendingReminders,
  getPendingReminder,
  setReminder,
  cancelReminder,
  fireDueReminders,
  readServerInfo,
  writeServerInfo,
  clearServerInfo,
};
