'use strict';

const {
  CONFIG_SCHEMA_VERSION,
  PROVIDER_NEUTRAL_DISPATCH_KINDS,
  ROUTE_SOURCES,
  ROUTING_CONTRACT_VERSION,
} = require('./schema.js');

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasOnlyKeys(value, keys) {
  return Object.keys(value).every((key) => keys.includes(key));
}

function validateRoute(value, errors, label, withSource) {
  const keys = withSource ? ['model', 'effort', 'source'] : ['model', 'effort'];
  if (!isRecord(value) || !hasOnlyKeys(value, keys) || !isText(value.model) || !('effort' in value) || (value.effort !== null && !isText(value.effort))) {
    errors.push(`${label} must contain a model and effort.`);
  }
}

function validateCategory(value, errors, label) {
  const keys = ['id', 'name', 'description', 'contract', 'route', 'fallback', 'enabled'];
  if (!isRecord(value) || !hasOnlyKeys(value, keys) || !keys.every((key) => Object.hasOwn(value, key))) {
    errors.push(`${label} must be a complete category row.`);
    return;
  }
  if (!isText(value.id) || !isText(value.name) || typeof value.description !== 'string' || typeof value.contract !== 'string' || typeof value.enabled !== 'boolean') {
    errors.push(`${label} has invalid category fields.`);
  }
  validateRoute(value.route, errors, `${label}.route`);
  if (value.fallback !== null) validateRoute(value.fallback, errors, `${label}.fallback`);
}

function validateRoutingRequest(value) {
  const errors = [];
  const keys = ['contractVersion', 'categoryId', 'projectPath', 'consumer'];
  if (!isRecord(value) || !hasOnlyKeys(value, keys)) errors.push('Request must be an object with known fields.');
  if (!value || value.contractVersion !== ROUTING_CONTRACT_VERSION) errors.push(`Unsupported routing contract version: ${value && value.contractVersion}.`);
  if (!value || !isText(value.categoryId)) errors.push('Request categoryId is required.');
  if (value && Object.hasOwn(value, 'projectPath') && !isText(value.projectPath)) errors.push('Request projectPath must be text.');
  if (value && Object.hasOwn(value, 'consumer') && !isText(value.consumer)) errors.push('Request consumer must be text.');
  return { valid: errors.length === 0, errors };
}

function validateAttempt(value, errors, label) {
  if (!isRecord(value) || !hasOnlyKeys(value, ['source', 'route', 'reason'])) {
    errors.push(`${label} must contain source, route, and reason.`);
    return;
  }
  if (!ROUTE_SOURCES.includes(value.source)) errors.push(`${label}.source is invalid.`);
  validateRoute(value.route, errors, `${label}.route`);
  if (!isText(value.reason)) errors.push(`${label}.reason must be text.`);
}

function validateCategoryProjection(value, errors) {
  if (!isRecord(value) || !hasOnlyKeys(value, ['id', 'contract']) || !isText(value.id) || typeof value.contract !== 'string') {
    errors.push('Result category must contain id and contract.');
  }
}

function validateDispatch(value, effort, errors) {
  if (!isRecord(value) || !PROVIDER_NEUTRAL_DISPATCH_KINDS.includes(value.kind) || !isText(value.spawnModel)) {
    errors.push('Result dispatch must identify a provider-neutral kind and spawn model.');
    return;
  }
  if (value.kind === 'native') {
    if (!hasOnlyKeys(value, ['kind', 'spawnModel'])) errors.push('Native dispatch has unsupported fields.');
    return;
  }
  if (!hasOnlyKeys(value, ['kind', 'spawnModel', 'dispatchModel', 'marker']) || !isText(value.dispatchModel) || !isText(value.marker)) {
    errors.push('Gateway-marker dispatch is incomplete.');
    return;
  }
  if (value.marker !== `[switchboard-route model=${value.dispatchModel} effort=${effort}]`) {
    errors.push('Gateway-marker dispatch marker does not match the resolved route.');
  }
}

