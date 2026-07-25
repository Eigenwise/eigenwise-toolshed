import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { readValue, replaceValue } from './jsonedit.mjs';
import { pluginSourceDir, resolveInRepo } from './paths.mjs';
import { parseVersion } from './semver.mjs';

export const MARKETPLACE_PATH = '.claude-plugin/marketplace.json';

const PLUGIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function pluginManifestPath(pluginDir) {
  return path.posix.join(pluginDir, '.claude-plugin/plugin.json');
}

/**
 * Everything the engine needs about published plugins, read from one pinned source so a runner
 * with no board access gets the same answer as a local session.
 */
export function readManifest(source, repoRoot = null) {
  const marketplaceText = source.read(MARKETPLACE_PATH);
  if (marketplaceText === null) throw new Error(`${MARKETPLACE_PATH} is missing from ${source.label}`);
  const marketplace = JSON.parse(marketplaceText);
  if (!Array.isArray(marketplace.plugins)) {
    throw new Error(`${MARKETPLACE_PATH} has no plugins array`);
  }

  const plugins = new Map();
  marketplace.plugins.forEach((entry, index) => {
    if (!entry?.name) throw new Error(`${MARKETPLACE_PATH} plugins[${index}] has no name`);
    if (!PLUGIN_NAME.test(entry.name)) throw new Error(`${MARKETPLACE_PATH} plugins[${index}] has an unusable name "${entry.name}"`);
    if (plugins.has(entry.name)) throw new Error(`${MARKETPLACE_PATH} lists "${entry.name}" twice`);

    const dir = pluginSourceDir(entry.source, entry.name);
    const manifestPath = pluginManifestPath(dir);
    if (repoRoot) resolveInRepo(repoRoot, manifestPath, `manifest for plugin "${entry.name}"`);

    const pluginText = source.read(manifestPath);
    plugins.set(entry.name, {
      name: entry.name,
      dir,
      index,
      manifestPath,
      entryVersion: entry.version ?? null,
      pluginVersion: pluginText === null ? null : readValue(pluginText, ['version']),
      version: entry.version ?? null,
      repository: entry.repository ?? null,
    });
  });

  return {
    source: source.label,
    marketplacePath: MARKETPLACE_PATH,
    marketplaceText,
    version: marketplace.version,
    plugins,
    repository: marketplace.plugins.find((entry) => entry.repository)?.repository ?? null,
  };
}

export function checkManifest(manifest) {
  const errors = [];
  try {
    parseVersion(manifest.version, `${MARKETPLACE_PATH} top-level version`);
  } catch (error) {
    errors.push(error.message);
  }
  for (const plugin of manifest.plugins.values()) {
    if (plugin.pluginVersion === null) {
      errors.push(`${plugin.manifestPath} is missing, but ${MARKETPLACE_PATH} lists "${plugin.name}"`);
      continue;
    }
    for (const [value, label] of [
      [plugin.entryVersion, `${MARKETPLACE_PATH} entry for "${plugin.name}"`],
      [plugin.pluginVersion, plugin.manifestPath],
    ]) {
      try {
        parseVersion(value, `${label} version`);
      } catch (error) {
        errors.push(error.message);
      }
    }
    if (plugin.entryVersion !== plugin.pluginVersion) {
      errors.push(
        `"${plugin.name}" version mismatch: ${MARKETPLACE_PATH} says ${plugin.entryVersion}, ${plugin.manifestPath} says ${plugin.pluginVersion}`,
      );
    }
  }
  return errors;
}

/**
 * Writes the three version fields of a release. Every write re-reads the file on disk and refuses
 * unless it still holds the version the plan was built from, so a tree that moved under the engine
 * fails loudly instead of publishing a number nobody planned.
 */
export function applyVersions(repoRoot, manifest, { plugins = [], marketplaceVersion = null } = {}) {
  const written = [];
  const marketplaceAbsolute = resolveInRepo(repoRoot, MARKETPLACE_PATH);
  let marketplaceText = readFileSync(marketplaceAbsolute, 'utf8');
  const marketplaceBefore = marketplaceText;

  for (const plugin of [...plugins].sort((a, b) => a.name.localeCompare(b.name))) {
    const known = manifest.plugins.get(plugin.name);
    if (!known) throw new Error(`unknown plugin "${plugin.name}" (not in ${MARKETPLACE_PATH})`);
    parseVersion(plugin.to, `new version for "${plugin.name}"`);

    const manifestAbsolute = resolveInRepo(repoRoot, known.manifestPath, `manifest for plugin "${plugin.name}"`);
    const pluginText = readFileSync(manifestAbsolute, 'utf8');
    const onDisk = readValue(pluginText, ['version']);
    if (onDisk !== plugin.from) {
      throw new Error(`${known.manifestPath} is ${onDisk} on disk but the plan was built from ${plugin.from}; refusing to write a version nobody planned`);
    }
    const entryOnDisk = readValue(marketplaceText, ['plugins', known.index, 'version']);
    if (entryOnDisk !== plugin.from) {
      throw new Error(`${MARKETPLACE_PATH} has "${plugin.name}" at ${entryOnDisk} but the plan was built from ${plugin.from}`);
    }

    writeFileSync(manifestAbsolute, replaceValue(pluginText, ['version'], plugin.to));
    written.push(known.manifestPath);
    marketplaceText = replaceValue(marketplaceText, ['plugins', known.index, 'version'], plugin.to);
  }

  if (marketplaceVersion !== null) {
    parseVersion(marketplaceVersion, `new ${MARKETPLACE_PATH} version`);
    marketplaceText = replaceValue(marketplaceText, ['version'], marketplaceVersion);
  }

  if (marketplaceText !== marketplaceBefore) {
    writeFileSync(marketplaceAbsolute, marketplaceText);
    written.push(MARKETPLACE_PATH);
  }

  return written.sort();
}
