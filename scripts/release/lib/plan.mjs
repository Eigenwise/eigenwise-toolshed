import { compareRefs } from './fragments.mjs';
import { bumpVersion, maxLevel } from './semver.mjs';

export const MODES = ['normal', 'hotfix'];

const MARKETPLACE_LEVEL = { normal: 'minor', hotfix: 'patch' };

export class PlanError extends Error {}

function selectFragments({ fragments, mode, tickets, released, force }) {
  const selected = [];
  const skipped = [];

  if (mode === 'hotfix') {
    if (!tickets || tickets.length === 0) throw new PlanError('a hotfix cut needs --tickets SQ-x[,SQ-y]');
    const duplicates = tickets.filter((ref, index) => tickets.indexOf(ref) !== index);
    if (duplicates.length > 0) {
      throw new PlanError(`--tickets names ${[...new Set(duplicates)].sort().join(', ')} more than once; list each ref exactly once`);
    }
    const byRef = new Map(fragments.map((fragment) => [fragment.ref, fragment]));
    const wanted = new Set(tickets);
    for (const ref of tickets) {
      const fragment = byRef.get(ref);
      if (!fragment) throw new PlanError(`no fragment .release/unreleased/${ref}.md, so ${ref} cannot be hotfixed`);
      if (released.has(ref)) throw new PlanError(`${ref} is already in CHANGELOG.md; it has been released`);
      if (fragment.hold && !force) throw new PlanError(`${ref} is marked "hold: true"; pass --force to release it anyway`);
      selected.push(fragment);
    }
    for (const fragment of fragments) {
      if (!wanted.has(fragment.ref)) {
        skipped.push({ ref: fragment.ref, reason: 'not named by --tickets' });
      }
    }
    return { selected: selected.sort((a, b) => compareRefs(a.ref, b.ref)), skipped };
  }

  for (const fragment of fragments) {
    if (released.has(fragment.ref)) skipped.push({ ref: fragment.ref, reason: 'already released (present in CHANGELOG.md)' });
    else if (fragment.hold) skipped.push({ ref: fragment.ref, reason: 'held by "hold: true"' });
    else selected.push(fragment);
  }
  return { selected, skipped };
}

/**
 * The single source of truth for what a cut would do. Pure: every input comes from the tree, so
 * plan.mjs and cut.mjs cannot disagree and a rerun on the same tree produces the same answer.
 */
export function buildPlan({
  fragments,
  manifest,
  mode = 'normal',
  tickets = null,
  released = new Set(),
  force = false,
  date,
  sha = null,
  base = null,
  publishBranch = 'main',
  suiteResolver = () => null,
}) {
  if (!MODES.includes(mode)) throw new PlanError(`unknown mode "${mode}" (expected ${MODES.join(' or ')})`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) throw new PlanError(`release date "${date}" must be YYYY-MM-DD`);

  const { selected, skipped } = selectFragments({ fragments, mode, tickets, released, force });

  const byPlugin = new Map();
  for (const fragment of selected) {
    for (const { name, level } of fragment.plugins) {
      const plugin = manifest.plugins.get(name);
      if (!plugin) throw new PlanError(`fragment ${fragment.ref} names "${name}", which is not published in .claude-plugin/marketplace.json`);
      if (!byPlugin.has(name)) byPlugin.set(name, { levels: [], entries: [], plugin });
      const bucket = byPlugin.get(name);
      bucket.levels.push(level);
      bucket.entries.push({ ref: fragment.ref, title: fragment.title, level, commit: fragment.commit, body: fragment.body });
    }
  }

  const plugins = [...byPlugin.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, bucket]) => {
      const level = maxLevel(bucket.levels);
      const from = bucket.plugin.version;
      return {
        name,
        dir: bucket.plugin.dir,
        manifestPath: bucket.plugin.manifestPath,
        level,
        from,
        to: bumpVersion(from, level, `${name} version`),
        entries: bucket.entries.sort((a, b) => compareRefs(a.ref, b.ref)),
      };
    });

  const releasable = selected.length > 0;
  const marketplaceLevel = MARKETPLACE_LEVEL[mode];
  const marketplaceTo = releasable
    ? bumpVersion(manifest.version, marketplaceLevel, 'marketplace version')
    : manifest.version;
  const tag = `v${marketplaceTo}`;
  const pluginTags = plugins.map((plugin) => `${plugin.name}-v${plugin.to}`);

  const suites = plugins
    .map((plugin) => suiteResolver({ name: plugin.name, dir: plugin.dir }))
    .filter((suite) => suite !== null);

  return {
    mode,
    sha,
    base,
    source: manifest.source,
    commit: null,
    date,
    publishBranch,
    repository: manifest.repository,
    releasable,
    selected,
    skipped,
    plugins,
    marketplace: { from: manifest.version, to: marketplaceTo, level: marketplaceLevel },
    tag,
    pluginTags,
    tags: releasable ? [tag, ...pluginTags] : [],
    suites,
  };
}