function validateRoutingResult(value) {
  const errors = [];
  if (!isRecord(value)) return { valid: false, errors: ['Result must be an object.'] };
  if (value.contractVersion !== ROUTING_CONTRACT_VERSION) errors.push(`Unsupported routing contract version: ${value.contractVersion}.`);
  if (!['routed', 'unrouted'].includes(value.status)) errors.push('Result status must be routed or unrouted.');
  const baseKeys = value.status === 'routed'
    ? ['contractVersion', 'status', 'category', 'route', 'dispatch', 'attempts', 'warnings']
    : ['contractVersion', 'status', 'category', 'attempts', 'warnings'];
  if (!hasOnlyKeys(value, baseKeys)) errors.push('Result contains unsupported fields.');
  if (value.category !== null) validateCategoryProjection(value.category, errors);
  if (value.status === 'routed') {
    validateRoute(value.route, errors, 'Result route', true);
    if (!isRecord(value.route) || !ROUTE_SOURCES.includes(value.route.source)) errors.push('Result route source is invalid.');
    validateDispatch(value.dispatch, value.route && value.route.effort, errors);
  }
  if (!Array.isArray(value.attempts)) errors.push('Result attempts must be an array.');
  else value.attempts.forEach((attempt, index) => validateAttempt(attempt, errors, `Result attempts[${index}]`));
  if (!Array.isArray(value.warnings) || value.warnings.some((warning) => typeof warning !== 'string')) errors.push('Result warnings must be an array of text.');
  if (value.status === 'unrouted' && (!Array.isArray(value.warnings) || value.warnings.length === 0)) errors.push('Unrouted results must explain why.');
  return { valid: errors.length === 0, errors };
}

function validateRegistryBreadcrumb(value) {
  const errors = [];
  const keys = ['schemaVersion', 'name', 'version', 'root', 'capabilities', 'routing', 'ui'];
  if (!isRecord(value) || !hasOnlyKeys(value, keys)) errors.push('Registry breadcrumb contains unsupported fields.');
  if (!value || value.schemaVersion !== CONFIG_SCHEMA_VERSION) errors.push(`Unsupported registry schema version: ${value && value.schemaVersion}.`);
  if (!value || value.name !== 'switchboard' || !isText(value.version) || !isText(value.root)) errors.push('Registry breadcrumb must identify Switchboard and its installation root.');
  if (!value || !Array.isArray(value.capabilities) || !value.capabilities.includes('routing')) errors.push('Registry breadcrumb must advertise routing capability.');
  const routing = value && value.routing;
  if (!isRecord(routing) || !hasOnlyKeys(routing, ['contractVersion', 'command', 'adapter']) || routing.contractVersion !== ROUTING_CONTRACT_VERSION || routing.command !== 'bin/switchboard.js routing resolve --request <json>' || routing.adapter !== 'lib/contract.js') {
    errors.push('Registry routing descriptor is invalid.');
  }
  return { valid: errors.length === 0, errors };
}

function createRegistryBreadcrumb({ root, version, panels } = {}) {
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    name: 'switchboard',
    version,
    root,
    capabilities: ['routing', 'categories'],
    routing: {
      contractVersion: ROUTING_CONTRACT_VERSION,
      command: 'bin/switchboard.js routing resolve --request <json>',
      adapter: 'lib/contract.js',
    },
    ui: {
      contractVersion: ROUTING_CONTRACT_VERSION,
      panels: Array.isArray(panels) ? panels : [{ id: 'routing', label: 'Routing', entry: 'dashboard/panels/routing.js', capability: 'routing' }],
    },
  };
}

function routingPanelData({ categories, globalFallback, availableModels, warnings } = {}) {
  return {
    contractVersion: ROUTING_CONTRACT_VERSION,
    categories: Array.isArray(categories) ? categories : [],
    globalFallback: globalFallback || null,
    availableModels: Array.isArray(availableModels) ? availableModels : [],
    warnings: Array.isArray(warnings) ? warnings : [],
  };
}

module.exports = {
  createRegistryBreadcrumb,
  routingPanelData,
  validateCategory,
  validateRegistryBreadcrumb,
  validateRoutingRequest,
  validateRoutingResult,
};
