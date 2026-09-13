#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { readRepoChangelog, releasedFragmentFingerprints, REPO_CHANGELOG } from './lib/changelog.mjs';
import { createGit } from './lib/git.mjs';
import { fragmentFile, fragmentFingerprint, readFragments } from './lib/fragments.mjs';
import { checkManifest, MARKETPLACE_PATH, readManifest } from './lib/manifests.mjs';
import { commitSource, diskSource } from './lib/treesource.mjs';
import { repoRootFrom, runCli, splitList } from './lib/cli.mjs';

const MODES = ['fragments', 'dev', 'main'];

const USAGE = `Usage: node scripts/release/guard.mjs [--mode ${MODES.join('|')}] [options]

Fails when the tree breaks a release invariant. Safe to run anywhere: it reads, never writes.

Use "dev" for ticket work and for a pull request into the integration branch: versions must match the
publish ref and every changed plugin needs a fragment. Use "main" for the publish branch and for a
release promotion pull request into it: the marketplace version must have moved, and the fragments
the cut consumed are gone.

A release sync-back pull request carries the release commit already on the publish branch back to the
integration branch, so its manifests moved with no fragment left to name them. Pass the pull request's
trusted base/head repository and refs to have that verified. The publish ref is pinned to one commit,
and each release-owned path is waived only where this pull request's resulting tree holds exactly the
entry that pinned commit already published. A branch name is never consulted.

  --mode <${MODES.join('|')}>   How strict to be (default dev)
  --publish-ref <rev>          Compare versions against this ref (e.g. origin/main), pinned once
  --default-branch <name>      The repository's default branch, asserted to be the publish branch
  --publish-branch <name>      Branch the marketplace serves (default main)
  --changed <paths>            Changed paths to check fragment coverage against
  --changed-file <path>        Read changed paths from a file, one per line ("-" for stdin)
  --pr-base-repo <name>        Base repository of the pull request (owner/repo)
  --pr-head-repo <name>        Head repository of the pull request (owner/repo)
  --pr-base-ref <name>         Base branch of the pull request
  --pr-head-sha <rev>          Resulting commit of the pull request (its merge sha)
  --json                       Machine-readable findings
  --repo <dir>                 Repository root (defaults to this script's repo)`;

