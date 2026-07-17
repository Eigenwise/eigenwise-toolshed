'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EFFORT_MODELS, VALID_EFFORTS, VALID_MODELS } = require('./ladder.js');
const { DEFAULT_CONFIG, routesFor, userConfigPath, writeConfig } = require('./config.js');

function legacyPrefsPath() {
  const root = process.env.SWITCHBOARD_HOME;
  const home = root && String(root).trim()
    ? path.resolve(String(root).trim())
    : path.join(os.homedir(), '.claude', 'switchboard');
  return path.join(home, 'prefs.json');
}

function readLegacyPrefs(file = legacyPrefsPath()) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw new Error(`Could not read legacy Switchboard prefs at ${file}: ${error.message}`);
  }
}

function legacyEfforts(prefs, model) {
  const matrix = prefs.efforts && typeof prefs.efforts === 'object' ? prefs.efforts : null;
  const row = matrix && matrix[model] && typeof matrix[model] === 'object' ? matrix[model] : null;
  return VALID_EFFORTS.reduce((out, effort) => {
    out[effort] = row ? row[effort] !== false : prefs[effort] !== false;
    return out;
  }, {});
}

function buildMigration(prefs, { source = legacyPrefsPath(), target = userConfigPath() } = {}) {
  if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) {
    throw new Error(`Legacy Switchboard prefs at ${source} must be a JSON object.`);
  }
  const allowedModels = VALID_MODELS.filter((model) => prefs[model] !== false);
  const efforts = {};
  for (const model of EFFORT_MODELS) efforts[model] = legacyEfforts(prefs, model);
  const ignored = Object.hasOwn(prefs, 'routingBias') ? ['routingBias'] : [];
  const config = Object.assign({}, DEFAULT_CONFIG, {
    routing: prefs.routing !== false,
    allowedModels,
    allowedRoutes: routesFor(allowedModels, efforts),
  });
  return {
    source,
    target,
    found: true,
    config,
    ignored,
    summary: {
      routing: config.routing,
      allowedModels: config.allowedModels,
      allowedRoutes: config.allowedRoutes,
    },
  };
}

function previewMigration({ source = legacyPrefsPath(), target = userConfigPath() } = {}) {
  const prefs = readLegacyPrefs(source);
  if (prefs === null) return { source, target, found: false, ignored: [], summary: null };
  return buildMigration(prefs, { source, target });
}

function applyMigration(options = {}) {
  const preview = previewMigration(options);
  if (!preview.found) throw new Error(`No legacy Switchboard prefs found at ${preview.source}.`);
  if (fs.existsSync(preview.target)) {
    throw new Error(`Refusing to overwrite existing Switchboard config at ${preview.target}. Legacy prefs remain at ${preview.source}.`);
  }
  writeConfig(preview.target, preview.config);
  return preview;
}

module.exports = {
  applyMigration,
  buildMigration,
  legacyPrefsPath,
  previewMigration,
  readLegacyPrefs,
};
