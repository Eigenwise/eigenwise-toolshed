"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { stableClaudeName, stableDispatchName } = require("./exec-names.js");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const db = require("./db.js");
const { migrateIfNeeded } = require("./migrate.js");
const { discoverExternalModels } = require("./discovery.js");
const telemetry = require("./telemetry.js");
const { routingDisabledMessage } = require("./refusal-guidance.js");
const AGENT_DESCRIPTION_MAX_LENGTH = 80;
function spawnDescription(ticket, resolved) {
  const title = String(ticket && ticket.title || "Sidequest ticket").replace(/\s+/g, " ").trim();
  const route = resolved && resolved.backend === "codex" ? String(resolved.runsLabel || resolved.runsModel || "").replace(/\s+/g, " ").trim() : "";
  const suffix = route ? ` (${route})` : "";
  const maxTitleLength = Math.max(1, AGENT_DESCRIPTION_MAX_LENGTH - suffix.length);
  return `${title.slice(0, maxTitleLength).trimEnd()}${suffix}`.slice(0, AGENT_DESCRIPTION_MAX_LENGTH);
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
    globalCategories: null,
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
  putCachedRow(database(), "projects", { slug, data: meta });
}
function putTicket(slug, ticket) {
  const stored = Object.assign({}, ticket);
  if (stored.category && typeof stored.category === "object") stored.category = stored.categoryId || stored.category.id;
  delete stored.categoryId;
  delete stored.warnings;
  delete stored.exec;
  delete stored.model;
  delete stored.effort;
  putCachedRow(database(), "tickets", {
    id: stored.id,
    project: slug,
    ref: stored.ref || null,
    status: stored.status || null,
    archived: stored.archived ? 1 : 0,
    ord: Number(stored.order) || 0,
    claim_by: stored.claim && stored.claim.by ? stored.claim.by : null,
    data: stored
  });
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
  Object.freeze({ model: "fable", signature: "You've reached your Fable 5 limit" })
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
  return { backend: "codex", source: entry.source, slug: entry.slug, agentSlug, id: entry.id, label: entry.label };
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
function dispatchModelFor(id) {
  return String(id || "").replace(/^claude-codex-/, "").replace(/\[1m\]$/, "");
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
        warnings: resolved.warnings
      });
    }),
    warnings: projectCategories.warnings
  };
}
function classifyModelFilter(v) {
  if (v == null) return "any";
  const value = String(v).trim().toLowerCase();
  if (!value || value === "any" || value === "none" || value === "null") return "any";
  const exec = resolveExec(value, null);
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
  const stored = readGlobal("routing-fallback", null);
  return normalizeRoute(stored);
}
function setRoutingFallback(route) {
  const normalized = normalizeRoute(route);
  if (!normalized) throw new Error("Routing fallback requires a valid model and effort.");
  writeGlobal("routing-fallback", normalized);
  return normalized;
}
function projectCategoryRows(project) {
  if (!project) return [];
  const cache = residentCache();
  const cached = cache.projectCategories.get(project);
  if (cached) return cloneCached(cached);
  const rows = database().prepare("SELECT id, kind, data FROM project_categories WHERE project = ? ORDER BY id").all(project).map((row) => {
    try {
      return { id: row.id, kind: row.kind, data: JSON.parse(row.data) };
    } catch (_) {
      return null;
    }
  }).filter(Boolean);
  cache.projectCategories.set(project, rows);
  return cloneCached(rows);
}
function projectCategoryWarnings(project) {
  const globalIds = new Set(db.listRows(database(), "categories").map((category) => String(category && category.id || "").trim().toLowerCase()));
  const warnings = [];
  for (const row of projectCategoryRows(project)) {
    if (row.kind === "OVERRIDE" && !globalIds.has(row.id)) {
      warnings.push({ kind: "dangling-override", id: row.id, project });
    }
  }
  return warnings;
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
  for (const category of getCategories()) add(category);
  const globals = new Map(getCategories().map((category) => [category.id, category]));
  let rows = [];
  try {
    rows = database().prepare("SELECT id, kind, data FROM project_categories ORDER BY project, id").all();
  } catch (_) {
    rows = [];
  }
  for (const row of rows) {
    if (row.kind === "DISABLE") continue;
    let data;
    try {
      data = JSON.parse(row.data);
    } catch (_) {
      continue;
    }
    if (row.kind === "ADD" || row.kind === "DETACH") {
      add(normalizeCategory(data));
      continue;
    }
    if (row.kind === "OVERRIDE") {
      const base = globals.get(String(row.id || "").trim().toLowerCase());
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
  const cache = residentCache();
  if (!cache.globalCategories) {
    cache.globalCategories = db.listRows(database(), "categories").map((raw) => normalizeCategory(raw)).filter(Boolean);
  }
  const categories = /* @__PURE__ */ new Map();
  for (const category of cache.globalCategories || []) {
    categories.set(category.id, withState ? Object.assign({}, category, { linkState: "linked" }) : category);
  }
  for (const row of projectCategoryRows(opts.project)) {
    const base = categories.get(row.id);
    if (row.kind === "ADD" && !base) {
      const category = normalizeCategory(row.data);
      if (category) categories.set(category.id, withState ? Object.assign({}, category, { linkState: "added" }) : category);
    } else if (row.kind === "DETACH") {
      const category = normalizeCategory(row.data);
      if (category) categories.set(category.id, withState ? Object.assign({}, category, { linkState: "detached" }) : category);
    } else if (row.kind === "OVERRIDE" && base) {
      const category = normalizeCategory(Object.assign({}, base, row.data));
      if (category) {
        categories.set(category.id, withState ? Object.assign({}, category, { linkState: "overridden", changedFields: Object.keys(row.data).sort() }) : category);
      }
    } else if (row.kind === "DISABLE" && row.id !== "general" && base) {
      categories.delete(row.id);
    }
  }
  return cloneCached([...categories.values()].filter((category) => includeDisabled || category.enabled).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)));
}
function normalizeCategoryId(id) {
  return String(id || "").trim().toLowerCase();
}
function getCategory(id, opts) {
  const normalizedId = normalizeCategoryId(id);
  return getCategories(opts).find((category) => category.id === normalizedId) || null;
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
    enabled: raw.enabled !== false
  };
}
function setCategory(categoryOrId, patch) {
  const requested = typeof categoryOrId === "string" ? Object.assign({}, getCategory(categoryOrId), patch || {}, { id: normalizeCategoryId(categoryOrId) }) : categoryOrId;
  const normalized = normalizeCategory(requested);
  if (!normalized) throw new Error("Category id is required.");
  if (!normalizeRoute(requested && requested.route)) throw new Error("Category route requires a valid model and effort.");
  if (requested && requested.fallback != null && !normalizeRoute(requested.fallback)) throw new Error("Category fallback requires a valid model and effort.");
  if (normalized.id === "general" && !normalized.enabled) throw new Error('Category "general" cannot be disabled.');
  putCachedRow(database(), "categories", { id: normalized.id, data: normalized });
  return normalized;
}
function removeCategory(id) {
  const normalizedId = normalizeCategoryId(id);
  if (normalizedId === "general") throw new Error('Category "general" cannot be removed.');
  return transaction(() => {
    const base = getCategory(normalizedId);
    if (base) {
      const overrides = database().prepare("SELECT project, data FROM project_categories WHERE id = ? AND kind = 'OVERRIDE'").all(normalizedId);
      for (const row of overrides) {
        let patch;
        try {
          patch = JSON.parse(row.data);
        } catch (_) {
          patch = {};
        }
        const pinned = normalizeCategory(Object.assign({}, base, patch, { id: normalizedId }));
        if (pinned) putCachedRow(database(), "project_categories", { project: row.project, id: normalizedId, kind: "DETACH", data: pinned });
      }
    }
    return deleteCachedRow(database(), "categories", normalizedId);
  });
}
function normalizeFullProjectCategory(id, kind, data) {
  const required = ["name", "description", "contract", "route", "fallback", "enabled"];
  if (!data || typeof data !== "object" || Array.isArray(data) || required.some((key) => !Object.hasOwn(data, key))) {
    throw new Error(`Project category ${kind} requires a complete category row.`);
  }
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
  const global = getCategory(normalizedId);
  let normalizedData;
  if (normalizedKind === "ADD") {
    if (global) throw new Error(`Project category ADD "${normalizedId}" collides with a global category.`);
    normalizedData = normalizeFullProjectCategory(normalizedId, normalizedKind, data);
  } else if (normalizedKind === "DETACH") {
    normalizedData = normalizeFullProjectCategory(normalizedId, normalizedKind, data);
  } else if (normalizedKind === "OVERRIDE") {
    if (!global) throw new Error(`Project category OVERRIDE "${normalizedId}" requires a global category.`);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Project category OVERRIDE requires a patch object.");
    const allowed = /* @__PURE__ */ new Set(["name", "description", "contract", "route", "fallback"]);
    for (const key of Object.keys(data)) if (!allowed.has(key)) throw new Error(`Project category OVERRIDE cannot patch "${key}".`);
    if (data.route != null && !normalizeRoute(data.route)) throw new Error("Project category OVERRIDE route requires a valid model and effort.");
    if (data.fallback != null && !normalizeRoute(data.fallback)) throw new Error("Project category OVERRIDE fallback requires a valid model and effort.");
    normalizedData = Object.assign({}, data);
  } else {
    if (normalizedId === "general") throw new Error('Category "general" cannot be disabled.');
    if (!global) throw new Error(`Project category DISABLE "${normalizedId}" requires a global category.`);
    normalizedData = {};
  }
  putCachedRow(database(), "project_categories", { project: normalizedProject, id: normalizedId, kind: normalizedKind, data: normalizedData });
  return { project: normalizedProject, id: normalizedId, kind: normalizedKind, data: normalizedData };
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
function removeProjectCategory(project, id) {
  const normalizedProject = String(project || "").trim();
  const normalizedId = normalizeCategoryId(id);
  if (!normalizedProject || !normalizedId) throw new Error("Project and category id are required.");
  return deleteCachedRow(database(), "project_categories", { project: normalizedProject, id: normalizedId });
}
function classifierCategories(opts) {
  return getCategories(Object.assign({}, opts, { includeDisabled: false })).map(({ id, name, description, route, fallback, contract }) => ({ id, name, description, route, fallback, contract }));
}
function resolveCategoryRoute(category) {
  const warnings = [];
  const candidates = [
    { name: "route", route: category && category.route },
    { name: "category fallback", route: category && category.fallback },
    { name: "global fallback", route: getRoutingFallback() }
  ];
  for (const candidate of candidates) {
    const route2 = normalizeRoute(candidate.route);
    if (!route2) continue;
    const exec = resolveExec(route2.model, route2.effort);
    if (exec) return { model: exec.runsModel, effort: route2.effort, exec, warnings };
    warnings.push(`Category "${category.id}" ${candidate.name} model "${route2.model}" isn't currently available.`);
  }
  const route = ROUTING_FALLBACK_DEFAULT;
  warnings.push("Global routing fallback is missing or invalid; using hardwired sonnet/high.");
  return { model: route.model, effort: route.effort, exec: resolveExec(route.model, route.effort), warnings };
}
function resolveCategoryFallback(category, failedModel) {
  const candidates = [
    { source: "category fallback", route: category && category.fallback },
    { source: "global fallback", route: getRoutingFallback() },
    { source: "hardwired fallback", route: ROUTING_FALLBACK_DEFAULT }
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
function ticketCategory(ticket) {
  if (!ticket || ticket.category == null) return null;
  return typeof ticket.category === "object" ? ticket.categoryId || ticket.category.id : String(ticket.category);
}
function execProjection(exec) {
  return { agent: exec.agent, model: exec.model, backend: exec.backend, runsModel: exec.runsModel, apiModel: exec.apiModel, runsLabel: exec.runsLabel, dispatch: exec.dispatch };
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
function defaultAlwaysInScope(absPath) {
  try {
    return fs.statSync(path.join(absPath, "docs")).isDirectory() ? ["docs/"] : [];
  } catch (_) {
    return [];
  }
}
function boardConfig(slug) {
  const meta = readMeta(slug);
  if (!meta) return null;
  return { alwaysInScope: Array.isArray(meta.alwaysInScope) ? normalizeAlwaysInScope(meta.alwaysInScope) : defaultAlwaysInScope(meta.path) };
}
function setBoardConfig(slug, patch) {
  return withMetaLock(slug, () => {
    const meta = readMeta(slug);
    if (!meta) return { ok: false, reason: "not_found" };
    if (!patch || !Object.prototype.hasOwnProperty.call(patch, "alwaysInScope")) {
      return { ok: true, config: boardConfig(slug) };
    }
    meta.alwaysInScope = normalizeAlwaysInScope(patch.alwaysInScope);
    putProject(slug, meta);
    return { ok: true, config: boardConfig(slug) };
  });
}
function effectiveScope(slug, files) {
  const config = boardConfig(slug);
  return Array.from(/* @__PURE__ */ new Set([...Array.isArray(files) ? files : [], ...config && config.alwaysInScope || []]));
}
function ensureProject(absPath, name) {
  const resolved = path.resolve(absPath);
  const slug = slugify(resolved);
  const dir = projectDir(slug);
  ensureDir(ticketsDir(slug));
  let meta = readMeta(slug);
  if (!meta || typeof meta !== "object") {
    meta = {
      path: resolved,
      name: name || defaultProjectName(resolved),
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      seq: 0,
      storySeq: 0,
      alwaysInScope: defaultAlwaysInScope(resolved)
    };
    putProject(slug, meta);
  } else {
    let dirty = false;
    if (meta.path !== resolved) {
      meta.path = resolved;
      dirty = true;
    }
    if (name && meta.name !== name) {
      meta.name = name;
      dirty = true;
    }
    if (!meta.name) {
      meta.name = defaultProjectName(resolved);
      dirty = true;
    }
    if (typeof meta.seq !== "number") {
      meta.seq = 0;
      dirty = true;
    }
    if (typeof meta.storySeq !== "number") {
      meta.storySeq = 0;
      dirty = true;
    }
    if (dirty) putProject(slug, meta);
  }
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
function sanitizeFilename(name) {
  const base = path.basename(String(name || "image")).replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+/, "");
  return base || "image";
}
function copyAsset(slug, id, srcPath) {
  const src = path.resolve(srcPath);
  const data = fs.readFileSync(src);
  const dir = assetsDir(slug, id);
  ensureDir(dir);
  let fname = sanitizeFilename(path.basename(src));
  if (!path.extname(fname)) fname += ".png";
  let dest = path.join(dir, fname);
  let n = 1;
  while (fs.existsSync(dest)) {
    const ext = path.extname(fname);
    const stem = fname.slice(0, -ext.length || void 0);
    dest = path.join(dir, `${stem}-${n}${ext}`);
    n++;
  }
  fs.writeFileSync(dest, data);
  return path.basename(dest);
}
function assetPath(slug, id, filename) {
  const safe = path.basename(String(filename));
  return path.join(assetsDir(slug, id), safe);
}
function saveAssetData(slug, id, name, buffer) {
  const dir = assetsDir(slug, id);
  ensureDir(dir);
  let fname = sanitizeFilename(name || "pasted.png");
  if (!path.extname(fname)) fname += ".png";
  let dest = path.join(dir, fname);
  let n = 1;
  while (fs.existsSync(dest)) {
    const ext = path.extname(fname);
    const stem = fname.slice(0, -ext.length || void 0);
    dest = path.join(dir, `${stem}-${n}${ext}`);
    n++;
  }
  fs.writeFileSync(dest, buffer);
  return path.basename(dest);
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
function ticketReferenceWarnings(slug, title, description) {
  const refs = new Set((`${title || ""}
${description || ""}`.match(/\bSQ-\d+\b/gi) || []).map((ref) => ref.toUpperCase()));
  if (!refs.size) return [];
  const known = new Set(listTickets(slug).map((ticket) => String(ticket.ref).toUpperCase()));
  const unknown = [...refs].filter((ref) => !known.has(ref));
  return unknown.length ? [`Unknown ticket refs: ${unknown.join(", ")}.`] : [];
}
function dispatchDescriptionError(ticket) {
  if (!ticket || !ticket.model || !ticket.effort) return null;
  if (String(ticket.description || "").trim().length >= DISPATCH_DESCRIPTION_MIN) return null;
  return `dispatch: ${DISPATCH_DESCRIPTION_GUIDANCE}.`;
}
function dispatchWarnings(ticket) {
  const categoryId = ticket && (ticket.categoryId || ticket.category && ticket.category.id);
  if (!/^(?:coding(?:\.|$)|debugging$)/.test(String(categoryId || ""))) return [];
  if (String(ticket.executorVerify || "").trim()) return [];
  return ["Dispatch warning: this coding/debugging ticket has no verify command. Add one before the executor starts."];
}
function ticketPlanningWarnings(ticket, projectPath) {
  if (!ticket) return [];
  const warnings = [];
  if (Number(ticket.complexity) >= 4) {
    const missing = [];
    if (!String(ticket.executorAnchors || "").trim()) missing.push("executor anchors");
    if (!String(ticket.executorVerify || "").trim()) missing.push("verify command");
    if (!Array.isArray(ticket.files) || !ticket.files.length) missing.push("file scope");
    if (missing.length) {
      warnings.push(`Planning-depth warning: complexity 4+ tickets should include executor anchors, an exact verify command, and declared file scope before dispatch; missing: ${missing.join(", ")}.`);
    }
  }
  if (!projectPath || !Array.isArray(ticket.files)) return warnings;
  const absent = ticket.files.filter((file) => !fs.existsSync(path.resolve(projectPath, file)));
  if (absent.length) warnings.push(`Planning-depth warning: declared file scope does not exist in the repo: ${absent.join(", ")}.`);
  return warnings;
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
  const ticket = {
    id,
    ref: `SQ-${seq}`,
    title: String(fields.title || "Untitled").trim().slice(0, 300) || "Untitled",
    description: String(fields.description || "").trim(),
    status,
    priority: coercePriority(fields.priority, "normal"),
    labels: normalizeLabels(fields.labels),
    storyId: coerceStoryId(slug, fields.storyId),
    // the user story this ticket belongs to (null = none)
    category: fields.category == null ? null : String(fields.category).trim().toLowerCase() || null,
    complexity: coerceComplexity(fields.complexity),
    // 1..10 score the routing is derived from (entry points require it)
    complexityWhy: String(fields.complexityWhy || "").trim().slice(0, 1e3),
    // the mandatory motivation for the score
    files: normalizeFiles(fields.files),
    // declared file scope, for parallel-wave planning
    executorAnchors: executorText(fields.executorAnchors, EXECUTOR_ANCHORS_MAX, "executor anchors"),
    executorVerify: executorText(fields.executorVerify, EXECUTOR_VERIFY_MAX, "executor verify command"),
    assets,
    comments: [],
    // [{ id, by, body, kind: 'comment'|'question', at }]
    links: [],
    // [{ type: 'blocks'|'blocked-by'|'related', ref }]
    claim: null,
    // { by, at } when an agent has claimed it to work on
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
  return out.slice(0, 12);
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
  return out.slice(0, 20);
}
function scopesOverlap(filesA, filesB) {
  const a = normalizeFiles(filesA).map((f) => f.toLowerCase());
  const b = normalizeFiles(filesB).map((f) => f.toLowerCase());
  if (!a.length || !b.length) return false;
  for (const x of a) {
    for (const y of b) {
      if (x === y || x.startsWith(y + "/") || y.startsWith(x + "/")) return true;
    }
  }
  return false;
}
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
function normalizeAssignee(v) {
  if (v == null) return null;
  const s = String(v).trim().slice(0, 60);
  return s || null;
}
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
    if (patch.storyId !== void 0) t.storyId = coerceStoryId(slug, patch.storyId);
    if (patch.category !== void 0) t.category = patch.category == null ? null : String(patch.category).trim().toLowerCase() || null;
    if (patch.complexity !== void 0) {
      const c = coerceComplexity(patch.complexity);
      if (c) t.complexity = c;
    }
    if (patch.complexityWhy !== void 0 && String(patch.complexityWhy).trim()) t.complexityWhy = String(patch.complexityWhy).trim().slice(0, 1e3);
    if (patch.files !== void 0) t.files = normalizeFiles(patch.files);
    if (patch.executorAnchors !== void 0) t.executorAnchors = executorText(patch.executorAnchors, EXECUTOR_ANCHORS_MAX, "executor anchors");
    if (patch.executorVerify !== void 0) t.executorVerify = executorText(patch.executorVerify, EXECUTOR_VERIFY_MAX, "executor verify command");
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
    t.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
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
const DEFAULT_CLAIM_TTL_MIN = 60;
const DEFAULT_PREPARED_DISPATCH_TTL_HOURS = 6;
function preparedDispatchTtlMs() {
  const hours = Number(process.env.SIDEQUEST_PREPARED_DISPATCH_TTL_HOURS);
  return (Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_PREPARED_DISPATCH_TTL_HOURS) * 60 * 60 * 1e3;
}
function claimTtlMs() {
  const min = Number(process.env.SIDEQUEST_CLAIM_TTL_MIN);
  return (Number.isFinite(min) && min > 0 ? min : DEFAULT_CLAIM_TTL_MIN) * 60 * 1e3;
}
function isClaimStale(claim) {
  if (!claim || !claim.at) return true;
  const t = Date.parse(claim.at);
  if (!Number.isFinite(t)) return true;
  return Date.now() - t > claimTtlMs();
}
function ticketLockPath(slug, id) {
  return path.join(ticketsDir(slug), "." + path.basename(String(id)) + ".lock");
}
function busyWait(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
  }
}
function testClaimLockDelayMs() {
  const delay = Number(process.env.SIDEQUEST_TEST_CLAIM_LOCK_DELAY_MS);
  return Number.isInteger(delay) && delay > 0 ? delay : 0;
}
function acquireLock(lockPath) {
  const STALE_LOCK_MS = 5e3;
  const RETRY_MS = 5;
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
function stableExecutorName(ticket) {
  if (!ticket || !ticket.model || !ticket.effort) throw new Error("dispatch executor requires a routable ticket.");
  const resolved = resolveExec(ticket.model, ticket.effort);
  if (!resolved || !resolved.agent) throw new Error(`no stable executor for ${ticket.model} at ${ticket.effort}.`);
  return resolved.agent;
}
function dispatchTokenPrefix(token) {
  return token ? String(token).slice(0, 12) : null;
}
function dispatchState(ticket) {
  return ticket && ticket.dispatch && typeof ticket.dispatch === "object" ? ticket.dispatch : null;
}
function activeDispatchRoute(ticket) {
  const state = dispatchState(ticket);
  if (!state || state.terminalAt || !ticket.dispatchNonce) return null;
  return normalizeRoute(state.route);
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
function setDispatchTerminal(ticket, outcome, source) {
  const state = dispatchState(ticket);
  if (!state) return;
  state.outcome = outcome;
  state.terminalAt = (/* @__PURE__ */ new Date()).toISOString();
  state.terminalSource = source || "store";
  delete state.supersededTokens;
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
function expiredPreparedDispatch(state, now) {
  if (!state || state.outcome !== "prepared" || state.terminalAt || state.launchedAt || state.boundAt || state.claimedAt) return false;
  const preparedAt = Date.parse(state.preparedAt);
  return Number.isFinite(preparedAt) && now - preparedAt > preparedDispatchTtlMs();
}
function prepareDispatch(slug, idOrRef, opts) {
  opts = opts || {};
  if (!projectRoutingEnabled(slug)) throw new Error(routingDisabledMessage(idOrRef));
  const found = getTicket(slug, idOrRef);
  if (!found) throw new Error(`prepare dispatch: no ticket "${idOrRef}".`);
  return withTicketLock(slug, found.id, () => {
    const t = getTicket(slug, found.id);
    if (!t) throw new Error(`prepare dispatch: no ticket "${idOrRef}".`);
    const current = dispatchState(t);
    const currentRoute = activeDispatchRoute(t);
    const currentExec = currentRoute && resolveExec(currentRoute.model, currentRoute.effort);
    if (current && current.recovery && current.outcome === "prepared" && t.dispatchNonce && t.dispatchExecutor && currentExec && currentExec.agent === t.dispatchExecutor) {
      if (opts.sessionId) current.sessionId = String(opts.sessionId);
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
    t.dispatchExecutor = stableExecutorName(t);
    t.dispatch = {
      sessionId: opts.sessionId ? String(opts.sessionId) : null,
      tokenPrefix: dispatchTokenPrefix(t.dispatchNonce),
      executor: t.dispatchExecutor,
      description: spawnDescription(t, resolveExec(t.model, t.effort)),
      route: { model: t.model, effort: t.effort },
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
    t.dispatch = {
      sessionId: opts.sessionId ? String(opts.sessionId) : state.sessionId || null,
      tokenPrefix: dispatchTokenPrefix(t.dispatchNonce),
      executor: t.dispatchExecutor,
      description: spawnDescription(t, resolveExec(t.model, t.effort)),
      route: { model: fallback.model, effort: fallback.effort },
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
    t.model = fallback.model;
    t.effort = fallback.effort;
    t.exec = execProjection(fallback.exec);
    stampDispatchEvent(t, opts.source || "agent-launch-failure", now);
    putTicket(slug, t);
    return { ok: true, ticket: t, token: t.dispatchNonce, recovery };
  });
}
function bindDispatchAgent(sessionId, executor, agentId, agentName) {
  if (!sessionId || !executor || !agentId) return { ok: false, reason: "missing_identity" };
  const matches = [];
  for (const project of listProjects({ all: true })) {
    for (const ticket of listTickets(project.slug)) {
      const state = dispatchState(ticket);
      if (!state || state.sessionId !== String(sessionId) || state.executor !== String(executor) || state.outcome !== "launched") continue;
      if (agentName && state.agentName && state.agentName !== String(agentName)) continue;
      if (state.agentId && state.agentId !== String(agentId)) continue;
      matches.push({ slug: project.slug, id: ticket.id });
    }
  }
  if (!matches.length || matches.length > 1 && !agentName) {
    return { ok: false, reason: matches.length ? "ambiguous" : "not_found" };
  }
  const tickets = [];
  for (const match of matches) {
    const result = withTicketLock(match.slug, match.id, () => {
      const t = getTicket(match.slug, match.id);
      const state = dispatchState(t);
      if (!state || state.outcome !== "launched" || state.sessionId !== String(sessionId) || state.executor !== String(executor)) {
        return { ok: false };
      }
      const now = (/* @__PURE__ */ new Date()).toISOString();
      state.agentId = String(agentId);
      state.agentName = agentName ? String(agentName) : state.agentName || null;
      state.boundAt = state.boundAt || now;
      stampDispatchEvent(t, "subagent-start", now);
      putTicket(match.slug, t);
      return { ok: true, ticket: t };
    });
    if (!result || !result.ok) return { ok: false, reason: "not_found" };
    tickets.push(result.ticket);
  }
  return { ok: true, ticket: tickets[0], tickets };
}
function markDispatchStopped(sessionId, executor, agentId, agentName) {
  if (!sessionId || !executor) return { ok: false, reason: "missing_identity" };
  const matches = [];
  for (const project of listProjects({ all: true })) {
    for (const ticket of listTickets(project.slug)) {
      const state = dispatchState(ticket);
      if (!state || state.sessionId !== String(sessionId) || state.executor !== String(executor)) continue;
      if (agentId && state.agentId !== String(agentId)) continue;
      if (agentName && state.agentName !== String(agentName)) continue;
      if (state.outcome === "prepared" || state.outcome === "launched" || state.outcome === "claimed") {
        matches.push({ slug: project.slug, id: ticket.id });
      }
    }
  }
  if (!matches.length || matches.length > 1 && !agentName) {
    return { ok: false, reason: matches.length ? "ambiguous" : "not_found" };
  }
  const tickets = [];
  for (const match of matches) {
    const result = withTicketLock(match.slug, match.id, () => {
      const t = getTicket(match.slug, match.id);
      const state = dispatchState(t);
      if (!state || !["prepared", "launched", "claimed"].includes(state.outcome) || state.sessionId !== String(sessionId) || state.executor !== String(executor) || agentId && state.agentId !== String(agentId) || agentName && state.agentName !== String(agentName)) {
        return { ok: false, reason: "not_found" };
      }
      const now = (/* @__PURE__ */ new Date()).toISOString();
      if (agentId) state.agentId = String(agentId);
      if (agentName) state.agentName = String(agentName);
      setDispatchTerminal(t, t.claim && t.claim.by ? "stopped_claimed" : "failed", "subagent-stop");
      if (!t.claim || !t.claim.by) {
        t.dispatchNonce = null;
        t.dispatchExecutor = null;
      }
      stampDispatchEvent(t, "subagent-stop", now);
      putTicket(match.slug, t);
      return { ok: true, ticket: t };
    });
    if (!result || !result.ok) return { ok: false, reason: "not_found" };
    tickets.push(result.ticket);
  }
  return { ok: true, ticket: tickets[0], tickets };
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
function isRoutedTicket(ticket) {
  return Boolean(ticket && ticket.model && ticket.effort && ticket.exec);
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
    if (opts.direct && t2.dispatchNonce) return { ok: false, reason: "direct_conflict", ticket: t2 };
    if (!opts.direct && t2.dispatchNonce && opts.token !== t2.dispatchNonce) return { ok: false, reason: "token", ticket: t2 };
    if (!opts.direct && t2.dispatchNonce && opts.executor !== t2.dispatchExecutor) return { ok: false, reason: "executor_mismatch", ticket: t2, expectedExecutor: t2.dispatchExecutor };
    if (!opts.direct && isRoutedTicket(t2) && !t2.dispatchNonce) return { ok: false, reason: "dispatch_required", ticket: t2 };
    if (t2.status === "done") return { ok: false, reason: "done", ticket: t2 };
    if (pendingSubmission(t2) && !opts.force) return { ok: false, reason: "submitted", ticket: t2, submission: t2.submission };
    const held2 = t2.claim;
    if (held2 && held2.by && held2.by !== by && !isClaimStale(held2) && !opts.force) {
      return { ok: false, reason: "claimed", ticket: t2, claim: held2 };
    }
    const now = (/* @__PURE__ */ new Date()).toISOString();
    t2.claim = { by, at: now };
    if (opts.direct && isRoutedTicket(t2)) {
      t2.directClaim = {
        by,
        at: now,
        model: t2.model,
        effort: t2.effort,
        executor: opts.executor ? String(opts.executor) : null,
        source: opts.source ? String(opts.source) : "store"
      };
    }
    const state = dispatchState(t2);
    if (state) {
      state.sessionId = opts.sessionId ? String(opts.sessionId) : state.sessionId || null;
      state.claimedAt = now;
      state.outcome = "claimed";
    }
    if (opts.status !== false) t2.status = coerceStatus(opts.status || "doing", t2.status);
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
  if (held && held.by && held.by !== by && !isClaimStale(held)) {
    return { ok: false, reason: "claimed", ticket: t, claim: held };
  }
  return result;
}
function releaseTicket(slug, idOrRef, by, opts) {
  opts = opts || {};
  by = String(by || "agent");
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
    const held = t.claim;
    if (held && held.by && held.by !== by && !isClaimStale(held) && !opts.force) {
      return { ok: false, reason: "not_owner", ticket: t, claim: held };
    }
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const previousStatus = t.status;
    let comment = null;
    const dispatch = dispatchState(t);
    t.claim = null;
    setDispatchTerminal(t, opts.status === "done" ? "done" : "released", opts.source || "cli");
    t.dispatchNonce = null;
    t.dispatchExecutor = null;
    if (opts.status) t.status = coerceStatus(opts.status, t.status);
    if (t.status === "todo" && (previousStatus !== "todo" || held && held.by)) {
      appendReworkEvent(t, "released_to_todo", {
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
        commentId: null
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
    return { ok: true, ticket: t, comment };
  });
}
function makeWorkedBy(input) {
  if (!input) return null;
  const rawModel = input.model;
  if (rawModel == null || String(rawModel).trim() === "") return null;
  const model = normalizeRouteModel(rawModel);
  if (!model || !availableRoute(model)) {
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
  const workedBy = makeWorkedBy({ model: opts.model, effort: opts.effort, by });
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
const SUBMISSION_COMMIT_RE = /^[0-9a-f]{7,64}$/i;
const SUBMISSION_GITREF_MAX = 200;
const SUBMISSION_WORKTREE_MAX = 500;
function submissionUnscopedPaths(paths) {
  return Array.from(new Set((Array.isArray(paths) ? paths : []).map((value) => String(value || "").trim().replace(/\\/g, "/")).filter(Boolean)));
}
function submissionRangeMetadata(range, commit) {
  if (!range) return null;
  const base = String(range.base || "").trim().toLowerCase();
  const upstream = String(range.upstream || "").trim();
  const upstreamCommit = String(range.upstreamCommit || "").trim().toLowerCase();
  const commits = Array.isArray(range.commits) ? range.commits.map((value) => String(value).trim().toLowerCase()) : [];
  const changedPaths = Array.isArray(range.changedPaths) ? range.changedPaths.map((value) => String(value).trim().replace(/\\/g, "/")).filter(Boolean) : [];
  if (!SUBMISSION_COMMIT_RE.test(base) || !upstream || !SUBMISSION_COMMIT_RE.test(upstreamCommit) || !commits.length || commits.some((value) => !SUBMISSION_COMMIT_RE.test(value)) || commits[commits.length - 1] !== commit) {
    throw new Error("invalid submission range metadata");
  }
  return { base, upstream, upstreamCommit, commits, changedPaths };
}
function pendingSubmission(t) {
  return !!(t && t.submission && t.submission.commit && !t.submission.integratedAt);
}
function submissionGitRef(ticket) {
  return `refs/sidequest/${ticket.ref}`;
}
function submitTicket(slug, idOrRef, by, opts) {
  opts = opts || {};
  by = String(by || "agent");
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
    if (held && held.by && held.by !== by && !isClaimStale(held) && !opts.force) {
      return { ok: false, reason: "not_owner", ticket: t, claim: held };
    }
    if ((!held || !held.by) && !opts.force) return { ok: false, reason: "not_claimed", ticket: t };
    t.submission = Object.assign({
      by,
      at: (/* @__PURE__ */ new Date()).toISOString(),
      commit,
      gitRef: gitRef || submissionGitRef(t),
      verify,
      worktree,
      unscopedPaths: submissionUnscopedPaths(opts.unscopedPaths),
      integratedAt: null
    }, range || {});
    const dispatch = dispatchState(t);
    t.claim = null;
    setDispatchTerminal(t, "submitted", opts.source || "cli");
    t.dispatchNonce = null;
    t.dispatchExecutor = null;
    t.status = "doing";
    if (dispatch) stampDispatchEvent(t, opts.source || "cli");
    else {
      t.lastEventType = "status";
      t.lastEventSource = opts.source ? String(opts.source) : "cli";
      t.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    }
    putTicket(slug, t);
    if (opts.sessionId) unregisterClaim(opts.sessionId, slug, t.id);
    queueEventNotification(slug, t, t.lastEventType, t.lastEventSource);
    return { ok: true, ticket: t };
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
function submissionsPayload(slug) {
  const tickets = listTickets(slug).filter((t) => !t.archived && t.status !== "done" && pendingSubmission(t)).sort((a, b) => String(a.submission.at).localeCompare(String(b.submission.at))).map((t) => ({
    ref: t.ref,
    title: t.title,
    status: t.status,
    files: Array.isArray(t.files) ? t.files : [],
    executorVerify: t.executorVerify || null,
    submission: t.submission
  }));
  return { tickets, count: tickets.length };
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
      if (ticket.archived || ticket.status === "done" || !isClaimStale(ticket.claim)) continue;
      try {
        const res = releaseTicket(project.slug, ticket.id, ticket.claim.by, { status: "todo", source });
        if (!res.ok) continue;
        released.push({ project: project.slug, ref: ticket.ref });
        addComment(project.slug, ticket.id, {
          by: "sidequest",
          kind: "comment",
          source,
          body: `Auto-released to **todo**: claim exceeded the ${Math.round(claimTtlMs() / 6e4)} minute TTL (was claimed by \`${ticket.claim.by}\`).`
        });
      } catch (_) {
      }
    }
  }
  const dispatches = sweepStaleDispatches(opts);
  return { ok: true, ttlMs: claimTtlMs(), released, expiredDispatches: dispatches.expired };
}
function modelMatches(ticketModel, want) {
  return !want || ticketModel === want;
}
function readyTickets(slug, opts) {
  opts = opts || {};
  const want = opts.model ? classifyModelFilter(opts.model) : "any";
  if (want === "unknown") throw new Error(`Unknown model: ${opts.model}`);
  const category = opts.category == null ? null : String(opts.category).trim().toLowerCase();
  return listTickets(slug).filter((t) => !t.archived).filter((t) => t.status !== "done").filter((t) => !pendingSubmission(t)).filter((t) => !t.claim || isClaimStale(t.claim)).filter((t) => !isBlocked(slug, t)).filter((t) => modelMatches(t.model, want === "any" ? null : want)).filter((t) => !category || t.categoryId === category).sort((a, b) => {
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
  const candidates = listTickets(slug).filter((t) => !t.archived).filter((t) => t.status !== "done").filter((t) => !pendingSubmission(t)).filter((t) => !t.claim || isClaimStale(t.claim) || t.claim.by === by).filter((t) => !opts.priority || t.priority === String(opts.priority).toLowerCase()).filter((t) => modelMatches(t.model, want === "any" ? null : want)).filter((t) => !category || t.categoryId === category).filter((t) => opts.includeBlocked || !isBlocked(slug, t)).sort((a, b) => {
    const pr = priorityRank(a.priority) - priorityRank(b.priority);
    if (pr !== 0) return pr;
    return String(a.createdAt).localeCompare(String(b.createdAt));
  });
  for (const cand of candidates) {
    const res = claimTicket(slug, cand.id, by, { direct: !!opts.direct, source: opts.source, sessionId: opts.sessionId });
    if (res.ok) return res;
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
function createStory(slug, fields) {
  return transaction(() => {
    fields = fields || {};
    const id = newStoryId();
    const seq = nextStorySeq(slug);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const story = {
      id,
      ref: `US-${seq}`,
      title: String(fields.title || "Untitled story").trim().slice(0, 200) || "Untitled story",
      description: String(fields.description || "").trim(),
      // A requested colour wins if it parses; otherwise cycle the palette by the
      // sequence number so successive stories stay visually distinct.
      color: parseStoryColor(fields.color) || autoStoryColor(seq - 1),
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
    s.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    putStory(slug, s);
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
const COMMENT_KINDS = ["comment", "question"];
const COMMENT_BODY_MAX = 16e3;
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
  return {
    ok: true,
    by: String(fields.by || "agent"),
    kind: COMMENT_KINDS.indexOf(String(fields.kind)) !== -1 ? String(fields.kind) : "comment",
    body,
    source: fields.source ? String(fields.source) : "cli"
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
    t.lastEventType = comment.kind === "question" ? "question" : "comment";
    t.lastEventSource = comment.source;
    t.updatedAt = comment.at;
    putTicket(slug, t);
    queueEventNotification(slug, t, t.lastEventType, t.lastEventSource, { commentBody: comment.body });
    return { ok: true, ticket: t, comment };
  });
}
function needsResponse(ticket) {
  const comments = ticket && Array.isArray(ticket.comments) ? ticket.comments : [];
  for (let i = comments.length - 1; i >= 0; i--) {
    const c = comments[i];
    if (c.source === "dashboard") return false;
    if (c.kind === "question") return true;
  }
  return false;
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
    model: t.model || null,
    backend: t.exec ? t.exec.backend : null,
    runsModel: t.exec ? t.exec.runsModel : null,
    apiModel: t.exec ? t.exec.apiModel : null,
    runsLabel: t.exec ? t.exec.runsLabel : null,
    executor: t.exec ? t.exec.agent : null,
    effort: t.effort || null,
    direct: t.directClaim || null,
    files: Array.isArray(t.files) ? t.files : [],
    claim: t.claim && t.claim.by ? { by: t.claim.by, at: t.claim.at, stale: isClaimStale(t.claim) } : null,
    blockedBy,
    comments: Array.isArray(t.comments) ? t.comments.length : 0,
    awaitingReply: needsResponse(t),
    submission: pendingSubmission(t) ? { commit: t.submission.commit, at: t.submission.at } : null
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
function listPayload(slug, opts) {
  opts = opts || {};
  const project = String(slug || "");
  const filter = { archived: !!opts.archived, status: opts.status };
  const total = countTickets(project, filter);
  let index;
  if (opts.brief) {
    const rows = db.selectRows(database(), "SELECT ref, status FROM tickets WHERE project = ?", [project]);
    index = new Map(rows.map((row) => [String(row.ref).toUpperCase(), row]));
  }
  if (!opts.all && opts.limit != null && opts.maxChars == null) {
    const offset = Math.min(decodeListCursor(opts.cursor), total);
    let tickets2 = queryTickets(project, { ...filter, limit: opts.limit, offset });
    if (opts.brief) tickets2 = tickets2.map((ticket) => briefTicket(project, ticket, { index }));
    const returned = tickets2.length;
    const nextOffset = offset + returned;
    return {
      tickets: tickets2,
      total,
      returned,
      nextCursor: nextOffset < total ? String(nextOffset) : null,
      claimTtlMs: claimTtlMs(),
      categories: classifierCategories({ project })
    };
  }
  let tickets = queryTickets(project, filter);
  if (opts.brief) tickets = tickets.map((ticket) => briefTicket(project, ticket, { index }));
  const page = pageTickets(tickets, opts);
  page.claimTtlMs = claimTtlMs();
  page.categories = classifierCategories({ project });
  return page;
}
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
    ageMs: Number.isFinite(atMs) ? Math.max(0, now - atMs) : null
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
  if (!claim || !claim.by) return { working: false, lastActivityAt: null };
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
      outcome: dispatch.outcome || null
    } : null,
    submission: ticket.submission || null,
    git
  };
}
function changesPayload(slug, since) {
  const serverTime = (/* @__PURE__ */ new Date()).toISOString();
  const defaultSince = new Date(Date.now() - 60 * 60 * 1e3).toISOString();
  const after = since == null ? defaultSince : String(since);
  const afterMs = Date.parse(after);
  if (!Number.isFinite(afterMs)) throw new Error("changes: --since must be an ISO timestamp.");
  const tickets = listTickets(slug).filter((ticket) => Date.parse(ticket.updatedAt) > afterMs).sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt)).map((ticket) => ({
    ref: ticket.ref,
    title: ticket.title,
    status: ticket.status,
    lastEventType: ticket.lastEventType || null,
    lastEventSource: ticket.lastEventSource || null,
    claim: claimPulse(ticket.claim, Date.now()),
    updatedAt: ticket.updatedAt
  }));
  return { since: after, serverTime, tickets };
}
const NOTIFICATION_KINDS = ["question", "comment", "created", "status", "reminder"];
const NOTIFY_PREF_DEFAULTS = { question: true, comment: true, created: true, status: true };
const MAX_READ_KEPT = 100;
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
  writeGlobal("notifications", { notifications: list });
}
function withNotificationsLock(fn) {
  const lock = notificationsLockPath();
  const locked = acquireLock(lock);
  try {
    return transaction(fn);
  } finally {
    if (locked) releaseLock(lock);
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
  if (kind === "question") return { title: `❓ Question · ${ref}`, body: extra.commentBody || ticket.title };
  if (kind === "comment") {
    return { title: `💬 Comment · ${ref}`, body: extra.commentBody ? `${extra.commentBody}  —  ${ticket.title}` : ticket.title };
  }
  if (kind === "created") return { title: `New side quest · ${ref}`, body: ticket.title };
  return { title: `${ref} → ${ticket.status}`, body: ticket.title };
}
function queueEventNotification(slug, ticket, kind, source, extra) {
  if (!ticket || !source || String(source) === "dashboard") return null;
  if (NOTIFY_PREF_DEFAULTS[kind] == null) return null;
  if (!getNotifyPrefs()[kind]) return null;
  const pmeta = readMeta(slug);
  if (pmeta && pmeta.notify === false) return null;
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
    ticketEventAt: eventAt
  });
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
      const res = releaseTicket(c.slug, c.ticketId, t.claim.by, { status: "todo", source });
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
  DISPATCH_DESCRIPTION_MIN,
  dispatchDescriptionError,
  dispatchWarnings,
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
  spawnDescription,
  resolveCategoryRoute,
  claudeQuotaFailure,
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
  boardConfig,
  setBoardConfig,
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
  sessionClaims
};
