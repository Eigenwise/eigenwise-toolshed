'use strict';

const { CONFIG_SCHEMA_VERSION, ROUTING_CONTRACT_VERSION } = require('./schema.js');
const { DEFAULT_CATEGORIES } = require('./category-defaults.js');
const { DEFAULT_CONFIG, applyLayer, projectConfigPath, readLayer, userConfigPath, writeConfig } = require('./config.js');
const { clone, normalizeCategory, normalizeCategoryId, normalizeRoute, resolveCategories } = require('./categories.js');
const { createModelCatalog } = require('./catalog.js');
const { createRegistryBreadcrumb, resolveRoutingRequest } = require('./contract.js');
const migration = require('./migrate.js');

const SERVER_NAME = 'switchboard';
const DEFAULT_PROTOCOL_VERSION = '2024-11-05';

function layer(file) {
  return readLayer(file) || { schemaVersion: CONFIG_SCHEMA_VERSION };
}

function categoryLayers(projectPath) {
  const user = layer(userConfigPath());
  const project = layer(projectConfigPath(projectPath));
  return { user, project };
}

function state(projectPath, globalOnly = false) {
  const paths = { user: userConfigPath(), project: projectConfigPath(projectPath) };
  const layers = categoryLayers(projectPath);
  const config = globalOnly
    ? applyLayer(DEFAULT_CONFIG, layers.user)
    : applyLayer(applyLayer(DEFAULT_CONFIG, layers.user), layers.project);
  const resolved = resolveCategories({
    shipped: DEFAULT_CATEGORIES,
    global: layers.user.categories || null,
    project: globalOnly ? null : layers.project.categories || null,
  });
  const catalog = createModelCatalog({
    allowedModels: config.allowedModels,
    allowedRoutes: config.allowedRoutes,
  });
  return { config, paths, layers, resolved, catalog };
}

function categoryOrThrow(id, current) {
  const normalized = normalizeCategoryId(id);
  const category = normalized && current.resolved.byId[normalized];
  if (!category) throw new Error(`No effective category "${id}".`);
  return category;
}

function routeOrThrow(route, catalog, label) {
  const normalized = normalizeRoute(route);
  if (!normalized) throw new Error(`${label} must contain a valid model and effort.`);
  const checked = catalog.checkRoute(normalized);
  if (!checked.available) throw new Error(`${label} is unavailable: ${checked.reason}`);
  return normalized;
}

function checkedCategory(value, current) {
  const category = normalizeCategory(value);
  if (!category) throw new Error('Category must be a complete valid row.');
  routeOrThrow(category.route, current.catalog, `Category "${category.id}" route`);
  if (category.fallback !== null) routeOrThrow(category.fallback, current.catalog, `Category "${category.id}" fallback`);
  return category;
}

function targetLayer(projectPath, project) {
  const current = state(projectPath, !project);
  return {
    current,
    file: project ? current.paths.project : current.paths.user,
    raw: clone(project ? current.layers.project : current.layers.user),
  };
}

function saveCategoryOverlay(target, id, value) {
  target.raw.categories = Object.assign({}, target.raw.categories || {}, { [id]: value });
  return writeConfig(target.file, target.raw);
}

function listCategories({ projectPath, global = false, includeDisabled = true } = {}) {
  const current = state(projectPath, global);
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    scope: global ? 'global' : 'effective',
    paths: current.paths,
    categories: includeDisabled ? current.resolved.categories : current.resolved.categories.filter((category) => category.enabled),
    states: current.resolved.states,
    warnings: current.resolved.warnings,
  };
}

function showCategory({ id, projectPath, global = false } = {}) {
  const current = state(projectPath, global);
  const category = categoryOrThrow(id, current);
  return { category, state: current.resolved.states[category.id], warnings: current.resolved.warnings };
}

function addCategory({ category, projectPath, project = false } = {}) {
  const target = targetLayer(projectPath, project);
  const normalized = checkedCategory(category, target.current);
  if (target.current.resolved.byId[normalized.id]) throw new Error(`Category "${normalized.id}" already exists.`);
  saveCategoryOverlay(target, normalized.id, project ? { kind: 'ADD', data: normalized } : normalized);
  return showCategory({ id: normalized.id, projectPath });
}

