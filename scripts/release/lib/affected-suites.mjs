import { isDeepStrictEqual } from 'node:util';

import { checkManifest, MARKETPLACE_PATH, readManifest } from './manifests.mjs';
import { commitSource } from './treesource.mjs';

function marketplaceConfiguration(text) {
  const { version, plugins, ...configuration } = JSON.parse(text);
  return {
    ...configuration,
    plugins: plugins.map(({ version: pluginVersion, ...plugin }) => plugin),
  };
}

function isReleaseMetadata(file, versionOnly) {
  return (file === MARKETPLACE_PATH && versionOnly)
    || /^(?:CHANGELOG\.md|scripts\/release\/README\.md|\.release\/unreleased\/[A-Z][A-Z0-9]*-\d+\.md)$/.test(file);
}

function isOrdinaryMetadataChange(git, base, head, file) {
  return [git.treeEntry(base, file), git.treeEntry(head, file)].every((entry) =>
    entry === null || (entry?.type === 'blob' && entry.mode === '100644'));
}

function pluginsForChangedPath(file, plugins, versionOnly) {
  if (isReleaseMetadata(file, versionOnly)) return [];
  if (/^plugins\/sidequest\/(?:src\/)?lib\/suite-resolver\.(?:js|ts)$/.test(file)) return plugins;
  const plugin = plugins.find(({ dir }) => file.startsWith(`${dir}/`));
  if (plugin) return [plugin];
  return plugins;
}

export function selectAffectedPlugins({ git, base, head, manifest }) {
  const plugins = [...manifest.plugins.values()];
  try {
    const before = readManifest(commitSource(git, git.revParse(base)));
    if (checkManifest(before).length > 0) return plugins.map(({ name }) => name);
    const versionOnly = isDeepStrictEqual(
      marketplaceConfiguration(before.marketplaceText),
      marketplaceConfiguration(manifest.marketplaceText),
    );
    const changed = git.invoke(['diff', '--no-renames', '--name-only', '-z', base, git.revParse(head), '--']).stdout.split('\0').slice(0, -1);
    const affected = changed.flatMap((file) => {
      if (isReleaseMetadata(file, versionOnly) && !isOrdinaryMetadataChange(git, base, head, file)) return plugins;
      return pluginsForChangedPath(file, plugins, versionOnly);
    });
    return [...new Set(affected.map(({ name }) => name))];
  } catch {
    return plugins.map(({ name }) => name);
  }
}
