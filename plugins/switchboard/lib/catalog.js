'use strict';

const { VALID_EFFORTS, normalizeRoute } = require('./categories.js');

const GATEWAY_CATALOG_SCHEMA_VERSION = 3;
const GATEWAY_SOURCE = 'codex-gateway';
const GATEWAY_SPAWN_MODEL = 'claude-codex-auto';
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;
const GATEWAY_MODEL_ID_RE = /^claude-codex-[a-z0-9][a-z0-9._-]*(?:\[1m\])?$/i;
const NATIVE_MODELS = Object.freeze([
  { slug: 'haiku', id: 'haiku', label: 'Claude Haiku', source: 'claude', provider: 'native' },
  { slug: 'sonnet', id: 'sonnet', label: 'Claude Sonnet', source: 'claude', provider: 'native' },
  { slug: 'opus', id: 'opus', label: 'Claude Opus', source: 'claude', provider: 'native' },
  { slug: 'fable', id: 'fable', label: 'Claude Fable', source: 'claude', provider: 'native' },
]);

function parseGatewayCatalog(value) {
  if (value == null) return { entries: [], warnings: [], status: 'missing' };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { entries: [], warnings: ['Codex Gateway model catalog must be an object.'], status: 'invalid' };
  }
  if (value.schemaVersion !== GATEWAY_CATALOG_SCHEMA_VERSION) {
    return {
      entries: [],
      warnings: [`Codex Gateway model catalog schemaVersion ${value.schemaVersion} is unsupported; expected ${GATEWAY_CATALOG_SCHEMA_VERSION}.`],
      status: 'unsupported',
    };
  }
  if (value.source !== GATEWAY_SOURCE || !Array.isArray(value.models)) {
    return { entries: [], warnings: ['Codex Gateway model catalog is missing its source or models array.'], status: 'invalid' };
  }

  const entries = [];
  const warnings = [];
  const seen = new Set();
  value.models.forEach((row, index) => {
    const slug = row && typeof row.slug === 'string' ? row.slug.trim().toLowerCase() : '';
    const id = row && typeof row.id === 'string' ? row.id.trim() : '';
    const label = row && typeof row.label === 'string' ? row.label.trim() : '';
    if (!SLUG_RE.test(slug) || !GATEWAY_MODEL_ID_RE.test(id) || !label) {
      warnings.push(`Codex Gateway model catalog entry ${index} is malformed and was ignored.`);
      return;
    }
    const key = `${GATEWAY_SOURCE}:${slug}`;
    if (seen.has(key)) {
      warnings.push(`Codex Gateway model catalog contains duplicate model "${slug}"; the duplicate was ignored.`);
      return;
    }
    seen.add(key);
    entries.push({ slug, id, label, source: GATEWAY_SOURCE, provider: 'gateway', key });
  });
  return { entries, warnings, status: warnings.length ? 'partial' : 'valid' };
}

function normalizeModelCaps(value) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) return new Set();
  return new Set(value.map((model) => typeof model === 'string' ? model.trim().toLowerCase() : '').filter(Boolean));
}

function normalizeRouteCaps(value) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) return [];
  return value.map(normalizeRoute).filter(Boolean);
}

function dispatchModelFor(id) {
  return String(id || '').replace(/^claude-codex-/, '').replace(/\[1m\]$/, '');
}