function editCategory({ id, patch, projectPath, project = false } = {}) {
  const target = targetLayer(projectPath, project);
  const existing = categoryOrThrow(id, target.current);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Category patch must be an object.');
  const next = checkedCategory(Object.assign({}, existing, patch, { id: existing.id }), target.current);
  if (project) {
    const prior = target.raw.categories && target.raw.categories[existing.id];
    saveCategoryOverlay(target, existing.id, prior && prior.kind === 'ADD' ? { kind: 'ADD', data: next } : { kind: 'DETACH', data: next });
  } else {
    saveCategoryOverlay(target, existing.id, next);
  }
  return showCategory({ id: existing.id, projectPath });
}

function disableCategory({ id, projectPath, project = false } = {}) {
  const normalized = normalizeCategoryId(id);
  if (!normalized) throw new Error(`Invalid category id "${id}".`);
  if (normalized === 'general') throw new Error('Category "general" cannot be disabled.');
  const target = targetLayer(projectPath, project);
  categoryOrThrow(normalized, target.current);
  saveCategoryOverlay(target, normalized, project ? { kind: 'DISABLE', data: {} } : null);
  return showCategory({ id: normalized, projectPath });
}

function removeCategory({ id, projectPath, project = false } = {}) {
  const normalized = normalizeCategoryId(id);
  if (!normalized) throw new Error(`Invalid category id "${id}".`);
  if (normalized === 'general') throw new Error('Category "general" cannot be removed.');
  const target = targetLayer(projectPath, project);
  categoryOrThrow(normalized, target.current);
  target.raw.categories = Object.assign({}, target.raw.categories || {});
  if (project && !Object.hasOwn(target.raw.categories, normalized)) {
    target.raw.categories[normalized] = { kind: 'DISABLE', data: {} };
  } else {
    delete target.raw.categories[normalized];
  }
  writeConfig(target.file, target.raw);
  return listCategories({ projectPath });
}

function detachCategory({ id, projectPath } = {}) {
  const target = targetLayer(projectPath, true);
  const existing = categoryOrThrow(id, target.current);
  saveCategoryOverlay(target, existing.id, { kind: 'DETACH', data: existing });
  return showCategory({ id: existing.id, projectPath });
}

function relinkCategory({ id, projectPath } = {}) {
  const target = targetLayer(projectPath, true);
  const normalized = normalizeCategoryId(id);
  if (!normalized) throw new Error(`Invalid category id "${id}".`);
  target.raw.categories = Object.assign({}, target.raw.categories || {});
  if (!Object.hasOwn(target.raw.categories, normalized)) throw new Error(`Category "${normalized}" has no project override to relink.`);
  delete target.raw.categories[normalized];
  writeConfig(target.file, target.raw);
  return showCategory({ id: normalized, projectPath });
}

function getFallback({ projectPath } = {}) {
  const current = state(projectPath);
  return { fallback: current.config.globalFallback, paths: current.paths };
}

function setFallback({ route, projectPath, project = false } = {}) {
  const target = targetLayer(projectPath, project);
  const normalized = route === null ? null : routeOrThrow(route, target.current.catalog, 'Global fallback');
  target.raw.globalFallback = normalized;
  writeConfig(target.file, target.raw);
  return getFallback({ projectPath });
}

function availableModels({ projectPath } = {}) {
  const current = state(projectPath);
  return { catalogSchemaVersion: current.catalog.schemaVersion, status: current.catalog.status, models: current.catalog.models, warnings: current.catalog.warnings };
}

function resolve({ categoryId, projectPath, consumer } = {}) {
  const current = state(projectPath);
  const request = { contractVersion: ROUTING_CONTRACT_VERSION, categoryId };
  if (projectPath !== undefined) request.projectPath = projectPath;
  if (consumer !== undefined) request.consumer = consumer;
  return resolveRoutingRequest(request, {
    config: current.config,
    categories: current.resolved.byId,
    modelCatalog: current.catalog,
    globalFallback: current.config.globalFallback,
  });
}

