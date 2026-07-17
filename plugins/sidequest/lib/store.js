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
const { execFileSync } = require('child_process');
const db = require('./db.js');
const { migrateIfNeeded } = require('./migrate.js');
const { discoverExternalModels } = require('./discovery.js');

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

// A git worktree's `.git` is a FILE, not a directory:
//     gitdir: C:/dev/repo/.git/worktrees/<name>
// Given that file, resolve the MAIN worktree root that owns it (C:\dev\repo)
// so a worktree never mints its own board. Returns null when this isn't a
// linked worktree we can trust locally, and the caller keeps today's behavior:
//   - the entry is a `.git` DIRECTORY (a real clone root) — not our job
//   - the gitdir points at `.../modules/...` (a submodule — a separate repo)
//   - the gitdir is missing/malformed, or points off THIS machine (a remote
//     clone, a container mount, another OS) so the computed root isn't real here
// Fail-soft throughout: any error returns null.
function mainWorktreeRoot(gitEntry) {
  let stat;
  try {
    stat = fs.statSync(gitEntry);
  } catch (_) {
    return null;
  }
  if (!stat.isFile()) return null; // a `.git` dir is a real repo root, leave it
  let content;
  try {
    content = fs.readFileSync(gitEntry, 'utf8');
  } catch (_) {
    return null;
  }
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(content);
  if (!m) return null;
  // gitdir is normally absolute; resolve relative forms against the worktree dir.
  let gitdir = m[1].replace(/[/\\]+$/, '');
  if (!path.isAbsolute(gitdir)) gitdir = path.resolve(path.dirname(gitEntry), gitdir);
  // Only linked worktrees (.git/worktrees/<name>) fold home. Submodules
  // (.git/modules/<name>) and anything else stay their own board.
  const parts = gitdir.split(/[/\\]+/);
  const wtIdx = parts.lastIndexOf('worktrees');
  if (wtIdx < 1) return null;
  // parts[0..wtIdx) is `.../.git`; the main worktree root is one level above it.
  const gitDirPath = parts.slice(0, wtIdx).join(path.sep);
  const root = path.dirname(gitDirPath);
  // Trust it only if that root actually exists on THIS filesystem — otherwise
  // the worktree points at a repo that isn't here, and we must not anchor a
  // board onto a phantom path.
  try {
    if (fs.statSync(root).isDirectory()) return path.resolve(root);
  } catch (_) { /* off-machine / moved — fall through to null */ }
  return null;
}

