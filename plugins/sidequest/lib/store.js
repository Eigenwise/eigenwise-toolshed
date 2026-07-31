"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { dispatchLaunchName, stableClaudeName, stableDispatchName, stableReadOnlyClaudeName, stableReadOnlyDispatchName } = require("./exec-names.js");
const crypto = require("crypto");
const { execFileSync, spawnSync } = require("child_process");
const db = require("./db.js");
const { DEFAULT_CATEGORIES, ROUTING_PROFILE_SEED_REVISION, STARTER_ROUTING_PROFILES } = require("./category-defaults.js");
const commitScope = require("./commit-scope.js");
const { migrateIfNeeded } = require("./migrate.js");
const { discoverExternalModels, providerReadiness } = require("./discovery.js");
const telemetry = require("./telemetry.js");
const { routingDisabledMessage } = require("./refusal-guidance.js");
const { assertSidequestInstall, assertDispatchTransport } = require("./dispatch-preflight.js");
const { createAssets } = require("./store/assets.js");
const { createNotifications } = require("./store/notifications.js");
const AGENT_DESCRIPTION_MAX_LENGTH = 120;
const ARTIFACT_BASELINE_MAX_PATHS = 500;
const WORKTREE_SETUP_MAX_LENGTH = 1e3;
const SHARED_TREE_ARTIFACT_MARKER = "Shared-tree artifact mode: leave the generated map as working-tree output; verify, comment, and close with done. Do not commit, submit, push, or edit source.";
const CONTROL_PLANE_COMPLETION = /* @__PURE__ */ Symbol("sidequest.control-plane-completion");
const DELIVERY_MODES = ["merge", "replay", "apply"];
const DEFAULT_INTEGRATION_VERIFY_TIMEOUT_MS = 10 * 60 * 1e3;
const MAX_INTEGRATION_VERIFY_TIMEOUT_MS = 60 * 60 * 1e3;
const INTEGRATION_VERIFY_OUTPUT_TAIL_BYTES = 8 * 1024;
function descriptionField(...candidates) {
  for (const candidate of candidates) {
    const value = String(candidate == null ? "" : candidate).replace(/[\s\[\]]+/g, " ").trim();
    if (value) return value;
  }
  return "";
}
function spawnDescription(ticket, resolved) {
  const title = String(ticket && ticket.title || "Sidequest ticket").replace(/\s+/g, " ").trim();
  const model = descriptionField(resolved && resolved.runsLabel, resolved && resolved.runsModel, ticket && ticket.model) || "unrouted";
  const effort = descriptionField(ticket && ticket.effort, resolved && resolved.effort) || "unset";
  const prefix = `[model=${model} effort=${effort}] `;
  const maxTitleLength = Math.max(1, AGENT_DESCRIPTION_MAX_LENGTH - prefix.length);
  return `${prefix}${title.slice(0, maxTitleLength).trimEnd()}`.slice(0, AGENT_DESCRIPTION_MAX_LENGTH);
}
function nextDispatchLaunchSeq(state) {
  if (!state) return 1;
  const current = Number.isInteger(state.launchSeq) && state.launchSeq > 0 ? state.launchSeq : 1;
  return state.launchedAt ? current + 1 : current;
}
function homeRoot() {
  const env = process.env.SIDEQUEST_HOME;
  if (env && String(env).trim()) return path.resolve(String(env).trim());
  return path.join(os.homedir(), ".claude", "sidequest");
}
function projectsRoot() {
  return path.join(homeRoot(), "projects");
}
function serverFile() {
  return path.join(homeRoot(), "server.json");
}
function normalizeForHash(absPath) {
  const p = path.resolve(absPath);
  return process.platform === "win32" ? p.toLowerCase() : p;
}
function slugify(absPath) {
  const base = path.basename(path.resolve(absPath)).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "project";
  const hash = crypto.createHash("sha1").update(normalizeForHash(absPath)).digest("hex").slice(0, 8);
  return `${base}-${hash}`;
}
function mainWorktreeRoot(gitEntry) {
  let stat;
  try {
    stat = fs.statSync(gitEntry);
  } catch (_) {
    return null;
  }
  if (!stat.isFile()) return null;
  let content;
  try {
    content = fs.readFileSync(gitEntry, "utf8");
  } catch (_) {
    return null;
  }
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(content);
  if (!m) return null;
  let gitdir = m[1].replace(/[/\\]+$/, "");
  if (!path.isAbsolute(gitdir)) gitdir = path.resolve(path.dirname(gitEntry), gitdir);
  const parts = gitdir.split(/[/\\]+/);
  const wtIdx = parts.lastIndexOf("worktrees");
  if (wtIdx < 1) return null;
  const gitDirPath = parts.slice(0, wtIdx).join(path.sep);
  const root = path.dirname(gitDirPath);
  try {
    if (fs.statSync(root).isDirectory()) return path.resolve(root);
  } catch (_) {
  }
  return null;
}
function nearestRepoRoot(startDir) {
  const start = path.resolve(startDir);
  const wt = /^(.*?)[/\\]\.claude[/\\]worktrees[/\\]/i.exec(start + path.sep);
  if (wt && wt[1]) {
    const owner = path.resolve(wt[1]);
    try {
      if (fs.statSync(owner).isDirectory()) return owner;
    } catch (_) {
    }
  }
  let dir = start;
  for (; ; ) {
    try {
      const entry = path.join(dir, ".git");
      if (fs.existsSync(entry)) {
        return mainWorktreeRoot(entry) || dir;
      }
    } catch (_) {
      return start;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}
function projectDir(slug) {
  return path.join(projectsRoot(), slug);
}
function ticketsDir(slug) {
  return path.join(projectDir(slug), "tickets");
}
function assetsDir(slug, id) {
  return path.join(projectDir(slug), "assets", id);
}
const dbByHome = /* @__PURE__ */ new Map();
const transactionDepth = /* @__PURE__ */ new WeakMap();
const storeCacheByDatabase = /* @__PURE__ */ new WeakMap();
function sqliteDataVersion(handle) {
  const row = handle.prepare("PRAGMA data_version").get();
  return Number(row && row.data_version) || 0;
}
function newStoreCache(dataVersion) {
  return {
    dataVersion,
    metadata: /* @__PURE__ */ new Map(),
    projectCategories: /* @__PURE__ */ new Map(),
    routingProfiles: /* @__PURE__ */ new Map(),
    routingProfileEntries: /* @__PURE__ */ new Map(),
    projectRoutingProfiles: /* @__PURE__ */ new Map(),
    routingProfileSettings: void 0,
    routingFallback: void 0,
    snapshots: /* @__PURE__ */ new Map()
  };
}
function residentCache() {
  const handle = database();
  const dataVersion = sqliteDataVersion(handle);
  let cache = storeCacheByDatabase.get(handle);
  if (!cache || cache.dataVersion !== dataVersion) {
    cache = newStoreCache(dataVersion);
    storeCacheByDatabase.set(handle, cache);
  }
  return cache;
}
function invalidateStoreCaches() {
  const handle = database();
  storeCacheByDatabase.set(handle, newStoreCache(sqliteDataVersion(handle)));
}
function putCachedRow(handle, table, row) {
  const result = db.putRow(handle, table, row);
  invalidateStoreCaches();
  return result;
}
function deleteCachedRow(handle, table, key) {
  const deleted = db.deleteRow(handle, table, key);
  if (deleted) invalidateStoreCaches();
  return deleted;
}
function cloneCached(value) {
  return value == null ? value : structuredClone(value);
}
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}
const { copyAsset, saveAssetData, assetPath } = createAssets({ assetsDir, ensureDir });
const {
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
  setReminder
} = createNotifications({
  acquireLock,
  crypto,
  getTicket,
  path,
  projectsRoot,
  readGlobal,
  readMeta,
  releaseLock,
  transaction,
  writeGlobal
});
function refreshRoutingProfileSeeds(handle) {
  const pending = [];
  for (const seed of STARTER_ROUTING_PROFILES) {
    const profile = handle.prepare(`
      SELECT id, seed_revision FROM routing_profiles WHERE source = 'seed' AND seed_key = ?
    `).get(seed.id);
    if (!profile || profile.seed_revision == null || Number(profile.seed_revision) >= ROUTING_PROFILE_SEED_REVISION) continue;
    pending.push({ seed, profileId: profile.id });
  }
  if (!pending.length) return;
  db.txn(handle, () => {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const affected = /* @__PURE__ */ new Set();
    for (const { seed, profileId } of pending) {
      handle.prepare("DELETE FROM routing_profile_entries WHERE profile_id = ?").run(profileId);
      seed.categories.forEach((category, position) => {
        handle.prepare(`
          INSERT INTO routing_profile_entries (profile_id, category_id, data, position, updated_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(profileId, category.id, JSON.stringify(category), position, now);
      });
      handle.prepare(`
        UPDATE routing_profiles SET name = ?, description = ?, seed_revision = ?, revision = revision + 1, updated_at = ?
        WHERE id = ?
      `).run(seed.name, seed.description, ROUTING_PROFILE_SEED_REVISION, now, profileId);
      for (const row of handle.prepare("SELECT project FROM project_routing_profiles WHERE profile_id = ?").all(profileId)) {
        affected.add(String(row.project));
      }
    }
    refreshPreparedDispatches(handle, [...affected], null);
  });
}
function refreshReadonlyCategorySeeds(handle) {
  const readonlyIds = /* @__PURE__ */ new Set([
    ...DEFAULT_CATEGORIES.filter((category) => category.readonly === true).map((category) => category.id),
    "hand-analysis"
  ]);
  const affected = /* @__PURE__ */ new Set();
  let changed = false;
  db.txn(handle, () => {
    const updateProfileEntry = handle.prepare("UPDATE routing_profile_entries SET data = ?, updated_at = ? WHERE profile_id = ? AND category_id = ?");
    const updateProjectEntry = handle.prepare("UPDATE project_categories SET data = ? WHERE project = ? AND id = ?");
    const now = (/* @__PURE__ */ new Date()).toISOString();
    for (const row of handle.prepare("SELECT profile_id, category_id, data FROM routing_profile_entries").all()) {
      let category;
      try {
        category = JSON.parse(row.data);
      } catch (_) {
        continue;
      }
      if (!readonlyIds.has(category?.id) || category.readonly !== void 0) continue;
      category.readonly = true;
      updateProfileEntry.run(JSON.stringify(category), now, row.profile_id, row.category_id);
      for (const project of handle.prepare("SELECT project FROM project_routing_profiles WHERE profile_id = ?").all(row.profile_id)) affected.add(String(project.project));
      changed = true;
    }
    for (const row of handle.prepare("SELECT project, id, data FROM project_categories").all()) {
      let category;
      try {
        category = JSON.parse(row.data);
      } catch (_) {
        continue;
      }
      if (!readonlyIds.has(row.id) || category.readonly !== void 0) continue;
      category.readonly = true;
      updateProjectEntry.run(JSON.stringify(category), row.project, row.id);
      affected.add(String(row.project));
      changed = true;
    }
    if (changed) refreshPreparedDispatches(handle, [...affected], [...readonlyIds]);
  });
}
function database() {
  const root = homeRoot();
  let handle = dbByHome.get(root);
  if (!handle) {
    handle = db.openDb(root);
    migrateIfNeeded(handle, root);
    refreshRoutingProfileSeeds(handle);
    refreshReadonlyCategorySeeds(handle);
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
  putCachedRow(database(), "projects", { slug, data: meta });
}
function ticketStorageRow(slug, ticket) {
  const stored = Object.assign({}, ticket);
  if (stored.category && typeof stored.category === "object") stored.category = stored.categoryId || stored.category.id;
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
    data: stored
  };
}
function putTicket(slug, ticket) {
  putCachedRow(database(), "tickets", ticketStorageRow(slug, ticket));
  const project = readMeta(slug);
  telemetry.emitTicket({ slug, path: project && project.path }, applyDerivedRouting(Object.assign({}, ticket), { project: slug }));
}
function putStory(slug, story) {
  putCachedRow(database(), "stories", { id: story.id, project: slug, data: story });
}
function readGlobal(key, fallback) {
  const value = db.getRow(database(), "globals", key);
  return value == null ? fallback : value;
}
function writeGlobal(key, value) {
  putCachedRow(database(), "globals", { key, data: value });
}
function newTicketId() {
  const t = Date.now().toString(36);
  const r = crypto.randomBytes(4).toString("hex");
  return `tk_${t}_${r}`;
}
const VALID_STATUS = ["todo", "doing", "done"];
const VALID_PRIORITY = ["low", "normal", "high", "urgent"];
const CLAUDE_RUNTIMES = ["haiku", "sonnet", "opus", "fable"];
const CLAUDE_RUNTIME_LABELS = {
  haiku: "Claude Haiku",
  sonnet: "Claude Sonnet",
  opus: "Claude Opus",
  fable: "Claude Fable"
};
const VALID_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const BACKEND_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;
const BACKEND_KEY_RE = /^([a-z0-9][a-z0-9-]{0,31}):([a-z0-9][a-z0-9-]{1,31})$/;
const HAIKU_BACKEND_EFFORT = "medium";
const ROUTING_FALLBACK_DEFAULT = Object.freeze({ model: "sonnet", effort: "high" });
const CLAUDE_QUOTA_FAILURES = Object.freeze([
  Object.freeze({ model: "fable", signature: "You've reached your Fable 5 limit" }),
  Object.freeze({ model: "opus", signature: "You've reached your Opus 5 limit" }),
  Object.freeze({ model: "opus", signature: "Your Claude Code subscription does not include access to Opus 5" })
]);
function coerceEffort(v) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  if (!s || s === "any" || s === "none" || s === "null" || s === "default") return null;
  return VALID_EFFORTS.includes(s) ? s : null;
}
function coerceComplexity(v) {
  if (v == null || String(v).trim() === "") return null;
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
  const agentSlug = discovered.filter((candidate) => candidate.slug === entry.slug).length > 1 ? `${entry.source}-${entry.slug}` : entry.slug;
  return { backend: "codex", provider: entry.provider, source: entry.source, slug: entry.slug, agentSlug, id: entry.id, label: entry.label };
}
function normalizeRouteModel(model) {
  if (typeof model !== "string") return null;
  const value = model.trim().toLowerCase();
  if (CLAUDE_RUNTIMES.includes(value)) return value;
  return BACKEND_SLUG_RE.test(value) || BACKEND_KEY_RE.test(value) ? value : null;
}
function availableRoute(model) {
  const normalized = normalizeRouteModel(model);
  if (!normalized) return null;
  if (CLAUDE_RUNTIMES.includes(normalized)) {
    return { backend: "claude", source: null, slug: normalized, id: normalized, label: CLAUDE_RUNTIME_LABELS[normalized] };
  }
  const catalog = discoveredByKey();
  const discovered = Object.values(catalog);
  const entry = catalog[normalized] || discoveredBySlug()[normalized];
  return entry ? resolvedBackend(entry, discovered) : null;
}
function reportingModelForms(value) {
  const normalized = String(value || "").trim().toLowerCase().replace(/\[1m\]$/, "");
  if (!normalized) return [];
  const forms = /* @__PURE__ */ new Set([normalized]);
  for (const form of Array.from(forms)) {
    forms.add(form.replace(/^claude-codex-/, ""));
    forms.add(form.replace(/^claude-/, ""));
  }
  for (const form of Array.from(forms)) forms.add(form.replace(/\./g, "-"));
  return Array.from(forms);
}
function claudeRuntimeAlias(forms) {
  for (const form of forms) {
    const runtime = String(form).replace(/-\d[\w.-]*$/, "");
    if (CLAUDE_RUNTIMES.includes(runtime)) return runtime;
  }
  return null;
}
function normalizeReportedModel(model) {
  const normalized = normalizeRouteModel(model);
  const direct = normalized && availableRoute(normalized);
  if (direct) return direct.slug;
  const forms = new Set(reportingModelForms(model));
  for (const entry of discoverExternalModels()) {
    const identities = [entry.slug, entry.id, dispatchModelFor(entry.id)];
    if (identities.some((identity) => reportingModelForms(identity).some((form) => forms.has(form)))) {
      return entry.slug;
    }
  }
  return claudeRuntimeAlias(forms);
}
function resolvedDispatchRoute(ticket) {
  const route = ticket && ticket.dispatch && normalizeRoute(ticket.dispatch.route);
  return route && availableRoute(route.model) ? route : null;
}
function dispatchModelFor(id) {
  return String(id || "").replace(/^claude-(?:codex-)?/, "").replace(/\[1m\]$/, "");
}
function dispatchRouteState(model, effort, exec) {
  return {
    model,
    effort,
    ...exec && exec.dispatchModel ? { marker: exec.dispatchModel } : {}
  };
}
function execFromBackend(backend, effort) {
  if (backend.backend === "codex") {
    const resolvedEffort = effort || HAIKU_BACKEND_EFFORT;
    return { agent: stableDispatchName(resolvedEffort), effort: resolvedEffort, model: null, spawnId: backend.id, dispatchModel: dispatchModelFor(backend.id), backend: "codex", source: backend.source, slug: backend.slug, runsModel: backend.slug, apiModel: backend.id, runsLabel: backend.label || backend.slug, dispatch: "native-agent" };
  }
  const runtime = backend.slug;
  const agent = effort ? stableClaudeName(effort) : null;
  return { agent, model: runtime, spawnId: runtime, backend: "claude", slug: runtime, runsModel: runtime, apiModel: runtime, runsLabel: backend.label || CLAUDE_RUNTIME_LABELS[runtime], dispatch: "native-agent" };
}
function resolveExec(model, effort) {
  const backend = availableRoute(model);
  if (!backend) return null;
  return execFromBackend(backend, coerceEffort(effort));
}
function resolveReportedExec(model, effort) {
  const normalized = normalizeReportedModel(model);
  return normalized ? resolveExec(normalized, effort) : null;
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
    discovered
  };
}
function getModelVocab() {
  return routingModels();
}
function routeDescriptor(model, effort) {
  return model && effort ? `${model}·${effort}` : null;
}
function modelsPayload(opts) {
  opts = opts || {};
  const catalog = routingModels();
  const categories = getCategories({ project: opts.project });
  const payload = {
    models: catalog.models,
    efforts: catalog.efforts,
    discovered: catalog.discovered,
    globalFallback: Object.assign({ label: "availability fallback" }, getRoutingFallback()),
    categories: categories.map((category) => {
      const resolved = resolveCategoryRoute(category);
      return { id: category.id, route: routeDescriptor(resolved.model, resolved.effort) };
    })
  };
  if (!opts.full) return payload;
  const projectCategories = getProjectCategories(opts.project);
  const selected = opts.project ? projectRoutingProfile(opts.project) : null;
  const profile = selected ? selected.profile : getRoutingProfile(defaultRoutingProfileId());
  return Object.assign(payload, {
    newBoardProfile: routingProfileDetails(defaultRoutingProfileId()),
    profile: profile ? { id: profile.id, name: profile.name, revision: profile.revision, entryCount: routingProfileEntries(profile.id).length } : null,
    categories: categories.map((category) => {
      const resolved = resolveCategoryRoute(category);
      return Object.assign({}, category, {
        configured: { route: category.route, fallback: category.fallback },
        resolved: { model: resolved.model, effort: resolved.effort, exec: execProjection(resolved.exec) },
        warnings: resolved.warnings
      });
    }),
    warnings: projectCategories.warnings
  });
}
function classifyModelFilter(v) {
  if (v == null) return "any";
  const value = String(v).trim().toLowerCase();
  if (!value || value === "any" || value === "none" || value === "null") return "any";
  const exec = resolveReportedExec(value, null);
  return exec ? exec.runsModel : "unknown";
}
function legacyCategoryForComplexity(value) {
  const complexity = coerceComplexity(value);
  if (!complexity) return null;
  if (complexity <= 3) return "coding.easy";
  if (complexity <= 6) return "coding.normal";
  return "coding.hard";
}
function normalizeRoute(raw) {
  if (!raw || typeof raw !== "object") return null;
  const model = normalizeRouteModel(raw.model);
  const effort = coerceEffort(raw.effort);
  return model && effort ? { model, effort } : null;
}
function claudeQuotaFailure(error) {
  const text = String(error || "");
  return CLAUDE_QUOTA_FAILURES.find((failure) => text.includes(failure.signature)) || null;
}
function getRoutingFallback() {
  const cache = residentCache();
  if (cache.routingFallback !== void 0) return cloneCached(cache.routingFallback);
  cache.routingFallback = normalizeRoute(readGlobal("routing-fallback", null));
  return cloneCached(cache.routingFallback);
}
function setRoutingFallback(route) {
  const normalized = normalizeRoute(route);
  if (!normalized) throw new Error("Routing fallback requires a valid model and effort.");
  return mutateRoutingPolicy({ allProjects: true }, (handle) => {
    db.putRow(handle, "globals", { key: "routing-fallback", data: normalized });
    return normalized;
  }).result;
}
function routingProfileSettings() {
  const cache = residentCache();
  if (cache.routingProfileSettings !== void 0) return cloneCached(cache.routingProfileSettings);
  const row = database().prepare("SELECT singleton, new_project_profile_id FROM routing_profile_settings WHERE singleton = 1").get();
  cache.routingProfileSettings = row ? { singleton: Number(row.singleton), newProjectProfileId: row.new_project_profile_id } : null;
  return cloneCached(cache.routingProfileSettings);
}
function getRoutingProfile(profileId) {
  const id = String(profileId || "").trim().toLowerCase();
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
    retiredAt: row.retired_at
  } : null;
  cache.routingProfiles.set(id, profile);
  return cloneCached(profile);
}
function routingProfileEntries(profileId) {
  const id = String(profileId || "").trim().toLowerCase();
  const cache = residentCache();
  if (cache.routingProfileEntries.has(id)) return cloneCached(cache.routingProfileEntries.get(id));
  const entries = database().prepare(`
    SELECT category_id, data, position, updated_at
    FROM routing_profile_entries WHERE profile_id = ? ORDER BY position, category_id
  `).all(id).map((row) => {
    try {
      return { categoryId: row.category_id, data: JSON.parse(row.data), position: Number(row.position), updatedAt: row.updated_at };
    } catch (_) {
      return null;
    }
  }).filter(Boolean);
  cache.routingProfileEntries.set(id, entries);
  return cloneCached(entries);
}
function defaultRoutingProfileId() {
  const settings = routingProfileSettings();
  if (!settings || !settings.newProjectProfileId) throw new Error("The new-board routing profile is not configured.");
  return settings.newProjectProfileId;
}
function projectRoutingProfile(project, repair = true) {
  const normalizedProject = String(project || "").trim();
  if (!normalizedProject) return null;
  const cache = residentCache();
  let pointer = cache.projectRoutingProfiles.get(normalizedProject);
  if (pointer === void 0) {
    const row = database().prepare(`
      SELECT project, profile_id, assigned_at, assigned_by FROM project_routing_profiles WHERE project = ?
    `).get(normalizedProject);
    pointer = row ? {
      project: row.project,
      profileId: row.profile_id,
      assignedAt: row.assigned_at,
      assignedBy: row.assigned_by
    } : null;
    cache.projectRoutingProfiles.set(normalizedProject, pointer);
  }
  let repaired = false;
  if (!pointer && repair) {
    const profileId = defaultRoutingProfileId();
    const assignedAt = (/* @__PURE__ */ new Date()).toISOString();
    transaction(() => {
      db.putRow(database(), "project_routing_profiles", {
        project: normalizedProject,
        profile_id: profileId,
        assigned_at: assignedAt,
        assigned_by: "invariant-repair"
      });
    });
    invalidateStoreCaches();
    pointer = { project: normalizedProject, profileId, assignedAt, assignedBy: "invariant-repair" };
    repaired = true;
  }
  if (!pointer) return null;
  const profile = getRoutingProfile(pointer.profileId);
  if (!profile) throw new Error(`Routing profile "${pointer.profileId}" for ${normalizedProject} does not exist.`);
  return {
    pointer,
    profile,
    warnings: repaired ? [{ kind: "missing-profile-pointer", project: normalizedProject, repairedTo: profile.id }] : []
  };
}
function policyMutationProjects(handle, scope) {
  const projects = new Set((scope.projects || []).map((project) => String(project || "").trim()).filter(Boolean));
  if (scope.allProjects) {
    for (const row of handle.prepare("SELECT slug FROM projects").all()) projects.add(String(row.slug));
  }
  for (const profileId of scope.profileIds || []) {
    for (const row of handle.prepare("SELECT project FROM project_routing_profiles WHERE profile_id = ?").all(String(profileId))) {
      projects.add(String(row.project));
    }
  }
  return projects;
}
function mutateRoutingPolicy(scope, mutation) {
  if (typeof mutation !== "function") throw new TypeError("mutateRoutingPolicy requires a synchronous mutation callback.");
  scope = scope || {};
  const handle = database();
  let result;
  let refresh;
  transaction(() => {
    const projects = policyMutationProjects(handle, scope);
    result = mutation(handle);
    for (const project of policyMutationProjects(handle, scope)) projects.add(project);
    refresh = refreshPreparedDispatches(handle, [...projects], scope.categoryIds || null);
  });
  invalidateStoreCaches();
  return { result, refresh };
}
function projectCategoryRows(project) {
  if (!project) return [];
  const cache = residentCache();
  const cached = cache.projectCategories.get(project);
  if (cached) return cloneCached(cached);
  const rows = database().prepare("SELECT id, kind, base_profile_id, base_data, data FROM project_categories WHERE project = ? ORDER BY id").all(project).map((row) => {
    try {
      return {
        id: row.id,
        kind: row.kind,
        baseProfileId: row.base_profile_id || null,
        baseData: row.base_data == null ? null : JSON.parse(row.base_data),
        data: JSON.parse(row.data)
      };
    } catch (_) {
      return null;
    }
  }).filter(Boolean);
  cache.projectCategories.set(project, rows);
  return cloneCached(rows);
}
function routingContext(project) {
  const selected = project ? projectRoutingProfile(project) : null;
  const profileId = selected ? selected.profile.id : defaultRoutingProfileId();
  const profile = selected ? selected.profile : getRoutingProfile(profileId);
  if (!profile) throw new Error(`Routing profile "${profileId}" does not exist.`);
  const entries = routingProfileEntries(profile.id);
  const general = entries.find((entry) => entry.categoryId === "general");
  if (!general || !normalizeCategory(general.data)?.enabled) {
    throw new Error(`Routing profile "${profile.id}" requires an enabled general category.`);
  }
  return { profile, entries, warnings: selected ? selected.warnings : [] };
}
function resolvedProfileCategories(opts) {
  opts = opts || {};
  const cache = residentCache();
  const cacheKey = `routing-categories:${opts.project || "@default"}:${opts.includeDisabled === false ? "enabled" : "all"}:${opts.withState === true ? "state" : "plain"}`;
  if (cache.snapshots.has(cacheKey)) return cloneCached(cache.snapshots.get(cacheKey));
  const context = routingContext(opts.project);
  const categories = /* @__PURE__ */ new Map();
  const warnings = context.warnings.slice();
  for (const entry of context.entries) {
    const category = normalizeCategory(entry.data);
    if (!category) continue;
    categories.set(category.id, Object.assign({}, category, {
      origin: "profile",
      profileId: context.profile.id,
      baseProfileId: context.profile.id,
      changedFields: [],
      warnings: [],
      ...opts.withState ? { linkState: "linked" } : {}
    }));
  }
  for (const row of projectCategoryRows(opts.project)) {
    const base = categories.get(row.id);
    const rowWarnings = [];
    if (row.baseProfileId && row.baseProfileId !== context.profile.id) {
      rowWarnings.push({ kind: "foreign-base", id: row.id, baseProfileId: row.baseProfileId, profileId: context.profile.id });
    }
    if (row.kind === "ADD") {
      if (base) rowWarnings.push({ kind: "add-collision", id: row.id, profileId: context.profile.id });
      const category = normalizeCategory(row.data);
      if (category) categories.set(category.id, Object.assign({}, category, {
        origin: "added",
        profileId: context.profile.id,
        baseProfileId: null,
        changedFields: [],
        warnings: rowWarnings,
        ...opts.withState ? { linkState: "added" } : {}
      }));
    } else if (row.kind === "OVERRIDE") {
      let source = base;
      if (!source) {
        source = normalizeCategory(row.baseData);
        rowWarnings.push({ kind: "override-using-snapshot", id: row.id, baseProfileId: row.baseProfileId });
      }
      const category = source && normalizeCategory(Object.assign({}, source, row.data, { id: row.id }));
      if (category) categories.set(category.id, Object.assign({}, category, {
        origin: "override",
        profileId: context.profile.id,
        baseProfileId: row.baseProfileId,
        changedFields: Object.keys(row.data).sort(),
        warnings: rowWarnings,
        ...opts.withState ? { linkState: "overridden" } : {}
      }));
    } else if (row.kind === "DETACH") {
      const category = normalizeCategory(row.data);
      if (category) categories.set(category.id, Object.assign({}, category, {
        origin: "detached",
        profileId: context.profile.id,
        baseProfileId: row.baseProfileId,
        changedFields: [],
        warnings: rowWarnings,
        ...opts.withState ? { linkState: "detached" } : {}
      }));
    } else if (row.kind === "DISABLE") {
      if (!base) rowWarnings.push({ kind: "redundant-disable", id: row.id, profileId: context.profile.id });
      categories.delete(row.id);
    }
    warnings.push(...rowWarnings.map((warning) => Object.assign({ project: opts.project }, warning)));
  }
  const general = categories.get("general");
  if (!general || !general.enabled) throw new Error(`Routing profile "${context.profile.id}" must resolve an enabled general category.`);
  const result = {
    profile: context.profile,
    categories: [...categories.values()].filter((category) => opts.includeDisabled !== false || category.enabled).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
    warnings
  };
  cache.snapshots.set(cacheKey, result);
  return cloneCached(result);
}
function projectCategoryWarnings(project) {
  return resolvedProfileCategories({ project }).warnings;
}
function getCategoryRoutePairs() {
  const pairs = [];
  const seen = /* @__PURE__ */ new Set();
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
  for (const row of database().prepare("SELECT data FROM routing_profile_entries ORDER BY profile_id, position, category_id").all()) {
    try {
      add(normalizeCategory(JSON.parse(row.data)));
    } catch (_) {
    }
  }
  for (const row of database().prepare("SELECT slug FROM projects ORDER BY slug").all()) {
    for (const category of getCategories({ project: row.slug })) add(category);
  }
  return pairs;
}
function getProjectCategories(project) {
  return { rows: projectCategoryRows(project), warnings: projectCategoryWarnings(project) };
}
function getCategories(opts) {
  return cloneCached(resolvedProfileCategories(opts).categories);
}
function normalizeCategoryId(id) {
  return String(id || "").trim().toLowerCase();
}
function getCategory(id, opts) {
  const normalizedId = normalizeCategoryId(id);
  opts = opts || {};
  const cache = residentCache();
  const cacheKey = `routing-category:${opts.project || "@default"}:${normalizedId}:${opts.includeDisabled === false ? "enabled" : "all"}:${opts.withState === true ? "state" : "plain"}`;
  if (cache.snapshots.has(cacheKey)) return cloneCached(cache.snapshots.get(cacheKey));
  const category = resolvedProfileCategories(opts).categories.find((candidate) => candidate.id === normalizedId) || null;
  cache.snapshots.set(cacheKey, category);
  return cloneCached(category);
}
function normalizeArtifactRoots(value) {
  if (!Array.isArray(value)) return [];
  const roots = commitScope.scopedPaths(value);
  return commitScope.validateRelativeScopes(roots).ok ? roots : [];
}
function requireArtifactRoots(value) {
  if (value == null) return;
  if (!Array.isArray(value)) throw new Error("Category artifactRoots must be an array of repository-relative paths.");
  const validation = commitScope.validateRelativeScopes(value);
  if (value.length && !validation.ok) {
    throw new Error(`Category artifactRoots must be repository-relative paths without traversal: ${validation.outside.join(", ")}`);
  }
}
function normalizeCategory(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = normalizeCategoryId(raw.id);
  if (!id) return null;
  const route = normalizeRoute(raw.route) || { model: "sonnet", effort: "medium" };
  const fallback = raw.fallback == null ? null : normalizeRoute(raw.fallback);
  return {
    id,
    name: String(raw.name || id).trim().slice(0, 120) || id,
    description: String(raw.description || "").trim(),
    route,
    fallback,
    contract: String(raw.contract || "").trim(),
    artifactRoots: normalizeArtifactRoots(raw.artifactRoots),
    readonly: raw.readonly === true,
    enabled: raw.enabled !== false
  };
}
function routingProfileCategory(profileId, id) {
  const normalizedId = normalizeCategoryId(id);
  const entry = routingProfileEntries(profileId).find((candidate) => candidate.categoryId === normalizedId);
  return entry ? normalizeCategory(entry.data) : null;
}
function setRoutingProfileCategory(profileId, categoryOrId, patch) {
  const normalizedProfileId = String(profileId || "").trim().toLowerCase();
  const profile = getRoutingProfile(normalizedProfileId);
  if (!profile) throw new Error(`Routing profile "${normalizedProfileId}" does not exist.`);
  const requested = typeof categoryOrId === "string" ? Object.assign({}, routingProfileCategory(normalizedProfileId, categoryOrId), patch || {}, { id: normalizeCategoryId(categoryOrId) }) : categoryOrId;
  const normalized = normalizeCategory(requested);
  if (!normalized) throw new Error("Category id is required.");
  requireArtifactRoots(requested && requested.artifactRoots);
  if (!normalizeRoute(requested && requested.route)) throw new Error("Category route requires a valid model and effort.");
  if (requested && requested.fallback != null && !normalizeRoute(requested.fallback)) throw new Error("Category fallback requires a valid model and effort.");
  if (normalized.id === "general" && !normalized.enabled) throw new Error('Category "general" cannot be disabled.');
  const outcome = mutateRoutingPolicy({ profileIds: [normalizedProfileId], categoryIds: [normalized.id] }, (handle) => {
    const now = (/* @__PURE__ */ new Date()).toISOString();
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
function setCategory(categoryOrId, patch) {
  return setRoutingProfileCategory(defaultRoutingProfileId(), categoryOrId, patch);
}
function removeRoutingProfileCategory(profileId, id) {
  const normalizedProfileId = String(profileId || "").trim().toLowerCase();
  const normalizedId = normalizeCategoryId(id);
  if (normalizedId === "general") throw new Error('Category "general" cannot be removed.');
  if (!getRoutingProfile(normalizedProfileId)) throw new Error(`Routing profile "${normalizedProfileId}" does not exist.`);
  const outcome = mutateRoutingPolicy({ profileIds: [normalizedProfileId], categoryIds: [normalizedId] }, (handle) => {
    const deleted = handle.prepare("DELETE FROM routing_profile_entries WHERE profile_id = ? AND category_id = ?").run(normalizedProfileId, normalizedId).changes !== 0;
    if (deleted) {
      handle.prepare("UPDATE routing_profiles SET revision = revision + 1, seed_revision = NULL, updated_at = ? WHERE id = ?").run((/* @__PURE__ */ new Date()).toISOString(), normalizedProfileId);
    }
    return deleted;
  });
  return outcome.result;
}
function removeCategory(id) {
  return removeRoutingProfileCategory(defaultRoutingProfileId(), id);
}
function normalizeFullProjectCategory(id, kind, data) {
  const required = ["name", "description", "contract", "route", "fallback", "enabled"];
  if (!data || typeof data !== "object" || Array.isArray(data) || required.some((key) => !Object.hasOwn(data, key))) {
    throw new Error(`Project category ${kind} requires a complete category row.`);
  }
  requireArtifactRoots(data.artifactRoots);
  const normalized = normalizeCategory(Object.assign({}, data, { id }));
  if (!normalized || !normalizeRoute(data.route)) throw new Error(`Project category ${kind} requires a valid full category route.`);
  if (data.fallback != null && !normalizeRoute(data.fallback)) throw new Error(`Project category ${kind} fallback requires a valid model and effort.`);
  return normalized;
}
function setProjectCategory(project, id, kind, data) {
  const normalizedProject = String(project || "").trim();
  const normalizedId = normalizeCategoryId(id);
  const normalizedKind = String(kind || "").trim().toUpperCase();
  if (!normalizedProject || !normalizedId) throw new Error("Project and category id are required.");
  if (!["ADD", "OVERRIDE", "DETACH", "DISABLE"].includes(normalizedKind)) throw new Error("Project category kind must be ADD, OVERRIDE, DETACH, or DISABLE.");
  const selected = projectRoutingProfile(normalizedProject);
  if (!selected) throw new Error(`Project "${normalizedProject}" does not have a routing profile.`);
  const base = routingProfileCategory(selected.profile.id, normalizedId);
  let normalizedData;
  if (normalizedKind === "ADD") {
    if (base) throw new Error(`Project category ADD "${normalizedId}" collides with profile "${selected.profile.id}".`);
    normalizedData = normalizeFullProjectCategory(normalizedId, normalizedKind, data);
  } else if (normalizedKind === "DETACH") {
    normalizedData = normalizeFullProjectCategory(normalizedId, normalizedKind, data);
    if (normalizedId === "general" && !normalizedData.enabled) throw new Error('Category "general" cannot be disabled.');
  } else if (normalizedKind === "OVERRIDE") {
    if (!base) throw new Error(`Project category OVERRIDE "${normalizedId}" requires a profile category.`);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Project category OVERRIDE requires a patch object.");
    const allowed = /* @__PURE__ */ new Set(["name", "description", "contract", "artifactRoots", "readonly", "route", "fallback"]);
    for (const key of Object.keys(data)) if (!allowed.has(key)) throw new Error(`Project category OVERRIDE cannot patch "${key}".`);
    requireArtifactRoots(data.artifactRoots);
    if (data.route != null && !normalizeRoute(data.route)) throw new Error("Project category OVERRIDE route requires a valid model and effort.");
    if (data.fallback != null && !normalizeRoute(data.fallback)) throw new Error("Project category OVERRIDE fallback requires a valid model and effort.");
    normalizedData = Object.assign({}, data);
  } else {
    if (normalizedId === "general") throw new Error('Category "general" cannot be disabled.');
    if (!base) throw new Error(`Project category DISABLE "${normalizedId}" requires a profile category.`);
    normalizedData = {};
  }
  const baseProfileId = normalizedKind === "ADD" ? null : selected.profile.id;
  const baseData = normalizedKind === "OVERRIDE" ? base : null;
  const outcome = mutateRoutingPolicy({ projects: [normalizedProject], categoryIds: [normalizedId] }, (handle) => {
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
      JSON.stringify(normalizedData)
    );
    return { project: normalizedProject, id: normalizedId, kind: normalizedKind, baseProfileId, baseData, data: normalizedData };
  });
  return outcome.result;
}
function detachCategory(project, id) {
  const normalizedProject = String(project || "").trim();
  const normalizedId = normalizeCategoryId(id);
  if (!normalizedProject || !normalizedId) throw new Error("Project and category id are required.");
  const existing = projectCategoryRows(normalizedProject).find((row) => row.id === normalizedId);
  if (existing && existing.kind === "DETACH") throw new Error(`Project category "${normalizedId}" is already detached.`);
  const category = getCategory(normalizedId, { project: normalizedProject });
  if (!category) throw new Error(`Project category "${normalizedId}" does not resolve to a category.`);
  return setProjectCategory(normalizedProject, normalizedId, "DETACH", category);
}
function setProjectRoutingProfile(project, profileId, assignedBy) {
  const normalizedProject = String(project || "").trim();
  const normalizedProfileId = String(profileId || "").trim().toLowerCase();
  if (!normalizedProject || !normalizedProfileId) throw new Error("Project and routing profile id are required.");
  if (!readMeta(normalizedProject)) throw new Error(`Project "${normalizedProject}" does not exist.`);
  const profile = getRoutingProfile(normalizedProfileId);
  if (!profile) throw new Error(`Routing profile "${normalizedProfileId}" does not exist.`);
  if (profile.retiredAt) throw new Error(`Routing profile "${normalizedProfileId}" is retired.`);
  return mutateRoutingPolicy({ projects: [normalizedProject] }, (handle) => {
    const assignedAt = (/* @__PURE__ */ new Date()).toISOString();
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
function setNewProjectRoutingProfile(profileId) {
  const normalizedProfileId = String(profileId || "").trim().toLowerCase();
  const profile = getRoutingProfile(normalizedProfileId);
  if (!profile) throw new Error(`Routing profile "${normalizedProfileId}" does not exist.`);
  if (profile.retiredAt) throw new Error(`Routing profile "${normalizedProfileId}" is retired.`);
  return mutateRoutingPolicy({}, (handle) => {
    handle.prepare(`
      INSERT INTO routing_profile_settings (singleton, new_project_profile_id) VALUES (1, ?)
      ON CONFLICT(singleton) DO UPDATE SET new_project_profile_id = excluded.new_project_profile_id
    `).run(normalizedProfileId);
    return { newProjectProfileId: normalizedProfileId };
  }).result;
}
function listRoutingProfiles(opts) {
  const includeRetired = opts && opts.retired === true;
  const sql = `
    SELECT id, name, description, source, seed_key, seed_revision, revision, created_at, updated_at, retired_at
    FROM routing_profiles ${includeRetired ? "" : "WHERE retired_at IS NULL"} ORDER BY lower(name), id
  `;
  return database().prepare(sql).all().map((row) => Object.assign({}, getRoutingProfile(row.id), {
    entryCount: Number(database().prepare("SELECT COUNT(*) AS count FROM routing_profile_entries WHERE profile_id = ?").get(row.id)?.count ?? 0)
  }));
}
function normalizeRoutingProfileId(profileId) {
  const id = String(profileId || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) throw new Error("Routing profile id must use lowercase letters, numbers, dots, underscores, or hyphens.");
  return id;
}
function routingProfileDetails(profileId) {
  const profile = getRoutingProfile(profileId);
  if (!profile) return null;
  const entries = routingProfileEntries(profile.id).map((entry) => entry.data);
  return Object.assign({}, profile, { entryCount: entries.length, categories: entries });
}
function createRoutingProfile(profileId, opts) {
  opts = opts || {};
  const id = normalizeRoutingProfileId(profileId);
  const fromId = String(opts.from || defaultRoutingProfileId()).trim().toLowerCase();
  const source = getRoutingProfile(fromId);
  if (!source) throw new Error(`Routing profile "${fromId}" does not exist.`);
  const entries = routingProfileEntries(fromId);
  const name = String(opts.name || id).trim();
  if (!name) throw new Error("Routing profile name is required.");
  const now = (/* @__PURE__ */ new Date()).toISOString();
  return mutateRoutingPolicy({}, (handle) => {
    if (handle.prepare("SELECT 1 FROM routing_profiles WHERE id = ?").get(id)) throw new Error(`Routing profile "${id}" already exists.`);
    if (handle.prepare("SELECT 1 FROM routing_profiles WHERE lower(name) = lower(?)").get(name)) throw new Error(`Routing profile name "${name}" already exists.`);
    handle.prepare(`
      INSERT INTO routing_profiles (id, name, description, source, seed_key, seed_revision, revision, created_at, updated_at, retired_at)
      VALUES (?, ?, ?, 'user', NULL, NULL, 1, ?, ?, NULL)
    `).run(id, name, String(opts.description || "").trim(), now, now);
    const insert = handle.prepare("INSERT INTO routing_profile_entries (profile_id, category_id, data, position, updated_at) VALUES (?, ?, ?, ?, ?)");
    for (const entry of entries) insert.run(id, entry.categoryId, JSON.stringify(entry.data), entry.position, now);
    return { id, from: fromId, entryCount: entries.length };
  }).result;
}
function editRoutingProfile(profileId, patch) {
  const id = normalizeRoutingProfileId(profileId);
  const profile = getRoutingProfile(id);
  if (!profile) throw new Error(`Routing profile "${id}" does not exist.`);
  patch = patch || {};
  const name = patch.name == null ? profile.name : String(patch.name).trim();
  const description = patch.description == null ? profile.description : String(patch.description).trim();
  if (!name) throw new Error("Routing profile name is required.");
  return mutateRoutingPolicy({ profileIds: [id] }, (handle) => {
    const collision = handle.prepare("SELECT id FROM routing_profiles WHERE lower(name) = lower(?) AND id <> ?").get(name, id);
    if (collision) throw new Error(`Routing profile name "${name}" already exists.`);
    handle.prepare("UPDATE routing_profiles SET name = ?, description = ?, updated_at = ? WHERE id = ?").run(name, description, (/* @__PURE__ */ new Date()).toISOString(), id);
    return { id, name, description };
  }).result;
}
function retireRoutingProfile(profileId) {
  const id = normalizeRoutingProfileId(profileId);
  const profile = getRoutingProfile(id);
  if (!profile) throw new Error(`Routing profile "${id}" does not exist.`);
  if (profile.retiredAt) return profile;
  const settings = routingProfileSettings();
  if (settings?.newProjectProfileId === id) throw new Error(`Routing profile "${id}" is the new-board profile and cannot be retired.`);
  const count = Number(database().prepare("SELECT COUNT(*) AS count FROM project_routing_profiles WHERE profile_id = ?").get(id)?.count ?? 0);
  if (count) throw new Error(`Routing profile "${id}" is used by ${count} board${count === 1 ? "" : "s"} and cannot be retired.`);
  return mutateRoutingPolicy({}, (handle) => {
    const retiredAt = (/* @__PURE__ */ new Date()).toISOString();
    handle.prepare("UPDATE routing_profiles SET retired_at = ?, updated_at = ? WHERE id = ?").run(retiredAt, retiredAt, id);
    return { id, retiredAt };
  }).result;
}
function canonicalRoutingValue(value) {
  if (Array.isArray(value)) return value.map(canonicalRoutingValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalRoutingValue(value[key])]));
}
function routingFingerprint(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonicalRoutingValue(value))).digest("hex");
}
function normalizedTaxonomy(project) {
  return getCategories({ project }).map((category) => normalizeCategory(category)).filter(Boolean).sort((a, b) => a.id.localeCompare(b.id));
}
function canonicalLocalRows(rows) {
  return (rows || []).map((row) => canonicalRoutingValue({
    id: row.id,
    kind: row.kind,
    baseProfileId: row.baseProfileId ?? row.base_profile_id ?? null,
    baseData: row.baseData ?? row.base_data ?? null,
    data: row.data
  })).sort((a, b) => a.id.localeCompare(b.id));
}
function localRowsFingerprint(project) {
  return routingFingerprint(canonicalLocalRows(projectCategoryRows(project)));
}
function routingProfileHygiene() {
  const projects = listProjects({ all: true }).map((project) => project.slug).sort();
  const profiles = listRoutingProfiles().filter((profile) => !profile.retiredAt);
  const profileTaxonomies = /* @__PURE__ */ new Map();
  for (const profile of profiles) {
    const taxonomy = routingProfileEntries(profile.id).map((entry) => normalizeCategory(entry.data)).filter(Boolean).sort((a, b) => a.id.localeCompare(b.id));
    profileTaxonomies.set(profile.id, routingFingerprint(taxonomy));
  }
  const promotionGroups = /* @__PURE__ */ new Map();
  const drift = [];
  for (const project of projects) {
    const rows = projectCategoryRows(project);
    if (!rows.length) continue;
    const rowFingerprint = routingFingerprint(canonicalLocalRows(rows));
    const group = promotionGroups.get(rowFingerprint) || [];
    group.push({ project, taxonomyFingerprint: routingFingerprint(normalizedTaxonomy(project)) });
    promotionGroups.set(rowFingerprint, group);
    const resolved = resolvedProfileCategories({ project });
    const foreignBaseCount = resolved.warnings.filter((warning) => warning.kind === "foreign-base").length;
    const effectiveCategoryCount = resolved.categories.length;
    const localRatio = effectiveCategoryCount ? rows.length / effectiveCategoryCount : 0;
    if (rows.length < 3 && localRatio < 0.25 && foreignBaseCount === 0) continue;
    const taxonomyFingerprint = routingFingerprint(normalizedTaxonomy(project));
    const matchingProfiles = profiles.filter((profile) => profileTaxonomies.get(profile.id) === taxonomyFingerprint).map((profile) => profile.id);
    const targetProfileId = matchingProfiles.find((profileId) => profileId !== resolved.profile.id) || matchingProfiles[0] || null;
    drift.push({
      kind: targetProfileId ? "repoint" : "fork-promote",
      project,
      profileId: resolved.profile.id,
      targetProfileId,
      localRowCount: rows.length,
      effectiveCategoryCount,
      localRatio,
      foreignBaseCount,
      localRowIds: rows.map((row) => row.id),
      taxonomyFingerprint
    });
  }
  const promotions = [...promotionGroups.entries()].filter(([, boards]) => boards.length >= 2).map(([fingerprint, boards]) => ({
    kind: "promote",
    sourceProject: boards[0].project,
    projects: boards.map((board) => board.project),
    localRowCount: projectCategoryRows(boards[0].project).length,
    localRowsFingerprint: fingerprint,
    taxonomyFingerprints: [...new Set(boards.map((board) => board.taxonomyFingerprint))]
  }));
  const pointerCounts = new Map(database().prepare(`
    SELECT profile_id, COUNT(*) AS count FROM project_routing_profiles GROUP BY profile_id
  `).all().map((row) => [row.profile_id, Number(row.count)]));
  const retirements = profiles.filter((profile) => (profile.source === "user" || profile.source === "migrated") && !pointerCounts.get(profile.id)).map((profile) => ({ kind: "retire", profileId: profile.id, name: profile.name, source: profile.source }));
  return {
    promotions,
    drift,
    retirements,
    proposals: [...promotions, ...drift, ...retirements]
  };
}
function hypotheticalTaxonomy(project, profileId) {
  const categories = /* @__PURE__ */ new Map();
  for (const entry of routingProfileEntries(profileId)) {
    const category = normalizeCategory(entry.data);
    if (category) categories.set(category.id, category);
  }
  for (const row of projectCategoryRows(project)) {
    const base = categories.get(row.id);
    if (row.kind === "ADD" || row.kind === "DETACH") {
      const category = normalizeCategory(row.data);
      if (category) categories.set(row.id, category);
    } else if (row.kind === "OVERRIDE") {
      const category = normalizeCategory(Object.assign({}, base || row.baseData, row.data, { id: row.id }));
      if (category) categories.set(row.id, category);
    } else if (row.kind === "DISABLE") {
      categories.delete(row.id);
    }
  }
  return [...categories.values()].sort((a, b) => a.id.localeCompare(b.id));
}
function taxonomyDrift(before = [], after = []) {
  const previous = new Map(before.map((category) => [category.id, category]));
  const next = new Map(after.map((category) => [category.id, category]));
  const added = [...next.keys()].filter((id) => !previous.has(id));
  const missing = [...previous.keys()].filter((id) => !next.has(id));
  const changed = [...next.keys()].filter((id) => previous.has(id) && routingFingerprint(previous.get(id)) !== routingFingerprint(next.get(id)));
  return { added, missing, changed, hasDrift: added.length + missing.length + changed.length > 0 };
}
function repointRoutingProfiles(fromProfileId, toProfileId, opts) {
  opts = opts || {};
  const from = normalizeRoutingProfileId(fromProfileId);
  const to = normalizeRoutingProfileId(toProfileId);
  if (!getRoutingProfile(from)) throw new Error(`Routing profile "${from}" does not exist.`);
  const target = getRoutingProfile(to);
  if (!target) throw new Error(`Routing profile "${to}" does not exist.`);
  if (target.retiredAt) throw new Error(`Routing profile "${to}" is retired.`);
  const projects = database().prepare("SELECT project FROM project_routing_profiles WHERE profile_id = ? ORDER BY project").all(from).map((row) => row.project);
  const boards = projects.map((project) => ({ project, drift: taxonomyDrift(normalizedTaxonomy(project), hypotheticalTaxonomy(project, to)) }));
  if (opts.dryRun) return { from, to, dryRun: true, boards };
  return mutateRoutingPolicy({ projects }, (handle) => {
    const assignedAt = (/* @__PURE__ */ new Date()).toISOString();
    const update = handle.prepare("UPDATE project_routing_profiles SET profile_id = ?, assigned_at = ?, assigned_by = ? WHERE project = ? AND profile_id = ?");
    for (const project of projects) update.run(to, assignedAt, opts.assignedBy == null ? null : String(opts.assignedBy), project, from);
    return { from, to, dryRun: false, boards };
  }).result;
}
function promoteRoutingProfile(profileId, sourceProject, projects, opts) {
  opts = opts || {};
  const id = normalizeRoutingProfileId(profileId);
  const source = String(sourceProject || "").trim();
  const selected = [...new Set((projects || []).map((project) => String(project || "").trim()).filter(Boolean))];
  if (!readMeta(source)) throw new Error(`Project "${source}" does not exist.`);
  if (!selected.length) throw new Error("Profile promotion requires at least one target board.");
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
  const now = (/* @__PURE__ */ new Date()).toISOString();
  return mutateRoutingPolicy({ projects: selected }, (handle) => {
    if (handle.prepare("SELECT 1 FROM routing_profiles WHERE id = ?").get(id)) throw new Error(`Routing profile "${id}" already exists.`);
    if (handle.prepare("SELECT 1 FROM routing_profiles WHERE lower(name) = lower(?)").get(name)) throw new Error(`Routing profile name "${name}" already exists.`);
    handle.prepare(`
      INSERT INTO routing_profiles (id, name, description, source, seed_key, seed_revision, revision, created_at, updated_at, retired_at)
      VALUES (?, ?, ?, 'user', NULL, NULL, 1, ?, ?, NULL)
    `).run(id, name, String(opts.description || "").trim(), now, now);
    const insert = handle.prepare("INSERT INTO routing_profile_entries (profile_id, category_id, data, position, updated_at) VALUES (?, ?, ?, ?, ?)");
    taxonomy.forEach((category, position) => insert.run(id, category.id, JSON.stringify(category), position, now));
    const repoint = handle.prepare("UPDATE project_routing_profiles SET profile_id = ?, assigned_at = ?, assigned_by = ? WHERE project = ?");
    const clear = handle.prepare("DELETE FROM project_categories WHERE project = ?");
    for (const project of selected) {
      repoint.run(id, now, opts.assignedBy == null ? null : String(opts.assignedBy), project);
      clear.run(project);
    }
    return { id, sourceProject: source, projects: selected, entryCount: taxonomy.length, taxonomyFingerprint: taxonomyHash, localRowsFingerprint: rowHash };
  }).result;
}
function removeProjectCategory(project, id) {
  const normalizedProject = String(project || "").trim();
  const normalizedId = normalizeCategoryId(id);
  if (!normalizedProject || !normalizedId) throw new Error("Project and category id are required.");
  return mutateRoutingPolicy({ projects: [normalizedProject], categoryIds: [normalizedId] }, (handle) => handle.prepare("DELETE FROM project_categories WHERE project = ? AND id = ?").run(normalizedProject, normalizedId).changes !== 0).result;
}
function classifierCategories(opts) {
  return getCategories(Object.assign({}, opts, { includeDisabled: false })).map(({ id, name, description, route, fallback, contract }) => ({ id, name, description, route, fallback, contract }));
}
function routeProvider(route) {
  const normalized = normalizeRoute(route);
  if (!normalized) return null;
  const backend = availableRoute(normalized.model);
  if (backend) return backend.provider || backend.backend;
  return normalized.model.startsWith("codex-") || normalized.model.startsWith("model-gateway:") ? "codex" : null;
}
function routeReadyForAutomaticFallback(route) {
  const provider = routeProvider(route);
  return !provider || provider === "claude" || providerReadiness(provider)?.ready === true;
}
function resolveCategoryRoute(category) {
  const warnings = [];
  const primary = normalizeRoute(category && category.route);
  if (!primary) return { model: null, effort: null, exec: null, warnings: ["Category route is missing or invalid."] };
  const provider = routeProvider(primary);
  const candidates = [
    { source: "route", route: primary },
    { source: "category fallback", route: category && category.fallback },
    { source: "global fallback", route: getRoutingFallback() }
  ];
  for (const candidate of candidates) {
    const route = normalizeRoute(candidate.route);
    if (!route) continue;
    if (candidate.source !== "route" && routeProvider(route) !== provider) {
      warnings.push(`Category "${category.id}" ${candidate.source} route "${route.model}" crosses providers and was refused.`);
      continue;
    }
    const exec = resolveExec(route.model, route.effort);
    if (exec && routeReadyForAutomaticFallback(route)) {
      return {
        model: exec.runsModel,
        effort: route.effort,
        exec,
        warnings,
        ...candidate.source === "route" ? {} : { fallbackReason: `${candidate.source} replaced unavailable ${primary.model}.` }
      };
    }
    warnings.push(`Category "${category.id}" ${candidate.source} model "${route.model}" isn't currently available.`);
  }
  return { model: primary.model, effort: primary.effort, exec: null, warnings };
}
function resolveCategoryFallback(category, failedModel) {
  const failedRoute = normalizeRoute({ model: failedModel, effort: "low" });
  const provider = routeProvider(failedRoute);
  const candidates = [
    { source: "category fallback", route: category && category.fallback },
    { source: "global fallback", route: getRoutingFallback() }
  ];
  for (const candidate of candidates) {
    const route = normalizeRoute(candidate.route);
    if (!route || candidate.source === "global fallback" && routeProvider(route) !== provider) continue;
    const exec = resolveExec(route.model, route.effort);
    if (!exec || !routeReadyForAutomaticFallback(route) || exec.runsModel === failedModel) continue;
    return { model: exec.runsModel, effort: route.effort, exec, source: candidate.source };
  }
  return null;
}
function providerDispatchRefusal(route) {
  const provider = routeProvider(route);
  if (!provider || provider === "claude") return null;
  const readiness = providerReadiness(provider);
  const name = provider === "codex" ? "Codex" : provider;
  if (!readiness) {
    return provider === "codex" ? 'Codex dispatch refused: model-gateway readiness is unavailable. Run `node "<gateway>/bin/model-gateway.js" ensure`, then retry. No Anthropic fallback was used.' : `${name} dispatch refused: model-gateway readiness for provider ${provider} is unavailable. Run \`node "<gateway>/bin/model-gateway.js" ensure\`, then retry. No Anthropic fallback was used.`;
  }
  if (!readiness.ready) {
    return provider === "codex" ? readiness.message : `${name} dispatch refused: ${readiness.message} Run \`node "<gateway>/bin/model-gateway.js" ensure\`, then retry. No Anthropic fallback was used.`;
  }
  if (!resolveExec(route.model, route.effort)) {
    return `${name} dispatch refused: configured route ${route.model} is not available from the live model-gateway catalog. Run \`node "<gateway>/bin/model-gateway.js" ensure\`, then retry. No Anthropic fallback was used.`;
  }
  return null;
}
function dispatchRouteRefusal(route) {
  const normalized = normalizeRoute(route);
  if (!normalized) return "Dispatch refused: the resolved route is missing or invalid.";
  return providerDispatchRefusal(normalized);
}
function ticketCategory(ticket) {
  if (!ticket || ticket.category == null) return null;
  return typeof ticket.category === "object" ? ticket.categoryId || ticket.category.id : String(ticket.category);
}
function execProjection(exec) {
  return exec ? { agent: exec.agent, model: exec.model, backend: exec.backend, runsModel: exec.runsModel, apiModel: exec.apiModel, runsLabel: exec.runsLabel, dispatch: exec.dispatch } : null;
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
      category = getCategory("general", { project });
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
const STORY_PALETTE = ["#c2683f", "#3f8f8a", "#7a5ba8", "#7d8a3f", "#b45573", "#4a72a8", "#c19a3e", "#4f8f6a"];
const STORY_COLOR_NAMES = {
  terracotta: "#c2683f",
  teal: "#3f8f8a",
  violet: "#7a5ba8",
  olive: "#7d8a3f",
  rose: "#b45573",
  steel: "#4a72a8",
  amber: "#c19a3e",
  green: "#4f8f6a"
};
function parseStoryColor(input) {
  if (input == null) return null;
  const s = String(input).trim().toLowerCase();
  if (!s) return null;
  if (STORY_COLOR_NAMES[s]) return STORY_COLOR_NAMES[s];
  if (/^#?[0-9a-f]{6}$/.test(s)) return "#" + s.replace(/^#/, "");
  if (/^#?[0-9a-f]{3}$/.test(s)) {
    const h = s.replace(/^#/, "");
    return "#" + h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  }
  return null;
}
function autoStoryColor(index) {
  const n = STORY_PALETTE.length;
  return STORY_PALETTE[((index || 0) % n + n) % n];
}
function defaultProjectName(absPath) {
  return path.basename(path.resolve(absPath)) || "project";
}
function normalizeAlwaysInScope(paths) {
  if (!Array.isArray(paths)) throw new Error("alwaysInScope must be an array of repo-relative paths.");
  const seen = /* @__PURE__ */ new Set();
  const normalized = [];
  for (const value of paths) {
    const item = String(value || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
    const relative = item.replace(/\/+$/, "");
    if (!relative || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) {
      throw new Error(`alwaysInScope path must stay inside the board repo: ${value}`);
    }
    const key = process.platform === "win32" ? relative.toLowerCase() : relative;
    if (!seen.has(key)) {
      seen.add(key);
      normalized.push(item);
    }
  }
  return normalized;
}
function normalizeReadOnlyDeniedTools(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error("readOnlyDeniedTools must be an array of tool patterns.");
  const seen = /* @__PURE__ */ new Set();
  const normalized = [];
  for (const entry of value) {
    const pattern = String(entry || "").trim();
    if (!pattern) throw new Error("readOnlyDeniedTools entries must be non-empty tool patterns.");
    if (!pattern.startsWith("mcp__")) throw new Error(`readOnlyDeniedTools patterns must target MCP tools: ${entry}`);
    if (!seen.has(pattern)) {
      seen.add(pattern);
      normalized.push(pattern);
    }
  }
  return normalized;
}
function normalizeGeneratedPairPath(value, name) {
  const item = String(value || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!item || item === ".." || item.startsWith("../") || path.isAbsolute(item) || item.includes("/../")) {
    throw new Error(`generatedPairs ${name} pattern must stay inside the board repo: ${value}`);
  }
  return item;
}
function normalizeGeneratedPairs(pairs) {
  if (pairs == null) return [];
  if (!Array.isArray(pairs)) throw new Error("generatedPairs must be an array of { from, to } patterns.");
  const seen = /* @__PURE__ */ new Set();
  const normalized = [];
  for (const pair of pairs) {
    if (!pair || typeof pair !== "object" || Array.isArray(pair)) {
      throw new Error("generatedPairs entries must be { from, to } patterns.");
    }
    const from = normalizeGeneratedPairPath(pair.from, "from");
    const to = normalizeGeneratedPairPath(pair.to, "to");
    if ((from.match(/\*/g) || []).length !== (to.match(/\*/g) || []).length) {
      throw new Error(`generatedPairs patterns must use the same number of * placeholders: ${from} -> ${to}`);
    }
    const key = `${from}\0${to}`;
    if (!seen.has(key)) {
      seen.add(key);
      normalized.push({ from, to });
    }
  }
  return normalized;
}
function generatedPathFor(source, pair) {
  const sourcePath = String(source || "").replace(/\\/g, "/");
  if (!sourcePath || sourcePath.includes("*")) return null;
  const parts = String(pair.from).split("*");
  const expression = new RegExp(`^${parts.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("(.+)")}$`);
  const match = sourcePath.match(expression);
  if (!match) return null;
  return String(pair.to).split("*").map((part, index) => `${part}${index < match.length - 1 ? match[index + 1] : ""}`).join("");
}
function trackedGeneratedPaths(config, files) {
  if (!config || !config.path || !Array.isArray(config.generatedPairs) || !config.generatedPairs.length || !Array.isArray(files)) return [];
  const candidates = Array.from(new Set(files.flatMap((file) => config.generatedPairs.map((pair) => generatedPathFor(file, pair)).filter(Boolean))));
  if (!candidates.length) return [];
  try {
    const tracked = execFileSync("git", ["ls-files", "-z", "--", ...candidates], {
      cwd: config.path,
      encoding: "utf8",
      windowsHide: true,
      stdio: "pipe"
    }).split("\0").filter(Boolean);
    const candidateKeys = new Set(candidates.map((candidate) => process.platform === "win32" ? candidate.toLowerCase() : candidate));
    return tracked.filter((trackedPath) => candidateKeys.has(process.platform === "win32" ? trackedPath.toLowerCase() : trackedPath));
  } catch (_) {
    return [];
  }
}
function defaultAlwaysInScope(absPath) {
  try {
    return fs.statSync(path.join(absPath, "docs")).isDirectory() ? ["docs/"] : [];
  } catch (_) {
    return [];
  }
}
function normalizeDeliveryMode(mode) {
  const value = String(mode || "merge").trim().toLowerCase();
  if (!DELIVERY_MODES.includes(value)) {
    throw new Error('delivery must be "merge", "replay", or "apply".');
  }
  return value;
}
function normalizeIntegrationMode(mode) {
  const value = String(mode || "auto").trim().toLowerCase();
  if (!["auto", "local", "remote"].includes(value)) {
    throw new Error('integrationMode must be "auto", "local", or "remote".');
  }
  return value;
}
function normalizeIntegrationBranch(value) {
  const branch = String(value == null ? "main" : value).trim();
  if (!branch || branch === "@" || branch.startsWith("/") || branch.endsWith("/") || branch.endsWith(".") || branch.includes("//") || branch.includes("/.") || branch.endsWith(".lock") || branch.includes("..") || branch.includes("@{") || /[\s~^:?*\[\\]/.test(branch)) {
    throw new Error("integrationBranch must be a valid Git branch name.");
  }
  return branch;
}
function normalizeWorktreeIsolation(value) {
  if (value == null) return true;
  if (typeof value !== "boolean") throw new Error("worktreeIsolation must be a boolean.");
  return value;
}
function normalizeAutoApprovePluginTests(value) {
  if (value == null) return true;
  if (typeof value !== "boolean") throw new Error("autoApprovePluginTests must be a boolean.");
  return value;
}
function normalizeWorktreeSetup(value) {
  if (value == null || String(value).trim() === "") return null;
  const setup = String(value);
  if (/[\r\n]/.test(setup)) throw new Error("worktreeSetup must be a one-line command.");
  if (setup.length > WORKTREE_SETUP_MAX_LENGTH) {
    throw new Error(`worktreeSetup exceeds the ${WORKTREE_SETUP_MAX_LENGTH}-character board-config limit.`);
  }
  return setup;
}
function normalizeIntegrationVerifyTimeoutMs(value) {
  if (value == null || value === "") return DEFAULT_INTEGRATION_VERIFY_TIMEOUT_MS;
  const timeoutMs = Number(value);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_INTEGRATION_VERIFY_TIMEOUT_MS) {
    throw new Error(`integrationVerifyTimeoutMs must be an integer from 1 to ${MAX_INTEGRATION_VERIFY_TIMEOUT_MS}.`);
  }
  return timeoutMs;
}
function hasOriginRemote(absPath) {
  try {
    execFileSync("git", ["remote", "get-url", "origin"], { cwd: absPath, encoding: "utf8", windowsHide: true, stdio: "pipe" });
    return true;
  } catch (_) {
    return false;
  }
}
function integrationBranchExists(absPath, ref) {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
      cwd: absPath,
      encoding: "utf8",
      windowsHide: true,
      stdio: "pipe"
    });
    return true;
  } catch (_) {
    return false;
  }
}
function integrationTarget(slug, override) {
  const meta = readMeta(slug);
  if (!meta) return null;
  const requested = override && typeof override === "object" ? override : {};
  const configured = normalizeIntegrationMode(requested.mode ?? meta.integrationMode);
  const mode = configured === "auto" ? hasOriginRemote(meta.path) ? "remote" : "local" : configured;
  const branch = normalizeIntegrationBranch(requested.branch ?? override ?? meta.integrationBranch);
  const upstream = mode === "local" ? branch : `origin/${branch}`;
  const ref = mode === "local" ? `refs/heads/${branch}` : `refs/remotes/origin/${branch}`;
  if (!integrationBranchExists(meta.path, ref)) {
    throw new Error(`Configured integration ref "${ref}" for branch "${branch}" does not exist. Create or fetch it, or set integrationBranch with board-config --integration-branch <branch>.`);
  }
  return { mode, upstream, branch };
}
function integrationTargetCommit(absPath, target) {
  return execFileSync("git", ["rev-parse", "--verify", `${target.upstream}^{commit}`], {
    cwd: absPath,
    encoding: "utf8",
    windowsHide: true,
    stdio: "pipe"
  }).trim();
}
function normalizeBoardName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) throw new Error("Board name cannot be empty.");
  return name;
}
function boardConfig(slug) {
  const meta = readMeta(slug);
  if (!meta) return null;
  const selected = projectRoutingProfile(slug);
  if (!selected) throw new Error(`Project "${slug}" does not have a routing profile.`);
  const layer = getProjectCategories(slug);
  const byKind = Object.fromEntries(["ADD", "OVERRIDE", "DETACH", "DISABLE"].map((kind) => [kind, layer.rows.filter((row) => row.kind === kind).length]));
  return {
    name: meta.name,
    alwaysInScope: Array.isArray(meta.alwaysInScope) ? normalizeAlwaysInScope(meta.alwaysInScope) : defaultAlwaysInScope(meta.path),
    readOnlyDeniedTools: normalizeReadOnlyDeniedTools(meta.readOnlyDeniedTools),
    generatedPairs: normalizeGeneratedPairs(meta.generatedPairs),
    integrationMode: normalizeIntegrationMode(meta.integrationMode),
    integrationBranch: normalizeIntegrationBranch(meta.integrationBranch),
    delivery: normalizeDeliveryMode(meta.delivery),
    integrationVerifyTimeoutMs: normalizeIntegrationVerifyTimeoutMs(meta.integrationVerifyTimeoutMs),
    worktreeIsolation: normalizeWorktreeIsolation(meta.worktreeIsolation),
    autoApprovePluginTests: normalizeAutoApprovePluginTests(meta.autoApprovePluginTests),
    worktreeSetup: normalizeWorktreeSetup(meta.worktreeSetup),
    profile: {
      id: selected.profile.id,
      name: selected.profile.name,
      revision: selected.profile.revision,
      entryCount: routingProfileEntries(selected.profile.id).length
    },
    overrides: {
      count: layer.rows.length,
      byKind,
      foreignBaseCount: layer.rows.filter((row) => row.baseProfileId && row.baseProfileId !== selected.profile.id).length,
      items: layer.rows
    },
    warnings: [...selected.warnings, ...layer.warnings]
  };
}
function setBoardConfig(slug, patch) {
  return withMetaLock(slug, () => {
    const meta = readMeta(slug);
    if (!meta) return { ok: false, reason: "not_found" };
    if (!patch || typeof patch !== "object") return { ok: true, config: boardConfig(slug) };
    if (Object.prototype.hasOwnProperty.call(patch, "name")) {
      meta.name = normalizeBoardName(patch.name);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "alwaysInScope")) {
      meta.alwaysInScope = normalizeAlwaysInScope(patch.alwaysInScope);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "readOnlyDeniedTools")) {
      meta.readOnlyDeniedTools = normalizeReadOnlyDeniedTools(patch.readOnlyDeniedTools);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "generatedPairs")) {
      meta.generatedPairs = normalizeGeneratedPairs(patch.generatedPairs);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "integrationMode")) {
      meta.integrationMode = normalizeIntegrationMode(patch.integrationMode);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "integrationBranch")) {
      meta.integrationBranch = normalizeIntegrationBranch(patch.integrationBranch);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "delivery")) {
      meta.delivery = normalizeDeliveryMode(patch.delivery);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "integrationVerifyTimeoutMs")) {
      meta.integrationVerifyTimeoutMs = normalizeIntegrationVerifyTimeoutMs(patch.integrationVerifyTimeoutMs);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "worktreeIsolation")) {
      meta.worktreeIsolation = normalizeWorktreeIsolation(patch.worktreeIsolation);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "autoApprovePluginTests")) {
      meta.autoApprovePluginTests = normalizeAutoApprovePluginTests(patch.autoApprovePluginTests);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "worktreeSetup")) {
      meta.worktreeSetup = normalizeWorktreeSetup(patch.worktreeSetup);
    }
    putProject(slug, meta);
    return { ok: true, config: boardConfig(slug) };
  });
}
function effectiveScope(slug, files) {
  const config = boardConfig(slug);
  const paired = trackedGeneratedPaths(Object.assign({ path: readMeta(slug)?.path }, config), files);
  return Array.from(/* @__PURE__ */ new Set([...Array.isArray(files) ? files : [], ...config && config.alwaysInScope || [], ...paired]));
}
function ensureProject(absPath, name) {
  const resolved = path.resolve(absPath);
  const slug = slugify(resolved);
  const dir = projectDir(slug);
  ensureDir(ticketsDir(slug));
  let meta;
  let changed = false;
  transaction(() => {
    const handle = database();
    meta = db.getRow(handle, "projects", slug);
    if (!meta || typeof meta !== "object") {
      meta = {
        path: resolved,
        name: name || defaultProjectName(resolved),
        createdAt: (/* @__PURE__ */ new Date()).toISOString(),
        seq: 0,
        storySeq: 0,
        alwaysInScope: defaultAlwaysInScope(resolved),
        worktreeIsolation: true
      };
      db.putRow(handle, "projects", { slug, data: meta });
      changed = true;
    } else {
      if (meta.path !== resolved) {
        meta.path = resolved;
        changed = true;
      }
      if (name && meta.name !== name) {
        meta.name = name;
        changed = true;
      }
      if (!meta.name) {
        meta.name = defaultProjectName(resolved);
        changed = true;
      }
      if (typeof meta.seq !== "number") {
        meta.seq = 0;
        changed = true;
      }
      if (typeof meta.storySeq !== "number") {
        meta.storySeq = 0;
        changed = true;
      }
      if (changed) db.putRow(handle, "projects", { slug, data: meta });
    }
    const pointer = handle.prepare("SELECT project FROM project_routing_profiles WHERE project = ?").get(slug);
    if (!pointer) {
      const settings = handle.prepare("SELECT new_project_profile_id FROM routing_profile_settings WHERE singleton = 1").get();
      if (!settings?.new_project_profile_id) throw new Error("The new-board routing profile is not configured.");
      db.putRow(handle, "project_routing_profiles", {
        project: slug,
        profile_id: settings.new_project_profile_id,
        assigned_at: (/* @__PURE__ */ new Date()).toISOString(),
        assigned_by: "ensure-project"
      });
      changed = true;
    }
  });
  if (changed) invalidateStoreCaches();
  return { slug, dir, meta };
}
function readMeta(slug) {
  const key = String(slug || "");
  const cache = residentCache();
  if (cache.metadata.has(key)) return cloneCached(cache.metadata.get(key));
  const meta = db.getRow(database(), "projects", key);
  cache.metadata.set(key, meta);
  return cloneCached(meta);
}
function metaLockPath(slug) {
  return path.join(projectDir(slug), ".meta.lock");
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
function nextSeq(slug) {
  return withMetaLock(slug, () => {
    const meta = readMeta(slug) || { seq: 0 };
    meta.seq = (typeof meta.seq === "number" ? meta.seq : 0) + 1;
    putProject(slug, meta);
    return meta.seq;
  });
}
function nextStorySeq(slug) {
  return withMetaLock(slug, () => {
    const meta = readMeta(slug) || { storySeq: 0 };
    meta.storySeq = (typeof meta.storySeq === "number" ? meta.storySeq : 0) + 1;
    putProject(slug, meta);
    return meta.storySeq;
  });
}
function setProjectNotify(slug, on) {
  return withMetaLock(slug, () => {
    const meta = readMeta(slug);
    if (!meta) return { ok: false, reason: "not_found" };
    meta.notify = on !== false;
    putProject(slug, meta);
    return { ok: true, notify: meta.notify };
  });
}
function setProjectRouting(slug, routing) {
  if (!["enabled", "disabled"].includes(routing)) throw new Error("Routing must be enabled or disabled.");
  return withMetaLock(slug, () => {
    const meta = readMeta(slug);
    if (!meta) return { ok: false, reason: "not_found" };
    meta.routing = routing;
    putProject(slug, meta);
    return { ok: true, routing: meta.routing };
  });
}
function projectRoutingEnabled(slug) {
  const meta = readMeta(slug);
  return !meta || meta.routing !== "disabled";
}
function archiveProject(slug) {
  return withMetaLock(slug, () => {
    const meta = readMeta(slug);
    if (!meta) return { ok: false, reason: "not_found" };
    if (meta.archivedAt) return { ok: true, slug, archivedAt: meta.archivedAt, alreadyArchived: true };
    meta.archivedAt = (/* @__PURE__ */ new Date()).toISOString();
    putProject(slug, meta);
    return { ok: true, slug, archivedAt: meta.archivedAt, alreadyArchived: false };
  });
}
function unarchiveProject(slug) {
  return withMetaLock(slug, () => {
    const meta = readMeta(slug);
    if (!meta) return { ok: false, reason: "not_found" };
    if (!meta.archivedAt) return { ok: true, slug, wasArchived: false };
    delete meta.archivedAt;
    putProject(slug, meta);
    return { ok: true, slug, wasArchived: true };
  });
}
function deleteProjectExact(slug) {
  if (typeof slug !== "string" || !/^[a-z0-9][a-z0-9-]{1,80}$/.test(slug)) return { ok: false, reason: "not_found" };
  if (!readMeta(slug)) return { ok: false, reason: "not_found" };
  transaction(() => {
    for (const ticket of db.listRows(database(), "tickets", { project: slug })) deleteCachedRow(database(), "tickets", ticket.id);
    for (const story of db.listRows(database(), "stories", { project: slug })) deleteCachedRow(database(), "stories", story.id);
    deleteCachedRow(database(), "projects", slug);
  });
  fs.rmSync(projectDir(slug), { recursive: true, force: true });
  return { ok: true, slug };
}
function listProjects(opts) {
  opts = opts || {};
  const cache = residentCache();
  const cacheKey = `projects:${opts.all ? "all" : opts.archived ? "archived" : "active"}`;
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
  const out = [];
  for (const row of rows) {
    let meta;
    try {
      meta = JSON.parse(row.data);
    } catch (_) {
      continue;
    }
    if (!meta || !meta.path) continue;
    const archivedAt = meta.archivedAt || null;
    if (!opts.all && (opts.archived ? !archivedAt : !!archivedAt)) continue;
    const counts = { todo: Number(row.todo) || 0, doing: Number(row.doing) || 0, done: Number(row.done) || 0 };
    out.push({
      slug: slugify(meta.path),
      name: meta.name || row.slug,
      path: meta.path || "",
      counts,
      total: Number(row.active) || 0,
      archived: Number(row.archived) || 0,
      open: counts.todo + counts.doing,
      lastActivity: row.last_activity || meta.createdAt || null,
      notify: meta.notify !== false,
      routing: meta.routing === "disabled" ? "disabled" : "enabled",
      stories: Number(row.stories) || 0,
      archivedAt
    });
  }
  out.sort((a, b) => String(b.lastActivity || "").localeCompare(String(a.lastActivity || "")));
  cache.snapshots.set(cacheKey, out);
  return cloneCached(out);
}
function findProject(ref) {
  const arg = String(ref == null ? "" : ref).trim();
  if (!arg) return { ok: false, reason: "not_found", known: listProjects({ all: true }).map((project) => project.name) };
  if (path.isAbsolute(arg)) {
    const resolvedPath = path.resolve(arg);
    const slug = slugify(resolvedPath);
    const meta = readMeta(slug);
    if (meta && normalizeForHash(meta.path) === normalizeForHash(resolvedPath)) return { ok: true, slug, meta };
  } else {
    const meta = readMeta(arg);
    if (meta) return { ok: true, slug: arg, meta };
  }
  const projects = db.selectRows(database(), "SELECT slug, data FROM projects ORDER BY slug").map((row) => {
    try {
      return { slug: row.slug, meta: JSON.parse(row.data) };
    } catch (_) {
      return null;
    }
  }).filter(Boolean);
  const wantedName = arg.toLowerCase();
  const byName = projects.filter((project) => String(project.meta.name || project.slug).trim().toLowerCase() === wantedName);
  if (byName.length === 1) return { ok: true, slug: byName[0].slug, meta: byName[0].meta };
  if (byName.length > 1) {
    return {
      ok: false,
      reason: "ambiguous",
      matches: byName.map((project) => ({ slug: project.slug, name: project.meta.name || project.slug, path: project.meta.path || "" }))
    };
  }
  if (!path.isAbsolute(arg)) {
    const wantedPath = normalizeForHash(path.resolve(arg));
    const byPath = projects.find((project) => project.meta.path && normalizeForHash(path.resolve(project.meta.path)) === wantedPath);
    if (byPath) return { ok: true, slug: byPath.slug, meta: byPath.meta };
  }
  return { ok: false, reason: "not_found", known: projects.map((project) => project.meta.name || project.slug) };
}
function mergeProject(srcSlug, destSlug, opts) {
  opts = opts || {};
  const dryRun = !!opts.dryRun;
  if (srcSlug === destSlug) throw new Error("source and destination are the same board");
  if (!readMeta(srcSlug)) throw new Error(`source board "${srcSlug}" does not exist`);
  if (!readMeta(destSlug)) throw new Error(`destination board "${destSlug}" does not exist`);
  const tickets = listTickets(srcSlug).slice().sort((a, b) => seqOfRef(a.ref) - seqOfRef(b.ref));
  const stories = listStories(srcSlug);
  const refMap = {};
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
  transaction(() => {
    for (const ticket of tickets) deleteCachedRow(database(), "tickets", ticket.id);
    for (const story of stories) deleteCachedRow(database(), "stories", story.id);
    for (const { story, newRef } of storyPlan) {
      const moved = Object.assign({}, story, { ref: newRef });
      putStory(destSlug, moved);
    }
    for (const { ticket, newRef } of ticketPlan) {
      const links = Array.isArray(ticket.links) ? ticket.links.map((l) => Object.assign({}, l, { ref: refMap[String(l.ref).toUpperCase()] || l.ref })) : [];
      const moved = Object.assign({}, ticket, { ref: newRef, links });
      putTicket(destSlug, moved);
      const srcAssets = assetsDir(srcSlug, ticket.id);
      if (fs.existsSync(srcAssets)) {
        try {
          fs.cpSync(srcAssets, assetsDir(destSlug, ticket.id), { recursive: true });
        } catch (_) {
        }
      }
    }
    deleteCachedRow(database(), "projects", srcSlug);
  });
  try {
    fs.rmSync(projectDir(srcSlug), { recursive: true, force: true });
  } catch (_) {
  }
  return { tickets: ticketPlan.length, stories: storyPlan.length, mapping };
}
function seqOfRef(ref) {
  const m = /(\d+)\s*$/.exec(String(ref || ""));
  return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
}
const PLAN_ASSET_NAME = "plan.md";
const PLAN_BODY_MAX_BYTES = 256 * 1024;
function planAssetPath(slug, ticket) {
  return assetPath(slug, ticket.id, PLAN_ASSET_NAME);
}
function writeTicketPlan(slug, idOrRef, by, body) {
  const text = stripControlChars(String(body == null ? "" : body)).trim();
  if (!text) return { ok: false, reason: "empty" };
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > PLAN_BODY_MAX_BYTES) {
    return { ok: false, reason: "too_long", max: PLAN_BODY_MAX_BYTES, length: bytes };
  }
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: "not_found" };
  return withTicketLock(slug, found.id, () => {
    const ticket = getTicket(slug, found.id);
    if (!ticket) return { ok: false, reason: "not_found" };
    fs.mkdirSync(assetsDir(slug, ticket.id), { recursive: true });
    fs.writeFileSync(planAssetPath(slug, ticket), text);
    if (!Array.isArray(ticket.assets)) ticket.assets = [];
    if (!ticket.assets.includes(PLAN_ASSET_NAME)) ticket.assets.push(PLAN_ASSET_NAME);
    const revision = (Number(ticket.plan && ticket.plan.revision) || 0) + 1;
    const at = (/* @__PURE__ */ new Date()).toISOString();
    ticket.plan = { revision, by: String(by || "agent"), at };
    ticket.updatedAt = at;
    putTicket(slug, ticket);
    return { ok: true, ticket, plan: ticket.plan, path: planAssetPath(slug, ticket) };
  });
}
function ticketPlanInfo(slug, idOrRef) {
  const ticket = getTicket(slug, idOrRef);
  if (!ticket || !ticket.plan || !ticket.plan.revision) return null;
  const file = planAssetPath(slug, ticket);
  if (!fs.existsSync(file)) return null;
  return { path: file, revision: ticket.plan.revision, by: ticket.plan.by, at: ticket.plan.at };
}
function experimentAssetName(ticket) {
  return `experiment-${String(ticket?.ref || ticket?.id || "ticket").replace(/[^a-z0-9_-]/gi, "_")}.md`;
}
function experimentLogTemplate(ticket) {
  return `# Experiment log — ${ticket.ref}

## Ruled out

## Standing constraints
`;
}
function experimentLine(value, label) {
  const line = String(value == null ? "" : value).replace(/[\r\n]+/g, " ").trim();
  if (!line) throw new Error(`${label || "Experiment value"} is required.`);
  return line;
}
function experimentText(value) {
  return String(value == null ? "" : value).trim();
}
function experimentRound(value) {
  const round = Number(value);
  if (!Number.isInteger(round) || round < 1) throw new Error("Experiment round must be a positive integer.");
  return round;
}
function experimentLogForTicket(slug, ticket) {
  const asset = experimentAssetName(ticket);
  const file = assetPath(slug, ticket.id, asset);
  return { asset, file };
}
function writeExperimentLog(slug, ticket, log) {
  const { asset, file } = experimentLogForTicket(slug, ticket);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, log);
  if (!Array.isArray(ticket.assets)) ticket.assets = [];
  if (!ticket.assets.includes(asset)) ticket.assets.push(asset);
  ticket.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
  putTicket(slug, ticket);
  return { asset, file };
}
function readExperimentLog(slug, ticket) {
  const { asset, file } = experimentLogForTicket(slug, ticket);
  if (!fs.existsSync(file)) return null;
  return { asset, file, log: fs.readFileSync(file, "utf8") };
}
function experimentSections(log) {
  const source = String(log || "");
  const ruledOut = source.match(/^## Ruled out\r?\n([\s\S]*?)(?=^## Standing constraints\r?$)/m);
  const constraints = source.match(/^## Standing constraints\r?\n([\s\S]*?)(?=^## R\d+\b|\s*$)/m);
  if (!ruledOut || !constraints) throw new Error("Experiment log is missing its pinned sections.");
  return { ruledOut: (ruledOut[1] || "").trim(), constraints: (constraints[1] || "").trim() };
}
function experimentEntries(log) {
  const source = String(log || "");
  const matches = [...source.matchAll(/^## R(\d+) — ([^\r\n]+)\r?$/gm)];
  return matches.map((match, index) => {
    const start = match.index ?? source.length;
    const end = matches[index + 1]?.index ?? source.length;
    return {
      round: Number(match[1]),
      headline: `R${match[1]} — ${match[2]}`,
      start,
      end,
      block: source.slice(start, end).trim()
    };
  });
}
function withExperimentLog(slug, idOrRef, change) {
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: "not_found" };
  return withTicketLock(slug, found.id, () => {
    const ticket = getTicket(slug, found.id);
    if (!ticket) return { ok: false, reason: "not_found" };
    const existing = readExperimentLog(slug, ticket);
    const log = existing ? existing.log : experimentLogTemplate(ticket);
    const result = change(ticket, log);
    if (!result || typeof result.log !== "string") return result;
    const location = writeExperimentLog(slug, ticket, result.log);
    return Object.assign({ ok: true }, location, result.result || {});
  });
}
function experimentLines(value, map) {
  if (value == null) return [];
  const entries = Array.isArray(value) ? value : [value];
  return entries.map(map).filter(Boolean);
}
function appendExperimentEntry(slug, idOrRef, entry) {
  entry = entry || {};
  const round = experimentRound(entry.round);
  const headline = experimentLine(entry.headline || entry.title, "Experiment headline");
  const date = experimentLine(entry.date || (/* @__PURE__ */ new Date()).toISOString().slice(0, 10), "Experiment date");
  const hypothesis = experimentText(entry.hypothesis);
  const change = experimentText(entry.change);
  const commit = experimentText(entry.commit);
  const branch = experimentText(entry.branch);
  const measured = experimentText(entry.measured);
  const deliverable = experimentText(entry.deliverable);
  const verdict = experimentText(entry.verdict ?? entry.verdictText);
  const outcome = experimentText(entry.outcome);
  const whyItFailed = experimentText(entry.whyItFailed ?? entry.why);
  const constraintBought = experimentText(entry.constraintBought ?? entry.constraint);
  const status = experimentText(entry.status);
  return withExperimentLog(slug, idOrRef, (_ticket, log) => {
    if (experimentEntries(log).some((current) => current.round === round)) {
      return { ok: false, reason: "round_exists" };
    }
    const ruledOut = experimentLines(entry.ruledOut, (item) => {
      if (typeof item === "string") return `- ${experimentLine(item, "Ruled-out entry")}`;
      return `- ${experimentLine(item?.line ?? item?.value, "Ruled-out entry")} — ${experimentLine(item?.why, "Ruled-out reason")}`;
    });
    const constraints = experimentLines(entry.standingConstraints ?? entry.constraints, (item) => {
      if (typeof item === "string") return `- [R${round}] ${experimentLine(item, "Standing constraint")}`;
      const boughtBy = experimentRound(item?.round ?? item?.boughtBy ?? round);
      return `- [R${boughtBy}] ${experimentLine(item?.line ?? item?.value, "Standing constraint")}`;
    });
    let next = String(log);
    if (ruledOut.length) next = next.replace(/(^## Ruled out\r?\n)([\s\S]*?)(?=^## Standing constraints\r?$)/m, (_all, heading, body) => `${heading}${body.trimEnd()}${body.trim() ? "\n" : ""}${ruledOut.join("\n")}
`);
    if (constraints.length) next = next.replace(/(^## Standing constraints\r?\n)([\s\S]*?)(?=^## R\d+\b|\s*$)/m, (_all, heading, body) => `${heading}${body.trimEnd()}${body.trim() ? "\n" : ""}${constraints.join("\n")}

`);
    const block = [
      `## R${round} — ${date} — ${headline}`,
      `Hypothesis: ${hypothesis}`,
      `Change: ${change} (commit ${commit}, branch ${branch})`,
      `Measured: ${measured}`,
      `Deliverable: ${deliverable}`,
      `Verdict: "${verdict}" — ${outcome}`,
      `Why it failed: ${whyItFailed}`,
      `Constraint bought: ${constraintBought}`,
      `Status: ${status}`
    ].join("\n");
    return { log: `${next}

${block}
`, result: { round } };
  });
}
function verdictOutcome(value) {
  const outcome = String(value == null ? "" : value).trim().toLowerCase();
  if (!["accepted", "rejected", "inconclusive"].includes(outcome)) {
    throw new Error("Verdict outcome must be accepted, rejected, or inconclusive.");
  }
  return outcome;
}
function verdictStatus(outcome, candidate) {
  const suffix = nullableText(candidate) ? ` ${nullableText(candidate)}` : "";
  if (outcome === "accepted") return `accepted${suffix}`;
  if (outcome === "rejected") return `DO-NOT-MERGE${suffix}`;
  return `inconclusive${suffix}`;
}
function replaceExperimentEntryField(block, label, value, nextLabel) {
  const escaped = String(label).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const nextEscaped = String(nextLabel || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = nextLabel ? new RegExp(`^${escaped}:.*?(?=^${nextEscaped}:)`, "ms") : new RegExp(`^${escaped}:.*$`, "m");
  if (!pattern.test(String(block))) throw new Error(`Experiment round is missing its ${label} field.`);
  return String(block).replace(pattern, `${label}: ${value}${nextLabel ? "\n" : ""}`);
}
function appendStandingConstraint(log, round, constraint) {
  if (!constraint) return String(log);
  return String(log).replace(
    /(^## Standing constraints\r?\n)([\s\S]*?)(?=^## R\d+\b|\s*$)/m,
    (_all, heading, body) => `${heading}${body.trimEnd()}${body.trim() ? "\n" : ""}- [R${round}] ${constraint}

`
  );
}
function applyExperimentVerdict(slug, idOrRef, input) {
  const text = String(input?.text == null ? "" : input.text);
  if (!text.trim()) throw new Error("Verdict text is required and must preserve the user's words.");
  const outcome = verdictOutcome(input?.outcome);
  const why = experimentText(input?.why);
  const constraint = experimentText(input?.constraint);
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: "not_found" };
  return withTicketLock(slug, found.id, () => {
    const ticket = getTicket(slug, found.id);
    if (!ticket) return { ok: false, reason: "not_found" };
    const oracle = ticket.oracle;
    if (!oracle) {
      return {
        ok: false,
        reason: "no_oracle",
        message: `${ticket.ref} is not awaiting an oracle verdict. Release an active experiment round with --oracle before recording a verdict.`
      };
    }
    const existing = readExperimentLog(slug, ticket);
    if (!existing) {
      return {
        ok: false,
        reason: "round_not_found",
        message: `${ticket.ref} awaits an oracle verdict for round ${oracle.round}, but its experiment log has no round entry.`
      };
    }
    const entry = experimentEntries(existing.log).find((current) => current.round === oracle.round);
    if (!entry) {
      return {
        ok: false,
        reason: "round_not_found",
        message: `${ticket.ref} awaits an oracle verdict for round ${oracle.round}, but that round is missing from its experiment log.`
      };
    }
    let block = replaceExperimentEntryField(entry.block, "Verdict", `"${text}" — ${outcome}`, "Why it failed");
    block = replaceExperimentEntryField(block, "Why it failed", why, "Constraint bought");
    block = replaceExperimentEntryField(block, "Constraint bought", constraint, "Status");
    block = replaceExperimentEntryField(block, "Status", verdictStatus(outcome, oracle.candidate));
    let log = `${String(existing.log).slice(0, entry.start)}${block}
${String(existing.log).slice(entry.end).trimStart()}`;
    log = appendStandingConstraint(log, oracle.round, constraint);
    clearOracleMarker(ticket);
    const location = writeExperimentLog(slug, ticket, log);
    return Object.assign({ ok: true, round: oracle.round, outcome }, location);
  });
}
function appendOverturnLine(slug, idOrRef, priorRound, overturningRound, line) {
  const options = priorRound && typeof priorRound === "object" ? priorRound : null;
  const target = experimentRound(options ? options.priorRound ?? options.targetRound ?? options.round : priorRound);
  const overturning = experimentRound(options ? options.overturningRound ?? options.byRound ?? options.overturnedBy : overturningRound);
  const text = experimentLine(options ? options.line : line, "Overturn line");
  return withExperimentLog(slug, idOrRef, (_ticket, log) => {
    const entries = experimentEntries(log);
    const entry = entries.find((current) => current.round === target);
    if (!entry) return { ok: false, reason: "round_not_found" };
    if (/^> Overturned by R\d+:/m.test(entry.block)) return { ok: false, reason: "already_overturned" };
    const insertion = `
> Overturned by R${overturning}: ${text}`;
    return { log: `${String(log).slice(0, entry.end).trimEnd()}${insertion}
${String(log).slice(entry.end)}`, result: { priorRound: target, overturningRound: overturning } };
  });
}
function experimentPacket(slug, idOrRef) {
  const ticket = getTicket(slug, idOrRef);
  if (!ticket) return null;
  const existing = readExperimentLog(slug, ticket);
  if (!existing) return null;
  const sections = experimentSections(existing.log);
  const entries = experimentEntries(existing.log);
  const recent = entries.slice(-3);
  let older = entries.slice(0, -3);
  const build = () => [
    `Experiment log: ${existing.file}`,
    "## Ruled out",
    sections.ruledOut || "(none)",
    "## Standing constraints",
    sections.constraints || "(none)",
    ...older.length ? ["## Earlier rounds", ...older.map((entry) => `- ${entry.headline}`)] : [],
    ...recent.length ? ["## Recent rounds", ...recent.map((entry) => entry.block)] : []
  ].join("\n\n").replace(/\n\n- /g, "\n- ");
  let packet = build();
  while (Buffer.byteLength(packet, "utf8") > 12 * 1024 && older.length) {
    older = older.slice(1);
    packet = build();
  }
  if (Buffer.byteLength(packet, "utf8") > 12 * 1024) {
    packet = Buffer.from(packet, "utf8").subarray(0, 12 * 1024).toString("utf8").replace(/[^\n]*$/, "").trimEnd();
  }
  return { asset: existing.asset, path: existing.file, packet };
}
function parseTicketData(slug, data) {
  try {
    const ticket = typeof data === "string" ? JSON.parse(data) : data;
    return ticket && ticket.id ? applyDerivedRouting(ticket, { project: slug }) : null;
  } catch (_) {
    return null;
  }
}
function queryTickets(slug, opts = {}) {
  const statuses = opts.status == null ? [] : (Array.isArray(opts.status) ? opts.status : [opts.status]).map((status) => String(status).toLowerCase());
  const unfiltered = opts.archived == null && statuses.length === 0 && opts.limit == null && !opts.offset;
  const cache = residentCache();
  const cacheKey = `tickets:${slug}`;
  if (unfiltered) {
    const cached = cache.snapshots.get(cacheKey);
    if (cached) return cloneCached(cached);
  }
  const clauses = ["project = ?"];
  const parameters = [slug];
  if (opts.archived != null) {
    clauses.push("archived = ?");
    parameters.push(opts.archived ? 1 : 0);
  }
  if (statuses.length) {
    clauses.push(`status IN (${statuses.map(() => "?").join(", ")})`);
    parameters.push(...statuses);
  }
  let sql = `SELECT data FROM tickets WHERE ${clauses.join(" AND ")} ORDER BY ord DESC`;
  if (opts.limit != null) {
    sql += " LIMIT ? OFFSET ?";
    parameters.push(Math.max(0, Math.floor(Number(opts.limit)) || 0), Math.max(0, Math.floor(Number(opts.offset)) || 0));
  }
  const tickets = db.selectRows(database(), sql, parameters).map((row) => parseTicketData(slug, row.data)).filter(Boolean);
  if (unfiltered) cache.snapshots.set(cacheKey, tickets);
  return cloneCached(tickets);
}
function countTickets(slug, opts = {}) {
  const statuses = opts.status == null ? [] : (Array.isArray(opts.status) ? opts.status : [opts.status]).map((status) => String(status).toLowerCase());
  const clauses = ["project = ?"];
  const parameters = [slug];
  if (opts.archived != null) {
    clauses.push("archived = ?");
    parameters.push(opts.archived ? 1 : 0);
  }
  if (statuses.length) {
    clauses.push(`status IN (${statuses.map(() => "?").join(", ")})`);
    parameters.push(...statuses);
  }
  const row = db.selectRow(database(), `SELECT COUNT(*) AS count FROM tickets WHERE ${clauses.join(" AND ")}`, parameters);
  return Number(row && row.count) || 0;
}
function listTickets(slug) {
  return queryTickets(String(slug || ""));
}
function worktreeGcTickets() {
  return db.selectRows(database(), "SELECT project, data FROM tickets").map((row) => {
    const ticket = parseTicketData(row.project, row.data);
    return ticket ? Object.assign({}, ticket, {
      project: row.project,
      claimLive: Boolean(ticket.claim && ticket.claim.by && !claimReleaseVerdict(ticket))
    }) : null;
  }).filter(Boolean);
}
function worktreeGcProjects(currentSlug, limit = 3) {
  const projects = listProjects({ all: true }).filter((project) => project && project.slug && project.path);
  if (!projects.length || limit < 1) return [];
  const current = String(currentSlug || "");
  const focused = projects.find((project) => project.slug === current);
  const cursor = String(readGlobal("worktree-gc-project-cursor", "") || "");
  const start = Math.max(0, projects.findIndex((project) => project.slug === cursor) + 1) % projects.length;
  const ordered = Array.from({ length: projects.length }, (_, index) => projects[(start + index) % projects.length]);
  const selected = focused ? [focused, ...ordered.filter((project) => project.slug !== focused.slug)] : ordered;
  const result = selected.slice(0, Math.min(limit, projects.length));
  writeGlobal("worktree-gc-project-cursor", result[result.length - 1].slug);
  return result;
}
function listAllProjectTickets(archivedOnly = false) {
  const cache = residentCache();
  const cacheKey = `all-project-tickets:${archivedOnly ? "archived" : "active"}`;
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
  const tickets = rows.map((row) => {
    const ticket = parseTicketData(row.project, row.data);
    return ticket ? Object.assign({}, ticket, { project: row.project, projectName: row.project_name }) : null;
  }).filter(Boolean);
  cache.snapshots.set(cacheKey, tickets);
  return cloneCached(tickets);
}
function getTicket(slug, idOrRef) {
  const wanted = String(idOrRef);
  const row = db.selectRow(
    database(),
    "SELECT data FROM tickets WHERE project = ? AND (id = ? OR upper(ref) = upper(?)) LIMIT 1",
    [String(slug || ""), wanted, wanted]
  );
  return row ? parseTicketData(String(slug || ""), row.data) : null;
}
function coerceStatus(s, fallback) {
  s = String(s || "").toLowerCase();
  return VALID_STATUS.includes(s) ? s : fallback;
}
function requireStatus(s) {
  const status = String(s).toLowerCase();
  if (!VALID_STATUS.includes(status)) {
    throw new Error(`Invalid status "${s}". Valid statuses: ${VALID_STATUS.join(", ")}. Deletion is not a status; use the MCP remove tool or CLI rm.`);
  }
  return status;
}
function coercePriority(p, fallback) {
  p = String(p || "").toLowerCase();
  return VALID_PRIORITY.includes(p) ? p : fallback;
}
const EXECUTOR_ANCHORS_MAX = 4e3;
const EXECUTOR_VERIFY_MAX = 1e3;
const DISPATCH_DESCRIPTION_MIN = 80;
const DISPATCH_DESCRIPTION_GUIDANCE = "the executor's entire brief is this ticket; add a description (Where / Contract / Verify) and a verify command, then dispatch";
function executorText(value, max, label) {
  if (value == null) return "";
  const text = String(value);
  if (text.length > max) throw new Error(`${label} exceeds the ${max}-character executor-context limit.`);
  return text;
}
const MANUAL_VERIFY_PREFIX = "manual:";
const VERIFY_BUILTINS = /* @__PURE__ */ new Set([
  "bash",
  "bun",
  "cargo",
  "cd",
  "cmd",
  "composer",
  "dart",
  "deno",
  "dotnet",
  "elixir",
  "eslint",
  "flutter",
  "git",
  "go",
  "gradle",
  "java",
  "jest",
  "just",
  "make",
  "mix",
  "mvn",
  "node",
  "npm",
  "npx",
  "php",
  "pnpm",
  "poetry",
  "powershell",
  "pwsh",
  "py",
  "pytest",
  "python",
  "python3",
  "rake",
  "ruby",
  "sh",
  "tox",
  "tsc",
  "uv",
  "vitest",
  "yarn"
]);
function manualVerify(value) {
  return /^manual:\s+\S/i.test(String(value || "").trim());
}
function verifyCommandError(value) {
  const command = String(value || "").trim();
  if (!command || manualVerify(command)) return null;
  if (/^manual:/i.test(command)) {
    return "Manual verification must say what was checked: `manual: <what you checked>`. Otherwise provide a runnable command such as `cd <repo-relative-dir> && <command>`.";
  }
  const first = command.match(/^\s*(?:["']([^"']+)["']|([^\s;&|]+))/)?.[1] || command.match(/^\s*(?:["']([^"']+)["']|([^\s;&|]+))/)?.[2] || "";
  const likelyExecutable = VERIFY_BUILTINS.has(first.toLowerCase()) || /[\\/]|\.(?:bat|cmd|com|exe|ps1|sh)$/i.test(first);
  const proseStarter = /^(?:check|confirm|ensure|inspect|look|open|read|review|verify)\s/i.test(command);
  if (command.endsWith(".") || proseStarter || !likelyExecutable && /[.!?]/.test(command)) {
    return "Verify must be a runnable command such as `cd <repo-relative-dir> && <command>`. For manual verification, use `manual: <what you checked>` so it is recorded without shell execution.";
  }
  for (const match of command.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)|\$\{([A-Za-z_][A-Za-z0-9_]*)(?:\}|(?::[^}]*)\})/g)) {
    const name = match[1] || match[2];
    if (name && process.env[name] == null && !match[0].includes(":-")) {
      return `Verify references unset environment variable ${name}. Set a portable default such as \`${"${"}${name}:-/tmp}\`, or use \`manual: <what you checked>\`.`;
    }
  }
  for (const match of command.matchAll(/%([A-Za-z_][A-Za-z0-9_]*)%/g)) {
    const name = match[1];
    if (name != null && process.env[name] == null) {
      return `Verify references unset environment variable ${name}. Set a portable default or use \`manual: <what you checked>\`.`;
    }
  }
  return null;
}
function requireVerifyCommand(value) {
  const error = verifyCommandError(value);
  if (error) throw new Error(error);
}
function ticketReferenceWarnings(slug, title, description) {
  const refs = new Set((`${title || ""}
${description || ""}`.match(/\bSQ-\d+\b/gi) || []).map((ref) => ref.toUpperCase()));
  if (!refs.size) return [];
  const known = new Set(listTickets(slug).map((ticket) => String(ticket.ref).toUpperCase()));
  const unknown = [...refs].filter((ref) => !known.has(ref));
  return unknown.length ? [`Unknown ticket refs: ${unknown.join(", ")}.`] : [];
}
function ticketPrescribesFix(description) {
  const body = String(description || "");
  if (/^\s*fix\s*:/im.test(body)) return true;
  if (/\b(?:replace|change)\s+\S[\s\S]{0,160}?\s+(?:with|to)\s+\S/i.test(body)) return true;
  if (/```(?:diff|patch)?\s*\r?\n[\s\S]*?^-\S[\s\S]*?^\+\S[\s\S]*?```/im.test(body)) return true;
  return (body.match(/^\s*\d+[.)]\s+(?:add|change|replace|remove|rename|move|update|set|delete|edit|wire)\b/gim) || []).length >= 2;
}
function ticketCategoryWarnings(ticket) {
  if (ticketCategory(ticket) !== "coding.hard" || !ticketPrescribesFix(ticket && ticket.description)) return [];
  return ["coding.hard is for unknown approaches; this description already spells out the fix, which usually means coding.normal. Recheck the category."];
}
function readonlyCategoryWriteIntentWarning(ticket) {
  if (!categoryReadOnly(ticket)) return null;
  const writesFiles = normalizeFiles(ticket.files).length > 0;
  const writesContracts = (normalizeContracts(ticket.contracts).changes || []).length > 0;
  if (!writesFiles && !writesContracts) return null;
  return "Readonly category contradicts declared write intent (files or changes). Resolve the category or set an explicit readonly override before dispatch.";
}
function noDeclaredScopeWarning(ticket) {
  if (dispatchReadOnly(ticket)) return null;
  if (Array.isArray(ticket.files) && ticket.files.length) return null;
  if (Number(ticket?.complexity) >= 4) return null;
  return "Planning-depth warning: no file scope declared for a write-scope ticket. Scope will be inferred from wherever the executor first writes, which can silently cap the work below what the description describes. Declare files now, or expect a possible partial submission.";
}
const BROWSER_REVIEW_SIGNAL = /\b(?:browser|visual|screenshot|playwright|ui review|e2e)\b/i;
function readonlyBrowserReviewWarning(ticket) {
  if (!dispatchReadOnly(ticket)) return null;
  const signal = [ticket?.title, ticket?.description, ticketCategory(ticket)].join("\n");
  if (!BROWSER_REVIEW_SIGNAL.test(signal)) return null;
  return "Planning-depth warning: this readonly browser/visual ticket may need a driver script. Read-only executors cannot write one; grant write scope with an explicit no-repo-writes mandate, or use a browser tool that needs no script.";
}
function relativePathWithin(root, target) {
  const relative = path.relative(String(root), String(target));
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : relative === "" ? "." : null;
}
function packageRootForScope(projectPath, scope) {
  const absolute = path.resolve(String(projectPath), String(scope));
  let directory = path.dirname(absolute);
  for (; ; ) {
    if (!relativePathWithin(projectPath, directory)) return null;
    if (fs.existsSync(path.join(directory, "package.json"))) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}
function buildOutputDirectories(source) {
  const outputs = /* @__PURE__ */ new Map();
  const add = (directory, sourceDirectory) => {
    const value = String(directory || "").trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
    if (!value || value.includes("..") || path.isAbsolute(value)) return;
    const current = outputs.get(value);
    outputs.set(value, { directory: value, sourceDirectory: sourceDirectory || current?.sourceDirectory || null });
  };
  const text = String(source || "");
  for (const match of text.matchAll(/--(?:outdir|out-dir|output-dir)\s*(?:=|\s+)\s*["']?([^"'\s;&]+)/gi)) add(match[1]);
  for (const match of text.matchAll(/(?:outdir|outDir|outputDir)\s*:\s*["']([^"']+)["']/g)) add(match[1]);
  for (const helper of text.matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(\s*([A-Za-z_$][\w$]*)[^)]*\)\s*\{([\s\S]{0,2000}?)\n\}/g)) {
    const [helperName, parameter, body] = [helper[1], helper[2], helper[3]];
    if (!helperName || !parameter || !body || !new RegExp(`(?:outdir|outDir)\\s*:\\s*path\\.join\\([^)]*,\\s*${parameter}\\s*\\)`).test(body)) continue;
    const call = new RegExp(`\\b${helperName}\\s*\\(\\s*["']([^"']+)["']`, "g");
    for (const match of text.matchAll(call)) add(match[1], match[1]);
  }
  return [...outputs.values()];
}
function packageBuildOutputs(packageRoot) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(String(packageRoot), "package.json"), "utf8"));
  } catch (_) {
    return [];
  }
  const build = String(manifest?.scripts?.build || "");
  if (!build) return [];
  const outputs = buildOutputDirectories(build);
  for (const match of build.matchAll(/\bnode\s+(?:["']([^"']+)["']|([^\s;&]+))/g)) {
    const script = path.resolve(String(packageRoot), match[1] || match[2]);
    if (!relativePathWithin(packageRoot, script) || !fs.existsSync(script)) continue;
    try {
      outputs.push(...buildOutputDirectories(fs.readFileSync(script, "utf8")));
    } catch (_) {
    }
  }
  return [...new Map(outputs.map((output) => [output.directory, output])).values()];
}
function isTrackedBuildOutput(projectPath, output) {
  const relative = relativePathWithin(projectPath, output);
  if (!relative || relative === ".") return false;
  try {
    return Boolean(execFileSync("git", ["ls-files", "--", relative], {
      cwd: projectPath,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"]
    }).trim());
  } catch (_) {
    return false;
  }
}
function scopeIncludesPath(files, projectPath, target) {
  return normalizeFiles(files).some((file) => {
    const declared = path.resolve(String(projectPath), file);
    return declared === target || relativePathWithin(target, declared) !== null;
  });
}
function sourceBuildOutputWarnings(ticket, projectPath) {
  if (!projectPath || !Array.isArray(ticket?.files)) return [];
  const warnings = /* @__PURE__ */ new Set();
  for (const scope of normalizeFiles(ticket.files)) {
    const packageRoot = packageRootForScope(projectPath, scope);
    if (!packageRoot) continue;
    const sourceRelative = relativePathWithin(packageRoot, path.resolve(projectPath, scope))?.replace(/\\/g, "/");
    if (!sourceRelative || sourceRelative !== "src" && !sourceRelative.startsWith("src/")) continue;
    const sourceDirectory = sourceRelative.split("/")[1] || null;
    for (const output of packageBuildOutputs(packageRoot)) {
      if (output.sourceDirectory && sourceDirectory && output.sourceDirectory !== sourceDirectory) continue;
      const target = path.resolve(packageRoot, output.directory);
      if (!isTrackedBuildOutput(projectPath, target) || scopeIncludesPath(ticket.files, projectPath, target)) continue;
      const packageRelative = relativePathWithin(projectPath, packageRoot)?.replace(/\\/g, "/") || ".";
      const display = packageRelative === "." ? output.directory : `${packageRelative}/${output.directory}`;
      warnings.add(`Planning-depth warning: declared source scope under ${packageRelative}/src omits tracked build output ${display}. Include the generated output in this ticket; content-hashed output gets one rebuild ticket per wave.`);
    }
  }
  return [...warnings];
}
function verifyCommandWarning(ticket, projectPath) {
  const verify = String(ticket?.executorVerify || "").trim();
  if (!verify) return null;
  const match = /^cd\s+(?:["']([^"']+)["']|([^&;\s]+))\s*&&/.exec(verify);
  if (!match) return "Planning-depth warning: record verify commands as `cd <repo-relative-dir> && ...`, then run that exact string before submitting.";
  const directory = path.resolve(String(projectPath || ""), match[1] || match[2]);
  if (!projectPath || !relativePathWithin(projectPath, directory) || !fs.existsSync(directory)) {
    return "Planning-depth warning: the recorded verify command changes to a directory that does not exist in this repo. Run the exact string you record before submitting.";
  }
  return null;
}
function dispatchDescriptionError(ticket) {
  if (!ticket || !ticket.model || !ticket.effort) return null;
  if (String(ticket.description || "").trim().length >= DISPATCH_DESCRIPTION_MIN) return null;
  return `dispatch: ${DISPATCH_DESCRIPTION_GUIDANCE}.`;
}
function storyContractDriftWarnings(ticket) {
  const contractDrift = ticket && (ticket.storyContractDrift || dispatchState(ticket)?.storyContractDrift);
  if (!contractDrift) return [];
  return [`Dispatch warning: ${contractDrift.storyRef || "story"} execution contract changed from revision ${contractDrift.fromRevision} to ${contractDrift.toRevision} while this ticket was claimed; the next briefing uses revision ${contractDrift.toRevision}.`];
}
function claudeWebSearchUnavailable(ticket) {
  const model = normalizeRouteModel(ticket && ticket.model);
  const effort = coerceEffort(ticket && ticket.effort);
  return ["opus", "sonnet", "fable"].includes(String(model)) && ["xhigh", "max"].includes(String(effort));
}
const DISPATCH_SYMBOL_CHECK_MAX = 12;
const DISPATCH_SYMBOL_CHECK_MAX_SCOPES = 64;
const DISPATCH_SYMBOL_CHECK_MAX_TREE_BYTES = 256 * 1024;
function ticketSymbolReferences(ticket) {
  const candidates = `${ticket?.title || ""}
${ticket?.description || ""}`.matchAll(/`([^`\r\n]+)`/g);
  const symbols = [];
  const seen = /* @__PURE__ */ new Set();
  for (const candidate of candidates) {
    const symbol = String(candidate[1] || "").trim();
    if (symbol.length < 3 || !/[_.]|\(\)/.test(symbol)) continue;
    if (!/^[A-Za-z_$][\w$]*(?:[._][A-Za-z_$][\w$]*)*(?:\(\))?$/.test(symbol)) continue;
    const key = symbol.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    symbols.push(symbol);
    if (symbols.length >= DISPATCH_SYMBOL_CHECK_MAX) break;
  }
  return symbols;
}
function symbolSearchIsBounded(projectPath, target, scopes) {
  if (!projectPath || !target || scopes.length > DISPATCH_SYMBOL_CHECK_MAX_SCOPES) return false;
  const args = ["ls-tree", "-r", "--name-only", String(target)];
  if (scopes.length) args.push("--", ...scopes);
  try {
    execFileSync("git", args, {
      cwd: projectPath,
      encoding: "utf8",
      windowsHide: true,
      stdio: "pipe",
      maxBuffer: DISPATCH_SYMBOL_CHECK_MAX_TREE_BYTES
    });
    return true;
  } catch (_) {
    return false;
  }
}
function symbolExistsOnTarget(projectPath, target, symbol, scopes) {
  const args = ["grep", "-F", "-q", "--", String(symbol), String(target)];
  if (scopes.length) args.push("--", ...scopes);
  const result = spawnSync("git", args, {
    cwd: projectPath,
    windowsHide: true,
    stdio: "ignore",
    timeout: 3e3
  });
  if (result.error || result.signal || result.status == null) return null;
  return result.status === 0;
}
function symbolExistenceWarnings(ticket, slug) {
  const projectPath = slug ? readMeta(slug)?.path : null;
  const symbols = ticketSymbolReferences(ticket);
  if (!projectPath || !symbols.length) return [];
  let target;
  try {
    target = integrationTarget(slug);
  } catch (_) {
    return [];
  }
  const scopes = dispatchDeclaredFiles(ticket);
  if (!symbolSearchIsBounded(projectPath, target.upstream, scopes)) return [];
  const warnings = [];
  for (const symbol of symbols) {
    const exists = symbolExistsOnTarget(projectPath, target.upstream, symbol, scopes);
    if (exists === false) warnings.push(`ticket names \`${symbol}\` but it does not appear on ${target.upstream}; verify this claim before acting.`);
  }
  return warnings;
}
function crossTicketStateWarnings(ticket, slug) {
  if (!ticket || !slug) return [];
  const writtenAt = Date.parse(ticket.referenceUpdatedAt || ticket.updatedAt);
  if (!Number.isFinite(writtenAt)) return [];
  const refs = new Set((String(ticket.description || "").match(/\bSQ-\d+\b/gi) || []).map((ref) => ref.toUpperCase()));
  refs.delete(String(ticket.ref || "").toUpperCase());
  const warnings = [];
  for (const ref of refs) {
    const referenced = getTicket(slug, ref);
    const transition = referenced?.statusTransition;
    const changedAt = Date.parse(transition?.at);
    if (!referenced || !Number.isFinite(changedAt) || changedAt <= writtenAt) continue;
    const from = transition.from || "unknown";
    const to = transition.to || referenced.status || "unknown";
    warnings.push(`${ref} changed state (${from} -> ${to}) after this ticket was written; its claims may be stale.`);
  }
  return warnings;
}
function dispatchUncertaintyWarnings(ticket, slug) {
  return [...symbolExistenceWarnings(ticket, slug), ...crossTicketStateWarnings(ticket, slug)].map((warning) => `Dispatch warning: ${warning}`);
}
function dispatchWarnings(ticket, slug) {
  const warnings = dispatchUncertaintyWarnings(ticket, slug);
  const projectPath = slug ? readMeta(slug)?.path : null;
  if (projectPath) {
    const browserReview = readonlyBrowserReviewWarning(ticket);
    if (browserReview) warnings.push(`Dispatch warning: ${browserReview.replace("Planning-depth warning: ", "")}`);
    const verify = verifyCommandWarning(ticket, projectPath);
    if (verify) warnings.push(`Dispatch warning: ${verify.replace("Planning-depth warning: ", "")}`);
    for (const warning of sourceBuildOutputWarnings(ticket, projectPath)) {
      warnings.push(`Dispatch warning: ${warning.replace("Planning-depth warning: ", "")}`);
    }
  }
  if (claudeWebSearchUnavailable(ticket)) {
    warnings.push("Dispatch warning: WebSearch is unavailable on this Claude xhigh/max route. Put web research in a research-category ticket.");
  }
  if (readOnlyOverrideActive(ticket)) {
    warnings.push(ticket.readonlyOverride ? "readonly override active: this ticket closes with done + comment despite its category default." : "readonly override active: this read-only category routes through the writing executor.");
  }
  const contradiction = readonlyCategoryWriteIntentWarning(ticket);
  if (contradiction) warnings.push(`Dispatch warning: ${contradiction}`);
  const worktreeWarning = dispatchState(ticket)?.worktreeWarning;
  if (worktreeWarning) warnings.push(worktreeWarning);
  const categoryId = ticket && (ticket.categoryId || ticket.category && ticket.category.id);
  if (/^(?:coding(?:\.|$)|debugging$)/.test(String(categoryId || "")) && !String(ticket.executorVerify || "").trim()) {
    warnings.push("Dispatch warning: this coding/debugging ticket has no verify command. Add one before the executor starts.");
  }
  warnings.push(...storyContractDriftWarnings(ticket));
  const declaredFiles = dispatchDeclaredFiles(ticket);
  const outside = externalDeclaredFiles(declaredFiles);
  if (outside.length) {
    warnings.push(`Dispatch warning: declared paths are outside the repo worktree: ${outside.join(", ")}. A repo-changing category can't commit them. Use an artifact/non-repo category, or declare in-repo paths.`);
  }
  if (!slug || !declaredFiles.length) return warnings;
  for (const sibling of listTickets(slug)) {
    if (sibling.id === ticket.id) continue;
    const dispatch = dispatchState(sibling);
    const liveClaim = sibling.claim && sibling.claim.by && !claimReclaimable(sibling);
    const liveDispatch = dispatch && !dispatch.terminalAt && ["prepared", "launched", "bound", "claimed"].includes(pulseDispatchState(dispatch));
    if (!liveClaim && !liveDispatch) continue;
    const overlaps = overlappingScopePaths(declaredFiles, dispatchDeclaredFiles(sibling));
    const contractReasons = contractCollisionReasons(ticket, sibling);
    if (!overlaps.length && !contractReasons.length) continue;
    if (overlaps.length) {
      const lockfilesOnly = overlaps.every((file) => /(?:^|\/)(?:Cargo\.lock|package-lock\.json|pnpm-lock\.yaml)$/i.test(file));
      const lockfileGuidance = lockfilesOnly ? " Only lockfiles overlap; serialize these tickets or regenerate the lockfile at integration." : "";
      warnings.push(`Dispatch warning: ${ticket.ref} overlaps in-flight ${sibling.ref} at ${overlaps.join(", ")} — parallel is fine in isolated worktrees unless the same symbols/regions change; assess.${lockfileGuidance}`);
    }
    for (const collision of contractReasons) {
      warnings.push(`Dispatch warning: contract edge with in-flight ${sibling.ref}: ${collision.message} Serialize unless a reviewed contract waiver applies.`);
    }
  }
  return warnings;
}
function dispatchDeclaredFiles(ticket) {
  const dispatch = dispatchState(ticket);
  return normalizeFiles(dispatch && Array.isArray(dispatch.declaredFiles) ? dispatch.declaredFiles : ticket && ticket.files);
}
function externalDeclaredFiles(files) {
  return commitScope.validateRelativeScopes(files).outside;
}
function nonRepoExternalOutput(ticket, files) {
  const declaredFiles = normalizeFiles(files);
  const outside = externalDeclaredFiles(declaredFiles);
  return declaredFiles.length > 0 && outside.length === declaredFiles.length && dispatchReadOnly(ticket);
}
const JUDGMENT_TIER_CATEGORIES = ["coding.normal", "coding.hard", "debugging", "plugin-dev", "ui-frontend"];
const PRESOLVED_BLOCK_MIN_LINES = 20;
const PRESOLVED_BLOCK_MIN_CHARS = 1200;
const EVIDENCE_SHARE = 0.25;
const EVIDENCE_LINE = /^\s*(?:\||at\s+\S.*:\d+:\d+|(?:not )?ok\s|[#$>]\s|(?:npm|node|git|pwsh|PS|yarn|pnpm|cargo|python)\s|(?:\[[^\]]*\]\s*)?(?:ERROR|WARN|INFO|DEBUG|TRACE)\b|(?:pass|fail|tests|suites|skipped|todo|cancelled|duration_ms)\s+\d|[\w.]*(?:Error|Exception):)/;
const EVIDENCE_TIMESTAMP = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
const DEFINITION_SHAPES = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*[\w$]*\s*\(/m,
  /^\s*(?:export\s+)?(?:abstract\s+)?class\s+[\w$]+/m,
  /^\s*(?:export\s+)?(?:const|let|var)\s+[\w$]+[^=\n]*=\s*(?:async\s*)?(?:function\b|\([^)\n]*\)\s*=>|[\w$]+\s*=>)/m,
  /^\s*def\s+[\w$]+\s*\(/m,
  /^\s*(?:public|private|protected|internal)\s+(?:static\s+)?[\w<>\[\],\s]+\s+[\w$]+\s*\(/m
];
function fencedBlocks(description) {
  const blocks = [];
  const body = String(description || "");
  const fence = /^[ \t]*```+[ \t]*([^\n`]*)\r?\n([\s\S]*?)^[ \t]*```+[ \t]*$/gm;
  let match;
  while (match = fence.exec(body)) blocks.push({ info: String(match[1]).trim().toLowerCase(), body: String(match[2]) });
  return blocks;
}
function diffShapedBlock(block) {
  if (/^(?:diff|patch)\b/.test(block.info)) return true;
  if (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m.test(block.body)) return true;
  if (/^--- .+\r?\n\+\+\+ /m.test(block.body)) return true;
  const added = (block.body.match(/^\+(?!\+)\s*\S/gm) || []).length;
  const removed = (block.body.match(/^-(?!-)\s*\S/gm) || []).length;
  return added >= 2 && removed >= 2;
}
function evidenceShapedBlock(lines) {
  const filled = lines.filter((line) => line.trim());
  if (!filled.length) return true;
  const evidence = filled.filter((line) => EVIDENCE_LINE.test(line) || EVIDENCE_TIMESTAMP.test(line)).length;
  return evidence / filled.length >= EVIDENCE_SHARE;
}
function embedsCompleteEdit(description) {
  for (const block of fencedBlocks(description)) {
    const lines = block.body.split(/\r?\n/);
    if (lines.length < PRESOLVED_BLOCK_MIN_LINES && block.body.length < PRESOLVED_BLOCK_MIN_CHARS) continue;
    if (evidenceShapedBlock(lines)) continue;
    if (diffShapedBlock(block) || DEFINITION_SHAPES.some((shape) => shape.test(block.body))) return true;
  }
  return false;
}
function presolvedRoutingWarnings(ticket) {
  if (!JUDGMENT_TIER_CATEGORIES.includes(String(ticketCategory(ticket) || ""))) return [];
  if (!embedsCompleteEdit(ticket && ticket.description)) return [];
  return ["Planning-depth warning: this description embeds what looks like a complete edit; route by remaining uncertainty, so a fully resolved approach belongs on coding.easy or direct-ok, not a judgment tier."];
}
function ticketPlanningWarnings(ticket, projectPath) {
  if (!ticket) return [];
  const warnings = [];
  const outside = externalDeclaredFiles(ticket.files);
  if (outside.length) {
    warnings.push(`Planning-depth warning: declared paths are outside the repo worktree: ${outside.join(", ")}. A repo-changing category can't commit them. Use an artifact/non-repo category, or declare in-repo paths.`);
  }
  if (Number(ticket.complexity) >= 4) {
    const missing = [];
    if (!String(ticket.executorAnchors || "").trim()) missing.push("executor anchors");
    if (!String(ticket.executorVerify || "").trim()) missing.push("verify command");
    if (!Array.isArray(ticket.files) || !ticket.files.length) missing.push("file scope");
    if (missing.length) {
      warnings.push(`Planning-depth warning: complexity 4+ tickets should include executor anchors, an exact verify command, and declared file scope before dispatch; missing: ${missing.join(", ")}.`);
    }
  }
  warnings.push(...presolvedRoutingWarnings(ticket));
  const contradiction = readonlyCategoryWriteIntentWarning(ticket);
  if (contradiction) warnings.push(contradiction);
  const noScope = noDeclaredScopeWarning(ticket);
  if (noScope) warnings.push(noScope);
  const browserReview = readonlyBrowserReviewWarning(ticket);
  if (browserReview) warnings.push(browserReview);
  const verify = verifyCommandWarning(ticket, projectPath);
  if (verify) warnings.push(verify);
  if (!projectPath || !Array.isArray(ticket.files)) return warnings;
  warnings.push(...sourceBuildOutputWarnings(ticket, projectPath));
  const absent = ticket.files.filter((file) => !fs.existsSync(path.resolve(projectPath, file)));
  if (absent.length) warnings.push(`Planning-depth warning: declared file scope does not exist in the repo: ${absent.join(", ")}.`);
  return warnings;
}
function normalizeReadonlyOverride(value) {
  return typeof value === "boolean" ? value : null;
}
function requestedReadonlyOverride(fields) {
  return normalizeReadonlyOverride(fields?.readonlyOverride === void 0 ? fields?.readonly : fields.readonlyOverride);
}
function categoryReadOnly(ticket) {
  return ticket?.category?.readonly === true;
}
function readOnlyOverrideActive(ticket) {
  return typeof ticket?.readonlyOverride === "boolean";
}
function dispatchReadOnly(ticket) {
  return typeof ticket?.readonlyOverride === "boolean" ? ticket.readonlyOverride : categoryReadOnly(ticket);
}
function createTicket(slug, fields) {
  fields = fields || {};
  const status = fields.status === void 0 ? "todo" : requireStatus(fields.status);
  const id = newTicketId();
  const seq = nextSeq(slug);
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const assets = [];
  const imgs = Array.isArray(fields.images) ? fields.images : [];
  for (const src of imgs) {
    try {
      assets.push(copyAsset(slug, id, src));
    } catch (e) {
      if (fields.onAssetError) fields.onAssetError(src, e);
    }
  }
  for (const d of asDataImages(fields.imagesData)) {
    try {
      assets.push(saveAssetData(slug, id, d.name, d.buffer));
    } catch (_) {
    }
  }
  requireVerifyCommand(fields.executorVerify);
  const ticket = {
    id,
    ref: `SQ-${seq}`,
    title: String(fields.title || "Untitled").trim().slice(0, 300) || "Untitled",
    description: String(fields.description || "").trim(),
    status,
    priority: coercePriority(fields.priority, "normal"),
    labels: boundedLabels(fields.labels),
    highStakes: !!fields.highStakes,
    storyId: coerceStoryId(slug, fields.storyId),
    // the user story this ticket belongs to (null = none)
    category: fields.category == null ? null : String(fields.category).trim().toLowerCase() || null,
    complexity: coerceComplexity(fields.complexity),
    // 1..10 score the routing is derived from (entry points require it)
    complexityWhy: String(fields.complexityWhy || "").trim().slice(0, 1e3),
    // the mandatory motivation for the score
    files: boundedFiles(fields.files),
    // declared file scope, for parallel-wave planning
    contracts: boundedContracts(fields.contracts),
    // declared contract edges, for parallel-wave planning
    contractWaiver: !!fields.contractWaiver,
    readonlyOverride: requestedReadonlyOverride(fields),
    executorAnchors: executorText(fields.executorAnchors, EXECUTOR_ANCHORS_MAX, "executor anchors"),
    executorVerify: executorText(fields.executorVerify, EXECUTOR_VERIFY_MAX, "executor verify command"),
    assets,
    comments: [],
    // [{ id, by, body, kind: 'comment', at }]
    links: [],
    // [{ type: 'blocks'|'blocked-by'|'related', ref }]
    claim: null,
    // { by, at } when an agent has claimed it to work on
    checkpoint: null,
    dispatchNonce: null,
    dispatchExecutor: null,
    directClaim: null,
    assignee: normalizeAssignee(fields.assignee),
    // who it's assigned to (usually the human "you"); distinct from an agent claim
    archived: false,
    // hidden from the board (kept, restorable) once true
    archivedAt: null,
    source: String(fields.source || "manual"),
    // Who/what last touched this ticket, and how. The dashboard uses these to
    // decide whether a change was made by the user (source "dashboard") or by
    // Claude/the CLI in the background, and whether it was a status change.
    lastEventType: "created",
    lastEventSource: String(fields.source || "manual"),
    createdAt: now,
    updatedAt: now,
    referenceUpdatedAt: now,
    order: Date.now()
  };
  putTicket(slug, ticket);
  queueEventNotification(slug, ticket, "created", ticket.lastEventSource);
  return ticket;
}
function asDataImages(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const d of list) {
    if (!d || typeof d.base64 !== "string") continue;
    const b64 = d.base64.replace(/^data:[^;]+;base64,/, "");
    try {
      const buffer = Buffer.from(b64, "base64");
      if (buffer.length) out.push({ name: d.name, buffer });
    } catch (_) {
    }
  }
  return out;
}
function normalizeLabels(labels) {
  if (!labels) return [];
  const arr = Array.isArray(labels) ? labels : String(labels).split(",");
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const l of arr) {
    const v = String(l).trim().slice(0, 40);
    if (v && !seen.has(v.toLowerCase())) {
      seen.add(v.toLowerCase());
      out.push(v);
    }
  }
  return out;
}
function normalizeFiles(files) {
  if (!files) return [];
  const arr = Array.isArray(files) ? files : String(files).split(",");
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const f of arr) {
    const v = String(f).trim().replace(/\\/g, "/").replace(/\/+$/, "").slice(0, 200);
    if (v && !seen.has(v.toLowerCase())) {
      seen.add(v.toLowerCase());
      out.push(v);
    }
  }
  return out;
}
const DECLARED_FILES_MAX = 100;
const CONTRACT_NAMES_MAX = 40;
const LABELS_MAX = 24;
function boundedList(values, max, label, guidance) {
  if (values.length > max) {
    throw new Error(`${label} accepts at most ${max} entries; this write declared ${values.length} (${values.length - max} over). ${guidance}`);
  }
  return values;
}
function boundedFiles(files) {
  return boundedList(
    normalizeFiles(files),
    DECLARED_FILES_MAX,
    "declared file scope",
    "Re-scope with directory entries: a declared directory covers every path under it (e.g. plugins/sidequest/test instead of each test file)."
  );
}
function boundedLabels(labels) {
  return boundedList(normalizeLabels(labels), LABELS_MAX, "labels", "Labels route and filter work; drop the ones that do neither.");
}
function scopeExpansionFiles(ticket, additions) {
  return normalizeFiles([...Array.isArray(ticket?.files) ? ticket.files : [], ...normalizeFiles(additions)]);
}
function approvedScopeRequestFiles(ticket, files) {
  const request = ticket?.scopeRequest;
  const pending = normalizeFiles(request?.files);
  if (!pending.length) return null;
  const next = boundedFiles(files);
  const pendingScope = scopeExpansionFiles(ticket, pending);
  const requestedScope = scopeExpansionFiles(ticket, request?.requested || pending);
  if (!sameFiles(next, pendingScope) && !sameFiles(next, requestedScope)) return null;
  return requestedScope;
}
function scopeExpansionCommand(ticket, additions) {
  const ref = String(ticket?.ref || "").trim();
  if (!ref) return null;
  return `sidequest update ${ref} --files ${JSON.stringify(scopeExpansionFiles(ticket, additions).join(","))}`;
}
function pendingScopeApprovalWarning(ticket) {
  const requested = normalizeFiles(ticket?.scopeRequest?.files);
  if (!requested.length) return null;
  const command = scopeExpansionCommand(ticket, requested);
  return `Scope request remains pending for ${requested.join(", ")}. This update did not cover every requested path; approve the full request with \`${command}\`.`;
}
function scopeRequestMarkerFile(ticket) {
  return `scope-request-${String(ticket?.id || "ticket").replace(/[^a-z0-9_-]/gi, "_")}.json`;
}
function pluginRoot(file) {
  const match = /^plugins\/([^/]+)(?:\/|$)/i.exec(String(file || "").replace(/\\/g, "/"));
  return match ? `plugins/${match[1]}` : null;
}
function pluginTestDirectory(file) {
  const match = /^(plugins\/[^/]+)\/test(?:\/|$)/i.exec(String(file || "").replace(/\\/g, "/"));
  return match ? `${match[1]}/test` : null;
}
function autoApprovedPluginTestScope(ticket, requested, additions, slug) {
  if (!boardConfig(slug)?.autoApprovePluginTests) return null;
  const declaredRoots = new Set((ticket?.files || []).map(pluginRoot).filter(Boolean).map((root) => root.toLowerCase()));
  const requestedTestDirectories = normalizeFiles(requested).map(pluginTestDirectory);
  if (!requestedTestDirectories.length || requestedTestDirectories.some((directory) => !directory || !declaredRoots.has(pluginRoot(directory).toLowerCase()))) return null;
  return normalizeFiles(normalizeFiles(additions).map(pluginTestDirectory).filter(Boolean));
}
function createScopeRequestMarker(ticket, request, worktree) {
  const dispatch = dispatchState(ticket);
  if (!dispatch || dispatch.sharedTree !== false) return { ok: true, markerWorktree: null };
  const supplied = String(worktree || "").trim();
  if (!supplied) return { ok: false, reason: "worktree_required" };
  try {
    const root = commitScope.repoRoot(supplied);
    const linked = commitScope.linkedWorktree(root);
    if (!linked.ok || !linked.linked) return { ok: false, reason: "worktree_isolation" };
    const marker = path.join(root, ".sidequest", scopeRequestMarkerFile(ticket));
    const relativeMarker = path.relative(root, marker).replace(/\\/g, "/");
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, JSON.stringify({
      ref: ticket.ref,
      by: request.by,
      files: request.files,
      requested: request.requested,
      covered: request.covered,
      at: request.at
    }) + "\n");
    try {
      execFileSync("git", ["add", "--intent-to-add", "--force", "--", relativeMarker], { cwd: root, windowsHide: true, stdio: "ignore" });
    } catch (_) {
      fs.unlinkSync(marker);
      return { ok: false, reason: "worktree_unavailable" };
    }
    return { ok: true, markerWorktree: root };
  } catch (_) {
    return { ok: false, reason: "worktree_unavailable" };
  }
}
function clearScopeRequestMarker(ticket) {
  const worktree = String(ticket?.scopeRequest?.markerWorktree || "").trim();
  if (!worktree) return;
  const marker = path.join(worktree, ".sidequest", scopeRequestMarkerFile(ticket));
  const relativeMarker = path.relative(worktree, marker).replace(/\\/g, "/");
  try {
    execFileSync("git", ["reset", "--quiet", "--", relativeMarker], { cwd: worktree, windowsHide: true, stdio: "ignore" });
  } catch (_) {
  }
  try {
    fs.unlinkSync(marker);
  } catch (_) {
  }
  try {
    fs.rmdirSync(path.dirname(marker));
  } catch (_) {
  }
}
function scopePauseRecoveryAsset(ticket) {
  return `scope-pause-${String(ticket?.id || "ticket").replace(/[^a-z0-9_-]/gi, "_")}.patch`;
}
function noIndexDiff(worktree, relativePath) {
  try {
    return execFileSync("git", ["diff", "--binary", "--no-index", "--", "/dev/null", relativePath], {
      cwd: worktree,
      encoding: "utf8",
      windowsHide: true
    });
  } catch (error) {
    return String(error?.stdout || "");
  }
}
function captureScopePauseRecovery(slug, ticket) {
  const dispatch = dispatchState(ticket);
  const worktree = String(dispatch?.worktree || ticket?.scopeRequest?.markerWorktree || "").trim();
  if (!worktree || !fs.existsSync(worktree)) return null;
  let patch = "";
  try {
    patch = execFileSync("git", ["diff", "--binary", "HEAD", "--", ".", ":(exclude).sidequest/**"], {
      cwd: worktree,
      encoding: "utf8",
      windowsHide: true
    });
  } catch (_) {
    return null;
  }
  try {
    const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
      cwd: worktree,
      encoding: "utf8",
      windowsHide: true
    }).split("\0");
    for (const file of untracked) {
      const relative = file.replace(/\\/g, "/");
      if (!relative || relative === ".sidequest" || relative.startsWith(".sidequest/")) continue;
      patch += noIndexDiff(worktree, relative);
    }
  } catch (_) {
  }
  if (!patch.trim()) return null;
  const asset = scopePauseRecoveryAsset(ticket);
  try {
    fs.mkdirSync(assetsDir(slug, ticket.id), { recursive: true });
    fs.writeFileSync(assetPath(slug, ticket.id, asset), patch);
    if (!Array.isArray(ticket.assets)) ticket.assets = [];
    if (!ticket.assets.includes(asset)) ticket.assets.push(asset);
    ticket.scopePauseRecovery = { asset, at: (/* @__PURE__ */ new Date()).toISOString(), worktree };
    return ticket.scopePauseRecovery;
  } catch (_) {
    return null;
  }
}
function requestScope(slug, idOrRef, by, files, opts) {
  opts = opts || {};
  by = String(by || "agent");
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: "not_found" };
  return withTicketLock(slug, found.id, () => {
    const t = getTicket(slug, found.id);
    if (!t) return { ok: false, reason: "not_found" };
    const held = t.claim;
    if (!held || !held.by) return { ok: false, reason: "not_claimed", ticket: t };
    if (held.by !== by && !opts.force) return { ok: false, reason: "not_owner", ticket: t, claim: held };
    const requested = normalizeFiles(files);
    if (!requested.length) return { ok: false, reason: "files_required", ticket: t };
    const validation = commitScope.validateRelativeScopes(requested);
    if (!validation.ok) return { ok: false, reason: "invalid_scope", ticket: t, paths: validation.outside };
    const scope = effectiveScope(slug, t.files);
    const additions = requested.filter((file) => !commitScope.isInScope(file, scope));
    const covered = requested.filter((file) => commitScope.isInScope(file, scope));
    const now = (/* @__PURE__ */ new Date()).toISOString();
    touchClaimActivity(t, by, now);
    if (!additions.length) {
      t.updatedAt = now;
      putTicket(slug, t);
      return { ok: true, ticket: t, covered, scopeRequest: null, command: null };
    }
    const testDirectories = autoApprovedPluginTestScope(t, requested, additions, slug);
    if (testDirectories) {
      t.files = boundedFiles(scopeExpansionFiles(t, testDirectories));
      const dispatch2 = dispatchState(t);
      if (dispatch2 && !dispatch2.terminalAt) dispatch2.declaredFiles = t.files.slice();
      if (!Array.isArray(t.comments)) t.comments = [];
      const comment2 = createComment({
        by: "board",
        body: `Auto-approved test scope under board policy: ${testDirectories.join(", ")}.`,
        kind: "comment",
        source: "policy"
      }, now);
      t.comments.push(comment2);
      t.lastEventType = "scope_auto_approved";
      t.lastEventSource = "policy";
      t.updatedAt = now;
      putTicket(slug, t);
      queueEventNotification(slug, t, "comment", comment2.source, { commentBody: comment2.body });
      return { ok: true, ticket: t, covered, approved: testDirectories, autoApproved: true, scopeRequest: null, command: null, comment: comment2 };
    }
    const command = scopeExpansionCommand(t, requested);
    const request = { by, files: additions, requested, covered, at: now };
    const marker = createScopeRequestMarker(t, request, opts.worktree);
    if (!marker.ok) return { ok: false, reason: marker.reason, ticket: t };
    t.scopeRequest = Object.assign(request, marker.markerWorktree ? { markerWorktree: marker.markerWorktree } : {});
    const dispatch = dispatchState(t);
    if (dispatch && !dispatch.terminalAt) dispatch.scopeRequest = t.scopeRequest;
    if (!Array.isArray(t.comments)) t.comments = [];
    const comment = createComment({
      by,
      body: `Scope expansion requested: ${additions.join(", ")}.${covered.length ? ` Already in scope: ${covered.join(", ")}.` : ""} Approve with \`${command}\`; claim remains held.`,
      kind: "comment",
      source: opts.source || "cli"
    }, now);
    t.comments.push(comment);
    t.lastEventType = "scope_request";
    t.lastEventSource = opts.source || "cli";
    t.updatedAt = now;
    putTicket(slug, t);
    queueEventNotification(slug, t, "comment", comment.source, { commentBody: comment.body });
    return { ok: true, ticket: t, scopeRequest: t.scopeRequest, command, comment };
  });
}
function overlappingScopePaths(filesA, filesB) {
  const a = normalizeFiles(filesA);
  const b = normalizeFiles(filesB);
  const overlaps = /* @__PURE__ */ new Map();
  for (const x of a) {
    for (const y of b) {
      const left = x.toLowerCase();
      const right = y.toLowerCase();
      const overlap = left === right ? x : left.startsWith(right + "/") ? x : right.startsWith(left + "/") ? y : null;
      if (overlap) overlaps.set(overlap.toLowerCase(), overlap);
    }
  }
  return Array.from(overlaps.values()).sort((left, right) => left.localeCompare(right));
}
function scopesOverlap(filesA, filesB) {
  return overlappingScopePaths(filesA, filesB).length > 0;
}
const CONTRACT_EDGE_KINDS = ["produces", "changes", "consumes"];
function normalizeContractNames(values) {
  if (!values) return [];
  const entries = Array.isArray(values) ? values : String(values).split(",");
  const seen = /* @__PURE__ */ new Set();
  const normalized = [];
  for (const value of entries) {
    const name = String(value).trim().slice(0, 200);
    if (name && !seen.has(name.toLowerCase())) {
      seen.add(name.toLowerCase());
      normalized.push(name);
    }
  }
  return normalized;
}
function normalizeContracts(contracts) {
  const source = contracts && typeof contracts === "object" ? contracts : {};
  return Object.fromEntries(CONTRACT_EDGE_KINDS.map((kind) => [kind, normalizeContractNames(source[kind])]));
}
function boundedContracts(contracts) {
  const normalized = normalizeContracts(contracts);
  for (const kind of CONTRACT_EDGE_KINDS) {
    boundedList(normalized[kind], CONTRACT_NAMES_MAX, `contract ${kind}`, "Name the shared interfaces the wave planner sequences on, not every symbol they touch.");
  }
  return normalized;
}
function contractNamesByLowerCase(values) {
  return new Map(normalizeContractNames(values).map((value) => [value.toLowerCase(), value]));
}
function contractCollisionReasons(left, right) {
  if (!left || !right || left.contractWaiver || right.contractWaiver) return [];
  const leftContracts = normalizeContracts(left.contracts);
  const rightContracts = normalizeContracts(right.contracts);
  const reasons = [];
  const matchingNames = (a, b) => {
    const matches = [];
    for (const [key, name] of contractNamesByLowerCase(a)) {
      if (contractNamesByLowerCase(b).has(key)) matches.push(name);
    }
    return matches.sort((a2, b2) => a2.localeCompare(b2));
  };
  for (const contract of matchingNames(leftContracts.produces, rightContracts.consumes)) {
    reasons.push({ contract, type: "produces-consumes", message: `${left.ref} produces ${contract}, which ${right.ref} consumes.` });
  }
  for (const contract of matchingNames(rightContracts.produces, leftContracts.consumes)) {
    reasons.push({ contract, type: "produces-consumes", message: `${right.ref} produces ${contract}, which ${left.ref} consumes.` });
  }
  for (const contract of matchingNames(leftContracts.changes, rightContracts.changes)) {
    reasons.push({ contract, type: "changes-changes", message: `${left.ref} and ${right.ref} both change ${contract}.` });
  }
  return reasons;
}
function ticketsConflict(left, right) {
  return scopesOverlap(left.files, right.files) || contractCollisionReasons(left, right).length > 0;
}
function orderReadyTicketsByContractDependencies(tickets) {
  const ordered = Array.isArray(tickets) ? tickets : [];
  const edges = new Map(ordered.map((ticket) => [ticket.id, /* @__PURE__ */ new Set()]));
  for (const producer of ordered) {
    if (producer.contractWaiver) continue;
    const produced = contractNamesByLowerCase(normalizeContracts(producer.contracts).produces);
    for (const consumer of ordered) {
      if (producer.id === consumer.id || consumer.contractWaiver) continue;
      const consumed = contractNamesByLowerCase(normalizeContracts(consumer.contracts).consumes);
      const dependencies = edges.get(producer.id);
      if (dependencies && [...produced.keys()].some((name) => consumed.has(name))) dependencies.add(consumer.id);
    }
  }
  const pending = new Set(ordered.map((ticket) => ticket.id));
  const result = [];
  while (pending.size) {
    const next = ordered.find((ticket) => {
      if (!pending.has(ticket.id)) return false;
      for (const [from, targets] of edges) {
        if (pending.has(from) && targets.has(ticket.id)) return false;
      }
      return true;
    }) || ordered.find((ticket) => pending.has(ticket.id));
    result.push(next);
    pending.delete(next.id);
  }
  return result;
}
function contractMetadata(ticket) {
  const contracts = normalizeContracts(ticket && ticket.contracts);
  return {
    produces: contracts.produces,
    changes: contracts.changes,
    consumes: contracts.consumes,
    waiver: !!(ticket && ticket.contractWaiver)
  };
}
function readyWaves(slug, opts) {
  const ready = orderReadyTicketsByContractDependencies(readyTickets(slug, opts));
  const waves = [];
  for (const t of ready) {
    let placed = false;
    for (const wave of waves) {
      if (!wave.some((w) => ticketsConflict(w, t))) {
        wave.push(t);
        placed = true;
        break;
      }
    }
    if (!placed) waves.push([t]);
  }
  return waves;
}
function readyWaveDependencies(slug, opts) {
  const waves = readyWaves(slug, opts);
  const dependencies = [];
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
function normalizeAssignee(v) {
  if (v == null) return null;
  const s = String(v).trim().slice(0, 60);
  return s || null;
}
function updateDoneRefusal(ticket) {
  if (ticket.claim && ticket.claim.by && !claimReclaimable(ticket)) {
    return `${ticket.ref} is claimed. Use done/completeTicket for eligible non-repo or artifact work; scoped repository work must commit and submit.`;
  }
  if (pendingSubmission(ticket)) {
    return `${ticket.ref} has a pending submission. Complete it through the integration lifecycle; update --status done cannot consume submitted work.`;
  }
  const state = dispatchState(ticket);
  if (ticket.dispatchNonce || state && !state.terminalAt) {
    return `${ticket.ref} has an active dispatch. Its executor must use done/completeTicket or commit and submit; update --status done cannot bypass that lifecycle.`;
  }
  if (state) {
    return `${ticket.ref} has routed dispatch history. Executors cannot close released repository work; use the control-plane grooming closure with evidence.`;
  }
  return null;
}
function updateReopenRefusal(ticket, nextStatus) {
  if (!pendingSubmission(ticket)) return null;
  const commit = String(ticket.submission.commit || "").slice(0, 12);
  return `${ticket.ref} has a pending submission (commit ${commit}) parked READY_FOR_INTEGRATION. update cannot move it to "${nextStatus}" and leave the submission in place — the next claim would still refuse it as already-submitted. Reject it first: \`sidequest submit ${ticket.ref} --clear --status ${nextStatus}\` (MCP \`submit\` with \`clear:true, status:"${nextStatus}"\`), or integrate it through the publish flow.`;
}
function sameFiles(left, right) {
  const normalizedLeft = normalizeFiles(left);
  const normalizedRight = normalizeFiles(right);
  const rightFiles = new Set(normalizedRight.map((file) => file.toLowerCase()));
  return normalizedLeft.length === normalizedRight.length && normalizedLeft.every((file) => rightFiles.has(file.toLowerCase()));
}
function activeClaimScopeRefusal(ticket, files, patch) {
  if (!ticket.claim?.by || claimReclaimable(ticket)) return null;
  const current = normalizeFiles(ticket.files);
  const next = boundedFiles(files);
  if (sameFiles(current, next)) return null;
  const request = ticket.scopeRequest;
  if (request && approvedScopeRequestFiles(ticket, next)) return null;
  const caller = String(patch?.by || "").trim();
  if (caller && caller !== ticket.claim.by) return null;
  const claimedSession = String(dispatchState(ticket)?.sessionId || "").trim();
  const callerSession = String(patch?.sessionId || "").trim();
  if (callerSession && claimedSession && callerSession !== claimedSession) return null;
  const currentFiles = new Set(current.map((file) => file.toLowerCase()));
  const nextFiles = new Set(next.map((file) => file.toLowerCase()));
  const refused = [
    ...next.filter((file) => !currentFiles.has(file.toLowerCase())),
    ...current.filter((file) => !nextFiles.has(file.toLowerCase()))
  ];
  return `${ticket.ref}: refusing active-claim scope change for ${refused.join(", ")}. Use \`sidequest scope-request ${ticket.ref} --file <path> --by ${ticket.claim.by}\` to request approval.`;
}
function updateTicket(slug, idOrRef, patch) {
  const found = getTicket(slug, idOrRef);
  if (!found) return null;
  patch = patch || {};
  const apply = (t) => {
    const nextStatus = patch.status == null ? null : requireStatus(patch.status);
    const doneRefusal = nextStatus === "done" ? updateDoneRefusal(t) : null;
    if (doneRefusal) throw new Error(doneRefusal);
    const reopenRefusal = nextStatus != null && nextStatus !== "done" ? updateReopenRefusal(t, nextStatus) : null;
    if (reopenRefusal) throw new Error(reopenRefusal);
    const prevStatus = t.status;
    if (patch.title != null) t.title = String(patch.title).trim().slice(0, 300) || t.title;
    if (patch.description != null) t.description = String(patch.description).trim();
    if (patch.status != null) t.status = nextStatus;
    if (patch.priority != null) t.priority = coercePriority(patch.priority, t.priority);
    if (patch.labels != null) t.labels = boundedLabels(patch.labels);
    if (patch.highStakes !== void 0) t.highStakes = !!patch.highStakes;
    if (patch.storyId !== void 0) t.storyId = coerceStoryId(slug, patch.storyId);
    if (patch.category !== void 0) t.category = patch.category == null ? null : String(patch.category).trim().toLowerCase() || null;
    if (patch.complexity !== void 0) {
      const c = coerceComplexity(patch.complexity);
      if (c) t.complexity = c;
    }
    if (patch.complexityWhy !== void 0 && String(patch.complexityWhy).trim()) t.complexityWhy = String(patch.complexityWhy).trim().slice(0, 1e3);
    if (patch.files !== void 0) {
      const scopeRefusal = activeClaimScopeRefusal(t, patch.files, patch);
      if (scopeRefusal) throw new Error(scopeRefusal);
      const approvedFiles = approvedScopeRequestFiles(t, patch.files);
      t.files = approvedFiles || boundedFiles(patch.files);
      const request = t.scopeRequest;
      if (request && Array.isArray(request.files) && request.files.every((file) => commitScope.isInScope(file, effectiveScope(slug, t.files)))) {
        clearScopeRequestMarker(t);
        const dispatch = dispatchState(t);
        const resumed = reopenScopePausedDispatch(t);
        t.scopeRequest = null;
        if (dispatch && (!dispatch.terminalAt || resumed)) {
          dispatch.declaredFiles = t.files.slice();
          delete dispatch.scopeRequest;
        }
      }
    }
    if (patch.contracts !== void 0) t.contracts = boundedContracts(patch.contracts);
    if (patch.contractWaiver !== void 0) t.contractWaiver = !!patch.contractWaiver;
    if (patch.readonly !== void 0 || patch.readonlyOverride !== void 0) t.readonlyOverride = requestedReadonlyOverride(patch);
    if (patch.executorAnchors !== void 0) t.executorAnchors = executorText(patch.executorAnchors, EXECUTOR_ANCHORS_MAX, "executor anchors");
    if (patch.executorVerify !== void 0) {
      requireVerifyCommand(patch.executorVerify);
      t.executorVerify = executorText(patch.executorVerify, EXECUTOR_VERIFY_MAX, "executor verify command");
    }
    if (patch.workedBy !== void 0) {
      try {
        const w = makeWorkedBy(patch.workedBy);
        if (w) t.workedBy = w;
      } catch (_) {
      }
    }
    if (patch.assignee !== void 0) t.assignee = normalizeAssignee(patch.assignee);
    if (patch.order != null && Number.isFinite(Number(patch.order))) t.order = Number(patch.order);
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
      }
    }
    if (Array.isArray(patch.removeAssets) && patch.removeAssets.length) {
      const drop = new Set(patch.removeAssets.map((f) => path.basename(String(f))));
      t.assets = t.assets.filter((a) => {
        if (!drop.has(a)) return true;
        try {
          fs.unlinkSync(assetPath(slug, t.id, a));
        } catch (_) {
        }
        return false;
      });
    }
    t.lastEventType = t.status !== prevStatus ? "status" : "edit";
    t.lastEventSource = patch.source ? String(patch.source) : "cli";
    const now = (/* @__PURE__ */ new Date()).toISOString();
    if (t.status !== prevStatus) t.statusTransition = { from: prevStatus, to: t.status, at: now };
    t.updatedAt = now;
    t.referenceUpdatedAt = now;
    putTicket(slug, t);
    queueEventNotification(slug, t, t.lastEventType, t.lastEventSource);
    return t;
  };
  const lock = ticketLockPath(slug, found.id);
  const locked = acquireLock(lock);
  try {
    const t = getTicket(slug, found.id);
    if (!t) return null;
    return apply(t);
  } finally {
    if (locked) releaseLock(lock);
  }
}
function deleteTicket(slug, idOrRef) {
  const found = getTicket(slug, idOrRef);
  if (!found) return false;
  const deletedRef = found.ref;
  const lock = ticketLockPath(slug, found.id);
  const locked = acquireLock(lock);
  let ok = false;
  try {
    ok = deleteCachedRow(database(), "tickets", found.id);
    if (ok) {
      try {
        fs.rmSync(assetsDir(slug, found.id), { recursive: true, force: true });
      } catch (_) {
      }
    }
  } finally {
    if (locked) releaseLock(lock);
  }
  if (!ok) return false;
  try {
    for (const other of listTickets(slug)) {
      if (Array.isArray(other.links) && other.links.some((l) => upperRef(l.ref) === upperRef(deletedRef))) {
        stripLinksTo(slug, other.id, deletedRef);
      }
    }
  } catch (_) {
  }
  return true;
}
function setArchived(slug, idOrRef, archived, opts) {
  opts = opts || {};
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: "not_found" };
  return withTicketLock(slug, found.id, () => {
    const t = getTicket(slug, found.id);
    if (!t) return { ok: false, reason: "not_found" };
    t.archived = !!archived;
    t.archivedAt = archived ? (/* @__PURE__ */ new Date()).toISOString() : null;
    t.lastEventType = archived ? "archived" : "restored";
    t.lastEventSource = opts.source ? String(opts.source) : "cli";
    t.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
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
function archiveAllDone(slug, opts) {
  const refs = [];
  for (const ticket of queryTickets(String(slug || ""), { status: "done", archived: false })) {
    const result = setArchived(slug, ticket.id, true, opts);
    if (result.ok) refs.push(result.ticket.ref);
  }
  return { ok: true, archived: refs };
}
function listArchived(slug) {
  return queryTickets(String(slug || ""), { archived: true });
}
function listActive(slug) {
  return queryTickets(String(slug || ""), { archived: false });
}
const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, low: 3 };
function priorityRank(p) {
  return Object.prototype.hasOwnProperty.call(PRIORITY_RANK, p) ? PRIORITY_RANK[String(p)] ?? 9 : 9;
}
const DEFAULT_CLAIM_IDLE_MIN = 60;
const DEFAULT_CLAIM_ABANDON_MIN = 24 * 60;
const DEFAULT_PREPARED_DISPATCH_TTL_HOURS = 6;
const VERIFY_START_COMMENT = "[sidequest:verify-start] ";
const VERIFY_COMPLETE_COMMENT = "[sidequest:verify-complete]";
function preparedDispatchTtlMs() {
  const hours = Number(process.env.SIDEQUEST_PREPARED_DISPATCH_TTL_HOURS);
  return (Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_PREPARED_DISPATCH_TTL_HOURS) * 60 * 60 * 1e3;
}
function envMinutesMs(fallbackMinutes, ...names) {
  for (const name of names) {
    const raw = process.env[name];
    if (raw == null || String(raw).trim() === "") continue;
    const minutes = Number(raw);
    if (Number.isFinite(minutes) && minutes > 0) return minutes * 60 * 1e3;
  }
  return fallbackMinutes * 60 * 1e3;
}
function claimIdleMs() {
  return envMinutesMs(DEFAULT_CLAIM_IDLE_MIN, "SIDEQUEST_CLAIM_IDLE_MIN", "SIDEQUEST_CLAIM_TTL_MIN");
}
function claimAbandonMs() {
  return envMinutesMs(DEFAULT_CLAIM_ABANDON_MIN, "SIDEQUEST_CLAIM_ABANDON_MIN");
}
function claimActivityMs(ticket) {
  const claim = ticket && ticket.claim;
  if (!claim || !claim.by) return Number.NaN;
  let latest = Number.NaN;
  const consider = (value) => {
    const ms = Date.parse(value);
    if (Number.isFinite(ms) && (!Number.isFinite(latest) || ms > latest)) latest = ms;
  };
  consider(claim.at);
  consider(claim.activeAt);
  consider(claimVerification(ticket)?.startedAt);
  for (const comment of Array.isArray(ticket.comments) ? ticket.comments : []) {
    if (comment && comment.by === claim.by) consider(comment.at);
  }
  return latest;
}
function claimIdleAge(ticket, now) {
  const latest = claimActivityMs(ticket);
  return Number.isFinite(latest) ? Math.max(0, now - latest) : Number.POSITIVE_INFINITY;
}
function claimVerification(ticket) {
  const claim = ticket?.claim;
  const verification = claim?.verification;
  if (!claim?.by || !verification || verification.by !== claim.by) return null;
  const startedAt = String(verification.startedAt || "");
  const command = String(verification.command || "").trim();
  if (!Number.isFinite(Date.parse(startedAt)) || !command) return null;
  return { startedAt, command };
}
function verificationComment(body) {
  const text = String(body || "");
  if (text.startsWith(VERIFY_START_COMMENT)) {
    const command = text.slice(VERIFY_START_COMMENT.length).trim();
    return command ? { kind: "start", command } : null;
  }
  return text === VERIFY_COMPLETE_COMMENT ? { kind: "complete" } : null;
}
function recordClaimVerification(ticket, comment) {
  const claim = ticket?.claim;
  if (!claim?.by || comment?.by !== claim.by) return;
  const event = verificationComment(comment.body);
  if (!event) return;
  const dispatch = dispatchState(ticket);
  if (event.kind === "start") {
    claim.verification = { by: claim.by, startedAt: comment.at, command: event.command };
    if (dispatch) delete dispatch.verifyStopAt;
    return;
  }
  if (claimVerification(ticket)) delete claim.verification;
  if (dispatch) delete dispatch.verifyStopAt;
}
function resumableScopePause(ticket) {
  const dispatch = dispatchState(ticket);
  return Boolean(
    dispatch && dispatch.terminalAt && ticket?.claim?.by && ticket?.scopeRequest && ["scope_paused", "stopped_claimed"].includes(dispatch.outcome)
  );
}
function observedStop(dispatch, claim) {
  if (!dispatch || dispatch.outcome !== "stopped_claimed" || !dispatch.terminalAt) return false;
  const stoppedMs = Date.parse(dispatch.terminalAt);
  const claimedMs = Date.parse(claim && claim.at);
  if (!Number.isFinite(stoppedMs)) return false;
  return !Number.isFinite(claimedMs) || stoppedMs >= claimedMs;
}
function missingStoppedWorktree(dispatch) {
  if (!dispatch || dispatch.sharedTree !== false || !dispatch.terminalAt || !dispatch.worktree) return false;
  try {
    return !fs.existsSync(dispatch.worktree);
  } catch (_) {
    return false;
  }
}
function claimReleaseVerdict(ticket, now) {
  const claim = ticket && ticket.claim;
  if (!claim || !claim.by) return null;
  const atMs = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const idleMs = claimIdleAge(ticket, atMs);
  const dispatch = dispatchState(ticket);
  const verification = claimVerification(ticket);
  if (verification) {
    if (idleMs > claimAbandonMs()) {
      return { kind: "abandoned_verifying", idleMs, at: verification.startedAt, reason: "its verification marker never completed past the unobserved-death backstop" };
    }
    return null;
  }
  if (resumableScopePause(ticket)) {
    if (missingStoppedWorktree(dispatch)) {
      return { kind: "missing_worktree", idleMs, at: dispatch.terminalAt, reason: "its stopped executor worktree no longer exists" };
    }
    return null;
  }
  if (observedStop(dispatch, claim)) {
    return { kind: "observed_stop", idleMs, at: dispatch.terminalAt, reason: "its executor was observed to stop while still holding the claim" };
  }
  const liveAgent = Boolean(dispatch && !dispatch.terminalAt);
  if (!liveAgent && idleMs > claimIdleMs()) {
    return { kind: "idle", idleMs, reason: "no board activity from the claim holder and no live executor associated" };
  }
  if (!liveAgent && idleMs > claimAbandonMs()) {
    return { kind: "abandoned", idleMs, reason: "no board activity from the claim holder past the unobserved-death backstop" };
  }
  return null;
}
function claimReclaimable(ticket, now) {
  return Boolean(claimReleaseVerdict(ticket, now));
}
function autoReleasedClaimMessage(ref, release) {
  const when = release && release.at ? ` at ${release.at}` : "";
  const why = release && (release.reason || release.kind) || "the claim sweep released it";
  return `${ref}'s claim was auto-released${when}: ${why}. Its dispatch token went with it, so this closeout cannot be recorded. Your commits are safe — do NOT discard, reset, or redo the work. Recovery: have the orchestrator run \`sidequest dispatch ${ref}\`, claim with that fresh token and executor, then hand in the SAME commit.`;
}
function claimIdleLabel(idleMs) {
  return Number.isFinite(idleMs) ? `${Math.round(Number(idleMs) / 6e4)}m` : "an unknown time";
}
function claimReleaseNote(ticket, verdict) {
  const by = ticket && ticket.claim && ticket.claim.by;
  const idle = claimIdleLabel(verdict && verdict.idleMs);
  if (verdict.kind === "observed_stop") {
    return `↩️ Auto-released to **todo**: its executor was observed to stop while holding the claim (SubagentStop at ${verdict.at}, was claimed by \`${by}\`). It is back in the ready pool; re-dispatch to continue the work.`;
  }
  if (verdict.kind === "abandoned_verifying") {
    return `↩️ Auto-released to **todo**: verification from \`${by}\` never completed for ${idle}, past the unobserved-death backstop.`;
  }
  if (verdict.kind === "idle") {
    return `↩️ Auto-released to **todo**: no board activity from \`${by}\` for ${idle} and no live executor is associated with this ticket.`;
  }
  return `↩️ Auto-released to **todo**: no board activity from \`${by}\` for ${idle}, past the unobserved-death backstop (nothing ever reported that executor stopping).`;
}
function touchClaimActivity(ticket, by, now) {
  const claim = ticket && ticket.claim;
  if (!claim || !claim.by || by != null && claim.by !== by) return false;
  claim.activeAt = now || (/* @__PURE__ */ new Date()).toISOString();
  return true;
}
function touchClaim(slug, idOrRef, by) {
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: "not_found" };
  return withTicketLock(slug, found.id, () => {
    const t = getTicket(slug, found.id);
    if (!t) return { ok: false, reason: "not_found" };
    if (!touchClaimActivity(t, by)) return { ok: false, reason: "not_owner", ticket: t };
    putTicket(slug, t);
    return { ok: true, ticket: t };
  });
}
function ticketLockPath(slug, id) {
  return path.join(ticketsDir(slug), "." + path.basename(String(id)) + ".lock");
}
const LOCK_SLEEP = new Int32Array(new SharedArrayBuffer(4));
function busyWait(ms) {
  Atomics.wait(LOCK_SLEEP, 0, 0, ms);
}
function testClaimLockDelayMs() {
  const delay = Number(process.env.SIDEQUEST_TEST_CLAIM_LOCK_DELAY_MS);
  return Number.isInteger(delay) && delay > 0 ? delay : 0;
}
function acquireLock(lockPath) {
  const STALE_LOCK_MS = 3e4;
  const RETRY_MS = 10;
  const MAX_ATTEMPTS = STALE_LOCK_MS / RETRY_MS;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      try {
        fs.writeSync(fd, String(process.pid) + " " + (/* @__PURE__ */ new Date()).toISOString());
      } catch (_) {
      }
      fs.closeSync(fd);
      return true;
    } catch (e) {
      if (!e || e.code !== "EEXIST") return false;
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > STALE_LOCK_MS) {
          try {
            fs.unlinkSync(lockPath);
          } catch (_) {
          }
          continue;
        }
      } catch (_) {
        continue;
      }
      busyWait(RETRY_MS);
    }
  }
  return false;
}
function releaseLock(lockPath) {
  const RETRY_MS = 5;
  for (let attempt = 0; attempt < 1e3; attempt++) {
    try {
      fs.unlinkSync(lockPath);
      return;
    } catch (error) {
      if (!error || !["EACCES", "EBUSY", "EPERM"].includes(error.code)) return;
      busyWait(RETRY_MS);
    }
  }
}
function withTicketLock(slug, id, fn) {
  const lock = ticketLockPath(slug, id);
  if (!acquireLock(lock)) return { ok: false, reason: "busy" };
  try {
    return transaction(fn);
  } finally {
    releaseLock(lock);
  }
}
function stableExecutorName(ticket, artifactMode = false) {
  if (!ticket || !ticket.model || !ticket.effort) throw new Error("dispatch executor requires a routable ticket.");
  const resolved = resolveExec(ticket.model, ticket.effort);
  if (!resolved || !resolved.agent) throw new Error(`no stable executor for ${ticket.model} at ${ticket.effort}.`);
  if (artifactMode || sharedTreeArtifactMode(ticket) || !dispatchReadOnly(ticket)) return resolved.agent;
  return resolved.backend === "codex" ? stableReadOnlyDispatchName(ticket.effort) : stableReadOnlyClaudeName(ticket.effort);
}
function dispatchTokenPrefix(token) {
  return token ? String(token).slice(0, 12) : null;
}
function dispatchState(ticket) {
  return ticket && ticket.dispatch && typeof ticket.dispatch === "object" ? ticket.dispatch : null;
}
function sharedTreeArtifactRequested(ticket) {
  return String(ticket && ticket.description || "").split(/\r?\n/).some((line) => line.trim() === SHARED_TREE_ARTIFACT_MARKER);
}
function categoryArtifactRoot(category, scope) {
  const normalizedScope = commitScope.scopedPaths([scope]);
  if (normalizedScope.length !== 1 || !commitScope.validateRelativeScopes(normalizedScope).ok) return null;
  const roots = normalizeArtifactRoots(category && category.artifactRoots);
  return roots.find((root) => commitScope.isInScope(normalizedScope[0], [root])) || null;
}
function sharedTreeArtifactMode(ticket) {
  const state = dispatchState(ticket);
  return Boolean(state && state.sharedTree === true && state.artifactMode === true && typeof state.artifactRoot === "string" && state.artifactRoot && typeof state.artifactScope === "string" && state.artifactScope);
}
function dirtyPathKey(file) {
  const normalized = String(file || "").replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
function artifactPathIdentity(root, file) {
  const absolute = path.resolve(root, file);
  let stat;
  try {
    stat = fs.lstatSync(absolute, { bigint: true });
  } catch (error) {
    if (error && error.code === "ENOENT") return "missing";
    throw error;
  }
  let kind = "other";
  if (stat.isFile()) kind = "file";
  else if (stat.isSymbolicLink()) kind = "symlink";
  else if (stat.isDirectory()) kind = "directory";
  let content = null;
  if (kind === "file" || kind === "symlink") {
    content = execFileSync("git", ["hash-object", "--no-filters", "--", file], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true
    }).trim();
  }
  return [kind, stat.mode, stat.size, stat.dev, stat.ino, content].map((value) => String(value == null ? "" : value)).join(":");
}
function artifactWorkingState(slug) {
  const meta = readMeta(slug);
  if (!meta || !meta.path) throw new Error("the board project path is unavailable");
  const output = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd: meta.path,
    encoding: "utf8",
    windowsHide: true
  });
  const raw = output.split("\0");
  const states = [];
  for (let index = 0; index < raw.length; index++) {
    const entry = raw[index];
    if (!entry) continue;
    const status = entry.slice(0, 2);
    const file = entry.slice(3).replace(/\\/g, "/");
    if (file) states.push({ file, status });
    if (status.includes("R") || status.includes("C")) {
      const previous = raw[++index];
      if (previous) states.push({ file: previous.replace(/\\/g, "/"), status: `${status}:source` });
    }
  }
  if (states.length > ARTIFACT_BASELINE_MAX_PATHS) {
    throw new Error(`artifact dirty baseline exceeds ${ARTIFACT_BASELINE_MAX_PATHS} paths`);
  }
  return states.map((entry) => {
    const indexState = execFileSync("git", ["ls-files", "--stage", "-z", "--", entry.file], {
      cwd: meta.path,
      encoding: "utf8",
      windowsHide: true
    });
    const identity = crypto.createHash("sha256").update(JSON.stringify({
      status: entry.status,
      index: indexState,
      worktree: artifactPathIdentity(meta.path, entry.file)
    })).digest("hex");
    return { path: entry.file, identity };
  }).sort((left, right) => left.path.localeCompare(right.path));
}
function captureArtifactBaseline(slug, scope) {
  const meta = readMeta(slug);
  if (!meta || !meta.path) throw new Error("prepare dispatch: shared-tree artifact mode requires a board project path.");
  const resolution = commitScope.validateScopeResolution(meta.path, [scope], { inspectDescendants: true });
  if (!resolution.ok) {
    const rejected = (resolution.indirect && resolution.indirect.length ? resolution.indirect : resolution.outside).join(", ");
    throw new Error(`prepare dispatch: artifact scope must be a direct path inside the board project: ${rejected}`);
  }
  try {
    return artifactWorkingState(slug);
  } catch (error) {
    const detail = error && error.message ? ` ${error.message}` : "";
    throw new Error(`prepare dispatch: shared-tree artifact mode requires a readable Git working tree.${detail}`);
  }
}
function artifactScopeCheck(slug, ticket, state) {
  if (!Array.isArray(state.artifactDirtyBaseline) || state.artifactDirtyBaseline.some((entry) => !entry || typeof entry.path !== "string" || typeof entry.identity !== "string")) {
    return {
      ok: false,
      reason: "artifact_baseline_missing",
      message: `${ticket.ref} has no content-aware dispatch-time dirty baseline. Release it and dispatch again before closing the artifact.`
    };
  }
  const approvedRoot = categoryArtifactRoot({ artifactRoots: [state.artifactRoot] }, state.artifactScope);
  if (!approvedRoot) {
    return {
      ok: false,
      reason: "artifact_scope_violation",
      message: `${ticket.ref} artifact scope is outside its dispatch-time approved root. Release it and dispatch again.`
    };
  }
  const meta = readMeta(slug);
  const resolution = meta && meta.path ? commitScope.validateScopeResolution(meta.path, [state.artifactScope], { inspectDescendants: true }) : { ok: false, reason: "scope_unavailable", indirect: [] };
  if (!resolution.ok) {
    const indirection = resolution.reason === "filesystem_indirection";
    return {
      ok: false,
      reason: indirection ? "artifact_scope_indirection" : "artifact_scope_unavailable",
      message: indirection ? `${ticket.ref} artifact scope contains filesystem indirection: ${resolution.indirect.join(", ")}. Replace it with direct in-project paths or release the ticket.` : `${ticket.ref} cannot resolve the shared-tree artifact scope directly inside the project. Release it and dispatch again.`,
      ...indirection ? { indirectPaths: resolution.indirect } : {}
    };
  }
  let current;
  try {
    current = artifactWorkingState(slug);
  } catch (_) {
    return {
      ok: false,
      reason: "artifact_scope_unavailable",
      message: `${ticket.ref} cannot verify the shared-tree artifact scope. Release it and dispatch again from a readable Git working tree.`
    };
  }
  const baseline = new Map(state.artifactDirtyBaseline.map((entry) => [dirtyPathKey(entry.path), entry]));
  const currentByPath = new Map(current.map((entry) => [dirtyPathKey(entry.path), entry]));
  const changed = /* @__PURE__ */ new Set();
  for (const entry of state.artifactDirtyBaseline) {
    if (commitScope.isInScope(entry.path, [state.artifactScope])) continue;
    const now = currentByPath.get(dirtyPathKey(entry.path));
    if (!now || now.identity !== entry.identity) changed.add(entry.path);
  }
  for (const entry of current) {
    if (!baseline.has(dirtyPathKey(entry.path)) && !commitScope.isInScope(entry.path, [state.artifactScope])) changed.add(entry.path);
  }
  const outside = Array.from(changed).sort();
  if (!outside.length) return { ok: true };
  return {
    ok: false,
    reason: "artifact_scope_violation",
    message: `${ticket.ref} changed paths outside artifact scope ${state.artifactScope}: ${outside.join(", ")}. Revert those changes or release the ticket instead of closing it.`,
    unscopedPaths: outside
  };
}
function activeDispatchRoute(ticket) {
  const state = dispatchState(ticket);
  if (!state || state.terminalAt || !ticket.dispatchNonce) return null;
  return normalizeRoute(state.route);
}
function rederiveUnlaunchedPreparedRoute(ticket, project) {
  const state = dispatchState(ticket);
  if (!state || state.recovery || state.terminalAt || state.outcome !== "prepared" || state.launchedAt || state.boundAt || state.claimedAt || !ticket.dispatchNonce) return;
  let requestedCategory = ticketCategory(ticket);
  if (requestedCategory == null && ticket.complexity != null) requestedCategory = legacyCategoryForComplexity(ticket.complexity);
  let category = requestedCategory == null ? null : getCategory(requestedCategory, { project });
  if (!category || !category.enabled) category = getCategory("general", { project });
  if (!category) return;
  const resolved = resolveCategoryRoute(category);
  ticket.model = resolved.model;
  ticket.effort = resolved.effort;
  ticket.exec = execProjection(resolved.exec);
}
function stampDispatchEvent(ticket, source, now) {
  ticket.lastEventType = "dispatch";
  ticket.lastEventSource = source || "store";
  ticket.updatedAt = now || (/* @__PURE__ */ new Date()).toISOString();
}
function pulseDispatchState(state) {
  if (!state) return null;
  if (state.terminalAt) return state.outcome || "terminal";
  if (state.claimedAt) return "claimed";
  if (state.boundAt) return "bound";
  if (state.launchedAt) return "launched";
  return state.outcome || "prepared";
}
function isolatedDispatchWorktreeMissing(state) {
  const worktree = String(state?.worktree || "").trim();
  return state?.sharedTree === false && Boolean(worktree) && !fs.existsSync(worktree);
}
function isolatedDispatchWithMissingWorktree(agentName) {
  const target = String(agentName || "").trim();
  if (!target) return null;
  for (const project of listProjects({ all: true })) {
    for (const ticket of listTickets(project.slug)) {
      const state = dispatchState(ticket);
      if (!state || state.agentName !== target || !isolatedDispatchWorktreeMissing(state)) continue;
      return { slug: project.slug, id: ticket.id, ref: ticket.ref, worktree: state.worktree };
    }
  }
  return null;
}
function terminalDispatchTarget(agentName) {
  const target = String(agentName || "").trim();
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
function terminalDispatchForIdle(identity) {
  const sessionId = String(identity?.sessionId || "").trim();
  const agentId = String(identity?.agentId || "").trim();
  const agentName = String(identity?.agentName || "").trim();
  const executor = String(identity?.executor || "").trim();
  if (!agentId && !agentName) return null;
  const candidates = [];
  for (const project of listProjects({ all: true })) {
    for (const ticket of listTickets(project.slug)) {
      const state = dispatchState(ticket);
      if (!state || !state.terminalAt || state.outcome === "scope_paused" || ticket.claim?.by) continue;
      const byId = Boolean(agentId && state.agentId && String(state.agentId) === agentId);
      const byName = Boolean(agentName && state.agentName && String(state.agentName) === agentName);
      if (!byId && !byName) continue;
      candidates.push({
        byId,
        corroboration: (sessionId && String(state.sessionId || "") === sessionId ? 1 : 0) + (executor && String(state.executor || "") === executor ? 1 : 0),
        match: { slug: project.slug, id: ticket.id, ref: ticket.ref, outcome: state.outcome, terminalAt: state.terminalAt }
      });
    }
  }
  const sole = soleIdleCandidate(candidates);
  return sole ? sole.match : null;
}
function soleIdleCandidate(candidates) {
  if (candidates.length < 2) return candidates[0] || null;
  for (const pool of [candidates.filter((candidate) => candidate.byId), candidates]) {
    if (!pool.length) continue;
    if (pool.length === 1) return pool[0];
    const best = pool.reduce((top, candidate) => Math.max(top, candidate.corroboration), 0);
    const narrowed = pool.filter((candidate) => candidate.corroboration === best);
    if (narrowed.length === 1) return narrowed[0];
  }
  return null;
}
function setDispatchTerminal(ticket, outcome, source) {
  const state = dispatchState(ticket);
  if (!state) return;
  state.outcome = outcome;
  state.terminalAt = (/* @__PURE__ */ new Date()).toISOString();
  state.terminalSource = source || "store";
  delete state.supersededTokens;
}
function reopenScopePausedDispatch(ticket, now) {
  if (!resumableScopePause(ticket)) return false;
  const state = dispatchState(ticket);
  state.outcome = "claimed";
  state.resumedAt = now || (/* @__PURE__ */ new Date()).toISOString();
  delete state.terminalAt;
  delete state.terminalSource;
  return true;
}
function appendReworkEvent(ticket, kind, details) {
  const dispatch = dispatchState(ticket);
  const route = dispatch && dispatch.route && typeof dispatch.route === "object" ? dispatch.route : {};
  const at = details.at || (/* @__PURE__ */ new Date()).toISOString();
  if (!Array.isArray(ticket.reworkEvents)) ticket.reworkEvents = [];
  ticket.reworkEvents.push({
    kind,
    at,
    source: details.source || "store",
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
      outcome: dispatch.outcome || null
    } : null
  });
}
function dispatchTokenDigest(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}
function isSupersededDispatchToken(ticket, token) {
  const state = dispatchState(ticket);
  if (!state || !token || token === ticket.dispatchNonce) return false;
  return Array.isArray(state.supersededTokens) && state.supersededTokens.some((entry) => entry.digest === dispatchTokenDigest(token));
}
function routingPolicyAffectsTicket(ticket, categoryIds) {
  if (!Array.isArray(categoryIds) || !categoryIds.length) return true;
  const affected = new Set(categoryIds.map(normalizeCategoryId));
  if (affected.has("general")) return true;
  let category = ticketCategory(ticket);
  if (category == null && ticket && ticket.complexity != null) category = legacyCategoryForComplexity(ticket.complexity);
  return category != null && affected.has(normalizeCategoryId(category));
}
function refreshPreparedDispatches(handle, projects, categoryIds) {
  const projectList = Array.from(new Set((projects || []).filter(Boolean)));
  const refreshed = { superseded: 0, stamped: 0 };
  if (!projectList.length) return refreshed;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  for (const project of projectList) {
    for (const row of handle.prepare("SELECT data FROM tickets WHERE project = ?").all(project)) {
      let ticket;
      try {
        ticket = JSON.parse(row.data);
      } catch (_) {
        continue;
      }
      if (!routingPolicyAffectsTicket(ticket, categoryIds)) continue;
      const state = dispatchState(ticket);
      if (!state || state.terminalAt || !ticket.dispatchNonce) continue;
      const active = Boolean(state.launchedAt || state.boundAt || state.claimedAt || ticket.claim && ticket.claim.by);
      if (active) {
        state.policyChangedAt = now;
        stampDispatchEvent(ticket, "routing-policy", now);
        db.putRow(handle, "tickets", ticketStorageRow(project, ticket));
        refreshed.stamped += 1;
        continue;
      }
      if (state.outcome !== "prepared") continue;
      const supersededTokens = Array.isArray(state.supersededTokens) ? state.supersededTokens.slice() : [];
      supersededTokens.push({
        digest: dispatchTokenDigest(ticket.dispatchNonce),
        tokenPrefix: dispatchTokenPrefix(ticket.dispatchNonce),
        at: now
      });
      state.supersededTokens = supersededTokens.slice(-8);
      const attempts = Array.isArray(state.attempts) ? state.attempts.slice() : [];
      attempts.push({
        route: normalizeRoute(state.route),
        executor: state.executor || ticket.dispatchExecutor,
        tokenPrefix: state.tokenPrefix || dispatchTokenPrefix(ticket.dispatchNonce),
        preparedAt: state.preparedAt || null,
        launchedAt: null,
        outcome: "policy-changed",
        terminalAt: now,
        terminalSource: "routing-policy"
      });
      state.attempts = attempts.slice(-8);
      state.outcome = "policy-changed";
      state.terminalAt = now;
      state.terminalSource = "routing-policy";
      state.policyChangedAt = now;
      delete state.executor;
      delete ticket.dispatchNonce;
      delete ticket.dispatchExecutor;
      stampDispatchEvent(ticket, "routing-policy", now);
      db.putRow(handle, "tickets", ticketStorageRow(project, ticket));
      refreshed.superseded += 1;
    }
  }
  return refreshed;
}
function expiredPreparedDispatch(state, now) {
  if (!state || state.outcome !== "prepared" || state.terminalAt || state.launchedAt || state.boundAt || state.claimedAt) return false;
  const preparedAt = Date.parse(state.preparedAt);
  return Number.isFinite(preparedAt) && now - preparedAt > preparedDispatchTtlMs();
}
function worktreeIsolationWarning(slug) {
  const meta = readMeta(slug);
  if (!meta || !meta.path) {
    return "Worktree isolation unavailable: board project path is unavailable; spawning in shared tree. Executor must scoped-commit immediately.";
  }
  if (!fs.existsSync(meta.path)) {
    return "Worktree isolation unavailable: project path does not exist; spawning in shared tree. Executor must scoped-commit immediately.";
  }
  try {
    const inside = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: meta.path,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    if (inside !== "true") {
      return "Worktree isolation unavailable: project is not a Git work tree; spawning in shared tree. Executor must scoped-commit immediately.";
    }
  } catch (error) {
    const reason = error && error.code === "ENOENT" ? "Git is not available" : "project is not a Git work tree";
    return `Worktree isolation unavailable: ${reason}; spawning in shared tree. Executor must scoped-commit immediately.`;
  }
  try {
    execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
      cwd: meta.path,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore"]
    });
    return null;
  } catch (_) {
    return "Worktree isolation unavailable: repo has no commits or HEAD cannot be resolved; spawning in shared tree. Executor must scoped-commit immediately.";
  }
}
function prepareDispatch(slug, idOrRef, opts) {
  opts = opts || {};
  if (!projectRoutingEnabled(slug)) throw new Error(routingDisabledMessage(idOrRef));
  const projectPath = readMeta(slug)?.path;
  if (projectPath) assertSidequestInstall(projectPath);
  assertDispatchTransport(opts.transport, { allowUnverifiedTransport: !!opts.allowUnverifiedTransport });
  const found = getTicket(slug, idOrRef);
  if (!found) throw new Error(`prepare dispatch: no ticket "${idOrRef}".`);
  return withTicketLock(slug, found.id, () => {
    const t = getTicket(slug, found.id);
    if (!t) throw new Error(`prepare dispatch: no ticket "${idOrRef}".`);
    if (t.claim && t.claim.by && !claimReclaimable(t)) {
      throw new Error(`prepare dispatch: ${t.ref} has a live claim by ${t.claim.by}. Release it (\`sidequest release ${t.ref} --by ${t.claim.by}\`) before dispatching again.`);
    }
    const current = dispatchState(t);
    rederiveUnlaunchedPreparedRoute(t, slug);
    const policyCategory = getCategory(ticketCategory(t), { project: slug });
    const resolvedPolicy = policyCategory && resolveCategoryRoute(policyCategory);
    if (!current?.recovery && resolvedPolicy) {
      t.model = resolvedPolicy.model;
      t.effort = resolvedPolicy.effort;
      t.exec = execProjection(resolvedPolicy.exec);
    }
    const currentRoute = activeDispatchRoute(t);
    const currentExec = currentRoute && resolveExec(currentRoute.model, currentRoute.effort);
    if (current && current.recovery && current.outcome === "prepared" && t.dispatchNonce && t.dispatchExecutor && currentExec && stableExecutorName(t) === t.dispatchExecutor) {
      if (opts.sessionId) current.sessionId = String(opts.sessionId);
      if (!current.launchSeq) current.launchSeq = 1;
      if (!current.launchName) current.launchName = dispatchLaunchName(t.ref, t.title, current.launchSeq);
      putTicket(slug, t);
      return {
        ok: true,
        ticket: t,
        token: t.dispatchNonce,
        reused: true,
        recovery: current.recovery
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
        effort: replacement.effort
      });
    }
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const backend = availableRoute(t.model);
    if (backend && backend.backend === "claude" && (t.effort == null || String(t.effort).trim() === "")) {
      t.effort = "low";
      t.exec = execProjection(resolveExec(t.model, t.effort));
    }
    const refusal = dispatchRouteRefusal({ model: t.model, effort: t.effort });
    if (refusal) throw new Error(refusal);
    const preparedExec = resolveExec(t.model, t.effort);
    if (!preparedExec) throw new Error(`prepare dispatch: ${t.ref} has no executable route.`);
    const fallbackReason = !current?.recovery && resolvedPolicy?.fallbackReason || null;
    const recovery = current && current.recovery && activeDispatchRoute(t) ? current.recovery : null;
    const attempts = current && Array.isArray(current.attempts) ? current.attempts.slice() : [];
    const supersededTokens = current && Array.isArray(current.supersededTokens) ? current.supersededTokens.slice() : [];
    if (current && !current.terminalAt && t.dispatchNonce) {
      supersededTokens.push({
        digest: dispatchTokenDigest(t.dispatchNonce),
        tokenPrefix: dispatchTokenPrefix(t.dispatchNonce),
        at: now
      });
    }
    t.dispatchNonce = crypto.randomBytes(24).toString("base64url");
    if (t.scopePauseRecovery && current?.outcome === "released") {
      t.scopePauseRecovery = Object.assign({}, t.scopePauseRecovery, { dispatchNonce: t.dispatchNonce });
    }
    const requestedSharedTree = Object.hasOwn(opts, "sharedTree") ? opts.sharedTree === true : Boolean(current && current.sharedTree);
    const worktreeIsolation = normalizeWorktreeIsolation(readMeta(slug)?.worktreeIsolation);
    let sharedTree = worktreeIsolation ? requestedSharedTree : true;
    const declaredFiles = normalizeFiles(t.files);
    const nonRepoOutput = nonRepoExternalOutput(t, declaredFiles);
    const worktreeWarning = !worktreeIsolation && Object.hasOwn(opts, "sharedTree") && requestedSharedTree === false ? "Board worktree isolation is disabled; explicit sharedTree:false was overridden. Spawning in shared tree. Executor must scoped-commit immediately." : !sharedTree && declaredFiles.length ? worktreeIsolationWarning(slug) : null;
    if (worktreeWarning) sharedTree = true;
    const category = getCategory(ticketCategory(t), { project: slug });
    const artifactRoot = sharedTree && declaredFiles.length === 1 && sharedTreeArtifactRequested(t) ? categoryArtifactRoot(category, declaredFiles[0]) : null;
    const artifactMode = Boolean(artifactRoot);
    const artifactScope = artifactMode ? declaredFiles[0] : null;
    const artifactDirtyBaseline = artifactMode ? captureArtifactBaseline(slug, artifactScope) : null;
    t.dispatchExecutor = stableExecutorName(t, artifactMode);
    const launchSeq = nextDispatchLaunchSeq(current);
    const readonly = dispatchReadOnly(t);
    const story = t.storyId ? getStory(slug, t.storyId) : null;
    const contract = storyExecutionContract(story);
    const contractDrift = t.storyContractDrift || null;
    const targetOverride = opts.integrationBranch != null || opts.integrationMode != null ? integrationTarget(slug, { branch: opts.integrationBranch, mode: opts.integrationMode }) : null;
    delete t.storyContractDrift;
    t.dispatch = {
      sessionId: opts.sessionId ? String(opts.sessionId) : null,
      sharedTree,
      ...worktreeWarning ? { worktreeWarning } : {},
      declaredFiles,
      // Where this run starts from, so a closeout can tell "wrote nothing" from
      // "committed and never submitted" — in a shared tree the executor's branch
      // IS the integration branch, so there is no other baseline (SQ-923).
      baseCommit: targetOverride ? integrationTargetCommit(readMeta(slug)?.path || "", targetOverride) : commitScope.headCommit(readMeta(slug)?.path || ""),
      ...targetOverride ? { integrationTarget: targetOverride } : {},
      readonly,
      ...nonRepoOutput ? { nonRepoOutput: true } : {},
      artifactMode,
      artifactRoot,
      artifactScope,
      ...artifactMode ? { artifactDirtyBaseline } : {},
      tokenPrefix: dispatchTokenPrefix(t.dispatchNonce),
      executor: t.dispatchExecutor,
      description: spawnDescription(t, preparedExec),
      launchSeq,
      launchName: dispatchLaunchName(t.ref, t.title, launchSeq),
      route: dispatchRouteState(t.model, t.effort, preparedExec),
      ...fallbackReason ? { fallbackReason } : {},
      storyContract: contract,
      ...contractDrift ? { storyContractDrift: Object.assign({}, contractDrift, { rebasedAt: now }) } : {},
      preparedAt: now,
      launchedAt: null,
      boundAt: null,
      claimedAt: null,
      terminalAt: null,
      outcome: "prepared",
      ...attempts.length ? { attempts } : {},
      ...supersededTokens.length ? { supersededTokens: supersededTokens.slice(-8) } : {},
      ...recovery ? { recovery } : {}
    };
    stampDispatchEvent(t, "dispatch", now);
    putTicket(slug, t);
    return { ok: true, ticket: t, token: t.dispatchNonce, recovery };
  });
}
function readDispatchBriefing(slug, idOrRef, token) {
  const ticket = getTicket(slug, idOrRef);
  if (!ticket) return { ok: false, reason: "not_found" };
  const state = dispatchState(ticket);
  if (!state || state.terminalAt || !ticket.dispatchNonce || token !== ticket.dispatchNonce) {
    return { ok: false, reason: "token" };
  }
  return { ok: true, ticket };
}
function recordDispatchLaunch(slug, idOrRef, opts) {
  opts = opts || {};
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: "not_found" };
  return withTicketLock(slug, found.id, () => {
    const t = getTicket(slug, found.id);
    if (!t || !t.dispatchNonce || opts.token !== t.dispatchNonce || opts.executor !== t.dispatchExecutor) {
      return { ok: false, reason: "not_prepared" };
    }
    const state = dispatchState(t);
    if (!state) return { ok: false, reason: "missing_state" };
    const now = (/* @__PURE__ */ new Date()).toISOString();
    state.sessionId = opts.sessionId ? String(opts.sessionId) : state.sessionId || null;
    state.agentName = opts.agentName ? String(opts.agentName) : state.agentName || null;
    state.launchedAt = state.launchedAt || now;
    state.outcome = "launched";
    stampDispatchEvent(t, opts.source || "dispatch", now);
    putTicket(slug, t);
    return { ok: true, ticket: t };
  });
}
function recoverDispatchQuotaFailure(slug, idOrRef, opts) {
  opts = opts || {};
  const failure = claudeQuotaFailure(opts.error);
  if (!failure) return { ok: false, reason: "unrecognized_failure" };
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: "not_found" };
  return withTicketLock(slug, found.id, () => {
    const t = getTicket(slug, found.id);
    if (!t || !t.dispatchNonce || opts.token !== t.dispatchNonce || opts.executor !== t.dispatchExecutor) {
      return { ok: false, reason: "not_prepared" };
    }
    if (t.claim && t.claim.by) return { ok: false, reason: "claimed" };
    const state = dispatchState(t);
    if (!state || state.outcome !== "launched" || state.terminalAt) return { ok: false, reason: "not_launched" };
    const failedRoute = normalizeRoute(state.route) || normalizeRoute({ model: t.model, effort: t.effort });
    const failedExec = failedRoute && resolveExec(failedRoute.model, failedRoute.effort);
    if (!failedExec || failedExec.backend !== "claude" || failedExec.runsModel !== failure.model) {
      return { ok: false, reason: "signature_route_mismatch" };
    }
    const fallback = resolveCategoryFallback(t.category, failedExec.runsModel);
    if (!fallback) return { ok: false, reason: "no_fallback" };
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const failedAttempt = {
      route: { model: failedExec.runsModel, effort: failedRoute.effort },
      executor: state.executor || t.dispatchExecutor,
      tokenPrefix: state.tokenPrefix || dispatchTokenPrefix(t.dispatchNonce),
      preparedAt: state.preparedAt || null,
      launchedAt: state.launchedAt || null,
      outcome: "quota_exhausted",
      terminalAt: now,
      terminalSource: opts.source || "agent-launch-failure",
      failure: { kind: "claude_quota_exhausted", signature: failure.signature }
    };
    const attempts = (Array.isArray(state.attempts) ? state.attempts : []).concat(failedAttempt).slice(-8);
    const supersededTokens = (Array.isArray(state.supersededTokens) ? state.supersededTokens : []).concat({
      digest: dispatchTokenDigest(t.dispatchNonce),
      tokenPrefix: dispatchTokenPrefix(t.dispatchNonce),
      at: now
    }).slice(-8);
    const recovery = {
      kind: "claude_quota_exhausted",
      failedModel: failedExec.runsModel,
      failedEffort: failedRoute.effort,
      fallbackSource: fallback.source,
      model: fallback.model,
      effort: fallback.effort,
      signature: failure.signature,
      at: now
    };
    t.dispatchNonce = crypto.randomBytes(24).toString("base64url");
    t.dispatchExecutor = fallback.exec.agent;
    t.model = fallback.model;
    t.effort = fallback.effort;
    t.exec = execProjection(fallback.exec);
    const launchSeq = nextDispatchLaunchSeq(state);
    t.dispatch = {
      sessionId: opts.sessionId ? String(opts.sessionId) : state.sessionId || null,
      sharedTree: state.sharedTree === true,
      declaredFiles: Array.isArray(state.declaredFiles) ? state.declaredFiles.slice() : normalizeFiles(t.files),
      artifactMode: state.artifactMode === true,
      artifactRoot: state.artifactRoot || null,
      artifactScope: state.artifactScope || null,
      ...Array.isArray(state.artifactDirtyBaseline) ? { artifactDirtyBaseline: state.artifactDirtyBaseline.slice() } : {},
      tokenPrefix: dispatchTokenPrefix(t.dispatchNonce),
      executor: t.dispatchExecutor,
      description: spawnDescription(t, fallback.exec),
      launchSeq,
      launchName: dispatchLaunchName(t.ref, t.title, launchSeq),
      route: dispatchRouteState(fallback.model, fallback.effort, fallback.exec),
      storyContract: state.storyContract || storyExecutionContract(t.storyId ? getStory(slug, t.storyId) : null),
      ...state.storyContractDrift ? { storyContractDrift: state.storyContractDrift } : {},
      preparedAt: now,
      launchedAt: null,
      boundAt: null,
      claimedAt: null,
      terminalAt: null,
      outcome: "prepared",
      attempts,
      supersededTokens,
      recovery
    };
    stampDispatchEvent(t, opts.source || "agent-launch-failure", now);
    putTicket(slug, t);
    return { ok: true, ticket: t, token: t.dispatchNonce, recovery };
  });
}
function dispatchIsolationExpectation(identity) {
  const sessionId = String(identity?.sessionId || "").trim();
  const executor = String(identity?.executor || "").trim();
  const agentId = String(identity?.agentId || "").trim();
  if (!agentId && !(sessionId && executor)) return null;
  const byAgent = [];
  const bySession = [];
  for (const project of listProjects({ all: true })) {
    for (const ticket of listTickets(project.slug)) {
      const state = dispatchState(ticket);
      if (!state) continue;
      const terminalWithoutClaim = Boolean(state.terminalAt && !(ticket.claim && ticket.claim.by));
      const candidate = {
        ref: ticket.ref,
        project: project.slug,
        projectPath: readMeta(project.slug)?.path || null,
        sharedTree: state.sharedTree !== false,
        terminal: terminalWithoutClaim,
        agentId: state.agentId ? String(state.agentId) : null
      };
      if (agentId && candidate.agentId === agentId) byAgent.push(candidate);
      else if (!terminalWithoutClaim && sessionId && executor && state.sessionId === sessionId && state.executor === executor) {
        bySession.push(candidate);
      }
    }
  }
  const matched = byAgent.length ? byAgent : bySession;
  if (!matched.length) return null;
  const expectation = matched[0];
  return {
    ref: expectation.ref,
    project: expectation.project,
    projectPath: expectation.projectPath,
    sharedTree: matched.some((candidate) => candidate.sharedTree),
    terminal: matched.some((candidate) => candidate.terminal),
    matchedBy: byAgent.length ? "agent" : "session",
    expectedWorktree: agentId && expectation.projectPath ? path.join(expectation.projectPath, ".claude", "worktrees", `agent-${agentId}`) : null
  };
}
function dispatchWorkspace(slug, ticket) {
  const state = dispatchState(ticket);
  const projectPath = readMeta(slug)?.path || null;
  if (!state || !projectPath) return null;
  const baseCommit = String(state.baseCommit || "").trim() || null;
  if (state.sharedTree !== false) return baseCommit ? { root: projectPath, base: baseCommit } : null;
  const agentId = String(state.agentId || "").trim();
  if (!agentId) return null;
  const root = path.join(projectPath, ".claude", "worktrees", `agent-${agentId}`);
  if (!fs.existsSync(root)) return null;
  let base = baseCommit;
  if (!base) {
    try {
      base = integrationTarget(slug)?.upstream || null;
    } catch (_) {
      base = null;
    }
  }
  return base ? { root, base } : null;
}
function dispatchDelta(slug, ticket) {
  const workspace = dispatchWorkspace(slug, ticket);
  if (!workspace) return { ok: false, reason: "workspace_unavailable" };
  try {
    const working = commitScope.workingPaths(workspace.root);
    const base = execFileSync("git", ["rev-parse", "--verify", `${workspace.base}^{commit}`], {
      cwd: workspace.root,
      encoding: "utf8",
      windowsHide: true
    }).trim();
    const head = execFileSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
      cwd: workspace.root,
      encoding: "utf8",
      windowsHide: true
    }).trim();
    const commits = base === head ? [] : execFileSync("git", ["rev-list", `${base}..${head}`], {
      cwd: workspace.root,
      encoding: "utf8",
      windowsHide: true
    }).trim().split(/\r?\n/).filter(Boolean);
    const committed = commits.length ? commitScope.rangePaths(workspace.root, commits) : [];
    return { ok: true, workspace, working, committed };
  } catch (error) {
    return { ok: false, reason: "git_error", message: error?.message || String(error) };
  }
}
function activeSharedTreeClaim(identity) {
  const agentId = String(identity?.agentId || "").trim();
  const executor = String(identity?.executor || "").trim();
  if (!agentId || !executor) return null;
  const matches = [];
  for (const project of listProjects({ all: true })) {
    const projectPath = readMeta(project.slug)?.path || null;
    for (const ticket of listTickets(project.slug)) {
      const state = dispatchState(ticket);
      if (!state || state.sharedTree !== true || state.terminalAt || !ticket.claim?.by) continue;
      if (String(state.agentId || "") !== agentId || String(state.executor || "") !== executor) continue;
      matches.push({ ref: ticket.ref, project: project.slug, projectPath });
    }
  }
  return matches.length === 1 ? matches[0] : null;
}
function dispatchIdentityAmbiguous(matches, agentName) {
  return matches.length > 1 && (!agentName || new Set(matches.map((match) => match.slug)).size > 1);
}
function dispatchCanBindRuntimeIdentity(state, sessionId, executor, agentId, agentName) {
  if (!state || state.sessionId !== sessionId || state.executor !== executor || state.outcome !== "launched") return false;
  if (agentName && state.agentName && state.agentName !== agentName) return false;
  if (agentId) return !state.agentId || state.agentId === agentId;
  return Boolean(agentName && state.agentName === agentName);
}
function recordDispatchRuntimeIdentity(slug, state, agentId, agentName, now) {
  if (agentId) state.agentId = agentId;
  if (agentName) state.agentName = agentName;
  if (state.sharedTree === false && agentId) {
    const projectPath = readMeta(slug)?.path;
    if (projectPath) state.worktree = path.join(projectPath, ".claude", "worktrees", `agent-${agentId}`);
  }
  state.boundAt = state.boundAt || now || (/* @__PURE__ */ new Date()).toISOString();
}
function bindDispatchAgent(sessionId, executor, agentId, agentName) {
  const normalizedSessionId = String(sessionId || "").trim();
  const normalizedExecutor = String(executor || "").trim();
  const normalizedAgentId = String(agentId || "").trim();
  const normalizedAgentName = String(agentName || "").trim();
  if (!normalizedSessionId || !normalizedExecutor || !normalizedAgentId && !normalizedAgentName) {
    return { ok: false, reason: "missing_identity" };
  }
  const matches = [];
  for (const project of listProjects({ all: true })) {
    for (const ticket of listTickets(project.slug)) {
      const state = dispatchState(ticket);
      if (!dispatchCanBindRuntimeIdentity(state, normalizedSessionId, normalizedExecutor, normalizedAgentId, normalizedAgentName)) continue;
      matches.push({ slug: project.slug, id: ticket.id });
    }
  }
  if (!matches.length || dispatchIdentityAmbiguous(matches, normalizedAgentName)) {
    return { ok: false, reason: matches.length ? "ambiguous" : "not_found" };
  }
  const tickets = [];
  for (const match of matches) {
    const result = withTicketLock(match.slug, match.id, () => {
      const t = getTicket(match.slug, match.id);
      const state = dispatchState(t);
      if (!dispatchCanBindRuntimeIdentity(state, normalizedSessionId, normalizedExecutor, normalizedAgentId, normalizedAgentName)) {
        return { ok: false };
      }
      const now = (/* @__PURE__ */ new Date()).toISOString();
      recordDispatchRuntimeIdentity(match.slug, state, normalizedAgentId, normalizedAgentName, now);
      stampDispatchEvent(t, "subagent-start", now);
      putTicket(match.slug, t);
      return { ok: true, ticket: t };
    });
    if (!result || !result.ok) return { ok: false, reason: "not_found" };
    tickets.push(result.ticket);
  }
  return { ok: true, ticket: tickets[0], tickets };
}
function dispatchMatchesStopIdentity(state, sessionId, executor, agentId, agentName) {
  if (!state || state.sessionId !== sessionId || state.executor !== executor) return false;
  if (agentName && state.agentName !== agentName) return false;
  if (!agentId) return agentName ? state.agentName === agentName : true;
  if (state.agentId) return state.agentId === agentId;
  return Boolean(agentName && state.agentName === agentName);
}
function markDispatchStopped(sessionId, executor, agentId, agentName) {
  const normalizedSessionId = String(sessionId || "").trim();
  const normalizedExecutor = String(executor || "").trim();
  const normalizedAgentId = String(agentId || "").trim();
  const normalizedAgentName = String(agentName || "").trim();
  if (!normalizedSessionId || !normalizedExecutor) return { ok: false, reason: "missing_identity" };
  const matches = [];
  for (const project of listProjects({ all: true })) {
    for (const ticket of listTickets(project.slug)) {
      const state = dispatchState(ticket);
      if (!dispatchMatchesStopIdentity(state, normalizedSessionId, normalizedExecutor, normalizedAgentId, normalizedAgentName)) continue;
      const active = state.outcome === "prepared" || state.outcome === "launched" || state.outcome === "claimed";
      if (active || state.terminalAt) matches.push({ slug: project.slug, id: ticket.id });
    }
  }
  if (!matches.length || dispatchIdentityAmbiguous(matches, normalizedAgentName)) {
    return { ok: false, reason: matches.length ? "ambiguous" : "not_found" };
  }
  const tickets = [];
  let stopped = false;
  for (const match of matches) {
    const result = withTicketLock(match.slug, match.id, () => {
      const t = getTicket(match.slug, match.id);
      const state = dispatchState(t);
      const active = Boolean(state && ["prepared", "launched", "claimed"].includes(state.outcome));
      if (!state || !active && !state.terminalAt || !dispatchMatchesStopIdentity(state, normalizedSessionId, normalizedExecutor, normalizedAgentId, normalizedAgentName)) {
        return { ok: false, reason: "not_found" };
      }
      const now = (/* @__PURE__ */ new Date()).toISOString();
      if (normalizedAgentId || normalizedAgentName) {
        recordDispatchRuntimeIdentity(match.slug, state, normalizedAgentId, normalizedAgentName, now);
      }
      if (active) {
        if (claimVerification(t)) {
          state.verifyStopAt = now;
          stampDispatchEvent(t, "subagent-stop-during-verify", now);
          putTicket(match.slug, t);
          return { ok: true, ticket: t, stopped: false, verifying: true };
        }
        if (t.scopeRequest) captureScopePauseRecovery(match.slug, t);
        setDispatchTerminal(t, t.claim && t.claim.by ? t.scopeRequest ? "scope_paused" : "stopped_claimed" : "failed", "subagent-stop");
        if (!t.claim || !t.claim.by) {
          t.dispatchNonce = null;
          t.dispatchExecutor = null;
        }
      }
      stampDispatchEvent(t, "subagent-stop", now);
      putTicket(match.slug, t);
      return { ok: true, ticket: t, stopped: active };
    });
    if (!result || !result.ok) return { ok: false, reason: "not_found" };
    stopped = stopped || result.stopped;
    tickets.push(result.ticket);
  }
  return { ok: true, ticket: tickets[0], tickets, stopped };
}
function reconcileLaunchedDispatches(sessionId, opts) {
  const reconciled = [];
  if (!sessionId) return { ok: true, reconciled };
  const source = opts && opts.source ? String(opts.source) : "session-start";
  for (const project of listProjects({ all: true })) {
    for (const ticket of listTickets(project.slug)) {
      const state = dispatchState(ticket);
      if (!state || state.sessionId !== String(sessionId) || state.outcome !== "launched" || state.boundAt || ticket.claim && ticket.claim.by) continue;
      const res = withTicketLock(project.slug, ticket.id, () => {
        const t = getTicket(project.slug, ticket.id);
        const current = dispatchState(t);
        if (!current || current.sessionId !== String(sessionId) || current.outcome !== "launched" || current.boundAt || t.claim && t.claim.by) {
          return { ok: false };
        }
        setDispatchTerminal(t, "failed", source);
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
const DIRECT_REASON_MIN_LENGTH = 20;
function isRoutedTicket(ticket) {
  return Boolean(ticket && ticket.model && ticket.effort && ticket.exec);
}
function directReason(reason) {
  const value = String(reason || "").trim();
  return value.length >= DIRECT_REASON_MIN_LENGTH ? value : null;
}
const INVALID_DIRECT_REASON_PATTERNS = [
  /context already loaded/i,
  /small change/i,
  /faster (?:myself|to do (?:it )?myself)/i,
  /(?:handoff|transfer) cost/i,
  /(?:needs?|requires?) (?:investigation|other[- ]file reading)/i,
  /(?:new behavior|new API(?: surface)?)/i,
  /failing test (?:does not|doesn't) pinpoint/i
];
function directReasonAllowed(reason) {
  return !INVALID_DIRECT_REASON_PATTERNS.some((pattern) => pattern.test(String(reason || "")));
}
function claimTicket(slug, idOrRef, by, opts) {
  opts = opts || {};
  by = String(by || "agent");
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: "not_found" };
  const result = withTicketLock(slug, found.id, () => {
    const t2 = getTicket(slug, found.id);
    if (!t2) return { ok: false, reason: "not_found" };
    const delay = testClaimLockDelayMs();
    if (delay) busyWait(delay);
    const directClaimReason = directReason(opts.reason);
    if (opts.direct && isRoutedTicket(t2) && !directClaimReason) return { ok: false, reason: "direct_reason_required", ticket: t2 };
    if (opts.direct && isRoutedTicket(t2) && !directReasonAllowed(directClaimReason)) return { ok: false, reason: "direct_not_allowed", ticket: t2, expectedExecutor: t2.dispatchExecutor || t2.exec?.agent || null };
    if (opts.direct && t2.dispatchNonce) return { ok: false, reason: "direct_conflict", ticket: t2 };
    if (!opts.direct && t2.dispatchNonce && opts.token !== t2.dispatchNonce) return { ok: false, reason: "token", ticket: t2 };
    if (!opts.direct && t2.dispatchNonce && opts.executor !== t2.dispatchExecutor) return { ok: false, reason: "executor_mismatch", ticket: t2, expectedExecutor: t2.dispatchExecutor };
    if (!opts.direct && isRoutedTicket(t2) && !t2.dispatchNonce) return { ok: false, reason: "dispatch_required", ticket: t2 };
    if (t2.status === "done") return { ok: false, reason: "done", ticket: t2 };
    const currentDispatch = dispatchState(t2);
    if (currentDispatch?.resumedAt && isolatedDispatchWorktreeMissing(currentDispatch)) return { ok: false, reason: "worktree_missing", ticket: t2 };
    if (pendingSubmission(t2) && !opts.force) return { ok: false, reason: "submitted", ticket: t2, submission: t2.submission };
    const held2 = t2.claim;
    if (held2 && held2.by && held2.by !== by && !claimReclaimable(t2) && !opts.force) {
      return { ok: false, reason: "claimed", ticket: t2, claim: held2 };
    }
    const now = (/* @__PURE__ */ new Date()).toISOString();
    t2.claim = { by, at: now };
    if (t2.storyId) {
      const story = getStory(slug, t2.storyId);
      if (story) t2.storyLogSeenSeq = Number(story.logRevision) || 0;
    }
    t2.claimRelease = null;
    if (opts.direct && isRoutedTicket(t2)) {
      t2.directClaim = {
        by,
        at: now,
        model: t2.model,
        effort: t2.effort,
        executor: opts.executor ? String(opts.executor) : null,
        source: opts.source ? String(opts.source) : "store",
        reason: directReason(opts.reason)
      };
    }
    const state = dispatchState(t2);
    if (state) {
      state.sessionId = opts.sessionId ? String(opts.sessionId) : state.sessionId || null;
      state.claimedAt = now;
      state.outcome = "claimed";
    }
    const previousStatus = t2.status;
    if (opts.status !== false) t2.status = coerceStatus(opts.status || "doing", t2.status);
    if (t2.status !== previousStatus) t2.statusTransition = { from: previousStatus, to: t2.status, at: now };
    if (state) stampDispatchEvent(t2, opts.source || "cli", now);
    else {
      t2.lastEventType = "status";
      t2.lastEventSource = opts.source ? String(opts.source) : "cli";
      t2.updatedAt = now;
    }
    putTicket(slug, t2);
    if (opts.sessionId) registerWorker(opts.sessionId, slug, t2.id, by);
    queueEventNotification(slug, t2, t2.lastEventType, t2.lastEventSource);
    return { ok: true, ticket: t2 };
  });
  if (result.reason !== "busy" || opts.force) return result;
  const t = getTicket(slug, found.id);
  const held = t && t.claim;
  if (held && held.by && held.by !== by && !claimReclaimable(t)) {
    return { ok: false, reason: "claimed", ticket: t, claim: held };
  }
  return result;
}
function nullableText(value) {
  const text = value == null ? "" : String(value).trim();
  return text || null;
}
function oracleMarker(dispatch, opts, at) {
  const ask = nullableText(opts && opts.oracle);
  if (!ask) return null;
  const round = Number(dispatch && dispatch.launchSeq);
  if (!Number.isInteger(round) || round < 1) {
    throw new Error("oracle release requires an active dispatched round");
  }
  return {
    round,
    at,
    candidate: nullableText(opts && opts.candidate),
    deliverable: nullableText(opts && opts.deliverable),
    ask
  };
}
function clearOracleMarker(ticket) {
  if (!ticket || !ticket.oracle) return false;
  ticket.oracle = null;
  return true;
}
function releaseTicket(slug, idOrRef, by, opts) {
  opts = opts || {};
  by = String(by || "agent");
  const releaseComment = opts.releaseComment ? prepareComment(opts.releaseComment) : null;
  if (releaseComment && !releaseComment.ok) throw new Error(`release comment ${releaseComment.reason}`);
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: "not_found" };
  return withTicketLock(slug, found.id, () => {
    const t = getTicket(slug, found.id);
    if (!t) return { ok: false, reason: "not_found" };
    if (t.status === "done" && !opts.force) {
      const completion = t.completion;
      const key = completion && [t.id, completion.claimAt || completion.at, by, "done"].join(":");
      if (opts.status === "done" && completion && completion.key === key && completion.by === by && completion.state === "done") {
        const comment2 = Array.isArray(t.comments) && completion.commentId ? t.comments.find((entry) => entry.id === completion.commentId) || null : null;
        return { ok: true, idempotent: true, ticket: t, comment: comment2 };
      }
      return { ok: false, reason: "done", ticket: t };
    }
    let reopenedSubmission = null;
    if (opts.status && pendingSubmission(t)) {
      const reopenStatus = coerceStatus(opts.status, t.status);
      if (reopenStatus !== "done") {
        if (!opts.force) {
          return {
            ok: false,
            reason: "pending_submission",
            ticket: t,
            submission: t.submission,
            message: `${t.ref} has a pending submission (commit ${String(t.submission.commit).slice(0, 12)}) parked READY_FOR_INTEGRATION. release cannot move it to "${reopenStatus}" and leave the submission in place. CLI: pass --force to reject the submission and reopen in one step, or run \`sidequest submit ${t.ref} --clear --status ${reopenStatus}\` first. MCP: \`submit\` with \`clear:true, status:"${reopenStatus}"\` (release has no force param over MCP).`
          };
        }
        reopenedSubmission = t.submission;
      }
    }
    const controlPlaneDone = opts.status === "done" && opts.completionAuthority === CONTROL_PLANE_COMPLETION;
    const executorDone = opts.status === "done" && !controlPlaneDone;
    const dispatch = dispatchState(t);
    const artifactDispatch = sharedTreeArtifactMode(t);
    const declaredFiles = dispatch && Array.isArray(dispatch.declaredFiles) ? dispatch.declaredFiles : normalizeFiles(t.files);
    const held = t.claim;
    const liveClaim = Boolean(held && held.by);
    const activeDispatch = Boolean(t.dispatchNonce || dispatch && !dispatch.terminalAt);
    const activeArtifactDispatch = artifactDispatch && liveClaim && activeDispatch;
    const activeNonRepoOutput = dispatch?.nonRepoOutput === true && liveClaim && activeDispatch;
    const activeReadOnlyDispatch = dispatch?.readonly === true && liveClaim && activeDispatch;
    let sharedTreeCommittedScope = false;
    if (executorDone && liveClaim && activeDispatch) {
      const delta = dispatchDelta(slug, t);
      if (!delta.ok && dispatch?.sharedTree === true && dispatch?.baseCommit) {
        return {
          ok: false,
          reason: "dispatch_delta_unavailable",
          message: `${t.ref} cannot inspect the full dispatch delta before done closeout. Restore the dispatch worktree or release the ticket and dispatch again.`,
          ticket: t
        };
      }
      if (delta.ok && !activeArtifactDispatch) {
        const scopedCommitted = delta.committed.filter((file) => commitScope.isInScope(file, declaredFiles));
        sharedTreeCommittedScope = dispatch?.sharedTree === true && scopedCommitted.length > 0;
        const scopedWorking = delta.working.filter((file) => commitScope.isInScope(file, declaredFiles));
        const scopedChanges = activeReadOnlyDispatch ? Array.from(/* @__PURE__ */ new Set([...scopedWorking, ...scopedCommitted])) : [];
        if (scopedChanges.length) {
          const paths = scopedChanges.sort();
          const mode = activeReadOnlyDispatch ? "read-only dispatch" : "declared scope";
          return {
            ok: false,
            reason: "done_scope_violation",
            message: `${t.ref} cannot close with done: ${mode} has dirty or committed paths inside its declared scope since dispatch base: ${paths.join(", ")}. Scoped-commit work that belongs to this ticket after a scope request, or restore the paths that do not.`,
            ticket: t,
            unscopedPaths: paths
          };
        }
      }
    }
    if (executorDone && activeArtifactDispatch) {
      const scopeCheck = artifactScopeCheck(slug, t, dispatch);
      if (!scopeCheck.ok) return Object.assign({ ticket: t }, scopeCheck);
    }
    if (executorDone && !liveClaim && t.claimRelease) {
      return {
        ok: false,
        reason: "claim_released",
        message: autoReleasedClaimMessage(t.ref, t.claimRelease),
        ticket: t,
        claimRelease: t.claimRelease
      };
    }
    const provenNoOp = opts.cleanDeclaredScope === true;
    if (executorDone && dispatch && declaredFiles.length && !provenNoOp && !sharedTreeCommittedScope && !activeReadOnlyDispatch && !activeArtifactDispatch && !activeNonRepoOutput) {
      return {
        ok: false,
        reason: "submission_required",
        message: `${t.ref} has routed repository write scope. Its executor must commit and submit verified changes. A read-only dispatch may close with done, but readonly:false selects this write path. A run that changed nothing closes here by itself once the board can see its worktree, so this refusal means the change is real or the worktree is unreadable. If the only declared output is outside the repo worktree, release it for reclassification as non-repo/artifact work; do not retry commit.`,
        ticket: t
      };
    }
    if (held && held.by && held.by !== by && !claimReclaimable(t) && !opts.force) {
      return { ok: false, reason: "not_owner", ticket: t, claim: held };
    }
    const oracleRequested = nullableText(opts.oracle);
    if (oracleRequested && coerceStatus(opts.status || t.status, t.status) !== "doing") {
      throw new Error("oracle release must keep the ticket in doing");
    }
    if (oracleRequested && t.oracle) {
      throw new Error("ticket already awaits an oracle verdict");
    }
    if (oracleRequested) oracleMarker(dispatch, opts, null);
    if (opts.requireReleaseVerdict && !claimReleaseVerdict(t)) {
      return {
        ok: false,
        reason: "claim_live",
        message: `${t.ref} is still live-claimed by "${held && held.by}"; the sweep re-checked it under the lock and left it alone.`,
        ticket: t,
        claim: held
      };
    }
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const previousStatus = t.status;
    if (resumableScopePause(t)) captureScopePauseRecovery(slug, t);
    let comment = null;
    if (releaseComment) {
      if (!Array.isArray(t.comments)) t.comments = [];
      comment = createComment(releaseComment, now);
      t.comments.push(comment);
    }
    clearScopeRequestMarker(t);
    t.scopeRequest = null;
    if (oracleRequested) t.oracle = oracleMarker(dispatch, opts, now);
    t.claim = null;
    if (opts.claimRelease) {
      t.claimRelease = Object.assign({ by, at: now, source: opts.source || "store" }, opts.claimRelease);
    }
    setDispatchTerminal(t, opts.status === "done" ? "done" : "released", opts.source || "cli");
    t.dispatchNonce = null;
    t.dispatchExecutor = null;
    if (reopenedSubmission) t.submission = null;
    if (opts.status) t.status = coerceStatus(opts.status, t.status);
    if (t.status !== previousStatus) t.statusTransition = { from: previousStatus, to: t.status, at: now };
    if (t.status === "todo" && (previousStatus !== "todo" || held && held.by)) {
      appendReworkEvent(t, "released_to_todo", {
        at: now,
        source: opts.source || "cli",
        by,
        fromStatus: previousStatus,
        toStatus: t.status
      });
    }
    if (reopenedSubmission) {
      appendReworkEvent(t, "submission_cleared", {
        at: now,
        source: opts.source || "cli",
        by,
        fromStatus: previousStatus,
        toStatus: t.status
      });
    }
    if (opts.workedBy) t.workedBy = opts.workedBy;
    if (t.status === "done") {
      t.completion = {
        key: [t.id, held && held.at ? held.at : now, by, "done"].join(":"),
        by,
        state: "done",
        claimAt: held && held.at ? held.at : null,
        at: now,
        commentId: null,
        ...opts.completionProvenance || {}
      };
      if (opts.completionComment) {
        if (!Array.isArray(t.comments)) t.comments = [];
        comment = createComment(opts.completionComment, now);
        t.comments.push(comment);
        t.completion.commentId = comment.id;
      }
    }
    if (t.status === "done" && pendingSubmission(t)) {
      t.submission = Object.assign({}, t.submission, { integratedAt: (/* @__PURE__ */ new Date()).toISOString() });
    }
    if (dispatch) stampDispatchEvent(t, opts.source || "cli", now);
    else {
      t.lastEventType = "status";
      t.lastEventSource = opts.source ? String(opts.source) : "cli";
      t.updatedAt = now;
    }
    putTicket(slug, t);
    if (opts.sessionId) unregisterClaim(opts.sessionId, slug, t.id);
    queueEventNotification(slug, t, t.lastEventType, t.lastEventSource);
    if (comment) queueEventNotification(slug, t, "comment", comment.source, { commentBody: comment.body });
    return {
      ok: true,
      ticket: t,
      comment,
      ...reopenedSubmission ? { clearedSubmission: reopenedSubmission } : {},
      ...opts.completionComment && opts.completionComment.advisory ? { advisory: opts.completionComment.advisory } : {}
    };
  });
}
function makeWorkedBy(input) {
  if (!input) return null;
  const rawModel = input.model;
  if (rawModel == null || String(rawModel).trim() === "") return null;
  const model = normalizeReportedModel(rawModel) || (input.allowUnavailable ? String(rawModel).trim().toLowerCase() : null);
  if (!model || !input.allowUnavailable && !availableRoute(model)) {
    throw new Error(`invalid model "${rawModel}" — expected an available Claude runtime or discovered Codex model`);
  }
  let effort = null;
  const rawEffort = input.effort;
  if (rawEffort != null && String(rawEffort).trim() !== "") {
    const e = String(rawEffort).trim().toLowerCase();
    if (VALID_EFFORTS.indexOf(e) === -1) {
      throw new Error(`invalid effort "${rawEffort}" — expected one of: ${VALID_EFFORTS.join(", ")} (or omit for none)`);
    }
    effort = e;
  }
  const by = input.by != null && String(input.by).trim() ? String(input.by).trim() : null;
  const at = input.at && Number.isFinite(Date.parse(input.at)) ? new Date(input.at).toISOString() : (/* @__PURE__ */ new Date()).toISOString();
  return { model, effort, by, at };
}
function completeTicket(slug, idOrRef, by, opts) {
  opts = opts || {};
  const ticket = getTicket(slug, idOrRef);
  const dispatched = resolvedDispatchRoute(ticket);
  const omittedProvenance = (opts.model == null || String(opts.model).trim() === "") && (opts.effort == null || String(opts.effort).trim() === "");
  const workedBy = makeWorkedBy({
    model: omittedProvenance && dispatched ? dispatched.model : opts.model,
    effort: omittedProvenance && dispatched ? dispatched.effort : opts.effort,
    by,
    allowUnavailable: Boolean(ticket && opts.model != null && normalizeRouteModel(opts.model) === normalizeRouteModel(ticket.model))
  });
  let completionComment = null;
  if (opts.body != null && String(opts.body).trim()) {
    completionComment = prepareComment({ by, body: opts.body, kind: "comment", source: opts.source || "cli" });
    if (!completionComment.ok) {
      throw new Error(`completion comment ${completionComment.reason}`);
    }
  }
  return releaseTicket(slug, idOrRef, by, Object.assign({}, opts, {
    status: "done",
    workedBy,
    completionComment
  }));
}
function recordedReviewPass(ticket) {
  return Array.isArray(ticket?.comments) && ticket.comments.some((comment) => /^\s*reviewed-by\s*:\s*\S/i.test(String(comment?.body || "")));
}
const HIGH_STAKES_REVIEW_WARNING = "high-stakes ticket integrated without a recorded review pass";
function completeTicketAsControlPlane(slug, idOrRef, opts) {
  opts = opts || {};
  const purpose = String(opts.purpose || "").trim();
  if (!["grooming", "integration"].includes(purpose)) {
    throw new Error('control-plane completion requires purpose "grooming" or "integration".');
  }
  const ticket = getTicket(slug, idOrRef);
  if (!ticket) return { ok: false, reason: "not_found" };
  const state = dispatchState(ticket);
  if (purpose === "grooming") {
    if (ticket.claim && ticket.claim.by && !claimReclaimable(ticket) || ticket.dispatchNonce || state && !state.terminalAt) {
      const holder = ticket.claim && ticket.claim.by ? String(ticket.claim.by) : "<claim holder>";
      return {
        ok: false,
        reason: "active_dispatch",
        message: `${ticket.ref} still has a live claim or an open dispatch, so grooming cannot close it. Release it first: \`sidequest release ${ticket.ref} --by ${holder}\`, then re-run this closure with the same evidence. Releasing does not discard work already committed.`,
        ticket
      };
    }
    if (pendingSubmission(ticket)) return { ok: false, reason: "pending_submission", ticket };
  }
  if (purpose === "integration" && !pendingSubmission(ticket)) {
    return {
      ok: false,
      reason: "submission_required",
      message: `${ticket.ref} has no submission to consume, so an integration closure has nothing to integrate. A submission only exists after its executor ran commit and then submit. When the work shipped outside that flow — the usual case is the orchestrator committing an executor's changes out of the shared tree after it lost its worktree — release the claim (\`sidequest release ${ticket.ref} --by <claim holder>\`) and close it as plain grooming with the shipped commit as evidence, without --integration.`,
      ticket
    };
  }
  const reason = String(opts.reason || "").trim();
  if (!reason) return { ok: false, reason: "evidence_required", ticket };
  const by = String(opts.by || "").trim();
  if (!by) return { ok: false, reason: "identity_required", ticket };
  let legacyScopeOverride = false;
  if (purpose === "integration") {
    const admitted = validateIntegrationSubmission(slug, idOrRef, opts);
    if (!admitted.ok) return admitted;
    legacyScopeOverride = !!admitted.legacyScopeOverride;
  }
  const advisory = purpose === "integration" && ticket.highStakes && !recordedReviewPass(ticket) ? HIGH_STAKES_REVIEW_WARNING : null;
  const result = completeTicket(slug, idOrRef, by, Object.assign({}, opts, {
    body: reason,
    source: `control-plane-${purpose}`,
    completionAuthority: CONTROL_PLANE_COMPLETION,
    completionProvenance: Object.assign(
      { authority: "control-plane", purpose, reason },
      legacyScopeOverride ? { legacyScopeOverride: { reason } } : {}
    )
  }));
  return advisory ? Object.assign(result, { advisory }) : result;
}
function closeTicketForGrooming(slug, idOrRef, opts) {
  return completeTicketAsControlPlane(slug, idOrRef, Object.assign({}, opts, { purpose: "grooming" }));
}
const SUBMISSION_COMMIT_RE = /^[0-9a-f]{7,64}$/i;
const SUBMISSION_GITREF_MAX = 200;
const SUBMISSION_WORKTREE_MAX = 500;
const DEFAULT_CHECKPOINT_TTL_MIN = 60;
const MAX_CHECKPOINT_TTL_MIN = 24 * 60;
const CHECKPOINT_VERIFY_MAX = 4e3;
const CHECKPOINT_VERIFY_EXCERPT_MAX = 500;
function checkpointTtlMs(ttlMinutes) {
  const minutes = ttlMinutes == null ? DEFAULT_CHECKPOINT_TTL_MIN : Number(ttlMinutes);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_CHECKPOINT_TTL_MIN) {
    throw new Error(`checkpoint TTL must be an integer from 1 to ${MAX_CHECKPOINT_TTL_MIN} minutes`);
  }
  return minutes * 60 * 1e3;
}
function checkpointProjection(ticket, now) {
  const checkpoint = ticket && ticket.checkpoint;
  if (!checkpoint) return null;
  const atMs = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const expiresMs = Date.parse(checkpoint.expiresAt);
  let state = "expired";
  if (Number.isFinite(expiresMs) && expiresMs > atMs) {
    if (pendingSubmission(ticket)) state = "submitted";
    else if (ticket.status === "done") state = "completed";
    else {
      const claim = ticket.claim;
      if (!claim || !claim.by) state = "recoverable";
      else state = claim.by === checkpoint.by ? "active" : "resumed";
    }
  }
  const verify = boundedExcerpt(String(checkpoint.verify || ""), CHECKPOINT_VERIFY_EXCERPT_MAX);
  return {
    id: checkpoint.id,
    state,
    by: checkpoint.by,
    at: checkpoint.at,
    expiresAt: checkpoint.expiresAt,
    ttlMinutes: checkpoint.ttlMinutes,
    kind: checkpoint.kind || "review",
    commit: checkpoint.commit || null,
    gitRef: checkpoint.gitRef || null,
    failure: checkpoint.failure || null,
    worktree: checkpoint.worktree || null,
    verify: verify.text,
    verifyLength: verify.length,
    verifyTruncated: verify.truncated
  };
}
function oracleProjection(ticket) {
  const oracle = ticket && ticket.oracle;
  if (!oracle) return null;
  const round = Number(oracle.round);
  const at = nullableText(oracle.at);
  const candidate = nullableText(oracle.candidate);
  const deliverable = nullableText(oracle.deliverable);
  const ask = nullableText(oracle.ask);
  if (!Number.isInteger(round) || round < 1 || !at || !ask) return null;
  const summary = [
    `awaiting oracle since ${at}`,
    `round ${round}`,
    candidate ? `candidate ${candidate}` : null,
    `ask: ${ask.replace(/\s+/g, " ")}`
  ].filter(Boolean).join(", ");
  return { round, at, candidate, deliverable, ask, summary };
}
function checkpointCommentBody(checkpoint) {
  const candidate = [
    checkpoint.commit ? `commit ${checkpoint.commit}` : null,
    checkpoint.worktree ? `worktree ${checkpoint.worktree}` : null
  ].filter(Boolean).join(", ");
  return `Live review checkpoint ${checkpoint.id}
Candidate: ${candidate}
Verification: ${checkpoint.verify}
Expires: ${checkpoint.expiresAt}`;
}
function checkpointTicket(slug, idOrRef, by, opts) {
  opts = opts || {};
  by = String(by || "agent");
  const commit = opts.commit == null || String(opts.commit).trim() === "" ? null : String(opts.commit).trim().toLowerCase();
  if (commit && !SUBMISSION_COMMIT_RE.test(commit)) {
    throw new Error(`invalid commit "${opts.commit}": pass the verified commit's hex hash (7-64 chars)`);
  }
  const worktree = opts.worktree == null || String(opts.worktree).trim() === "" ? null : String(opts.worktree).trim();
  if (worktree && (!path.isAbsolute(worktree) || worktree.length > SUBMISSION_WORKTREE_MAX)) {
    throw new Error(`checkpoint worktree must be an absolute path no longer than ${SUBMISSION_WORKTREE_MAX} characters`);
  }
  if (!commit && !worktree) throw new Error("checkpoint requires a commit hash or absolute worktree path");
  const verify = String(opts.verify || "").trim();
  if (!verify) throw new Error("checkpoint verification evidence is required");
  if (verify.length > CHECKPOINT_VERIFY_MAX) throw new Error(`checkpoint verification evidence exceeds ${CHECKPOINT_VERIFY_MAX} characters`);
  const ttlMs = checkpointTtlMs(opts.ttlMinutes);
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: "not_found" };
  return withTicketLock(slug, found.id, () => {
    const t = getTicket(slug, found.id);
    if (!t) return { ok: false, reason: "not_found" };
    if (t.status === "done") return { ok: false, reason: "done", ticket: t };
    if (pendingSubmission(t)) return { ok: false, reason: "submitted", ticket: t, submission: t.submission };
    const held = t.claim;
    if (!held || !held.by) return { ok: false, reason: "not_claimed", ticket: t };
    if (held.by !== by) return { ok: false, reason: "not_owner", ticket: t, claim: held };
    const nowMs = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now();
    const now = new Date(nowMs).toISOString();
    const checkpoint = {
      id: `cp_${crypto.randomBytes(8).toString("hex")}`,
      by,
      at: now,
      expiresAt: new Date(nowMs + ttlMs).toISOString(),
      ttlMinutes: ttlMs / 6e4,
      kind: opts.kind === "submission_rejected" ? "submission_rejected" : "review",
      commit,
      gitRef: opts.gitRef == null ? null : String(opts.gitRef).trim().slice(0, SUBMISSION_GITREF_MAX),
      failure: opts.failure && typeof opts.failure === "object" ? {
        reason: String(opts.failure.reason || "").trim(),
        message: String(opts.failure.message || "").trim()
      } : null,
      worktree,
      verify
    };
    const body = opts.commentBody == null ? checkpointCommentBody(checkpoint) : String(opts.commentBody);
    const prepared = prepareComment({ by, body, source: opts.source || "cli" });
    if (!prepared.ok) throw new Error(`checkpoint comment ${prepared.reason}`);
    const comment = createComment(prepared, now);
    if (!Array.isArray(t.comments)) t.comments = [];
    t.comments.push(comment);
    t.checkpoint = checkpoint;
    t.claim = Object.assign({}, held, { activeAt: now });
    t.lastEventType = "comment";
    t.lastEventSource = comment.source;
    t.updatedAt = now;
    putTicket(slug, t);
    queueEventNotification(slug, t, "comment", comment.source, { commentBody: comment.body });
    return { ok: true, ticket: t, checkpoint: checkpointProjection(t, nowMs), comment };
  });
}
function submissionUnscopedPaths(paths) {
  return Array.from(new Set((Array.isArray(paths) ? paths : []).map((value) => String(value || "").trim().replace(/\\/g, "/")).filter(Boolean)));
}
function submissionReadiness(submission) {
  const unscopedPaths = submissionUnscopedPaths(submission?.unscopedPaths);
  if (!unscopedPaths.length) return { ok: true, state: "ready", reason: null, unscopedPaths };
  return {
    ok: false,
    state: "partial",
    reason: "unscoped_paths",
    unscopedPaths,
    message: `PARTIAL: scope-gated paths remain outside this submission: ${unscopedPaths.join(", ")}.`
  };
}
function submissionProjection(submission) {
  if (!submission) return null;
  return Object.assign({}, submission, { readiness: submissionReadiness(submission) });
}
function submissionRangeMetadata(range, commit) {
  if (!range) return null;
  const base = String(range.base || "").trim().toLowerCase();
  const upstream = String(range.upstream || "").trim();
  const upstreamCommit = String(range.upstreamCommit || "").trim().toLowerCase();
  const commits = Array.isArray(range.commits) ? range.commits.map((value) => String(value).trim().toLowerCase()) : [];
  const changedPaths = Array.isArray(range.changedPaths) ? range.changedPaths.map((value) => String(value).trim().replace(/\\/g, "/")).filter(Boolean) : [];
  const integrationMode = range.integrationMode == null ? null : String(range.integrationMode).trim().toLowerCase();
  const integrationBranch = range.integrationBranch == null ? null : normalizeIntegrationBranch(range.integrationBranch);
  if (!SUBMISSION_COMMIT_RE.test(base) || !upstream || !SUBMISSION_COMMIT_RE.test(upstreamCommit) || !commits.length || commits.some((value) => !SUBMISSION_COMMIT_RE.test(value)) || commits[commits.length - 1] !== commit || integrationMode != null && !["local", "remote"].includes(integrationMode)) {
    throw new Error("invalid submission range metadata");
  }
  return Object.assign(
    { base, upstream, upstreamCommit, commits, changedPaths },
    integrationMode ? { integrationMode } : {},
    integrationBranch ? { integrationBranch } : {}
  );
}
function pendingSubmission(t) {
  return !!(t && t.submission && t.submission.commit && !t.submission.integratedAt);
}
function submissionGitRef(ticket) {
  return `refs/sidequest/${ticket.ref}`;
}
function integrationGit(repo, args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function integrationGitError(error) {
  return String(error?.stderr || error?.message || error || "").trim();
}
function integrationVerifyLogPath(slug, ticket) {
  const safeRef = String(ticket.ref || ticket.id || "submission").replace(/[^a-zA-Z0-9._-]/g, "_");
  const dir = path.join(projectDir(slug), "verification", safeRef);
  ensureDir(dir);
  return path.join(dir, `${Date.now()}-${crypto.randomBytes(4).toString("hex")}.log`);
}
function integrationVerifyOutputTail(logPath) {
  const size = fs.statSync(logPath).size;
  const length = Math.min(size, INTEGRATION_VERIFY_OUTPUT_TAIL_BYTES);
  if (!length) return "";
  const fd = fs.openSync(logPath, "r");
  try {
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    return `${size > length ? "[output truncated]\n" : ""}${buffer.toString("utf8")}`.trim();
  } finally {
    fs.closeSync(fd);
  }
}
function verifyDeliveredSubmission(slug, ticket, opts) {
  const command = String(ticket.submission?.verify || "").trim();
  if (opts?.skipVerify === true) return { status: "skipped", skippedByChoice: true, command: command || null };
  if (!command) return { status: "none", command: null };
  const validationError = verifyCommandError(command);
  if (validationError) return { status: "invalid", command, error: validationError };
  if (manualVerify(command)) return { status: "manual", command, manual: command.slice(MANUAL_VERIFY_PREFIX.length).trim() };
  const timeoutMs = normalizeIntegrationVerifyTimeoutMs(boardConfig(slug)?.integrationVerifyTimeoutMs);
  const logPath = integrationVerifyLogPath(slug, ticket);
  const fd = fs.openSync(logPath, "w");
  let result;
  try {
    result = spawnSync(command, {
      cwd: readMeta(slug)?.path,
      shell: true,
      timeout: timeoutMs,
      windowsHide: true,
      stdio: ["ignore", fd, fd]
    });
  } finally {
    fs.closeSync(fd);
  }
  const outputTail = integrationVerifyOutputTail(logPath);
  const timedOut = result?.error?.code === "ETIMEDOUT";
  if (timedOut) return { status: "timeout", command, timeoutMs, logPath, outputTail };
  if (result?.status === 0) return { status: "passed", command, timeoutMs, logPath, outputTail };
  return {
    status: "failed",
    command,
    exitCode: typeof result?.status === "number" ? result.status : null,
    logPath,
    outputTail,
    error: result?.error ? String(result.error.message || result.error) : null
  };
}
function verificationFailureComment(verify) {
  const outcome = verify.status === "timeout" ? `timed out after ${verify.timeoutMs}ms` : `exited ${verify.exitCode ?? "without an exit code"}`;
  return [
    `Integration verification ${outcome}.`,
    `Command: ${verify.command}`,
    `Log: ${verify.logPath}`,
    verify.outputTail ? `Output tail:
${verify.outputTail}` : null
  ].filter(Boolean).join("\n");
}
function verifyIntegration(slug, idOrRef, opts) {
  const ticket = getTicket(slug, idOrRef);
  if (!ticket || !ticket.submission?.integration || ticket.submission.integration.outcome !== "delivered") {
    return { ok: false, reason: "delivery_required", ticket };
  }
  const verify = ticket.submission.integration?.verify || verifyDeliveredSubmission(slug, ticket, opts);
  const accepted = ["passed", "none", "skipped", "manual"].includes(verify.status);
  const stored = updateSubmissionIntegration(slug, ticket.id, { verify, outcome: accepted ? "verified" : "verify_failed" });
  if (!stored.ok) return stored;
  if (accepted) return { ok: true, ticket: stored.ticket, verify };
  const comment = addComment(slug, ticket.id, { by: String(opts?.by || "orchestrator"), source: "integration", body: verificationFailureComment(verify) });
  return { ok: false, reason: "verify_failed", ticket: comment.ticket || stored.ticket, verify };
}
function changedIntegrationPaths(repo, submission) {
  if (Array.isArray(submission.changedPaths) && submission.changedPaths.length) return submission.changedPaths.slice();
  return integrationGit(repo, ["diff", "--name-only", submission.base, submission.commit]).split(/\r?\n/).filter(Boolean);
}
function validateIntegrationSubmission(slug, idOrRef, opts) {
  const ticket = getTicket(slug, idOrRef);
  if (!ticket) return { ok: false, reason: "not_found" };
  if (!pendingSubmission(ticket)) {
    return { ok: false, reason: "submission_required", ticket, message: `${ticket.ref} has no submission to integrate.` };
  }
  const readiness = submissionReadiness(ticket.submission);
  if (!readiness.ok) {
    return {
      ok: false,
      reason: readiness.reason,
      ticket,
      submissionReadiness: readiness,
      message: `${ticket.ref} integration refused; ${readiness.message}`
    };
  }
  const project = readMeta(slug);
  const scopeValidation = commitScope.validateStoredSubmissionRange(project?.path, ticket.submission);
  const legacyScopeOverride = opts?.overrideLegacyScope === true && scopeValidation.reason === "missing_scope_snapshot";
  if (!scopeValidation.ok && !legacyScopeOverride) {
    const outside = Array.isArray(scopeValidation.outside) ? scopeValidation.outside : [];
    return {
      ok: false,
      reason: scopeValidation.reason,
      outside,
      ticket,
      scopeValidation,
      message: scopeValidation.reason === "missing_scope_snapshot" ? `${ticket.ref} submission has no admitted scope snapshot. Re-submit it, or pass the explicit legacy scope override with a recorded reason.` : `${ticket.ref} integration refused; submitted range changes paths outside its admitted scope: ${outside.join(", ")}.`
    };
  }
  return { ok: true, ticket, scopeValidation, legacyScopeOverride };
}
function updateSubmissionIntegration(slug, id, patch) {
  return withTicketLock(slug, id, () => {
    const ticket = getTicket(slug, id);
    if (!ticket || !ticket.submission) return { ok: false, reason: "submission_required", ticket };
    ticket.submission.integration = Object.assign({}, ticket.submission.integration || {}, patch);
    ticket.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    putTicket(slug, ticket);
    queueEventNotification(slug, ticket, "status", "integration");
    return { ok: true, ticket };
  });
}
function integrationFailure(slug, ticket, patch) {
  updateSubmissionIntegration(slug, ticket.id, Object.assign({ outcome: "failed", completedAt: (/* @__PURE__ */ new Date()).toISOString() }, patch));
  return Object.assign({ ok: false, ticket: getTicket(slug, ticket.id) }, patch);
}
function integrateSubmission(slug, idOrRef, opts) {
  opts = opts || {};
  const admitted = validateIntegrationSubmission(slug, idOrRef, opts);
  if (!admitted.ok) return admitted;
  const preflight = verifyDeliveredSubmission(slug, admitted.ticket, opts);
  const acceptedPreflight = ["passed", "none", "skipped", "manual"].includes(preflight.status);
  if (!acceptedPreflight) {
    return {
      ok: false,
      reason: "verify_failed",
      ticket: admitted.ticket,
      verify: preflight,
      message: `${admitted.ticket.ref} integration refused before merge: ${preflight.error || `verification ${preflight.status}`}.`
    };
  }
  const prepared = updateSubmissionIntegration(slug, admitted.ticket.id, { verify: preflight, preflightAt: (/* @__PURE__ */ new Date()).toISOString() });
  if (!prepared.ok) return prepared;
  const ticket = prepared.ticket;
  const project = readMeta(slug);
  const repo = project?.path;
  const mode = normalizeDeliveryMode(opts.mode);
  const target = opts.target;
  if (!repo || !target || !target.branch) return { ok: false, reason: "integration_target_unavailable", ticket };
  const submission = ticket.submission;
  const gitRef = String(submission.gitRef || submissionGitRef(ticket));
  let pinnedCommit;
  let changedPaths;
  try {
    pinnedCommit = integrationGit(repo, ["rev-parse", "--verify", `${gitRef}^{commit}`]).toLowerCase();
    if (pinnedCommit !== String(submission.commit).toLowerCase()) {
      return { ok: false, reason: "pinned_ref_mismatch", ticket, message: `${gitRef} points to ${pinnedCommit}, not submitted ${submission.commit}.` };
    }
    changedPaths = changedIntegrationPaths(repo, submission);
  } catch (error) {
    return { ok: false, reason: "pinned_ref_missing", ticket, message: `${gitRef} is unavailable: ${integrationGitError(error)}` };
  }
  const recorded = updateSubmissionIntegration(slug, ticket.id, {
    mode,
    targetBranch: target.branch,
    targetUpstream: target.upstream,
    pinnedRef: gitRef,
    pinnedCommit,
    changedPaths,
    recordedAt: (/* @__PURE__ */ new Date()).toISOString(),
    outcome: "pending"
  });
  if (!recorded.ok) return recorded;
  try {
    const currentBranch = integrationGit(repo, ["branch", "--show-current"]);
    if (currentBranch !== target.branch) {
      return integrationFailure(slug, ticket, { reason: "branch_not_checked_out", message: `${target.branch} must be checked out before integration; currently on ${currentBranch || "detached HEAD"}.` });
    }
    const dirty = integrationGit(repo, ["diff", "--name-only"]).split(/\r?\n/).filter(Boolean);
    const staged = integrationGit(repo, ["diff", "--cached", "--name-only"]).split(/\r?\n/).filter(Boolean);
    const untracked = integrationGit(repo, ["ls-files", "--others", "--exclude-standard"]).split(/\r?\n/).filter(Boolean);
    const dirtyPaths = Array.from(/* @__PURE__ */ new Set([...dirty, ...staged]));
    if (mode === "apply") {
      const overlap = Array.from(/* @__PURE__ */ new Set([...dirtyPaths, ...untracked])).filter((entry) => changedPaths.includes(entry));
      if (overlap.length) {
        return integrationFailure(slug, ticket, { reason: "dirty_overlap", dirtyPaths: overlap, message: `apply refused; uncommitted changes overlap submitted paths: ${overlap.join(", ")}.` });
      }
    } else if (dirtyPaths.length) {
      return integrationFailure(slug, ticket, { reason: "checkout_dirty", dirtyPaths, message: `${mode} refused; the integration checkout has uncommitted changes: ${dirtyPaths.join(", ")}.` });
    }
    const before = integrationGit(repo, ["rev-parse", "HEAD"]);
    const commits = Array.isArray(submission.commits) && submission.commits.length ? submission.commits : [submission.commit];
    if (mode === "merge") {
      try {
        integrationGit(repo, ["merge", "--no-ff", "--no-edit", pinnedCommit]);
      } catch (error) {
        try {
          integrationGit(repo, ["merge", "--abort"]);
        } catch (_) {
        }
        return integrationFailure(slug, ticket, { reason: "merge_failed", message: integrationGitError(error), before });
      }
    } else {
      for (const commit of commits) {
        try {
          integrationGit(repo, ["cherry-pick", ...mode === "apply" ? ["--no-commit"] : [], commit]);
        } catch (error) {
          try {
            integrationGit(repo, ["cherry-pick", "--abort"]);
          } catch (_) {
          }
          if (mode === "replay") {
            try {
              integrationGit(repo, ["reset", "--hard", before]);
            } catch (_) {
            }
          }
          return integrationFailure(slug, ticket, {
            reason: `${mode}_failed`,
            failedCommit: commit,
            before,
            message: integrationGitError(error)
          });
        }
      }
    }
    const resultingHead = integrationGit(repo, ["rev-parse", "HEAD"]);
    const deliveredFiles = mode === "apply" ? Array.from(/* @__PURE__ */ new Set([
      ...integrationGit(repo, ["diff", "--name-only"]).split(/\r?\n/).filter(Boolean),
      ...integrationGit(repo, ["diff", "--cached", "--name-only"]).split(/\r?\n/).filter(Boolean)
    ])) : changedPaths;
    const result = updateSubmissionIntegration(slug, ticket.id, {
      outcome: "delivered",
      deliveredAt: (/* @__PURE__ */ new Date()).toISOString(),
      resultingHead,
      dirtyFiles: mode === "apply" ? deliveredFiles : [],
      deliveredFiles
    });
    return result.ok ? { ok: true, ticket: result.ticket, integration: result.ticket.submission.integration } : result;
  } catch (error) {
    return integrationFailure(slug, ticket, { reason: "integration_error", message: integrationGitError(error) });
  }
}
function submitTicket(slug, idOrRef, by, opts) {
  opts = opts || {};
  by = String(by || "agent");
  const submissionComment = opts.submissionComment ? prepareComment(opts.submissionComment) : null;
  if (submissionComment && !submissionComment.ok) throw new Error(`submission comment ${submissionComment.reason}`);
  const commit = String(opts.commit || "").trim().toLowerCase();
  if (!SUBMISSION_COMMIT_RE.test(commit)) {
    throw new Error(`invalid commit "${opts.commit}" — pass the verified commit's hex hash (7-64 chars)`);
  }
  const gitRef = opts.gitRef != null && String(opts.gitRef).trim() ? String(opts.gitRef).trim().slice(0, SUBMISSION_GITREF_MAX) : null;
  const verify = opts.verify != null && String(opts.verify).trim() ? String(opts.verify).trim().slice(0, EXECUTOR_VERIFY_MAX) : null;
  const worktree = opts.worktree != null && String(opts.worktree).trim() ? String(opts.worktree).trim().slice(0, SUBMISSION_WORKTREE_MAX) : null;
  const range = submissionRangeMetadata(opts.range, commit);
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: "not_found" };
  return withTicketLock(slug, found.id, () => {
    const t = getTicket(slug, found.id);
    if (!t) return { ok: false, reason: "not_found" };
    if (t.status === "done") return { ok: false, reason: "done", ticket: t };
    const held = t.claim;
    if (held && held.by && held.by !== by && !claimReclaimable(t) && !opts.force) {
      return { ok: false, reason: "not_owner", ticket: t, claim: held };
    }
    if ((!held || !held.by) && !opts.force) {
      return {
        ok: false,
        reason: "not_claimed",
        ticket: t,
        ...t.claimRelease ? { claimRelease: t.claimRelease, message: autoReleasedClaimMessage(t.ref, t.claimRelease) } : {}
      };
    }
    const readiness = submissionReadiness({ unscopedPaths: opts.unscopedPaths });
    if (!readiness.ok) {
      return {
        ok: false,
        reason: readiness.reason,
        ticket: t,
        submissionReadiness: readiness,
        message: `submit: refused ${t.ref}; ${readiness.message} Request scope, include every blocked path in a complete commit, then submit again.`
      };
    }
    const submittedAt = (/* @__PURE__ */ new Date()).toISOString();
    let comment = null;
    if (submissionComment) {
      if (!Array.isArray(t.comments)) t.comments = [];
      comment = createComment(submissionComment, submittedAt);
      t.comments.push(comment);
    }
    t.submission = Object.assign({
      by,
      at: submittedAt,
      commit,
      gitRef: gitRef || submissionGitRef(t),
      verify,
      worktree,
      admittedScope: effectiveScope(slug, t.files),
      unscopedPaths: submissionUnscopedPaths(opts.unscopedPaths),
      integratedAt: null
    }, range || {});
    const dispatch = dispatchState(t);
    const previousStatus = t.status;
    clearScopeRequestMarker(t);
    t.scopeRequest = null;
    delete t.scopePauseRecovery;
    t.claim = null;
    setDispatchTerminal(t, "submitted", opts.source || "cli");
    t.dispatchNonce = null;
    t.dispatchExecutor = null;
    t.status = "doing";
    if (t.status !== previousStatus) t.statusTransition = { from: previousStatus, to: t.status, at: submittedAt };
    if (dispatch) stampDispatchEvent(t, opts.source || "cli", submittedAt);
    else {
      t.lastEventType = "status";
      t.lastEventSource = opts.source ? String(opts.source) : "cli";
      t.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    }
    putTicket(slug, t);
    if (opts.sessionId) unregisterClaim(opts.sessionId, slug, t.id);
    queueEventNotification(slug, t, t.lastEventType, t.lastEventSource);
    if (comment) queueEventNotification(slug, t, "comment", comment.source, { commentBody: comment.body });
    return { ok: true, ticket: t, comment, ...submissionComment?.advisory ? { advisory: submissionComment.advisory } : {} };
  });
}
function clearSubmission(slug, idOrRef, opts) {
  opts = opts || {};
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: "not_found" };
  return withTicketLock(slug, found.id, () => {
    const t = getTicket(slug, found.id);
    if (!t) return { ok: false, reason: "not_found" };
    if (!t.submission) return { ok: false, reason: "no_submission", ticket: t };
    const cleared = t.submission;
    const previousStatus = t.status;
    const now = (/* @__PURE__ */ new Date()).toISOString();
    t.submission = null;
    if (opts.status) t.status = coerceStatus(opts.status, t.status);
    if (t.status !== previousStatus) t.statusTransition = { from: previousStatus, to: t.status, at: now };
    appendReworkEvent(t, "submission_cleared", {
      at: now,
      source: opts.source || "cli",
      fromStatus: previousStatus,
      toStatus: t.status
    });
    t.lastEventType = "status";
    t.lastEventSource = opts.source ? String(opts.source) : "cli";
    t.updatedAt = now;
    putTicket(slug, t);
    queueEventNotification(slug, t, t.lastEventType, t.lastEventSource);
    return { ok: true, ticket: t, cleared };
  });
}
function submissionBaseCandidates(slug, idOrRef, opts) {
  const excluded = idOrRef == null ? null : getTicket(slug, idOrRef);
  const integratedOnly = !!(opts && opts.integratedOnly);
  const commits = /* @__PURE__ */ new Set();
  for (const ticket of listTickets(slug)) {
    if (excluded && ticket.id === excluded.id) continue;
    const submission = ticket.submission;
    const commit = String(submission && submission.commit || "").trim().toLowerCase();
    const rangeCommits = submission && Array.isArray(submission.commits) ? submission.commits : [];
    if (!submission || !SUBMISSION_COMMIT_RE.test(commit) || !SUBMISSION_COMMIT_RE.test(String(submission.base || "")) || !rangeCommits.length || String(rangeCommits[rangeCommits.length - 1]).trim().toLowerCase() !== commit) continue;
    if (integratedOnly && !submission.integratedAt) continue;
    commits.add(commit);
  }
  return Array.from(commits);
}
function submissionsPayload(slug) {
  const tickets = listTickets(slug).filter((t) => !t.archived && t.status !== "done" && pendingSubmission(t)).sort((a, b) => String(a.submission.at).localeCompare(String(b.submission.at))).map((t) => ({
    ref: t.ref,
    title: t.title,
    status: t.status,
    files: Array.isArray(t.files) ? t.files : [],
    executorVerify: t.executorVerify || null,
    submission: submissionProjection(t.submission)
  }));
  return { tickets, count: tickets.length, delivery: boardConfig(slug)?.delivery || "merge" };
}
function sweepStaleDispatches(opts) {
  opts = opts || {};
  const source = opts.source ? String(opts.source) : "sweep";
  const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now();
  const expired = [];
  for (const project of listProjects({ all: true })) {
    if (opts.project && project.slug !== opts.project) continue;
    for (const ticket of listTickets(project.slug)) {
      if (ticket.archived || ticket.status === "done" || !expiredPreparedDispatch(dispatchState(ticket), now)) continue;
      try {
        const res = withTicketLock(project.slug, ticket.id, () => {
          const current = getTicket(project.slug, ticket.id);
          if (!current || !expiredPreparedDispatch(dispatchState(current), now)) return { ok: false };
          setDispatchTerminal(current, "expired", source);
          current.dispatchNonce = null;
          current.dispatchExecutor = null;
          stampDispatchEvent(current, source);
          putTicket(project.slug, current);
          return { ok: true, ticket: current };
        });
        if (!res || !res.ok) continue;
        expired.push({ project: project.slug, ref: res.ticket.ref });
        addComment(project.slug, ticket.id, {
          by: "sidequest",
          kind: "comment",
          source,
          body: `Auto-expired prepared dispatch: it never launched within the ${Math.round(preparedDispatchTtlMs() / 36e5)} hour TTL.`
        });
      } catch (_) {
      }
    }
  }
  return { ok: true, ttlMs: preparedDispatchTtlMs(), expired };
}
function sweepStaleClaims(opts) {
  opts = opts || {};
  const source = opts.source ? String(opts.source) : "sweep";
  const released = [];
  for (const project of listProjects({ all: true })) {
    if (opts.project && project.slug !== opts.project) continue;
    for (const ticket of listTickets(project.slug)) {
      if (ticket.archived || ticket.status === "done") continue;
      const verdict = claimReleaseVerdict(ticket);
      if (!verdict) continue;
      try {
        const res = releaseTicket(project.slug, ticket.id, ticket.claim.by, {
          status: "todo",
          source,
          requireReleaseVerdict: true,
          claimRelease: { kind: verdict.kind, reason: verdict.reason, idleMs: Number.isFinite(verdict.idleMs) ? verdict.idleMs : null }
        });
        if (!res.ok) continue;
        released.push({ project: project.slug, ref: ticket.ref, kind: verdict.kind });
        addComment(project.slug, ticket.id, {
          by: "sidequest",
          kind: "comment",
          source,
          body: claimReleaseNote(ticket, verdict)
        });
      } catch (_) {
      }
    }
  }
  const dispatches = sweepStaleDispatches(opts);
  return { ok: true, idleMs: claimIdleMs(), abandonMs: claimAbandonMs(), released, expiredDispatches: dispatches.expired };
}
function modelMatches(ticketModel, want) {
  return !want || ticketModel === want;
}
function readyTickets(slug, opts) {
  opts = opts || {};
  const want = opts.model ? classifyModelFilter(opts.model) : "any";
  if (want === "unknown") throw new Error(`Unknown model: ${opts.model}`);
  const category = opts.category == null ? null : String(opts.category).trim().toLowerCase();
  return listTickets(slug).filter((t) => !t.archived).filter((t) => t.status !== "done").filter((t) => !pendingSubmission(t)).filter((t) => !t.claim || claimReclaimable(t)).filter((t) => !isBlocked(slug, t)).filter((t) => modelMatches(t.model, want === "any" ? null : want)).filter((t) => !category || t.categoryId === category).sort((a, b) => {
    const pr = priorityRank(a.priority) - priorityRank(b.priority);
    if (pr !== 0) return pr;
    return String(a.createdAt).localeCompare(String(b.createdAt));
  });
}
function claimNext(slug, by, opts) {
  opts = opts || {};
  by = String(by || "agent");
  const want = opts.model ? classifyModelFilter(opts.model) : "any";
  if (want === "unknown") throw new Error(`Unknown model: ${opts.model}`);
  const category = opts.category == null ? null : String(opts.category).trim().toLowerCase();
  const candidates = listTickets(slug).filter((t) => !t.archived).filter((t) => t.status !== "done").filter((t) => !pendingSubmission(t)).filter((t) => !t.claim || claimReclaimable(t) || t.claim.by === by).filter((t) => !opts.priority || t.priority === String(opts.priority).toLowerCase()).filter((t) => modelMatches(t.model, want === "any" ? null : want)).filter((t) => !category || t.categoryId === category).filter((t) => opts.includeBlocked || !isBlocked(slug, t)).sort((a, b) => {
    const pr = priorityRank(a.priority) - priorityRank(b.priority);
    if (pr !== 0) return pr;
    return String(a.createdAt).localeCompare(String(b.createdAt));
  });
  for (const cand of candidates) {
    const res = claimTicket(slug, cand.id, by, { direct: !!opts.direct, reason: opts.reason, source: opts.source, sessionId: opts.sessionId });
    if (res.ok || res.reason === "direct_not_allowed" || res.reason === "direct_reason_required") return res;
  }
  return { ok: false, reason: "empty" };
}
function assignTicket(slug, idOrRef, assignee, opts) {
  opts = opts || {};
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: "not_found" };
  return withTicketLock(slug, found.id, () => {
    const t = getTicket(slug, found.id);
    if (!t) return { ok: false, reason: "not_found" };
    t.assignee = normalizeAssignee(assignee);
    t.lastEventType = "edit";
    t.lastEventSource = opts.source ? String(opts.source) : "cli";
    t.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    putTicket(slug, t);
    return { ok: true, ticket: t };
  });
}
function newStoryId() {
  return "st_" + Date.now().toString(36) + "_" + crypto.randomBytes(4).toString("hex");
}
function listStories(slug) {
  const out = db.listRows(database(), "stories", { project: slug }).filter((s) => s && s.id);
  out.sort((a, b) => (a.order || 0) - (b.order || 0));
  return out;
}
function getStory(slug, idOrRef) {
  const wanted = String(idOrRef);
  const wantedRef = wanted.toUpperCase();
  for (const s of listStories(slug)) {
    if (s.id === wanted || String(s.ref).toUpperCase() === wantedRef) return s;
  }
  return null;
}
function coerceStoryId(slug, val) {
  if (val == null) return null;
  const s = String(val).trim();
  if (!s || s.toLowerCase() === "none" || s.toLowerCase() === "null") return null;
  const story = getStory(slug, s);
  return story ? story.id : null;
}
const STORY_EXECUTION_CONTRACT_MAX_BYTES = 4 * 1024;
const STORY_DECISION_LOG_MAX_BYTES = 4 * 1024;
const STORY_LOG_ENTRY_TEXT_MAX_BYTES = 280;
const STORY_LOG_KINDS = /* @__PURE__ */ new Set(["DECISION", "CONSTRAINT", "DISCOVERY"]);
function normalizeStoryExecutionContract(value) {
  if (value == null) return null;
  const contract = String(value).trim();
  if (!contract) return null;
  const bytes = Buffer.byteLength(contract, "utf8");
  if (bytes > STORY_EXECUTION_CONTRACT_MAX_BYTES) {
    throw new Error(`story execution contract exceeds the ${STORY_EXECUTION_CONTRACT_MAX_BYTES}-byte limit.`);
  }
  return contract;
}
function storyExecutionContract(story) {
  if (!story || !story.executionContract) return null;
  return {
    revision: Number(story.contractRevision) || 1,
    body: String(story.executionContract)
  };
}
function normalizeStoryLogEntry(value) {
  const raw = value && typeof value === "object" ? value.text ?? value.entry ?? value.body : value;
  let text = String(raw == null ? "" : raw).replace(/\s*[\r\n]+\s*/g, " ").trim();
  const prefixed = text.match(/^(DECISION|CONSTRAINT|DISCOVERY)\s*:\s*/i);
  const explicitKind = value && typeof value === "object" && value.kind != null ? String(value.kind).trim().toUpperCase() : null;
  const kind = explicitKind || (prefixed?.[1]?.toUpperCase() ?? null);
  if (!kind || !STORY_LOG_KINDS.has(kind)) {
    throw new Error("story log entry kind must be DECISION, CONSTRAINT, or DISCOVERY.");
  }
  if (prefixed && (!explicitKind || explicitKind === prefixed?.[1]?.toUpperCase())) {
    text = text.slice(prefixed[0].length).trim();
  }
  if (!text) throw new Error("story log entry text is required.");
  if (Buffer.byteLength(text, "utf8") > STORY_LOG_ENTRY_TEXT_MAX_BYTES) {
    throw new Error(`story log entry text exceeds the ${STORY_LOG_ENTRY_TEXT_MAX_BYTES}-byte limit.`);
  }
  return { kind, text };
}
function storyDecisionLogEntries(story) {
  if (!story || !Array.isArray(story.decisionLog)) return [];
  return story.decisionLog.filter((entry) => entry && Number.isInteger(Number(entry.seq)) && STORY_LOG_KINDS.has(String(entry.kind))).map((entry) => ({
    seq: Number(entry.seq),
    at: String(entry.at),
    by: String(entry.by),
    ref: entry.ref == null ? null : String(entry.ref),
    kind: String(entry.kind),
    text: String(entry.text)
  }));
}
function renderStoryDecisionLog(story, entries) {
  const log = entries || storyDecisionLogEntries(story);
  if (!log.length) return "";
  const lastEntry = log[log.length - 1];
  const lastSeq = Number(story && story.logRevision) || lastEntry?.seq;
  const countLabel = `${log.length} ${log.length === 1 ? "entry" : "entries"}`;
  return [
    `## Story decision log (${story?.ref}, ${countLabel} through #${lastSeq})`,
    "Findings appended by sibling executors on this story. The contract above outranks these.",
    ...log.map((entry) => `- #${entry.seq} ${entry.kind} (${entry.ref || "orchestrator"}, ${entry.by}): ${entry.text}`)
  ].join("\n");
}
function storyDecisionLog(story) {
  const entries = storyDecisionLogEntries(story);
  return {
    revision: Number(story && story.logRevision) || 0,
    entries,
    bytes: Buffer.byteLength(renderStoryDecisionLog(story, entries), "utf8"),
    capacity: STORY_DECISION_LOG_MAX_BYTES
  };
}
function storyLogClaimRefusal(story, ticketRef, by) {
  return `story log: ${ticketRef} is not claimed by "${by}", or it is not a member of ${story.ref}. Append from a ticket you hold, or use story_contract.`;
}
function appendStoryLogEntry(slug, storyRef, value) {
  const normalized = normalizeStoryLogEntry(value);
  return transaction(() => {
    const story = getStory(slug, storyRef);
    if (!story) throw new Error(`story log: ${storyRef} was not found.`);
    const by = String(value && typeof value === "object" ? value.by || "orchestrator" : "orchestrator").trim() || "orchestrator";
    const requestedRef = value && typeof value === "object" && value.ref != null ? String(value.ref).trim() : "";
    let ticketRef = null;
    if (requestedRef) {
      const ticket = getTicket(slug, requestedRef);
      ticketRef = ticket ? ticket.ref : requestedRef;
      if (!ticket || ticket.storyId !== story.id || !ticket.claim || ticket.claim.by !== by || claimReclaimable(ticket)) {
        throw new Error(storyLogClaimRefusal(story, ticketRef, by));
      }
    }
    const entries = storyDecisionLogEntries(story);
    const seq = (Number(story.logRevision) || 0) + 1;
    const entry = {
      seq,
      at: (/* @__PURE__ */ new Date()).toISOString(),
      by,
      ref: ticketRef,
      kind: normalized.kind,
      text: normalized.text
    };
    const nextEntries = [...entries, entry];
    if (Buffer.byteLength(renderStoryDecisionLog(Object.assign({}, story, { logRevision: seq }), nextEntries), "utf8") > STORY_DECISION_LOG_MAX_BYTES) {
      throw new Error(`story log: ${story.ref} decision log is full (${STORY_DECISION_LOG_MAX_BYTES} bytes, ${entries.length} entries). Condense it into the story execution contract with story_contract, then clear with story_log --clear.`);
    }
    story.decisionLog = nextEntries;
    story.logRevision = seq;
    story.updatedAt = entry.at;
    putStory(slug, story);
    return story;
  });
}
function clearStoryLog(slug, storyRef) {
  return transaction(() => {
    const story = getStory(slug, storyRef);
    if (!story) return null;
    story.decisionLog = [];
    story.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    putStory(slug, story);
    return story;
  });
}
function storyDecisionLogWarnings(ticket, slug) {
  if (!ticket || !ticket.storyId || !slug) return [];
  const story = getStory(slug, ticket.storyId);
  if (!story) return [];
  const seenSeq = Number(ticket.storyLogSeenSeq) || 0;
  const lastSeq = Number(story.logRevision) || 0;
  if (lastSeq <= seenSeq) return [];
  const gained = lastSeq - seenSeq;
  const firstSeq = seenSeq + 1;
  const range = firstSeq === lastSeq ? `#${firstSeq}` : `#${firstSeq}-#${lastSeq}`;
  const noun = gained === 1 ? "entry" : "entries";
  const pronoun = gained === 1 ? "it is" : "they are";
  return [`Dispatch warning: ${story.ref} decision log gained ${gained} ${noun} (${range}) since ${ticket.ref} was claimed; ${pronoun} not in its briefing.`];
}
function markStoryContractDrift(slug, story, fromRevision, changedAt) {
  const toRevision = Number(story && story.contractRevision) || 0;
  for (const ticket of listTickets(slug)) {
    if (ticket.storyId !== story.id || !ticket.claim || !ticket.claim.by || claimReclaimable(ticket)) continue;
    ticket.storyContractDrift = {
      storyRef: story.ref,
      fromRevision: Number(fromRevision) || 0,
      toRevision,
      changedAt
    };
    ticket.lastEventType = "story-contract";
    ticket.lastEventSource = "story";
    ticket.updatedAt = changedAt;
    putTicket(slug, ticket);
  }
}
function createStory(slug, fields) {
  return transaction(() => {
    fields = fields || {};
    const id = newStoryId();
    const seq = nextStorySeq(slug);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const executionContract = normalizeStoryExecutionContract(fields.executionContract);
    const story = {
      id,
      ref: `US-${seq}`,
      title: String(fields.title || "Untitled story").trim().slice(0, 200) || "Untitled story",
      description: String(fields.description || "").trim(),
      color: parseStoryColor(fields.color) || autoStoryColor(seq - 1),
      executionContract,
      contractRevision: executionContract ? 1 : 0,
      decisionLog: [],
      logRevision: 0,
      createdAt: now,
      updatedAt: now,
      order: Date.now()
    };
    putStory(slug, story);
    return story;
  });
}
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
    const previousRevision = Number(s.contractRevision) || 0;
    const nextContract = patch.executionContract === void 0 ? s.executionContract || null : normalizeStoryExecutionContract(patch.executionContract);
    const contractChanged = nextContract !== (s.executionContract || null);
    if (contractChanged) {
      s.executionContract = nextContract;
      s.contractRevision = previousRevision + 1;
    }
    const now = (/* @__PURE__ */ new Date()).toISOString();
    s.updatedAt = now;
    putStory(slug, s);
    if (contractChanged) markStoryContractDrift(slug, s, previousRevision, now);
    return s;
  });
}
function deleteStory(slug, idOrRef) {
  const s = getStory(slug, idOrRef);
  if (!s) return false;
  if (!deleteCachedRow(database(), "stories", s.id)) return false;
  try {
    for (const t of listTickets(slug)) {
      if (t.storyId === s.id) updateTicket(slug, t.id, { storyId: null, source: "cli" });
    }
  } catch (_) {
  }
  return true;
}
const COMMENT_BODY_MAX = 16e3;
const COMMENT_BODY_ADVISORY_BYTES = 4096;
function commentBodyAdvisory(body) {
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes <= COMMENT_BODY_ADVISORY_BYTES) return null;
  return `body stored in full (${(bytes / 1024).toFixed(1)} KB); default reads excerpt bodies past 1200 chars - prefer a tight report and link artifacts (paths, commit hashes) over pasting content.`;
}
function newCommentId() {
  return "c_" + Date.now().toString(36) + "_" + crypto.randomBytes(3).toString("hex");
}
function stripControlChars(s) {
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}
function prepareComment(fields) {
  fields = fields || {};
  const body = stripControlChars(String(fields.body || "")).trim();
  if (!body) return { ok: false, reason: "empty" };
  if (body.length > COMMENT_BODY_MAX) {
    return { ok: false, reason: "too_long", max: COMMENT_BODY_MAX, length: body.length };
  }
  const advisory = commentBodyAdvisory(body);
  return {
    ok: true,
    by: String(fields.by || "agent"),
    kind: "comment",
    body,
    source: fields.source ? String(fields.source) : "cli",
    ...advisory ? { advisory } : {}
  };
}
function createComment(fields, at) {
  return {
    id: newCommentId(),
    by: fields.by,
    kind: fields.kind,
    body: fields.body,
    source: fields.source,
    at: at || (/* @__PURE__ */ new Date()).toISOString()
  };
}
function addComment(slug, idOrRef, fields) {
  const prepared = prepareComment(fields);
  if (!prepared.ok) return prepared;
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: "not_found" };
  return withTicketLock(slug, found.id, () => {
    const t = getTicket(slug, found.id);
    if (!t) return { ok: false, reason: "not_found" };
    if (!Array.isArray(t.comments)) t.comments = [];
    const comment = createComment(prepared);
    t.comments.push(comment);
    recordClaimVerification(t, comment);
    touchClaimActivity(t, comment.by, comment.at);
    t.lastEventType = "comment";
    t.lastEventSource = comment.source;
    t.updatedAt = comment.at;
    putTicket(slug, t);
    queueEventNotification(slug, t, t.lastEventType, t.lastEventSource, { commentBody: comment.body });
    return { ok: true, ticket: t, comment, ...prepared.advisory ? { advisory: prepared.advisory } : {} };
  });
}
function linkTypePair(verb) {
  switch (String(verb || "").toLowerCase().replace(/_/g, "-")) {
    case "blocks":
    case "blocking":
      return ["blocks", "blocked-by"];
    case "blocked-by":
    case "blockedby":
    case "depends-on":
    case "dependson":
    case "depends":
    case "needs":
    case "after":
      return ["blocked-by", "blocks"];
    case "related":
    case "related-to":
    case "relates-to":
    case "relates":
      return ["related", "related"];
    default:
      return null;
  }
}
function upperRef(r) {
  return String(r).toUpperCase();
}
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
      t.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
      putTicket(slug, t);
    }
  });
}
function linkTickets(slug, fromRef, verb, toRef) {
  const pair = linkTypePair(verb);
  if (!pair) return { ok: false, reason: "bad_type" };
  const from = getTicket(slug, fromRef);
  const to = getTicket(slug, toRef);
  if (!from) return { ok: false, reason: "from_not_found" };
  if (!to) return { ok: false, reason: "to_not_found" };
  if (from.id === to.id) return { ok: false, reason: "self" };
  addLinkToTicket(slug, from.id, pair[0], to.ref);
  addLinkToTicket(slug, to.id, pair[1], from.ref);
  return { ok: true, from: getTicket(slug, from.id), to: getTicket(slug, to.id), type: pair[0] };
}
function unlinkTickets(slug, aRef, bRef) {
  const a = getTicket(slug, aRef);
  const b = getTicket(slug, bRef);
  if (!a || !b) return { ok: false, reason: "not_found" };
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
      t.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
      putTicket(slug, t);
    }
  });
}
function openBlockers(slug, ticket) {
  if (!ticket || !Array.isArray(ticket.links)) return [];
  const out = [];
  for (const l of ticket.links) {
    if (l.type !== "blocked-by") continue;
    const blocker = getTicket(slug, l.ref);
    if (blocker && blocker.status !== "done") out.push(blocker.ref);
  }
  return out;
}
function isBlocked(slug, ticket) {
  return openBlockers(slug, ticket).length > 0;
}
function openBlockersFromIndex(index, ticket) {
  if (!ticket || !Array.isArray(ticket.links)) return [];
  const out = [];
  for (const l of ticket.links) {
    if (l.type !== "blocked-by") continue;
    const blocker = index.get(String(l.ref).toUpperCase());
    if (blocker && blocker.status !== "done") out.push(blocker.ref);
  }
  return out;
}
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
    categoryId: t.categoryId || t.category && t.category.id || null,
    categoryName: t.category && t.category.name || null,
    route: routeDescriptor(t.model, t.effort),
    effort: t.effort || null,
    readonlyOverride: t.readonlyOverride === false ? false : null,
    direct: t.directClaim || null,
    ...opts.includeScope ? {
      files: Array.isArray(t.files) ? t.files : [],
      contracts: contractMetadata(t)
    } : {},
    claim: t.claim && t.claim.by ? { by: t.claim.by, at: t.claim.at, stale: claimReclaimable(t) } : null,
    blockedBy,
    comments: Array.isArray(t.comments) ? t.comments.length : 0,
    checkpoint: checkpointProjection(t),
    ...oracleProjection(t) ? { oracle: oracleProjection(t) } : {},
    submission: pendingSubmission(t) ? { commit: t.submission.commit, at: t.submission.at, readiness: submissionReadiness(t.submission) } : null
  };
}
function decodeListCursor(cursor) {
  if (cursor == null || cursor === "") return 0;
  const n = Math.floor(Number(cursor));
  return Number.isFinite(n) && n > 0 ? n : 0;
}
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
const DEFAULT_LIST_PAGE_LIMIT = 40;
function listPayload(slug, opts) {
  opts = opts || {};
  const project = String(slug || "");
  const filter = {
    archived: !!opts.archived,
    status: opts.status == null && !opts.all ? ["todo", "doing"] : opts.status
  };
  const paging = !opts.all && opts.limit == null ? Object.assign({}, opts, { limit: DEFAULT_LIST_PAGE_LIMIT }) : opts;
  const total = countTickets(project, filter);
  let index;
  if (opts.brief) {
    const rows = db.selectRows(database(), "SELECT ref, status FROM tickets WHERE project = ?", [project]);
    index = new Map(rows.map((row) => [String(row.ref).toUpperCase(), row]));
  }
  if (!paging.all && paging.limit != null && paging.maxChars == null) {
    const offset = Math.min(decodeListCursor(paging.cursor), total);
    let tickets2 = queryTickets(project, { ...filter, limit: paging.limit, offset });
    if (opts.brief) tickets2 = tickets2.map((ticket) => briefTicket(project, ticket, { index }));
    const returned = tickets2.length;
    const nextOffset = offset + returned;
    return {
      tickets: tickets2,
      total,
      returned,
      nextCursor: nextOffset < total ? String(nextOffset) : null,
      claimIdleMs: claimIdleMs(),
      categories: classifierCategories({ project })
    };
  }
  let tickets = queryTickets(project, filter);
  if (opts.brief) tickets = tickets.map((ticket) => briefTicket(project, ticket, { index }));
  const page = pageTickets(tickets, paging);
  page.claimIdleMs = claimIdleMs();
  page.categories = classifierCategories({ project });
  return page;
}
function readyPayload(slug, opts) {
  opts = opts || {};
  let tickets = readyTickets(slug, { model: opts.model, category: opts.category });
  const waves = readyWaves(slug, { model: opts.model, category: opts.category }).map((wave) => wave.map((t) => t.ref));
  const waveDependencies = readyWaveDependencies(slug, { model: opts.model, category: opts.category });
  if (opts.brief) tickets = tickets.map((t) => briefTicket(slug, t, { blockedBy: [], includeScope: true }));
  return { tickets, waves, waveDependencies, claimIdleMs: claimIdleMs(), categories: classifierCategories({ project: slug }) };
}
function claimPulse(ticket, now) {
  const claim = ticket && ticket.claim;
  if (!claim || !claim.by) return null;
  const atMs = Date.parse(claim.at);
  const idleMs = claimIdleAge(ticket, now);
  const verdict = claimReleaseVerdict(ticket, now);
  return {
    by: claim.by,
    at: claim.at,
    ageMs: Number.isFinite(atMs) ? Math.max(0, now - atMs) : null,
    idleMs: Number.isFinite(idleMs) ? idleMs : null,
    reclaimable: verdict ? verdict.kind : null,
    verifying: Boolean(claimVerification(ticket))
  };
}
function boundedExcerpt(value, maxChars = 1200) {
  const text = String(value || "");
  if (text.length <= maxChars) return { text, length: text.length, truncated: false };
  const tailLength = Math.min(240, Math.floor(maxChars / 4));
  const marker = `
[… ${text.length - maxChars} more chars; use full:true …]
`;
  const headLength = maxChars - tailLength - marker.length;
  return {
    text: `${text.slice(0, headLength)}${marker}${text.slice(-tailLength)}`,
    length: text.length,
    truncated: true
  };
}
const COMMENT_BODY_RETENTION = 10;
function commentHistory(comments, full = false) {
  const history = Array.isArray(comments) ? comments : [];
  const omittedBodies = full ? 0 : Math.max(0, history.length - COMMENT_BODY_RETENTION);
  if (!omittedBodies) return { comments: history, omittedBodies: 0, notice: null };
  const notice = `${omittedBodies} earlier comment bodies omitted — pass --full to see them.`;
  return {
    comments: history.map((comment, index) => {
      if (index >= omittedBodies) return comment;
      const { body: _body, ...metadata } = comment;
      return Object.assign(metadata, { bodyOmitted: true });
    }),
    omittedBodies,
    notice
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
    body: String(comment.body || "").slice(0, 100)
  };
}
function latestCommentExcerpt(ticket) {
  const comments = Array.isArray(ticket.comments) ? ticket.comments : [];
  const comment = comments[comments.length - 1];
  if (!comment) return null;
  const body = boundedExcerpt(comment.body, 200);
  return {
    by: comment.by,
    kind: comment.kind,
    body: body.text,
    bodyLength: body.length,
    bodyTruncated: body.truncated
  };
}
function gitPulse(projectPath, files) {
  if (!projectPath || !Array.isArray(files) || !files.length) return null;
  try {
    const git = (args) => execFileSync("git", args, {
      cwd: projectPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true
    }).trim();
    if (git(["rev-parse", "--is-inside-work-tree"]) !== "true") return null;
    const commit = git(["log", "-1", "--format=%H%x1f%s%x1f%cI", "--", ...files]);
    const [hash, subject, at] = commit ? commit.split("") : [];
    const changed = git(["status", "--porcelain", "--", ...files]);
    return {
      commit: hash ? { hash, subject, at } : null,
      dirty: Boolean(changed)
    };
  } catch (_) {
    return null;
  }
}
function claimActivityPulse(ticket, git) {
  const claim = ticket && ticket.claim;
  if (!claim || !claim.by || claimReleaseVerdict(ticket)) return { working: false, lastActivityAt: null };
  const activity = [claim.at];
  for (const comment of Array.isArray(ticket.comments) ? ticket.comments : []) {
    if (comment && comment.by === claim.by) activity.push(comment.at);
  }
  if (git && git.commit && git.commit.at) activity.push(git.commit.at);
  const timestamps = activity.filter((at) => Number.isFinite(Date.parse(at))).sort((a, b) => Date.parse(b) - Date.parse(a));
  return { working: true, lastActivityAt: timestamps[0] || null };
}
function pulsePayload(slug, idOrRef) {
  const ticket = getTicket(slug, idOrRef);
  if (!ticket) return null;
  const meta = readMeta(slug);
  const git = gitPulse(meta && meta.path, ticket.files);
  const activity = claimActivityPulse(ticket, git);
  const dispatch = dispatchState(ticket);
  const warnings = [...storyContractDriftWarnings(ticket), ...storyDecisionLogWarnings(ticket, slug)];
  return {
    ref: ticket.ref,
    title: ticket.title,
    status: ticket.status,
    direct: ticket.directClaim || null,
    claim: claimPulse(ticket, Date.now()),
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
      outcome: dispatch.outcome || null
    } : null,
    checkpoint: checkpointProjection(ticket),
    ...oracleProjection(ticket) ? { oracle: oracleProjection(ticket) } : {},
    ...warnings.length ? { warnings } : {},
    submission: submissionProjection(ticket.submission),
    delivery: boardConfig(slug)?.delivery || "merge",
    git
  };
}
function changesPayload(slug, since) {
  const serverTime = (/* @__PURE__ */ new Date()).toISOString();
  const nowMs = Date.parse(serverTime);
  const defaultSince = new Date(Date.now() - 60 * 60 * 1e3).toISOString();
  const after = since == null ? defaultSince : String(since);
  const afterMs = Date.parse(after);
  if (!Number.isFinite(afterMs)) throw new Error("changes: --since must be an ISO timestamp.");
  const changedAt = (ticket) => {
    const updatedMs = Date.parse(ticket.updatedAt);
    const expiresMs = Date.parse(ticket.checkpoint && ticket.checkpoint.expiresAt);
    return Number.isFinite(expiresMs) && expiresMs <= nowMs ? Math.max(updatedMs, expiresMs) : updatedMs;
  };
  const tickets = listTickets(slug).filter((ticket) => changedAt(ticket) > afterMs).sort((a, b) => changedAt(a) - changedAt(b)).map((ticket) => {
    const warnings = [...storyContractDriftWarnings(ticket), ...storyDecisionLogWarnings(ticket, slug)];
    return {
      ref: ticket.ref,
      title: ticket.title,
      status: ticket.status,
      lastEventType: ticket.lastEventType || null,
      lastEventSource: ticket.lastEventSource || null,
      lastComment: latestCommentExcerpt(ticket),
      claim: claimPulse(ticket, nowMs),
      checkpoint: checkpointProjection(ticket, nowMs),
      ...oracleProjection(ticket) ? { oracle: oracleProjection(ticket) } : {},
      ...warnings.length ? { warnings } : {},
      updatedAt: ticket.updatedAt
    };
  });
  return { since: after, serverTime, tickets };
}
const WORKER_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1e3;
function workersLockPath() {
  return path.join(projectsRoot(), ".workers.lock");
}
function readWorkers() {
  const d = readGlobal("workers", null);
  return d && typeof d === "object" && d.sessions && typeof d.sessions === "object" ? d : { sessions: {} };
}
function writeWorkers(obj) {
  writeGlobal("workers", obj);
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
function pruneWorkers(w) {
  const cutoff = Date.now() - WORKER_SESSION_TTL_MS;
  for (const sid of Object.keys(w.sessions)) {
    const s = w.sessions[sid];
    const claims = s && Array.isArray(s.claims) ? s.claims : [];
    const ts = s && s.updatedAt ? Date.parse(s.updatedAt) : NaN;
    if (!claims.length || Number.isFinite(ts) && ts < cutoff) delete w.sessions[sid];
  }
  return w;
}
function registerWorker(sessionId, slug, ticketId, by) {
  if (!sessionId || !slug || !ticketId) return;
  try {
    withWorkersLock(() => {
      const w = readWorkers();
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const s = w.sessions[sessionId] || (w.sessions[sessionId] = { updatedAt: now, claims: [] });
      s.updatedAt = now;
      if (!Array.isArray(s.claims)) s.claims = [];
      if (!s.claims.some((c) => c.slug === slug && c.ticketId === ticketId)) {
        s.claims.push({ slug, ticketId, by: by || null, at: now });
      }
      writeWorkers(pruneWorkers(w));
    });
  } catch (_) {
  }
}
function unregisterClaim(sessionId, slug, ticketId) {
  if (!sessionId || !slug || !ticketId) return;
  try {
    withWorkersLock(() => {
      const w = readWorkers();
      const s = w.sessions[sessionId];
      if (!s || !Array.isArray(s.claims)) return;
      s.claims = s.claims.filter((c) => !(c.slug === slug && c.ticketId === ticketId));
      s.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
      writeWorkers(pruneWorkers(w));
    });
  } catch (_) {
  }
}
function markLongRunFlagged(sessionId, slug, ticketId, claimAt) {
  if (!sessionId || !slug || !ticketId) return true;
  let first = true;
  try {
    withWorkersLock(() => {
      const w = readWorkers();
      const s = w.sessions[sessionId];
      if (!s) return;
      const key = `${slug}\0${ticketId}\0${claimAt || ""}`;
      if (!Array.isArray(s.flagged)) s.flagged = [];
      if (s.flagged.indexOf(key) !== -1) {
        first = false;
        return;
      }
      s.flagged.push(key);
      s.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
      writeWorkers(w);
    });
  } catch (_) {
    return true;
  }
  return first;
}
function reconcileSession(sessionId, opts) {
  opts = opts || {};
  const reason = opts.reason ? String(opts.reason) : "worker session ended";
  const source = opts.source ? String(opts.source) : "cli";
  const released = [];
  if (!sessionId) return { ok: true, released };
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
    if (!t || t.archived || t.status === "done") continue;
    if (!t.claim || !t.claim.by) continue;
    if (c.by && t.claim.by !== c.by) continue;
    try {
      const res = releaseTicket(c.slug, c.ticketId, t.claim.by, {
        status: "todo",
        source,
        claimRelease: { kind: "session_ended", reason }
      });
      if (res && res.ok) {
        released.push(t.ref);
        try {
          addComment(c.slug, c.ticketId, {
            by: "sidequest",
            kind: "comment",
            source,
            body: `↩️ Auto-released to **todo**: ${reason} (was claimed by \`${t.claim.by}\`). It's back in the ready pool for another worker.`
          });
        } catch (_) {
        }
      }
    } catch (_) {
    }
  }
  return { ok: true, released };
}
function sessionClaims(sessionId, opts) {
  const out = [];
  if (!sessionId) return out;
  const agentId = opts && opts.agentId ? String(opts.agentId) : null;
  const agentName = opts && opts.agentName ? String(opts.agentName) : null;
  const executor = opts && opts.executor ? String(opts.executor) : null;
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
        const state = dispatchState(t);
        if ((agentId || agentName) && (!state || agentId && state.agentId !== agentId || agentName && state.agentName !== agentName || executor && state.executor !== executor)) continue;
        ref = t.ref;
        status = t.status;
        held = !!(t.claim && t.claim.by && (!c.by || t.claim.by === c.by));
      }
    } catch (_) {
    }
    out.push({ slug: c.slug, ticketId: c.ticketId, ref, by: c.by || null, at: c.at || null, status, held });
  }
  return out;
}
function readServerInfo() {
  return readGlobal("server-info", null);
}
function writeServerInfo(info) {
  writeGlobal("server-info", info);
}
function clearServerInfo() {
  deleteCachedRow(database(), "globals", "server-info");
}
module.exports = {
  VALID_STATUS,
  VALID_PRIORITY,
  VALID_EFFORTS,
  CLAUDE_RUNTIMES,
  ROUTING_FALLBACK_DEFAULT,
  EXECUTOR_ANCHORS_MAX,
  EXECUTOR_VERIFY_MAX,
  DECLARED_FILES_MAX,
  CONTRACT_NAMES_MAX,
  LABELS_MAX,
  DISPATCH_DESCRIPTION_MIN,
  dispatchDescriptionError,
  dispatchDeclaredFiles,
  dispatchWorkspace,
  dispatchWarnings,
  dispatchUncertaintyWarnings,
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
  normalizeDeliveryMode,
  validateIntegrationSubmission,
  integrateSubmission,
  verifyIntegration,
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
  PLAN_ASSET_NAME,
  PLAN_BODY_MAX_BYTES,
  writeTicketPlan,
  ticketPlanInfo,
  appendExperimentEntry,
  applyExperimentVerdict,
  appendOverturnLine,
  experimentPacket,
  listTickets,
  worktreeGcTickets,
  worktreeGcProjects,
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
  dispatchIsolationExpectation,
  activeSharedTreeClaim,
  isolatedDispatchWithMissingWorktree,
  terminalDispatchTarget,
  terminalDispatchForIdle,
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
  oracleProjection,
  clearOracleMarker,
  checkpointTtlMs,
  DEFAULT_CHECKPOINT_TTL_MIN,
  MAX_CHECKPOINT_TTL_MIN,
  submitTicket,
  clearSubmission,
  pendingSubmission,
  submissionReadiness,
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
  pendingScopeApprovalWarning,
  requestScope,
  normalizeContracts,
  contractCollisionReasons,
  STORY_PALETTE,
  STORY_COLOR_NAMES,
  STORY_EXECUTION_CONTRACT_MAX_BYTES,
  STORY_DECISION_LOG_MAX_BYTES,
  STORY_LOG_ENTRY_TEXT_MAX_BYTES,
  storyExecutionContract,
  normalizeStoryLogEntry,
  storyDecisionLog,
  appendStoryLogEntry,
  clearStoryLog,
  storyDecisionLogWarnings,
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
  claimPulse,
  changesPayload,
  boundedExcerpt,
  commentHistory,
  archiveTicket,
  unarchiveTicket,
  archiveAllDone,
  listArchived,
  listActive,
  autoReleasedClaimMessage,
  claimReclaimable,
  claimReleaseVerdict,
  claimActivityMs,
  touchClaim,
  claimIdleMs,
  claimAbandonMs,
  preparedDispatchTtlMs,
  DEFAULT_CLAIM_IDLE_MIN,
  DEFAULT_CLAIM_ABANDON_MIN,
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
  sessionClaims
};
