'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;
const CATALOG_SOURCES = [
  { source: 'codex-gateway', relPath: path.join('codex-gateway', 'catalog.json') },
];

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
    for (const { source, relPath } of CATALOG_SOURCES) {
      const data = readJsonSafe(path.join(root, relPath));
      const models = data && Array.isArray(data.models) ? data.models : [];
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

module.exports = { CATALOG_SOURCES, discoverExternalModels };
