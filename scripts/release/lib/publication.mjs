export class PublicationError extends Error {}

/**
 * What a merged release commit publishes, read from the manifests it already carries. The cut is
 * still the only thing that decides a version; finalize only names the tags for the versions that
 * moved, so a promotion PR cannot publish a number nobody planned.
 */
export function derivePublication({ before, after }) {
  if (before.version === after.version) {
    throw new PublicationError(
      `the marketplace version is ${after.version} on both sides of this commit, so it publishes no release`,
    );
  }

  const plugins = [...after.plugins.values()]
    .map((plugin) => ({
      name: plugin.name,
      from: before.plugins.get(plugin.name)?.version ?? null,
      to: plugin.version,
    }))
    .filter((plugin) => plugin.from !== plugin.to)
    .sort((a, b) => a.name.localeCompare(b.name));

  const tag = `v${after.version}`;
  const summaries = plugins.map((plugin) => `${plugin.name} ${plugin.to}`);
  return {
    marketplace: { from: before.version, to: after.version },
    plugins: plugins.map((plugin) => ({ ...plugin, tag: `${plugin.name}-v${plugin.to}`, tagMessage: `${plugin.name} ${plugin.to} (${tag})` })),
    tag,
    tagMessage: summaries.length > 0 ? `release ${tag}: ${summaries.join(', ')}` : `release ${tag}`,
    pluginTags: plugins.map((plugin) => `${plugin.name}-v${plugin.to}`),
    tags: [tag, ...plugins.map((plugin) => `${plugin.name}-v${plugin.to}`)],
  };
}
