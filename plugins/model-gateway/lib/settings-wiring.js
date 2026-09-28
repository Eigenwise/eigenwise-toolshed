'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeFileAtomically } = require('./atomic-file.js');
const { COMPAT_BASE_URL, COMPAT_HOST, DEFAULT_BASE_URL, GATEWAY_MODELS_CACHE, gatewayClientModelId, LEGACY_ENV_BLOCK, PIN_ALIASES, PROJECT_WIRING_REGISTRY_PATH, STATIC_ENV_BLOCK, STATE, WIRING_CONFIG_PATH } = require('./runtime.js');
const { effectivePins, isGatewayModelId, ourBaseUrls, ownedPinValues } = require('./pins.js');

// Project-local wiring is the default so each repository opts into the
// machine-local gateway endpoint independently. Claude Code still lets a local
// setting shadow user settings, so doctor reports the effective source and
// treats conflicting gateway modes as an error.
const WIRING_SCOPE = 'project';

function selectedWiringScope() {
  return WIRING_SCOPE;
}

// A leftover {"mode":"local"} from an older install must not silently keep a
// project wired against the user scope, so retiring the file is part of migrating.
function retireWiringModeConfig() {
  try {
    fs.rmSync(WIRING_CONFIG_PATH);
    return true;
  } catch { return false; }
}

function settingsPath(scope) {
  if (scope === 'project') return path.join(process.cwd(), '.claude', 'settings.local.json');
  if (scope === 'legacy-project' || scope === 'project-shared') return path.join(process.cwd(), '.claude', 'settings.json');
  return path.join(os.homedir(), '.claude', 'settings.json');
}

function effectiveBaseUrl() {
  const definitions = [];
  if (typeof process.env.ANTHROPIC_BASE_URL === 'string') {
    definitions.push({ source: 'env', file: null, value: process.env.ANTHROPIC_BASE_URL });
  }
  for (const source of ['project-local', 'project-shared', 'user']) {
    const scope = source === 'project-local' ? 'project' : source;
    const file = settingsPath(scope);
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8')).env?.ANTHROPIC_BASE_URL;
      if (typeof value === 'string') definitions.push({ source, file, value });
    } catch {}
  }
  const [winner, ...shadowed] = definitions;
  return winner ? { ...winner, shadowed } : { value: null, source: null, file: null, shadowed: [] };
}

function processEnvGatewayBypass(effective = effectiveBaseUrl()) {
  if (effective.source !== 'env' || ourBaseUrls().includes(effective.value)) return null;
  const shadowedWiring = effective.shadowed.find((definition) => ourBaseUrls().includes(definition.value));
  return shadowedWiring ? { effective, shadowedWiring } : null;
}

function isUnsupportedRemoteControlHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.toLowerCase() === COMPAT_HOST
      && (url.port === '' || url.port === '443');
  } catch {
    return false;
  }
}

function unsafeRemoteControlProcessEnv(effective = effectiveBaseUrl()) {
  if (effective.source !== 'env' || !isUnsupportedRemoteControlHttpsUrl(effective.value)) return null;
  return effective;
}

function readSettingsForWrite(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw new Error(`Could not read ${file}: ${error.message}`);
  }
}

function writeSettings(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
}

function ownedGatewayEnvEntries(env) {
  return Object.entries(env || {}).filter(([key, value]) => (
    (key === 'ANTHROPIC_BASE_URL' && ourBaseUrls().includes(value))
    || Object.values(PIN_ALIASES).includes(key)
    || (Object.hasOwn(STATIC_ENV_BLOCK, key) && String(value) === String(STATIC_ENV_BLOCK[key]))
  ));
}

function projectSettingsFile(projectDirectory) {
  return path.join(projectDirectory, '.claude', 'settings.local.json');
}

function canonicalPath(value) {
  const resolved = path.resolve(value);
  const missingSegments = [];
  let existingAncestor = resolved;
  while (!fs.existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) break;
    missingSegments.unshift(path.basename(existingAncestor));
    existingAncestor = parent;
  }
  try {
    const canonical = fs.realpathSync.native(existingAncestor);
    const completed = path.join(canonical, ...missingSegments);
    return process.platform === 'win32' ? completed.toLowerCase() : completed;
  } catch {
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  }
}

