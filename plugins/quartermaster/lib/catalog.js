'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { pluginsDir } = require('./paths.js');

const SEARCH_LIMIT = 15;

function readJson(file, fallback) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

/** Installed plugin ids ("name@marketplace") with where each install applies. */
function readInstalled(env = process.env) {
  const file = path.join(pluginsDir(env), 'installed_plugins.json');
  const parsed = readJson(file, { plugins: {} });
  const installed = [];
  for (const [id, records] of Object.entries(parsed.plugins ?? {})) {
    const atSign = id.lastIndexOf('@');
    installed.push({
      id,
      name: atSign > 0 ? id.slice(0, atSign) : id,
      marketplace: atSign > 0 ? id.slice(atSign + 1) : null,
      scopes: Array.isArray(records) ? records.map((record) => record.scope ?? 'user') : [],
    });
  }
  return installed;
}

/**
 * Every plugin the user could install, from two local sources: the official catalog cache (which
 * carries install counts and per-component token costs) and the marketplace manifests already
 * added on this machine. No network involved; `claude plugin list --available` is the fallback
 * when neither file exists.
 */
function readAvailable(env = process.env) {
  const root = pluginsDir(env);
  const available = new Map();

  const cache = readJson(path.join(root, 'plugin-catalog-cache.json'), {});
  for (const [id, entry] of Object.entries(cache.catalog?.plugins ?? {})) {
    const marketplaceEntry = entry.marketplace_entry ?? {};
    available.set(id, {
      id,
      name: entry.plugin ?? marketplaceEntry.name ?? id,
      description: marketplaceEntry.description ?? '',
      category: marketplaceEntry.category ?? null,
      keywords: marketplaceEntry.tags ?? marketplaceEntry.keywords ?? [],
      installs: entry.unique_installs ?? null,
      components: summarizeComponents(entry.components),
    });
  }

  const known = readJson(path.join(root, 'known_marketplaces.json'), {});
  for (const [marketplaceName, record] of Object.entries(known)) {
    const manifest = readJson(path.join(String(record.installLocation ?? ''), '.claude-plugin', 'marketplace.json'), {});
    for (const plugin of manifest.plugins ?? []) {
      const id = `${plugin.name}@${marketplaceName}`;
      if (available.has(id)) continue;
      available.set(id, {
        id,
        name: plugin.name,
        description: plugin.description ?? '',
        category: plugin.category ?? null,
        keywords: plugin.keywords ?? [],
        installs: null,
        components: null,
      });
    }
  }

  return [...available.values()];
}

function summarizeComponents(components) {
  if (!components || typeof components !== 'object') return null;
  const count = (value) => (Array.isArray(value) ? value.length : 0);
  return {
    skills: count(components.skills),
    commands: count(components.commands),
    agents: count(components.agents),
    hooks: count(components.hooks),
    mcpServers: count(components.mcpServers),
    lspServers: count(components.lspServers),
  };
}

function scorePlugin(plugin, terms) {
  const haystackName = plugin.name.toLowerCase();
  const haystackRest = `${plugin.description} ${(plugin.keywords ?? []).join(' ')} ${plugin.category ?? ''}`.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (haystackName.includes(term)) score += 5;
    if (haystackRest.includes(term)) score += 2;
  }
  if (score === 0) return 0;
  // Popularity is a tiebreaker, never the ranking: log-scaled so a 10x install gap adds one point.
  if (plugin.installs) score += Math.min(4, Math.log10(plugin.installs));
  return score;
}

function searchAvailable(query, env = process.env) {
  const terms = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const installedIds = new Set(readInstalled(env).map((plugin) => plugin.id));
  return readAvailable(env)
    .filter((plugin) => !installedIds.has(plugin.id))
    .map((plugin) => ({ ...plugin, score: scorePlugin(plugin, terms) }))
    .filter((plugin) => plugin.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, SEARCH_LIMIT);
}

/** Installed plugins with zero attribution events in the scanned window. A hint, not proof. */
function unusedInstalled(attributionPlugins, env = process.env) {
  const used = new Set(Object.keys(attributionPlugins ?? {}).map((name) => name.toLowerCase()));
  return readInstalled(env)
    .filter((plugin) => !used.has(plugin.name.toLowerCase()))
    .map((plugin) => plugin.id);
}

module.exports = { readAvailable, readInstalled, searchAvailable, unusedInstalled };
