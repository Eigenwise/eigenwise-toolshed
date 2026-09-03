'use strict';

function createRouting(dependencies: any) {
  const {
    activeDispatchRoute,
    commitScope,
    configuredExternalModelProvider,
    crypto,
    database,
    db,
    discoverExternalModels,
    invalidateStoreCaches,
    listProjects,
    projectRoutingEnabled,
    providerReadiness,
    readGlobal,
    readMeta,
    refreshPreparedDispatches,
    residentCache,
    stableClaudeName,
    stableDispatchName,
    transaction,
    cloneCached,
    dispatchState,
  } = dependencies;

const CLAUDE_RUNTIMES = ['haiku', 'sonnet', 'opus', 'fable'];
const CLAUDE_RUNTIME_LABELS: Record<string, string> = {
  haiku: 'Claude Haiku', sonnet: 'Claude Sonnet',
  opus: 'Claude Opus 5', fable: 'Claude Fable',
};
const VALID_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const BACKEND_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;
const BACKEND_KEY_RE = /^([a-z0-9][a-z0-9-]{0,31}):([a-z0-9][a-z0-9-]{1,31})$/;
const HAIKU_BACKEND_EFFORT = 'medium';
const ROUTING_FALLBACK_DEFAULT = Object.freeze({ model: 'sonnet', effort: 'high' });
const CLAUDE_QUOTA_FAILURES = Object.freeze([
  Object.freeze({ matcher: /You've reached your (Fable|Opus|Sonnet|Haiku)(?: \d+(?:\.\d+)*)? limit\b/ }),
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
  return { backend: 'codex', provider: entry.provider, source: entry.source, slug: entry.slug, agentSlug, id: entry.id, label: entry.label };
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

// An executor reports the model it actually ran as the runtime id it sees
// ("claude-fable-5", "claude-opus-5[1m]"), not the board's tier name — and
// BACKEND_SLUG_RE happily accepts that string, so it reaches the catalog lookup
// and dies as "unknown model" on an otherwise correct closeout. Map the version
// suffix off a reporting form and land back on the tier (SQ-923).
function claudeRuntimeAlias(forms?: any) {
  for (const form of forms) {
    const runtime = String(form).replace(/-\d[\w.-]*$/, '');
    if (CLAUDE_RUNTIMES.includes(runtime)) return runtime;
  }
  return null;
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
  return claudeRuntimeAlias(forms);
}

function resolvedDispatchRoute(ticket?: any) {
  const route = ticket && ticket.dispatch && normalizeRoute(ticket.dispatch.route);
  return route && availableRoute(route.model) ? route : null;
}

// The id the model-gateway shim forwards upstream for a discovered backend: its
// advertised id minus the local claude- discovery prefix and any [1m] suffix.
// Dispatch briefings embed it as the [sidequest-route model=...] marker that
// resolves the shared executors' virtual claude-codex-auto pin (SQ-347).
//
// The optional codex- segment covers a catalog.json written by a pre-3.x
// gateway: a stale catalog would otherwise emit markers the shim can't resolve
// and take every dispatch on the board down at once (SQ-1004).
function dispatchModelFor(id?: any) {
  return String(id || '').replace(/^claude-(?:codex-)?/, '').replace(/\[1m\]$/, '');
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
  for (const failure of CLAUDE_QUOTA_FAILURES) {
    const match = text.match(failure.matcher);
    const family = match?.[1];
    if (match && family) return { model: family.toLowerCase(), signature: match[0] };
  }
  return null;
}

function classifyDispatchFailure(error?: any) {
  const text = String(error || '').trim();
  if (!text) return 'process_death';
  const normalized = text.toLowerCase();
  if (claudeQuotaFailure(text)) return 'quota_exhausted';
  if (/prompt is too long|request too large \(max 32mb\)|context (?:length|window).*(?:exceed|too (?:large|long)|overflow)|maximum context/.test(normalized)) return 'context_overflow';
  if (/\bmax(?:imum)?[_ -]?(?:output[_ -]?)?tokens?\b/.test(normalized)) return 'max_tokens';
  if (/\b(?:vite|app|service)\b.*\b(?:404|not found|missing)\b|\b(?:404|not found|missing)\b.*\b(?:vite|app|service)\b/.test(normalized)) return 'worktree_environment';
  if (/\b(?:agent|subagent)\b.*\b(?:terminated|stopped|died|crashed|fatal)\b|\b(?:terminated|stopped|died|crashed|fatal)\b.*\b(?:agent|subagent)\b/.test(normalized)) return 'agent_terminal';
  if (/not authenticated|unauthenticated|authentication failed|authorization failed|credential(?:s)? (?:rejected|invalid|expired)|(?:invalid|rejected) (?:credential|token)|\b401\b/.test(normalized)) return 'auth_failure';
  if (/backend (?:is )?(?:down|unavailable)|gateway (?:is )?(?:down|unavailable|not serving)|(?:model|model id).*(?:not (?:found|resolvable|available)|unavailable)|could not resolve.*model/.test(normalized)) return 'provider_unavailable';
  return 'unknown';
}

function terminalAgentFailure(error?: any) {
  const failureShape = classifyDispatchFailure(error);
  return ['context_overflow', 'max_tokens', 'worktree_environment', 'agent_terminal'].includes(failureShape) ? failureShape : null;
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
    readonly: raw.readonly === true,
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
    const allowed = new Set(['name', 'description', 'contract', 'artifactRoots', 'readonly', 'route', 'fallback']);
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

function routeProvider(route?: any) {
  const normalized = normalizeRoute(route);
  if (!normalized) return null;
  const backend = availableRoute(normalized.model);
  if (backend) return (backend as any).provider || backend.backend;
  const configuredProvider = configuredExternalModelProvider(normalized.model);
  if (configuredProvider) return configuredProvider;
  return normalized.model.startsWith('codex-') || normalized.model.startsWith('model-gateway:') ? 'codex' : null;
}

function routeReadyForAutomaticFallback(route?: any) {
  const provider = routeProvider(route);
  return !provider || provider === 'claude' || providerReadiness(provider)?.ready === true;
}

function resolveTicketRoute(ticket?: any, category?: any) {
  const warnings: any[] = [];
  const ref = String(ticket?.ref || 'Ticket');
  const override = ticket && ticket.route != null ? normalizeRoute(ticket.route) : null;
  if (ticket && ticket.route != null && !override) {
    return { model: null, effort: null, exec: null, warnings: [`${ref} route override is missing or invalid.`], refusal: `${ref} route override is missing or invalid.` };
  }
  if (!override) return resolveCategoryRoute(category);

  const primary = normalizeRoute(category && category.route);
  const provider = routeProvider(primary);
  if (primary && routeProvider(override) !== provider) {
    const message = `${ref} route override "${override.model}" crosses providers from category "${category.id}" and was refused.`;
    return { model: override.model, effort: override.effort, exec: null, warnings: [message], refusal: message };
  }
  const exec = resolveExec(override.model, override.effort);
  if (!exec || !availableRoute(override.model) || !routeReadyForAutomaticFallback(override)) {
    const message = `${ref} route override model "${override.model}" isn't currently available; explicit route overrides never fall back.`;
    return { model: override.model, effort: override.effort, exec: null, warnings: [message], refusal: message };
  }
  return { model: exec.runsModel, effort: override.effort, exec, warnings, override: true };
}

function resolveCategoryRoute(category?: any) {
  const warnings: any[] = [];
  const primary = normalizeRoute(category && category.route);
  if (!primary) return { model: null, effort: null, exec: null, warnings: ['Category route is missing or invalid.'] };
  const provider = routeProvider(primary);
  const candidates = [
    { source: 'route', route: primary },
    { source: 'category fallback', route: category && category.fallback },
    { source: 'global fallback', route: getRoutingFallback() },
  ];
  for (const candidate of candidates) {
    const route = normalizeRoute(candidate.route);
    if (!route) continue;
    if (candidate.source !== 'route' && routeProvider(route) !== provider) {
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
        ...(candidate.source === 'route' ? {} : { fallbackReason: `${candidate.source} replaced unavailable ${primary.model}.` }),
      };
    }
    warnings.push(`Category "${category.id}" ${candidate.source} model "${route.model}" isn't currently available.`);
  }
  return { model: primary.model, effort: primary.effort, exec: null, warnings };
}

function projectDispatchAdmission(project?: any) {
  const slug = String(project || '').trim();
  if (!slug) return { status: 'no-project', slug: null, route: null };
  if (!projectRoutingEnabled(slug)) return { status: 'routing-disabled', slug, route: null };
  for (const category of getCategories({ project: slug, includeDisabled: false })) {
    const route = resolveCategoryRoute(category);
    if (route.exec) return { status: 'routed', slug, route };
  }
  return { status: 'no-usable-route', slug, route: null };
}

function resolveCategoryFallback(category?: any, failedModel?: any) {
  const failedRoute = normalizeRoute({ model: failedModel, effort: 'low' });
  const provider = routeProvider(failedRoute);
  const candidates = [
    { source: 'category fallback', route: category && category.fallback },
    { source: 'global fallback', route: getRoutingFallback() },
  ];
  for (const candidate of candidates) {
    const route = normalizeRoute(candidate.route);
    if (!route || (candidate.source === 'global fallback' && routeProvider(route) !== provider)) continue;
    const exec = resolveExec(route.model, route.effort);
    if (!exec || !routeReadyForAutomaticFallback(route) || exec.runsModel === failedModel) continue;
    return { model: exec.runsModel, effort: route.effort, exec, source: candidate.source };
  }
  return null;
}

function providerDispatchRefusal(route?: any) {
  const provider = routeProvider(route);
  if (!provider || provider === 'claude') return null;
  const readiness = providerReadiness(provider);
  const name = provider === 'codex' ? 'Codex' : provider;
  if (!readiness) {
    return provider === 'codex'
      ? 'Codex dispatch refused: model-gateway readiness is unavailable. Run `node "<gateway>/bin/model-gateway.js" ensure`, then retry. No Anthropic fallback was used.'
      : `${name} dispatch refused: model-gateway readiness for provider ${provider} is unavailable. Run \`node "<gateway>/bin/model-gateway.js" ensure\`, then retry. No Anthropic fallback was used.`;
  }
  if (!readiness.ready) {
    return provider === 'codex'
      ? readiness.message
      : `${name} dispatch refused: ${readiness.message} Run \`node "<gateway>/bin/model-gateway.js" ensure\`, then retry. No Anthropic fallback was used.`;
  }
  if (!resolveExec(route.model, route.effort)) {
    return `${name} dispatch refused: configured route ${route.model} is not available from the live model-gateway catalog. Run \`node "<gateway>/bin/model-gateway.js" ensure\`, then retry. No Anthropic fallback was used.`;
  }
  return null;
}

function dispatchRouteRefusal(route?: any) {
  const normalized = normalizeRoute(route);
  if (!normalized) return 'Dispatch refused: the resolved route is missing or invalid.';
  return providerDispatchRefusal(normalized);
}

function ticketCategory(ticket?: any) {
  if (!ticket || ticket.category == null) return null;
  return typeof ticket.category === 'object' ? ticket.categoryId || ticket.category.id : String(ticket.category);
}

function execProjection(exec?: any) {
  return exec ? { agent: exec.agent, model: exec.model, backend: exec.backend, runsModel: exec.runsModel, apiModel: exec.apiModel, runsLabel: exec.runsLabel, dispatch: exec.dispatch } : null;
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
      const resolved = resolveTicketRoute(t, category);
      if (!legacy) t.categoryId = requestedId;
      t.category = Object.assign({}, category, { projectedFromGeneral: fallback });
      t.model = resolved.model;
      t.effort = resolved.effort;
      t.exec = execProjection(resolved.exec);
      warnings.push(...resolved.warnings);
    }
  } else if (t.route != null) {
    const resolved = resolveTicketRoute(t);
    t.category = null;
    t.model = resolved.model;
    t.effort = resolved.effort;
    t.exec = execProjection(resolved.exec);
    warnings.push(...resolved.warnings);
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

  return {
    CLAUDE_RUNTIMES,
    CLAUDE_RUNTIME_LABELS,
    VALID_EFFORTS,
    BACKEND_SLUG_RE,
    BACKEND_KEY_RE,
    HAIKU_BACKEND_EFFORT,
    ROUTING_FALLBACK_DEFAULT,
    CLAUDE_QUOTA_FAILURES,
    coerceEffort,
    coerceComplexity,
    backendKey,
    discoveredByKey,
    discoveredBySlug,
    resolvedBackend,
    normalizeRouteModel,
    availableRoute,
    reportingModelForms,
    claudeRuntimeAlias,
    normalizeReportedModel,
    resolvedDispatchRoute,
    dispatchModelFor,
    dispatchRouteState,
    execFromBackend,
    resolveExec,
    resolveReportedExec,
    resolveModelId,
    routingModels,
    getModelVocab,
    routeDescriptor,
    modelsPayload,
    classifyModelFilter,
    legacyCategoryForComplexity,
    normalizeRoute,
    claudeQuotaFailure,
    classifyDispatchFailure,
    terminalAgentFailure,
    getRoutingFallback,
    setRoutingFallback,
    routingProfileSettings,
    getRoutingProfile,
    routingProfileEntries,
    defaultRoutingProfileId,
    projectRoutingProfile,
    policyMutationProjects,
    mutateRoutingPolicy,
    projectCategoryRows,
    routingContext,
    resolvedProfileCategories,
    projectCategoryWarnings,
    getCategoryRoutePairs,
    getProjectCategories,
    getCategories,
    normalizeCategoryId,
    getCategory,
    normalizeArtifactRoots,
    requireArtifactRoots,
    normalizeCategory,
    routingProfileCategory,
    setRoutingProfileCategory,
    setCategory,
    removeRoutingProfileCategory,
    removeCategory,
    normalizeFullProjectCategory,
    setProjectCategory,
    detachCategory,
    setProjectRoutingProfile,
    setNewProjectRoutingProfile,
    listRoutingProfiles,
    normalizeRoutingProfileId,
    routingProfileDetails,
    createRoutingProfile,
    editRoutingProfile,
    retireRoutingProfile,
    canonicalRoutingValue,
    routingFingerprint,
    normalizedTaxonomy,
    canonicalLocalRows,
    localRowsFingerprint,
    routingProfileHygiene,
    hypotheticalTaxonomy,
    taxonomyDrift,
    repointRoutingProfiles,
    promoteRoutingProfile,
    removeProjectCategory,
    classifierCategories,
    routeProvider,
    routeReadyForAutomaticFallback,
    projectDispatchAdmission,
    resolveTicketRoute,
    resolveCategoryRoute,
    resolveCategoryFallback,
    providerDispatchRefusal,
    dispatchRouteRefusal,
    ticketCategory,
    execProjection,
    applyDerivedRouting,
  };
}

module.exports = { createRouting };
