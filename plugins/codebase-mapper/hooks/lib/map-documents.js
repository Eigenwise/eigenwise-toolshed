'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const migrationLock = require('./migration-lock');

const MAP_DIR_PARTS = ['.claude', '.codebase-info'];
const INDEX_NAME = 'INDEX.md';
const STATE_NAME = '.map-state.json';

function hashContent(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function mapDirectory(projectDir) {
  return path.join(projectDir, ...MAP_DIR_PARTS);
}

function displayPath(relative) {
  return [...MAP_DIR_PARTS, relative].join('/');
}

function safeDocumentPath(value) {
  const normalized = String(value || '').replace(/\\/g, '/');
  return normalized && !path.isAbsolute(normalized) && !normalized.split('/').includes('..') && normalized.endsWith('.md');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function listDocuments(directory, relative = '') {
  let entries;
  try {
    entries = fs.readdirSync(path.join(directory, relative), { withFileTypes: true });
  } catch (_) {
    return [];
  }

  const documents = [];
  for (const entry of entries) {
    const next = relative ? relative + '/' + entry.name : entry.name;
    if (entry.isDirectory()) documents.push(...listDocuments(directory, next));
    else if (entry.isFile() && safeDocumentPath(next)) documents.push(next);
  }
  return documents;
}

function stateStatus(state, documents) {
  if (state && typeof state.schemaVersion === 'number' && state.schemaVersion > 1) {
    return { migratable: false, stale: false, future: true };
  }
  if (!state || !Array.isArray(state.documents)) return { migratable: true, stale: false };
  if (!state.hashes || typeof state.hashes !== 'object' || Array.isArray(state.hashes)) {
    return { migratable: true, stale: false };
  }

  let stale = false;
  const expected = new Set(state.documents.filter(safeDocumentPath));
  const actual = new Set(documents.filter((entry) => entry.relative !== INDEX_NAME).map((entry) => entry.relative));
  if (expected.size !== actual.size || [...expected].some((name) => !actual.has(name))) stale = true;
  for (const entry of documents) {
    if (state.hashes[entry.relative] !== entry.hash) stale = true;
  }
  return { migratable: false, stale };
}

function loadMap(projectDir) {
  const directory = mapDirectory(projectDir);
  const indexPath = path.join(directory, INDEX_NAME);
  let index;
  try {
    index = fs.readFileSync(indexPath, 'utf8');
  } catch (_) {
    return null;
  }

  const documents = [];
  for (const relative of [...new Set(listDocuments(directory).concat(INDEX_NAME))].sort()) {
    try {
      const content = relative === INDEX_NAME ? index : fs.readFileSync(path.join(directory, relative), 'utf8');
      documents.push({ relative, sourcePath: displayPath(relative), hash: hashContent(content), content });
    } catch (_) {
      // A concurrent map update can leave a file unavailable for this hook run.
    }
  }

  const state = readJson(path.join(directory, STATE_NAME));
  return {
    index: documents.find((entry) => entry.relative === INDEX_NAME),
    documents,
    state: stateStatus(state, documents),
  };
}

function mapHashes(documents) {
  return Object.fromEntries(documents.map((entry) => [entry.relative, entry.hash]));
}

function mapSchema(projectDir) {
  const state = readJson(path.join(mapDirectory(projectDir), STATE_NAME));
  if (!state) return 'legacy';
  if (typeof state.schemaVersion === 'number' && state.schemaVersion > 1) return 'future';
  return state.hashes && typeof state.hashes === 'object' && !Array.isArray(state.hashes) ? 'current' : 'legacy';
}

function backupState(statePath) {
  if (!fs.existsSync(statePath)) return;
  const backup = statePath + '.legacy.json';
  if (!fs.existsSync(backup)) fs.copyFileSync(statePath, backup);
}

function validMigratedState(state, map) {
  if (!state || state.schemaVersion !== 1 || !Array.isArray(state.documents) || !state.hashes || typeof state.hashes !== 'object') return false;
  const expected = map.documents.filter((entry) => entry.relative !== INDEX_NAME).map((entry) => entry.relative).sort();
  if (state.documents.length !== expected.length || state.documents.some((entry, index) => entry !== expected[index])) return false;
  return map.documents.every((entry) => state.hashes[entry.relative] === entry.hash);
}

function migrateLegacyMap(projectDir) {
  if (mapSchema(projectDir) !== 'legacy') return false;
  const directory = mapDirectory(projectDir);
  const lockPath = directory + '.migration.lock';
  try {
    const result = migrationLock.withMigrationLock(lockPath, () => {
      if (mapSchema(projectDir) !== 'legacy') return { migrated: false };
      const map = loadMap(projectDir);
      if (!map || !map.index) return { migrated: false };
      const statePath = path.join(directory, STATE_NAME);
      const legacyState = readJson(statePath);
      const nextState = {
        ...(legacyState && typeof legacyState === 'object' && !Array.isArray(legacyState) ? legacyState : {}),
        schemaVersion: 1,
        documents: map.documents.filter((entry) => entry.relative !== INDEX_NAME).map((entry) => entry.relative).sort(),
        hashes: mapHashes(map.documents),
      };
      const temp = statePath + '.tmp-' + process.pid + '-' + crypto.randomBytes(6).toString('hex');
      fs.writeFileSync(temp, JSON.stringify(nextState, null, 2) + '\n');
      const validated = readJson(temp);
      if (!validMigratedState(validated, loadMap(projectDir))) throw new Error('Codebase map migration validation failed');
      backupState(statePath);
      fs.renameSync(temp, statePath);
      return { migrated: true };
    });
    return Boolean(result.migrated);
  } catch (_) {
    return false;
  }
}

module.exports = { INDEX_NAME, MAP_DIR_PARTS, STATE_NAME, hashContent, loadMap, mapDirectory, mapHashes, migrateLegacyMap, safeDocumentPath };
