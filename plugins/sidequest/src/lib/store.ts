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
const { isReadOnlyCategory, stableClaudeName, stableDispatchName, stableReadOnlyClaudeName, stableReadOnlyDispatchName } = require('./exec-names.js');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const db = require('./db.js');
const { ROUTING_PROFILE_SEED_REVISION, STARTER_ROUTING_PROFILES } = require('./category-defaults.js');
const commitScope = require('./commit-scope.js');
const { migrateIfNeeded } = require('./migrate.js');
const { discoverExternalModels } = require('./discovery.js');
const telemetry = require('./telemetry.js');
const { routingDisabledMessage } = require('./refusal-guidance.js');

const AGENT_DESCRIPTION_MAX_LENGTH = 80;
const ARTIFACT_BASELINE_MAX_PATHS = 500;
const WORKTREE_SETUP_MAX_LENGTH = 1000;
const SHARED_TREE_ARTIFACT_MARKER = 'Shared-tree artifact mode: leave the generated map as working-tree output; verify, comment, and close with done. Do not commit, submit, push, or edit source.';
const CONTROL_PLANE_COMPLETION = Symbol('sidequest.control-plane-completion');

function spawnDescription(ticket?: any, resolved?: any) {
  const title = String(ticket && ticket.title || 'Sidequest ticket').replace(/\s+/g, ' ').trim();
  const route = resolved && resolved.backend === 'codex'
    ? String(resolved.runsLabel || resolved.runsModel || '').replace(/\s+/g, ' ').trim()
    : '';
  const suffix = route ? ` (${route})` : '';
  const maxTitleLength = Math.max(1, AGENT_DESCRIPTION_MAX_LENGTH - suffix.length);
  return `${title.slice(0, maxTitleLength).trimEnd()}${suffix}`.slice(0, AGENT_DESCRIPTION_MAX_LENGTH);
}

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
function normalizeForHash(absPath?: any) {
  const p = path.resolve(absPath);
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

function slugify(absPath?: any) {
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
function mainWorktreeRoot(gitEntry?: any) {
  let stat: any;
  try {
    stat = fs.statSync(gitEntry);
  } catch (_: any) {
    return null;
  }
  if (!stat.isFile()) return null; // a `.git` dir is a real repo root, leave it
  let content: any;
  try {
    content = fs.readFileSync(gitEntry, 'utf8');
  } catch (_: any) {
    return null;
  }
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(content);
  if (!m) return null;
  // gitdir is normally absolute; resolve relative forms against the worktree dir.
  let gitdir = m[1]!.replace(/[/\\]+$/, '');
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
  } catch (_: any) { /* off-machine / moved — fall through to null */ }
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
function nearestRepoRoot(startDir?: any) {
  const start = path.resolve(startDir);

  // (1) EnterWorktree fast path — deterministic, no filesystem trust required.
  const wt = /^(.*?)[/\\]\.claude[/\\]worktrees[/\\]/i.exec(start + path.sep);
  if (wt && wt[1]) {
    const owner = path.resolve(wt[1]);
    try {
      if (fs.statSync(owner).isDirectory()) return owner;
    } catch (_: any) { /* owner gone — fall through to the git walk */ }
  }

  // (2) + (3) Walk up to the enclosing `.git`.
  let dir = start;
  for (;;) {
    try {
      const entry = path.join(dir, '.git');
      if (fs.existsSync(entry)) {
        return mainWorktreeRoot(entry) || dir;
      }
    } catch (_: any) {
      return start;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return start; // hit the filesystem root without a repo
    dir = parent;
  }
}

function projectDir(slug?: any) {
  return path.join(projectsRoot(), slug);
}
function ticketsDir(slug?: any) {
  return path.join(projectDir(slug), 'tickets');
}
function assetsDir(slug?: any, id?: any) {
  return path.join(projectDir(slug), 'assets', id);
}

/* ------------------------------------------------------------------ *
 *  SQLite persistence
 * ------------------------------------------------------------------ */

const dbByHome = new Map<string, any>();
const transactionDepth = new WeakMap<object, number>();

interface StoreCache {
  dataVersion: number;
  metadata: Map<string, any>;
  projectCategories: Map<string, any[]>;
  routingProfiles: Map<string, any>;
  routingProfileEntries: Map<string, any[]>;
  projectRoutingProfiles: Map<string, any>;
  routingProfileSettings: any | undefined;
  routingFallback: any | undefined;
  snapshots: Map<string, any>;
}

const storeCacheByDatabase = new WeakMap<object, StoreCache>();

function sqliteDataVersion(handle: any): number {
  const row = handle.prepare('PRAGMA data_version').get();
  return Number(row && row.data_version) || 0;
}

function newStoreCache(dataVersion: number): StoreCache {
  return {
    dataVersion,
    metadata: new Map<string, any>(),
    projectCategories: new Map<string, any[]>(),
    routingProfiles: new Map<string, any>(),
    routingProfileEntries: new Map<string, any[]>(),
    projectRoutingProfiles: new Map<string, any>(),
    routingProfileSettings: undefined,
    routingFallback: undefined,
    snapshots: new Map<string, any>(),
  };
}

function residentCache(): StoreCache {
  const handle = database();
  const dataVersion = sqliteDataVersion(handle);
  let cache = storeCacheByDatabase.get(handle);
  if (!cache || cache.dataVersion !== dataVersion) {
    cache = newStoreCache(dataVersion);
    storeCacheByDatabase.set(handle, cache);
  }
  return cache;
}

function invalidateStoreCaches(): void {
  const handle = database();
  storeCacheByDatabase.set(handle, newStoreCache(sqliteDataVersion(handle)));
}

function putCachedRow(handle: any, table: any, row: any): any {
  const result = db.putRow(handle, table, row);
  invalidateStoreCaches();
  return result;
}

function deleteCachedRow(handle: any, table: any, key: any): boolean {
  const deleted = db.deleteRow(handle, table, key);
  if (deleted) invalidateStoreCaches();
  return deleted;
}

function cloneCached<T>(value: T): T {
  return value == null ? value : structuredClone(value);
}

function ensureDir(dir?: any) {
  fs.mkdirSync(dir, { recursive: true });
}

function refreshRoutingProfileSeeds(handle?: any) {
  const pending: any[] = [];
  for (const seed of STARTER_ROUTING_PROFILES) {
    const profile = handle.prepare(`
      SELECT id, seed_revision FROM routing_profiles WHERE source = 'seed' AND seed_key = ?
    `).get(seed.id);
    if (!profile || profile.seed_revision == null || Number(profile.seed_revision) >= ROUTING_PROFILE_SEED_REVISION) continue;
    pending.push({ seed, profileId: profile.id });
  }
  if (!pending.length) return;
  db.txn(handle, () => {
    const now = new Date().toISOString();
    const affected = new Set<string>();
    for (const { seed, profileId } of pending) {
      handle.prepare('DELETE FROM routing_profile_entries WHERE profile_id = ?').run(profileId);
      seed.categories.forEach((category?: any, position?: any) => {
        handle.prepare(`
          INSERT INTO routing_profile_entries (profile_id, category_id, data, position, updated_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(profileId, category.id, JSON.stringify(category), position, now);
      });
      handle.prepare(`
        UPDATE routing_profiles SET name = ?, description = ?, seed_revision = ?, revision = revision + 1, updated_at = ?
        WHERE id = ?
      `).run(seed.name, seed.description, ROUTING_PROFILE_SEED_REVISION, now, profileId);
      for (const row of handle.prepare('SELECT project FROM project_routing_profiles WHERE profile_id = ?').all(profileId)) {
        affected.add(String(row.project));
      }
    }
    refreshPreparedDispatches(handle, [...affected], null);
  });
}

function database() {
  const root = homeRoot();
  let handle = dbByHome.get(root);
  if (!handle) {
    handle = db.openDb(root);
    migrateIfNeeded(handle, root);
    refreshRoutingProfileSeeds(handle);
    dbByHome.set(root, handle);
  }
  return handle;
}

function transaction(fn?: any) {
  const handle = database();
  if (transactionDepth.get(handle)) return fn();
  transactionDepth.set(handle, 1);
  try {
    return db.txn(handle, fn);
  } finally {
    transactionDepth.delete(handle);
  }
}

function putProject(slug?: any, meta?: any) {
  putCachedRow(database(), 'projects', { slug, data: meta });
}

function ticketStorageRow(slug?: any, ticket?: any) {
  const stored = Object.assign({}, ticket);
  if (stored.category && typeof stored.category === 'object') stored.category = stored.categoryId || stored.category.id;
  delete stored.categoryId;
  delete stored.warnings;
  delete stored.exec;
  delete stored.model;
  delete stored.effort;
  return {
    id: stored.id,
    project: slug,
    ref: stored.ref || null,
    status: stored.status || null,
    archived: stored.archived ? 1 : 0,
    ord: Number(stored.order) || 0,
    claim_by: stored.claim && stored.claim.by ? stored.claim.by : null,
    data: stored,
  };
}

function putTicket(slug?: any, ticket?: any) {
  putCachedRow(database(), 'tickets', ticketStorageRow(slug, ticket));
  const project = readMeta(slug);
  telemetry.emitTicket({ slug, path: project && project.path }, applyDerivedRouting(Object.assign({}, ticket), { project: slug }));
}

function putStory(slug?: any, story?: any) {
  putCachedRow(database(), 'stories', { id: story.id, project: slug, data: story });
}

function readGlobal(key?: any, fallback?: any) {
  const value = db.getRow(database(), 'globals', key);
  return value == null ? fallback : value;
}

function writeGlobal(key?: any, value?: any) {
  putCachedRow(database(), 'globals', { key, data: value });
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
const CLAUDE_RUNTIME_LABELS: Record<string, string> = {
  haiku: 'Claude Haiku', sonnet: 'Claude Sonnet',
  opus: 'Claude Opus', fable: 'Claude Fable',
};
const VALID_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const BACKEND_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;
const BACKEND_KEY_RE = /^([a-z0-9][a-z0-9-]{0,31}):([a-z0-9][a-z0-9-]{1,31})$/;
const HAIKU_BACKEND_EFFORT = 'medium';
const ROUTING_FALLBACK_DEFAULT = Object.freeze({ model: 'sonnet', effort: 'high' });
const CLAUDE_QUOTA_FAILURES = Object.freeze([
  Object.freeze({ model: 'fable', signature: "You've reached your Fable 5 limit" }),
]);

function coerceEffort(v?: any) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  if (!s || s === 'any' || s === 'none' || s === 'null' || s === 'default') return null;
  return VALID_EFFORTS.includes(s) ? s : null;
}

function coerceComplexity(v?: any) {
  if (v == null || String(v).trim() === '') return null;
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 1 && n <= 10 ? n : null;
}

function backendKey(source?: any, slug?: any) {
  return `${source}:${slug}`;
}

function discoveredByKey() {
  const out: Record<string, any> = {};
  for (const entry of discoverExternalModels()) out[backendKey(entry.source, entry.slug)] = entry;
  return out;
}

function discoveredBySlug() {
  const out: Record<string, any> = {};
  for (const entry of discoverExternalModels()) if (!(entry.slug in out)) out[entry.slug] = entry;
  return out;
}

function resolvedBackend(entry?: any, discovered?: any) {
  const agentSlug = discovered.filter((candidate?: any) => candidate.slug === entry.slug).length > 1
    ? `${entry.source}-${entry.slug}`
    : entry.slug;
  return { backend: 'codex', source: entry.source, slug: entry.slug, agentSlug, id: entry.id, label: entry.label };
}

function normalizeRouteModel(model?: any) {
  if (typeof model !== 'string') return null;
  const value = model.trim().toLowerCase();
  if (CLAUDE_RUNTIMES.includes(value)) return value;
  return BACKEND_SLUG_RE.test(value) || BACKEND_KEY_RE.test(value) ? value : null;
}

function availableRoute(model?: any) {
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

function reportingModelForms(value?: any) {
  const normalized = String(value || '').trim().toLowerCase().replace(/\[1m\]$/, '');
  if (!normalized) return [];
  const forms = new Set([normalized]);
  for (const form of Array.from(forms)) {
    forms.add(form.replace(/^claude-codex-/, ''));
    forms.add(form.replace(/^claude-/, ''));
  }
  for (const form of Array.from(forms)) forms.add(form.replace(/\./g, '-'));
  return Array.from(forms);
}

function normalizeReportedModel(model?: any) {
  const normalized = normalizeRouteModel(model);
  const direct = normalized && availableRoute(normalized);
  if (direct) return direct.slug;
  const forms = new Set(reportingModelForms(model));
  for (const entry of discoverExternalModels()) {
    const identities = [entry.slug, entry.id, dispatchModelFor(entry.id)];
    if (identities.some((identity?: any) => reportingModelForms(identity).some((form?: any) => forms.has(form)))) {
      return entry.slug;
    }
  }
  return null;
}

function resolvedDispatchRoute(ticket?: any) {
  const route = ticket && ticket.dispatch && normalizeRoute(ticket.dispatch.route);
  return route && availableRoute(route.model) ? route : null;
}

// The id the codex-gateway shim forwards upstream for a discovered backend: its
// advertised id minus the local claude-codex- discovery prefix and any [1m]
// suffix. Dispatch briefings embed it as the [sidequest-route model=...] marker
// that resolves the shared executors' virtual claude-codex-auto pin (SQ-347).
function dispatchModelFor(id?: any) {
  return String(id || '').replace(/^claude-codex-/, '').replace(/\[1m\]$/, '');
}

// The marker rides along so the spawn gate can compare like with like: the
// briefing embeds exec.dispatchModel (gateway form), never the board slug.
function dispatchRouteState(model?: any, effort?: any, exec?: any) {
  return {
    model,
    effort,
    ...(exec && exec.dispatchModel ? { marker: exec.dispatchModel } : {}),
  };
}

function execFromBackend(backend?: any, effort?: any) {
  if (backend.backend === 'codex') {
    const resolvedEffort = effort || HAIKU_BACKEND_EFFORT;
    return { agent: stableDispatchName(resolvedEffort), effort: resolvedEffort, model: null, spawnId: backend.id, dispatchModel: dispatchModelFor(backend.id), backend: 'codex', source: backend.source, slug: backend.slug, runsModel: backend.slug, apiModel: backend.id, runsLabel: backend.label || backend.slug, dispatch: 'native-agent' };
  }
  const runtime = backend.slug;
  const agent = effort ? stableClaudeName(effort) : null;
  return { agent, model: runtime, spawnId: runtime, backend: 'claude', slug: runtime, runsModel: runtime, apiModel: runtime, runsLabel: backend.label || CLAUDE_RUNTIME_LABELS[runtime], dispatch: 'native-agent' };
}

function resolveExec(model?: any, effort?: any) {
  const backend = availableRoute(model);
  if (!backend) return null;
  return execFromBackend(backend, coerceEffort(effort));
}

function resolveReportedExec(model?: any, effort?: any) {
  const normalized = normalizeReportedModel(model);
  return normalized ? resolveExec(normalized, effort) : null;
}

function resolveModelId(model?: any) {
  const exec = resolveExec(model, null);
  return exec ? exec.spawnId : null;
}

function routingModels() {
  const discovered = discoverExternalModels();
  return {
    models: CLAUDE_RUNTIMES.concat(discovered.map((entry?: any) => entry.slug)),
    efforts: VALID_EFFORTS.slice(),
    discovered,
  };
}

function getModelVocab() {
  return routingModels();
}

function routeDescriptor(model?: any, effort?: any) {
  return model && effort ? `${model}·${effort}` : null;
}

function modelsPayload(opts?: any) {
  opts = opts || {};
  const catalog = routingModels();
  const categories = getCategories({ project: opts.project });
  const payload: any = {
    models: catalog.models,
    efforts: catalog.efforts,
    discovered: catalog.discovered,
    globalFallback: Object.assign({ label: 'availability fallback' }, getRoutingFallback()),
    categories: categories.map((category?: any) => {
      const resolved = resolveCategoryRoute(category);
      return { id: category.id, route: routeDescriptor(resolved.model, resolved.effort) };
    }),
  };
  if (!opts.full) return payload;

  const projectCategories = getProjectCategories(opts.project);
  const selected = opts.project ? projectRoutingProfile(opts.project) : null;
  const profile = selected ? selected.profile : getRoutingProfile(defaultRoutingProfileId());
  return Object.assign(payload, {
    newBoardProfile: routingProfileDetails(defaultRoutingProfileId()),
    profile: profile ? { id: profile.id, name: profile.name, revision: profile.revision, entryCount: routingProfileEntries(profile.id).length } : null,
    categories: categories.map((category?: any) => {
      const resolved = resolveCategoryRoute(category);
      return Object.assign({}, category, {
        configured: { route: category.route, fallback: category.fallback },
        resolved: { model: resolved.model, effort: resolved.effort, exec: execProjection(resolved.exec) },
        warnings: resolved.warnings,
      });
    }),
    warnings: projectCategories.warnings,
  });
}

function classifyModelFilter(v?: any) {
  if (v == null) return 'any';
  const value = String(v).trim().toLowerCase();
  if (!value || value === 'any' || value === 'none' || value === 'null') return 'any';
  const exec = resolveReportedExec(value, null);
  return exec ? exec.runsModel : 'unknown';
}

function legacyCategoryForComplexity(value?: any) {
  const complexity = coerceComplexity(value);
  if (!complexity) return null;
  if (complexity <= 3) return 'coding.easy';
  if (complexity <= 6) return 'coding.normal';
  return 'coding.hard';
}

function normalizeRoute(raw?: any) {
  if (!raw || typeof raw !== 'object') return null;
  const model = normalizeRouteModel(raw.model);
  const effort = coerceEffort(raw.effort);
  return model && effort ? { model, effort } : null;
}

function claudeQuotaFailure(error?: any) {
  const text = String(error || '');
  return CLAUDE_QUOTA_FAILURES.find((failure?: any) => text.includes(failure.signature)) || null;
}

function getRoutingFallback() {
  const cache = residentCache();
  if (cache.routingFallback !== undefined) return cloneCached(cache.routingFallback);
  cache.routingFallback = normalizeRoute(readGlobal('routing-fallback', null));
  return cloneCached(cache.routingFallback);
}

function setRoutingFallback(route?: any) {
  const normalized = normalizeRoute(route);
  if (!normalized) throw new Error('Routing fallback requires a valid model and effort.');
  return mutateRoutingPolicy({ allProjects: true }, (handle?: any) => {
    db.putRow(handle, 'globals', { key: 'routing-fallback', data: normalized });
    return normalized;
  }).result;
}

function routingProfileSettings() {
  const cache = residentCache();
  if (cache.routingProfileSettings !== undefined) return cloneCached(cache.routingProfileSettings);
  const row = database().prepare('SELECT singleton, new_project_profile_id FROM routing_profile_settings WHERE singleton = 1').get();
  cache.routingProfileSettings = row ? { singleton: Number(row.singleton), newProjectProfileId: row.new_project_profile_id } : null;
  return cloneCached(cache.routingProfileSettings);
}

function getRoutingProfile(profileId?: any) {
  const id = String(profileId || '').trim().toLowerCase();
  if (!id) return null;
  const cache = residentCache();
  if (cache.routingProfiles.has(id)) return cloneCached(cache.routingProfiles.get(id));
  const row = database().prepare(`
    SELECT id, name, description, source, seed_key, seed_revision, revision, created_at, updated_at, retired_at
    FROM routing_profiles WHERE id = ?
  `).get(id);
  const profile = row ? {
    id: row.id,
    name: row.name,
    description: row.description,
    source: row.source,
    seedKey: row.seed_key,
    seedRevision: row.seed_revision == null ? null : Number(row.seed_revision),
    revision: Number(row.revision),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    retiredAt: row.retired_at,
  } : null;
  cache.routingProfiles.set(id, profile);
  return cloneCached(profile);
}

function routingProfileEntries(profileId?: any) {
  const id = String(profileId || '').trim().toLowerCase();
  const cache = residentCache();
  if (cache.routingProfileEntries.has(id)) return cloneCached(cache.routingProfileEntries.get(id));
  const entries = database().prepare(`
    SELECT category_id, data, position, updated_at
    FROM routing_profile_entries WHERE profile_id = ? ORDER BY position, category_id
  `).all(id).map((row?: any) => {
    try {
      return { categoryId: row.category_id, data: JSON.parse(row.data), position: Number(row.position), updatedAt: row.updated_at };
    } catch (_: any) {
      return null;
    }
  }).filter(Boolean);
  cache.routingProfileEntries.set(id, entries);
  return cloneCached(entries);
}

function defaultRoutingProfileId() {
  const settings = routingProfileSettings();
  if (!settings || !settings.newProjectProfileId) throw new Error('The new-board routing profile is not configured.');
  return settings.newProjectProfileId;
}

function projectRoutingProfile(project?: any, repair: boolean = true) {
  const normalizedProject = String(project || '').trim();
  if (!normalizedProject) return null;
  const cache = residentCache();
  let pointer = cache.projectRoutingProfiles.get(normalizedProject);
  if (pointer === undefined) {
    const row = database().prepare(`
      SELECT project, profile_id, assigned_at, assigned_by FROM project_routing_profiles WHERE project = ?
    `).get(normalizedProject);
    pointer = row ? {
      project: row.project,
      profileId: row.profile_id,
      assignedAt: row.assigned_at,
      assignedBy: row.assigned_by,
    } : null;
    cache.projectRoutingProfiles.set(normalizedProject, pointer);
  }
  let repaired = false;
  if (!pointer && repair) {
    const profileId = defaultRoutingProfileId();
    const assignedAt = new Date().toISOString();
    transaction(() => {
      db.putRow(database(), 'project_routing_profiles', {
        project: normalizedProject,
        profile_id: profileId,
        assigned_at: assignedAt,
        assigned_by: 'invariant-repair',
      });
    });
    invalidateStoreCaches();
    pointer = { project: normalizedProject, profileId, assignedAt, assignedBy: 'invariant-repair' };
    repaired = true;
  }
  if (!pointer) return null;
  const profile = getRoutingProfile(pointer.profileId);
  if (!profile) throw new Error(`Routing profile "${pointer.profileId}" for ${normalizedProject} does not exist.`);
  return {
    pointer,
    profile,
    warnings: repaired ? [{ kind: 'missing-profile-pointer', project: normalizedProject, repairedTo: profile.id }] : [],
  };
}

function policyMutationProjects(handle?: any, scope?: any) {
  const projects = new Set((scope.projects || []).map((project?: any) => String(project || '').trim()).filter(Boolean));
  if (scope.allProjects) {
    for (const row of handle.prepare('SELECT slug FROM projects').all()) projects.add(String(row.slug));
  }
  for (const profileId of scope.profileIds || []) {
    for (const row of handle.prepare('SELECT project FROM project_routing_profiles WHERE profile_id = ?').all(String(profileId))) {
      projects.add(String(row.project));
    }
  }
  return projects;
}

function mutateRoutingPolicy(scope?: any, mutation?: any) {
  if (typeof mutation !== 'function') throw new TypeError('mutateRoutingPolicy requires a synchronous mutation callback.');
  scope = scope || {};
  const handle = database();
  let result: any;
  let refresh: any;
  transaction(() => {
    const projects = policyMutationProjects(handle, scope);
    result = mutation(handle);
    for (const project of policyMutationProjects(handle, scope)) projects.add(project);
    refresh = refreshPreparedDispatches(handle, [...projects], scope.categoryIds || null);
  });
  invalidateStoreCaches();
  return { result, refresh };
}

function projectCategoryRows(project?: any) {
  if (!project) return [];
  const cache = residentCache();
  const cached = cache.projectCategories.get(project);
  if (cached) return cloneCached(cached);
  const rows = database().prepare('SELECT id, kind, base_profile_id, base_data, data FROM project_categories WHERE project = ? ORDER BY id').all(project)
    .map((row?: any) => {
      try {
        return {
          id: row.id,
          kind: row.kind,
          baseProfileId: row.base_profile_id || null,
          baseData: row.base_data == null ? null : JSON.parse(row.base_data),
          data: JSON.parse(row.data),
        };
      } catch (_: any) {
        return null;
      }
    })
    .filter(Boolean);
  cache.projectCategories.set(project, rows);
  return cloneCached(rows);
}

function routingContext(project?: any) {
  const selected = project ? projectRoutingProfile(project) : null;
  const profileId = selected ? selected.profile.id : defaultRoutingProfileId();
  const profile = selected ? selected.profile : getRoutingProfile(profileId);
  if (!profile) throw new Error(`Routing profile "${profileId}" does not exist.`);
  const entries = routingProfileEntries(profile.id);
  const general = entries.find((entry?: any) => entry.categoryId === 'general');
  if (!general || !normalizeCategory(general.data)?.enabled) {
    throw new Error(`Routing profile "${profile.id}" requires an enabled general category.`);
  }
  return { profile, entries, warnings: selected ? selected.warnings : [] };
}

function resolvedProfileCategories(opts?: any) {
  opts = opts || {};
  const cache = residentCache();
  const cacheKey = `routing-categories:${opts.project || '@default'}:${opts.includeDisabled === false ? 'enabled' : 'all'}:${opts.withState === true ? 'state' : 'plain'}`;
  if (cache.snapshots.has(cacheKey)) return cloneCached(cache.snapshots.get(cacheKey));
  const context = routingContext(opts.project);
  const categories = new Map<string, any>();
  const warnings = context.warnings.slice();
  for (const entry of context.entries) {
    const category = normalizeCategory(entry.data);
    if (!category) continue;
    categories.set(category.id, Object.assign({}, category, {
      origin: 'profile',
      profileId: context.profile.id,
      baseProfileId: context.profile.id,
      changedFields: [],
      warnings: [],
      ...(opts.withState ? { linkState: 'linked' } : {}),
    }));
  }

  for (const row of projectCategoryRows(opts.project)) {
    const base = categories.get(row.id);
    const rowWarnings: any[] = [];
    if (row.baseProfileId && row.baseProfileId !== context.profile.id) {
      rowWarnings.push({ kind: 'foreign-base', id: row.id, baseProfileId: row.baseProfileId, profileId: context.profile.id });
    }
    if (row.kind === 'ADD') {
      if (base) rowWarnings.push({ kind: 'add-collision', id: row.id, profileId: context.profile.id });
      const category = normalizeCategory(row.data);
      if (category) categories.set(category.id, Object.assign({}, category, {
        origin: 'added',
        profileId: context.profile.id,
        baseProfileId: null,
        changedFields: [],
        warnings: rowWarnings,
        ...(opts.withState ? { linkState: 'added' } : {}),
      }));
    } else if (row.kind === 'OVERRIDE') {
      let source = base;
      if (!source) {
        source = normalizeCategory(row.baseData);
        rowWarnings.push({ kind: 'override-using-snapshot', id: row.id, baseProfileId: row.baseProfileId });
      }
      const category = source && normalizeCategory(Object.assign({}, source, row.data, { id: row.id }));
      if (category) categories.set(category.id, Object.assign({}, category, {
        origin: 'override',
        profileId: context.profile.id,
        baseProfileId: row.baseProfileId,
        changedFields: Object.keys(row.data).sort(),
        warnings: rowWarnings,
        ...(opts.withState ? { linkState: 'overridden' } : {}),
      }));
    } else if (row.kind === 'DETACH') {
      const category = normalizeCategory(row.data);
      if (category) categories.set(category.id, Object.assign({}, category, {
        origin: 'detached',
        profileId: context.profile.id,
        baseProfileId: row.baseProfileId,
        changedFields: [],
        warnings: rowWarnings,
        ...(opts.withState ? { linkState: 'detached' } : {}),
      }));
    } else if (row.kind === 'DISABLE') {
      if (!base) rowWarnings.push({ kind: 'redundant-disable', id: row.id, profileId: context.profile.id });
      categories.delete(row.id);
    }
    warnings.push(...rowWarnings.map((warning) => Object.assign({ project: opts.project }, warning)));
  }

  const general = categories.get('general');
  if (!general || !general.enabled) throw new Error(`Routing profile "${context.profile.id}" must resolve an enabled general category.`);
  const result = {
    profile: context.profile,
    categories: [...categories.values()]
      .filter((category?: any) => opts.includeDisabled !== false || category.enabled)
      .sort((a?: any, b?: any) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
    warnings,
  };
  cache.snapshots.set(cacheKey, result);
  return cloneCached(result);
}

function projectCategoryWarnings(project?: any) {
  return resolvedProfileCategories({ project }).warnings;
}

function getCategoryRoutePairs() {
  const pairs: any[] = [];
  const seen = new Set();
  const add = (category?: any) => {
    if (!category) return;
    const route = normalizeRoute(category.route);
    const fallback = category.fallback == null ? null : normalizeRoute(category.fallback);
    if (!route) return;
    const key = JSON.stringify({ route, fallback });
    if (seen.has(key)) return;
    seen.add(key);
    pairs.push({ route, fallback });
  };

  for (const row of database().prepare('SELECT data FROM routing_profile_entries ORDER BY profile_id, position, category_id').all()) {
    try { add(normalizeCategory(JSON.parse(row.data))); } catch (_: any) {}
  }
  for (const row of database().prepare('SELECT slug FROM projects ORDER BY slug').all()) {
    for (const category of getCategories({ project: row.slug })) add(category);
  }
  return pairs;
}

function getProjectCategories(project?: any) {
  return { rows: projectCategoryRows(project), warnings: projectCategoryWarnings(project) };
}

function getCategories(opts?: any) {
  return cloneCached(resolvedProfileCategories(opts).categories);
}

function normalizeCategoryId(id?: any) {
  return String(id || '').trim().toLowerCase();
}

function getCategory(id?: any, opts?: any) {
  const normalizedId = normalizeCategoryId(id);
  opts = opts || {};
  const cache = residentCache();
  const cacheKey = `routing-category:${opts.project || '@default'}:${normalizedId}:${opts.includeDisabled === false ? 'enabled' : 'all'}:${opts.withState === true ? 'state' : 'plain'}`;
  if (cache.snapshots.has(cacheKey)) return cloneCached(cache.snapshots.get(cacheKey));
  const category = resolvedProfileCategories(opts).categories.find((candidate?: any) => candidate.id === normalizedId) || null;
  cache.snapshots.set(cacheKey, category);
  return cloneCached(category);
}

function normalizeArtifactRoots(value?: any) {
  if (!Array.isArray(value)) return [];
  const roots = commitScope.scopedPaths(value);
  return commitScope.validateRelativeScopes(roots).ok ? roots : [];
}

function requireArtifactRoots(value?: any) {
  if (value == null) return;
  if (!Array.isArray(value)) throw new Error('Category artifactRoots must be an array of repository-relative paths.');
  const validation = commitScope.validateRelativeScopes(value);
  if (value.length && !validation.ok) {
    throw new Error(`Category artifactRoots must be repository-relative paths without traversal: ${validation.outside.join(', ')}`);
  }
}

function normalizeCategory(raw?: any) {
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
    artifactRoots: normalizeArtifactRoots(raw.artifactRoots),
    enabled: raw.enabled !== false,
  };
}

function routingProfileCategory(profileId?: any, id?: any) {
  const normalizedId = normalizeCategoryId(id);
  const entry = routingProfileEntries(profileId).find((candidate?: any) => candidate.categoryId === normalizedId);
  return entry ? normalizeCategory(entry.data) : null;
}

function setRoutingProfileCategory(profileId?: any, categoryOrId?: any, patch?: any) {
  const normalizedProfileId = String(profileId || '').trim().toLowerCase();
  const profile = getRoutingProfile(normalizedProfileId);
  if (!profile) throw new Error(`Routing profile "${normalizedProfileId}" does not exist.`);
  const requested = typeof categoryOrId === 'string'
    ? Object.assign({}, routingProfileCategory(normalizedProfileId, categoryOrId), patch || {}, { id: normalizeCategoryId(categoryOrId) })
    : categoryOrId;
  const normalized = normalizeCategory(requested);
  if (!normalized) throw new Error('Category id is required.');
  requireArtifactRoots(requested && requested.artifactRoots);
  if (!normalizeRoute(requested && requested.route)) throw new Error('Category route requires a valid model and effort.');
  if (requested && requested.fallback != null && !normalizeRoute(requested.fallback)) throw new Error('Category fallback requires a valid model and effort.');
  if (normalized.id === 'general' && !normalized.enabled) throw new Error('Category "general" cannot be disabled.');
  const outcome = mutateRoutingPolicy({ profileIds: [normalizedProfileId], categoryIds: [normalized.id] }, (handle?: any) => {
    const now = new Date().toISOString();
    const position = handle.prepare(`
      SELECT COALESCE((SELECT position FROM routing_profile_entries WHERE profile_id = ? AND category_id = ?),
        (SELECT COALESCE(MAX(position), -1) + 1 FROM routing_profile_entries WHERE profile_id = ?)) AS position
    `).get(normalizedProfileId, normalized.id, normalizedProfileId);
    handle.prepare(`
      INSERT INTO routing_profile_entries (profile_id, category_id, data, position, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(profile_id, category_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
    `).run(normalizedProfileId, normalized.id, JSON.stringify(normalized), Number(position?.position ?? 0), now);
    handle.prepare(`
      UPDATE routing_profiles SET revision = revision + 1, seed_revision = NULL, updated_at = ? WHERE id = ?
    `).run(now, normalizedProfileId);
    return normalized;
  });
  return outcome.result;
}

function setCategory(categoryOrId?: any, patch?: any) {
  return setRoutingProfileCategory(defaultRoutingProfileId(), categoryOrId, patch);
}

function removeRoutingProfileCategory(profileId?: any, id?: any) {
  const normalizedProfileId = String(profileId || '').trim().toLowerCase();
  const normalizedId = normalizeCategoryId(id);
  if (normalizedId === 'general') throw new Error('Category "general" cannot be removed.');
  if (!getRoutingProfile(normalizedProfileId)) throw new Error(`Routing profile "${normalizedProfileId}" does not exist.`);
  const outcome = mutateRoutingPolicy({ profileIds: [normalizedProfileId], categoryIds: [normalizedId] }, (handle?: any) => {
    const deleted = handle.prepare('DELETE FROM routing_profile_entries WHERE profile_id = ? AND category_id = ?')
      .run(normalizedProfileId, normalizedId).changes !== 0;
    if (deleted) {
      handle.prepare('UPDATE routing_profiles SET revision = revision + 1, seed_revision = NULL, updated_at = ? WHERE id = ?')
        .run(new Date().toISOString(), normalizedProfileId);
    }
    return deleted;
  });
  return outcome.result;
}

function removeCategory(id?: any) {
  return removeRoutingProfileCategory(defaultRoutingProfileId(), id);
}

function normalizeFullProjectCategory(id?: any, kind?: any, data?: any) {
  const required = ['name', 'description', 'contract', 'route', 'fallback', 'enabled'];
  if (!data || typeof data !== 'object' || Array.isArray(data) || required.some((key?: any) => !Object.hasOwn(data, key))) {
    throw new Error(`Project category ${kind} requires a complete category row.`);
  }
  requireArtifactRoots(data.artifactRoots);
  const normalized = normalizeCategory(Object.assign({}, data, { id }));
  if (!normalized || !normalizeRoute(data.route)) throw new Error(`Project category ${kind} requires a valid full category route.`);
  if (data.fallback != null && !normalizeRoute(data.fallback)) throw new Error(`Project category ${kind} fallback requires a valid model and effort.`);
  return normalized;
}

function setProjectCategory(project?: any, id?: any, kind?: any, data?: any) {
  const normalizedProject = String(project || '').trim();
  const normalizedId = normalizeCategoryId(id);
  const normalizedKind = String(kind || '').trim().toUpperCase();
  if (!normalizedProject || !normalizedId) throw new Error('Project and category id are required.');
  if (!['ADD', 'OVERRIDE', 'DETACH', 'DISABLE'].includes(normalizedKind)) throw new Error('Project category kind must be ADD, OVERRIDE, DETACH, or DISABLE.');
  const selected = projectRoutingProfile(normalizedProject);
  if (!selected) throw new Error(`Project "${normalizedProject}" does not have a routing profile.`);
  const base = routingProfileCategory(selected.profile.id, normalizedId);
  let normalizedData: any;
  if (normalizedKind === 'ADD') {
    if (base) throw new Error(`Project category ADD "${normalizedId}" collides with profile "${selected.profile.id}".`);
    normalizedData = normalizeFullProjectCategory(normalizedId, normalizedKind, data);
  } else if (normalizedKind === 'DETACH') {
    normalizedData = normalizeFullProjectCategory(normalizedId, normalizedKind, data);
    if (normalizedId === 'general' && !normalizedData.enabled) throw new Error('Category "general" cannot be disabled.');
  } else if (normalizedKind === 'OVERRIDE') {
    if (!base) throw new Error(`Project category OVERRIDE "${normalizedId}" requires a profile category.`);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Project category OVERRIDE requires a patch object.');
    const allowed = new Set(['name', 'description', 'contract', 'artifactRoots', 'route', 'fallback']);
    for (const key of Object.keys(data)) if (!allowed.has(key)) throw new Error(`Project category OVERRIDE cannot patch "${key}".`);
    requireArtifactRoots(data.artifactRoots);
    if (data.route != null && !normalizeRoute(data.route)) throw new Error('Project category OVERRIDE route requires a valid model and effort.');
    if (data.fallback != null && !normalizeRoute(data.fallback)) throw new Error('Project category OVERRIDE fallback requires a valid model and effort.');
    normalizedData = Object.assign({}, data);
  } else {
    if (normalizedId === 'general') throw new Error('Category "general" cannot be disabled.');
    if (!base) throw new Error(`Project category DISABLE "${normalizedId}" requires a profile category.`);
    normalizedData = {};
  }
  const baseProfileId = normalizedKind === 'ADD' ? null : selected.profile.id;
  const baseData = normalizedKind === 'OVERRIDE' ? base : null;
  const outcome = mutateRoutingPolicy({ projects: [normalizedProject], categoryIds: [normalizedId] }, (handle?: any) => {
    handle.prepare(`
      INSERT INTO project_categories (project, id, kind, base_profile_id, base_data, data)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(project, id) DO UPDATE SET
        kind = excluded.kind,
        base_profile_id = excluded.base_profile_id,
        base_data = excluded.base_data,
        data = excluded.data
    `).run(
      normalizedProject,
      normalizedId,
      normalizedKind,
      baseProfileId,
      baseData ? JSON.stringify(baseData) : null,
      JSON.stringify(normalizedData),
    );
    return { project: normalizedProject, id: normalizedId, kind: normalizedKind, baseProfileId, baseData, data: normalizedData };
  });
  return outcome.result;
}

function detachCategory(project?: any, id?: any) {
  const normalizedProject = String(project || '').trim();
  const normalizedId = normalizeCategoryId(id);
  if (!normalizedProject || !normalizedId) throw new Error('Project and category id are required.');
  const existing = projectCategoryRows(normalizedProject).find((row?: any) => row.id === normalizedId);
  if (existing && existing.kind === 'DETACH') throw new Error(`Project category "${normalizedId}" is already detached.`);
  const category = getCategory(normalizedId, { project: normalizedProject });
  if (!category) throw new Error(`Project category "${normalizedId}" does not resolve to a category.`);
  return setProjectCategory(normalizedProject, normalizedId, 'DETACH', category);
}

function setProjectRoutingProfile(project?: any, profileId?: any, assignedBy?: any) {
  const normalizedProject = String(project || '').trim();
  const normalizedProfileId = String(profileId || '').trim().toLowerCase();
  if (!normalizedProject || !normalizedProfileId) throw new Error('Project and routing profile id are required.');
  if (!readMeta(normalizedProject)) throw new Error(`Project "${normalizedProject}" does not exist.`);
  const profile = getRoutingProfile(normalizedProfileId);
  if (!profile) throw new Error(`Routing profile "${normalizedProfileId}" does not exist.`);
  if (profile.retiredAt) throw new Error(`Routing profile "${normalizedProfileId}" is retired.`);
  return mutateRoutingPolicy({ projects: [normalizedProject] }, (handle?: any) => {
    const assignedAt = new Date().toISOString();
    handle.prepare(`
      INSERT INTO project_routing_profiles (project, profile_id, assigned_at, assigned_by)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(project) DO UPDATE SET
        profile_id = excluded.profile_id,
        assigned_at = excluded.assigned_at,
        assigned_by = excluded.assigned_by
    `).run(normalizedProject, normalizedProfileId, assignedAt, assignedBy == null ? null : String(assignedBy));
    return { project: normalizedProject, profileId: normalizedProfileId, assignedAt, assignedBy: assignedBy == null ? null : String(assignedBy) };
  }).result;
}

function setNewProjectRoutingProfile(profileId?: any) {
  const normalizedProfileId = String(profileId || '').trim().toLowerCase();
  const profile = getRoutingProfile(normalizedProfileId);
  if (!profile) throw new Error(`Routing profile "${normalizedProfileId}" does not exist.`);
  if (profile.retiredAt) throw new Error(`Routing profile "${normalizedProfileId}" is retired.`);
  return mutateRoutingPolicy({}, (handle?: any) => {
    handle.prepare(`
      INSERT INTO routing_profile_settings (singleton, new_project_profile_id) VALUES (1, ?)
      ON CONFLICT(singleton) DO UPDATE SET new_project_profile_id = excluded.new_project_profile_id
    `).run(normalizedProfileId);
    return { newProjectProfileId: normalizedProfileId };
  }).result;
}

function listRoutingProfiles(opts?: any) {
  const includeRetired = opts && opts.retired === true;
  const sql = `
    SELECT id, name, description, source, seed_key, seed_revision, revision, created_at, updated_at, retired_at
    FROM routing_profiles ${includeRetired ? '' : 'WHERE retired_at IS NULL'} ORDER BY lower(name), id
  `;
  return database().prepare(sql).all().map((row?: any) => Object.assign({}, getRoutingProfile(row.id), {
    entryCount: Number(database().prepare('SELECT COUNT(*) AS count FROM routing_profile_entries WHERE profile_id = ?').get(row.id)?.count ?? 0),
  }));
}

function normalizeRoutingProfileId(profileId?: any) {
  const id = String(profileId || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) throw new Error('Routing profile id must use lowercase letters, numbers, dots, underscores, or hyphens.');
  return id;
}

function routingProfileDetails(profileId?: any) {
  const profile = getRoutingProfile(profileId);
  if (!profile) return null;
  const entries = routingProfileEntries(profile.id).map((entry?: any) => entry.data);
  return Object.assign({}, profile, { entryCount: entries.length, categories: entries });
}

function createRoutingProfile(profileId?: any, opts?: any) {
  opts = opts || {};
  const id = normalizeRoutingProfileId(profileId);
  const fromId = String(opts.from || defaultRoutingProfileId()).trim().toLowerCase();
  const source = getRoutingProfile(fromId);
  if (!source) throw new Error(`Routing profile "${fromId}" does not exist.`);
  const entries = routingProfileEntries(fromId);
  const name = String(opts.name || id).trim();
  if (!name) throw new Error('Routing profile name is required.');
  const now = new Date().toISOString();
  return mutateRoutingPolicy({}, (handle?: any) => {
    if (handle.prepare('SELECT 1 FROM routing_profiles WHERE id = ?').get(id)) throw new Error(`Routing profile "${id}" already exists.`);
    if (handle.prepare('SELECT 1 FROM routing_profiles WHERE lower(name) = lower(?)').get(name)) throw new Error(`Routing profile name "${name}" already exists.`);
    handle.prepare(`
      INSERT INTO routing_profiles (id, name, description, source, seed_key, seed_revision, revision, created_at, updated_at, retired_at)
      VALUES (?, ?, ?, 'user', NULL, NULL, 1, ?, ?, NULL)
    `).run(id, name, String(opts.description || '').trim(), now, now);
    const insert = handle.prepare('INSERT INTO routing_profile_entries (profile_id, category_id, data, position, updated_at) VALUES (?, ?, ?, ?, ?)');
    for (const entry of entries) insert.run(id, entry.categoryId, JSON.stringify(entry.data), entry.position, now);
    return { id, from: fromId, entryCount: entries.length };
  }).result;
}

function editRoutingProfile(profileId?: any, patch?: any) {
  const id = normalizeRoutingProfileId(profileId);
  const profile = getRoutingProfile(id);
  if (!profile) throw new Error(`Routing profile "${id}" does not exist.`);
  patch = patch || {};
  const name = patch.name == null ? profile.name : String(patch.name).trim();
  const description = patch.description == null ? profile.description : String(patch.description).trim();
  if (!name) throw new Error('Routing profile name is required.');
  return mutateRoutingPolicy({ profileIds: [id] }, (handle?: any) => {
    const collision = handle.prepare('SELECT id FROM routing_profiles WHERE lower(name) = lower(?) AND id <> ?').get(name, id);
    if (collision) throw new Error(`Routing profile name "${name}" already exists.`);
    handle.prepare('UPDATE routing_profiles SET name = ?, description = ?, updated_at = ? WHERE id = ?')
      .run(name, description, new Date().toISOString(), id);
    return { id, name, description };
  }).result;
}

function retireRoutingProfile(profileId?: any) {
  const id = normalizeRoutingProfileId(profileId);
  const profile = getRoutingProfile(id);
  if (!profile) throw new Error(`Routing profile "${id}" does not exist.`);
  if (profile.retiredAt) return profile;
  const settings = routingProfileSettings();
  if (settings?.newProjectProfileId === id) throw new Error(`Routing profile "${id}" is the new-board profile and cannot be retired.`);
  const count = Number(database().prepare('SELECT COUNT(*) AS count FROM project_routing_profiles WHERE profile_id = ?').get(id)?.count ?? 0);
  if (count) throw new Error(`Routing profile "${id}" is used by ${count} board${count === 1 ? '' : 's'} and cannot be retired.`);
  return mutateRoutingPolicy({}, (handle?: any) => {
    const retiredAt = new Date().toISOString();
    handle.prepare('UPDATE routing_profiles SET retired_at = ?, updated_at = ? WHERE id = ?').run(retiredAt, retiredAt, id);
    return { id, retiredAt };
  }).result;
}

function canonicalRoutingValue(value?: any): any {
  if (Array.isArray(value)) return value.map(canonicalRoutingValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key?: any) => [key, canonicalRoutingValue(value[key])]));
}

function routingFingerprint(value?: any) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalRoutingValue(value))).digest('hex');
}

function normalizedTaxonomy(project?: any) {
  return getCategories({ project }).map((category?: any) => normalizeCategory(category)).filter(Boolean).sort((a?: any, b?: any) => a.id.localeCompare(b.id));
}

function canonicalLocalRows(rows?: any[]) {
  return (rows || []).map((row?: any) => canonicalRoutingValue({
    id: row.id,
    kind: row.kind,
    baseProfileId: row.baseProfileId ?? row.base_profile_id ?? null,
    baseData: row.baseData ?? row.base_data ?? null,
    data: row.data,
  })).sort((a?: any, b?: any) => a.id.localeCompare(b.id));
}

function localRowsFingerprint(project?: any) {
  return routingFingerprint(canonicalLocalRows(projectCategoryRows(project)));
}

function routingProfileHygiene() {
  const projects = listProjects({ all: true }).map((project?: any) => project.slug).sort();
  const profiles = listRoutingProfiles().filter((profile?: any) => !profile.retiredAt);
  const profileTaxonomies = new Map<string, string>();
  for (const profile of profiles) {
    const taxonomy = routingProfileEntries(profile.id)
      .map((entry?: any) => normalizeCategory(entry.data))
      .filter(Boolean)
      .sort((a?: any, b?: any) => a.id.localeCompare(b.id));
    profileTaxonomies.set(profile.id, routingFingerprint(taxonomy));
  }

  const promotionGroups = new Map<string, any[]>();
  const drift: any[] = [];
  for (const project of projects) {
    const rows = projectCategoryRows(project);
    if (!rows.length) continue;
    const rowFingerprint = routingFingerprint(canonicalLocalRows(rows));
    const group = promotionGroups.get(rowFingerprint) || [];
    group.push({ project, taxonomyFingerprint: routingFingerprint(normalizedTaxonomy(project)) });
    promotionGroups.set(rowFingerprint, group);

    const resolved = resolvedProfileCategories({ project });
    const foreignBaseCount = resolved.warnings.filter((warning?: any) => warning.kind === 'foreign-base').length;
    const effectiveCategoryCount = resolved.categories.length;
    const localRatio = effectiveCategoryCount ? rows.length / effectiveCategoryCount : 0;
    if (rows.length < 3 && localRatio < 0.25 && foreignBaseCount === 0) continue;

    const taxonomyFingerprint = routingFingerprint(normalizedTaxonomy(project));
    const matchingProfiles = profiles
      .filter((profile?: any) => profileTaxonomies.get(profile.id) === taxonomyFingerprint)
      .map((profile?: any) => profile.id);
    const targetProfileId = matchingProfiles.find((profileId?: any) => profileId !== resolved.profile.id) || matchingProfiles[0] || null;
    drift.push({
      kind: targetProfileId ? 'repoint' : 'fork-promote',
      project,
      profileId: resolved.profile.id,
      targetProfileId,
      localRowCount: rows.length,
      effectiveCategoryCount,
      localRatio,
      foreignBaseCount,
      localRowIds: rows.map((row?: any) => row.id),
      taxonomyFingerprint,
    });
  }

  const promotions = [...promotionGroups.entries()]
    .filter(([, boards]: any) => boards.length >= 2)
    .map(([fingerprint, boards]: any) => ({
      kind: 'promote',
      sourceProject: boards[0].project,
      projects: boards.map((board?: any) => board.project),
      localRowCount: projectCategoryRows(boards[0].project).length,
      localRowsFingerprint: fingerprint,
      taxonomyFingerprints: [...new Set(boards.map((board?: any) => board.taxonomyFingerprint))],
    }));

  const pointerCounts = new Map(database().prepare(`
    SELECT profile_id, COUNT(*) AS count FROM project_routing_profiles GROUP BY profile_id
  `).all().map((row?: any) => [row.profile_id, Number(row.count)]));
  const retirements = profiles
    .filter((profile?: any) => (profile.source === 'user' || profile.source === 'migrated') && !pointerCounts.get(profile.id))
    .map((profile?: any) => ({ kind: 'retire', profileId: profile.id, name: profile.name, source: profile.source }));

  return {
    promotions,
    drift,
    retirements,
    proposals: [...promotions, ...drift, ...retirements],
  };
}

function hypotheticalTaxonomy(project?: any, profileId?: any) {
  const categories = new Map<string, any>();
  for (const entry of routingProfileEntries(profileId)) {
    const category = normalizeCategory(entry.data);
    if (category) categories.set(category.id, category);
  }
  for (const row of projectCategoryRows(project)) {
    const base = categories.get(row.id);
    if (row.kind === 'ADD' || row.kind === 'DETACH') {
      const category = normalizeCategory(row.data);
      if (category) categories.set(row.id, category);
    } else if (row.kind === 'OVERRIDE') {
      const category = normalizeCategory(Object.assign({}, base || row.baseData, row.data, { id: row.id }));
      if (category) categories.set(row.id, category);
    } else if (row.kind === 'DISABLE') {
      categories.delete(row.id);
    }
  }
  return [...categories.values()].sort((a?: any, b?: any) => a.id.localeCompare(b.id));
}

function taxonomyDrift(before: any[] = [], after: any[] = []) {
  const previous = new Map(before.map((category?: any) => [category.id, category]));
  const next = new Map(after.map((category?: any) => [category.id, category]));
  const added = [...next.keys()].filter((id?: any) => !previous.has(id));
  const missing = [...previous.keys()].filter((id?: any) => !next.has(id));
  const changed = [...next.keys()].filter((id?: any) => previous.has(id) && routingFingerprint(previous.get(id)) !== routingFingerprint(next.get(id)));
  return { added, missing, changed, hasDrift: added.length + missing.length + changed.length > 0 };
}

function repointRoutingProfiles(fromProfileId?: any, toProfileId?: any, opts?: any) {
  opts = opts || {};
  const from = normalizeRoutingProfileId(fromProfileId);
  const to = normalizeRoutingProfileId(toProfileId);
  if (!getRoutingProfile(from)) throw new Error(`Routing profile "${from}" does not exist.`);
  const target = getRoutingProfile(to);
  if (!target) throw new Error(`Routing profile "${to}" does not exist.`);
  if (target.retiredAt) throw new Error(`Routing profile "${to}" is retired.`);
  const projects = database().prepare('SELECT project FROM project_routing_profiles WHERE profile_id = ? ORDER BY project').all(from).map((row?: any) => row.project);
  const boards = projects.map((project?: any) => ({ project, drift: taxonomyDrift(normalizedTaxonomy(project), hypotheticalTaxonomy(project, to)) }));
  if (opts.dryRun) return { from, to, dryRun: true, boards };
  return mutateRoutingPolicy({ projects }, (handle?: any) => {
    const assignedAt = new Date().toISOString();
    const update = handle.prepare('UPDATE project_routing_profiles SET profile_id = ?, assigned_at = ?, assigned_by = ? WHERE project = ? AND profile_id = ?');
    for (const project of projects) update.run(to, assignedAt, opts.assignedBy == null ? null : String(opts.assignedBy), project, from);
    return { from, to, dryRun: false, boards };
  }).result;
}

function promoteRoutingProfile(profileId?: any, sourceProject?: any, projects?: any[], opts?: any) {
  opts = opts || {};
  const id = normalizeRoutingProfileId(profileId);
  const source = String(sourceProject || '').trim();
  const selected = [...new Set((projects || []).map((project?: any) => String(project || '').trim()).filter(Boolean))];
  if (!readMeta(source)) throw new Error(`Project "${source}" does not exist.`);
  if (!selected.length) throw new Error('Profile promotion requires at least one target board.');
  const taxonomy = normalizedTaxonomy(source);
  const taxonomyHash = routingFingerprint(taxonomy);
  const rowHash = localRowsFingerprint(source);
  for (const project of selected) {
    if (!readMeta(project)) throw new Error(`Project "${project}" does not exist.`);
    if (routingFingerprint(normalizedTaxonomy(project)) !== taxonomyHash || localRowsFingerprint(project) !== rowHash) {
      throw new Error(`Project "${project}" does not match the source taxonomy and local-row fingerprint.`);
    }
  }
  const name = String(opts.name || id).trim();
  const now = new Date().toISOString();
  return mutateRoutingPolicy({ projects: selected }, (handle?: any) => {
    if (handle.prepare('SELECT 1 FROM routing_profiles WHERE id = ?').get(id)) throw new Error(`Routing profile "${id}" already exists.`);
    if (handle.prepare('SELECT 1 FROM routing_profiles WHERE lower(name) = lower(?)').get(name)) throw new Error(`Routing profile name "${name}" already exists.`);
    handle.prepare(`
      INSERT INTO routing_profiles (id, name, description, source, seed_key, seed_revision, revision, created_at, updated_at, retired_at)
      VALUES (?, ?, ?, 'user', NULL, NULL, 1, ?, ?, NULL)
    `).run(id, name, String(opts.description || '').trim(), now, now);
    const insert = handle.prepare('INSERT INTO routing_profile_entries (profile_id, category_id, data, position, updated_at) VALUES (?, ?, ?, ?, ?)');
    taxonomy.forEach((category?: any, position?: any) => insert.run(id, category.id, JSON.stringify(category), position, now));
    const repoint = handle.prepare('UPDATE project_routing_profiles SET profile_id = ?, assigned_at = ?, assigned_by = ? WHERE project = ?');
    const clear = handle.prepare('DELETE FROM project_categories WHERE project = ?');
    for (const project of selected) {
      repoint.run(id, now, opts.assignedBy == null ? null : String(opts.assignedBy), project);
      clear.run(project);
    }
    return { id, sourceProject: source, projects: selected, entryCount: taxonomy.length, taxonomyFingerprint: taxonomyHash, localRowsFingerprint: rowHash };
  }).result;
}

function removeProjectCategory(project?: any, id?: any) {
  const normalizedProject = String(project || '').trim();
  const normalizedId = normalizeCategoryId(id);
  if (!normalizedProject || !normalizedId) throw new Error('Project and category id are required.');
  return mutateRoutingPolicy({ projects: [normalizedProject], categoryIds: [normalizedId] }, (handle?: any) => (
    handle.prepare('DELETE FROM project_categories WHERE project = ? AND id = ?')
      .run(normalizedProject, normalizedId).changes !== 0
  )).result;
}

function classifierCategories(opts?: any) {
  return getCategories(Object.assign({}, opts, { includeDisabled: false })).map(({ id, name, description, route, fallback, contract }: any) => ({ id, name, description, route, fallback, contract }));
}

function resolveCategoryRoute(category?: any) {
  const warnings: any[] = [];
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

function resolveCategoryFallback(category?: any, failedModel?: any) {
  const candidates = [
    { source: 'category fallback', route: category && category.fallback },
    { source: 'global fallback', route: getRoutingFallback() },
    { source: 'hardwired fallback', route: ROUTING_FALLBACK_DEFAULT },
  ];
  for (const candidate of candidates) {
    const route = normalizeRoute(candidate.route);
    if (!route) continue;
    const exec = resolveExec(route.model, route.effort);
    if (!exec || exec.runsModel === failedModel) continue;
    return { model: exec.runsModel, effort: route.effort, exec, source: candidate.source };
  }
  return null;
}

function ticketCategory(ticket?: any) {
  if (!ticket || ticket.category == null) return null;
  return typeof ticket.category === 'object' ? ticket.categoryId || ticket.category.id : String(ticket.category);
}

function execProjection(exec?: any) {
  return { agent: exec.agent, model: exec.model, backend: exec.backend, runsModel: exec.runsModel, apiModel: exec.apiModel, runsLabel: exec.runsLabel, dispatch: exec.dispatch };
}

function applyDerivedRouting(t?: any, opts?: any) {
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
  const dispatchRoute = activeDispatchRoute(t);
  if (dispatchRoute) {
    const dispatchExec = resolveExec(dispatchRoute.model, dispatchRoute.effort);
    if (dispatchExec) {
      t.model = dispatchExec.runsModel;
      t.effort = dispatchRoute.effort;
      t.exec = execProjection(dispatchExec);
      const state = dispatchState(t);
      if (state && state.recovery) {
        warnings.push(`This dispatch is temporarily using ${t.model} at ${t.effort} after ${state.recovery.failedModel} quota exhaustion; category policy is unchanged.`);
      }
      if (state && state.policyChangedAt) {
        warnings.push(`This active dispatch was prepared before routing policy changed at ${state.policyChangedAt}; its prepared route remains in force for this attempt.`);
      }
    }
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
const STORY_COLOR_NAMES: Record<string, string> = {
  terracotta: '#c2683f', teal: '#3f8f8a', violet: '#7a5ba8', olive: '#7d8a3f',
  rose: '#b45573', steel: '#4a72a8', amber: '#c19a3e', green: '#4f8f6a',
};

// Normalize a requested story colour to a #rrggbb string, or null if it isn't a
// hex (#rgb / #rrggbb) or a known name — callers fall back to autoStoryColor().
function parseStoryColor(input?: any) {
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
function autoStoryColor(index?: any) {
  const n = STORY_PALETTE.length;
  return STORY_PALETTE[(((index || 0) % n) + n) % n];
}

function defaultProjectName(absPath?: any) {
  return path.basename(path.resolve(absPath)) || 'project';
}

function normalizeAlwaysInScope(paths?: any) {
  if (!Array.isArray(paths)) throw new Error('alwaysInScope must be an array of repo-relative paths.');
  const seen = new Set();
  const normalized: any[] = [];
  for (const value of paths) {
    const item = String(value || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
    const relative = item.replace(/\/+$/, '');
    if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
      throw new Error(`alwaysInScope path must stay inside the board repo: ${value}`);
    }
    const key = process.platform === 'win32' ? relative.toLowerCase() : relative;
    if (!seen.has(key)) {
      seen.add(key);
      normalized.push(item);
    }
  }
  return normalized;
}

function defaultAlwaysInScope(absPath?: any) {
  try {
    return fs.statSync(path.join(absPath, 'docs')).isDirectory() ? ['docs/'] : [];
  } catch (_: any) {
    return [];
  }
}

function normalizeIntegrationMode(mode?: any) {
  const value = String(mode || 'auto').trim().toLowerCase();
  if (!['auto', 'local', 'remote'].includes(value)) {
    throw new Error('integrationMode must be "auto", "local", or "remote".');
  }
  return value;
}

function normalizeWorktreeIsolation(value?: any) {
  if (value == null) return true;
  if (typeof value !== 'boolean') throw new Error('worktreeIsolation must be a boolean.');
  return value;
}

function normalizeWorktreeSetup(value?: any) {
  if (value == null || String(value).trim() === '') return null;
  const setup = String(value);
  if (/[\r\n]/.test(setup)) throw new Error('worktreeSetup must be a one-line command.');
  if (setup.length > WORKTREE_SETUP_MAX_LENGTH) {
    throw new Error(`worktreeSetup exceeds the ${WORKTREE_SETUP_MAX_LENGTH}-character board-config limit.`);
  }
  return setup;
}

function hasOriginRemote(absPath?: any) {
  try {
    execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: absPath, encoding: 'utf8', windowsHide: true, stdio: 'pipe' });
    return true;
  } catch (_: any) {
    return false;
  }
}

function integrationTarget(slug?: any) {
  const meta = readMeta(slug);
  if (!meta) return null;
  const configured = normalizeIntegrationMode(meta.integrationMode);
  const mode = configured === 'auto' ? (hasOriginRemote(meta.path) ? 'remote' : 'local') : configured;
  return { mode, upstream: mode === 'local' ? 'main' : 'origin/main', branch: 'main' };
}

function normalizeBoardName(value?: any) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) throw new Error('Board name cannot be empty.');
  return name;
}

function boardConfig(slug?: any) {
  const meta = readMeta(slug);
  if (!meta) return null;
  const selected = projectRoutingProfile(slug);
  if (!selected) throw new Error(`Project "${slug}" does not have a routing profile.`);
  const layer = getProjectCategories(slug);
  const byKind = Object.fromEntries(['ADD', 'OVERRIDE', 'DETACH', 'DISABLE'].map((kind?: any) => [kind, layer.rows.filter((row?: any) => row.kind === kind).length]));
  return {
    name: meta.name,
    alwaysInScope: Array.isArray(meta.alwaysInScope) ? normalizeAlwaysInScope(meta.alwaysInScope) : defaultAlwaysInScope(meta.path),
    integrationMode: normalizeIntegrationMode(meta.integrationMode),
    worktreeIsolation: normalizeWorktreeIsolation(meta.worktreeIsolation),
    worktreeSetup: normalizeWorktreeSetup(meta.worktreeSetup),
    profile: {
      id: selected.profile.id,
      name: selected.profile.name,
      revision: selected.profile.revision,
      entryCount: routingProfileEntries(selected.profile.id).length,
    },
    overrides: {
      count: layer.rows.length,
      byKind,
      foreignBaseCount: layer.rows.filter((row?: any) => row.baseProfileId && row.baseProfileId !== selected.profile.id).length,
      items: layer.rows,
    },
    warnings: [...selected.warnings, ...layer.warnings],
  };
}

function setBoardConfig(slug?: any, patch?: any) {
  return withMetaLock(slug, () => {
    const meta = readMeta(slug);
    if (!meta) return { ok: false, reason: 'not_found' };
    if (!patch || typeof patch !== 'object') return { ok: true, config: boardConfig(slug) };
    if (Object.prototype.hasOwnProperty.call(patch, 'name')) {
      meta.name = normalizeBoardName(patch.name);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'alwaysInScope')) {
      meta.alwaysInScope = normalizeAlwaysInScope(patch.alwaysInScope);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'integrationMode')) {
      meta.integrationMode = normalizeIntegrationMode(patch.integrationMode);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'worktreeIsolation')) {
      meta.worktreeIsolation = normalizeWorktreeIsolation(patch.worktreeIsolation);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'worktreeSetup')) {
      meta.worktreeSetup = normalizeWorktreeSetup(patch.worktreeSetup);
    }
    putProject(slug, meta);
    return { ok: true, config: boardConfig(slug) };
  });
}

function effectiveScope(slug?: any, files?: any) {
  const config = boardConfig(slug);
  return Array.from(new Set([...(Array.isArray(files) ? files : []), ...((config && config.alwaysInScope) || [])]));
}

// Register (or refresh) a project and return { slug, dir, meta }. Creates the
// directory tree on first use. `name` overrides the display name (defaults to
// the folder basename).
function ensureProject(absPath?: any, name?: any) {
  const resolved = path.resolve(absPath);
  const slug = slugify(resolved);
  const dir = projectDir(slug);
  ensureDir(ticketsDir(slug));
  let meta: any;
  let changed = false;
  transaction(() => {
    const handle = database();
    meta = db.getRow(handle, 'projects', slug);
    if (!meta || typeof meta !== 'object') {
      meta = {
        path: resolved,
        name: name || defaultProjectName(resolved),
        createdAt: new Date().toISOString(),
        seq: 0,
        storySeq: 0,
        alwaysInScope: defaultAlwaysInScope(resolved),
        worktreeIsolation: true,
      };
      db.putRow(handle, 'projects', { slug, data: meta });
      changed = true;
    } else {
      if (meta.path !== resolved) { meta.path = resolved; changed = true; }
      if (name && meta.name !== name) { meta.name = name; changed = true; }
      if (!meta.name) { meta.name = defaultProjectName(resolved); changed = true; }
      if (typeof meta.seq !== 'number') { meta.seq = 0; changed = true; }
      if (typeof meta.storySeq !== 'number') { meta.storySeq = 0; changed = true; }
      if (changed) db.putRow(handle, 'projects', { slug, data: meta });
    }
    const pointer = handle.prepare('SELECT project FROM project_routing_profiles WHERE project = ?').get(slug);
    if (!pointer) {
      const settings = handle.prepare('SELECT new_project_profile_id FROM routing_profile_settings WHERE singleton = 1').get();
      if (!settings?.new_project_profile_id) throw new Error('The new-board routing profile is not configured.');
      db.putRow(handle, 'project_routing_profiles', {
        project: slug,
        profile_id: settings.new_project_profile_id,
        assigned_at: new Date().toISOString(),
        assigned_by: 'ensure-project',
      });
      changed = true;
    }
  });
  if (changed) invalidateStoreCaches();
  return { slug, dir, meta };
}

function readMeta(slug?: any) {
  const key = String(slug || '');
  const cache = residentCache();
  if (cache.metadata.has(key)) return cloneCached(cache.metadata.get(key));
  const meta = db.getRow(database(), 'projects', key);
  cache.metadata.set(key, meta);
  return cloneCached(meta);
}

function metaLockPath(slug?: any) {
  return path.join(projectDir(slug), '.meta.lock');
}

function withMetaLock(slug?: any, fn?: any) {
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
function nextSeq(slug?: any) {
  return withMetaLock(slug, () => {
    const meta = readMeta(slug) || { seq: 0 };
    meta.seq = (typeof meta.seq === 'number' ? meta.seq : 0) + 1;
    putProject(slug, meta);
    return meta.seq;
  });
}

// The story counter is a second monotonic sequence on the same project row,
// minting US-1, US-2, … independently of the SQ-N ticket refs.
function nextStorySeq(slug?: any) {
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
function setProjectNotify(slug?: any, on?: any) {
  return withMetaLock(slug, () => {
    const meta = readMeta(slug);
    if (!meta) return { ok: false, reason: 'not_found' };
    meta.notify = on !== false;
    putProject(slug, meta);
    return { ok: true, notify: meta.notify };
  });
}

function setProjectRouting(slug?: any, routing?: any) {
  if (!['enabled', 'disabled'].includes(routing)) throw new Error('Routing must be enabled or disabled.');
  return withMetaLock(slug, () => {
    const meta = readMeta(slug);
    if (!meta) return { ok: false, reason: 'not_found' };
    meta.routing = routing;
    putProject(slug, meta);
    return { ok: true, routing: meta.routing };
  });
}

function projectRoutingEnabled(slug?: any) {
  const meta = readMeta(slug);
  return !meta || meta.routing !== 'disabled';
}

// Board-level archive is a reversible project-row stamp. Project data and tickets
// remain in place, and repeat calls keep the original archive timestamp.
function archiveProject(slug?: any) {
  return withMetaLock(slug, () => {
    const meta = readMeta(slug);
    if (!meta) return { ok: false, reason: 'not_found' };
    if (meta.archivedAt) return { ok: true, slug, archivedAt: meta.archivedAt, alreadyArchived: true };
    meta.archivedAt = new Date().toISOString();
    putProject(slug, meta);
    return { ok: true, slug, archivedAt: meta.archivedAt, alreadyArchived: false };
  });
}

function unarchiveProject(slug?: any) {
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
function deleteProjectExact(slug?: any) {
  if (typeof slug !== 'string' || !/^[a-z0-9][a-z0-9-]{1,80}$/.test(slug)) return { ok: false, reason: 'not_found' };
  if (!readMeta(slug)) return { ok: false, reason: 'not_found' };
  transaction(() => {
    for (const ticket of db.listRows(database(), 'tickets', { project: slug })) deleteCachedRow(database(), 'tickets', ticket.id);
    for (const story of db.listRows(database(), 'stories', { project: slug })) deleteCachedRow(database(), 'stories', story.id);
    deleteCachedRow(database(), 'projects', slug);
  });
  fs.rmSync(projectDir(slug), { recursive: true, force: true });
  return { ok: true, slug };
}

// List every registered project with live ticket counts. Sorted by most recent
// activity so the busiest board floats to the top of the switcher. By default,
// archived boards are hidden. Pass { archived: true } to list only archived
// boards, or { all: true } for internal resolution.
function listProjects(opts?: any) {
  opts = opts || {};
  const cache = residentCache();
  const cacheKey = `projects:${opts.all ? 'all' : opts.archived ? 'archived' : 'active'}`;
  const cached = cache.snapshots.get(cacheKey);
  if (cached) return cloneCached(cached);

  const rows = db.selectRows(database(), `
    SELECT
      p.slug,
      p.data,
      COALESCE(t.todo, 0) AS todo,
      COALESCE(t.doing, 0) AS doing,
      COALESCE(t.done, 0) AS done,
      COALESCE(t.active, 0) AS active,
      COALESCE(t.archived, 0) AS archived,
      t.last_activity,
      COALESCE(s.stories, 0) AS stories
    FROM projects p
    LEFT JOIN (
      SELECT
        project,
        SUM(CASE WHEN archived = 0 AND status = 'todo' THEN 1 ELSE 0 END) AS todo,
        SUM(CASE WHEN archived = 0 AND status = 'doing' THEN 1 ELSE 0 END) AS doing,
        SUM(CASE WHEN archived = 0 AND status = 'done' THEN 1 ELSE 0 END) AS done,
        SUM(CASE WHEN archived = 0 THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN archived != 0 THEN 1 ELSE 0 END) AS archived,
        MAX(json_extract(data, '$.updatedAt')) AS last_activity
      FROM tickets
      GROUP BY project
    ) t ON t.project = p.slug
    LEFT JOIN (
      SELECT project, COUNT(*) AS stories
      FROM stories
      GROUP BY project
    ) s ON s.project = p.slug
  `);

  const out: any[] = [];
  for (const row of rows) {
    let meta: any;
    try { meta = JSON.parse(row.data); } catch (_: any) { continue; }
    if (!meta || !meta.path) continue;
    const archivedAt = meta.archivedAt || null;
    if (!opts.all && (opts.archived ? !archivedAt : !!archivedAt)) continue;
    const counts = { todo: Number(row.todo) || 0, doing: Number(row.doing) || 0, done: Number(row.done) || 0 };
    out.push({
      slug: slugify(meta.path),
      name: meta.name || row.slug,
      path: meta.path || '',
      counts,
      total: Number(row.active) || 0,
      archived: Number(row.archived) || 0,
      open: counts.todo + counts.doing,
      lastActivity: row.last_activity || meta.createdAt || null,
      notify: meta.notify !== false,
      routing: meta.routing === 'disabled' ? 'disabled' : 'enabled',
      stories: Number(row.stories) || 0,
      archivedAt,
    });
  }
  out.sort((a?: any, b?: any) => String(b.lastActivity || '').localeCompare(String(a.lastActivity || '')));
  cache.snapshots.set(cacheKey, out);
  return cloneCached(out);
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
function findProject(ref?: any) {
  const arg = String(ref == null ? '' : ref).trim();
  if (!arg) return { ok: false, reason: 'not_found', known: listProjects({ all: true }).map((project?: any) => project.name) };

  if (path.isAbsolute(arg)) {
    const resolvedPath = path.resolve(arg);
    const slug = slugify(resolvedPath);
    const meta = readMeta(slug);
    if (meta && normalizeForHash(meta.path) === normalizeForHash(resolvedPath)) return { ok: true, slug, meta };
  } else {
    const meta = readMeta(arg);
    if (meta) return { ok: true, slug: arg, meta };
  }

  const projects = db.selectRows(database(), 'SELECT slug, data FROM projects ORDER BY slug')
    .map((row?: any) => {
      try { return { slug: row.slug, meta: JSON.parse(row.data) }; } catch (_: any) { return null; }
    })
    .filter(Boolean);

  const wantedName = arg.toLowerCase();
  const byName = projects.filter((project?: any) => String(project.meta.name || project.slug).trim().toLowerCase() === wantedName);
  if (byName.length === 1) return { ok: true, slug: byName[0].slug, meta: byName[0].meta };
  if (byName.length > 1) {
    return {
      ok: false,
      reason: 'ambiguous',
      matches: byName.map((project?: any) => ({ slug: project.slug, name: project.meta.name || project.slug, path: project.meta.path || '' })),
    };
  }

  if (!path.isAbsolute(arg)) {
    const wantedPath = normalizeForHash(path.resolve(arg));
    const byPath = projects.find((project?: any) => project.meta.path && normalizeForHash(path.resolve(project.meta.path)) === wantedPath);
    if (byPath) return { ok: true, slug: byPath.slug, meta: byPath.meta };
  }

  return { ok: false, reason: 'not_found', known: projects.map((project?: any) => project.meta.name || project.slug) };
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
function mergeProject(srcSlug?: any, destSlug?: any, opts?: any) {
  opts = opts || {};
  const dryRun = !!opts.dryRun;
  if (srcSlug === destSlug) throw new Error('source and destination are the same board');
  if (!readMeta(srcSlug)) throw new Error(`source board "${srcSlug}" does not exist`);
  if (!readMeta(destSlug)) throw new Error(`destination board "${destSlug}" does not exist`);

  // Oldest-first so re-minted refs preserve the source's creation order.
  const tickets = listTickets(srcSlug).slice().sort((a?: any, b?: any) => seqOfRef(a.ref) - seqOfRef(b.ref));
  const stories = listStories(srcSlug); // listStories already returns oldest-first

  // Plan the ref renumbering up front so link remapping can see every mapping.
  const refMap: Record<string, any> = {}; // OLD-TICKET-REF (upper) -> NEW-TICKET-REF
  const ticketPlan: any[] = [];
  for (const t of tickets) {
    const newRef = dryRun ? `SQ-?` : `SQ-${nextSeq(destSlug)}`;
    if (t.ref) refMap[String(t.ref).toUpperCase()] = newRef;
    ticketPlan.push({ ticket: t, newRef });
  }
  const storyPlan: any[] = [];
  for (const s of stories) {
    const newRef = dryRun ? `US-?` : `US-${nextStorySeq(destSlug)}`;
    storyPlan.push({ story: s, newRef });
  }

  const mapping = ticketPlan.map(({ ticket, newRef }: any) => ({ from: ticket.ref, to: newRef, title: ticket.title }));
  if (dryRun) return { tickets: ticketPlan.length, stories: storyPlan.length, mapping };

  // Stories first, so a moved ticket's storyId still finds its story in dest.
  transaction(() => {
    for (const ticket of tickets) deleteCachedRow(database(), 'tickets', ticket.id);
    for (const story of stories) deleteCachedRow(database(), 'stories', story.id);
    for (const { story, newRef } of storyPlan) {
      const moved = Object.assign({}, story, { ref: newRef });
      putStory(destSlug, moved);
    }
    for (const { ticket, newRef } of ticketPlan) {
      const links = Array.isArray(ticket.links)
        ? ticket.links.map((l?: any) => Object.assign({}, l, { ref: refMap[String(l.ref).toUpperCase()] || l.ref }))
        : [];
      const moved = Object.assign({}, ticket, { ref: newRef, links });
      putTicket(destSlug, moved);
      const srcAssets = assetsDir(srcSlug, ticket.id);
      if (fs.existsSync(srcAssets)) {
        try {
          fs.cpSync(srcAssets, assetsDir(destSlug, ticket.id), { recursive: true });
        } catch (_: any) {
          /* an unreadable asset folder shouldn't abort the whole merge */
        }
      }
    }
    deleteCachedRow(database(), 'projects', srcSlug);
  });

  try {
    fs.rmSync(projectDir(srcSlug), { recursive: true, force: true });
  } catch (_: any) {
    /* best effort; the tickets already live in dest */
  }
  return { tickets: ticketPlan.length, stories: storyPlan.length, mapping };
}

// Pull the numeric sequence out of an "SQ-12" ref for ordering; junk sorts last.
function seqOfRef(ref?: any) {
  const m = /(\d+)\s*$/.exec(String(ref || ''));
  return m ? parseInt(m[1]!, 10) : Number.MAX_SAFE_INTEGER;
}

/* ------------------------------------------------------------------ *
 *  Assets (images attached to a ticket)
 * ------------------------------------------------------------------ */

function sanitizeFilename(name?: any) {
  const base = path.basename(String(name || 'image')).replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+/, '');
  return base || 'image';
}

// Copy a source image into a ticket's asset folder and return the stored
// filename (deduped on collision). Throws on an unreadable source so the CLI
// can report it; callers that must not throw wrap this.
function copyAsset(slug?: any, id?: any, srcPath?: any) {
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

function assetPath(slug?: any, id?: any, filename?: any) {
  // Guard against path traversal in a filename coming from the HTTP layer.
  const safe = path.basename(String(filename));
  return path.join(assetsDir(slug, id), safe);
}

// Save raw image bytes (e.g. a screenshot pasted into the dashboard) into a
// ticket's asset folder, deduping the filename. Returns the stored filename.
function saveAssetData(slug?: any, id?: any, name?: any, buffer?: any) {
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

function parseTicketData(slug: string, data: unknown): any | null {
  try {
    const ticket = typeof data === 'string' ? JSON.parse(data) : data;
    return ticket && ticket.id ? applyDerivedRouting(ticket, { project: slug }) : null;
  } catch (_: any) {
    return null;
  }
}

function queryTickets(slug: string, opts: any = {}): any[] {
  const statuses = opts.status == null
    ? []
    : (Array.isArray(opts.status) ? opts.status : [opts.status]).map((status?: any) => String(status).toLowerCase());
  const unfiltered = opts.archived == null && statuses.length === 0 && opts.limit == null && !opts.offset;
  const cache = residentCache();
  const cacheKey = `tickets:${slug}`;
  if (unfiltered) {
    const cached = cache.snapshots.get(cacheKey);
    if (cached) return cloneCached(cached);
  }

  const clauses = ['project = ?'];
  const parameters: any[] = [slug];
  if (opts.archived != null) {
    clauses.push('archived = ?');
    parameters.push(opts.archived ? 1 : 0);
  }
  if (statuses.length) {
    clauses.push(`status IN (${statuses.map(() => '?').join(', ')})`);
    parameters.push(...statuses);
  }
  let sql = `SELECT data FROM tickets WHERE ${clauses.join(' AND ')} ORDER BY ord DESC`;
  if (opts.limit != null) {
    sql += ' LIMIT ? OFFSET ?';
    parameters.push(Math.max(0, Math.floor(Number(opts.limit)) || 0), Math.max(0, Math.floor(Number(opts.offset)) || 0));
  }
  const tickets = db.selectRows(database(), sql, parameters)
    .map((row?: any) => parseTicketData(slug, row.data))
    .filter(Boolean);
  if (unfiltered) cache.snapshots.set(cacheKey, tickets);
  return cloneCached(tickets);
}

function countTickets(slug: string, opts: any = {}): number {
  const statuses = opts.status == null
    ? []
    : (Array.isArray(opts.status) ? opts.status : [opts.status]).map((status?: any) => String(status).toLowerCase());
  const clauses = ['project = ?'];
  const parameters: any[] = [slug];
  if (opts.archived != null) {
    clauses.push('archived = ?');
    parameters.push(opts.archived ? 1 : 0);
  }
  if (statuses.length) {
    clauses.push(`status IN (${statuses.map(() => '?').join(', ')})`);
    parameters.push(...statuses);
  }
  const row = db.selectRow(database(), `SELECT COUNT(*) AS count FROM tickets WHERE ${clauses.join(' AND ')}`, parameters);
  return Number(row && row.count) || 0;
}

function listTickets(slug?: any) {
  return queryTickets(String(slug || ''));
}

function listAllProjectTickets(archivedOnly: boolean = false): any[] {
  const cache = residentCache();
  const cacheKey = `all-project-tickets:${archivedOnly ? 'archived' : 'active'}`;
  const cached = cache.snapshots.get(cacheKey);
  if (cached) return cloneCached(cached);
  const rows = db.selectRows(database(), `
    WITH active_projects AS (
      SELECT
        p.slug,
        p.data,
        COALESCE(MAX(json_extract(all_t.data, '$.updatedAt')), json_extract(p.data, '$.createdAt'), '') AS last_activity
      FROM projects p
      LEFT JOIN tickets all_t ON all_t.project = p.slug
      WHERE json_extract(p.data, '$.archivedAt') IS NULL
      GROUP BY p.slug, p.data
    )
    SELECT
      tickets.data,
      active_projects.slug AS project,
      COALESCE(json_extract(active_projects.data, '$.name'), active_projects.slug) AS project_name
    FROM active_projects
    JOIN tickets ON tickets.project = active_projects.slug
    WHERE tickets.archived = ?
    ORDER BY active_projects.last_activity DESC, tickets.ord DESC
  `, [archivedOnly ? 1 : 0]);
  const tickets = rows
    .map((row?: any) => {
      const ticket = parseTicketData(row.project, row.data);
      return ticket ? Object.assign({}, ticket, { project: row.project, projectName: row.project_name }) : null;
    })
    .filter(Boolean);
  cache.snapshots.set(cacheKey, tickets);
  return cloneCached(tickets);
}

function getTicket(slug?: any, idOrRef?: any) {
  const wanted = String(idOrRef);
  const row = db.selectRow(
    database(),
    'SELECT data FROM tickets WHERE project = ? AND (id = ? OR upper(ref) = upper(?)) LIMIT 1',
    [String(slug || ''), wanted, wanted],
  );
  return row ? parseTicketData(String(slug || ''), row.data) : null;
}

function coerceStatus(s?: any, fallback?: any) {
  s = String(s || '').toLowerCase();
  return VALID_STATUS.includes(s) ? s : fallback;
}

function requireStatus(s?: any) {
  const status = String(s).toLowerCase();
  if (!VALID_STATUS.includes(status)) {
    throw new Error(`Invalid status "${s}". Valid statuses: ${VALID_STATUS.join(', ')}. Deletion is not a status; use the MCP remove tool or CLI rm.`);
  }
  return status;
}
function coercePriority(p?: any, fallback?: any) {
  p = String(p || '').toLowerCase();
  return VALID_PRIORITY.includes(p) ? p : fallback;
}

const EXECUTOR_ANCHORS_MAX = 4000;
const EXECUTOR_VERIFY_MAX = 1000;
const DISPATCH_DESCRIPTION_MIN = 80;
const DISPATCH_DESCRIPTION_GUIDANCE = "the executor's entire brief is this ticket; add a description (Where / Contract / Verify) and a verify command, then dispatch";

// Per-ticket executor context stays deliberately small: this data may be passed
// through a Windows command surface with an 8191-character ceiling. Keep the
// anchors as written so the eventual executor prompt can carry them verbatim.
function executorText(value?: any, max?: any, label?: any) {
  if (value == null) return '';
  const text = String(value);
  if (text.length > max) throw new Error(`${label} exceeds the ${max}-character executor-context limit.`);
  return text;
}

function ticketReferenceWarnings(slug?: any, title?: any, description?: any) {
  const refs = new Set((`${title || ''}\n${description || ''}`.match(/\bSQ-\d+\b/gi) || []).map((ref?: any) => ref.toUpperCase()));
  if (!refs.size) return [];
  const known = new Set(listTickets(slug).map((ticket?: any) => String(ticket.ref).toUpperCase()));
  const unknown = [...refs].filter((ref?: any) => !known.has(ref));
  return unknown.length ? [`Unknown ticket refs: ${unknown.join(', ')}.`] : [];
}

function ticketPrescribesFix(description?: any) {
  const body = String(description || '');
  if (/^\s*fix\s*:/im.test(body)) return true;
  if (/\b(?:replace|change)\s+\S[\s\S]{0,160}?\s+(?:with|to)\s+\S/i.test(body)) return true;
  if (/```(?:diff|patch)?\s*\r?\n[\s\S]*?^-\S[\s\S]*?^\+\S[\s\S]*?```/im.test(body)) return true;
  return (body.match(/^\s*\d+[.)]\s+(?:add|change|replace|remove|rename|move|update|set|delete|edit|wire)\b/gim) || []).length >= 2;
}

function ticketCategoryWarnings(ticket?: any) {
  if (ticketCategory(ticket) !== 'coding.hard' || !ticketPrescribesFix(ticket && ticket.description)) return [];
  return ['coding.hard is for unknown approaches; this description already spells out the fix, which usually means coding.normal. Recheck the category.'];
}

function dispatchDescriptionError(ticket?: any) {
  if (!ticket || !ticket.model || !ticket.effort) return null;
  if (String(ticket.description || '').trim().length >= DISPATCH_DESCRIPTION_MIN) return null;
  return `dispatch: ${DISPATCH_DESCRIPTION_GUIDANCE}.`;
}

function storyContractDriftWarnings(ticket?: any) {
  const contractDrift = ticket && (ticket.storyContractDrift || dispatchState(ticket)?.storyContractDrift);
  if (!contractDrift) return [];
  return [`Dispatch warning: ${contractDrift.storyRef || 'story'} execution contract changed from revision ${contractDrift.fromRevision} to ${contractDrift.toRevision} while this ticket was claimed; the next briefing uses revision ${contractDrift.toRevision}.`];
}

function dispatchWarnings(ticket?: any, slug?: any) {
  const warnings: any[] = [];
  if (readOnlyOverrideActive(ticket)) warnings.push('readonly override active: this read-only category routes through the writing executor.');
  const worktreeWarning = dispatchState(ticket)?.worktreeWarning;
  if (worktreeWarning) warnings.push(worktreeWarning);
  const categoryId = ticket && (ticket.categoryId || (ticket.category && ticket.category.id));
  if (/^(?:coding(?:\.|$)|debugging$)/.test(String(categoryId || '')) && !String(ticket.executorVerify || '').trim()) {
    warnings.push('Dispatch warning: this coding/debugging ticket has no verify command. Add one before the executor starts.');
  }
  warnings.push(...storyContractDriftWarnings(ticket));
  const declaredFiles = dispatchDeclaredFiles(ticket);
  const outside = externalDeclaredFiles(declaredFiles);
  if (outside.length) {
    warnings.push(`Dispatch warning: declared paths are outside the repo worktree: ${outside.join(', ')}. A repo-changing category can't commit them. Use an artifact/non-repo category, or declare in-repo paths.`);
  }
  if (!slug || !declaredFiles.length) return warnings;
  for (const sibling of listTickets(slug)) {
    if (sibling.id === ticket.id) continue;
    const dispatch = dispatchState(sibling);
    const liveClaim = sibling.claim && sibling.claim.by && !isClaimStale(sibling.claim);
    const liveDispatch = dispatch && !dispatch.terminalAt && ['prepared', 'launched', 'bound', 'claimed'].includes(pulseDispatchState(dispatch));
    if (!liveClaim && !liveDispatch) continue;
    const overlaps = overlappingScopePaths(declaredFiles, dispatchDeclaredFiles(sibling));
    const contractReasons = contractCollisionReasons(ticket, sibling);
    if (!overlaps.length && !contractReasons.length) continue;
    if (overlaps.length) {
      const lockfilesOnly = overlaps.every((file?: any) => /(?:^|\/)(?:Cargo\.lock|package-lock\.json|pnpm-lock\.yaml)$/i.test(file));
      const lockfileGuidance = lockfilesOnly
        ? ' Only lockfiles overlap; serialize these tickets or regenerate the lockfile at integration.'
        : '';
      warnings.push(`Dispatch warning: ${ticket.ref} overlaps in-flight ${sibling.ref} at ${overlaps.join(', ')}.${lockfileGuidance}`);
    }
    for (const collision of contractReasons) {
      warnings.push(`Dispatch warning: contract edge with in-flight ${sibling.ref}: ${collision.message} Serialize unless a reviewed contract waiver applies.`);
    }
  }
  return warnings;
}

function dispatchDeclaredFiles(ticket?: any) {
  const dispatch = dispatchState(ticket);
  return normalizeFiles(dispatch && Array.isArray(dispatch.declaredFiles) ? dispatch.declaredFiles : ticket && ticket.files);
}

function externalDeclaredFiles(files?: any) {
  return commitScope.validateRelativeScopes(files).outside;
}

function nonRepoExternalOutput(ticket?: any, files?: any) {
  const declaredFiles = normalizeFiles(files);
  const outside = externalDeclaredFiles(declaredFiles);
  return declaredFiles.length > 0
    && outside.length === declaredFiles.length
    && isReadOnlyCategory(ticketCategory(ticket))
    && !readOnlyOverrideActive(ticket);
}

function ticketPlanningWarnings(ticket?: any, projectPath?: any) {
  if (!ticket) return [];
  const warnings: any[] = [];
  const outside = externalDeclaredFiles(ticket.files);
  if (outside.length) {
    warnings.push(`Planning-depth warning: declared paths are outside the repo worktree: ${outside.join(', ')}. A repo-changing category can't commit them. Use an artifact/non-repo category, or declare in-repo paths.`);
  }
  if (Number(ticket.complexity) >= 4) {
    const missing: any[] = [];
    if (!String(ticket.executorAnchors || '').trim()) missing.push('executor anchors');
    if (!String(ticket.executorVerify || '').trim()) missing.push('verify command');
    if (!Array.isArray(ticket.files) || !ticket.files.length) missing.push('file scope');
    if (missing.length) {
      warnings.push(`Planning-depth warning: complexity 4+ tickets should include executor anchors, an exact verify command, and declared file scope before dispatch; missing: ${missing.join(', ')}.`);
    }
  }
  if (!projectPath || !Array.isArray(ticket.files)) return warnings;
  const absent = ticket.files.filter((file?: any) => !fs.existsSync(path.resolve(projectPath, file)));
  if (absent.length) warnings.push(`Planning-depth warning: declared file scope does not exist in the repo: ${absent.join(', ')}.`);
  return warnings;
}

function normalizeReadonlyOverride(value?: any) {
  return value === false ? false : null;
}

function requestedReadonlyOverride(fields?: any) {
  return normalizeReadonlyOverride(fields?.readonlyOverride === undefined ? fields?.readonly : fields.readonlyOverride);
}

function readOnlyOverrideActive(ticket?: any) {
  return ticket?.readonlyOverride === false && isReadOnlyCategory(ticketCategory(ticket));
}

function createTicket(slug?: any, fields?: any) {
  fields = fields || {};
  const status = fields.status === undefined ? 'todo' : requireStatus(fields.status);
  const id = newTicketId();
  const seq = nextSeq(slug);
  const now = new Date().toISOString();

  const assets: any[] = [];
  const imgs = Array.isArray(fields.images) ? fields.images : [];
  for (const src of imgs) {
    try {
      assets.push(copyAsset(slug, id, src));
    } catch (e: any) {
      // Record which image could not be attached; the CLI surfaces this.
      if (fields.onAssetError) fields.onAssetError(src, e);
    }
  }
  for (const d of asDataImages(fields.imagesData)) {
    try {
      assets.push(saveAssetData(slug, id, d.name, d.buffer));
    } catch (_: any) {
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
    highStakes: !!fields.highStakes,
    storyId: coerceStoryId(slug, fields.storyId), // the user story this ticket belongs to (null = none)
    category: fields.category == null ? null : String(fields.category).trim().toLowerCase() || null,
    complexity: coerceComplexity(fields.complexity), // 1..10 score the routing is derived from (entry points require it)
    complexityWhy: String(fields.complexityWhy || '').trim().slice(0, 1000), // the mandatory motivation for the score
    files: normalizeFiles(fields.files),          // declared file scope, for parallel-wave planning
    contracts: normalizeContracts(fields.contracts), // declared contract edges, for parallel-wave planning
    contractWaiver: !!fields.contractWaiver,
    readonlyOverride: requestedReadonlyOverride(fields),
    executorAnchors: executorText(fields.executorAnchors, EXECUTOR_ANCHORS_MAX, 'executor anchors'),
    executorVerify: executorText(fields.executorVerify, EXECUTOR_VERIFY_MAX, 'executor verify command'),
    assets,
    comments: [],              // [{ id, by, body, kind: 'comment', at }]
    links: [],                 // [{ type: 'blocks'|'blocked-by'|'related', ref }]
    claim: null,               // { by, at } when an agent has claimed it to work on
    checkpoint: null,
    dispatchNonce: null,
    dispatchExecutor: null,
    directClaim: null,
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
function asDataImages(list?: any) {
  if (!Array.isArray(list)) return [];
  const out: any[] = [];
  for (const d of list) {
    if (!d || typeof d.base64 !== 'string') continue;
    const b64 = d.base64.replace(/^data:[^;]+;base64,/, '');
    try {
      const buffer = Buffer.from(b64, 'base64');
      if (buffer.length) out.push({ name: d.name, buffer });
    } catch (_: any) {
      /* skip */
    }
  }
  return out;
}

function normalizeLabels(labels?: any) {
  if (!labels) return [];
  const arr = Array.isArray(labels) ? labels : String(labels).split(',');
  const seen = new Set();
  const out: any[] = [];
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
function normalizeFiles(files?: any) {
  if (!files) return [];
  const arr = Array.isArray(files) ? files : String(files).split(',');
  const seen = new Set();
  const out: any[] = [];
  for (const f of arr) {
    const v = String(f).trim().replace(/\\/g, '/').replace(/\/+$/, '').slice(0, 200);
    if (v && !seen.has(v.toLowerCase())) {
      seen.add(v.toLowerCase());
      out.push(v);
    }
  }
  return out.slice(0, 20);
}

function scopeExpansionFiles(ticket?: any, additions?: any) {
  return normalizeFiles([...(Array.isArray(ticket?.files) ? ticket.files : []), ...normalizeFiles(additions)]);
}

function scopeExpansionCommand(ticket?: any, additions?: any) {
  const ref = String(ticket?.ref || '').trim();
  if (!ref) return null;
  return `sidequest update ${ref} --files ${JSON.stringify(scopeExpansionFiles(ticket, additions).join(','))}`;
}

function requestScope(slug?: any, idOrRef?: any, by?: any, files?: any, opts?: any) {
  opts = opts || {};
  by = String(by || 'agent');
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: 'not_found' };
  return withTicketLock(slug, found.id, () => {
    const t = getTicket(slug, found.id);
    if (!t) return { ok: false, reason: 'not_found' };
    const held = t.claim;
    if (!held || !held.by || isClaimStale(held)) return { ok: false, reason: 'not_claimed', ticket: t };
    if (held.by !== by && !opts.force) return { ok: false, reason: 'not_owner', ticket: t, claim: held };
    const requested = normalizeFiles(files);
    if (!requested.length) return { ok: false, reason: 'files_required', ticket: t };
    const validation = commitScope.validateRelativeScopes(requested);
    if (!validation.ok) return { ok: false, reason: 'invalid_scope', ticket: t, paths: validation.outside };
    const additions = requested.filter((file?: any) => !commitScope.isInScope(file, effectiveScope(slug, t.files)));
    if (!additions.length) return { ok: false, reason: 'already_in_scope', ticket: t };
    const now = new Date().toISOString();
    const command = scopeExpansionCommand(t, additions);
    t.scopeRequest = { by, files: additions, at: now };
    const dispatch = dispatchState(t);
    if (dispatch && !dispatch.terminalAt) dispatch.scopeRequest = t.scopeRequest;
    if (!Array.isArray(t.comments)) t.comments = [];
    const comment = createComment({
      by,
      body: `Scope expansion requested: ${additions.join(', ')}. Approve with \`${command}\`; claim remains held.`,
      kind: 'comment',
      source: opts.source || 'cli',
    }, now);
    t.comments.push(comment);
    t.lastEventType = 'scope_request';
    t.lastEventSource = opts.source || 'cli';
    t.updatedAt = now;
    putTicket(slug, t);
    queueEventNotification(slug, t, 'comment', comment.source, { commentBody: comment.body });
    return { ok: true, ticket: t, scopeRequest: t.scopeRequest, command, comment };
  });
}

// Do two declared scopes collide? A path conflicts with an equal path or with
// one that is a directory-prefix of it (case-insensitive, "/"-normalized).
// Empty scopes never conflict mechanically — "no declaration" means "no
// information", and the skill tells the orchestrator how to treat that.
function overlappingScopePaths(filesA?: any, filesB?: any) {
  const a = normalizeFiles(filesA);
  const b = normalizeFiles(filesB);
  const overlaps = new Map();
  for (const x of a) {
    for (const y of b) {
      const left = x.toLowerCase();
      const right = y.toLowerCase();
      const overlap = left === right ? x : (left.startsWith(right + '/') ? x : (right.startsWith(left + '/') ? y : null));
      if (overlap) overlaps.set(overlap.toLowerCase(), overlap);
    }
  }
  return Array.from(overlaps.values()).sort((left?: any, right?: any) => left.localeCompare(right));
}

function scopesOverlap(filesA?: any, filesB?: any) {
  return overlappingScopePaths(filesA, filesB).length > 0;
}

const CONTRACT_EDGE_KINDS = ['produces', 'changes', 'consumes'];

function normalizeContractNames(values?: any) {
  if (!values) return [];
  const entries = Array.isArray(values) ? values : String(values).split(',');
  const seen = new Set();
  const normalized: any[] = [];
  for (const value of entries) {
    const name = String(value).trim().slice(0, 200);
    if (name && !seen.has(name.toLowerCase())) {
      seen.add(name.toLowerCase());
      normalized.push(name);
    }
  }
  return normalized.slice(0, 20);
}

function normalizeContracts(contracts?: any) {
  const source = contracts && typeof contracts === 'object' ? contracts : {};
  return Object.fromEntries(CONTRACT_EDGE_KINDS.map((kind) => [kind, normalizeContractNames(source[kind])]));
}

function contractNamesByLowerCase(values?: any) {
  return new Map(normalizeContractNames(values).map((value?: any) => [value.toLowerCase(), value]));
}

function contractCollisionReasons(left?: any, right?: any) {
  if (!left || !right || left.contractWaiver || right.contractWaiver) return [];
  const leftContracts = normalizeContracts(left.contracts);
  const rightContracts = normalizeContracts(right.contracts);
  const reasons: any[] = [];
  const matchingNames = (a?: any, b?: any) => {
    const matches: any[] = [];
    for (const [key, name] of contractNamesByLowerCase(a)) {
      if (contractNamesByLowerCase(b).has(key)) matches.push(name);
    }
    return matches.sort((a?: any, b?: any) => a.localeCompare(b));
  };
  for (const contract of matchingNames(leftContracts.produces, rightContracts.consumes)) {
    reasons.push({ contract, type: 'produces-consumes', message: `${left.ref} produces ${contract}, which ${right.ref} consumes.` });
  }
  for (const contract of matchingNames(rightContracts.produces, leftContracts.consumes)) {
    reasons.push({ contract, type: 'produces-consumes', message: `${right.ref} produces ${contract}, which ${left.ref} consumes.` });
  }
  for (const contract of matchingNames(leftContracts.changes, rightContracts.changes)) {
    reasons.push({ contract, type: 'changes-changes', message: `${left.ref} and ${right.ref} both change ${contract}.` });
  }
  return reasons;
}

function ticketsConflict(left?: any, right?: any) {
  return scopesOverlap(left.files, right.files) || contractCollisionReasons(left, right).length > 0;
}

function orderReadyTicketsByContractDependencies(tickets?: any) {
  const ordered = Array.isArray(tickets) ? tickets : [];
  const edges = new Map(ordered.map((ticket?: any) => [ticket.id, new Set()]));
  for (const producer of ordered) {
    if (producer.contractWaiver) continue;
    const produced = contractNamesByLowerCase(normalizeContracts(producer.contracts).produces);
    for (const consumer of ordered) {
      if (producer.id === consumer.id || consumer.contractWaiver) continue;
      const consumed = contractNamesByLowerCase(normalizeContracts(consumer.contracts).consumes);
      const dependencies = edges.get(producer.id);
      if (dependencies && [...produced.keys()].some((name?: any) => consumed.has(name))) dependencies.add(consumer.id);
    }
  }
  const pending = new Set(ordered.map((ticket?: any) => ticket.id));
  const result: any[] = [];
  while (pending.size) {
    const next = ordered.find((ticket?: any) => {
      if (!pending.has(ticket.id)) return false;
      for (const [from, targets] of edges) {
        if (pending.has(from) && targets.has(ticket.id)) return false;
      }
      return true;
    }) || ordered.find((ticket?: any) => pending.has(ticket.id));
    result.push(next);
    pending.delete(next.id);
  }
  return result;
}

function contractMetadata(ticket?: any) {
  const contracts = normalizeContracts(ticket && ticket.contracts);
  return {
    produces: contracts.produces,
    changes: contracts.changes,
    consumes: contracts.consumes,
    waiver: !!(ticket && ticket.contractWaiver),
  };
}

// Partition the ready set into waves an orchestrator can fan out one wave at a
// time: within a wave no two tickets' declared scopes or named contracts
// conflict. Greedy first-fit in priority order, so wave 1 is "start these now",
// wave 2 "after wave 1", etc. Tickets with no declarations never mechanically
// conflict.
function readyWaves(slug?: any, opts?: any) {
  const ready = orderReadyTicketsByContractDependencies(readyTickets(slug, opts));
  const waves: any[] = [];
  for (const t of ready) {
    let placed = false;
    for (const wave of waves) {
      if (!wave.some((w?: any) => ticketsConflict(w, t))) {
        wave.push(t);
        placed = true;
        break;
      }
    }
    if (!placed) waves.push([t]);
  }
  return waves;
}

function readyWaveDependencies(slug?: any, opts?: any) {
  const waves = readyWaves(slug, opts);
  const dependencies: any[] = [];
  for (let waveIndex = 1; waveIndex < waves.length; waveIndex++) {
    for (const ticket of waves[waveIndex]) {
      for (let priorWave = 0; priorWave < waveIndex; priorWave++) {
        for (const earlier of waves[priorWave]) {
          for (const reason of contractCollisionReasons(earlier, ticket)) {
            dependencies.push({ before: earlier.ref, after: ticket.ref, contract: reason.contract, type: reason.type, reason: reason.message });
          }
        }
      }
    }
  }
  return dependencies;
}

// An assignee is a free-form name (the human "you", or an agent). Empty/blank
// clears it back to null (unassigned).
function normalizeAssignee(v?: any) {
  if (v == null) return null;
  const s = String(v).trim().slice(0, 60);
  return s || null;
}

function updateDoneRefusal(ticket?: any) {
  if (ticket.claim && ticket.claim.by && !isClaimStale(ticket.claim)) {
    return `${ticket.ref} is claimed. Use done/completeTicket for eligible non-repo or artifact work; scoped repository work must commit and submit.`;
  }
  if (pendingSubmission(ticket)) {
    return `${ticket.ref} has a pending submission. Complete it through the integration lifecycle; update --status done cannot consume submitted work.`;
  }
  const state = dispatchState(ticket);
  if (ticket.dispatchNonce || (state && !state.terminalAt)) {
    return `${ticket.ref} has an active dispatch. Its executor must use done/completeTicket or commit and submit; update --status done cannot bypass that lifecycle.`;
  }
  if (state) {
    return `${ticket.ref} has routed dispatch history. Executors cannot close released repository work; use the control-plane grooming closure with evidence.`;
  }
  return null;
}

// Apply a partial update. Only known fields are written; unknown keys ignored.
// Locked (like every other mutator) so a concurrent comment/claim/link append
// can never be silently overwritten by an update whose read predates it.
function updateTicket(slug?: any, idOrRef?: any, patch?: any) {
  const found = getTicket(slug, idOrRef);
  if (!found) return null;
  patch = patch || {};
  const apply = (t?: any) => {
    const nextStatus = patch.status == null ? null : requireStatus(patch.status);
    const doneRefusal = nextStatus === 'done' ? updateDoneRefusal(t) : null;
    if (doneRefusal) throw new Error(doneRefusal);
    const prevStatus = t.status;
    if (patch.title != null) t.title = String(patch.title).trim().slice(0, 300) || t.title;
    if (patch.description != null) t.description = String(patch.description).trim();
    if (patch.status != null) t.status = nextStatus;
    if (patch.priority != null) t.priority = coercePriority(patch.priority, t.priority);
    if (patch.labels != null) t.labels = normalizeLabels(patch.labels);
    if (patch.highStakes !== undefined) t.highStakes = !!patch.highStakes;
    if (patch.storyId !== undefined) t.storyId = coerceStoryId(slug, patch.storyId);
    if (patch.category !== undefined) t.category = patch.category == null ? null : String(patch.category).trim().toLowerCase() || null;
    // Complexity can move to another valid score, never clear; a fresh motivation
    // rides along whenever one is provided (the CLI demands one on change).
    if (patch.complexity !== undefined) { const c = coerceComplexity(patch.complexity); if (c) t.complexity = c; }
    if (patch.complexityWhy !== undefined && String(patch.complexityWhy).trim()) t.complexityWhy = String(patch.complexityWhy).trim().slice(0, 1000);
    if (patch.files !== undefined) {
      t.files = normalizeFiles(patch.files);
      const request = t.scopeRequest;
      if (request && Array.isArray(request.files) && request.files.every((file?: any) => commitScope.isInScope(file, effectiveScope(slug, t.files)))) {
        t.scopeRequest = null;
        const dispatch = dispatchState(t);
        if (dispatch && !dispatch.terminalAt) {
          dispatch.declaredFiles = t.files.slice();
          delete dispatch.scopeRequest;
        }
      }
    }
    if (patch.contracts !== undefined) t.contracts = normalizeContracts(patch.contracts);
    if (patch.contractWaiver !== undefined) t.contractWaiver = !!patch.contractWaiver;
    if (patch.readonly !== undefined || patch.readonlyOverride !== undefined) t.readonlyOverride = requestedReadonlyOverride(patch);
    if (patch.executorAnchors !== undefined) t.executorAnchors = executorText(patch.executorAnchors, EXECUTOR_ANCHORS_MAX, 'executor anchors');
    if (patch.executorVerify !== undefined) t.executorVerify = executorText(patch.executorVerify, EXECUTOR_VERIFY_MAX, 'executor verify command');
    // A provenance stamp may ride along a patch (e.g. the dashboard completing a
    // ticket). Permissive like the routing fields above: a valid stamp is set, a
    // bad one is ignored rather than thrown (the data layer never crashes a write).
    if (patch.workedBy !== undefined) {
      try { const w = makeWorkedBy(patch.workedBy); if (w) t.workedBy = w; } catch (_: any) { /* ignore an invalid stamp on a patch */ }
    }
    if (patch.assignee !== undefined) t.assignee = normalizeAssignee(patch.assignee);
    if (patch.order != null && Number.isFinite(Number(patch.order))) t.order = Number(patch.order);
    // Attach any newly supplied images (by path from the CLI, or base64 from the
    // dashboard). Also allow removing an attached asset by filename.
    const imgs = Array.isArray(patch.images) ? patch.images : [];
    for (const src of imgs) {
      try {
        t.assets.push(copyAsset(slug, t.id, src));
      } catch (e: any) {
        if (patch.onAssetError) patch.onAssetError(src, e);
      }
    }
    for (const d of asDataImages(patch.imagesData)) {
      try {
        t.assets.push(saveAssetData(slug, t.id, d.name, d.buffer));
      } catch (_: any) {
        /* skip */
      }
    }
    if (Array.isArray(patch.removeAssets) && patch.removeAssets.length) {
      const drop = new Set(patch.removeAssets.map((f?: any) => path.basename(String(f))));
      t.assets = t.assets.filter((a?: any) => {
        if (!drop.has(a)) return true;
        try {
          fs.unlinkSync(assetPath(slug, t.id, a));
        } catch (_: any) {
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
function deleteTicket(slug?: any, idOrRef?: any) {
  const found = getTicket(slug, idOrRef);
  if (!found) return false;
  const deletedRef = found.ref;
  const lock = ticketLockPath(slug, found.id);
  const locked = acquireLock(lock);
  let ok = false;
  try {
    ok = deleteCachedRow(database(), 'tickets', found.id);
    if (ok) {
      try {
        fs.rmSync(assetsDir(slug, found.id), { recursive: true, force: true });
      } catch (_: any) {
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
      if (Array.isArray(other.links) && other.links.some((l?: any) => upperRef(l.ref) === upperRef(deletedRef))) {
        stripLinksTo(slug, other.id, deletedRef);
      }
    }
  } catch (_: any) {
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

function setArchived(slug?: any, idOrRef?: any, archived?: any, opts?: any) {
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

function archiveTicket(slug?: any, idOrRef?: any, opts?: any) {
  return setArchived(slug, idOrRef, true, opts);
}
function unarchiveTicket(slug?: any, idOrRef?: any, opts?: any) {
  return setArchived(slug, idOrRef, false, opts);
}

// Archive every done, not-yet-archived ticket in a project. Returns the refs.
function archiveAllDone(slug?: any, opts?: any) {
  const refs: any[] = [];
  for (const ticket of queryTickets(String(slug || ''), { status: 'done', archived: false })) {
    const result = setArchived(slug, ticket.id, true, opts);
    if (result.ok) refs.push(result.ticket.ref);
  }
  return { ok: true, archived: refs };
}

function listArchived(slug?: any) {
  return queryTickets(String(slug || ''), { archived: true });
}
function listActive(slug?: any) {
  return queryTickets(String(slug || ''), { archived: false });
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

const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

function priorityRank(p?: any) {
  return Object.prototype.hasOwnProperty.call(PRIORITY_RANK, p) ? (PRIORITY_RANK[String(p)] ?? 9) : 9;
}

const DEFAULT_CLAIM_TTL_MIN = 60;
const DEFAULT_PREPARED_DISPATCH_TTL_HOURS = 6;

function preparedDispatchTtlMs() {
  const hours = Number(process.env.SIDEQUEST_PREPARED_DISPATCH_TTL_HOURS);
  return (Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_PREPARED_DISPATCH_TTL_HOURS) * 60 * 60 * 1000;
}

// How long a claim stays valid without being refreshed before another worker
// may take it over (a crashed/abandoned worker must never wedge a ticket).
function claimTtlMs() {
  const min = Number(process.env.SIDEQUEST_CLAIM_TTL_MIN);
  return (Number.isFinite(min) && min > 0 ? min : DEFAULT_CLAIM_TTL_MIN) * 60 * 1000;
}

function isClaimStale(claim?: any) {
  if (!claim || !claim.at) return true;
  const t = Date.parse(claim.at);
  if (!Number.isFinite(t)) return true;
  return Date.now() - t > claimTtlMs();
}

function ticketLockPath(slug?: any, id?: any) {
  return path.join(ticketsDir(slug), '.' + path.basename(String(id)) + '.lock');
}

// A tiny synchronous pause. The lock is contended only under genuinely
// simultaneous claims and is held for microseconds, so this never runs long.
function busyWait(ms?: any) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    /* spin */
  }
}

function testClaimLockDelayMs() {
  const delay = Number(process.env.SIDEQUEST_TEST_CLAIM_LOCK_DELAY_MS);
  return Number.isInteger(delay) && delay > 0 ? delay : 0;
}

// Acquire a short-lived exclusive lock for a ticket. A lock file older than a
// few seconds is treated as abandoned (holder crashed mid-claim) and reclaimed,
// so a crash can never permanently wedge a ticket.
function acquireLock(lockPath?: any) {
  const STALE_LOCK_MS = 5000;
  const RETRY_MS = 5;
  const MAX_ATTEMPTS = STALE_LOCK_MS / RETRY_MS;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try {
        fs.writeSync(fd, String(process.pid) + ' ' + new Date().toISOString());
      } catch (_: any) {
        /* ignore */
      }
      fs.closeSync(fd);
      return true;
    } catch (e: any) {
      if (!e || e.code !== 'EEXIST') return false;
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > STALE_LOCK_MS) {
          try {
            fs.unlinkSync(lockPath);
          } catch (_: any) {
            /* ignore */
          }
          continue;
        }
      } catch (_: any) {
        continue; // lock vanished between open and stat: retry immediately
      }
      busyWait(RETRY_MS);
    }
  }
  return false;
}

function releaseLock(lockPath?: any) {
  const RETRY_MS = 5;
  for (let attempt = 0; attempt < 1000; attempt++) {
    try {
      fs.unlinkSync(lockPath);
      return;
    } catch (error: any) {
      if (!error || !['EACCES', 'EBUSY', 'EPERM'].includes(error.code)) return;
      busyWait(RETRY_MS);
    }
  }
}

function withTicketLock(slug?: any, id?: any, fn?: any) {
  const lock = ticketLockPath(slug, id);
  if (!acquireLock(lock)) return { ok: false, reason: 'busy' };
  try {
    return transaction(fn);
  } finally {
    releaseLock(lock);
  }
}

// The stable session-start executor receives the briefing and token in its prompt.
function stableExecutorName(ticket?: any) {
  if (!ticket || !ticket.model || !ticket.effort) throw new Error('dispatch executor requires a routable ticket.');
  const resolved = resolveExec(ticket.model, ticket.effort);
  if (!resolved || !resolved.agent) throw new Error(`no stable executor for ${ticket.model} at ${ticket.effort}.`);
  if (!isReadOnlyCategory(ticketCategory(ticket)) || readOnlyOverrideActive(ticket)) return resolved.agent;
  return resolved.backend === 'codex'
    ? stableReadOnlyDispatchName(ticket.effort)
    : stableReadOnlyClaudeName(ticket.effort);
}

// Prepare a ticket for dispatch: persist a fresh claim nonce and the stable
// executor name the claim guard requires. The briefing and token ride the spawn
// prompt, so no executor definition is written.
function dispatchTokenPrefix(token?: any) {
  return token ? String(token).slice(0, 12) : null;
}

function dispatchState(ticket?: any) {
  return ticket && ticket.dispatch && typeof ticket.dispatch === 'object' ? ticket.dispatch : null;
}

function sharedTreeArtifactRequested(ticket?: any) {
  return String(ticket && ticket.description || '')
    .split(/\r?\n/)
    .some((line) => line.trim() === SHARED_TREE_ARTIFACT_MARKER);
}

function categoryArtifactRoot(category?: any, scope?: any) {
  const normalizedScope = commitScope.scopedPaths([scope]);
  if (normalizedScope.length !== 1 || !commitScope.validateRelativeScopes(normalizedScope).ok) return null;
  const roots = normalizeArtifactRoots(category && category.artifactRoots);
  return roots.find((root?: any) => commitScope.isInScope(normalizedScope[0], [root])) || null;
}

function sharedTreeArtifactMode(ticket?: any) {
  const state = dispatchState(ticket);
  return Boolean(state
    && state.sharedTree === true
    && state.artifactMode === true
    && typeof state.artifactRoot === 'string'
    && state.artifactRoot
    && typeof state.artifactScope === 'string'
    && state.artifactScope);
}

function dirtyPathKey(file?: any) {
  const normalized = String(file || '').replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function artifactPathIdentity(root?: any, file?: any) {
  const absolute = path.resolve(root, file);
  let stat;
  try {
    stat = fs.lstatSync(absolute, { bigint: true });
  } catch (error: any) {
    if (error && error.code === 'ENOENT') return 'missing';
    throw error;
  }
  let kind = 'other';
  if (stat.isFile()) kind = 'file';
  else if (stat.isSymbolicLink()) kind = 'symlink';
  else if (stat.isDirectory()) kind = 'directory';
  let content = null;
  if (kind === 'file' || kind === 'symlink') {
    content = execFileSync('git', ['hash-object', '--no-filters', '--', file], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
  }
  return [kind, stat.mode, stat.size, stat.dev, stat.ino, content].map((value) => String(value == null ? '' : value)).join(':');
}

function artifactWorkingState(slug?: any) {
  const meta = readMeta(slug);
  if (!meta || !meta.path) throw new Error('the board project path is unavailable');
  const output = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    cwd: meta.path,
    encoding: 'utf8',
    windowsHide: true,
  });
  const raw = output.split('\0');
  const states: any[] = [];
  for (let index = 0; index < raw.length; index++) {
    const entry = raw[index];
    if (!entry) continue;
    const status = entry.slice(0, 2);
    const file = entry.slice(3).replace(/\\/g, '/');
    if (file) states.push({ file, status });
    if (status.includes('R') || status.includes('C')) {
      const previous = raw[++index];
      if (previous) states.push({ file: previous.replace(/\\/g, '/'), status: `${status}:source` });
    }
  }
  if (states.length > ARTIFACT_BASELINE_MAX_PATHS) {
    throw new Error(`artifact dirty baseline exceeds ${ARTIFACT_BASELINE_MAX_PATHS} paths`);
  }
  return states
    .map((entry) => {
      const indexState = execFileSync('git', ['ls-files', '--stage', '-z', '--', entry.file], {
        cwd: meta.path,
        encoding: 'utf8',
        windowsHide: true,
      });
      const identity = crypto.createHash('sha256')
        .update(JSON.stringify({
          status: entry.status,
          index: indexState,
          worktree: artifactPathIdentity(meta.path, entry.file),
        }))
        .digest('hex');
      return { path: entry.file, identity };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

function captureArtifactBaseline(slug?: any, scope?: any) {
  const meta = readMeta(slug);
  if (!meta || !meta.path) throw new Error('prepare dispatch: shared-tree artifact mode requires a board project path.');
  const resolution = commitScope.validateScopeResolution(meta.path, [scope], { inspectDescendants: true });
  if (!resolution.ok) {
    const rejected = (resolution.indirect && resolution.indirect.length ? resolution.indirect : resolution.outside).join(', ');
    throw new Error(`prepare dispatch: artifact scope must be a direct path inside the board project: ${rejected}`);
  }
  try {
    return artifactWorkingState(slug);
  } catch (error: any) {
    const detail = error && error.message ? ` ${error.message}` : '';
    throw new Error(`prepare dispatch: shared-tree artifact mode requires a readable Git working tree.${detail}`);
  }
}

function artifactScopeCheck(slug?: any, ticket?: any, state?: any) {
  if (!Array.isArray(state.artifactDirtyBaseline)
    || state.artifactDirtyBaseline.some((entry?: any) => !entry || typeof entry.path !== 'string' || typeof entry.identity !== 'string')) {
    return {
      ok: false,
      reason: 'artifact_baseline_missing',
      message: `${ticket.ref} has no content-aware dispatch-time dirty baseline. Release it and dispatch again before closing the artifact.`,
    };
  }
  const approvedRoot = categoryArtifactRoot({ artifactRoots: [state.artifactRoot] }, state.artifactScope);
  if (!approvedRoot) {
    return {
      ok: false,
      reason: 'artifact_scope_violation',
      message: `${ticket.ref} artifact scope is outside its dispatch-time approved root. Release it and dispatch again.`,
    };
  }
  const meta = readMeta(slug);
  const resolution = meta && meta.path
    ? commitScope.validateScopeResolution(meta.path, [state.artifactScope], { inspectDescendants: true })
    : { ok: false, reason: 'scope_unavailable', indirect: [] };
  if (!resolution.ok) {
    const indirection = resolution.reason === 'filesystem_indirection';
    return {
      ok: false,
      reason: indirection ? 'artifact_scope_indirection' : 'artifact_scope_unavailable',
      message: indirection
        ? `${ticket.ref} artifact scope contains filesystem indirection: ${resolution.indirect.join(', ')}. Replace it with direct in-project paths or release the ticket.`
        : `${ticket.ref} cannot resolve the shared-tree artifact scope directly inside the project. Release it and dispatch again.`,
      ...(indirection ? { indirectPaths: resolution.indirect } : {}),
    };
  }
  let current: any[];
  try {
    current = artifactWorkingState(slug);
  } catch (_: any) {
    return {
      ok: false,
      reason: 'artifact_scope_unavailable',
      message: `${ticket.ref} cannot verify the shared-tree artifact scope. Release it and dispatch again from a readable Git working tree.`,
    };
  }
  const baseline = new Map(state.artifactDirtyBaseline.map((entry?: any) => [dirtyPathKey(entry.path), entry]));
  const currentByPath = new Map(current.map((entry?: any) => [dirtyPathKey(entry.path), entry]));
  const changed = new Set<string>();
  for (const entry of state.artifactDirtyBaseline) {
    if (commitScope.isInScope(entry.path, [state.artifactScope])) continue;
    const now: any = currentByPath.get(dirtyPathKey(entry.path));
    if (!now || now.identity !== entry.identity) changed.add(entry.path);
  }
  for (const entry of current) {
    if (!baseline.has(dirtyPathKey(entry.path)) && !commitScope.isInScope(entry.path, [state.artifactScope])) changed.add(entry.path);
  }
  const outside = Array.from(changed).sort();
  if (!outside.length) return { ok: true };
  return {
    ok: false,
    reason: 'artifact_scope_violation',
    message: `${ticket.ref} changed paths outside artifact scope ${state.artifactScope}: ${outside.join(', ')}. Revert those changes or release the ticket instead of closing it.`,
    unscopedPaths: outside,
  };
}

function activeDispatchRoute(ticket?: any) {
  const state = dispatchState(ticket);
  if (!state || state.terminalAt || !ticket.dispatchNonce) return null;
  return normalizeRoute(state.route);
}

function rederiveUnlaunchedPreparedRoute(ticket?: any, project?: any) {
  const state = dispatchState(ticket);
  if (!state || state.recovery || state.terminalAt || state.outcome !== 'prepared' || state.launchedAt || state.boundAt || state.claimedAt || !ticket.dispatchNonce) return;
  let requestedCategory = ticketCategory(ticket);
  if (requestedCategory == null && ticket.complexity != null) requestedCategory = legacyCategoryForComplexity(ticket.complexity);
  let category = requestedCategory == null ? null : getCategory(requestedCategory, { project });
  if (!category || !category.enabled) category = getCategory('general', { project });
  if (!category) return;
  const resolved = resolveCategoryRoute(category);
  ticket.model = resolved.model;
  ticket.effort = resolved.effort;
  ticket.exec = execProjection(resolved.exec);
}

function stampDispatchEvent(ticket?: any, source?: any, now?: any) {
  ticket.lastEventType = 'dispatch';
  ticket.lastEventSource = source || 'store';
  ticket.updatedAt = now || new Date().toISOString();
}

function pulseDispatchState(state?: any) {
  if (!state) return null;
  if (state.terminalAt) return state.outcome || 'terminal';
  if (state.claimedAt) return 'claimed';
  if (state.boundAt) return 'bound';
  if (state.launchedAt) return 'launched';
  return state.outcome || 'prepared';
}

function terminalDispatchTarget(agentName?: any) {
  const target = String(agentName || '').trim();
  if (!target) return null;
  let terminal = null;
  for (const project of listProjects({ all: true })) {
    for (const ticket of listTickets(project.slug)) {
      const state = dispatchState(ticket);
      if (!state || state.agentName !== target) continue;
      if (!state.terminalAt) return null;
      terminal = { slug: project.slug, id: ticket.id, ref: ticket.ref, outcome: state.outcome, terminalAt: state.terminalAt };
    }
  }
  return terminal;
}

function setDispatchTerminal(ticket?: any, outcome?: any, source?: any) {
  const state = dispatchState(ticket);
  if (!state) return;
  state.outcome = outcome;
  state.terminalAt = new Date().toISOString();
  state.terminalSource = source || 'store';
  delete state.supersededTokens;
}

function appendReworkEvent(ticket?: any, kind?: any, details?: any) {
  const dispatch = dispatchState(ticket);
  const route = dispatch && dispatch.route && typeof dispatch.route === 'object' ? dispatch.route : {};
  const at = details.at || new Date().toISOString();
  if (!Array.isArray(ticket.reworkEvents)) ticket.reworkEvents = [];
  ticket.reworkEvents.push({
    kind,
    at,
    source: details.source || 'store',
    by: details.by || null,
    fromStatus: details.fromStatus || null,
    toStatus: details.toStatus || null,
    attempt: dispatch ? {
      agentId: dispatch.agentId || null,
      agentName: dispatch.agentName || null,
      route: { model: route.model || null, effort: route.effort || null },
      preparedAt: dispatch.preparedAt || null,
      launchedAt: dispatch.launchedAt || null,
      boundAt: dispatch.boundAt || null,
      claimedAt: dispatch.claimedAt || null,
      terminalAt: dispatch.terminalAt || at,
      outcome: dispatch.outcome || null,
    } : null,
  });
}

function dispatchTokenDigest(token?: any) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function isSupersededDispatchToken(ticket?: any, token?: any) {
  const state = dispatchState(ticket);
  if (!state || !token || token === ticket.dispatchNonce) return false;
  return Array.isArray(state.supersededTokens) && state.supersededTokens.some((entry?: any) => entry.digest === dispatchTokenDigest(token));
}

function routingPolicyAffectsTicket(ticket?: any, categoryIds?: any) {
  if (!Array.isArray(categoryIds) || !categoryIds.length) return true;
  const affected = new Set(categoryIds.map(normalizeCategoryId));
  if (affected.has('general')) return true;
  let category = ticketCategory(ticket);
  if (category == null && ticket && ticket.complexity != null) category = legacyCategoryForComplexity(ticket.complexity);
  return category != null && affected.has(normalizeCategoryId(category));
}

function refreshPreparedDispatches(handle?: any, projects?: any, categoryIds?: any) {
  const projectList = Array.from(new Set((projects || []).filter(Boolean)));
  const refreshed = { superseded: 0, stamped: 0 };
  if (!projectList.length) return refreshed;
  const now = new Date().toISOString();
  for (const project of projectList) {
    for (const row of handle.prepare('SELECT data FROM tickets WHERE project = ?').all(project)) {
      let ticket: any;
      try { ticket = JSON.parse(row.data); } catch (_: any) { continue; }
      if (!routingPolicyAffectsTicket(ticket, categoryIds)) continue;
      const state = dispatchState(ticket);
      if (!state || state.terminalAt || !ticket.dispatchNonce) continue;
      const active = Boolean(state.launchedAt || state.boundAt || state.claimedAt || (ticket.claim && ticket.claim.by));
      if (active) {
        state.policyChangedAt = now;
        stampDispatchEvent(ticket, 'routing-policy', now);
        db.putRow(handle, 'tickets', ticketStorageRow(project, ticket));
        refreshed.stamped += 1;
        continue;
      }
      if (state.outcome !== 'prepared') continue;
      const supersededTokens = Array.isArray(state.supersededTokens) ? state.supersededTokens.slice() : [];
      supersededTokens.push({
        digest: dispatchTokenDigest(ticket.dispatchNonce),
        tokenPrefix: dispatchTokenPrefix(ticket.dispatchNonce),
        at: now,
      });
      state.supersededTokens = supersededTokens.slice(-8);
      const attempts = Array.isArray(state.attempts) ? state.attempts.slice() : [];
      attempts.push({
        route: normalizeRoute(state.route),
        executor: state.executor || ticket.dispatchExecutor,
        tokenPrefix: state.tokenPrefix || dispatchTokenPrefix(ticket.dispatchNonce),
        preparedAt: state.preparedAt || null,
        launchedAt: null,
        outcome: 'policy-changed',
        terminalAt: now,
        terminalSource: 'routing-policy',
      });
      state.attempts = attempts.slice(-8);
      state.outcome = 'policy-changed';
      state.terminalAt = now;
      state.terminalSource = 'routing-policy';
      state.policyChangedAt = now;
      delete state.executor;
      delete ticket.dispatchNonce;
      delete ticket.dispatchExecutor;
      stampDispatchEvent(ticket, 'routing-policy', now);
      db.putRow(handle, 'tickets', ticketStorageRow(project, ticket));
      refreshed.superseded += 1;
    }
  }
  return refreshed;
}

function expiredPreparedDispatch(state?: any, now?: any) {
  if (!state || state.outcome !== 'prepared' || state.terminalAt || state.launchedAt || state.boundAt || state.claimedAt) return false;
  const preparedAt = Date.parse(state.preparedAt);
  return Number.isFinite(preparedAt) && now - preparedAt > preparedDispatchTtlMs();
}

function worktreeIsolationWarning(slug?: any) {
  const meta = readMeta(slug);
  if (!meta || !meta.path) {
    return 'Worktree isolation unavailable: board project path is unavailable; spawning in shared tree. Executor must scoped-commit immediately.';
  }
  if (!fs.existsSync(meta.path)) {
    return 'Worktree isolation unavailable: project path does not exist; spawning in shared tree. Executor must scoped-commit immediately.';
  }
  try {
    const inside = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: meta.path,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (inside !== 'true') {
      return 'Worktree isolation unavailable: project is not a Git work tree; spawning in shared tree. Executor must scoped-commit immediately.';
    }
  } catch (error: any) {
    const reason = error && error.code === 'ENOENT' ? 'Git is not available' : 'project is not a Git work tree';
    return `Worktree isolation unavailable: ${reason}; spawning in shared tree. Executor must scoped-commit immediately.`;
  }
  try {
    execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: meta.path,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return null;
  } catch (_: any) {
    return 'Worktree isolation unavailable: repo has no commits or HEAD cannot be resolved; spawning in shared tree. Executor must scoped-commit immediately.';
  }
}

function prepareDispatch(slug?: any, idOrRef?: any, opts?: any) {
  opts = opts || {};
  if (!projectRoutingEnabled(slug)) throw new Error(routingDisabledMessage(idOrRef));
  const found = getTicket(slug, idOrRef);
  if (!found) throw new Error(`prepare dispatch: no ticket "${idOrRef}".`);
  return withTicketLock(slug, found.id, () => {
    const t = getTicket(slug, found.id);
    if (!t) throw new Error(`prepare dispatch: no ticket "${idOrRef}".`);
    if (t.claim && t.claim.by && !isClaimStale(t.claim)) {
      throw new Error(`prepare dispatch: ${t.ref} has a live claim by ${t.claim.by}. Release it before dispatching again.`);
    }
    const current = dispatchState(t);
    rederiveUnlaunchedPreparedRoute(t, slug);
    const currentRoute = activeDispatchRoute(t);
    const currentExec = currentRoute && resolveExec(currentRoute.model, currentRoute.effort);
    if (current && current.recovery && current.outcome === 'prepared' && t.dispatchNonce && t.dispatchExecutor
      && currentExec && stableExecutorName(t) === t.dispatchExecutor) {
      if (opts.sessionId) current.sessionId = String(opts.sessionId);
      putTicket(slug, t);
      return {
        ok: true,
        ticket: t,
        token: t.dispatchNonce,
        reused: true,
        recovery: current.recovery,
      };
    }
    if (current && current.recovery && !current.terminalAt && !currentExec) {
      const replacement = resolveCategoryFallback(t.category, current.recovery.failedModel);
      if (!replacement) throw new Error(`prepare dispatch: no fallback remains available for ${current.recovery.failedModel}.`);
      t.model = replacement.model;
      t.effort = replacement.effort;
      t.exec = execProjection(replacement.exec);
      current.recovery = Object.assign({}, current.recovery, {
        fallbackSource: replacement.source,
        model: replacement.model,
        effort: replacement.effort,
      });
    }
    const now = new Date().toISOString();
    const backend = availableRoute(t.model);
    if (backend && backend.backend === 'claude' && (t.effort == null || String(t.effort).trim() === '')) {
      t.effort = 'low';
      t.exec = execProjection(resolveExec(t.model, t.effort));
    }
    const recovery = current && current.recovery && activeDispatchRoute(t) ? current.recovery : null;
    const attempts = current && Array.isArray(current.attempts) ? current.attempts.slice() : [];
    const supersededTokens = current && Array.isArray(current.supersededTokens) ? current.supersededTokens.slice() : [];
    if (current && !current.terminalAt && t.dispatchNonce) {
      supersededTokens.push({
        digest: dispatchTokenDigest(t.dispatchNonce),
        tokenPrefix: dispatchTokenPrefix(t.dispatchNonce),
        at: now,
      });
    }
    t.dispatchNonce = crypto.randomBytes(24).toString('base64url');
    t.dispatchExecutor = stableExecutorName(t);
    const requestedSharedTree = Object.hasOwn(opts, 'sharedTree') ? opts.sharedTree === true : Boolean(current && current.sharedTree);
    const worktreeIsolation = normalizeWorktreeIsolation(readMeta(slug)?.worktreeIsolation);
    let sharedTree = worktreeIsolation ? requestedSharedTree : true;
    const declaredFiles = normalizeFiles(t.files);
    const nonRepoOutput = nonRepoExternalOutput(t, declaredFiles);
    const worktreeWarning = !worktreeIsolation && Object.hasOwn(opts, 'sharedTree') && requestedSharedTree === false
      ? 'Board worktree isolation is disabled; explicit sharedTree:false was overridden. Spawning in shared tree. Executor must scoped-commit immediately.'
      : (!sharedTree && declaredFiles.length ? worktreeIsolationWarning(slug) : null);
    if (worktreeWarning) sharedTree = true;
    const category = getCategory(ticketCategory(t), { project: slug });
    const artifactRoot = sharedTree && declaredFiles.length === 1 && sharedTreeArtifactRequested(t)
      ? categoryArtifactRoot(category, declaredFiles[0])
      : null;
    const artifactMode = Boolean(artifactRoot);
    const artifactScope = artifactMode ? declaredFiles[0] : null;
    const artifactDirtyBaseline = artifactMode ? captureArtifactBaseline(slug, artifactScope) : null;
    const preparedExec = resolveExec(t.model, t.effort);
    const story = t.storyId ? getStory(slug, t.storyId) : null;
    const contract = storyExecutionContract(story);
    const contractDrift = t.storyContractDrift || null;
    delete t.storyContractDrift;
    t.dispatch = {
      sessionId: opts.sessionId ? String(opts.sessionId) : null,
      sharedTree,
      ...(worktreeWarning ? { worktreeWarning } : {}),
      declaredFiles,
      ...(nonRepoOutput ? { nonRepoOutput: true } : {}),
      artifactMode,
      artifactRoot,
      artifactScope,
      ...(artifactMode ? { artifactDirtyBaseline } : {}),
      tokenPrefix: dispatchTokenPrefix(t.dispatchNonce),
      executor: t.dispatchExecutor,
      description: spawnDescription(t, preparedExec),
      route: dispatchRouteState(t.model, t.effort, preparedExec),
      storyContract: contract,
      ...(contractDrift ? { storyContractDrift: Object.assign({}, contractDrift, { rebasedAt: now }) } : {}),
      preparedAt: now,
      launchedAt: null,
      boundAt: null,
      claimedAt: null,
      terminalAt: null,
      outcome: 'prepared',
      ...(attempts.length ? { attempts } : {}),
      ...(supersededTokens.length ? { supersededTokens: supersededTokens.slice(-8) } : {}),
      ...(recovery ? { recovery } : {}),
    };
    stampDispatchEvent(t, 'dispatch', now);
    putTicket(slug, t);
    return { ok: true, ticket: t, token: t.dispatchNonce, recovery };
  });
}

function readDispatchBriefing(slug?: any, idOrRef?: any, token?: any) {
  const ticket = getTicket(slug, idOrRef);
  if (!ticket) return { ok: false, reason: 'not_found' };
  const state = dispatchState(ticket);
  if (!state || state.terminalAt || !ticket.dispatchNonce || token !== ticket.dispatchNonce) {
    return { ok: false, reason: 'token' };
  }
  return { ok: true, ticket };
}

function recordDispatchLaunch(slug?: any, idOrRef?: any, opts?: any) {
  opts = opts || {};
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: 'not_found' };
  return withTicketLock(slug, found.id, () => {
    const t = getTicket(slug, found.id);
    if (!t || !t.dispatchNonce || opts.token !== t.dispatchNonce || opts.executor !== t.dispatchExecutor) {
      return { ok: false, reason: 'not_prepared' };
    }
    const state = dispatchState(t);
    if (!state) return { ok: false, reason: 'missing_state' };
    const now = new Date().toISOString();
    state.sessionId = opts.sessionId ? String(opts.sessionId) : state.sessionId || null;
    state.agentName = opts.agentName ? String(opts.agentName) : state.agentName || null;
    state.launchedAt = state.launchedAt || now;
    state.outcome = 'launched';
    stampDispatchEvent(t, opts.source || 'dispatch', now);
    putTicket(slug, t);
    return { ok: true, ticket: t };
  });
}

function recoverDispatchQuotaFailure(slug?: any, idOrRef?: any, opts?: any) {
  opts = opts || {};
  const failure = claudeQuotaFailure(opts.error);
  if (!failure) return { ok: false, reason: 'unrecognized_failure' };
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: 'not_found' };
  return withTicketLock(slug, found.id, () => {
    const t = getTicket(slug, found.id);
    if (!t || !t.dispatchNonce || opts.token !== t.dispatchNonce || opts.executor !== t.dispatchExecutor) {
      return { ok: false, reason: 'not_prepared' };
    }
    if (t.claim && t.claim.by) return { ok: false, reason: 'claimed' };
    const state = dispatchState(t);
    if (!state || state.outcome !== 'launched' || state.terminalAt) return { ok: false, reason: 'not_launched' };
    const failedRoute = normalizeRoute(state.route) || normalizeRoute({ model: t.model, effort: t.effort });
    const failedExec = failedRoute && resolveExec(failedRoute.model, failedRoute.effort);
    if (!failedExec || failedExec.backend !== 'claude' || failedExec.runsModel !== failure.model) {
      return { ok: false, reason: 'signature_route_mismatch' };
    }
    const fallback = resolveCategoryFallback(t.category, failedExec.runsModel);
    if (!fallback) return { ok: false, reason: 'no_fallback' };

    const now = new Date().toISOString();
    const failedAttempt = {
      route: { model: failedExec.runsModel, effort: failedRoute.effort },
      executor: state.executor || t.dispatchExecutor,
      tokenPrefix: state.tokenPrefix || dispatchTokenPrefix(t.dispatchNonce),
      preparedAt: state.preparedAt || null,
      launchedAt: state.launchedAt || null,
      outcome: 'quota_exhausted',
      terminalAt: now,
      terminalSource: opts.source || 'agent-launch-failure',
      failure: { kind: 'claude_quota_exhausted', signature: failure.signature },
    };
    const attempts = (Array.isArray(state.attempts) ? state.attempts : []).concat(failedAttempt).slice(-8);
    const supersededTokens = (Array.isArray(state.supersededTokens) ? state.supersededTokens : []).concat({
      digest: dispatchTokenDigest(t.dispatchNonce),
      tokenPrefix: dispatchTokenPrefix(t.dispatchNonce),
      at: now,
    }).slice(-8);
    const recovery = {
      kind: 'claude_quota_exhausted',
      failedModel: failedExec.runsModel,
      failedEffort: failedRoute.effort,
      fallbackSource: fallback.source,
      model: fallback.model,
      effort: fallback.effort,
      signature: failure.signature,
      at: now,
    };

    t.dispatchNonce = crypto.randomBytes(24).toString('base64url');
    t.dispatchExecutor = fallback.exec.agent;
    t.dispatch = {
      sessionId: opts.sessionId ? String(opts.sessionId) : state.sessionId || null,
      sharedTree: state.sharedTree === true,
      declaredFiles: Array.isArray(state.declaredFiles) ? state.declaredFiles.slice() : normalizeFiles(t.files),
      artifactMode: state.artifactMode === true,
      artifactRoot: state.artifactRoot || null,
      artifactScope: state.artifactScope || null,
      ...(Array.isArray(state.artifactDirtyBaseline) ? { artifactDirtyBaseline: state.artifactDirtyBaseline.slice() } : {}),
      tokenPrefix: dispatchTokenPrefix(t.dispatchNonce),
      executor: t.dispatchExecutor,
      description: spawnDescription(t, fallback.exec),
      route: dispatchRouteState(fallback.model, fallback.effort, fallback.exec),
      storyContract: state.storyContract || storyExecutionContract(t.storyId ? getStory(slug, t.storyId) : null),
      ...(state.storyContractDrift ? { storyContractDrift: state.storyContractDrift } : {}),
      preparedAt: now,
      launchedAt: null,
      boundAt: null,
      claimedAt: null,
      terminalAt: null,
      outcome: 'prepared',
      attempts,
      supersededTokens,
      recovery,
    };
    t.model = fallback.model;
    t.effort = fallback.effort;
    t.exec = execProjection(fallback.exec);
    stampDispatchEvent(t, opts.source || 'agent-launch-failure', now);
    putTicket(slug, t);
    return { ok: true, ticket: t, token: t.dispatchNonce, recovery };
  });
}

function bindDispatchAgent(sessionId?: any, executor?: any, agentId?: any, agentName?: any) {
  if (!sessionId || !executor || !agentId) return { ok: false, reason: 'missing_identity' };
  const matches: any[] = [];
  for (const project of listProjects({ all: true })) {
    for (const ticket of listTickets(project.slug)) {
      const state = dispatchState(ticket);
      if (!state || state.sessionId !== String(sessionId) || state.executor !== String(executor) || state.outcome !== 'launched') continue;
      if (agentName && state.agentName && state.agentName !== String(agentName)) continue;
      if (state.agentId && state.agentId !== String(agentId)) continue;
      matches.push({ slug: project.slug, id: ticket.id });
    }
  }
  if (!matches.length || (matches.length > 1 && !agentName)) {
    return { ok: false, reason: matches.length ? 'ambiguous' : 'not_found' };
  }
  const tickets: any[] = [];
  for (const match of matches) {
    const result = withTicketLock(match.slug, match.id, () => {
      const t = getTicket(match.slug, match.id);
      const state = dispatchState(t);
      if (!state || state.outcome !== 'launched' || state.sessionId !== String(sessionId) || state.executor !== String(executor)) {
        return { ok: false };
      }
      const now = new Date().toISOString();
      state.agentId = String(agentId);
      state.agentName = agentName ? String(agentName) : state.agentName || null;
      state.boundAt = state.boundAt || now;
      stampDispatchEvent(t, 'subagent-start', now);
      putTicket(match.slug, t);
      return { ok: true, ticket: t };
    });
    if (!result || !result.ok) return { ok: false, reason: 'not_found' };
    tickets.push(result.ticket);
  }
  return { ok: true, ticket: tickets[0], tickets };
}

function markDispatchStopped(sessionId?: any, executor?: any, agentId?: any, agentName?: any) {
  if (!sessionId || !executor) return { ok: false, reason: 'missing_identity' };
  const matches: any[] = [];
  for (const project of listProjects({ all: true })) {
    for (const ticket of listTickets(project.slug)) {
      const state = dispatchState(ticket);
      if (!state || state.sessionId !== String(sessionId) || state.executor !== String(executor)) continue;
      if (agentId && state.agentId !== String(agentId)) continue;
      if (agentName && state.agentName !== String(agentName)) continue;
      if (state.outcome === 'prepared' || state.outcome === 'launched' || state.outcome === 'claimed') {
        matches.push({ slug: project.slug, id: ticket.id });
      }
    }
  }
  if (!matches.length || (matches.length > 1 && !agentName)) {
    return { ok: false, reason: matches.length ? 'ambiguous' : 'not_found' };
  }
  const tickets: any[] = [];
  for (const match of matches) {
    const result = withTicketLock(match.slug, match.id, () => {
      const t = getTicket(match.slug, match.id);
      const state = dispatchState(t);
      if (!state || !['prepared', 'launched', 'claimed'].includes(state.outcome) ||
        state.sessionId !== String(sessionId) || state.executor !== String(executor) ||
        (agentId && state.agentId !== String(agentId)) ||
        (agentName && state.agentName !== String(agentName))) {
        return { ok: false, reason: 'not_found' };
      }
      const now = new Date().toISOString();
      if (agentId) state.agentId = String(agentId);
      if (agentName) state.agentName = String(agentName);
      setDispatchTerminal(t, t.claim && t.claim.by ? 'stopped_claimed' : 'failed', 'subagent-stop');
      if (!t.claim || !t.claim.by) {
        t.dispatchNonce = null;
        t.dispatchExecutor = null;
      }
      stampDispatchEvent(t, 'subagent-stop', now);
      putTicket(match.slug, t);
      return { ok: true, ticket: t };
    });
    if (!result || !result.ok) return { ok: false, reason: 'not_found' };
    tickets.push(result.ticket);
  }
  return { ok: true, ticket: tickets[0], tickets };
}

function reconcileLaunchedDispatches(sessionId?: any, opts?: any) {
  const reconciled: any[] = [];
  if (!sessionId) return { ok: true, reconciled };
  const source = opts && opts.source ? String(opts.source) : 'session-start';
  for (const project of listProjects({ all: true })) {
    for (const ticket of listTickets(project.slug)) {
      const state = dispatchState(ticket);
      // A bound agent has a durable runtime identity; only its terminal hook or claim lifecycle may retire it.
      if (!state || state.sessionId !== String(sessionId) || state.outcome !== 'launched' || state.boundAt || (ticket.claim && ticket.claim.by)) continue;
      const res = withTicketLock(project.slug, ticket.id, () => {
        const t = getTicket(project.slug, ticket.id);
        const current = dispatchState(t);
        if (!current || current.sessionId !== String(sessionId) || current.outcome !== 'launched' || current.boundAt || (t.claim && t.claim.by)) {
          return { ok: false };
        }
        setDispatchTerminal(t, 'failed', source);
        t.dispatchNonce = null;
        t.dispatchExecutor = null;
        stampDispatchEvent(t, source);
        putTicket(project.slug, t);
        return { ok: true, ticket: t };
      });
      if (res && res.ok) reconciled.push(res.ticket.ref);
    }
  }
  return { ok: true, reconciled };
}

// Atomically claim a ticket for worker `by`. Refuses (ok:false) if the ticket is
// gone, already done, or actively claimed by someone else, unless that claim is
// stale or opts.force; on success it moves the ticket to "doing" unless opts.status is false.
const DIRECT_REASON_MIN_LENGTH = 20;

function isRoutedTicket(ticket?: any) {
  return Boolean(ticket && ticket.model && ticket.effort && ticket.exec);
}

function directReason(reason?: any) {
  const value = String(reason || '').trim();
  return value.length >= DIRECT_REASON_MIN_LENGTH ? value : null;
}

function hasDirectPermission(ticket?: any) {
  return Array.isArray(ticket?.labels) && ticket.labels.some((label?: any) => String(label).toLowerCase() === 'direct-ok');
}

function claimTicket(slug?: any, idOrRef?: any, by?: any, opts?: any) {
  opts = opts || {};
  by = String(by || 'agent');
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: 'not_found' };
  const result = withTicketLock(slug, found.id, () => {
    const t = getTicket(slug, found.id); // fresh read, under the lock
    if (!t) return { ok: false, reason: 'not_found' };
    const delay = testClaimLockDelayMs();
    if (delay) busyWait(delay);
    if (opts.direct && isRoutedTicket(t) && !hasDirectPermission(t)) return { ok: false, reason: 'direct_not_allowed', ticket: t, expectedExecutor: t.dispatchExecutor || t.exec?.agent || null };
    if (opts.direct && isRoutedTicket(t) && !directReason(opts.reason)) return { ok: false, reason: 'direct_reason_required', ticket: t };
    if (opts.direct && t.dispatchNonce) return { ok: false, reason: 'direct_conflict', ticket: t };
    if (!opts.direct && t.dispatchNonce && opts.token !== t.dispatchNonce) return { ok: false, reason: 'token', ticket: t };
    if (!opts.direct && t.dispatchNonce && opts.executor !== t.dispatchExecutor) return { ok: false, reason: 'executor_mismatch', ticket: t, expectedExecutor: t.dispatchExecutor };
    if (!opts.direct && isRoutedTicket(t) && !t.dispatchNonce) return { ok: false, reason: 'dispatch_required', ticket: t };
    if (t.status === 'done') return { ok: false, reason: 'done', ticket: t };
    // Submitted work awaits the orchestrator's publish transaction, not another
    // executor: re-claiming it would fork the already-verified commit. The
    // orchestrator clears the submission first when rework is genuinely wanted.
    if (pendingSubmission(t) && !opts.force) return { ok: false, reason: 'submitted', ticket: t, submission: t.submission };
    const held = t.claim;
    if (held && held.by && held.by !== by && !isClaimStale(held) && !opts.force) {
      return { ok: false, reason: 'claimed', ticket: t, claim: held };
    }
    const now = new Date().toISOString();
    t.claim = { by, at: now };
    if (opts.direct && isRoutedTicket(t)) {
      t.directClaim = {
        by,
        at: now,
        model: t.model,
        effort: t.effort,
        executor: opts.executor ? String(opts.executor) : null,
        source: opts.source ? String(opts.source) : 'store',
        reason: directReason(opts.reason),
      };
    }
    const state = dispatchState(t);
    if (state) {
      state.sessionId = opts.sessionId ? String(opts.sessionId) : state.sessionId || null;
      state.claimedAt = now;
      state.outcome = 'claimed';
    }
    if (opts.status !== false) t.status = coerceStatus(opts.status || 'doing', t.status);
    if (state) stampDispatchEvent(t, opts.source || 'cli', now);
    else {
      t.lastEventType = 'status';
      t.lastEventSource = opts.source ? String(opts.source) : 'cli';
      t.updatedAt = now;
    }
    putTicket(slug, t);
    // Tie this claim to the worker's session so a SessionEnd/SubagentStop hook can
    // release it immediately instead of waiting out the TTL. No-op without a session id.
    if (opts.sessionId) registerWorker(opts.sessionId, slug, t.id, by);
    queueEventNotification(slug, t, t.lastEventType, t.lastEventSource);
    return { ok: true, ticket: t };
  });
  if (result.reason !== 'busy' || opts.force) return result;
  const t = getTicket(slug, found.id);
  const held = t && t.claim;
  if (held && held.by && held.by !== by && !isClaimStale(held)) {
    return { ok: false, reason: 'claimed', ticket: t, claim: held };
  }
  return result;
}

// Release a claim. Only the owner (or a stale claim) may release unless
// opts.force; opts.status optionally moves the ticket at the same time.
function releaseTicket(slug?: any, idOrRef?: any, by?: any, opts?: any) {
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
    if (t.status === 'done' && !opts.force) {
      const completion = t.completion;
      const key = completion && [t.id, completion.claimAt || completion.at, by, 'done'].join(':');
      if (opts.status === 'done' && completion && completion.key === key && completion.by === by && completion.state === 'done') {
        const comment = Array.isArray(t.comments) && completion.commentId
          ? t.comments.find((entry?: any) => entry.id === completion.commentId) || null
          : null;
        return { ok: true, idempotent: true, ticket: t, comment };
      }
      return { ok: false, reason: 'done', ticket: t };
    }
    const controlPlaneDone = opts.status === 'done' && opts.completionAuthority === CONTROL_PLANE_COMPLETION;
    const executorDone = opts.status === 'done' && !controlPlaneDone;
    const dispatch = dispatchState(t);
    const artifactDispatch = sharedTreeArtifactMode(t);
    const declaredFiles = dispatch && Array.isArray(dispatch.declaredFiles) ? dispatch.declaredFiles : normalizeFiles(t.files);
    const held = t.claim;
    const liveClaim = held && held.by && !isClaimStale(held);
    const activeDispatch = Boolean(t.dispatchNonce || (dispatch && !dispatch.terminalAt));
    const activeArtifactDispatch = artifactDispatch && liveClaim && activeDispatch;
    const activeNonRepoOutput = dispatch?.nonRepoOutput === true && liveClaim && activeDispatch;
    if (executorDone && activeArtifactDispatch) {
      const scopeCheck = artifactScopeCheck(slug, t, dispatch);
      if (!scopeCheck.ok) return Object.assign({ ticket: t }, scopeCheck);
    }
    if (executorDone && dispatch && declaredFiles.length && !activeArtifactDispatch && !activeNonRepoOutput) {
      return {
        ok: false,
        reason: 'submission_required',
        message: `${t.ref} has routed repository write scope. Its executor must commit and submit verified changes. If the only declared output is outside the repo worktree, release it for reclassification as non-repo/artifact work; do not retry commit.`,
        ticket: t,
      };
    }
    if (held && held.by && held.by !== by && !isClaimStale(held) && !opts.force) {
      return { ok: false, reason: 'not_owner', ticket: t, claim: held };
    }
    const now = new Date().toISOString();
    const previousStatus = t.status;
    let comment = null;
    t.claim = null;
    setDispatchTerminal(t, opts.status === 'done' ? 'done' : 'released', opts.source || 'cli');
    t.dispatchNonce = null;
    t.dispatchExecutor = null;
    if (opts.status) t.status = coerceStatus(opts.status, t.status);
    if (t.status === 'todo' && (previousStatus !== 'todo' || (held && held.by))) {
      appendReworkEvent(t, 'released_to_todo', {
        at: now,
        source: opts.source || 'cli',
        by,
        fromStatus: previousStatus,
        toStatus: t.status,
      });
    }
    if (opts.workedBy) t.workedBy = opts.workedBy; // self-reported provenance stamp (done transition only)
    if (t.status === 'done') {
      t.completion = {
        key: [t.id, held && held.at ? held.at : now, by, 'done'].join(':'),
        by,
        state: 'done',
        claimAt: held && held.at ? held.at : null,
        at: now,
        commentId: null,
        ...(opts.completionProvenance || {}),
      };
      if (opts.completionComment) {
        if (!Array.isArray(t.comments)) t.comments = [];
        comment = createComment(opts.completionComment, now);
        t.comments.push(comment);
        t.completion.commentId = comment.id;
      }
    }
    // Completing a submitted ticket is the publish transaction consuming the
    // submission — stamp it integrated (kept as provenance) so the ticket
    // leaves the ready-for-integration queue the moment it goes done.
    if (t.status === 'done' && pendingSubmission(t)) {
      t.submission = Object.assign({}, t.submission, { integratedAt: new Date().toISOString() });
    }
    if (dispatch) stampDispatchEvent(t, opts.source || 'cli', now);
    else {
      t.lastEventType = 'status';
      t.lastEventSource = opts.source ? String(opts.source) : 'cli';
      t.updatedAt = now;
    }
    putTicket(slug, t);
    // Drop this claim from the session registry — it's no longer outstanding, so a
    // later reconcile of the same session won't try to touch it (keyed on the
    // ticket, so a blank `by` on the done doesn't matter). No-op without a session id.
    if (opts.sessionId) unregisterClaim(opts.sessionId, slug, t.id);
    queueEventNotification(slug, t, t.lastEventType, t.lastEventSource);
    if (comment) queueEventNotification(slug, t, 'comment', comment.source, { commentBody: comment.body });
    return { ok: true, ticket: t, comment, ...(opts.completionComment && opts.completionComment.advisory ? { advisory: opts.completionComment.advisory } : {}) };
  });
}

// Build the provenance stamp recorded when a ticket is completed — which model
// tier (or the Codex model that actually backed it) and reasoning effort worked
// it, plus who and when. Returns null when no model is supplied. A supplied model
// must be a VALID_MODELS tier OR a discovered catalog slug (a Codex-backed tier
// records the real model that ran); effort, if present, a VALID_EFFORTS level
// (null/omitted allowed — haiku has no effort). Anything else throws.
function makeWorkedBy(input?: any) {
  if (!input) return null;
  const rawModel = input.model;
  if (rawModel == null || String(rawModel).trim() === '') return null;
  const model = normalizeReportedModel(rawModel);
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
function completeTicket(slug?: any, idOrRef?: any, by?: any, opts?: any) {
  opts = opts || {};
  const ticket = getTicket(slug, idOrRef);
  const dispatched = resolvedDispatchRoute(ticket);
  const omittedProvenance = (opts.model == null || String(opts.model).trim() === '')
    && (opts.effort == null || String(opts.effort).trim() === '');
  const workedBy = makeWorkedBy({
    model: omittedProvenance && dispatched ? dispatched.model : opts.model,
    effort: omittedProvenance && dispatched ? dispatched.effort : opts.effort,
    by,
  });
  let completionComment = null;
  if (opts.body != null && String(opts.body).trim()) {
    completionComment = prepareComment({ by, body: opts.body, kind: 'comment', source: opts.source || 'cli' });
    if (!completionComment.ok) {
      throw new Error(`completion comment ${completionComment.reason}`);
    }
  }
  return releaseTicket(slug, idOrRef, by, Object.assign({}, opts, {
    status: 'done',
    workedBy,
    completionComment,
  }));
}

function recordedReviewPass(ticket?: any) {
  return Array.isArray(ticket?.comments) && ticket.comments.some((comment?: any) => /^\s*reviewed-by\s*:\s*\S/i.test(String(comment?.body || '')));
}

const HIGH_STAKES_REVIEW_WARNING = 'high-stakes ticket integrated without a recorded review pass';

function completeTicketAsControlPlane(slug?: any, idOrRef?: any, opts?: any) {
  opts = opts || {};
  const purpose = String(opts.purpose || '').trim();
  if (!['grooming', 'integration'].includes(purpose)) {
    throw new Error('control-plane completion requires purpose "grooming" or "integration".');
  }
  const ticket = getTicket(slug, idOrRef);
  if (!ticket) return { ok: false, reason: 'not_found' };
  const state = dispatchState(ticket);
  if (purpose === 'grooming') {
    if ((ticket.claim && ticket.claim.by && !isClaimStale(ticket.claim)) || ticket.dispatchNonce || (state && !state.terminalAt)) {
      return { ok: false, reason: 'active_dispatch', ticket };
    }
    if (pendingSubmission(ticket)) return { ok: false, reason: 'pending_submission', ticket };
  }
  if (purpose === 'integration' && !pendingSubmission(ticket)) {
    return { ok: false, reason: 'submission_required', ticket };
  }
  const reason = String(opts.reason || '').trim();
  if (!reason) return { ok: false, reason: 'evidence_required', ticket };
  const by = String(opts.by || '').trim();
  if (!by) return { ok: false, reason: 'identity_required', ticket };
  const advisory = purpose === 'integration' && ticket.highStakes && !recordedReviewPass(ticket)
    ? HIGH_STAKES_REVIEW_WARNING
    : null;
  const result = completeTicket(slug, idOrRef, by, Object.assign({}, opts, {
    body: reason,
    source: `control-plane-${purpose}`,
    completionAuthority: CONTROL_PLANE_COMPLETION,
    completionProvenance: { authority: 'control-plane', purpose, reason },
  }));
  return advisory ? Object.assign(result, { advisory }) : result;
}

function closeTicketForGrooming(slug?: any, idOrRef?: any, opts?: any) {
  return completeTicketAsControlPlane(slug, idOrRef, Object.assign({}, opts, { purpose: 'grooming' }));
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
const DEFAULT_CHECKPOINT_TTL_MIN = 60;
const MAX_CHECKPOINT_TTL_MIN = 24 * 60;
const CHECKPOINT_VERIFY_MAX = 4000;
const CHECKPOINT_VERIFY_EXCERPT_MAX = 500;

function checkpointTtlMs(ttlMinutes?: any) {
  const minutes = ttlMinutes == null ? DEFAULT_CHECKPOINT_TTL_MIN : Number(ttlMinutes);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_CHECKPOINT_TTL_MIN) {
    throw new Error(`checkpoint TTL must be an integer from 1 to ${MAX_CHECKPOINT_TTL_MIN} minutes`);
  }
  return minutes * 60 * 1000;
}

function checkpointProjection(ticket?: any, now?: any) {
  const checkpoint = ticket && ticket.checkpoint;
  if (!checkpoint) return null;
  const atMs = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const expiresMs = Date.parse(checkpoint.expiresAt);
  let state = 'expired';
  if (Number.isFinite(expiresMs) && expiresMs > atMs) {
    if (pendingSubmission(ticket)) state = 'submitted';
    else if (ticket.status === 'done') state = 'completed';
    else {
      const claim = ticket.claim;
      const claimAt = claim && Date.parse(claim.at);
      const liveClaim = claim && claim.by && Number.isFinite(claimAt) && atMs - claimAt <= claimTtlMs();
      if (!liveClaim) state = 'recoverable';
      else state = claim.by === checkpoint.by ? 'active' : 'resumed';
    }
  }
  const verify = boundedExcerpt(String(checkpoint.verify || ''), CHECKPOINT_VERIFY_EXCERPT_MAX);
  return {
    id: checkpoint.id,
    state,
    by: checkpoint.by,
    at: checkpoint.at,
    expiresAt: checkpoint.expiresAt,
    ttlMinutes: checkpoint.ttlMinutes,
    commit: checkpoint.commit || null,
    worktree: checkpoint.worktree || null,
    verify: verify.text,
    verifyLength: verify.length,
    verifyTruncated: verify.truncated,
  };
}

function checkpointCommentBody(checkpoint?: any) {
  const candidate = [
    checkpoint.commit ? `commit ${checkpoint.commit}` : null,
    checkpoint.worktree ? `worktree ${checkpoint.worktree}` : null,
  ].filter(Boolean).join(', ');
  return `Live review checkpoint ${checkpoint.id}\nCandidate: ${candidate}\nVerification: ${checkpoint.verify}\nExpires: ${checkpoint.expiresAt}`;
}

function checkpointTicket(slug?: any, idOrRef?: any, by?: any, opts?: any) {
  opts = opts || {};
  by = String(by || 'agent');
  const commit = opts.commit == null || String(opts.commit).trim() === '' ? null : String(opts.commit).trim().toLowerCase();
  if (commit && !SUBMISSION_COMMIT_RE.test(commit)) {
    throw new Error(`invalid commit "${opts.commit}": pass the verified commit's hex hash (7-64 chars)`);
  }
  const worktree = opts.worktree == null || String(opts.worktree).trim() === '' ? null : String(opts.worktree).trim();
  if (worktree && (!path.isAbsolute(worktree) || worktree.length > SUBMISSION_WORKTREE_MAX)) {
    throw new Error(`checkpoint worktree must be an absolute path no longer than ${SUBMISSION_WORKTREE_MAX} characters`);
  }
  if (!commit && !worktree) throw new Error('checkpoint requires a commit hash or absolute worktree path');
  const verify = String(opts.verify || '').trim();
  if (!verify) throw new Error('checkpoint verification evidence is required');
  if (verify.length > CHECKPOINT_VERIFY_MAX) throw new Error(`checkpoint verification evidence exceeds ${CHECKPOINT_VERIFY_MAX} characters`);
  const ttlMs = checkpointTtlMs(opts.ttlMinutes);
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: 'not_found' };
  return withTicketLock(slug, found.id, () => {
    const t = getTicket(slug, found.id);
    if (!t) return { ok: false, reason: 'not_found' };
    if (t.status === 'done') return { ok: false, reason: 'done', ticket: t };
    if (pendingSubmission(t)) return { ok: false, reason: 'submitted', ticket: t, submission: t.submission };
    const held = t.claim;
    if (!held || !held.by) return { ok: false, reason: 'not_claimed', ticket: t };
    if (held.by !== by) return { ok: false, reason: 'not_owner', ticket: t, claim: held };
    if (isClaimStale(held)) return { ok: false, reason: 'claim_stale', ticket: t, claim: held };
    const nowMs = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now();
    const now = new Date(nowMs).toISOString();
    const checkpoint = {
      id: `cp_${crypto.randomBytes(8).toString('hex')}`,
      by,
      at: now,
      expiresAt: new Date(nowMs + ttlMs).toISOString(),
      ttlMinutes: ttlMs / 60000,
      commit,
      worktree,
      verify,
    };
    const prepared = prepareComment({ by, body: checkpointCommentBody(checkpoint), source: opts.source || 'cli' });
    if (!prepared.ok) throw new Error(`checkpoint comment ${prepared.reason}`);
    const comment = createComment(prepared, now);
    if (!Array.isArray(t.comments)) t.comments = [];
    t.comments.push(comment);
    t.checkpoint = checkpoint;
    t.claim = Object.assign({}, held, { at: now });
    t.lastEventType = 'comment';
    t.lastEventSource = comment.source;
    t.updatedAt = now;
    putTicket(slug, t);
    queueEventNotification(slug, t, 'comment', comment.source, { commentBody: comment.body });
    return { ok: true, ticket: t, checkpoint: checkpointProjection(t, nowMs), comment };
  });
}

function submissionUnscopedPaths(paths?: any) {
  return Array.from(new Set((Array.isArray(paths) ? paths : [])
    .map((value?: any) => String(value || '').trim().replace(/\\/g, '/'))
    .filter(Boolean)));
}

function submissionRangeMetadata(range?: any, commit?: any) {
  if (!range) return null;
  const base = String(range.base || '').trim().toLowerCase();
  const upstream = String(range.upstream || '').trim();
  const upstreamCommit = String(range.upstreamCommit || '').trim().toLowerCase();
  const commits = Array.isArray(range.commits) ? range.commits.map((value?: any) => String(value).trim().toLowerCase()) : [];
  const changedPaths = Array.isArray(range.changedPaths) ? range.changedPaths.map((value?: any) => String(value).trim().replace(/\\/g, '/')).filter(Boolean) : [];
  const integrationMode = range.integrationMode == null ? null : String(range.integrationMode).trim().toLowerCase();
  if (!SUBMISSION_COMMIT_RE.test(base) || !upstream || !SUBMISSION_COMMIT_RE.test(upstreamCommit) || !commits.length
    || commits.some((value?: any) => !SUBMISSION_COMMIT_RE.test(value)) || commits[commits.length - 1] !== commit
    || (integrationMode != null && !['local', 'remote'].includes(integrationMode))) {
    throw new Error('invalid submission range metadata');
  }
  return Object.assign({ base, upstream, upstreamCommit, commits, changedPaths }, integrationMode ? { integrationMode } : {});
}

// A submission that has not been consumed by a done transition yet — the
// ticket is parked for the publish transaction, not for another executor.
function pendingSubmission(t?: any) {
  return !!(t && t.submission && t.submission.commit && !t.submission.integratedAt);
}

function submissionGitRef(ticket?: any) {
  return `refs/sidequest/${ticket.ref}`;
}

// Record verified, committed work as ready for integration and release the
// claim in the same locked step. Requires the caller to HOLD the claim (the
// submit is the terminal act of a claimed run) unless opts.force — mirroring
// releaseTicket's ownership rules. Status deliberately stays "doing".
function submitTicket(slug?: any, idOrRef?: any, by?: any, opts?: any) {
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
  const range = submissionRangeMetadata(opts.range, commit);
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
    t.submission = Object.assign({
      by,
      at: new Date().toISOString(),
      commit,
      gitRef: gitRef || submissionGitRef(t),
      verify,
      worktree,
      unscopedPaths: submissionUnscopedPaths(opts.unscopedPaths),
      integratedAt: null,
    }, range || {});
    const dispatch = dispatchState(t);
    t.claim = null;
    setDispatchTerminal(t, 'submitted', opts.source || 'cli');
    t.dispatchNonce = null;
    t.dispatchExecutor = null;
    t.status = 'doing'; // ready-for-integration parks in doing, never done
    if (dispatch) stampDispatchEvent(t, opts.source || 'cli');
    else {
      t.lastEventType = 'status';
      t.lastEventSource = opts.source ? String(opts.source) : 'cli';
      t.updatedAt = new Date().toISOString();
    }
    putTicket(slug, t);
    if (opts.sessionId) unregisterClaim(opts.sessionId, slug, t.id);
    queueEventNotification(slug, t, t.lastEventType, t.lastEventSource);
    return { ok: true, ticket: t };
  });
}

// Orchestrator reset: drop a pending submission so the ticket is claimable
// again (integration bounced and the work must be redone rather than merged).
// opts.status optionally moves it (usually back to todo) at the same time.
function clearSubmission(slug?: any, idOrRef?: any, opts?: any) {
  opts = opts || {};
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: 'not_found' };
  return withTicketLock(slug, found.id, () => {
    const t = getTicket(slug, found.id);
    if (!t) return { ok: false, reason: 'not_found' };
    if (!t.submission) return { ok: false, reason: 'no_submission', ticket: t };
    const cleared = t.submission;
    const previousStatus = t.status;
    const now = new Date().toISOString();
    t.submission = null;
    if (opts.status) t.status = coerceStatus(opts.status, t.status);
    appendReworkEvent(t, 'submission_cleared', {
      at: now,
      source: opts.source || 'cli',
      fromStatus: previousStatus,
      toStatus: t.status,
    });
    t.lastEventType = 'status';
    t.lastEventSource = opts.source ? String(opts.source) : 'cli';
    t.updatedAt = now;
    putTicket(slug, t);
    queueEventNotification(slug, t, t.lastEventType, t.lastEventSource);
    return { ok: true, ticket: t, cleared };
  });
}

function submissionBaseCandidates(slug?: any, idOrRef?: any, opts?: any) {
  const excluded = idOrRef == null ? null : getTicket(slug, idOrRef);
  const integratedOnly = !!(opts && opts.integratedOnly);
  const commits = new Set<string>();
  for (const ticket of listTickets(slug)) {
    if (excluded && ticket.id === excluded.id) continue;
    const submission = ticket.submission;
    const commit = String(submission && submission.commit || '').trim().toLowerCase();
    const rangeCommits = submission && Array.isArray(submission.commits) ? submission.commits : [];
    if (!submission || !SUBMISSION_COMMIT_RE.test(commit) || !SUBMISSION_COMMIT_RE.test(String(submission.base || ''))
      || !rangeCommits.length || String(rangeCommits[rangeCommits.length - 1]).trim().toLowerCase() !== commit) continue;
    if (integratedOnly && !submission.integratedAt) continue;
    commits.add(commit);
  }
  return Array.from(commits);
}

// The integration queue: every ticket parked ready-for-integration, oldest
// submission first — the order the publish transaction integrates them in.
function submissionsPayload(slug?: any) {
  const tickets = listTickets(slug)
    .filter((t?: any) => !t.archived && t.status !== 'done' && pendingSubmission(t))
    .sort((a?: any, b?: any) => String(a.submission.at).localeCompare(String(b.submission.at)))
    .map((t?: any) => ({
      ref: t.ref,
      title: t.title,
      status: t.status,
      files: Array.isArray(t.files) ? t.files : [],
      executorVerify: t.executorVerify || null,
      submission: t.submission,
    }));
  return { tickets, count: tickets.length };
}

// Expire only dispatches that remained prepared. Launched and bound dispatches are stateful work, not wall-clock leases.
function sweepStaleDispatches(opts?: any) {
  opts = opts || {};
  const source = opts.source ? String(opts.source) : 'sweep';
  const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now();
  const expired: any[] = [];
  for (const project of listProjects({ all: true })) {
    if (opts.project && project.slug !== opts.project) continue;
    for (const ticket of listTickets(project.slug)) {
      if (ticket.archived || ticket.status === 'done' || !expiredPreparedDispatch(dispatchState(ticket), now)) continue;
      try {
        const res = withTicketLock(project.slug, ticket.id, () => {
          const current = getTicket(project.slug, ticket.id);
          if (!current || !expiredPreparedDispatch(dispatchState(current), now)) return { ok: false };
          setDispatchTerminal(current, 'expired', source);
          current.dispatchNonce = null;
          current.dispatchExecutor = null;
          stampDispatchEvent(current, source);
          putTicket(project.slug, current);
          return { ok: true, ticket: current };
        });
        if (!res || !res.ok) continue;
        expired.push({ project: project.slug, ref: res.ticket.ref });
        addComment(project.slug, ticket.id, {
          by: 'sidequest', kind: 'comment', source,
          body: `Auto-expired prepared dispatch: it never launched within the ${Math.round(preparedDispatchTtlMs() / 3600000)} hour TTL.`,
        });
      } catch (_: any) {
        // One inaccessible board must not prevent other stale dispatches from recovering.
      }
    }
  }
  return { ok: true, ttlMs: preparedDispatchTtlMs(), expired };
}

// Release claims that exceeded the shared TTL. Each release is locked and audited,
// so a fresh replacement claim is never cleared by a stale snapshot.
function sweepStaleClaims(opts?: any) {
  opts = opts || {};
  const source = opts.source ? String(opts.source) : 'sweep';
  const released: any[] = [];
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
      } catch (_: any) {
        // One inaccessible board must not prevent other stale claims from recovering.
      }
    }
  }
  const dispatches = sweepStaleDispatches(opts);
  return { ok: true, ttlMs: claimTtlMs(), released, expiredDispatches: dispatches.expired };
}

// True when a ticket may be handed to a worker running as tier `want`: either the
// worker didn't specify a tier, or the tags match. Every ticket now carries a
// tier, so a filtered tier-X worker only gets exact-tier matches (no untagged
// pass-through).
function modelMatches(ticketModel?: any, want?: any) {
  return !want || ticketModel === want;
}

// The tickets that are ready to be worked right now: not done, not archived, not
// actively claimed, and not blocked by an unfinished ticket. This is the set to
// fan subagents out over (each still claims before working). Priority-ordered.
// opts.model restricts to that tier's work (exact-tier matches only).
function readyTickets(slug?: any, opts?: any) {
  opts = opts || {};
  const want = opts.model ? classifyModelFilter(opts.model) : 'any';
  if (want === 'unknown') throw new Error(`Unknown model: ${opts.model}`);
  const category = opts.category == null ? null : String(opts.category).trim().toLowerCase();
  return listTickets(slug)
    .filter((t?: any) => !t.archived)
    .filter((t?: any) => t.status !== 'done')
    .filter((t?: any) => !pendingSubmission(t)) // parked for integration, not for another executor
    .filter((t?: any) => !t.claim || isClaimStale(t.claim))
    .filter((t?: any) => !isBlocked(slug, t))
    .filter((t?: any) => modelMatches(t.model, want === 'any' ? null : want))
    .filter((t?: any) => !category || t.categoryId === category)
    .sort((a: any, b: any) => {
      const pr = priorityRank(a.priority) - priorityRank(b.priority);
      if (pr !== 0) return pr;
      return String(a.createdAt).localeCompare(String(b.createdAt));
    });
}

// Atomically claim the best available ticket in a project: highest priority
// first, oldest-first within a priority. Skips done tickets and ones actively
// claimed by another worker. Returns { ok:true, ticket } or { reason:'empty' }.
function claimNext(slug?: any, by?: any, opts?: any) {
  opts = opts || {};
  by = String(by || 'agent');
  const want = opts.model ? classifyModelFilter(opts.model) : 'any';
  if (want === 'unknown') throw new Error(`Unknown model: ${opts.model}`);
  const category = opts.category == null ? null : String(opts.category).trim().toLowerCase();
  const candidates = listTickets(slug)
    .filter((t?: any) => !t.archived)
    .filter((t?: any) => t.status !== 'done')
    .filter((t?: any) => !pendingSubmission(t)) // parked for integration, not for another executor
    .filter((t?: any) => !t.claim || isClaimStale(t.claim) || t.claim.by === by)
    .filter((t?: any) => !opts.priority || t.priority === String(opts.priority).toLowerCase())
    .filter((t?: any) => modelMatches(t.model, want === 'any' ? null : want))
    .filter((t?: any) => !category || t.categoryId === category) // a tier-X worker only claims X-tagged work
    .filter((t?: any) => opts.includeBlocked || !isBlocked(slug, t)) // never auto-hand-out blocked work
    .sort((a: any, b: any) => {
      const pr = priorityRank(a.priority) - priorityRank(b.priority);
      if (pr !== 0) return pr;
      return String(a.createdAt).localeCompare(String(b.createdAt));
    });
  for (const cand of candidates) {
    const res = claimTicket(slug, cand.id, by, { direct: !!opts.direct, reason: opts.reason, source: opts.source, sessionId: opts.sessionId });
    if (res.ok || res.reason === 'direct_not_allowed' || res.reason === 'direct_reason_required') return res;
    // Lost the race or it changed under us — try the next candidate.
  }
  return { ok: false, reason: 'empty' };
}

// Assign (or, with a null/blank assignee, unassign) a ticket. Assignment is a
// persistent "who owns this" marker — unlike claimTicket it has no TTL, does not
// move the ticket to "doing", and does not gate ready/next. It's how a human
// takes a ticket for themselves (assignee "you") or an agent hands one back.
function assignTicket(slug?: any, idOrRef?: any, assignee?: any, opts?: any) {
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
function listStories(slug?: any) {
  const out = db.listRows(database(), 'stories', { project: slug }).filter((s?: any) => s && s.id);
  out.sort((a?: any, b?: any) => (a.order || 0) - (b.order || 0));
  return out;
}

// Look up a story by its stable id or its human ref (US-4, case-insensitive).
function getStory(slug?: any, idOrRef?: any) {
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
function coerceStoryId(slug?: any, val?: any) {
  if (val == null) return null;
  const s = String(val).trim();
  if (!s || s.toLowerCase() === 'none' || s.toLowerCase() === 'null') return null;
  const story = getStory(slug, s);
  return story ? story.id : null;
}

const STORY_EXECUTION_CONTRACT_MAX_BYTES = 4 * 1024;

function normalizeStoryExecutionContract(value?: any) {
  if (value == null) return null;
  const contract = String(value).trim();
  if (!contract) return null;
  const bytes = Buffer.byteLength(contract, 'utf8');
  if (bytes > STORY_EXECUTION_CONTRACT_MAX_BYTES) {
    throw new Error(`story execution contract exceeds the ${STORY_EXECUTION_CONTRACT_MAX_BYTES}-byte limit.`);
  }
  return contract;
}

function storyExecutionContract(story?: any) {
  if (!story || !story.executionContract) return null;
  return {
    revision: Number(story.contractRevision) || 1,
    body: String(story.executionContract),
  };
}

function markStoryContractDrift(slug?: any, story?: any, fromRevision?: any, changedAt?: any) {
  const toRevision = Number(story && story.contractRevision) || 0;
  for (const ticket of listTickets(slug)) {
    if (ticket.storyId !== story.id || !ticket.claim || !ticket.claim.by || isClaimStale(ticket.claim)) continue;
    ticket.storyContractDrift = {
      storyRef: story.ref,
      fromRevision: Number(fromRevision) || 0,
      toRevision,
      changedAt,
    };
    ticket.lastEventType = 'story-contract';
    ticket.lastEventSource = 'story';
    ticket.updatedAt = changedAt;
    putTicket(slug, ticket);
  }
}

function createStory(slug?: any, fields?: any) {
  return transaction(() => {
    fields = fields || {};
    const id = newStoryId();
    const seq = nextStorySeq(slug);
    const now = new Date().toISOString();
    const executionContract = normalizeStoryExecutionContract(fields.executionContract);
    const story = {
      id,
      ref: `US-${seq}`,
      title: String(fields.title || 'Untitled story').trim().slice(0, 200) || 'Untitled story',
      description: String(fields.description || '').trim(),
      color: parseStoryColor(fields.color) || autoStoryColor(seq - 1),
      executionContract,
      contractRevision: executionContract ? 1 : 0,
      createdAt: now,
      updatedAt: now,
      order: Date.now(),
    };
    putStory(slug, story);
    return story;
  });
}

function updateStory(slug?: any, idOrRef?: any, patch?: any) {
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
    const previousRevision = Number(s.contractRevision) || 0;
    const nextContract = patch.executionContract === undefined ? s.executionContract || null : normalizeStoryExecutionContract(patch.executionContract);
    const contractChanged = nextContract !== (s.executionContract || null);
    if (contractChanged) {
      s.executionContract = nextContract;
      s.contractRevision = previousRevision + 1;
    }
    const now = new Date().toISOString();
    s.updatedAt = now;
    putStory(slug, s);
    if (contractChanged) markStoryContractDrift(slug, s, previousRevision, now);
    return s;
  });
}

// Delete a story and detach it from its member tickets (clearing storyId, the
// same way deleteTicket strips dangling links) so no card is left tinted by a
// story that no longer exists.
function deleteStory(slug?: any, idOrRef?: any) {
  const s = getStory(slug, idOrRef);
  if (!s) return false;
  if (!deleteCachedRow(database(), 'stories', s.id)) return false;
  try {
    for (const t of listTickets(slug)) {
      if (t.storyId === s.id) updateTicket(slug, t.id, { storyId: null, source: 'cli' });
    }
  } catch (_: any) {
    /* best effort — the story file is already gone */
  }
  return true;
}

/* ------------------------------------------------------------------ *
 *  Comments
 *
 *  Appends happen under the ticket lock so two simultaneous comments never
 *  clobber each other.
 * ------------------------------------------------------------------ */

// Comments are durable cross-actor handoffs. Storage allows a useful evidence
// report; agentsync independently bounds what reaches an executor prompt.
const COMMENT_BODY_MAX = 16000;
const COMMENT_BODY_ADVISORY_BYTES = 4096;

function commentBodyAdvisory(body: string) {
  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes <= COMMENT_BODY_ADVISORY_BYTES) return null;
  return `body stored in full (${(bytes / 1024).toFixed(1)} KB); default reads excerpt bodies past 1200 chars - prefer a tight report and link artifacts (paths, commit hashes) over pasting content.`;
}

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
// path, so every comment surface gets the same normalization.
function stripControlChars(s?: any) {
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

function prepareComment(fields?: any) {
  fields = fields || {};
  const body = stripControlChars(String(fields.body || '')).trim();
  if (!body) return { ok: false, reason: 'empty' };
  if (body.length > COMMENT_BODY_MAX) {
    return { ok: false, reason: 'too_long', max: COMMENT_BODY_MAX, length: body.length };
  }
  const advisory = commentBodyAdvisory(body);
  return {
    ok: true,
    by: String(fields.by || 'agent'),
    kind: 'comment',
    body,
    source: fields.source ? String(fields.source) : 'cli',
    ...(advisory ? { advisory } : {}),
  };
}

function createComment(fields?: any, at?: any) {
  return {
    id: newCommentId(),
    by: fields.by,
    kind: fields.kind,
    body: fields.body,
    source: fields.source,
    at: at || new Date().toISOString(),
  };
}

function addComment(slug?: any, idOrRef?: any, fields?: any) {
  const prepared = prepareComment(fields);
  if (!prepared.ok) return prepared;
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: 'not_found' };
  return withTicketLock(slug, found.id, () => {
    const t = getTicket(slug, found.id);
    if (!t) return { ok: false, reason: 'not_found' };
    if (!Array.isArray(t.comments)) t.comments = [];
    const comment = createComment(prepared);
    t.comments.push(comment);
    t.lastEventType = 'comment';
    t.lastEventSource = comment.source;
    t.updatedAt = comment.at;
    putTicket(slug, t);
    queueEventNotification(slug, t, t.lastEventType, t.lastEventSource, { commentBody: comment.body });
    return { ok: true, ticket: t, comment, ...((prepared as any).advisory ? { advisory: (prepared as any).advisory } : {}) };
  });
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
function linkTypePair(verb?: any) {
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

function upperRef(r?: any) {
  return String(r).toUpperCase();
}

// Add one directed link to a single ticket (idempotent), under its lock.
function addLinkToTicket(slug?: any, idOrRef?: any, type?: any, otherRef?: any) {
  const found = getTicket(slug, idOrRef);
  if (!found) return;
  withTicketLock(slug, found.id, () => {
    const t = getTicket(slug, found.id);
    if (!t) return;
    if (!Array.isArray(t.links)) t.links = [];
    const ref = upperRef(otherRef);
    if (!t.links.some((l?: any) => l.type === type && upperRef(l.ref) === ref)) {
      t.links.push({ type, ref });
      t.updatedAt = new Date().toISOString();
      putTicket(slug, t);
    }
  });
}

// Link two tickets by a verb, writing the correct direction on each side.
function linkTickets(slug?: any, fromRef?: any, verb?: any, toRef?: any) {
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
function unlinkTickets(slug?: any, aRef?: any, bRef?: any) {
  const a = getTicket(slug, aRef);
  const b = getTicket(slug, bRef);
  if (!a || !b) return { ok: false, reason: 'not_found' };
  stripLinksTo(slug, a.id, b.ref);
  stripLinksTo(slug, b.id, a.ref);
  return { ok: true };
}

function stripLinksTo(slug?: any, idOrRef?: any, otherRef?: any) {
  const found = getTicket(slug, idOrRef);
  if (!found) return;
  withTicketLock(slug, found.id, () => {
    const t = getTicket(slug, found.id);
    if (!t || !Array.isArray(t.links)) return;
    const ref = upperRef(otherRef);
    const kept = t.links.filter((l?: any) => upperRef(l.ref) !== ref);
    if (kept.length !== t.links.length) {
      t.links = kept;
      t.updatedAt = new Date().toISOString();
      putTicket(slug, t);
    }
  });
}

// The refs a ticket is blocked-by that are not yet done (i.e. genuinely blocking).
function openBlockers(slug?: any, ticket?: any) {
  if (!ticket || !Array.isArray(ticket.links)) return [];
  const out: any[] = [];
  for (const l of ticket.links) {
    if (l.type !== 'blocked-by') continue;
    const blocker = getTicket(slug, l.ref);
    if (blocker && blocker.status !== 'done') out.push(blocker.ref);
  }
  return out;
}

function isBlocked(slug?: any, ticket?: any) {
  return openBlockers(slug, ticket).length > 0;
}

// Resolve a ticket's open blockers against an in-memory ref->ticket index
// (uppercased refs), instead of openBlockers()'s per-link getTicket fallback:
// links store "SQ-n" refs while ticket files are named by id, so the per-link
// path degenerates into a full-board rescan per link.
function openBlockersFromIndex(index?: any, ticket?: any) {
  if (!ticket || !Array.isArray(ticket.links)) return [];
  const out: any[] = [];
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
function briefTicket(slug?: any, t?: any, opts?: any) {
  opts = opts || {};
  let blockedBy: any;
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
    route: routeDescriptor(t.model, t.effort),
    effort: t.effort || null,
    readonlyOverride: t.readonlyOverride === false ? false : null,
    direct: t.directClaim || null,
    ...(opts.includeScope ? {
      files: Array.isArray(t.files) ? t.files : [],
      contracts: contractMetadata(t),
    } : {}),
    claim: t.claim && t.claim.by ? { by: t.claim.by, at: t.claim.at, stale: isClaimStale(t.claim) } : null,
    blockedBy,
    comments: Array.isArray(t.comments) ? t.comments.length : 0,
    checkpoint: checkpointProjection(t),
    submission: pendingSubmission(t) ? { commit: t.submission.commit, at: t.submission.at } : null,
  };
}

// A list cursor is just the next row offset, carried as an opaque decimal
// string. Kept transparent (not base64) so `--cursor 150` is usable by hand and
// a script can pipe nextCursor straight back. Garbage or a negative decodes to
// the first page rather than throwing.
function decodeListCursor(cursor?: any) {
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
//   - none of the above: the default page cap from the cursor.
// nextCursor is the next offset as a string, or null when the page reaches the
// end. Because each page is a contiguous slice and the next cursor is exactly
// where it stopped, following nextCursor to exhaustion yields every ticket once.
function pageTickets(tickets?: any, opts?: any) {
  const total = tickets.length;
  const start = Math.min(decodeListCursor(opts.cursor), total);
  const limit = opts.limit != null ? Math.max(0, Math.floor(Number(opts.limit)) || 0) : null;
  const budget = opts.maxChars != null && Number(opts.maxChars) > 0 ? Number(opts.maxChars) : null;

  let end: any;
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
const DEFAULT_LIST_PAGE_LIMIT = 40;

function listPayload(slug?: any, opts?: any) {
  opts = opts || {};
  const project = String(slug || '');
  const filter = {
    archived: !!opts.archived,
    status: opts.status == null && !opts.all ? ['todo', 'doing'] : opts.status,
  };
  const paging = !opts.all && opts.limit == null ? Object.assign({}, opts, { limit: DEFAULT_LIST_PAGE_LIMIT }) : opts;
  const total = countTickets(project, filter);
  let index: any;
  if (opts.brief) {
    const rows = db.selectRows(database(), 'SELECT ref, status FROM tickets WHERE project = ?', [project]);
    index = new Map(rows.map((row?: any) => [String(row.ref).toUpperCase(), row]));
  }

  if (!paging.all && paging.limit != null && paging.maxChars == null) {
    const offset = Math.min(decodeListCursor(paging.cursor), total);
    let tickets = queryTickets(project, { ...filter, limit: paging.limit, offset });
    if (opts.brief) tickets = tickets.map((ticket?: any) => briefTicket(project, ticket, { index }));
    const returned = tickets.length;
    const nextOffset = offset + returned;
    return {
      tickets,
      total,
      returned,
      nextCursor: nextOffset < total ? String(nextOffset) : null,
      claimTtlMs: claimTtlMs(),
      categories: classifierCategories({ project }),
    };
  }

  let tickets = queryTickets(project, filter);
  if (opts.brief) tickets = tickets.map((ticket?: any) => briefTicket(project, ticket, { index }));
  const page: any = pageTickets(tickets, paging);
  page.claimTtlMs = claimTtlMs();
  page.categories = classifierCategories({ project });
  return page;
}

// Same for the ready read. Waves are ALWAYS arrays of refs (both transports,
// brief or not) — full tickets ride only in `tickets`, so nothing is
// serialized twice and the field has one shape. Ready tickets are unblocked by
// construction, so brief projections skip the blocker lookup outright.
function readyPayload(slug?: any, opts?: any) {
  opts = opts || {};
  let tickets = readyTickets(slug, { model: opts.model, category: opts.category });
  const waves = readyWaves(slug, { model: opts.model, category: opts.category }).map((wave?: any) => wave.map((t?: any) => t.ref));
  const waveDependencies = readyWaveDependencies(slug, { model: opts.model, category: opts.category });
  if (opts.brief) tickets = tickets.map((t?: any) => briefTicket(slug, t, { blockedBy: [], includeScope: true }));
  return { tickets, waves, waveDependencies, claimTtlMs: claimTtlMs(), categories: classifierCategories({ project: slug }) };
}

function claimPulse(claim?: any, now?: any) {
  if (!claim || !claim.by) return null;
  const atMs = Date.parse(claim.at);
  return {
    by: claim.by,
    at: claim.at,
    ageMs: Number.isFinite(atMs) ? Math.max(0, now - atMs) : null,
  };
}

function boundedExcerpt(value?: any, maxChars = 1200) {
  const text = String(value || '');
  if (text.length <= maxChars) return { text, length: text.length, truncated: false };
  const tailLength = Math.min(240, Math.floor(maxChars / 4));
  const marker = `\n[… ${text.length - maxChars} more chars; use full:true …]\n`;
  const headLength = maxChars - tailLength - marker.length;
  return {
    text: `${text.slice(0, headLength)}${marker}${text.slice(-tailLength)}`,
    length: text.length,
    truncated: true,
  };
}

const COMMENT_BODY_RETENTION = 10;

function commentHistory(comments?: any, full = false) {
  const history = Array.isArray(comments) ? comments : [];
  const omittedBodies = full ? 0 : Math.max(0, history.length - COMMENT_BODY_RETENTION);
  if (!omittedBodies) return { comments: history, omittedBodies: 0, notice: null };
  const notice = `${omittedBodies} earlier comment bodies omitted — pass --full to see them.`;
  return {
    comments: history.map((comment: any, index: number) => {
      if (index >= omittedBodies) return comment;
      const { body: _body, ...metadata } = comment;
      return Object.assign(metadata, { bodyOmitted: true });
    }),
    omittedBodies,
    notice,
  };
}

function lastCommentPulse(ticket?: any) {
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

function latestCommentExcerpt(ticket?: any) {
  const comments = Array.isArray(ticket.comments) ? ticket.comments : [];
  const comment = comments[comments.length - 1];
  if (!comment) return null;
  const body = boundedExcerpt(comment.body, 200);
  return {
    by: comment.by,
    kind: comment.kind,
    body: body.text,
    bodyLength: body.length,
    bodyTruncated: body.truncated,
  };
}

function gitPulse(projectPath?: any, files?: any) {
  if (!projectPath || !Array.isArray(files) || !files.length) return null;
  try {
    const git = (args?: any) => execFileSync('git', args, {
      cwd: projectPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();
    if (git(['rev-parse', '--is-inside-work-tree']) !== 'true') return null;
    const commit = git(['log', '-1', '--format=%H%x1f%s%x1f%cI', '--', ...files]);
    const [hash, subject, at] = commit ? commit.split('\x1f') : [];
    const changed = git(['status', '--porcelain', '--', ...files]);
    return {
      commit: hash ? { hash, subject, at } : null,
      dirty: Boolean(changed),
    };
  } catch (_: any) {
    return null;
  }
}

function claimActivityPulse(ticket?: any, git?: any) {
  const claim = ticket && ticket.claim;
  if (!claim || !claim.by) return { working: false, lastActivityAt: null };
  const activity = [claim.at];
  for (const comment of Array.isArray(ticket.comments) ? ticket.comments : []) {
    if (comment && comment.by === claim.by) activity.push(comment.at);
  }
  if (git && git.commit && git.commit.at) activity.push(git.commit.at);
  const timestamps = activity
    .filter((at?: any) => Number.isFinite(Date.parse(at)))
    .sort((a?: any, b?: any) => Date.parse(b) - Date.parse(a));
  return { working: true, lastActivityAt: timestamps[0] || null };
}

function pulsePayload(slug?: any, idOrRef?: any) {
  const ticket = getTicket(slug, idOrRef);
  if (!ticket) return null;
  const meta = readMeta(slug);
  const git = gitPulse(meta && meta.path, ticket.files);
  const activity = claimActivityPulse(ticket, git);
  const dispatch = dispatchState(ticket);
  return {
    ref: ticket.ref,
    title: ticket.title,
    status: ticket.status,
    direct: ticket.directClaim || null,
    claim: claimPulse(ticket.claim, Date.now()),
    working: activity.working,
    lastActivityAt: activity.lastActivityAt,
    comments: Array.isArray(ticket.comments) ? ticket.comments.length : 0,
    lastComment: lastCommentPulse(ticket),
    dispatchExecutor: ticket.dispatchExecutor || null,
    dispatch: dispatch ? {
      state: pulseDispatchState(dispatch),
      sessionId: dispatch.sessionId || null,
      tokenPrefix: dispatch.tokenPrefix || null,
      executor: dispatch.executor || null,
      route: normalizeRoute(dispatch.route),
      recovery: dispatch.recovery || null,
      attempts: Array.isArray(dispatch.attempts) ? dispatch.attempts : [],
      agentId: dispatch.agentId || null,
      agentName: dispatch.agentName || null,
      preparedAt: dispatch.preparedAt || null,
      launchedAt: dispatch.launchedAt || null,
      boundAt: dispatch.boundAt || null,
      claimedAt: dispatch.claimedAt || null,
      terminalAt: dispatch.terminalAt || null,
      terminalSource: dispatch.terminalSource || null,
      outcome: dispatch.outcome || null,
    } : null,
    checkpoint: checkpointProjection(ticket),
    ...(storyContractDriftWarnings(ticket).length ? { warnings: storyContractDriftWarnings(ticket) } : {}),
    submission: ticket.submission || null,
    git,
  };
}

function changesPayload(slug?: any, since?: any) {
  const serverTime = new Date().toISOString();
  const nowMs = Date.parse(serverTime);
  const defaultSince = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const after = since == null ? defaultSince : String(since);
  const afterMs = Date.parse(after);
  if (!Number.isFinite(afterMs)) throw new Error('changes: --since must be an ISO timestamp.');
  const changedAt = (ticket?: any) => {
    const updatedMs = Date.parse(ticket.updatedAt);
    const expiresMs = Date.parse(ticket.checkpoint && ticket.checkpoint.expiresAt);
    return Number.isFinite(expiresMs) && expiresMs <= nowMs ? Math.max(updatedMs, expiresMs) : updatedMs;
  };
  const tickets = listTickets(slug)
    .filter((ticket?: any) => changedAt(ticket) > afterMs)
    .sort((a?: any, b?: any) => changedAt(a) - changedAt(b))
    .map((ticket?: any) => ({
      ref: ticket.ref,
      title: ticket.title,
      status: ticket.status,
      lastEventType: ticket.lastEventType || null,
      lastEventSource: ticket.lastEventSource || null,
      lastComment: latestCommentExcerpt(ticket),
      claim: claimPulse(ticket.claim, nowMs),
      checkpoint: checkpointProjection(ticket, nowMs),
      ...(storyContractDriftWarnings(ticket).length ? { warnings: storyContractDriftWarnings(ticket) } : {}),
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

const NOTIFICATION_KINDS = ['comment', 'created', 'status', 'reminder'];

// The three background-event kinds a user can opt in/out of from the dashboard's
// settings popover (a 'reminder' notification isn't optional this way — only
// *when* it fires is, via fireAt). Kept server-side, not just in the dashboard's
// localStorage, so the queue below can honor the same opt-outs even when no
// dashboard tab is open to gate on the client's behalf.
const NOTIFY_PREF_DEFAULTS: Record<string, boolean> = { comment: true, created: true, status: true };

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
function writeNotifications(list?: any) {
  writeGlobal('notifications', { notifications: list });
}

// Serialize every mutation on the queue behind one lock (best-effort, like the
// ticket mutators: still applies if contention outlasts the retries).
function withNotificationsLock(fn?: any) {
  const lock = notificationsLockPath();
  const locked = acquireLock(lock);
  try {
    return transaction(fn);
  } finally {
    if (locked) releaseLock(lock);
  }
}

// Drop the oldest read notifications past the cap; never touches unread ones.
function pruneReadList(list?: any) {
  const read = list.filter((n?: any) => n.readAt);
  if (read.length <= MAX_READ_KEPT) return list;
  read.sort((a?: any, b?: any) => String(b.readAt).localeCompare(String(a.readAt)));
  const dropIds = new Set(read.slice(MAX_READ_KEPT).map((n?: any) => n.id));
  return list.filter((n?: any) => !dropIds.has(n.id));
}

// List notifications, newest first. opts: { projectSlug, kind, unreadOnly,
// includePending, limit }. A reminder scheduled for the future (fireAt > now) is
// hidden until it's due unless includePending is set.
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

// Append a notification and return it. Unknown kinds coerce to "comment".
// fireAt is only meaningful for reminders (a scheduled future time); everything
// else leaves it null. Prunes read history in the same locked write.
function addNotification(fields?: any) {
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
  const out: Record<string, any> = {};
  for (const k of Object.keys(NOTIFY_PREF_DEFAULTS)) out[k] = merged[k] !== false;
  return out;
}

// Persist a partial or full set of opt-in/out prefs. Unknown keys are dropped.
function setNotifyPrefs(patch?: any) {
  const next = Object.assign({}, getNotifyPrefs(), patch || {});
  const out: Record<string, any> = {};
  for (const k of Object.keys(NOTIFY_PREF_DEFAULTS)) out[k] = next[k] !== false;
  writeGlobal('notify-prefs', out);
  return out;
}

// Build the title/body for a background-event notification, mirroring the
// dashboard's own maybeNotify() toast copy so a persisted inbox entry reads the
// same as the desktop toast the user may also have seen for the same event.
function eventNotificationCopy(ticket?: any, kind?: any, extra?: any) {
  extra = extra || {};
  const ref = ticket.ref;
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
function queueEventNotification(slug?: any, ticket?: any, kind?: any, source?: any, extra?: any) {
  if (!ticket || !source || String(source) === 'dashboard') return null; // your own action never notifies you
  if (NOTIFY_PREF_DEFAULTS[kind] == null) return null; // not an opt-in-able kind (e.g. 'edit'/'archived')
  if (!getNotifyPrefs()[kind]) return null; // opted out for this kind, globally
  const pmeta = readMeta(slug);
  if (pmeta && pmeta.notify === false) return null; // this whole board is muted
  const eventAt = ticket.updatedAt;
  const dup = readNotifications().some((n?: any) => n.ticketId === ticket.id && n.kind === kind && n.ticketEventAt === eventAt);
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
function dismiss(id?: any) {
  return withNotificationsLock(() => {
    const list = readNotifications();
    const kept = list.filter((n?: any) => n.id !== id);
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
function getPendingReminder(ticketId?: any) {
  if (!ticketId) return null;
  return pendingReminders().get(ticketId) || null;
}

// Schedule (or reschedule) a reminder on a ticket. fireAt must parse to a
// moment in the future. At most one pending reminder per ticket — setting a
// new one cancels whatever was pending, same as "snoozing" it.
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

// Cancel whatever reminder is currently pending on a ticket. Not finding one
// isn't an error — cancelling a reminder that already fired (or never
// existed) is a no-op the caller can treat as success.
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
function writeWorkers(obj?: any) {
  writeGlobal('workers', obj);
}
function withWorkersLock(fn?: any) {
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
function pruneWorkers(w?: any) {
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
function registerWorker(sessionId?: any, slug?: any, ticketId?: any, by?: any) {
  if (!sessionId || !slug || !ticketId) return;
  try {
    withWorkersLock(() => {
      const w = readWorkers();
      const now = new Date().toISOString();
      const s = w.sessions[sessionId] || (w.sessions[sessionId] = { updatedAt: now, claims: [] });
      s.updatedAt = now;
      if (!Array.isArray(s.claims)) s.claims = [];
      if (!s.claims.some((c?: any) => c.slug === slug && c.ticketId === ticketId)) {
        s.claims.push({ slug, ticketId, by: by || null, at: now });
      }
      writeWorkers(pruneWorkers(w));
    });
  } catch (_: any) {
    /* the TTL is the backstop — a registry write failure must never break a claim */
  }
}

// Forget a claim (the worker finished or dropped it). No-op without a session id.
function unregisterClaim(sessionId?: any, slug?: any, ticketId?: any) {
  if (!sessionId || !slug || !ticketId) return;
  try {
    withWorkersLock(() => {
      const w = readWorkers();
      const s = w.sessions[sessionId];
      if (!s || !Array.isArray(s.claims)) return;
      s.claims = s.claims.filter((c?: any) => !(c.slug === slug && c.ticketId === ticketId));
      s.updatedAt = new Date().toISOString();
      writeWorkers(pruneWorkers(w));
    });
  } catch (_: any) {
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
function markLongRunFlagged(sessionId?: any, slug?: any, ticketId?: any, claimAt?: any) {
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
  } catch (_: any) {
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
function reconcileSession(sessionId?: any, opts?: any) {
  opts = opts || {};
  const reason = opts.reason ? String(opts.reason) : 'worker session ended';
  const source = opts.source ? String(opts.source) : 'cli';
  const released: any[] = [];
  if (!sessionId) return { ok: true, released };

  // Snapshot this session's claims and clear its registry entry in one locked
  // step, so a concurrent reconcile of the same session can't double-release.
  let claims: any[] = [];
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
  } catch (_: any) {
    return { ok: true, released };
  }

  for (const c of claims) {
    let t: any;
    try {
      t = getTicket(c.slug, c.ticketId);
    } catch (_: any) {
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
        } catch (_: any) {
          /* the release is what matters; the note is a courtesy */
        }
      }
    } catch (_: any) {
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
function sessionClaims(sessionId?: any, opts?: any) {
  const out: any[] = [];
  if (!sessionId) return out;
  const agentId = opts && opts.agentId ? String(opts.agentId) : null;
  const agentName = opts && opts.agentName ? String(opts.agentName) : null;
  const executor = opts && opts.executor ? String(opts.executor) : null;
  let claims: any[] = [];
  try {
    withWorkersLock(() => {
      const w = readWorkers();
      const s = w.sessions[String(sessionId)];
      claims = s && Array.isArray(s.claims) ? s.claims.slice() : [];
    });
  } catch (_: any) {
    return out;
  }
  for (const c of claims) {
    let ref = null;
    let status = null;
    let held = false;
    try {
      const t = getTicket(c.slug, c.ticketId);
      if (t) {
        const state = dispatchState(t);
        if ((agentId || agentName) && (!state ||
          (agentId && state.agentId !== agentId) ||
          (agentName && state.agentName !== agentName) ||
          (executor && state.executor !== executor))) continue;
        ref = t.ref;
        status = t.status;
        held = !!(t.claim && t.claim.by && (!c.by || t.claim.by === c.by));
      }
    } catch (_: any) {
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
function writeServerInfo(info?: any) {
  writeGlobal('server-info', info);
}
function clearServerInfo() {
  deleteCachedRow(database(), 'globals', 'server-info');
}

module.exports = {
  VALID_STATUS,
  VALID_PRIORITY,
  VALID_EFFORTS,
  CLAUDE_RUNTIMES,
  ROUTING_FALLBACK_DEFAULT,
  EXECUTOR_ANCHORS_MAX,
  EXECUTOR_VERIFY_MAX,
  DISPATCH_DESCRIPTION_MIN,
  dispatchDescriptionError,
  dispatchWarnings,
  ticketReferenceWarnings,
  ticketCategoryWarnings,
  ticketPlanningWarnings,
  coerceComplexity,
  legacyCategoryForComplexity,
  applyDerivedRouting,
  getModelVocab,
  modelsPayload,
  routingModels,
  resolveModelId,
  resolveExec,
  resolveReportedExec,
  normalizeReportedModel,
  resolvedDispatchRoute,
  spawnDescription,
  SHARED_TREE_ARTIFACT_MARKER,
  sharedTreeArtifactRequested,
  categoryArtifactRoot,
  sharedTreeArtifactMode,
  resolveCategoryRoute,
  claudeQuotaFailure,
  classifyModelFilter,
  getRoutingFallback,
  setRoutingFallback,
  mutateRoutingPolicy,
  routingProfileSettings,
  listRoutingProfiles,
  routingProfileDetails,
  createRoutingProfile,
  editRoutingProfile,
  retireRoutingProfile,
  routingProfileHygiene,
  repointRoutingProfiles,
  promoteRoutingProfile,
  getRoutingProfile,
  projectRoutingProfile,
  setProjectRoutingProfile,
  setNewProjectRoutingProfile,
  routingProfileEntries,
  routingProfileCategory,
  setRoutingProfileCategory,
  removeRoutingProfileCategory,
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
  boardConfig,
  setBoardConfig,
  integrationTarget,
  effectiveScope,
  listProjects,
  findProject,
  archiveProject,
  unarchiveProject,
  deleteProjectExact,
  mergeProject,
  setProjectNotify,
  setProjectRouting,
  projectRoutingEnabled,
  copyAsset,
  saveAssetData,
  assetPath,
  listTickets,
  listAllProjectTickets,
  getTicket,
  createTicket,
  updateTicket,
  deleteTicket,
  stableExecutorName,
  prepareDispatch,
  readDispatchBriefing,
  isSupersededDispatchToken,
  recordDispatchLaunch,
  recoverDispatchQuotaFailure,
  bindDispatchAgent,
  terminalDispatchTarget,
  markDispatchStopped,
  reconcileLaunchedDispatches,
  claimTicket,
  releaseTicket,
  completeTicket,
  completeTicketAsControlPlane,
  closeTicketForGrooming,
  makeWorkedBy,
  checkpointTicket,
  checkpointProjection,
  checkpointTtlMs,
  DEFAULT_CHECKPOINT_TTL_MIN,
  MAX_CHECKPOINT_TTL_MIN,
  submitTicket,
  clearSubmission,
  pendingSubmission,
  submissionBaseCandidates,
  submissionsPayload,
  claimNext,
  assignTicket,
  readyTickets,
  readyWaves,
  readyWaveDependencies,
  scopesOverlap,
  normalizeFiles,
  scopeExpansionFiles,
  scopeExpansionCommand,
  requestScope,
  normalizeContracts,
  contractCollisionReasons,
  STORY_PALETTE,
  STORY_COLOR_NAMES,
  STORY_EXECUTION_CONTRACT_MAX_BYTES,
  storyExecutionContract,
  listStories,
  getStory,
  createStory,
  updateStory,
  deleteStory,
  addComment,
  linkTickets,
  unlinkTickets,
  openBlockers,
  isBlocked,
  briefTicket,
  listPayload,
  readyPayload,
  pulsePayload,
  changesPayload,
  boundedExcerpt,
  commentHistory,
  archiveTicket,
  unarchiveTicket,
  archiveAllDone,
  listArchived,
  listActive,
  isClaimStale,
  claimTtlMs,
  preparedDispatchTtlMs,
  DEFAULT_CLAIM_TTL_MIN,
  DEFAULT_PREPARED_DISPATCH_TTL_HOURS,
  sweepStaleClaims,
  sweepStaleDispatches,
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
