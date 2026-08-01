'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { COMPAT_BASE_URL, DEFAULT_BASE_URL, GATEWAY_MODELS_CACHE, LEGACY_ENV_BLOCK, PIN_ALIASES, PROJECT_WIRING_REGISTRY_PATH, STATIC_ENV_BLOCK, STATE, WIRING_CONFIG_PATH } = require('./runtime.js');
const { isGatewayModelId, ourBaseUrls } = require('./pins.js');

// Wiring is global-only. Per-project wiring existed as a mode and was removed:
// a project-local ANTHROPIC_BASE_URL silently shadows the user-scope one, which
// made /remote-control unreachable across a dozen projects with no diagnosis.
// Deliberately shadowing one project is still supported (write the key into that
// project's settings.local.json by hand); having it be the DEFAULT was the bug.
const WIRING_SCOPE = 'user';

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

function registryKey(projectDirectory) {
  const resolved = path.resolve(projectDirectory);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
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

function migrateLegacyProjectSettings() {
  const legacyFile = settingsPath('legacy-project');
  if (!fs.existsSync(legacyFile)) return { migrated: false };
  const legacy = readSettingsForWrite(legacyFile);
  const entries = ownedGatewayEnvEntries(legacy.env);
  const legacyKeys = Object.entries(LEGACY_ENV_BLOCK)
    .filter(([key, value]) => String(legacy.env?.[key]) === String(value))
    .map(([key]) => key);
  if (entries.length === 0 && legacyKeys.length === 0) return { migrated: false };

  // Wiring is global, so these keys are stripped rather than relocated into
  // settings.local.json: a project-scope copy would outrank the user scope and
  // recreate the silent shadow that per-project wiring was removed for. The
  // mode is still carried out so the user-scope write preserves compat mode.
  const localFile = settingsPath('project');
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
    if (!settings.env) continue;
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
    fs.writeFileSync(GATEWAY_MODELS_CACHE, JSON.stringify(cache, null, 2) + '\n');
  } catch { return false; }
  return true;
}

function isWired() {
  if (ourBaseUrls().includes(process.env.ANTHROPIC_BASE_URL)) return true;
  try {
    const s = JSON.parse(fs.readFileSync(settingsPath(selectedWiringScope()), 'utf8'));
    return !!(s.env && ourBaseUrls().includes(s.env.ANTHROPIC_BASE_URL));
  } catch { return false; }
}

// The selected wiring scope owns compatibility switching. A legacy global block
// remains readable during migration but must never be changed in local mode.
function wiredMode() {
  const scope = selectedWiringScope();
  try {
    const s = JSON.parse(fs.readFileSync(settingsPath(scope), 'utf8'));
    const base = s.env && s.env.ANTHROPIC_BASE_URL;
    if (base === COMPAT_BASE_URL) return { scope, mode: 'compat' };
    if (base === DEFAULT_BASE_URL) return { scope, mode: 'default' };
  } catch { /* absent or unparsable */ }
  return null;
}


module.exports = {
  cleanLegacyEnvSettings, cleanLegacyGatewayModelCache, effectiveBaseUrl, isWired,
  migrateLegacyProjectSettings, readSettingsForWrite, reconcileRegisteredProjectWirings,
  recordProjectWiring, registeredProjectWirings, retireWiringModeConfig, selectedWiringScope,
  settingsPath, wiredMode, writeSettings,
};