function registryKey(projectDirectory) {
  return canonicalPath(projectDirectory);
}

function writeProjectWiringRegistry(projects) {
  fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(PROJECT_WIRING_REGISTRY_PATH, JSON.stringify({ projects }, null, 2) + '\n', { mode: 0o600 });
}

function recordedWiringProjects() {
  try {
    const parsed = JSON.parse(fs.readFileSync(PROJECT_WIRING_REGISTRY_PATH, 'utf8'));
    return Array.isArray(parsed.projects)
      ? { projects: parsed.projects, rewrite: false, exists: true }
      : { projects: [], rewrite: true, exists: true };
  } catch (error) {
    return { projects: [], rewrite: error?.code !== 'ENOENT', exists: error?.code !== 'ENOENT' };
  }
}

function registeredProjectSettingsFile(project) {
  try {
    return fs.statSync(project).isDirectory()
      ? { file: projectSettingsFile(project) }
      : { reason: 'directory is missing' };
  } catch { return { reason: 'directory is missing' }; }
}

function isAbsoluteProjectPath(entry) {
  return typeof entry === 'string' && path.isAbsolute(entry);
}

function registeredProjectWiring(entry, seen) {
  if (!isAbsoluteProjectPath(entry)) return null;
  const project = path.normalize(entry);
  const key = registryKey(project);
  if (seen.has(key)) return null;
  const candidate = registeredProjectSettingsFile(project);
  if (!candidate.file) return { pruned: { project, reason: candidate.reason } };
  try {
    const value = JSON.parse(fs.readFileSync(candidate.file, 'utf8')).env?.ANTHROPIC_BASE_URL;
    if (!ourBaseUrls().includes(value)) return null;
    seen.add(key);
    return { wiring: { project, file: candidate.file, value } };
  } catch { return null; }
}

function registeredProjectWiringReport() {
  const recorded = recordedWiringProjects();
  const seen = new Set();
  const results = recorded.projects.map((entry) => registeredProjectWiring(entry, seen));
  const wirings = results.flatMap((result) => result?.wiring ? [result.wiring] : []);
  const pruned = results.flatMap((result) => result?.pruned ? [result.pruned] : []);
  const projects = wirings.map(({ project }) => project);
  if (recorded.exists && (recorded.rewrite || JSON.stringify(projects) !== JSON.stringify(recorded.projects))) writeProjectWiringRegistry(projects);
  return { wirings, pruned };
}

function registeredProjectWirings() {
  return registeredProjectWiringReport().wirings;
}

function pinValuesNotOwned(env, valuesByKey) {
  return Object.entries(valuesByKey).find(([key, values]) => (
    env[key] !== undefined && !values.has(String(env[key]))
  )) || null;
}

function effectivePinValues() {
  return Object.fromEntries(Object.entries(effectivePins()).map(([alias, pin]) => [PIN_ALIASES[alias], pin.value]));
}

function syncRegisteredProjectPins({ ownedPins = ownedPinValues() } = {}) {
  const { wirings, pruned } = registeredProjectWiringReport();
  const expected = effectivePinValues();
  const changed = [];
  const skipped = [];
  for (const wiring of wirings) {
    let settings;
    try {
      settings = readSettingsForWrite(wiring.file);
    } catch (error) {
      skipped.push({ ...wiring, reason: error.message });
      continue;
    }
    const env = settings.env || {};
    const unowned = pinValuesNotOwned(env, ownedPins);
    if (unowned) {
      skipped.push({ ...wiring, key: unowned[0], value: env[unowned[0]], reason: 'pin value is not gateway-owned' });
      continue;
    }
    if (Object.entries(expected).every(([key, value]) => env[key] === value)) continue;
    settings.env = { ...env, ...expected };
    writeSettings(wiring.file, settings);
    changed.push(wiring);
  }
  return { changed, pruned, skipped };
}

