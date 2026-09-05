'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeFileAtomically } = require('./atomic-file.js');
const { COMPAT_BASE_URL, DEFAULT_BASE_URL, GATEWAY_MODELS_CACHE, LEGACY_ENV_BLOCK, PIN_ALIASES, PROJECT_WIRING_REGISTRY_PATH, STATIC_ENV_BLOCK, STATE, WIRING_CONFIG_PATH } = require('./runtime.js');
const { isGatewayModelId, ourBaseUrls } = require('./pins.js');

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

function registeredProjectWirings() {
  let recorded = [];
  let registryExists = false;
  let registryNeedsRewrite = false;
  try {
    registryExists = true;
    const parsed = JSON.parse(fs.readFileSync(PROJECT_WIRING_REGISTRY_PATH, 'utf8'));
    if (Array.isArray(parsed.projects)) recorded = parsed.projects;
    else registryNeedsRewrite = true;
  } catch (error) {
    if (error?.code === 'ENOENT') registryExists = false;
    else registryNeedsRewrite = true;
  }

  const seen = new Set();
  const valid = [];
  for (const entry of recorded) {
    if (typeof entry !== 'string' || !path.isAbsolute(entry)) continue;
    const project = path.normalize(entry);
    const key = registryKey(project);
    if (seen.has(key)) continue;
    let baseUrl;
    try {
      if (!fs.statSync(project).isDirectory()) continue;
      baseUrl = JSON.parse(fs.readFileSync(projectSettingsFile(project), 'utf8')).env?.ANTHROPIC_BASE_URL;
    } catch { continue; }
    if (!ourBaseUrls().includes(baseUrl)) continue;
    seen.add(key);
    valid.push({ project, file: projectSettingsFile(project), value: baseUrl });
  }

  const projects = valid.map(({ project }) => project);
  if (registryExists && (registryNeedsRewrite || JSON.stringify(projects) !== JSON.stringify(recorded))) writeProjectWiringRegistry(projects);
  return valid;
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
  if (!fs.existsSync(legacyFile)) return { migrated: false };
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

function cleanLegacyGatewayModelCache() {
  let cache;
  try { cache = JSON.parse(fs.readFileSync(GATEWAY_MODELS_CACHE, 'utf8')); } catch { return false; }
  if (!ourBaseUrls().includes(cache.baseUrl) || !Array.isArray(cache.models)) return false;
  if (!cache.models.some((m) => m && typeof m.id === 'string'
    && isGatewayModelId(m.id) && /\[1m\]$/.test(m.id))) return false;
  cache.models = cache.models.map((m) => {
    if (!m || typeof m.id !== 'string' || !isGatewayModelId(m.id)) return m;
    return { ...m, id: m.id.replace(/\[1m\]$/, '') };
  });
  try {
    writeFileAtomically(GATEWAY_MODELS_CACHE, JSON.stringify(cache, null, 2) + '\n', { mode: 0o600 });
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
  cleanLegacyEnvSettings, cleanLegacyGatewayModelCache, effectiveBaseUrl, isWired,
  migrateLegacyProjectSettings, readSettingsForWrite, reconcileRegisteredProjectWirings,
  recordProjectWiring, registeredProjectWirings, retireWiringModeConfig, selectedWiringScope,
  settingsPath, wiredMode, writeSettings,
};