function contract() {
  return createRegistryBreadcrumb({ root: process.cwd(), version: require('../.claude-plugin/plugin.json').version });
}

function doctor({ projectPath } = {}) {
  const current = state(projectPath);
  const fallback = current.config.globalFallback === null ? null : current.catalog.checkRoute(current.config.globalFallback);
  return {
    ok: current.resolved.warnings.length === 0 && current.catalog.warnings.length === 0 && (!fallback || fallback.available),
    schemaVersion: CONFIG_SCHEMA_VERSION,
    paths: current.paths,
    categoryWarnings: current.resolved.warnings,
    catalogWarnings: current.catalog.warnings,
    globalFallback: fallback,
  };
}

function migrationCommand({ apply = false } = {}) {
  return apply ? migration.applyMigration() : migration.previewMigration();
}

function schema(properties, required) {
  return { type: 'object', properties, required };
}

function categoryInput(required = ['id']) {
  return schema({
    id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, contract: { type: 'string' },
    routeModel: { type: 'string' }, routeEffort: { type: ['string', 'null'] }, fallbackModel: { type: ['string', 'null'] }, fallbackEffort: { type: ['string', 'null'] },
    enabled: { type: 'boolean' }, projectPath: { type: 'string' }, project: { type: 'boolean' },
  }, required);
}

function categoryFromArgs(args, existing) {
  const route = args.routeModel === undefined && args.routeEffort === undefined
    ? existing && existing.route
    : { model: args.routeModel === undefined ? existing.route.model : args.routeModel, effort: args.routeEffort === undefined ? existing.route.effort : args.routeEffort };
  const fallbackChanged = args.fallbackModel !== undefined || args.fallbackEffort !== undefined;
  const fallback = !fallbackChanged ? existing && existing.fallback : (args.fallbackModel === null && args.fallbackEffort === null ? null : {
    model: args.fallbackModel === undefined ? existing.fallback && existing.fallback.model : args.fallbackModel,
    effort: args.fallbackEffort === undefined ? existing.fallback && existing.fallback.effort : args.fallbackEffort,
  });
  return {
    id: args.id === undefined ? existing.id : args.id,
    name: args.name === undefined ? existing.name : args.name,
    description: args.description === undefined ? existing.description : args.description,
    contract: args.contract === undefined ? existing.contract : args.contract,
    route,
    fallback,
    enabled: args.enabled === undefined ? existing.enabled : args.enabled,
  };
}

