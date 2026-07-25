import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { readValue, replaceValue } from './jsonedit.mjs';
import { parseVersion } from './semver.mjs';

export const MARKETPLACE_PATH = '.claude-plugin/marketplace.json';

export function pluginManifestPath(pluginDir) {
  return path.posix.join(pluginDir, '.claude-plugin/plugin.json');
}

function repoRead(repoRoot, relative) {
  return readFileSync(path.join(repoRoot, relative), 'utf8');
}

/**
 * Everything the engine needs about published plugins, read straight from the tree so a
 * runner with no board access gets the same answer as a local session.
 */
export function readManifest(repoRoot) {
  const marketplaceText = repoRead(repoRoot, MARKETPLACE_PATH);
  const marketplace = JSON.parse(marketplaceText);
  if (!Array.isArray(marketplace.plugins)) {
    throw new Error(`${MARKETPLACE_PATH} has no plugins array`);
  }

  const plugins = new Map();
  marketplace.plugins.forEach((entry, index) => {
    if (!entry?.name) throw new Error(`${MARKETPLACE_PATH} plugins[${index}] has no name`);
    const dir = String(entry.source ?? `./plugins/${entry.name}`).replace(/^\.\//, '');
    const manifestPath = pluginManifestPath(dir);
    const absolute = path.join(repoRoot, manifestPath);
    let pluginVersion = null;
    if (existsSync(absolute)) {
      pluginVersion = readValue(readFileSync(absolute, 'utf8'), ['version']);
    }
    plugins.set(entry.name, {
      name: entry.name,
      dir,
      index,
      manifestPath,
      entryVersion: entry.version ?? null,
      pluginVersion,
      version: entry.version ?? pluginVersion,
      repository: entry.repository ?? null,
    });
  });

  return {
    repoRoot,
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
 * Writes the three version fields of a release (per-plugin manifest, its marketplace entry,
 * and the marketplace counter) and returns the repo-relative paths it touched.
 */
export function applyVersions(repoRoot, manifest, { plugins = new Map(), marketplaceVersion = null } = {}) {
  const written = [];
  let marketplaceText = manifest.marketplaceText;

  for (const [name, nextVersion] of [...plugins].sort(([a], [b]) => a.localeCompare(b))) {
    const plugin = manifest.plugins.get(name);
    if (!plugin) throw new Error(`unknown plugin "${name}" (not in ${MARKETPLACE_PATH})`);
    parseVersion(nextVersion, `new version for "${name}"`);

    const manifestAbsolute = path.join(repoRoot, plugin.manifestPath);
    const pluginText = readFileSync(manifestAbsolute, 'utf8');
    writeFileSync(manifestAbsolute, replaceValue(pluginText, ['version'], nextVersion));
    written.push(plugin.manifestPath);

    marketplaceText = replaceValue(marketplaceText, ['plugins', plugin.index, 'version'], nextVersion);
  }

  if (marketplaceVersion !== null) {
    parseVersion(marketplaceVersion, `new ${MARKETPLACE_PATH} version`);
    marketplaceText = replaceValue(marketplaceText, ['version'], marketplaceVersion);
  }

  if (marketplaceText !== manifest.marketplaceText) {
    writeFileSync(path.join(repoRoot, MARKETPLACE_PATH), marketplaceText);
    written.push(MARKETPLACE_PATH);
  }

  return written.sort();
}
