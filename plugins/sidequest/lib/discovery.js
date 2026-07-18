'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;
const CATALOG_SOURCES = [
  { source: 'codex-gateway', relPath: path.join('codex-gateway', 'catalog.json'), schemas: new Set([2, 3]) },
];
const SWITCHBOARD_CONTRACT_VERSION = 1;
const SWITCHBOARD_REGISTRY_RELATIVE_PATH = path.join('toolshed', 'registry', 'switchboard.json');
const SWITCHBOARD_COMMAND = 'bin/switchboard.js routing resolve --request <json>';
const SWITCHBOARD_ADAPTER = 'lib/contract.js';
const ROUTE_SOURCES = new Set(['primary', 'category-fallback', 'global-fallback', 'hard-default']);
const switchboardResolutionCache = new Map();

function discoveryRoots() {
  const override = process.env.SIDEQUEST_DISCOVERY_DIRS;
  if (override && String(override).trim()) {
    return String(override).split(',').map((value) => value.trim()).filter(Boolean).map((value) => path.resolve(value));
  }
  return [path.join(os.homedir(), '.claude')];
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function catalogModels(data, schemas) {
  if (!data || typeof data !== 'object') return [];
  const schema = data.schemaVersion ?? data.schema;
  if (!schemas.has(schema) || !Array.isArray(data.models)) return [];
  return data.models;
}

function validateEntry(raw, source) {
  if (!raw || typeof raw !== 'object') return null;
  const slug = typeof raw.slug === 'string' ? raw.slug.trim().toLowerCase() : '';
  if (!SLUG_RE.test(slug)) return null;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id) return null;
  const label = typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : slug;
  return { slug, id, label, source };
}

function discoverExternalModels() {
  const out = [];
  const seen = new Set();
  for (const root of discoveryRoots()) {
    for (const { source, relPath, schemas } of CATALOG_SOURCES) {
      const data = readJsonSafe(path.join(root, relPath));
      const models = catalogModels(data, schemas);
      for (const raw of models) {
        const entry = validateEntry(raw, source);
        const key = entry && `${entry.source}:${entry.slug}`;
        if (!entry || seen.has(key)) continue;
        seen.add(key);
        out.push(entry);
      }
    }
  }
  return out;
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasOnlyKeys(value, keys) {
  return isRecord(value) && Object.keys(value).every((key) => keys.includes(key));
}

function containedEntry(root, entry) {
  if (!isText(entry) || path.isAbsolute(entry)) return null;
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, entry);
  return resolved.startsWith(resolvedRoot + path.sep) ? resolved : null;
}

function switchboardRegistryCandidates() {
  const override = process.env.SIDEQUEST_SWITCHBOARD_REGISTRY_FILE;
  if (override && String(override).trim()) return [path.resolve(String(override).trim())];
  return discoveryRoots().map((root) => path.join(root, SWITCHBOARD_REGISTRY_RELATIVE_PATH));
}