function createModelCatalog({ gatewayCatalog = null, allowedModels, allowedRoutes, userAllowedModels, userAllowedRoutes, projectAllowedModels, projectAllowedRoutes } = {}) {
  const parsed = parseGatewayCatalog(gatewayCatalog);
  const entries = NATIVE_MODELS.map((entry) => Object.assign({}, entry, { key: `${entry.source}:${entry.slug}` })).concat(parsed.entries);
  const qualified = new Map(entries.map((entry) => [entry.key, entry]));
  const bySlug = new Map();
  for (const entry of entries) {
    const group = bySlug.get(entry.slug) || [];
    group.push(entry);
    bySlug.set(entry.slug, group);
  }

  const modelCaps = [
    ['effective', normalizeModelCaps(allowedModels)],
    ['user', normalizeModelCaps(userAllowedModels)],
    ['project', normalizeModelCaps(projectAllowedModels)],
  ];
  const routeCaps = [
    ['effective', normalizeRouteCaps(allowedRoutes)],
    ['user', normalizeRouteCaps(userAllowedRoutes)],
    ['project', normalizeRouteCaps(projectAllowedRoutes)],
  ];

  function lookup(model) {
    const normalized = typeof model === 'string' ? model.trim().toLowerCase() : '';
    if (qualified.has(normalized)) return { entry: qualified.get(normalized), ambiguous: false };
    const matches = bySlug.get(normalized) || [];
    if (matches.length === 1) return { entry: matches[0], ambiguous: false };
    return { entry: null, ambiguous: matches.length > 1 };
  }

  function capAllowsModel(cap, entry, requestedModel) {
    if (cap === null) return true;
    return cap.has(requestedModel) || cap.has(entry.slug) || cap.has(entry.key);
  }

  function capAllowsRoute(cap, entry, route) {
    if (cap === null) return true;
    return cap.some((candidate) => {
      const resolved = lookup(candidate.model);
      return resolved.entry && resolved.entry.key === entry.key && candidate.effort === route.effort;
    });
  }

  function checkRoute(value) {
    const route = normalizeRoute(value);
    if (!route) return { available: false, route: null, reason: 'Route is missing a valid model and effort.' };
    const found = lookup(route.model);
    if (found.ambiguous) {
      return { available: false, route, reason: `Model "${route.model}" is ambiguous; use a source-qualified model id.` };
    }
    if (!found.entry) {
      return { available: false, route, reason: `Model "${route.model}" is not available in the current model catalog.` };
    }
    const entry = found.entry;
    for (const [scope, cap] of modelCaps) {
      if (!capAllowsModel(cap, entry, route.model)) {
        return { available: false, route, entry, reason: `Model "${route.model}" is blocked by the ${scope} allowedModels cap.` };
      }
    }
    if (entry.slug === 'haiku' && route.effort !== null) {
      return { available: false, route, entry, reason: 'Claude Haiku routes must use a null effort.' };
    }
    if (entry.provider === 'gateway' && !VALID_EFFORTS.includes(route.effort)) {
      return { available: false, route, entry, reason: `Gateway model "${route.model}" requires an explicit effort.` };
    }
    for (const [scope, cap] of routeCaps) {
      if (!capAllowsRoute(cap, entry, route)) {
        const effort = route.effort === null ? 'null' : route.effort;
        return { available: false, route, entry, reason: `Route "${route.model}/${effort}" is blocked by the ${scope} allowedRoutes cap.` };
      }
    }
    return { available: true, route, entry, reason: null };
  }

  function dispatchFor(entry, effort) {
    if (entry.provider === 'native') return { kind: 'native', spawnModel: entry.slug };
    const dispatchModel = dispatchModelFor(entry.id);
    return {
      kind: 'gateway-marker',
      spawnModel: GATEWAY_SPAWN_MODEL,
      dispatchModel,
      marker: `[switchboard-route model=${dispatchModel} effort=${effort}]`,
    };
  }

  function availableModels() {
    return entries.map((entry) => {
      const efforts = entry.slug === 'haiku' ? [null] : VALID_EFFORTS;
      const available = efforts.some((effort) => checkRoute({ model: entry.key, effort }).available);
      return {
        model: entry.slug,
        qualifiedModel: entry.key,
        id: entry.id,
        label: entry.label,
        source: entry.source,
        provider: entry.provider,
        available,
      };
    });
  }

  return {
    schemaVersion: GATEWAY_CATALOG_SCHEMA_VERSION,
    status: parsed.status,
    warnings: parsed.warnings.slice(),
    models: availableModels(),
    checkRoute,
    dispatchFor,
  };
}

module.exports = {
  GATEWAY_CATALOG_SCHEMA_VERSION,
  GATEWAY_SOURCE,
  GATEWAY_SPAWN_MODEL,
  NATIVE_MODELS,
  createModelCatalog,
  dispatchModelFor,
  parseGatewayCatalog,
};
