'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { COMPAT_BASE_URL, DEFAULT_BASE_URL, GATEWAY_MODELS_CACHE, LEGACY_ENV_BLOCK, PIN_ALIASES, STATIC_ENV_BLOCK, STATE, WIRING_CONFIG_PATH } = require('./runtime.js');
const { isGatewayModelId, ourBaseUrls } = require('./pins.js');

function hasWiringMode() {
  try {
    return ['local', 'global'].includes(JSON.parse(fs.readFileSync(WIRING_CONFIG_PATH, 'utf8')).mode);
  } catch { return false; }
}

function wiringMode() {
  try {
    return JSON.parse(fs.readFileSync(WIRING_CONFIG_PATH, 'utf8')).mode === 'global' ? 'global' : 'local';
  } catch { return 'local'; }
}

function wiringModeDefaultNotice() {
  return 'wiring mode defaulted to per-project; use /model-gateway:model-gateway to run its env --mode global command to change';
}

function writeWiringMode(mode) {
  if (!['local', 'global'].includes(mode)) throw new Error(`Unknown wiring mode: ${mode}`);
  fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(WIRING_CONFIG_PATH, JSON.stringify({ mode }, null, 2) + '\n', { mode: 0o600 });
  return mode;
}

function selectedWiringScope() {
  return wiringMode() === 'global' ? 'user' : 'project';
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

function migrateLegacyProjectSettings() {
  const legacyFile = settingsPath('legacy-project');
  if (!fs.existsSync(legacyFile)) return { migrated: false };
  const legacy = readSettingsForWrite(legacyFile);
  const entries = ownedGatewayEnvEntries(legacy.env);
  const legacyKeys = Object.entries(LEGACY_ENV_BLOCK)
    .filter(([key, value]) => String(legacy.env?.[key]) === String(value))
    .map(([key]) => key);
  if (entries.length === 0 && legacyKeys.length === 0) return { migrated: false };

  const localFile = settingsPath('project');
  let nextLocal;
  if (entries.length > 0) {
    const local = readSettingsForWrite(localFile);
    nextLocal = structuredClone(local);
    nextLocal.env = { ...(nextLocal.env || {}) };
    for (const [key, value] of entries) {
      if (!Object.hasOwn(nextLocal.env, key)) nextLocal.env[key] = value;
    }
  }

  const nextLegacy = structuredClone(legacy);
  nextLegacy.env = { ...(nextLegacy.env || {}) };
  for (const [key] of entries) delete nextLegacy.env[key];
  for (const key of legacyKeys) delete nextLegacy.env[key];
  if (!Object.keys(nextLegacy.env).length) delete nextLegacy.env;

  if (nextLocal) writeSettings(localFile, nextLocal);
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


module.exports = { cleanLegacyEnvSettings, cleanLegacyGatewayModelCache, effectiveBaseUrl, hasWiringMode, isWired, migrateLegacyProjectSettings, readSettingsForWrite, selectedWiringScope, settingsPath, wiredMode, wiringMode, wiringModeDefaultNotice, writeSettings, writeWiringMode };
