'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

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

module.exports = { INDEX_NAME, MAP_DIR_PARTS, STATE_NAME, hashContent, loadMap, mapDirectory, mapHashes, safeDocumentPath };