const TOOLS = [
  { name: 'category_list', description: 'List effective Switchboard categories and their inheritance state.', inputSchema: schema({ projectPath: { type: 'string' }, global: { type: 'boolean' }, includeDisabled: { type: 'boolean' } }), handler: (args) => listCategories(args) },
  { name: 'category_show', description: 'Show one effective Switchboard category.', inputSchema: schema({ id: { type: 'string' }, projectPath: { type: 'string' }, global: { type: 'boolean' } }, ['id']), handler: (args) => showCategory(args) },
  { name: 'category_add', description: 'Add a complete global or project-local category.', inputSchema: categoryInput(['id', 'name', 'routeModel', 'routeEffort']), handler: (args) => addCategory({ category: categoryFromArgs(args, { id: args.id, name: '', description: '', contract: '', route: {}, fallback: null, enabled: true }), projectPath: args.projectPath, project: args.project === true }) },
  { name: 'category_edit', description: 'Edit a category. Project edits detach the category first.', inputSchema: categoryInput(['id']), handler: (args) => { const existing = showCategory(Object.assign({}, args, { global: args.project !== true })).category; return editCategory({ id: args.id, patch: categoryFromArgs(args, existing), projectPath: args.projectPath, project: args.project === true }); } },
  { name: 'category_disable', description: 'Disable a category at global or project scope.', inputSchema: schema({ id: { type: 'string' }, projectPath: { type: 'string' }, project: { type: 'boolean' } }, ['id']), handler: (args) => disableCategory(args) },
  { name: 'category_remove', description: 'Remove a local category row or disable an inherited row.', inputSchema: schema({ id: { type: 'string' }, projectPath: { type: 'string' }, project: { type: 'boolean' } }, ['id']), handler: (args) => removeCategory(args) },
  { name: 'category_detach', description: 'Fork a project category into a detached complete row.', inputSchema: schema({ id: { type: 'string' }, projectPath: { type: 'string' } }, ['id']), handler: (args) => detachCategory(args) },
  { name: 'category_relink', description: 'Drop a project category overlay and follow inherited policy.', inputSchema: schema({ id: { type: 'string' }, projectPath: { type: 'string' } }, ['id']), handler: (args) => relinkCategory(args) },
  { name: 'category_reset', description: 'Alias for category_relink.', inputSchema: schema({ id: { type: 'string' }, projectPath: { type: 'string' } }, ['id']), handler: (args) => relinkCategory(args) },
  { name: 'global_fallback', description: 'Read or set the global fallback route.', inputSchema: schema({ model: { type: ['string', 'null'] }, effort: { type: ['string', 'null'] }, projectPath: { type: 'string' }, project: { type: 'boolean' } }), handler: (args) => args.model === undefined && args.effort === undefined ? getFallback(args) : setFallback({ route: args.model === null && args.effort === null ? null : { model: args.model, effort: args.effort }, projectPath: args.projectPath, project: args.project === true }) },
  { name: 'available_models', description: 'List available models and effort-cap intersections.', inputSchema: schema({ projectPath: { type: 'string' } }), handler: (args) => availableModels(args) },
  { name: 'routing_resolve', description: 'Resolve a category with every fallback attempt and dispatch contract.', inputSchema: schema({ categoryId: { type: 'string' }, projectPath: { type: 'string' }, consumer: { type: 'string' } }, ['categoryId']), handler: (args) => resolve(args) },
  { name: 'routing_contract', description: 'Return the Switchboard routing contract breadcrumb.', inputSchema: schema({}), handler: () => contract() },
  { name: 'doctor', description: 'Check config schema, categories, catalog, and fallback availability.', inputSchema: schema({ projectPath: { type: 'string' } }), handler: (args) => doctor(args) },
  { name: 'migrate', description: 'Preview or apply legacy numeric preferences migration.', inputSchema: schema({ apply: { type: 'boolean' } }), handler: (args) => migrationCommand(args) },
];

const TOOL_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

function toolDescriptors() {
  return TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

function handleRequest(msg) {
  if (!msg || msg.jsonrpc !== '2.0') return null;
  const { id, method, params } = msg;
  if (method === 'initialize') return { jsonrpc: '2.0', id, result: { protocolVersion: (params && params.protocolVersion) || DEFAULT_PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: { name: SERVER_NAME, version: require('../.claude-plugin/plugin.json').version } } };
  if (method && method.startsWith('notifications/')) return null;
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: toolDescriptors() } };
  if (method === 'tools/call') {
    const tool = TOOL_BY_NAME.get(params && params.name);
    if (!tool) return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Unknown tool "${params && params.name}".` }], isError: true } };
    try {
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(tool.handler((params && params.arguments) || {}), null, 2) }] } };
    } catch (error) {
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: error.message }], isError: true } };
    }
  }
  return id === undefined || id === null ? null : { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}

module.exports = {
  DEFAULT_PROTOCOL_VERSION,
  SERVER_NAME,
  TOOLS,
  addCategory,
  availableModels,
  contract,
  detachCategory,
  disableCategory,
  doctor,
  editCategory,
  getFallback,
  handleRequest,
  listCategories,
  migrationCommand,
  relinkCategory,
  removeCategory,
  resolve,
  setFallback,
  showCategory,
  toolDescriptors,
};

if (require.main === module) {
  let buffer = '';
  const respond = (message) => { if (message) process.stdout.write(JSON.stringify(message) + '\n'); };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line);
        (Array.isArray(message) ? message : [message]).forEach((entry) => respond(handleRequest(entry)));
      } catch (_) {}
    }
  });
  process.stdin.resume();
}
