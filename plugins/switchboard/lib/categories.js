'use strict';

const { DEFAULT_CATEGORIES } = require('./category-defaults.js');

const VALID_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
const CATEGORY_ID_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const MODEL_RE = /^[a-z0-9][a-z0-9.:-]{0,127}$/;
const COMPLETE_CATEGORY_FIELDS = Object.freeze(['name', 'description', 'contract', 'route', 'fallback', 'enabled']);
const PATCH_FIELDS = new Set(COMPLETE_CATEGORY_FIELDS);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeCategoryId(value) {
  const id = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return CATEGORY_ID_RE.test(id) ? id : null;
}

function normalizeRoute(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const model = typeof value.model === 'string' ? value.model.trim().toLowerCase() : '';
  if (!MODEL_RE.test(model)) return null;
  if (value.effort === null) return { model, effort: null };
  const effort = typeof value.effort === 'string' ? value.effort.trim().toLowerCase() : '';
  return VALID_EFFORTS.includes(effort) ? { model, effort } : null;
}

function normalizeCategory(value, idOverride) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const id = normalizeCategoryId(idOverride || value.id);
  const route = normalizeRoute(value.route);
  const fallback = value.fallback === null ? null : normalizeRoute(value.fallback);
  if (!id || !route || (value.fallback !== null && !fallback)) return null;
  if (typeof value.name !== 'string' || !value.name.trim()) return null;
  if (typeof value.description !== 'string' || typeof value.contract !== 'string' || typeof value.enabled !== 'boolean') return null;
  return {
    id,
    name: value.name.trim().slice(0, 120),
    description: value.description.trim(),
    route,
    fallback,
    contract: value.contract.trim(),
    enabled: value.enabled,
  };
}

function isCompleteCategory(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && COMPLETE_CATEGORY_FIELDS.every((field) => Object.hasOwn(value, field));
}

function layerEntries(layer) {
  if (!layer) return [];
  if (Array.isArray(layer)) {
    return layer.map((value) => [normalizeCategoryId(value && value.id), value]);
  }
  if (typeof layer !== 'object') return [];
  return Object.entries(layer).map(([id, value]) => [normalizeCategoryId(id), value]);
}

function overlayKind(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.kind !== 'string') return null;
  return value.kind.trim().toUpperCase();
}

function mergePatch(base, patch, id) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return null;
  if (Object.keys(patch).some((field) => field !== 'id' && !PATCH_FIELDS.has(field))) return null;
  return normalizeCategory(Object.assign({}, base || {}, patch, { id }), id);
}

function applyOverlay(categories, states, warnings, layer, scope) {
  for (const [id, raw] of layerEntries(layer)) {
    if (!id) {
      warnings.push(`${scope} category override has an invalid id.`);
      continue;
    }
    const base = categories.get(id) || null;
    const kind = overlayKind(raw);
    const data = kind ? raw.data : raw;

    if (kind === 'RELINK' || kind === 'RESET') continue;
    if (raw === null || kind === 'DISABLE') {
      if (id === 'general') {
        warnings.push('Category "general" cannot be disabled.');
      } else if (!base) {
        warnings.push(`${scope} category "${id}" cannot be disabled because it does not exist.`);
      } else {
        categories.set(id, Object.assign({}, base, { enabled: false }));
        states[id] = 'disabled';
      }
      continue;
    }

    if (kind && !['ADD', 'OVERRIDE', 'DETACH'].includes(kind)) {
      warnings.push(`${scope} category "${id}" uses unsupported overlay kind "${kind}".`);
      continue;
    }
    if (kind === 'ADD' && base) {
      warnings.push(`${scope} category ADD "${id}" collides with an inherited category.`);
      continue;
    }
    if (kind === 'OVERRIDE' && !base) {
      warnings.push(`${scope} category OVERRIDE "${id}" has no inherited category.`);
      continue;
    }
    if ((kind === 'ADD' || kind === 'DETACH') && !isCompleteCategory(data)) {
      warnings.push(`${scope} category ${kind} "${id}" requires a complete category row.`);
      continue;
    }

    const normalized = kind === 'ADD' || kind === 'DETACH'
      ? normalizeCategory(Object.assign({}, data, { id }), id)
      : mergePatch(base, data, id);
    if (!normalized) {
      warnings.push(`${scope} category "${id}" is invalid and was ignored.`);
      continue;
    }
    if (id === 'general') normalized.enabled = true;
    categories.set(id, normalized);
    states[id] = normalized.enabled === false
      ? 'disabled'
      : kind === 'DETACH'
        ? 'detached'
        : base
          ? 'customized'
          : 'added';
  }
}

function resolveCategories({ shipped = DEFAULT_CATEGORIES, global = null, project = null, includeDisabled = true } = {}) {
  const categories = new Map();
  const states = {};
  const warnings = [];
  for (const [id, row] of layerEntries(shipped)) {
    const normalized = normalizeCategory(row, id);
    if (!normalized) {
      warnings.push(`Shipped category "${id || '<invalid>'}" is invalid and was ignored.`);
      continue;
    }
    categories.set(normalized.id, normalized);
    states[normalized.id] = 'inherited';
  }

  applyOverlay(categories, states, warnings, global, 'Global');
  applyOverlay(categories, states, warnings, project, 'Project');

  const generalDefault = normalizeCategory(DEFAULT_CATEGORIES.find((category) => category.id === 'general'));
  const general = categories.get('general') || generalDefault;
  if (general) {
    categories.set('general', Object.assign({}, general, { id: 'general', enabled: true }));
    if (states.general === 'disabled') states.general = 'customized';
  }

  const all = [...categories.values()].sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  const visible = includeDisabled ? all : all.filter((category) => category.enabled);
  return {
    categories: clone(visible),
    byId: Object.fromEntries(all.map((category) => [category.id, clone(category)])),
    states: Object.assign({}, states),
    warnings,
  };
}

module.exports = {
  VALID_EFFORTS,
  clone,
  isCompleteCategory,
  normalizeCategory,
  normalizeCategoryId,
  normalizeRoute,
  resolveCategories,
};
