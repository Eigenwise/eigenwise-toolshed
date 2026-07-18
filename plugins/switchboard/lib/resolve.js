'use strict';

const { ROUTING_CONTRACT_VERSION } = require('./schema.js');
const { HARD_DEFAULT_ROUTE } = require('./category-defaults.js');
const { normalizeCategoryId, normalizeRoute } = require('./categories.js');
const { createModelCatalog } = require('./catalog.js');

const SOURCE_LABELS = Object.freeze({
  primary: 'primary route',
  'category-fallback': 'category fallback',
  'global-fallback': 'global fallback',
  'hard-default': 'hardwired fallback',
});

function categoryMap(categories) {
  if (Array.isArray(categories)) return Object.fromEntries(categories.map((category) => [category.id, category]));
  return categories && typeof categories === 'object' ? categories : {};
}

function addWarning(warnings, message) {
  if (message && !warnings.includes(message)) warnings.push(message);
}

function unrouted(category, attempts, warnings, message) {
  addWarning(warnings, message);
  return {
    contractVersion: ROUTING_CONTRACT_VERSION,
    status: 'unrouted',
    category: category ? { id: category.id, contract: category.contract } : null,
    attempts,
    warnings,
  };
}

function resolveCategoryRoute({ categoryId, categories, globalFallback = null, catalog, warnings: initialWarnings = [] } = {}) {
  const id = normalizeCategoryId(categoryId);
  const byId = categoryMap(categories);
  const category = id ? byId[id] : null;
  const warnings = Array.isArray(initialWarnings) ? initialWarnings.slice() : [];
  const attempts = [];
  const modelCatalog = catalog && typeof catalog.checkRoute === 'function' ? catalog : createModelCatalog();
  for (const warning of modelCatalog.warnings || []) addWarning(warnings, warning);

  if (!category) return unrouted(null, attempts, warnings, `Category "${id || categoryId || ''}" does not exist.`);
  if (category.enabled === false) return unrouted(category, attempts, warnings, `Category "${category.id}" is disabled.`);

  function tryCandidate(source, value) {
    const route = normalizeRoute(value);
    if (!route) {
      addWarning(warnings, `${SOURCE_LABELS[source]} is missing or invalid.`);
      return null;
    }
    const checked = modelCatalog.checkRoute(route);
    if (!checked.available) {
      attempts.push({ source, route, reason: checked.reason });
      addWarning(warnings, `Category "${category.id}" ${SOURCE_LABELS[source]} was skipped: ${checked.reason}`);
      return null;
    }
    return {
      contractVersion: ROUTING_CONTRACT_VERSION,
      status: 'routed',
      category: { id: category.id, contract: category.contract },
      route: Object.assign({}, checked.route, { source }),
      dispatch: modelCatalog.dispatchFor(checked.entry, checked.route.effort),
      attempts,
      warnings,
    };
  }

  let result = tryCandidate('primary', category.route);
  if (result) return result;

  if (category.fallback !== null) {
    result = tryCandidate('category-fallback', category.fallback);
    if (result) return result;
  }

  if (globalFallback !== null) {
    result = tryCandidate('global-fallback', globalFallback);
    if (result) return result;
  } else {
    addWarning(warnings, 'Global routing fallback is missing; trying hardwired sonnet/high.');
  }

  result = tryCandidate('hard-default', HARD_DEFAULT_ROUTE);
  if (result) {
    addWarning(result.warnings, 'Configured routes were unavailable; using hardwired sonnet/high.');
    return result;
  }
  return unrouted(category, attempts, warnings, 'Every route in the fallback chain is unavailable.');
}

module.exports = {
  SOURCE_LABELS,
  resolveCategoryRoute,
};