// Resolve startDir to the root of the project the agent is actually working in,
// so a board is always anchored there — never on a worktree, and never on a bare
// subfolder. Precedence, safest-first:
//
//   1. A path inside `<root>\.claude\worktrees\<name>` (the EnterWorktree
//      convention) folds straight back to <root>. Pure string match, no fs
//      trust: the worktree checkout may carry its OWN committed `.claude`, which
//      must NOT win — keying on the outermost `.claude/worktrees` guarantees the
//      real project root regardless.
//   2. Walk up to the nearest `.git`. A `.git` FILE is a linked worktree — fold
//      it to its main worktree root (works wherever the worktree sits on disk,
//      even far from the repo, because the file points home). A `.git` DIRECTORY
//      is a real clone root and wins, so a genuine nested/vendored repo keeps its
//      own board just like before.
//   3. A worktree we can't resolve locally (gitdir missing, off-machine, a
//      submodule) or a plain non-repo folder is returned unchanged — a
//      self-contained board on the dir you're actually in. Today's behavior.
//
// Fail-soft: any fs error stops the walk and falls back to the resolved startDir.
function nearestRepoRoot(startDir) {
  const start = path.resolve(startDir);

  // (1) EnterWorktree fast path — deterministic, no filesystem trust required.
  const wt = /^(.*?)[/\\]\.claude[/\\]worktrees[/\\]/i.exec(start + path.sep);
  if (wt && wt[1]) {
    const owner = path.resolve(wt[1]);
    try {
      if (fs.statSync(owner).isDirectory()) return owner;
    } catch (_) { /* owner gone — fall through to the git walk */ }
  }

  // (2) + (3) Walk up to the enclosing `.git`.
  let dir = start;
  for (;;) {
    try {
      const entry = path.join(dir, '.git');
      if (fs.existsSync(entry)) {
        return mainWorktreeRoot(entry) || dir;
      }
    } catch (_) {
      return start;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return start; // hit the filesystem root without a repo
    dir = parent;
  }
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

/* ------------------------------------------------------------------ *
 *  SQLite persistence
 * ------------------------------------------------------------------ */

const dbByHome = new Map();
const transactionDepth = new WeakMap();

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function database() {
  const root = homeRoot();
  let handle = dbByHome.get(root);
  if (!handle) {
    handle = db.openDb(root);
    migrateIfNeeded(handle, root);
    dbByHome.set(root, handle);
  }
  return handle;
}

function transaction(fn) {
  const handle = database();
  if (transactionDepth.get(handle)) return fn();
  transactionDepth.set(handle, 1);
  try {
    return db.txn(handle, fn);
  } finally {
    transactionDepth.delete(handle);
  }
}

function putProject(slug, meta) {
  db.putRow(database(), 'projects', { slug, data: meta });
}

function putTicket(slug, ticket) {
  const stored = Object.assign({}, ticket);
  if (stored.category && typeof stored.category === 'object') stored.category = stored.categoryId || stored.category.id;
  delete stored.categoryId;
  delete stored.warnings;
  delete stored.exec;
  delete stored.model;
  delete stored.effort;
  db.putRow(database(), 'tickets', {
    id: stored.id,
    project: slug,
    ref: stored.ref || null,
    status: stored.status || null,
    archived: stored.archived ? 1 : 0,
    ord: Number(stored.order) || 0,
    claim_by: stored.claim && stored.claim.by ? stored.claim.by : null,
    data: stored,
  });
}

function putStory(slug, story) {
  db.putRow(database(), 'stories', { id: story.id, project: slug, data: story });
}

function readGlobal(key, fallback) {
  const value = db.getRow(database(), 'globals', key);
  return value == null ? fallback : value;
}

function writeGlobal(key, value) {
  db.putRow(database(), 'globals', { key, data: value });
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

const CLAUDE_RUNTIMES = ['haiku', 'sonnet', 'opus', 'fable'];
const CLAUDE_RUNTIME_LABELS = {
  haiku: 'Claude Haiku', sonnet: 'Claude Sonnet',
  opus: 'Claude Opus', fable: 'Claude Fable',
};
const VALID_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const BACKEND_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;
const BACKEND_KEY_RE = /^([a-z0-9][a-z0-9-]{0,31}):([a-z0-9][a-z0-9-]{1,31})$/;
const HAIKU_BACKEND_EFFORT = 'medium';
const ROUTING_FALLBACK_DEFAULT = Object.freeze({ model: 'sonnet', effort: 'high' });

function coerceEffort(v) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  if (!s || s === 'any' || s === 'none' || s === 'null' || s === 'default') return null;
  return VALID_EFFORTS.includes(s) ? s : null;
}

function coerceComplexity(v) {
  if (v == null || String(v).trim() === '') return null;
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 1 && n <= 10 ? n : null;
}

function backendKey(source, slug) {
  return `${source}:${slug}`;
}

function discoveredByKey() {
  const out = {};
  for (const entry of discoverExternalModels()) out[backendKey(entry.source, entry.slug)] = entry;
  return out;
}

function discoveredBySlug() {
  const out = {};
  for (const entry of discoverExternalModels()) if (!(entry.slug in out)) out[entry.slug] = entry;
  return out;
}

function resolvedBackend(entry, discovered) {
  const agentSlug = discovered.filter((candidate) => candidate.slug === entry.slug).length > 1
    ? `${entry.source}-${entry.slug}`
    : entry.slug;
  return { backend: 'codex', source: entry.source, slug: entry.slug, agentSlug, id: entry.id, label: entry.label };
}

function normalizeRouteModel(model) {
  if (typeof model !== 'string') return null;
  const value = model.trim().toLowerCase();
  if (CLAUDE_RUNTIMES.includes(value)) return value;
  return BACKEND_SLUG_RE.test(value) || BACKEND_KEY_RE.test(value) ? value : null;
}

function availableRoute(model) {
  const normalized = normalizeRouteModel(model);
  if (!normalized) return null;
  if (CLAUDE_RUNTIMES.includes(normalized)) {
    return { backend: 'claude', source: null, slug: normalized, id: normalized, label: CLAUDE_RUNTIME_LABELS[normalized] };
  }
  const catalog = discoveredByKey();
  const discovered = Object.values(catalog);
  const entry = catalog[normalized] || discoveredBySlug()[normalized];
  return entry ? resolvedBackend(entry, discovered) : null;
}

// The id the codex-gateway shim forwards upstream for a discovered backend: its
// advertised id minus the local claude-codex- discovery prefix and any [1m]
// suffix. Dispatch briefings embed it as the [sidequest-route model=...] marker
// that resolves the shared executors' virtual claude-codex-auto pin (SQ-347).
function dispatchModelFor(id) {
  return String(id || '').replace(/^claude-codex-/, '').replace(/\[1m\]$/, '');
}

function execFromBackend(backend, effort) {
  if (backend.backend === 'codex') {
    const resolvedEffort = effort || HAIKU_BACKEND_EFFORT;
    return { agent: `sidequest-exec-dispatch-${resolvedEffort}`, effort: resolvedEffort, model: null, spawnId: backend.id, dispatchModel: dispatchModelFor(backend.id), backend: 'codex', source: backend.source, slug: backend.slug, runsModel: backend.slug, runsLabel: backend.label || backend.slug, dispatch: 'native-agent' };
  }
  const runtime = backend.slug;
  if (runtime === 'haiku' || !effort) {
    return { agent: null, model: runtime, spawnId: runtime, backend: 'claude', slug: runtime, runsModel: runtime, runsLabel: backend.label || CLAUDE_RUNTIME_LABELS[runtime], dispatch: 'native-agent' };
  }
  return { agent: `sidequest-exec-${effort}`, model: runtime, spawnId: runtime, backend: 'claude', slug: runtime, runsModel: runtime, runsLabel: backend.label || CLAUDE_RUNTIME_LABELS[runtime], dispatch: 'native-agent' };
}

function resolveExec(model, effort) {
  const backend = availableRoute(model);
  if (!backend) return null;
  return execFromBackend(backend, coerceEffort(effort));
}

function resolveModelId(model) {
  const exec = resolveExec(model, null);
  return exec ? exec.spawnId : null;
}

function routingModels() {
  const discovered = discoverExternalModels();
  return {
    models: CLAUDE_RUNTIMES.concat(discovered.map((entry) => entry.slug)),
    efforts: VALID_EFFORTS.slice(),
    discovered,
  };
}

function getModelVocab() {
  return routingModels();
}

function modelsPayload(opts) {
  opts = opts || {};
  const catalog = routingModels();
  const projectCategories = getProjectCategories(opts.project);
  return {
    models: catalog.models,
    efforts: catalog.efforts,
    discovered: catalog.discovered,
    globalFallback: getRoutingFallback(),
    categories: getCategories({ project: opts.project }).map((category) => {
      const resolved = resolveCategoryRoute(category);
      return Object.assign({}, category, {
        resolved: { model: resolved.model, effort: resolved.effort, exec: execProjection(resolved.exec) },
        warnings: resolved.warnings,
      });
    }),
    warnings: projectCategories.warnings,
  };
}

function classifyModelFilter(v) {
  if (v == null) return 'any';
  const value = String(v).trim().toLowerCase();
  if (!value || value === 'any' || value === 'none' || value === 'null') return 'any';
  const exec = resolveExec(value, null);
  return exec ? exec.runsModel : 'unknown';
}

function legacyCategoryForComplexity(value) {
  const complexity = coerceComplexity(value);
  if (!complexity) return null;
  if (complexity <= 3) return 'coding.easy';
  if (complexity <= 6) return 'coding.normal';
  return 'coding.hard';
}

function normalizeRoute(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const model = normalizeRouteModel(raw.model);
  const effort = coerceEffort(raw.effort);
  return model && effort ? { model, effort } : null;
}

function getRoutingFallback() {
  const stored = readGlobal('routing-fallback', null);
  return normalizeRoute(stored);
}

function setRoutingFallback(route) {
  const normalized = normalizeRoute(route);
  if (!normalized) throw new Error('Routing fallback requires a valid model and effort.');
  writeGlobal('routing-fallback', normalized);
  return normalized;
}

function projectCategoryRows(project) {
  if (!project) return [];
  return database().prepare('SELECT id, kind, data FROM project_categories WHERE project = ? ORDER BY id').all(project)
    .map((row) => {
      try {
        return { id: row.id, kind: row.kind, data: JSON.parse(row.data) };
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean);
}

function projectCategoryWarnings(project) {
  const globalIds = new Set(db.listRows(database(), 'categories').map((category) => String(category && category.id || '').trim().toLowerCase()));
  const warnings = [];
  // A board's customized category (DETACH) intentionally coexists with its
  // shared default — that's the normal forked state, not a warning. Only a
  // legacy OVERRIDE whose shared default is gone is worth flagging.
  for (const row of projectCategoryRows(project)) {
    if (row.kind === 'OVERRIDE' && !globalIds.has(row.id)) {
      warnings.push({ kind: 'dangling-override', id: row.id, project });
    }
  }
  return warnings;
}

function getCategoryRoutePairs() {
  const pairs = [];
  const seen = new Set();
  const add = (category) => {
    if (!category) return;
    const route = normalizeRoute(category.route);
    const fallback = category.fallback == null ? null : normalizeRoute(category.fallback);
    if (!route) return;
    const key = JSON.stringify({ route, fallback });
    if (seen.has(key)) return;
    seen.add(key);
    pairs.push({ route, fallback });
  };

  for (const category of getCategories()) add(category);

  const globals = new Map(getCategories().map((category) => [category.id, category]));
  let rows = [];
  try {
    rows = database().prepare('SELECT id, kind, data FROM project_categories ORDER BY project, id').all();
  } catch (_) {
    rows = [];
  }
  for (const row of rows) {
    if (row.kind === 'DISABLE') continue;
    let data;
    try { data = JSON.parse(row.data); } catch (_) { continue; }
    if (row.kind === 'ADD' || row.kind === 'DETACH') {
      add(normalizeCategory(data));
      continue;
    }
    if (row.kind === 'OVERRIDE') {
      const base = globals.get(String(row.id || '').trim().toLowerCase());
      if (base) add(normalizeCategory(Object.assign({}, base, data)));
    }
  }
  return pairs;
}

function getProjectCategories(project) {
  return { rows: projectCategoryRows(project), warnings: projectCategoryWarnings(project) };
}

function getCategories(opts) {
  opts = opts || {};
  const includeDisabled = opts.includeDisabled !== false;
  const withState = opts.withState === true;
  const categories = new Map();
  for (const raw of db.listRows(database(), 'categories')) {
    const category = normalizeCategory(raw);
    if (category) categories.set(category.id, withState ? Object.assign({}, category, { linkState: 'linked' }) : category);
  }
  for (const row of projectCategoryRows(opts.project)) {
    const base = categories.get(row.id);
    if (row.kind === 'ADD' && !base) {
      const category = normalizeCategory(row.data);
      if (category) categories.set(category.id, withState ? Object.assign({}, category, { linkState: 'added' }) : category);
    } else if (row.kind === 'DETACH') {
      const category = normalizeCategory(row.data);
      if (category) categories.set(category.id, withState ? Object.assign({}, category, { linkState: 'detached' }) : category);
    } else if (row.kind === 'OVERRIDE' && base) {
      const category = normalizeCategory(Object.assign({}, base, row.data));
      if (category) {
        categories.set(category.id, withState
          ? Object.assign({}, category, { linkState: 'overridden', changedFields: Object.keys(row.data).sort() })
          : category);
      }
    } else if (row.kind === 'DISABLE' && row.id !== 'general' && base) {
      categories.delete(row.id);
    }
  }
  return [...categories.values()]
    .filter((category) => includeDisabled || category.enabled)
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

function normalizeCategoryId(id) {
  return String(id || '').trim().toLowerCase();
}

function getCategory(id, opts) {
  const normalizedId = normalizeCategoryId(id);
  return getCategories(opts).find((category) => category.id === normalizedId) || null;
}

function normalizeCategory(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = normalizeCategoryId(raw.id);
  if (!id) return null;
  const route = normalizeRoute(raw.route) || { model: 'sonnet', effort: 'medium' };
  const fallback = raw.fallback == null ? null : normalizeRoute(raw.fallback);
  return {
    id,
    name: String(raw.name || id).trim().slice(0, 120) || id,
    description: String(raw.description || '').trim(),
    route,
    fallback,
    contract: String(raw.contract || '').trim(),
    enabled: raw.enabled !== false,
  };
}

function setCategory(categoryOrId, patch) {
  const requested = typeof categoryOrId === 'string'
    ? Object.assign({}, getCategory(categoryOrId), patch || {}, { id: normalizeCategoryId(categoryOrId) })
    : categoryOrId;
  const normalized = normalizeCategory(requested);
  if (!normalized) throw new Error('Category id is required.');
  if (!normalizeRoute(requested && requested.route)) throw new Error('Category route requires a valid model and effort.');
  if (requested && requested.fallback != null && !normalizeRoute(requested.fallback)) throw new Error('Category fallback requires a valid model and effort.');
  if (normalized.id === 'general' && !normalized.enabled) throw new Error('Category "general" cannot be disabled.');
  db.putRow(database(), 'categories', { id: normalized.id, data: normalized });
  return normalized;
}

function removeCategory(id) {
  const normalizedId = normalizeCategoryId(id);
  if (normalizedId === 'general') throw new Error('Category "general" cannot be removed.');
  return transaction(() => {
    // A project that only customized (OVERRODE) this global category holds a
    // partial patch that inherits the rest from global. Once the global row is
    // gone that patch would dangle and the board would drop into a broken
    // "global category missing" state. Freeze each such customization into a
    // full local (pinned/DETACH) copy of its effective value so the board keeps
    // a working category instead.
    const base = getCategory(normalizedId);
    if (base) {
      const overrides = database()
        .prepare("SELECT project, data FROM project_categories WHERE id = ? AND kind = 'OVERRIDE'")
        .all(normalizedId);
      for (const row of overrides) {
        let patch;
        try { patch = JSON.parse(row.data); } catch (_) { patch = {}; }
        const pinned = normalizeCategory(Object.assign({}, base, patch, { id: normalizedId }));
        if (pinned) db.putRow(database(), 'project_categories', { project: row.project, id: normalizedId, kind: 'DETACH', data: pinned });
      }
    }
    return db.deleteRow(database(), 'categories', normalizedId);
  });
}

function normalizeFullProjectCategory(id, kind, data) {
  const required = ['name', 'description', 'contract', 'route', 'fallback', 'enabled'];
  if (!data || typeof data !== 'object' || Array.isArray(data) || required.some((key) => !Object.hasOwn(data, key))) {
    throw new Error(`Project category ${kind} requires a complete category row.`);
  }
  const normalized = normalizeCategory(Object.assign({}, data, { id }));
  if (!normalized || !normalizeRoute(data.route)) throw new Error(`Project category ${kind} requires a valid full category route.`);
  if (data.fallback != null && !normalizeRoute(data.fallback)) throw new Error(`Project category ${kind} fallback requires a valid model and effort.`);
  return normalized;
}

function setProjectCategory(project, id, kind, data) {
  const normalizedProject = String(project || '').trim();
  const normalizedId = normalizeCategoryId(id);
  const normalizedKind = String(kind || '').trim().toUpperCase();
  if (!normalizedProject || !normalizedId) throw new Error('Project and category id are required.');
  if (!['ADD', 'OVERRIDE', 'DETACH', 'DISABLE'].includes(normalizedKind)) throw new Error('Project category kind must be ADD, OVERRIDE, DETACH, or DISABLE.');
  const global = getCategory(normalizedId);
  let normalizedData;
  if (normalizedKind === 'ADD') {
    if (global) throw new Error(`Project category ADD "${normalizedId}" collides with a global category.`);
    normalizedData = normalizeFullProjectCategory(normalizedId, normalizedKind, data);
  } else if (normalizedKind === 'DETACH') {
    normalizedData = normalizeFullProjectCategory(normalizedId, normalizedKind, data);
  } else if (normalizedKind === 'OVERRIDE') {
    if (!global) throw new Error(`Project category OVERRIDE "${normalizedId}" requires a global category.`);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Project category OVERRIDE requires a patch object.');
    const allowed = new Set(['name', 'description', 'contract', 'route', 'fallback']);
    for (const key of Object.keys(data)) if (!allowed.has(key)) throw new Error(`Project category OVERRIDE cannot patch "${key}".`);
    if (data.route != null && !normalizeRoute(data.route)) throw new Error('Project category OVERRIDE route requires a valid model and effort.');
    if (data.fallback != null && !normalizeRoute(data.fallback)) throw new Error('Project category OVERRIDE fallback requires a valid model and effort.');
    normalizedData = Object.assign({}, data);
  } else {
    if (normalizedId === 'general') throw new Error('Category "general" cannot be disabled.');
    if (!global) throw new Error(`Project category DISABLE "${normalizedId}" requires a global category.`);
    normalizedData = {};
  }
  db.putRow(database(), 'project_categories', { project: normalizedProject, id: normalizedId, kind: normalizedKind, data: normalizedData });
  return { project: normalizedProject, id: normalizedId, kind: normalizedKind, data: normalizedData };
}

function detachCategory(project, id) {
  const normalizedProject = String(project || '').trim();
  const normalizedId = normalizeCategoryId(id);
  if (!normalizedProject || !normalizedId) throw new Error('Project and category id are required.');
  const existing = projectCategoryRows(normalizedProject).find((row) => row.id === normalizedId);
  if (existing && existing.kind === 'DETACH') throw new Error(`Project category "${normalizedId}" is already detached.`);
  const category = getCategory(normalizedId, { project: normalizedProject });
  if (!category) throw new Error(`Project category "${normalizedId}" does not resolve to a category.`);
  return setProjectCategory(normalizedProject, normalizedId, 'DETACH', category);
}

function removeProjectCategory(project, id) {
  const normalizedProject = String(project || '').trim();
  const normalizedId = normalizeCategoryId(id);
  if (!normalizedProject || !normalizedId) throw new Error('Project and category id are required.');
  return db.deleteRow(database(), 'project_categories', { project: normalizedProject, id: normalizedId });
}

function classifierCategories(opts) {
  return getCategories(Object.assign({}, opts, { includeDisabled: false })).map(({ id, name, description, route, fallback, contract }) => ({ id, name, description, route, fallback, contract }));
}

function resolveCategoryRoute(category) {
  const warnings = [];
  const candidates = [
    { name: 'route', route: category && category.route },
    { name: 'category fallback', route: category && category.fallback },
    { name: 'global fallback', route: getRoutingFallback() },
  ];
  for (const candidate of candidates) {
    const route = normalizeRoute(candidate.route);
    if (!route) continue;
    const exec = resolveExec(route.model, route.effort);
    if (exec) return { model: exec.runsModel, effort: route.effort, exec, warnings };
    warnings.push(`Category "${category.id}" ${candidate.name} model "${route.model}" isn't currently available.`);
  }
  const route = ROUTING_FALLBACK_DEFAULT;
  warnings.push('Global routing fallback is missing or invalid; using hardwired sonnet/high.');
  return { model: route.model, effort: route.effort, exec: resolveExec(route.model, route.effort), warnings };
}

function ticketCategory(ticket) {
  if (!ticket || ticket.category == null) return null;
  return typeof ticket.category === 'object' ? ticket.categoryId || ticket.category.id : String(ticket.category);
}

function execProjection(exec) {
  return { agent: exec.agent, model: exec.model, backend: exec.backend, runsModel: exec.runsModel, runsLabel: exec.runsLabel, dispatch: exec.dispatch };
}

function applyDerivedRouting(t, opts) {
  if (!t) return t;
  opts = opts || {};
  const project = opts.project || t.project;
  let requestedCategory = ticketCategory(t);
  const warnings = Array.isArray(t.warnings) ? t.warnings.slice() : [];
  let legacy = false;
  if (requestedCategory == null && t.complexity != null) {
    requestedCategory = legacyCategoryForComplexity(t.complexity);
    legacy = !!requestedCategory;
    if (legacy) warnings.push(`Legacy complexity ${coerceComplexity(t.complexity)} mapped to ${requestedCategory}; update the ticket to persist a category.`);
  }
  if (requestedCategory != null) {
    const requestedId = String(requestedCategory).trim().toLowerCase();
    let category = getCategory(requestedId, { project });
    let fallback = false;
    if (!category || !category.enabled) {
      fallback = true;
      warnings.push(`Category "${requestedId}" is unknown or disabled; falling back to "general".`);
      category = getCategory('general', { project });
    }
    if (category) {
      const resolved = resolveCategoryRoute(category);
      if (!legacy) t.categoryId = requestedId;
      t.category = Object.assign({}, category, { projectedFromGeneral: fallback });
      t.model = resolved.model;
      t.effort = resolved.effort;
      t.exec = execProjection(resolved.exec);
      warnings.push(...resolved.warnings);
    }
  } else {
    t.category = null;
    delete t.model;
    delete t.effort;
    delete t.exec;
  }
  delete t.profile;
  if (warnings.length) t.warnings = warnings;
  else delete t.warnings;
  return t;
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
  let meta = readMeta(slug);
  if (!meta || typeof meta !== 'object') {
    meta = { path: resolved, name: name || defaultProjectName(resolved), createdAt: new Date().toISOString(), seq: 0, storySeq: 0 };
    putProject(slug, meta);
  } else {
    // ensureProject runs on ordinary reads/writes, so restoring a board is
    // unarchiveProject's job. Keep meta.archivedAt intact here.
    let dirty = false;
    if (meta.path !== resolved) { meta.path = resolved; dirty = true; }
    if (name && meta.name !== name) { meta.name = name; dirty = true; }
    if (!meta.name) { meta.name = defaultProjectName(resolved); dirty = true; }
    if (typeof meta.seq !== 'number') { meta.seq = 0; dirty = true; }
    if (typeof meta.storySeq !== 'number') { meta.storySeq = 0; dirty = true; }
    if (dirty) putProject(slug, meta);
  }
  return { slug, dir, meta };
}

function readMeta(slug) {
  return db.getRow(database(), 'projects', slug);
}

function metaLockPath(slug) {
  return path.join(projectDir(slug), '.meta.lock');
}

function withMetaLock(slug, fn) {
  const lock = metaLockPath(slug);
  const locked = acquireLock(lock);
  try {
    return transaction(fn);
  } finally {
    if (locked) releaseLock(lock);
  }
}

// Locked read-modify-write so two concurrent createTicket calls never mint the
// same human-facing SQ-N ref (a bare read+increment+write here would race).
// acquireLock already retries internally on contention; if it still can't get
// the lock (e.g. a wedged/unwritable dir), fall back to an unlocked bump rather
// than blocking ticket creation entirely.
function nextSeq(slug) {
  return withMetaLock(slug, () => {
    const meta = readMeta(slug) || { seq: 0 };
    meta.seq = (typeof meta.seq === 'number' ? meta.seq : 0) + 1;
    putProject(slug, meta);
    return meta.seq;
  });
}

// The story counter is a second monotonic sequence on the same project row,
// minting US-1, US-2, … independently of the SQ-N ticket refs.
function nextStorySeq(slug) {
  return withMetaLock(slug, () => {
    const meta = readMeta(slug) || { storySeq: 0 };
    meta.storySeq = (typeof meta.storySeq === 'number' ? meta.storySeq : 0) + 1;
    putProject(slug, meta);
    return meta.storySeq;
  });
}

// Turn a board's per-project notifications on or off. When off, the board is
// muted: queueEventNotification below drops every background event for it, even
// with a dashboard tab open. Stored on the project row (absent == on).
function setProjectNotify(slug, on) {
  return withMetaLock(slug, () => {
    const meta = readMeta(slug);
    if (!meta) return { ok: false, reason: 'not_found' };
    meta.notify = on !== false;
    putProject(slug, meta);
    return { ok: true, notify: meta.notify };
  });
}

// Board-level archive is a reversible project-row stamp. Project data and tickets
// remain in place, and repeat calls keep the original archive timestamp.
function archiveProject(slug) {
  return withMetaLock(slug, () => {
    const meta = readMeta(slug);
    if (!meta) return { ok: false, reason: 'not_found' };
    if (meta.archivedAt) return { ok: true, slug, archivedAt: meta.archivedAt, alreadyArchived: true };
    meta.archivedAt = new Date().toISOString();
    putProject(slug, meta);
    return { ok: true, slug, archivedAt: meta.archivedAt, alreadyArchived: false };
  });
}

function unarchiveProject(slug) {
  return withMetaLock(slug, () => {
    const meta = readMeta(slug);
    if (!meta) return { ok: false, reason: 'not_found' };
    if (!meta.archivedAt) return { ok: true, slug, wasArchived: false };
    delete meta.archivedAt;
    putProject(slug, meta);
    return { ok: true, slug, wasArchived: true };
  });
}

// Permanent deletion is deliberately strict: callers must already have the exact
// stored slug. This avoids turning an untrusted display name or path into a new
// project lookup at a destructive boundary.
function deleteProjectExact(slug) {
  if (typeof slug !== 'string' || !/^[a-z0-9][a-z0-9-]{1,80}$/.test(slug)) return { ok: false, reason: 'not_found' };
  if (!readMeta(slug)) return { ok: false, reason: 'not_found' };
  transaction(() => {
    for (const ticket of db.listRows(database(), 'tickets', { project: slug })) db.deleteRow(database(), 'tickets', ticket.id);
    for (const story of db.listRows(database(), 'stories', { project: slug })) db.deleteRow(database(), 'stories', story.id);
    db.deleteRow(database(), 'projects', slug);
  });
  fs.rmSync(projectDir(slug), { recursive: true, force: true });
  return { ok: true, slug };
}

// List every registered project with live ticket counts. Sorted by most recent
// activity so the busiest board floats to the top of the switcher. By default,
// archived boards are hidden. Pass { archived: true } to list only archived
// boards, or { all: true } for internal resolution.
function listProjects(opts) {
  opts = opts || {};
  const out = [];
  for (const meta of db.listRows(database(), 'projects')) {
    if (!meta || !meta.path) continue;
    const slug = slugify(meta.path);
    const archivedAt = meta.archivedAt || null;
    if (!opts.all && (opts.archived ? !archivedAt : !!archivedAt)) continue;
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
      archivedAt,
    });
  }
  out.sort((a, b) => String(b.lastActivity || '').localeCompare(String(a.lastActivity || '')));
  return out;
}

// Resolve a caller-supplied --project reference to the ONE already-registered
// board it names — an exact slug, a case-insensitive display NAME, or a
// filesystem path. NEVER creates or matches anything outside the registered
// set (see SQ-86): a name is not a slug, so a bare display name used to miss
// the slug lookup, fall into ensureProject(), and get treated as a raw path
// resolved against cwd — silently minting a phantom empty board that happened
// to share the real project's display name (or a real one's if two directories
// share a basename, e.g. "BMR" run from both C:\dev\BMR and C:\dev\BMR\BMR).
// Returns { ok:true, slug, meta } on a clean match, or { ok:false, reason,
// ...} for the caller (the CLI) to turn into a hard error:
//   - reason 'ambiguous' + matches: 2+ registered boards share that NAME —
//     the caller must re-run with the disambiguating path.
//   - reason 'not_found' + known: nothing matched — known is the list of
//     registered display names to surface in the error.
function findProject(ref) {
  const arg = String(ref == null ? '' : ref).trim();
  const all = listProjects({ all: true });
  if (!arg) return { ok: false, reason: 'not_found', known: all.map((p) => p.name) };

  // 1. An exact slug of an existing board (the historical fast path — a few
  // internal callers, like the dashboard, already pass a real slug).
  const bySlugMeta = readMeta(arg);
  if (bySlugMeta) return { ok: true, slug: arg, meta: bySlugMeta };

  // 2. A case-insensitive exact match on the display NAME.
  const wantedName = arg.toLowerCase();
  const byName = all.filter((p) => String(p.name).trim().toLowerCase() === wantedName);
  if (byName.length === 1) {
    const meta = readMeta(byName[0].slug);
    if (meta) return { ok: true, slug: byName[0].slug, meta };
  } else if (byName.length > 1) {
    return { ok: false, reason: 'ambiguous', matches: byName };
  }

  // 3. A filesystem path matching an ALREADY-REGISTERED project's path. Never
  // registers a new one at this path — that would just reopen the SQ-86 hole.
  const wantedPath = normalizeForHash(path.resolve(arg));
  const byPath = all.find((p) => p.path && normalizeForHash(path.resolve(p.path)) === wantedPath);
  if (byPath) {
    const meta = readMeta(byPath.slug);
    if (meta) return { ok: true, slug: byPath.slug, meta };
  }

  return { ok: false, reason: 'not_found', known: all.map((p) => p.name) };
}

// Fold one board (src) entirely into another (dest): move every ticket, story,
// and attached asset over, then delete the source board. Used to collapse the
// duplicate boards that older versions minted when the CLI ran from a subfolder
// (see nearestRepoRoot / SQ-94). The renumbering rules that make this safe:
//   - Ticket SQ-n / story US-n refs are re-minted ABOVE dest's live counters
//     (via nextSeq/nextStorySeq), so they never collide with dest's own refs.
//   - Stable ids (tk_… / st_…) are kept as-is. They're globally unique, so the
//     ticket/story JSON drops into dest without a filename clash, the assets
//     folder (keyed by ticket id) copies 1:1, and a ticket's storyId (which
//     points at a story's stable id, never its ref) still resolves after the
//     move — no membership is orphaned.
//   - Intra-board links (links[].ref, which point by SQ-ref) are rewritten
//     through the old->new ref map so dependencies survive the renumber.
// dryRun computes and returns the same mapping without touching disk. Returns
// { tickets, stories, mapping: [{ from, to, title }] }.
function mergeProject(srcSlug, destSlug, opts) {
  opts = opts || {};
  const dryRun = !!opts.dryRun;
  if (srcSlug === destSlug) throw new Error('source and destination are the same board');
  if (!readMeta(srcSlug)) throw new Error(`source board "${srcSlug}" does not exist`);
  if (!readMeta(destSlug)) throw new Error(`destination board "${destSlug}" does not exist`);

  // Oldest-first so re-minted refs preserve the source's creation order.
  const tickets = listTickets(srcSlug).slice().sort((a, b) => seqOfRef(a.ref) - seqOfRef(b.ref));
  const stories = listStories(srcSlug); // listStories already returns oldest-first

  // Plan the ref renumbering up front so link remapping can see every mapping.
  const refMap = {}; // OLD-TICKET-REF (upper) -> NEW-TICKET-REF
  const ticketPlan = [];
  for (const t of tickets) {
    const newRef = dryRun ? `SQ-?` : `SQ-${nextSeq(destSlug)}`;
    if (t.ref) refMap[String(t.ref).toUpperCase()] = newRef;
    ticketPlan.push({ ticket: t, newRef });
  }
  const storyPlan = [];
  for (const s of stories) {
    const newRef = dryRun ? `US-?` : `US-${nextStorySeq(destSlug)}`;
    storyPlan.push({ story: s, newRef });
  }

  const mapping = ticketPlan.map(({ ticket, newRef }) => ({ from: ticket.ref, to: newRef, title: ticket.title }));
  if (dryRun) return { tickets: ticketPlan.length, stories: storyPlan.length, mapping };

  // Stories first, so a moved ticket's storyId still finds its story in dest.
  transaction(() => {
    for (const ticket of tickets) db.deleteRow(database(), 'tickets', ticket.id);
    for (const story of stories) db.deleteRow(database(), 'stories', story.id);
    for (const { story, newRef } of storyPlan) {
      const moved = Object.assign({}, story, { ref: newRef });
      putStory(destSlug, moved);
    }
    for (const { ticket, newRef } of ticketPlan) {
      const links = Array.isArray(ticket.links)
        ? ticket.links.map((l) => Object.assign({}, l, { ref: refMap[String(l.ref).toUpperCase()] || l.ref }))
        : [];
      const moved = Object.assign({}, ticket, { ref: newRef, links });
      putTicket(destSlug, moved);
      const srcAssets = assetsDir(srcSlug, ticket.id);
      if (fs.existsSync(srcAssets)) {
        try {
          fs.cpSync(srcAssets, assetsDir(destSlug, ticket.id), { recursive: true });
        } catch (_) {
          /* an unreadable asset folder shouldn't abort the whole merge */
        }
      }
    }
    db.deleteRow(database(), 'projects', srcSlug);
  });

  try {
    fs.rmSync(projectDir(srcSlug), { recursive: true, force: true });
  } catch (_) {
    /* best effort; the tickets already live in dest */
  }
  return { tickets: ticketPlan.length, stories: storyPlan.length, mapping };
}

// Pull the numeric sequence out of an "SQ-12" ref for ordering; junk sorts last.
function seqOfRef(ref) {
  const m = /(\d+)\s*$/.exec(String(ref || ''));
  return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
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

function listTickets(slug) {
  const out = [];
  for (const t of db.listRows(database(), 'tickets', { project: slug })) {
    if (t && t.id) out.push(applyDerivedRouting(t, { project: slug }));
  }
  // Newest first by order (falls back to createdAt); the UI re-groups by column.
  out.sort((a, b) => (b.order || 0) - (a.order || 0));
  return out;
}

function getTicket(slug, idOrRef) {
  const wanted = String(idOrRef);
  const wantedRef = wanted.toUpperCase();
  for (const t of listTickets(slug)) {
    if (t.id === wanted || String(t.ref).toUpperCase() === wantedRef) return t;
  }
  return null;
}

function coerceStatus(s, fallback) {
  s = String(s || '').toLowerCase();
  return VALID_STATUS.includes(s) ? s : fallback;
}

function requireStatus(s) {
  const status = String(s).toLowerCase();
  if (!VALID_STATUS.includes(status)) {
    throw new Error(`Invalid status "${s}". Valid statuses: ${VALID_STATUS.join(', ')}. Deletion is not a status; use the MCP remove tool or CLI rm.`);
  }
  return status;
}
function coercePriority(p, fallback) {
  p = String(p || '').toLowerCase();
  return VALID_PRIORITY.includes(p) ? p : fallback;
}

const EXECUTOR_ANCHORS_MAX = 4000;
const EXECUTOR_VERIFY_MAX = 1000;

// Per-ticket executor context stays deliberately small: this data may be passed
// through a Windows command surface with an 8191-character ceiling. Keep the
// anchors as written so the eventual executor prompt can carry them verbatim.
function executorText(value, max, label) {
  if (value == null) return '';
  const text = String(value);
  if (text.length > max) throw new Error(`${label} exceeds the ${max}-character executor-context limit.`);
  return text;
}

function ticketReferenceWarnings(slug, title, description) {
  const refs = new Set((`${title || ''}\n${description || ''}`.match(/\bSQ-\d+\b/gi) || []).map((ref) => ref.toUpperCase()));
  if (!refs.size) return [];
  const known = new Set(listTickets(slug).map((ticket) => String(ticket.ref).toUpperCase()));
  const unknown = [...refs].filter((ref) => !known.has(ref));
  return unknown.length ? [`Unknown ticket refs: ${unknown.join(', ')}.`] : [];
}

function ticketPlanningWarnings(ticket, projectPath) {
  if (!ticket) return [];
  const warnings = [];
  if (Number(ticket.complexity) >= 4) {
    const missing = [];
    if (!String(ticket.executorAnchors || '').trim()) missing.push('executor anchors');
    if (!String(ticket.executorVerify || '').trim()) missing.push('verify command');
    if (!Array.isArray(ticket.files) || !ticket.files.length) missing.push('file scope');
    if (missing.length) {
      warnings.push(`Planning-depth warning: complexity 4+ tickets should include executor anchors, an exact verify command, and declared file scope before dispatch; missing: ${missing.join(', ')}.`);
    }
  }
  if (!projectPath || !Array.isArray(ticket.files)) return warnings;
  const absent = ticket.files.filter((file) => !fs.existsSync(path.resolve(projectPath, file)));
  if (absent.length) warnings.push(`Planning-depth warning: declared file scope does not exist in the repo: ${absent.join(', ')}.`);
  return warnings;
}

function createTicket(slug, fields) {
  fields = fields || {};
  const status = fields.status === undefined ? 'todo' : requireStatus(fields.status);
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
    status,
    priority: coercePriority(fields.priority, 'normal'),
    labels: normalizeLabels(fields.labels),
    storyId: coerceStoryId(slug, fields.storyId), // the user story this ticket belongs to (null = none)
    category: fields.category == null ? null : String(fields.category).trim().toLowerCase() || null,
    complexity: coerceComplexity(fields.complexity), // 1..10 score the routing is derived from (entry points require it)
    complexityWhy: String(fields.complexityWhy || '').trim().slice(0, 1000), // the mandatory motivation for the score
    files: normalizeFiles(fields.files),          // declared file scope, for parallel-wave planning
    executorAnchors: executorText(fields.executorAnchors, EXECUTOR_ANCHORS_MAX, 'executor anchors'),
    executorVerify: executorText(fields.executorVerify, EXECUTOR_VERIFY_MAX, 'executor verify command'),
    assets,
    comments: [],              // [{ id, by, body, kind: 'comment'|'question', at }]
    links: [],                 // [{ type: 'blocks'|'blocked-by'|'related', ref }]
    claim: null,               // { by, at } when an agent has claimed it to work on
    dispatchNonce: null,
    dispatchExecutor: null,
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
  putTicket(slug, ticket);
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

// A ticket's declared file scope drives wave planning and gates repository commits
// submitted through the Sidequest executor path.
function normalizeFiles(files) {
  if (!files) return [];
  const arr = Array.isArray(files) ? files : String(files).split(',');
  const seen = new Set();
  const out = [];
  for (const f of arr) {
    const v = String(f).trim().replace(/\\/g, '/').replace(/\/+$/, '').slice(0, 200);
    if (v && !seen.has(v.toLowerCase())) {
      seen.add(v.toLowerCase());
      out.push(v);
    }
  }
  return out.slice(0, 20);
}

// Do two declared scopes collide? A path conflicts with an equal path or with
// one that is a directory-prefix of it (case-insensitive, "/"-normalized).
// Empty scopes never conflict mechanically — "no declaration" means "no
// information", and the skill tells the orchestrator how to treat that.
function scopesOverlap(filesA, filesB) {
  const a = normalizeFiles(filesA).map((f) => f.toLowerCase());
  const b = normalizeFiles(filesB).map((f) => f.toLowerCase());
  if (!a.length || !b.length) return false;
  for (const x of a) {
    for (const y of b) {
      if (x === y || x.startsWith(y + '/') || y.startsWith(x + '/')) return true;
    }
  }
  return false;
}

// Partition the ready set into waves an orchestrator can fan out one wave at a
// time: within a wave no two tickets' declared scopes overlap. Greedy first-fit
// in priority order, so wave 1 is "start these now", wave 2 "after wave 1",
// etc. Tickets with no declared files never mechanically conflict (see above).
function readyWaves(slug, opts) {
  const ready = readyTickets(slug, opts);
  const waves = [];
  for (const t of ready) {
    let placed = false;
    for (const wave of waves) {
      if (!wave.some((w) => scopesOverlap(w.files, t.files))) {
        wave.push(t);
        placed = true;
        break;
      }
    }
    if (!placed) waves.push([t]);
  }
  return waves;
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
    if (patch.status != null) t.status = requireStatus(patch.status);
    if (patch.priority != null) t.priority = coercePriority(patch.priority, t.priority);
    if (patch.labels != null) t.labels = normalizeLabels(patch.labels);
    if (patch.storyId !== undefined) t.storyId = coerceStoryId(slug, patch.storyId);
    if (patch.category !== undefined) t.category = patch.category == null ? null : String(patch.category).trim().toLowerCase() || null;
    // Complexity can move to another valid score, never clear; a fresh motivation
    // rides along whenever one is provided (the CLI demands one on change).
    if (patch.complexity !== undefined) { const c = coerceComplexity(patch.complexity); if (c) t.complexity = c; }
    if (patch.complexityWhy !== undefined && String(patch.complexityWhy).trim()) t.complexityWhy = String(patch.complexityWhy).trim().slice(0, 1000);
    if (patch.files !== undefined) t.files = normalizeFiles(patch.files);
    if (patch.executorAnchors !== undefined) t.executorAnchors = executorText(patch.executorAnchors, EXECUTOR_ANCHORS_MAX, 'executor anchors');
    if (patch.executorVerify !== undefined) t.executorVerify = executorText(patch.executorVerify, EXECUTOR_VERIFY_MAX, 'executor verify command');
    // A provenance stamp may ride along a patch (e.g. the dashboard completing a
    // ticket). Permissive like the routing fields above: a valid stamp is set, a
    // bad one is ignored rather than thrown (the data layer never crashes a write).
    if (patch.workedBy !== undefined) {
      try { const w = makeWorkedBy(patch.workedBy); if (w) t.workedBy = w; } catch (_) { /* ignore an invalid stamp on a patch */ }
    }
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
    putTicket(slug, t);
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
  let ok = false;
  try {
    ok = db.deleteRow(database(), 'tickets', found.id);
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
    putTicket(slug, t);
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

const DEFAULT_CLAIM_TTL_MIN = 60;

// How long a claim stays valid without being refreshed before another worker
// may take it over (a crashed/abandoned worker must never wedge a ticket).
function claimTtlMs() {
  const min = Number(process.env.SIDEQUEST_CLAIM_TTL_MIN);
  return (Number.isFinite(min) && min > 0 ? min : DEFAULT_CLAIM_TTL_MIN) * 60 * 1000;
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
    return transaction(fn);
  } finally {
    releaseLock(lock);
  }
}

function dispatchExecutorName(ticket) {
  if (!ticket || !ticket.ref || !ticket.model || !ticket.effort) throw new Error('dispatch executor requires a routable ticket.');
  const resolved = resolveExec(ticket.model, ticket.effort);
  if (!resolved || !resolved.runsModel) throw new Error(`dispatch executor could not resolve ${ticket.model} at ${ticket.effort}.`);
  const ref = String(ticket.ref).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'ticket';
  const runtime = String(resolved.runsModel).toLowerCase().replace(/^codex-/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const base = runtime ? `sidequest-ticket-${ref}-${runtime}` : `sidequest-ticket-${ref}`;
  let name;
  do {
    name = `${base}-${crypto.randomBytes(4).toString('hex')}`;
  } while (name === ticket.dispatchExecutor);
  return name;
}

// The STABLE, session-start-registered executor for a ticket's route (e.g.
// sidequest-exec-xhigh, or the shared Codex sidequest-exec-dispatch-high whose
// model the gateway resolves from the briefing's route marker).
// Instant dispatch targets this instead of a fresh per-ticket definition: it is
// already registered, so there is no watcher-registration wait and no def file.
// A route with no stable executor (haiku, agent:null) has no instant target —
// throw so the dispatch surface can steer the caller to --ephemeral.
function stableExecutorName(ticket) {
  if (!ticket || !ticket.model || !ticket.effort) throw new Error('dispatch executor requires a routable ticket.');
  const resolved = resolveExec(ticket.model, ticket.effort);
  if (!resolved || !resolved.agent) throw new Error(`no stable executor for ${ticket.model} at ${ticket.effort} — dispatch with --ephemeral.`);
  return resolved.agent;
}

// Prepare a ticket for dispatch: persist a fresh claim nonce and the executor
// name the claim guard will require. Default (instant) mode points
// dispatchExecutor at the STABLE per-model executor, so the briefing + token can
// ride the spawn prompt with no def write and no registration wait. opts.ephemeral
// keeps the legacy behavior — a unique per-ticket executor name whose self-contained
// definition any session can later adopt.
function prepareDispatch(slug, idOrRef, opts) {
  opts = opts || {};
  const found = getTicket(slug, idOrRef);
  if (!found) throw new Error(`prepare dispatch: no ticket "${idOrRef}".`);
  return withTicketLock(slug, found.id, () => {
    const t = getTicket(slug, found.id);
    if (!t) throw new Error(`prepare dispatch: no ticket "${idOrRef}".`);
    t.dispatchNonce = crypto.randomBytes(24).toString('base64url');
    t.dispatchExecutor = opts.ephemeral ? dispatchExecutorName(t) : stableExecutorName(t);
    t.updatedAt = new Date().toISOString();
    putTicket(slug, t);
    return { ok: true, ticket: t, token: t.dispatchNonce, ephemeral: !!opts.ephemeral };
  });
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
    if (t.dispatchNonce && opts.token !== t.dispatchNonce) return { ok: false, reason: 'token', ticket: t };
    if (t.dispatchNonce && opts.executor !== t.dispatchExecutor) return { ok: false, reason: 'executor_mismatch', ticket: t, expectedExecutor: t.dispatchExecutor };
    if (t.status === 'done') return { ok: false, reason: 'done', ticket: t };
    // Submitted work awaits the orchestrator's publish transaction, not another
    // executor: re-claiming it would fork the already-verified commit. The
    // orchestrator clears the submission first when rework is genuinely wanted.
    if (pendingSubmission(t) && !opts.force) return { ok: false, reason: 'submitted', ticket: t, submission: t.submission };
    const held = t.claim;
    if (held && held.by && held.by !== by && !isClaimStale(held) && !opts.force) {
      return { ok: false, reason: 'claimed', ticket: t, claim: held };
    }
    t.claim = { by, at: new Date().toISOString() };
    if (opts.status !== false) t.status = coerceStatus(opts.status || 'doing', t.status);
    t.lastEventType = 'status';
    t.lastEventSource = opts.source ? String(opts.source) : 'cli';
    t.updatedAt = new Date().toISOString();
    putTicket(slug, t);
    // Tie this claim to the worker's session so a SessionEnd/SubagentStop hook can
    // release it immediately instead of waiting out the TTL. No-op without a session id.
    if (opts.sessionId) registerWorker(opts.sessionId, slug, t.id, by);
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
    // A ticket that finished is done — never yanked back to another status by a
    // release racing behind it. This closes a TOCTOU window: a caller (notably
    // reconcileSession, which pre-checks status on an unlocked read taken before
    // it could get this lock) can be scheduled between a completeTicket() clearing
    // the claim and this fresh read; without this guard, the empty claim would
    // vacuously pass the ownership check below and opts.status would stomp the
    // ticket straight back to "todo", silently un-completing finished work.
    // Mirrors claimTicket's own "done" refusal just above.
    if (t.status === 'done' && !opts.force) return { ok: false, reason: 'done', ticket: t };
    const held = t.claim;
    if (held && held.by && held.by !== by && !isClaimStale(held) && !opts.force) {
      return { ok: false, reason: 'not_owner', ticket: t, claim: held };
    }
    t.claim = null;
    t.dispatchNonce = null;
    t.dispatchExecutor = null;
    if (opts.status) t.status = coerceStatus(opts.status, t.status);
    if (opts.workedBy) t.workedBy = opts.workedBy; // self-reported provenance stamp (done transition only)
    // Completing a submitted ticket is the publish transaction consuming the
    // submission — stamp it integrated (kept as provenance) so the ticket
    // leaves the ready-for-integration queue the moment it goes done.
    if (t.status === 'done' && pendingSubmission(t)) {
      t.submission = Object.assign({}, t.submission, { integratedAt: new Date().toISOString() });
    }
    t.lastEventType = 'status';
    t.lastEventSource = opts.source ? String(opts.source) : 'cli';
    t.updatedAt = new Date().toISOString();
    putTicket(slug, t);
    // Drop this claim from the session registry — it's no longer outstanding, so a
    // later reconcile of the same session won't try to touch it (keyed on the
    // ticket, so a blank `by` on the done doesn't matter). No-op without a session id.
    if (opts.sessionId) unregisterClaim(opts.sessionId, slug, t.id);
    queueEventNotification(slug, t, t.lastEventType, t.lastEventSource);
    return { ok: true, ticket: t };
  });
}

// Build the provenance stamp recorded when a ticket is completed — which model
// tier (or the Codex model that actually backed it) and reasoning effort worked
// it, plus who and when. Returns null when no model is supplied. A supplied model
// must be a VALID_MODELS tier OR a discovered catalog slug (a Codex-backed tier
// records the real model that ran); effort, if present, a VALID_EFFORTS level
// (null/omitted allowed — haiku has no effort). Anything else throws.
function makeWorkedBy(input) {
  if (!input) return null;
  const rawModel = input.model;
  if (rawModel == null || String(rawModel).trim() === '') return null;
  const model = normalizeRouteModel(rawModel);
  if (!model || !availableRoute(model)) {
    throw new Error(`invalid model "${rawModel}" — expected an available Claude runtime or discovered Codex model`);
  }
  let effort = null;
  const rawEffort = input.effort;
  if (rawEffort != null && String(rawEffort).trim() !== '') {
    const e = String(rawEffort).trim().toLowerCase();
    if (VALID_EFFORTS.indexOf(e) === -1) {
      throw new Error(`invalid effort "${rawEffort}" — expected one of: ${VALID_EFFORTS.join(', ')} (or omit for none)`);
    }
    effort = e;
  }
  const by = input.by != null && String(input.by).trim() ? String(input.by).trim() : null;
  const at = input.at && Number.isFinite(Date.parse(input.at)) ? new Date(input.at).toISOString() : new Date().toISOString();
  return { model, effort, by, at };
}

// Complete a ticket: mark it done and clear its claim. An optional { model,
// effort } (from `done --model … --effort …`) is recorded as a workedBy
// provenance stamp; invalid values throw before anything is written.
function completeTicket(slug, idOrRef, by, opts) {
  opts = opts || {};
  const workedBy = makeWorkedBy({ model: opts.model, effort: opts.effort, by });
  return releaseTicket(slug, idOrRef, by, Object.assign({}, opts, { status: 'done', workedBy }));
}

/* ------------------------------------------------------------------ *
 *  Ready-for-integration submissions (SQ-398)
 *
 *  Executors never publish. A repo-changing executor finishes at a verified
 *  LOCAL commit in its isolated worktree and submits it — commit hash, durable
 *  git ref, the verify command it ran — as a submission riding the ticket. The
 *  ticket stays "doing" with the claim released: ready-for-integration is a
 *  lifecycle of its own, distinct from done. The orchestrator's publish
 *  transaction (see skills/sidequest/references/publishing.md) integrates the
 *  submitted commits under the repo publish lock (lib/publish.js), assigns
 *  versions centrally, reverifies, pushes main, and only then completes the
 *  ticket — which stamps the submission integrated.
 * ------------------------------------------------------------------ */

const SUBMISSION_COMMIT_RE = /^[0-9a-f]{7,64}$/i;
const SUBMISSION_GITREF_MAX = 200;
const SUBMISSION_WORKTREE_MAX = 500;

// A submission that has not been consumed by a done transition yet — the
// ticket is parked for the publish transaction, not for another executor.
function pendingSubmission(t) {
  return !!(t && t.submission && t.submission.commit && !t.submission.integratedAt);
}

function submissionGitRef(ticket) {
  return `refs/sidequest/${ticket.ref}`;
}

// Record verified, committed work as ready for integration and release the
// claim in the same locked step. Requires the caller to HOLD the claim (the
// submit is the terminal act of a claimed run) unless opts.force — mirroring
// releaseTicket's ownership rules. Status deliberately stays "doing".
function submitTicket(slug, idOrRef, by, opts) {
  opts = opts || {};
  by = String(by || 'agent');
  const commit = String(opts.commit || '').trim().toLowerCase();
  if (!SUBMISSION_COMMIT_RE.test(commit)) {
    throw new Error(`invalid commit "${opts.commit}" — pass the verified commit's hex hash (7-64 chars)`);
  }
  const gitRef = opts.gitRef != null && String(opts.gitRef).trim()
    ? String(opts.gitRef).trim().slice(0, SUBMISSION_GITREF_MAX)
    : null;
  const verify = opts.verify != null && String(opts.verify).trim()
    ? String(opts.verify).trim().slice(0, EXECUTOR_VERIFY_MAX)
    : null;
  const worktree = opts.worktree != null && String(opts.worktree).trim()
    ? String(opts.worktree).trim().slice(0, SUBMISSION_WORKTREE_MAX)
    : null;
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: 'not_found' };
  return withTicketLock(slug, found.id, () => {
    const t = getTicket(slug, found.id);
    if (!t) return { ok: false, reason: 'not_found' };
    if (t.status === 'done') return { ok: false, reason: 'done', ticket: t };
    const held = t.claim;
    if (held && held.by && held.by !== by && !isClaimStale(held) && !opts.force) {
      return { ok: false, reason: 'not_owner', ticket: t, claim: held };
    }
    if ((!held || !held.by) && !opts.force) return { ok: false, reason: 'not_claimed', ticket: t };
    t.submission = {
      by,
      at: new Date().toISOString(),
      commit,
      gitRef: gitRef || submissionGitRef(t),
      verify,
      worktree,
      integratedAt: null,
    };
    t.claim = null;
    t.dispatchNonce = null;
    t.dispatchExecutor = null;
    t.status = 'doing'; // ready-for-integration parks in doing, never done
    t.lastEventType = 'status';
    t.lastEventSource = opts.source ? String(opts.source) : 'cli';
    t.updatedAt = new Date().toISOString();
    putTicket(slug, t);
    if (opts.sessionId) unregisterClaim(opts.sessionId, slug, t.id);
    queueEventNotification(slug, t, t.lastEventType, t.lastEventSource);
    return { ok: true, ticket: t };
  });
}

// Orchestrator reset: drop a pending submission so the ticket is claimable
// again (integration bounced and the work must be redone rather than merged).
// opts.status optionally moves it (usually back to todo) at the same time.
function clearSubmission(slug, idOrRef, opts) {
  opts = opts || {};
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: 'not_found' };
  return withTicketLock(slug, found.id, () => {
    const t = getTicket(slug, found.id);
    if (!t) return { ok: false, reason: 'not_found' };
    if (!t.submission) return { ok: false, reason: 'no_submission', ticket: t };
    const cleared = t.submission;
    t.submission = null;
    if (opts.status) t.status = coerceStatus(opts.status, t.status);
    t.lastEventType = 'status';
    t.lastEventSource = opts.source ? String(opts.source) : 'cli';
    t.updatedAt = new Date().toISOString();
    putTicket(slug, t);
    queueEventNotification(slug, t, t.lastEventType, t.lastEventSource);
    return { ok: true, ticket: t, cleared };
  });
}

// The integration queue: every ticket parked ready-for-integration, oldest
// submission first — the order the publish transaction integrates them in.
function submissionsPayload(slug) {
  const tickets = listTickets(slug)
    .filter((t) => !t.archived && t.status !== 'done' && pendingSubmission(t))
    .sort((a, b) => String(a.submission.at).localeCompare(String(b.submission.at)))
    .map((t) => ({
      ref: t.ref,
      title: t.title,
      status: t.status,
      files: Array.isArray(t.files) ? t.files : [],
      executorVerify: t.executorVerify || null,
      submission: t.submission,
    }));
  return { tickets, count: tickets.length };
}

// Release claims that exceeded the shared TTL. Each release is locked and audited,
// so a fresh replacement claim is never cleared by a stale snapshot.
function sweepStaleClaims(opts) {
  opts = opts || {};
  const source = opts.source ? String(opts.source) : 'sweep';
  const released = [];
  for (const project of listProjects({ all: true })) {
    if (opts.project && project.slug !== opts.project) continue;
    for (const ticket of listTickets(project.slug)) {
      if (ticket.archived || ticket.status === 'done' || !isClaimStale(ticket.claim)) continue;
      try {
        const res = releaseTicket(project.slug, ticket.id, ticket.claim.by, { status: 'todo', source });
        if (!res.ok) continue;
        released.push({ project: project.slug, ref: ticket.ref });
        addComment(project.slug, ticket.id, {
          by: 'sidequest', kind: 'comment', source,
          body: `Auto-released to **todo**: claim exceeded the ${Math.round(claimTtlMs() / 60000)} minute TTL (was claimed by \`${ticket.claim.by}\`).`,
        });
      } catch (_) {
        // One inaccessible board must not prevent other stale claims from recovering.
      }
    }
  }
  return { ok: true, ttlMs: claimTtlMs(), released };
}

// True when a ticket may be handed to a worker running as tier `want`: either the
// worker didn't specify a tier, or the tags match. Every ticket now carries a
// tier, so a filtered tier-X worker only gets exact-tier matches (no untagged
// pass-through).
function modelMatches(ticketModel, want) {
  return !want || ticketModel === want;
}

// The tickets that are ready to be worked right now: not done, not archived, not
// actively claimed, and not blocked by an unfinished ticket. This is the set to
// fan subagents out over (each still claims before working). Priority-ordered.
// opts.model restricts to that tier's work (exact-tier matches only).
function readyTickets(slug, opts) {
  opts = opts || {};
  const want = opts.model ? classifyModelFilter(opts.model) : 'any';
  if (want === 'unknown') throw new Error(`Unknown model: ${opts.model}`);
  const category = opts.category == null ? null : String(opts.category).trim().toLowerCase();
  return listTickets(slug)
    .filter((t) => !t.archived)
    .filter((t) => t.status !== 'done')
    .filter((t) => !pendingSubmission(t)) // parked for integration, not for another executor
    .filter((t) => !t.claim || isClaimStale(t.claim))
    .filter((t) => !isBlocked(slug, t))
    .filter((t) => modelMatches(t.model, want === 'any' ? null : want))
    .filter((t) => !category || t.categoryId === category)
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
  const want = opts.model ? classifyModelFilter(opts.model) : 'any';
  if (want === 'unknown') throw new Error(`Unknown model: ${opts.model}`);
  const category = opts.category == null ? null : String(opts.category).trim().toLowerCase();
  const candidates = listTickets(slug)
    .filter((t) => !t.archived)
    .filter((t) => t.status !== 'done')
    .filter((t) => !pendingSubmission(t)) // parked for integration, not for another executor
    .filter((t) => !t.claim || isClaimStale(t.claim) || t.claim.by === by)
    .filter((t) => !opts.priority || t.priority === String(opts.priority).toLowerCase())
    .filter((t) => modelMatches(t.model, want === 'any' ? null : want))
    .filter((t) => !category || t.categoryId === category) // a tier-X worker only claims X-tagged work
    .filter((t) => opts.includeBlocked || !isBlocked(slug, t)) // never auto-hand-out blocked work
    .sort((a, b) => {
      const pr = priorityRank(a.priority) - priorityRank(b.priority);
      if (pr !== 0) return pr;
      return String(a.createdAt).localeCompare(String(b.createdAt));
    });
  for (const cand of candidates) {
    const res = claimTicket(slug, cand.id, by, { source: opts.source, sessionId: opts.sessionId });
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
    putTicket(slug, t);
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

function newStoryId() {
  return 'st_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex');
}

// Every story in a project, oldest-first (US-1 before US-2) so a legend/filter
// reads in creation order. Fail-soft to [] when the folder doesn't exist yet.
function listStories(slug) {
  const out = db.listRows(database(), 'stories', { project: slug }).filter((s) => s && s.id);
  out.sort((a, b) => (a.order || 0) - (b.order || 0));
  return out;
}

// Look up a story by its stable id or its human ref (US-4, case-insensitive).
function getStory(slug, idOrRef) {
  const wanted = String(idOrRef);
  const wantedRef = wanted.toUpperCase();
  for (const s of listStories(slug)) {
    if (s.id === wanted || String(s.ref).toUpperCase() === wantedRef) return s;
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
  return transaction(() => {
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
    putStory(slug, story);
    return story;
  });
}

// Apply a partial update to a story. An unparseable colour is ignored rather
// than blanking the existing one.
function updateStory(slug, idOrRef, patch) {
  return transaction(() => {
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
    putStory(slug, s);
    return s;
  });
}

// Delete a story and detach it from its member tickets (clearing storyId, the
// same way deleteTicket strips dangling links) so no card is left tinted by a
// story that no longer exists.
function deleteStory(slug, idOrRef) {
  const s = getStory(slug, idOrRef);
  if (!s) return false;
  if (!db.deleteRow(database(), 'stories', s.id)) return false;
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
// The hard storage cap for a single comment body. A body over this used to be
// silently sliced to fit (SQ-173), so the tail of a long note vanished with no
// signal to the caller. addComment now rejects an over-cap body instead of
// truncating, so the write is either stored whole or fails loudly.
const COMMENT_BODY_MAX = 4000;

function newCommentId() {
  return 'c_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex');
}

// Comment bodies are stored verbatim except for control bytes that have no place
// in prose. A raw NUL is the offender behind SQ-174: an author describing a
// NUL-separated key (e.g. `source + '\0' + slug`) can smuggle a literal 0x00
// into the body, and a NUL is a C-string terminator that silently truncates or
// corrupts anything downstream that treats the body as a C string. Read back,
// that lone NUL among hundreds of intact spaces looked like "a space turned into
// \x00" (it never was: spaces are 0x20 and are left untouched). Strip the C0
// control range and DEL, keeping only the whitespace that legitimately appears
// in prose (tab, newline, carriage return). This runs at the one shared write
// path, so the MCP `comment`/`ask` tools, the CLI `comment` command, and the
// dashboard all get the same normalization.
function stripControlChars(s) {
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

function addComment(slug, idOrRef, fields) {
  fields = fields || {};
  const body = stripControlChars(String(fields.body || '')).trim();
  if (!body) return { ok: false, reason: 'empty' };
  if (body.length > COMMENT_BODY_MAX) {
    return { ok: false, reason: 'too_long', max: COMMENT_BODY_MAX, length: body.length };
  }
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
      body, // over-cap bodies are rejected above, never silently truncated
      source, // 'cli' (agent) or 'dashboard' (the human) — who needsResponse() listens for
      at: new Date().toISOString(),
    };
    t.comments.push(comment);
    t.lastEventType = kind === 'question' ? 'question' : 'comment';
    t.lastEventSource = source;
    t.updatedAt = comment.at;
    putTicket(slug, t);
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
      putTicket(slug, t);
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
      putTicket(slug, t);
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

// Resolve a ticket's open blockers against an in-memory ref->ticket index
// (uppercased refs), instead of openBlockers()'s per-link getTicket fallback:
// links store "SQ-n" refs while ticket files are named by id, so the per-link
// path degenerates into a full-board rescan per link.
function openBlockersFromIndex(index, ticket) {
  if (!ticket || !Array.isArray(ticket.links)) return [];
  const out = [];
  for (const l of ticket.links) {
    if (l.type !== 'blocked-by') continue;
    const blocker = index.get(String(l.ref).toUpperCase());
    if (blocker && blocker.status !== 'done') out.push(blocker.ref);
  }
  return out;
}

// A compact projection of a ticket for orchestration reads (`--brief` on the
// CLI, `brief: true` over MCP): everything an orchestrator needs to route,
// batch, and spawn, none of the bodies. A full ticket carries its whole
// description and comment thread, which an orchestrator scanning a board pays
// for on every read without needing; the executor working the ticket reads the
// full record instead. opts.blockedBy short-circuits the blocker lookup when
// the caller already knows it (the ready set is unblocked by construction);
// opts.index resolves blockers in memory. Bare briefTicket(slug, t) still
// works but pays the per-link scan.
function briefTicket(slug, t, opts) {
  opts = opts || {};
  let blockedBy;
  if (Array.isArray(opts.blockedBy)) blockedBy = opts.blockedBy;
  else if (opts.index) blockedBy = openBlockersFromIndex(opts.index, t);
  else blockedBy = openBlockers(slug, t);
  return {
    ref: t.ref,
    title: t.title,
    status: t.status,
    priority: t.priority,
    complexity: t.complexity || null,
    categoryId: t.categoryId || (t.category && t.category.id) || null,
    categoryName: t.category && t.category.name || null,
    model: t.model || null,
    backend: t.exec ? t.exec.backend : null,
    runsModel: t.exec ? t.exec.runsModel : null,
    runsLabel: t.exec ? t.exec.runsLabel : null,
    executor: t.exec ? t.exec.agent : null,
    effort: t.effort || null,
    files: Array.isArray(t.files) ? t.files : [],
    claim: t.claim && t.claim.by ? { by: t.claim.by, at: t.claim.at, stale: isClaimStale(t.claim) } : null,
    blockedBy,
    comments: Array.isArray(t.comments) ? t.comments.length : 0,
    awaitingReply: needsResponse(t),
    submission: pendingSubmission(t) ? { commit: t.submission.commit, at: t.submission.at } : null,
  };
}

// A list cursor is just the next row offset, carried as an opaque decimal
// string. Kept transparent (not base64) so `--cursor 150` is usable by hand and
// a script can pipe nextCursor straight back. Garbage or a negative decodes to
// the first page rather than throwing.
function decodeListCursor(cursor) {
  if (cursor == null || cursor === '') return 0;
  const n = Math.floor(Number(cursor));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Slice one page out of the filtered tickets and report where the next page
// starts. Three page modes, in precedence order:
//   - all: the whole set from the cursor, no cap (the escape hatch).
//   - limit: an exact page size (start .. start+limit).
//   - maxChars: a size-budgeted page — accumulate rows until the serialized
//     cost would cross the budget (always keep at least one, so a lone fat row
//     still advances the cursor and iteration can't stall).
//   - none of the above: the whole set from the cursor (CLI default / small
//     board — one call returns everything, backward compatible).
// nextCursor is the next offset as a string, or null when the page reaches the
// end. Because each page is a contiguous slice and the next cursor is exactly
// where it stopped, following nextCursor to exhaustion yields every ticket once.
function pageTickets(tickets, opts) {
  const total = tickets.length;
  const start = Math.min(decodeListCursor(opts.cursor), total);
  const limit = opts.limit != null ? Math.max(0, Math.floor(Number(opts.limit)) || 0) : null;
  const budget = opts.maxChars != null && Number(opts.maxChars) > 0 ? Number(opts.maxChars) : null;

  let end;
  if (opts.all) {
    end = total;
  } else if (limit != null) {
    end = Math.min(start + limit, total);
  } else if (budget != null) {
    let size = 0;
    end = start;
    while (end < total) {
      // Size against the SAME pretty serialization the transports emit
      // (JSON.stringify(payload, null, 2)), so the budget is in real output
      // chars. +8 covers the array indent / comma-newline overhead per row.
      const cost = JSON.stringify(tickets[end], null, 2).length + 8;
      if (end > start && size + cost > budget) break;
      size += cost;
      end++;
    }
  } else {
    end = total;
  }

  const page = tickets.slice(start, end);
  const nextCursor = end < total ? String(end) : null;
  return { tickets: page, total, returned: page.length, nextCursor };
}

// The one board-read payload both transports (CLI --json and MCP) serve, so
// their shapes cannot drift: filtering, the brief projection, the blocker
// index, and paging (limit/cursor/maxChars -> total/returned/nextCursor) all
// live here and nowhere else.
function listPayload(slug, opts) {
  opts = opts || {};
  const all = listTickets(slug);
  let tickets = opts.archived ? all.filter((t) => t.archived) : all.filter((t) => !t.archived);
  if (opts.status) {
    const statuses = (Array.isArray(opts.status) ? opts.status : [opts.status]).map((status) => String(status).toLowerCase());
    tickets = tickets.filter((t) => statuses.includes(t.status));
  }
  if (opts.brief) {
    // Blockers may live outside the filtered set, so index the whole board.
    const index = new Map(all.map((t) => [String(t.ref).toUpperCase(), t]));
    tickets = tickets.map((t) => briefTicket(slug, t, { index }));
  }
  const page = pageTickets(tickets, opts);
  page.claimTtlMs = claimTtlMs();
  page.categories = classifierCategories({ project: slug });
  return page;
}

// Same for the ready read. Waves are ALWAYS arrays of refs (both transports,
// brief or not) — full tickets ride only in `tickets`, so nothing is
// serialized twice and the field has one shape. Ready tickets are unblocked by
// construction, so brief projections skip the blocker lookup outright.
function readyPayload(slug, opts) {
  opts = opts || {};
  let tickets = readyTickets(slug, { model: opts.model, category: opts.category });
  const waves = readyWaves(slug, { model: opts.model, category: opts.category }).map((wave) => wave.map((t) => t.ref));
  if (opts.brief) tickets = tickets.map((t) => briefTicket(slug, t, { blockedBy: [] }));
  return { tickets, waves, claimTtlMs: claimTtlMs(), categories: classifierCategories({ project: slug }) };
}

function claimPulse(claim, now) {
  if (!claim || !claim.by) return null;
  const atMs = Date.parse(claim.at);
  return {
    by: claim.by,
    at: claim.at,
    ageMs: Number.isFinite(atMs) ? Math.max(0, now - atMs) : null,
  };
}

function lastCommentPulse(ticket) {
  const comments = Array.isArray(ticket.comments) ? ticket.comments : [];
  const comment = comments[comments.length - 1];
  if (!comment) return null;
  return {
    at: comment.at,
    by: comment.by,
    kind: comment.kind,
    body: String(comment.body || '').slice(0, 100),
  };
}

function gitPulse(projectPath, files) {
  if (!projectPath || !Array.isArray(files) || !files.length) return null;
  try {
    const git = (args) => execFileSync('git', args, { cwd: projectPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (git(['rev-parse', '--is-inside-work-tree']) !== 'true') return null;
    const commit = git(['log', '-1', '--format=%H%x1f%s%x1f%cI', '--', ...files]);
    const [hash, subject, at] = commit ? commit.split('\x1f') : [];
    const changed = git(['status', '--porcelain', '--', ...files]);
    return {
      commit: hash ? { hash, subject, at } : null,
      dirty: Boolean(changed),
    };
  } catch (_) {
    return null;
  }
}

function pulsePayload(slug, idOrRef) {
  const ticket = getTicket(slug, idOrRef);
  if (!ticket) return null;
  const meta = readMeta(slug);
  return {
    ref: ticket.ref,
    title: ticket.title,
    status: ticket.status,
    claim: claimPulse(ticket.claim, Date.now()),
    comments: Array.isArray(ticket.comments) ? ticket.comments.length : 0,
    lastComment: lastCommentPulse(ticket),
    dispatchExecutor: ticket.dispatchExecutor || null,
    dispatchNonce: ticket.dispatchNonce || null,
    submission: ticket.submission || null,
    git: gitPulse(meta && meta.path, ticket.files),
  };
}

function changesPayload(slug, since) {
  const serverTime = new Date().toISOString();
  const defaultSince = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const after = since == null ? defaultSince : String(since);
  const afterMs = Date.parse(after);
  if (!Number.isFinite(afterMs)) throw new Error('changes: --since must be an ISO timestamp.');
  const tickets = listTickets(slug)
    .filter((ticket) => Date.parse(ticket.updatedAt) > afterMs)
    .sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt))
    .map((ticket) => ({
      ref: ticket.ref,
      title: ticket.title,
      status: ticket.status,
      lastEventType: ticket.lastEventType || null,
      lastEventSource: ticket.lastEventSource || null,
      claim: claimPulse(ticket.claim, Date.now()),
      updatedAt: ticket.updatedAt,
    }));
  return { since: after, serverTime, tickets };
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

function notificationsLockPath() {
  return path.join(projectsRoot(), '.notifications.lock');
}

function newNotificationId() {
  return 'nt_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex');
}

// Fail-soft read: a missing/corrupt file degrades to an empty queue.
function readNotifications() {
  const data = readGlobal('notifications', null);
  return data && Array.isArray(data.notifications) ? data.notifications : [];
}
function writeNotifications(list) {
  writeGlobal('notifications', { notifications: list });
}

// Serialize every mutation on the queue behind one lock (best-effort, like the
// ticket mutators: still applies if contention outlasts the retries).
function withNotificationsLock(fn) {
  const lock = notificationsLockPath();
  const locked = acquireLock(lock);
  try {
    return transaction(fn);
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

// Read the saved opt-in/out settings. Missing/corrupt file -> all on, matching
// the dashboard's own NOTIFY_DEFAULTS.
function getNotifyPrefs() {
  const saved = readGlobal('notify-prefs', null);
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
  writeGlobal('notify-prefs', out);
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
 *  Worker registry (session -> the claims it holds)
 *
 *  The claim TTL (default 60 min) is the backstop that frees a crashed worker's
 *  ticket. But when a *session* ends cleanly, we know its claims are dead right
 *  then — no reason to make a dependent wait out the TTL. The SessionEnd hook
 *  fires on that boundary; it has the session id but a claim is tagged
 *  only with an opaque `--by`. This tiny registry is the missing link: it maps a
 *  session id to the claims taken under it, so reconcileSession() can release
 *  exactly those (and only those — never another live session's) on the spot.
 *
 *  One file, projects/workers.json, a sibling to notifications.json:
 *    { sessions: { <sessionId>: { updatedAt, claims: [{ slug, ticketId, by, at }] } } }
 *
 *  Fail-soft throughout: a missing/garbage file degrades to an empty registry,
 *  and any hiccup here must never break a claim (the TTL still covers us). The
 *  registry is an OPTIMIZATION over the TTL, not a new source of truth — nothing
 *  reads it to decide whether a claim is valid, only to speed up releasing it.
 * ------------------------------------------------------------------ */

// Sessions untouched for this long with no live claims are pruned on write, so
// the file can't grow forever from sessions that ended without a reconcile hook.
const WORKER_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function workersLockPath() {
  return path.join(projectsRoot(), '.workers.lock');
}
function readWorkers() {
  const d = readGlobal('workers', null);
  return d && typeof d === 'object' && d.sessions && typeof d.sessions === 'object' ? d : { sessions: {} };
}
function writeWorkers(obj) {
  writeGlobal('workers', obj);
}
function withWorkersLock(fn) {
  const lock = workersLockPath();
  const locked = acquireLock(lock);
  try {
    return transaction(fn);
  } finally {
    if (locked) releaseLock(lock);
  }
}

// Drop sessions with no claims left, and any whose last activity is older than
// the TTL (a session that ended without its reconcile hook ever firing). Mutates
// and returns the registry object.
function pruneWorkers(w) {
  const cutoff = Date.now() - WORKER_SESSION_TTL_MS;
  for (const sid of Object.keys(w.sessions)) {
    const s = w.sessions[sid];
    const claims = s && Array.isArray(s.claims) ? s.claims : [];
    const ts = s && s.updatedAt ? Date.parse(s.updatedAt) : NaN;
    if (!claims.length || (Number.isFinite(ts) && ts < cutoff)) delete w.sessions[sid];
  }
  return w;
}

// Record that `sessionId` now holds a claim on (slug, ticketId) under worker id
// `by`. Idempotent per (slug, ticketId). No-op without a session id — the whole
// feature is dormant (and the TTL covers everything) until an id starts flowing.
function registerWorker(sessionId, slug, ticketId, by) {
  if (!sessionId || !slug || !ticketId) return;
  try {
    withWorkersLock(() => {
      const w = readWorkers();
      const now = new Date().toISOString();
      const s = w.sessions[sessionId] || (w.sessions[sessionId] = { updatedAt: now, claims: [] });
      s.updatedAt = now;
      if (!Array.isArray(s.claims)) s.claims = [];
      if (!s.claims.some((c) => c.slug === slug && c.ticketId === ticketId)) {
        s.claims.push({ slug, ticketId, by: by || null, at: now });
      }
      writeWorkers(pruneWorkers(w));
    });
  } catch (_) {
    /* the TTL is the backstop — a registry write failure must never break a claim */
  }
}

// Forget a claim (the worker finished or dropped it). No-op without a session id.
function unregisterClaim(sessionId, slug, ticketId) {
  if (!sessionId || !slug || !ticketId) return;
  try {
    withWorkersLock(() => {
      const w = readWorkers();
      const s = w.sessions[sessionId];
      if (!s || !Array.isArray(s.claims)) return;
      s.claims = s.claims.filter((c) => !(c.slug === slug && c.ticketId === ticketId));
      s.updatedAt = new Date().toISOString();
      writeWorkers(pruneWorkers(w));
    });
  } catch (_) {
    /* best effort */
  }
}

// Record that the SubagentStop hook already surfaced a runaway note for this exact
// claim, keyed on the claim's OWN start time so a later re-claim of the same ticket
// counts as a fresh flaggable run. Returns true the FIRST time and false on every
// repeat. Without this, each subsequent SubagentStop in the session re-emitted the
// same note as additionalContext — which re-woke the stopping child and turned one
// long run into a nag loop. Fail-open (returns true) if the registry can't be read:
// better a rare duplicate note than a swallowed real one.
function markLongRunFlagged(sessionId, slug, ticketId, claimAt) {
  if (!sessionId || !slug || !ticketId) return true;
  let first = true;
  try {
    withWorkersLock(() => {
      const w = readWorkers();
      const s = w.sessions[sessionId];
      if (!s) return; // no registered claims here — nothing to dedupe against
      const key = `${slug}\u0000${ticketId}\u0000${claimAt || ''}`;
      if (!Array.isArray(s.flagged)) s.flagged = [];
      if (s.flagged.indexOf(key) !== -1) {
        first = false;
        return;
      }
      s.flagged.push(key);
      s.updatedAt = new Date().toISOString();
      writeWorkers(w);
    });
  } catch (_) {
    return true;
  }
  return first;
}

// Release every claim registered to `sessionId` that is still genuinely held by
// that session's worker and not finished — moving each ticket back to `todo` and
// leaving a note. This is what the SessionEnd hook calls. Safe by construction:
// it only touches tickets the registry attributes to THIS session,
// and skips any that were completed or re-claimed by someone else in the interim.
// Idempotent — the session's registry entry is cleared as part of the pass, so a
// second call finds nothing. Returns { ok, released: [ref...] }.
function reconcileSession(sessionId, opts) {
  opts = opts || {};
  const reason = opts.reason ? String(opts.reason) : 'worker session ended';
  const source = opts.source ? String(opts.source) : 'cli';
  const released = [];
  if (!sessionId) return { ok: true, released };

  // Snapshot this session's claims and clear its registry entry in one locked
  // step, so a concurrent reconcile of the same session can't double-release.
  let claims = [];
  try {
    withWorkersLock(() => {
      const w = readWorkers();
      const s = w.sessions[sessionId];
      claims = s && Array.isArray(s.claims) ? s.claims.slice() : [];
      if (s) {
        delete w.sessions[sessionId];
        writeWorkers(w);
      }
    });
  } catch (_) {
    return { ok: true, released };
  }

  for (const c of claims) {
    let t;
    try {
      t = getTicket(c.slug, c.ticketId);
    } catch (_) {
      continue;
    }
    if (!t || t.archived || t.status === 'done') continue; // finished work is left alone
    if (!t.claim || !t.claim.by) continue; // already released
    if (c.by && t.claim.by !== c.by) continue; // re-claimed by someone else since — not ours to touch
    try {
      const res = releaseTicket(c.slug, c.ticketId, t.claim.by, { status: 'todo', source });
      if (res && res.ok) {
        released.push(t.ref);
        try {
          addComment(c.slug, c.ticketId, {
            by: 'sidequest',
            kind: 'comment',
            source,
            body: `↩️ Auto-released to **todo**: ${reason} (was claimed by \`${t.claim.by}\`). It's back in the ready pool for another worker.`,
          });
        } catch (_) {
          /* the release is what matters; the note is a courtesy */
        }
      }
    } catch (_) {
      /* one bad ticket must not abort the rest of the reconcile */
    }
  }
  return { ok: true, released };
}

// Read-only view of the claims the registry attributes to `sessionId`, each with
// the claim's OWN start `at` timestamp — the raw material a SubagentStop hook uses
// to spot a runaway (long-running) executor post-hoc. Unlike reconcileSession this
// mutates NOTHING: it snapshots the registry entry and resolves each claim's ticket
// ref/status for naming, skipping tickets that have since vanished. Returns [] for
// an unknown/absent session. Fail-soft: any hiccup degrades to []. Like the rest of
// the registry it is a convenience over the TTL, never a source of truth about
// whether a claim is valid. Shape: [{ slug, ticketId, ref, by, at, status, held }].
function sessionClaims(sessionId) {
  const out = [];
  if (!sessionId) return out;
  let claims = [];
  try {
    withWorkersLock(() => {
      const w = readWorkers();
      const s = w.sessions[String(sessionId)];
      claims = s && Array.isArray(s.claims) ? s.claims.slice() : [];
    });
  } catch (_) {
    return out;
  }
  for (const c of claims) {
    let ref = null;
    let status = null;
    let held = false;
    try {
      const t = getTicket(c.slug, c.ticketId);
      if (t) {
        ref = t.ref;
        status = t.status;
        held = !!(t.claim && t.claim.by && (!c.by || t.claim.by === c.by));
      }
    } catch (_) {
      /* a bad ticket read just yields a bare entry — the `at` still stands */
    }
    out.push({ slug: c.slug, ticketId: c.ticketId, ref, by: c.by || null, at: c.at || null, status, held });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 *  Server lockfile (used by CLI + server to find/reuse a running dashboard)
 * ------------------------------------------------------------------ */

function readServerInfo() {
  return readGlobal('server-info', null);
}
function writeServerInfo(info) {
  writeGlobal('server-info', info);
}
function clearServerInfo() {
  db.deleteRow(database(), 'globals', 'server-info');
}

module.exports = {
  VALID_STATUS,
  VALID_PRIORITY,
  VALID_EFFORTS,
  CLAUDE_RUNTIMES,
  ROUTING_FALLBACK_DEFAULT,
  EXECUTOR_ANCHORS_MAX,
  EXECUTOR_VERIFY_MAX,
  ticketReferenceWarnings,
  ticketPlanningWarnings,
  coerceComplexity,
  legacyCategoryForComplexity,
  applyDerivedRouting,
  getModelVocab,
  modelsPayload,
  routingModels,
  resolveModelId,
  resolveExec,
  resolveCategoryRoute,
  classifyModelFilter,
  getRoutingFallback,
  setRoutingFallback,
  getCategories,
  getCategoryRoutePairs,
  getCategory,
  getProjectCategories,
  setProjectCategory,
  detachCategory,
  removeProjectCategory,
  setCategory,
  removeCategory,
  homeRoot,
  projectsRoot,
  serverFile,
  slugify,
  nearestRepoRoot,
  mainWorktreeRoot,
  projectDir,
  ensureProject,
  readMeta,
  listProjects,
  findProject,
  archiveProject,
  unarchiveProject,
  deleteProjectExact,
  mergeProject,
  setProjectNotify,
  copyAsset,
  saveAssetData,
  assetPath,
  listTickets,
  getTicket,
  createTicket,
  updateTicket,
  deleteTicket,
  dispatchExecutorName,
  stableExecutorName,
  prepareDispatch,
  claimTicket,
  releaseTicket,
  completeTicket,
  makeWorkedBy,
  submitTicket,
  clearSubmission,
  pendingSubmission,
  submissionsPayload,
  claimNext,
  assignTicket,
  readyTickets,
  readyWaves,
  scopesOverlap,
  normalizeFiles,
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
  briefTicket,
  listPayload,
  readyPayload,
  pulsePayload,
  changesPayload,
  archiveTicket,
  unarchiveTicket,
  archiveAllDone,
  listArchived,
  listActive,
  isClaimStale,
  claimTtlMs,
  DEFAULT_CLAIM_TTL_MIN,
  sweepStaleClaims,
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
  registerWorker,
  unregisterClaim,
  markLongRunFlagged,
  reconcileSession,
  sessionClaims,
};