function registeredProjectPinDisagreements() {
  const { wirings, pruned } = registeredProjectWiringReport();
  const expected = effectivePinValues();
  const disagreements = wirings.flatMap((wiring) => {
    const env = readSettingsForWrite(wiring.file).env || {};
    return Object.entries(expected)
      .filter(([key, value]) => env[key] !== value)
      .map(([key, value]) => ({ ...wiring, key, staleValue: env[key], expectedValue: value }));
  });
  return { disagreements, pruned };
}

function recordProjectWiring(projectDirectory = process.cwd()) {
  const project = path.resolve(projectDirectory);
  let baseUrl;
  try {
    baseUrl = JSON.parse(fs.readFileSync(projectSettingsFile(project), 'utf8')).env?.ANTHROPIC_BASE_URL;
  } catch { return registeredProjectWirings(); }
  if (!ourBaseUrls().includes(baseUrl)) return registeredProjectWirings();

  const wirings = registeredProjectWirings();
  if (!wirings.some((entry) => registryKey(entry.project) === registryKey(project))) {
    wirings.push({ project, file: projectSettingsFile(project), value: baseUrl });
    writeProjectWiringRegistry(wirings.map((entry) => entry.project));
  }
  return wirings;
}

function removeOwnedProjectWiring(file, targetBaseUrl) {
  const settings = readSettingsForWrite(file);
  if (!ourBaseUrls().includes(settings.env?.ANTHROPIC_BASE_URL) || settings.env.ANTHROPIC_BASE_URL === targetBaseUrl) return false;
  const entries = ownedGatewayEnvEntries(settings.env);
  if (!entries.length) return false;
  for (const [key] of entries) delete settings.env[key];
  if (!Object.keys(settings.env).length) delete settings.env;
  writeSettings(file, settings);
  return true;
}

function reconcileRegisteredProjectWirings(targetBaseUrl, { confirm = false } = {}) {
  if (!ourBaseUrls().includes(targetBaseUrl)) throw new Error(`Cannot reconcile project wiring to unknown base URL: ${targetBaseUrl}`);
  const conflicting = registeredProjectWirings().filter(({ value }) => value !== targetBaseUrl);
  const reconciled = [];
  if (confirm) {
    for (const wiring of conflicting) {
      if (removeOwnedProjectWiring(wiring.file, targetBaseUrl)) reconciled.push(wiring);
    }
    registeredProjectWirings();
  }
  return { conflicting, reconciled };
}

function hasGatewayBaseUrl(settings) {
  return ourBaseUrls().includes(settings.env?.ANTHROPIC_BASE_URL);
}

function migrateLegacyProjectSettings() {
  const legacyFile = settingsPath('legacy-project');
  const userFile = settingsPath('user');
  if (!fs.existsSync(legacyFile) || path.relative(legacyFile, userFile) === '') return { migrated: false };
  let resolvedLegacyFile;
  try {
    resolvedLegacyFile = fs.realpathSync.native(legacyFile);
  } catch {
    return { migrated: false };
  }
  try {
    if (path.relative(resolvedLegacyFile, fs.realpathSync.native(userFile)) === '') return { migrated: false };
  } catch (error) {
    if (error?.code !== 'ENOENT') return { migrated: false };
  }
  const legacy = readSettingsForWrite(legacyFile);
  if (!hasGatewayBaseUrl(legacy)) return { migrated: false };
  const entries = ownedGatewayEnvEntries(legacy.env);
  const legacyKeys = Object.entries(LEGACY_ENV_BLOCK)
    .filter(([key, value]) => String(legacy.env?.[key]) === String(value))
    .map(([key]) => key);
  if (entries.length === 0 && legacyKeys.length === 0) return { migrated: false };

  const localFile = settingsPath('project');
  const local = readSettingsForWrite(localFile);
  local.env = local.env || {};
  for (const [key, value] of entries) {
    if (local.env[key] === undefined) local.env[key] = value;
  }
  if (entries.length) writeSettings(localFile, local);

  const nextLegacy = structuredClone(legacy);
  nextLegacy.env = { ...(nextLegacy.env || {}) };
  for (const [key] of entries) delete nextLegacy.env[key];
  for (const key of legacyKeys) delete nextLegacy.env[key];
  if (!Object.keys(nextLegacy.env).length) delete nextLegacy.env;

  writeSettings(legacyFile, nextLegacy);
  const baseUrl = Object.fromEntries(entries).ANTHROPIC_BASE_URL;
  const mode = baseUrl === COMPAT_BASE_URL ? 'compat' : baseUrl === DEFAULT_BASE_URL ? 'default' : null;
  return { migrated: true, legacyFile, localFile, keys: [...entries.map(([key]) => key), ...legacyKeys], mode };
}