function validateSwitchboardBreadcrumb(value) {
  const errors = [];
  const warnings = [];
  const topKeys = ['schemaVersion', 'name', 'version', 'root', 'capabilities', 'routing', 'ui'];
  if (!hasOnlyKeys(value, topKeys)) errors.push('Registry breadcrumb must be an object with contract v1 fields only.');
  if (!value || value.schemaVersion !== 1) errors.push(`Unsupported Switchboard registry schema version: ${value && value.schemaVersion}.`);
  if (!value || value.name !== 'switchboard' || !isText(value.version) || !isText(value.root)) errors.push('Registry breadcrumb must identify Switchboard and its installation root.');
  if (!value || !Array.isArray(value.capabilities) || !value.capabilities.includes('routing')) errors.push('Registry breadcrumb does not advertise routing.');
  if (!value || !hasOnlyKeys(value.routing, ['contractVersion', 'command', 'adapter']) || value.routing.contractVersion !== SWITCHBOARD_CONTRACT_VERSION || value.routing.command !== SWITCHBOARD_COMMAND || value.routing.adapter !== SWITCHBOARD_ADAPTER) {
    errors.push('Registry routing descriptor is not the Sidequest-supported contract v1 command.');
  }

  const root = value && isText(value.root) && path.isAbsolute(value.root) ? path.resolve(value.root) : null;
  if (value && isText(value.root) && !root) errors.push('Switchboard installation root must be absolute.');
  const commandPath = root && containedEntry(root, 'bin/switchboard.js');
  const adapterPath = root && containedEntry(root, SWITCHBOARD_ADAPTER);
  if (root && (!commandPath || !fs.existsSync(commandPath))) errors.push('Switchboard contract command is missing from its advertised root.');
  if (root && (!adapterPath || !fs.existsSync(adapterPath))) errors.push('Switchboard contract adapter is missing from its advertised root.');

  let panel = { available: false, reason: 'Switchboard did not advertise a routing panel.' };
  if (value && value.ui !== undefined) {
    if (!hasOnlyKeys(value.ui, ['contractVersion', 'panels']) || value.ui.contractVersion !== SWITCHBOARD_CONTRACT_VERSION || !Array.isArray(value.ui.panels)) {
      warnings.push('Switchboard UI descriptor is incompatible with host contract v1.');
      panel = { available: false, reason: warnings[warnings.length - 1] };
    } else {
      const descriptor = value.ui.panels.find((candidate) => isRecord(candidate) && candidate.id === 'routing' && candidate.capability === 'routing');
      if (!descriptor || !hasOnlyKeys(descriptor, ['id', 'label', 'entry', 'capability']) || !isText(descriptor.entry)) {
        warnings.push('Switchboard did not advertise a valid routing panel entry.');
        panel = { available: false, reason: warnings[warnings.length - 1] };
      } else if (root) {
        const advertised = containedEntry(root, descriptor.entry);
        const conventional = containedEntry(root, 'dashboard/panel.js');
        const panelFile = advertised && fs.existsSync(advertised)
          ? advertised
          : conventional && fs.existsSync(conventional)
            ? conventional
            : null;
        const hostFile = containedEntry(root, 'lib/mcp.js');
        if (panelFile && hostFile && fs.existsSync(hostFile)) {
          if (panelFile !== advertised) warnings.push('Switchboard routing panel used the contract v1 dashboard/panel.js fallback because the advertised entry was absent.');
          panel = { available: true, contractVersion: SWITCHBOARD_CONTRACT_VERSION, descriptor, file: panelFile, hostFile };
        } else {
          warnings.push('Switchboard routing panel or host adapter is missing from its advertised root.');
          panel = { available: false, reason: warnings[warnings.length - 1] };
        }
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings, root, commandPath, adapterPath, panel };
}

function discoverSwitchboard() {
  const candidates = switchboardRegistryCandidates();
  const diagnostics = [];
  let found = false;
  for (const registryPath of candidates) {
    if (!fs.existsSync(registryPath)) continue;
    found = true;
    let breadcrumb;
    try {
      breadcrumb = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    } catch (error) {
      diagnostics.push(`Could not parse Switchboard registry breadcrumb at ${registryPath}: ${error.message}`);
      continue;
    }
    const checked = validateSwitchboardBreadcrumb(breadcrumb);
    if (!checked.valid) {
      diagnostics.push(...checked.errors.map((error) => `${registryPath}: ${error}`));
      continue;
    }
    return {
      available: true,
      status: 'available',
      contractVersion: SWITCHBOARD_CONTRACT_VERSION,
      registryPath,
      version: breadcrumb.version,
      root: checked.root,
      commandPath: checked.commandPath,
      adapterPath: checked.adapterPath,
      panel: checked.panel,
      diagnostics: checked.warnings,
    };
  }
  return {
    available: false,
    status: found ? 'incompatible' : 'missing',
    contractVersion: SWITCHBOARD_CONTRACT_VERSION,
    registryPath: candidates[0] || null,
    panel: { available: false, reason: found ? 'Switchboard registry contract is incompatible.' : 'Switchboard registry breadcrumb was not found.' },
    diagnostics: diagnostics.length ? diagnostics : ['Switchboard registry breadcrumb was not found.'],
  };
}

function validateRoute(value, withSource, errors, label) {
  const keys = withSource ? ['model', 'effort', 'source'] : ['model', 'effort'];
  if (!hasOnlyKeys(value, keys) || !isText(value.model) || !Object.hasOwn(value, 'effort') || (value.effort !== null && !isText(value.effort))) {
    errors.push(`${label} must contain model and effort.`);
    return;
  }
  if (withSource && !ROUTE_SOURCES.has(value.source)) errors.push(`${label} source is invalid.`);
}

function validateSwitchboardRoutingResult(value) {
  const errors = [];
  if (!isRecord(value)) return { valid: false, errors: ['Result must be an object.'] };
  if (value.contractVersion !== SWITCHBOARD_CONTRACT_VERSION) errors.push(`Unsupported routing contract version: ${value.contractVersion}.`);
  if (!['routed', 'unrouted'].includes(value.status)) errors.push('Result status must be routed or unrouted.');
  const keys = value.status === 'routed'
    ? ['contractVersion', 'status', 'category', 'route', 'dispatch', 'attempts', 'warnings']
    : ['contractVersion', 'status', 'category', 'attempts', 'warnings'];
  if (!hasOnlyKeys(value, keys)) errors.push('Result contains unsupported fields.');
  if (value.category !== null && (!hasOnlyKeys(value.category, ['id', 'contract']) || !isText(value.category.id) || typeof value.category.contract !== 'string')) errors.push('Result category is invalid.');
  if (value.status === 'routed') {
    validateRoute(value.route, true, errors, 'Result route');
    if (!isRecord(value.dispatch) || !['native', 'gateway-marker'].includes(value.dispatch.kind) || !isText(value.dispatch.spawnModel)) {
      errors.push('Result dispatch is invalid.');
    } else if (value.dispatch.kind === 'native') {
      if (!hasOnlyKeys(value.dispatch, ['kind', 'spawnModel'])) errors.push('Native dispatch contains unsupported fields.');
    } else if (!hasOnlyKeys(value.dispatch, ['kind', 'spawnModel', 'dispatchModel', 'marker']) || !isText(value.dispatch.dispatchModel) || value.dispatch.marker !== `[switchboard-route model=${value.dispatch.dispatchModel} effort=${value.route && value.route.effort}]`) {
      errors.push('Gateway-marker dispatch is invalid.');
    }
  }
  if (!Array.isArray(value.attempts)) errors.push('Result attempts must be an array.');
  else value.attempts.forEach((attempt, index) => {
    if (!hasOnlyKeys(attempt, ['source', 'route', 'reason']) || !ROUTE_SOURCES.has(attempt.source) || !isText(attempt.reason)) {
      errors.push(`Result attempts[${index}] is invalid.`);
      return;
    }
    validateRoute(attempt.route, false, errors, `Result attempts[${index}].route`);
  });
  if (!Array.isArray(value.warnings) || value.warnings.some((warning) => typeof warning !== 'string')) errors.push('Result warnings must be text.');
  if (value.status === 'unrouted' && (!Array.isArray(value.warnings) || value.warnings.length === 0)) errors.push('Unrouted results must explain why.');
  return { valid: errors.length === 0, errors };
}

function switchboardCacheMs() {
  const configured = Number(process.env.SIDEQUEST_SWITCHBOARD_CACHE_MS);
  return Number.isFinite(configured) && configured >= 0 ? configured : 5000;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function resolveThroughSwitchboard({ categoryId, projectPath, consumer = 'sidequest' } = {}) {
  const discovered = discoverSwitchboard();
  if (!discovered.available) {
    return { status: discovered.status, result: null, diagnostics: discovered.diagnostics, switchboard: discovered, panel: discovered.panel };
  }
  const request = { contractVersion: SWITCHBOARD_CONTRACT_VERSION, categoryId: String(categoryId || '') };
  if (projectPath) request.projectPath = path.resolve(projectPath);
  if (consumer) request.consumer = consumer;
  const cacheKey = JSON.stringify([discovered.registryPath, request]);
  const cached = switchboardResolutionCache.get(cacheKey);
  const ttl = switchboardCacheMs();
  if (cached && Date.now() - cached.at <= ttl) return clone(cached.value);

  let child;
  try {
    child = spawnSync(process.execPath, [discovered.commandPath, 'routing', 'resolve', '--request', JSON.stringify(request)], {
      cwd: request.projectPath || discovered.root,
      encoding: 'utf8',
      maxBuffer: 256 * 1024,
      timeout: Math.max(250, Number(process.env.SIDEQUEST_SWITCHBOARD_TIMEOUT_MS) || 3000),
      windowsHide: true,
    });
  } catch (error) {
    child = { error };
  }

  let value;
  if (child.error) {
    value = { status: 'error', result: null, diagnostics: [`Switchboard comparison failed: ${child.error.message}`], switchboard: discovered, panel: discovered.panel };
  } else if (child.status !== 0) {
    const detail = String(child.stderr || child.stdout || `exit ${child.status}`).trim();
    value = { status: 'error', result: null, diagnostics: [`Switchboard comparison failed: ${detail}`], switchboard: discovered, panel: discovered.panel };
  } else {
    let result;
    try {
      result = JSON.parse(String(child.stdout || '').trim());
    } catch (error) {
      value = { status: 'incompatible', result: null, diagnostics: [`Switchboard returned invalid JSON: ${error.message}`], switchboard: discovered, panel: discovered.panel };
    }
    if (result) {
      const checked = validateSwitchboardRoutingResult(result);
      value = checked.valid
        ? { status: result.status, result, diagnostics: result.warnings.slice(), switchboard: discovered, panel: discovered.panel }
        : { status: 'incompatible', result: null, diagnostics: checked.errors, switchboard: discovered, panel: discovered.panel };
    }
  }
  switchboardResolutionCache.set(cacheKey, { at: Date.now(), value });
  return clone(value);
}

function loadSwitchboardHost() {
  const discovered = discoverSwitchboard();
  if (!discovered.available || !discovered.panel.available) return { available: false, discovery: discovered, reason: discovered.panel.reason || discovered.diagnostics.join(' ') };
  try {
    const api = require(discovered.panel.hostFile);
    const required = ['listCategories', 'availableModels', 'getFallback', 'doctor', 'resolve', 'editCategory', 'detachCategory', 'relinkCategory', 'disableCategory', 'setFallback'];
    const missing = required.filter((name) => typeof api[name] !== 'function');
    if (missing.length) return { available: false, discovery: discovered, reason: `Switchboard host contract is missing: ${missing.join(', ')}.` };
    return { available: true, discovery: discovered, panel: discovered.panel, api };
  } catch (error) {
    return { available: false, discovery: discovered, reason: `Switchboard host contract could not load: ${error.message}` };
  }
}

function clearSwitchboardCache() {
  switchboardResolutionCache.clear();
}

module.exports = {
  CATALOG_SOURCES,
  SWITCHBOARD_CONTRACT_VERSION,
  clearSwitchboardCache,
  discoverExternalModels,
  discoverSwitchboard,
  loadSwitchboardHost,
  resolveThroughSwitchboard,
  switchboardRegistryCandidates,
  validateSwitchboardBreadcrumb,
  validateSwitchboardRoutingResult,
};