export function planCommitMessage(plan) {
  const summary = plan.plugins.map((plugin) => `${plugin.name} ${plugin.to}`).join(', ');
  const refs = plan.selected.map((fragment) => fragment.ref).join(', ');
  const kind = plan.mode === 'hotfix' ? 'hotfix ' : '';
  return `release ${kind}${plan.tag}: ${summary} (${refs})`;
}

/**
 * Refspecs name the verified commit explicitly, never HEAD: if anything moved HEAD after the
 * release was built and verified, the push must still publish exactly what was verified.
 */
export function planRefspecs(plan, commit) {
  const sha = commit ?? plan.commit;
  if (!sha) throw new PlanError('the publish refspecs need the release commit sha');
  return [`${sha}:refs/heads/${plan.publishBranch}`, ...plan.tags.map((tag) => `refs/tags/${tag}:refs/tags/${tag}`)];
}

export function planPushCommand(plan, { remote = 'origin', commit = null } = {}) {
  const sha = commit ?? plan.commit ?? '<release-sha>';
  const refspecs = [
    `${sha}:refs/heads/${plan.publishBranch}`,
    ...plan.tags.map((tag) => `refs/tags/${tag}:refs/tags/${tag}`),
  ];
  return ['git', 'push', '--atomic', remote, ...refspecs].join(' ');
}

export function formatPlan(plan) {
  const lines = [];
  lines.push(`mode:        ${plan.mode}`);
  lines.push(`pinned sha:  ${plan.sha ?? '(working tree)'}`);
  lines.push(`read from:   ${plan.source}`);
  lines.push(`date:        ${plan.date}`);
  if (!plan.releasable) {
    lines.push('', 'nothing to release: no selected fragments in .release/unreleased/');
    if (plan.skipped.length > 0) {
      lines.push('', 'skipped fragments:');
      for (const entry of plan.skipped) lines.push(`  ${entry.ref}: ${entry.reason}`);
    }
    return lines.join('\n');
  }

  lines.push('', `fragments (${plan.selected.length}):`);
  for (const fragment of plan.selected) {
    const targets = fragment.plugins.map((entry) => `${entry.name}:${entry.level}`).join(' ');
    lines.push(`  ${fragment.ref}  ${targets}  ${fragment.title}`);
  }
  if (plan.skipped.length > 0) {
    lines.push('', `skipped (${plan.skipped.length}):`);
    for (const entry of plan.skipped) lines.push(`  ${entry.ref}: ${entry.reason}`);
  }

  lines.push('', `plugin versions (${plan.plugins.length}):`);
  for (const plugin of plan.plugins) {
    lines.push(`  ${plugin.name}  ${plugin.from} -> ${plugin.to}  (${plugin.level})`);
  }
  const moved = plan.plugins.length;
  lines.push('', `marketplace: ${plan.marketplace.from} -> ${plan.marketplace.to} (${plan.marketplace.level})`);
  lines.push(`tags:        ${plan.tags.join(' ')}`);
  lines.push('', `suites (${plan.suites.length}):`);
  if (plan.suites.length === 0) lines.push('  (none of the changed plugins ship a suite)');
  for (const suite of plan.suites) {
    lines.push(`  ${suite.plugin}: ${suite.setup ? `${suite.setup} && ` : ''}${suite.command}  [cwd ${suite.cwd}]`);
  }
  lines.push('', `commit:      ${planCommitMessage(plan)}`);
  lines.push(`publish:     ${planPushCommand(plan)}`);
  lines.push('', `${moved} plugin${moved === 1 ? '' : 's'} move; every other plugin keeps its version and nobody re-extracts it.`);
  return lines.join('\n');
}