function cleanLegacyEnvSettings() {
  migrateLegacyProjectSettings();
  for (const scope of ['user', 'project']) {
    const file = settingsPath(scope);
    let settings;
    try { settings = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    if (!settings.env || !hasGatewayBaseUrl(settings)) continue;
    let changed = false;
    for (const [k, v] of Object.entries(LEGACY_ENV_BLOCK)) {
      if (String(settings.env[k]) === String(v)) {
        delete settings.env[k];
        changed = true;
      }
    }
    if (!changed) continue;
    if (!Object.keys(settings.env).length) delete settings.env;
    writeSettings(file, settings);
  }
}

function cleanLegacyGatewayModelCache(cachePath = GATEWAY_MODELS_CACHE) {
  let cache;
  try { cache = JSON.parse(fs.readFileSync(cachePath, 'utf8')); } catch { return false; }
  if (!ourBaseUrls().includes(cache.baseUrl) || !Array.isArray(cache.models)) return false;
  let changed = false;
  const models = cache.models.map((m) => {
    if (!m || typeof m.id !== 'string' || !isGatewayModelId(m.id)) return m;
    const canonicalId = gatewayClientModelId(m.id);
    if (canonicalId === m.id) return m;
    changed = true;
    return { ...m, id: canonicalId };
  });
  if (!changed) return false;
  cache.models = models;
  try {
    writeFileAtomically(cachePath, JSON.stringify(cache, null, 2) + '\n', { mode: 0o600 });
  } catch { return false; }
  return true;
}

function isWired() {
  return ourBaseUrls().includes(effectiveBaseUrl().value);
}

// The selected wiring scope owns compatibility switching. A committed project
// settings.json can still contain legacy wiring, but every new write belongs in
// settings.local.json.
const WRITABLE_SCOPE_BY_SOURCE = { 'project-local': 'project', 'project-shared': 'project', user: 'user' };

function modeForBaseUrl(value) {
  if (value === COMPAT_BASE_URL) return 'compat';
  if (value === DEFAULT_BASE_URL) return 'default';
  return null;
}

// isWired() honours a base URL from the environment or any settings file, so
// this has to see the same definitions. Reading only the selected scope made
// the two disagree the moment a project wired itself by hand: isWired() said
// yes, this returned null, and callers crashed on `current.scope`.
//
// Callers use the result to decide what to WRITE, so the answer describes the
// highest-precedence definition backed by a FILE, not whatever the calling
// shell happens to export. Taking the environment's mode would make `setup`
// rewrite the settings file to match a transient shell. A base URL that exists
// only in the environment is still reported, with scope null, so callers can
// skip the write and say why instead of throwing.
function wiredMode() {
  const effective = effectiveBaseUrl();
  for (const definition of [effective, ...effective.shadowed]) {
    const mode = modeForBaseUrl(definition.value);
    if (mode && definition.file) return { scope: WRITABLE_SCOPE_BY_SOURCE[definition.source], mode, source: definition.source, file: definition.file };
  }
  const environmentMode = modeForBaseUrl(effective.source === 'env' ? effective.value : null);
  return environmentMode ? { scope: null, mode: environmentMode, source: 'env', file: null } : null;
}


module.exports = {
  cleanLegacyEnvSettings, cleanLegacyGatewayModelCache, effectiveBaseUrl, isUnsupportedRemoteControlHttpsUrl, isWired,
  migrateLegacyProjectSettings, processEnvGatewayBypass, readSettingsForWrite, reconcileRegisteredProjectWirings,
  recordProjectWiring, registeredProjectPinDisagreements, registeredProjectWirings, retireWiringModeConfig, selectedWiringScope,
  settingsPath, syncRegisteredProjectPins, unsafeRemoteControlProcessEnv, wiredMode, writeSettings,
};
