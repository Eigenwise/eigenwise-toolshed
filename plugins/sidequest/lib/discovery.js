'use strict';
/**
 * sidequest - external model catalog discovery (SQ-157)
 *
 * Instead of the user hand-entering custom model tiers, sidequest DETECTS
 * sibling plugins (starting with codex-gateway, same marketplace) via a
 * catalog file each one writes, and folds the declared models into the
 * routing ladder as first-class, toggleable tiers (store.js does the
 * merging; this module only finds and validates catalogs).
 *
 * FROZEN catalog contract (SQ-161, codex-gateway):
 *   ~/.claude/codex-gateway/catalog.json = {
 *     schema: 1, source: "codex-gateway", updatedAt: <iso>,
 *     models: [{ slug, id, label, anchor }],
 *   }
 *
 * The list of known catalogs (CATALOG_SOURCES) is intentionally an array so
 * a future sibling plugin slots in with one more entry, no other changes.
 *
 * Every failure mode here degrades to an empty result rather than throwing:
 * a missing file, a malformed JSON body, or an individual bad model entry
 * are all just skipped. Discovery must never be able to break a ticket read.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// Mirrors store.js's CUSTOM_SLUG_RE (2..32 chars, lowercase alnum + dashes,
// starting alnum) — kept independent on purpose: this module has no
// dependency on store.js, and store.js re-validates everything it merges in.
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;

// Mirrors store.js's VALID_MODELS. Duplicated rather than imported so
// discovery.js stays a leaf module with zero sidequest dependencies.
const VALID_ANCHORS = ['haiku', 'sonnet', 'opus', 'fable'];

// Catalogs this version of sidequest knows how to read, each resolved as
// <discovery root>/<relPath>. Add an entry here for the next sibling plugin.
const CATALOG_SOURCES = [
  { source: 'codex-gateway', relPath: path.join('codex-gateway', 'catalog.json') },
];

// The root(s) to look for catalogs under. Defaults to ~/.claude (same home
// convention store.js's homeRoot() uses via os.homedir()), overridable with
// SIDEQUEST_DISCOVERY_DIRS (comma-separated absolute paths) so tests never
// have to touch a real home directory. Each override entry is treated as a
// discovery root itself (i.e. a catalog is looked for directly under it),
// not as a `.claude` ancestor.
function discoveryRoots() {
  const override = process.env.SIDEQUEST_DISCOVERY_DIRS;
  if (override && String(override).trim()) {
    return String(override)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((p) => path.resolve(p));
  }
  return [path.join(os.homedir(), '.claude')];
}

function readJsonSafe(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw);
  } catch (_e) {
    return null; // missing file, unreadable, or malformed JSON -> tolerated
  }
}

// Validate + normalize one raw catalog model entry. Returns the resolved
// {slug,id,label,anchor,source} or null when the entry is malformed.
function validateEntry(raw, source) {
  if (!raw || typeof raw !== 'object') return null;
  const slug = typeof raw.slug === 'string' ? raw.slug.trim().toLowerCase() : '';
  if (!SLUG_RE.test(slug)) return null;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id) return null;
  const anchor = typeof raw.anchor === 'string' ? raw.anchor.trim().toLowerCase() : '';
  if (VALID_ANCHORS.indexOf(anchor) === -1) return null;
  const label = typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : slug;
  return { slug, id, label, anchor, source };
}

/**
 * discoverExternalModels() -> [{slug,id,label,anchor,source}]
 *
 * Reads every known catalog under every discovery root, validates each
 * model entry, and dedupes by slug (first one found wins — root order then
 * CATALOG_SOURCES order is the precedence). Never throws. Not cached across
 * calls, so a caller (or a test resetting SIDEQUEST_DISCOVERY_DIRS/writing a
 * new catalog file) always sees the current on-disk state.
 */
function discoverExternalModels() {
  const out = [];
  const seen = new Set();
  for (const root of discoveryRoots()) {
    for (const { source, relPath } of CATALOG_SOURCES) {
      const file = path.join(root, relPath);
      const data = readJsonSafe(file);
      if (!data || typeof data !== 'object') continue;
      const models = Array.isArray(data.models) ? data.models : [];
      for (const raw of models) {
        const entry = validateEntry(raw, source);
        if (!entry || seen.has(entry.slug)) continue;
        seen.add(entry.slug);
        out.push(entry);
      }
    }
  }
  return out;
}

module.exports = { discoverExternalModels };