function normalizePaths(paths) {
  return paths.map((file) => file.replaceAll('\\', '/').replace(/^\.\//, '')).filter(Boolean);
}

function pluginOf(file, manifest) {
  const match = /^plugins\/([^/]+)\//.exec(file);
  if (!match) return null;
  return manifest.plugins.has(match[1]) ? match[1] : null;
}

// The only paths a release cut writes inside a plugin. Being one of these is what makes a path
// eligible for the sync-back waiver; it is never what earns it. The waiver is earned per path by
// publishedEntryMatches below, because a merge commit can write any of these itself.
function isReleaseOwned(file) {
  return file === MARKETPLACE_PATH
    || file === REPO_CHANGELOG
    || file.startsWith('.release/')
    || /^plugins\/[^/]+\/\.claude-plugin\/plugin\.json$/.test(file);
}

const WAIVER_REMEDY = 'a sync-back may only deliver the tree the release already published, so either '
  + 'rebuild the sync as a plain merge of the publish branch or release that edit with its own fragment';

/**
 * Whether this pull request is shaped like the release coming back from the publish branch: same
 * repository, into the integration branch, and actually carrying the pinned publish commit. Passing
 * only makes its release-owned paths eligible for a waiver. The containment check is here because a
 * pull request that does not carry the release is not a sync-back at all, not because containing a
 * commit says anything about what this tree holds.
 */
export function verifyReleaseSyncBack(git, {
  publishSha, integrationBranch, baseRepo, headRepo, baseRef, headSha,
}) {
  const refusals = [];
  if (!publishSha || !headSha) {
    refusals.push('a pinned publish commit and the pull request head commit are both required to verify a sync-back');
  }
  if (!baseRepo || !headRepo || baseRepo !== headRepo) {
    refusals.push(`its head repository (${headRepo || 'unknown'}) is not its base repository (${baseRepo || 'unknown'})`);
  }
  if (baseRef !== integrationBranch) {
    refusals.push(`its base branch is "${baseRef || 'unknown'}" rather than "${integrationBranch}"`);
  }
  if (refusals.length === 0 && !git.isAncestor(publishSha, headSha)) {
    refusals.push(`${publishSha} is not contained in its head ${headSha}, so it carries no release from the publish branch`);
  }
  return { ok: refusals.length === 0, refusals, publishSha, headSha };
}

/**
 * Whether one path in the pull request's resulting tree is the entry the pinned publish commit
 * published: the same blob and the same mode, or absent on both sides. A tree that cannot be read and
 * an entry that is not an ordinary file both count as a mismatch, so nothing is waived on a guess.
 */
export function publishedEntryMatches(git, publishSha, headSha, file) {
  const published = git.treeEntry(publishSha, file);
  const resulting = git.treeEntry(headSha, file);
  if (published === undefined || resulting === undefined) {
    return { ok: false, reason: `its tree entry could not be read at ${publishSha} or at ${headSha}` };
  }
  for (const entry of [published, resulting]) {
    if (entry && entry.type !== 'blob') {
      return { ok: false, reason: `it is a ${entry.type} entry, which the release waiver does not cover` };
    }
  }
  if (published === null && resulting === null) return { ok: true };
  if (published === null) return { ok: false, reason: `${publishSha} does not have it, so no release published it` };
  if (resulting === null) return { ok: false, reason: `this pull request deletes it while ${publishSha} still has it` };
  if (published.object !== resulting.object) {
    return { ok: false, reason: `its content here is ${resulting.object} but ${publishSha} published ${published.object}` };
  }
  if (published.mode !== resulting.mode) {
    return { ok: false, reason: `its mode here is ${resulting.mode} but ${publishSha} published ${published.mode}` };
  }
  return { ok: true };
}

export function runGuard(repoRoot, {
  mode = 'dev',
  publishRef = null,
  defaultBranch = null,
  publishBranch = 'main',
  integrationBranch = 'develop',
  changed = null,
  pullRequest = null,
  git = null,
} = {}) {
  const failures = [];
  const notes = [];
  const fail = (message) => failures.push(message);

  if (!MODES.includes(mode)) {
    fail(`unknown --mode "${mode}" (expected ${MODES.join(', ')})`);
    return { ok: false, mode, failures, notes };
  }

  const source = diskSource(repoRoot);
  let manifest;
  try {
    manifest = readManifest(source, repoRoot);
  } catch (error) {
    fail(error.message);
    return { ok: false, mode, failures, notes };
  }
  for (const error of checkManifest(manifest)) fail(error);

  const { fragments, errors } = readFragments(source, { knownPlugins: manifest.plugins });
  for (const error of errors) fail(error.message);

  const released = releasedFragmentFingerprints(readRepoChangelog(source));
  for (const fragment of fragments) {
    if (released.has(fragmentFingerprint(fragment))) {
      fail(`${fragmentFile(fragment.ref)} is still queued even though this exact fragment already has a ${REPO_CHANGELOG} entry; its note is stuck and will never ship`);
    }
  }

  if (defaultBranch !== null && defaultBranch !== publishBranch) {
    fail(`the repository default branch is "${defaultBranch}" but the marketplace must serve "${publishBranch}"; a fresh install follows the default branch`);
  }

  // Pinned once, then never resolved again: every later comparison names this commit, so a publish
  // branch that moves mid-run cannot answer two questions with two different trees.
  let publishSha = null;
  if (publishRef && git) {
    try {
      publishSha = git.revParse(publishRef);
    } catch {
      notes.push(`${publishRef} does not resolve to a commit here, so it was not used for any comparison`);
    }
  }

  if (publishSha) {
    const marketplaceAtRef = commitSource(git, publishSha).read(MARKETPLACE_PATH);
    if (marketplaceAtRef === null) {
      notes.push(`${publishRef} has no ${MARKETPLACE_PATH} yet, so version drift was not checked`);
    } else {
      const published = JSON.parse(marketplaceAtRef);
      if (mode === 'dev') {
        if (published.version !== manifest.version) {
          fail(`${MARKETPLACE_PATH} version is ${manifest.version} but ${publishRef} has ${published.version}; only a release cut may move it`);
        }
        const publishedPlugins = new Map((published.plugins ?? []).map((entry) => [entry.name, entry.version]));
        for (const plugin of manifest.plugins.values()) {
          const before = publishedPlugins.get(plugin.name);
          if (before === undefined) {
            notes.push(`"${plugin.name}" is new since ${publishRef}, so its version was not compared`);
            continue;
          }
          if (before !== plugin.version) {
            fail(`"${plugin.name}" is ${plugin.version} here but ${before} on ${publishRef}; version bumps belong in a release cut, not in ticket work`);
          }
        }
      }
      if (mode === 'main') {
        // The publish branch only ever receives a release promotion, and a release is a marketplace
        // version move. Without this, any docs-only pull request into it passed the release guard.
        if (published.version === manifest.version) {
          fail(
            `${MARKETPLACE_PATH} is ${manifest.version} on both sides of this change, so it publishes no release; ` +
            `${publishBranch} only receives a release promotion built by node scripts/release/cut.mjs --prepare`,
          );
        }
        const bumped = new Set();
        for (const entry of published.plugins ?? []) {
          const plugin = manifest.plugins.get(entry.name);
          if (plugin && plugin.version !== entry.version) bumped.add(entry.name);
        }
        if (changed) {
          for (const name of new Set(changed.map((file) => pluginOf(file, manifest)).filter(Boolean))) {
            if (!bumped.has(name)) {
              fail(`"${name}" changed on ${publishBranch} without a version bump, so no installed copy will ever re-extract it`);
            }
          }
          const movedVersions = bumped.size > 0 ? [...bumped].sort().join(', ') : MARKETPLACE_PATH;
          if (published.version !== manifest.version && !changed.includes(REPO_CHANGELOG)) {
            fail(`versions moved (${movedVersions}) without touching ${REPO_CHANGELOG}; releases are generated, not hand-edited`);
          }
        }
      }
    }
  } else if (publishRef && !git) {
    notes.push('--publish-ref was given without a git runner, so version drift was not checked');
  }

  // A promotion carries the cut itself, which consumed every fragment it released, so demanding a
  // fragment for the plugins it changed would fail exactly the commit that did the releasing. The
  // sync-back pull request carries that same commit into the integration branch and has the same
  // problem, but only for a path whose resulting entry is still the one the release published.
  let syncBack = null;
  if (changed && mode !== 'main' && pullRequest) {
    syncBack = verifyReleaseSyncBack(git, {
      publishSha, integrationBranch, ...pullRequest,
    });
    notes.push(syncBack.ok
      ? `release sync-back of ${publishSha}: a release-owned path needs no fragment only where this tree holds exactly what that commit published`
      : `not treated as a release sync-back, so every changed plugin still needs a fragment: ${syncBack.refusals.join('; ')}`);
  }
  if (changed && mode !== 'main') {
    const covered = new Set(fragments.flatMap((fragment) => fragment.plugins.map((entry) => entry.name)));
    const uncovered = new Set();
    let refusedWaiver = false;
    for (const file of changed) {
      if (file.endsWith('/CHANGELOG.md')) continue;
      const name = pluginOf(file, manifest);
      if (!name || covered.has(name)) continue;
      if (syncBack?.ok && isReleaseOwned(file)) {
        const match = publishedEntryMatches(git, syncBack.publishSha, syncBack.headSha, file);
        if (match.ok) continue;
        notes.push(`${file} keeps its fragment requirement: ${match.reason}`);
        refusedWaiver = true;
      }
      uncovered.add(name);
    }
    if (refusedWaiver) notes.push(WAIVER_REMEDY);
    for (const name of [...uncovered].sort()) {
      fail(`"${name}" changed with no fragment naming it; run node scripts/release/note.mjs <REF> --plugins ${name} --bump <level> so the change gets released`);
    }
  }

  return { ok: failures.length === 0, mode, failures, notes, fragments: fragments.length, syncBack };
}

export async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      mode: { type: 'string' },
      'publish-ref': { type: 'string' },
      'default-branch': { type: 'string' },
      'publish-branch': { type: 'string' },
      changed: { type: 'string' },
      'changed-file': { type: 'string' },
      'integration-branch': { type: 'string' },
      'pr-base-repo': { type: 'string' },
      'pr-head-repo': { type: 'string' },
      'pr-base-ref': { type: 'string' },
      'pr-head-sha': { type: 'string' },
      json: { type: 'boolean' },
      repo: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help) {
    console.log(USAGE);
    return 0;
  }

  const repoRoot = path.resolve(values.repo ?? repoRootFrom(import.meta.url));
  let changed = splitList(values.changed);
  if (values['changed-file']) {
    const source = values['changed-file'] === '-' ? readFileSync(0, 'utf8') : readFileSync(values['changed-file'], 'utf8');
    changed = [...(changed ?? []), ...source.split('\n').map((line) => line.trim()).filter(Boolean)];
  }

  const pullRequest = values['pr-head-sha']
    ? {
      baseRepo: values['pr-base-repo'] ?? null,
      headRepo: values['pr-head-repo'] ?? null,
      baseRef: values['pr-base-ref'] ?? null,
      headSha: values['pr-head-sha'],
    }
    : null;

  const result = runGuard(repoRoot, {
    mode: values.mode ?? 'dev',
    publishRef: values['publish-ref'] ?? null,
    defaultBranch: values['default-branch'] ?? null,
    publishBranch: values['publish-branch'] ?? 'main',
    integrationBranch: values['integration-branch'] ?? 'develop',
    changed: changed ? normalizePaths(changed) : null,
    pullRequest,
    git: createGit({ cwd: repoRoot }),
  });

  if (values.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    for (const note of result.notes) console.log(`note: ${note}`);
    for (const failure of result.failures) console.error(`fail: ${failure}`);
    console.log(result.ok ? `release guard passed (${result.mode})` : `release guard failed (${result.failures.length} problem${result.failures.length === 1 ? '' : 's'})`);
  }
  return result.ok ? 0 : 1;
}

await runCli(import.meta.url, main);
