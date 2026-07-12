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
 * Catalog contract (codex-gateway, schema 2):
 *   ~/.claude/codex-gateway/catalog.json = {
 *     schema: 2, source: "codex-gateway", updatedAt: <iso>,
 *     models: [{ slug, id, label, suggestedTier }],
 *   }
 * `suggestedTier` is an optional hint (the dashboard's dropdown default); a
 * missing/invalid one just resolves to null. The older schema-1 `anchor` field
 * is still read as a fallback so a stale catalog on disk keeps working.
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
const VALID_TIERS = ['grade-1', 'grade-2', 'grade-3', 'grade-4'];
// Catalog files (codex-gateway schema-2, and the older schema-1 `anchor`) still
// carry provider-family hints; normalize those to grade IDs at this boundary.
const LEGACY_TIER_HINTS = { haiku: 'grade-1', sonnet: 'grade-2', opus: 'grade-3', fable: 'grade-4' };

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
// {slug,id,label,suggestedTier,source} or null when the entry is malformed.
// slug + id are required; suggestedTier is an optional hint (schema-2
// `suggestedTier`, or the legacy schema-1 `anchor`), null when absent/invalid.
function validateEntry(raw, source) {
  if (!raw || typeof raw !== 'object') return null;
  const slug = typeof raw.slug === 'string' ? raw.slug.trim().toLowerCase() : '';
  if (!SLUG_RE.test(slug)) return null;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id) return null;
  const hintRaw = raw.suggestedTier != null ? raw.suggestedTier : raw.anchor;
  const hintNorm = typeof hintRaw === 'string' ? hintRaw.trim().toLowerCase() : '';
  const hint = LEGACY_TIER_HINTS[hintNorm] || hintNorm;
  const suggestedTier = VALID_TIERS.indexOf(hint) !== -1 ? hint : null;
  const label = typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : slug;
  return { slug, id, label, suggestedTier, source };
}

/**
 * discoverExternalModels() -> [{slug,id,label,suggestedTier,source}]
 *
 * Reads every known catalog under every discovery root, validates each
 * model entry, and dedupes by `(source, slug)` (first entry from each source
 * wins — root order then CATALOG_SOURCES order is the precedence). Never throws. Not cached across
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
