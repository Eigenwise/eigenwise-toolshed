#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { createGit } from './lib/git.mjs';
import { assertGitHubReleasePublished, assertParentCiPassed, isGitHubRemote } from './lib/github.mjs';
import { checkManifest, readManifest } from './lib/manifests.mjs';
import { derivePublication } from './lib/publication.mjs';
import { developSyncCommands } from './lib/promotion.mjs';
import { createPublishLock, publishLockRefusal, publishLockReleaseFailure } from './lib/publishlock.mjs';
import { commitSource } from './lib/treesource.mjs';
import { repoRootFrom, runCli, UsageError } from './lib/cli.mjs';

const USAGE = `Usage: node scripts/release/finalize.mjs [options]

Publishes the release that a promotion PR already merged. It tags the exact merged publish-branch
commit and pushes only tags: the branch itself moved through the PR, never through this script.

Refuses unless the commit IS the current remote publish-branch head, its manifests actually moved a
version against its first parent, and the Test workflow passed on that same sha. There is no
override for any of that. Rerunning it is a no-op once every tag is published, and it never moves a
tag that already points somewhere else.

The publish lock serialises releases started through Sidequest. It cannot serialise an unrelated
writer pushing the publish branch from elsewhere, and git has no way to make a tag push conditional
on a branch the push does not update, so there is no atomic remote-head compare-and-set to hold
here. Instead the remote head and tags are re-read inside the lock immediately before the tags are
created, and re-read again after the push: movement refuses beforehand and is reported afterwards.

  --commit <rev>           Merged commit to publish (default: the remote publish-branch head)
  --publish-branch <name>  Branch the promotion PR merged into (default main)
  --base-branch <name>     Integration branch the sync-back PR targets (default develop)
  --remote <name>          Remote to publish to (default origin)
  --push                   Acquire the publish lock and push the tags
  --json                   Machine-readable result
  --repo <dir>             Repository root (defaults to this script's repo)`;

function requireLocalCommit(git, rev, { remote, publishBranch }) {
  try {
    return git.revParse(rev);
  } catch (_) {
    throw new Error(`${rev} is not in this checkout; run git fetch ${remote} ${publishBranch} before finalizing`);
  }
}

function tagRefspecs(tags) {
  return tags.map((tag) => `refs/tags/${tag}:refs/tags/${tag}`);
}

function pushCommand(remote, refspecs) {
  return ['git', 'push', '--atomic', remote, ...refspecs].join(' ');
}

/**
 * Everything validated before the lock was read from a remote that other people can write. The lock
 * only covers publishers that go through Sidequest, so the last thing done before any tag exists is
 * to read the publish branch and its tags again and refuse on any movement. This narrows the window
 * to the push itself; it does not close it, and closing it would need a tag push conditional on the
 * branch head, which the git protocol does not offer for a ref the push is not updating.
 */
function confirmRemoteUnmoved(git, { remote, publishBranch, commit, tags }) {
  const head = git.remoteBranchHead(remote, publishBranch);
  if (head !== commit) {
    throw new Error(
      `${remote}/${publishBranch} moved to ${head} while this release was being validated, so ${commit} is no longer ` +
      `its head. Nothing was published. Fetch ${remote} and finalize the new head instead.`,
    );
  }
  const targets = git.remoteTagTargets(remote);
  const conflicting = tags.filter((tag) => targets.has(tag) && targets.get(tag) !== commit);
  if (conflicting.length > 0) {
    throw new Error(
      `another publisher created ${conflicting.map((tag) => `${tag} -> ${targets.get(tag)}`).join(', ')} on ${remote} while ` +
      'this release was being validated. A published version is never moved; nothing was published.',
    );
  }
  return targets;
}

/**
 * The other half of that narrowing: a branch that advanced during the push leaves the tag pinned to
 * a commit that is still part of its history, which is the release it named all along. A branch that
 * no longer contains the tagged commit is a different situation entirely, and the tag is already out.
 */
function describeRemoteMovement(git, { remote, publishBranch, commit, tag }) {
  const head = git.remoteBranchHead(remote, publishBranch);
  if (head === commit) return null;
  if (!git.isAncestor(commit, head)) {
    throw new Error(
      `${tag} was published at ${commit}, but ${remote}/${publishBranch} is now ${head} and no longer contains that commit. ` +
      'The published tag stays; work out how the publish branch lost it before releasing again.',
    );
  }
  return {
    head,
    message: `note: ${remote}/${publishBranch} advanced to ${head} during publication. ${tag} stays pinned to ${commit}, ` +
      'which is still in its history.',
  };
}

/**
 * The publish half of the release transaction. Preparation already decided every version; this only
 * names the tags for the versions that moved and pins them to the commit the publish branch really
 * carries, so a failed PR, a stale local checkout, or a second run cannot publish a different sha.
 */
export async function finalize(options = {}) {
  const {
    repoRoot,
    commit: requestedCommit = null,
    publishBranch = 'main',
    baseBranch = 'develop',
    remote = 'origin',
    push = false,
    log = console.log,
  } = options;

  if (!repoRoot) throw new UsageError('finalize() needs a repoRoot');
  const git = options.git ?? createGit({ cwd: repoRoot });

  const merged = git.remoteBranchHead(remote, publishBranch);
  const commit = requireLocalCommit(git, requestedCommit ?? merged, { remote, publishBranch });
  if (commit !== merged) {
    throw new Error(
      `${remote}/${publishBranch} is at ${merged}, not ${commit}; a release is tagged only at the exact merged ` +
      `${publishBranch} commit. Merge the promotion PR, fetch ${remote}, then finalize again.`,
    );
  }

  // Always the first parent: that is the publish branch as it stood before the merge. Letting a
  // caller name the comparison let an ordinary commit borrow an unrelated release's version delta
  // and publish every tag at the wrong sha (SQ-2826).
  const previous = requireLocalCommit(git, `${commit}^1`, { remote, publishBranch });
  const loadManifest = (rev) => {
    const loaded = readManifest(commitSource(git, rev), repoRoot);
    const errors = checkManifest(loaded);
    if (errors.length > 0) {
      throw new Error(`manifest versions at ${rev} are inconsistent, refusing to publish:\n  ${errors.join('\n  ')}`);
    }
    return loaded;
  };
  const publication = derivePublication({ before: loadManifest(previous), after: loadManifest(commit) });
  const syncCommands = developSyncCommands({ remote, publishBranch, baseBranch, tag: publication.tag });

  const remoteTags = git.remoteTagTargets(remote);
  const moved = publication.tags.filter((tag) => remoteTags.has(tag) && remoteTags.get(tag) !== commit);
  if (moved.length > 0) {
    throw new Error(
      `these tags already exist on ${remote} pointing somewhere other than ${commit}: ` +
      `${moved.map((tag) => `${tag} -> ${remoteTags.get(tag)}`).join(', ')}. ` +
      'A published version is never moved; cut a new window instead.',
    );
  }
  const missing = publication.tags.filter((tag) => !remoteTags.has(tag));
  if (missing.length === 0) {
    log(`${publication.tag} is already published at ${commit}; nothing to publish.`);
    return {
      status: 'already-published', commit, previous, publication, missing: [], pushed: false,
      ci: null, githubRelease: null, syncCommands,
    };
  }

  const githubRemote = isGitHubRemote(git.remoteUrl(remote));
  // A failed or missing Test run on the merged sha refuses, with nothing to override it: the only
  // way forward is a fix that Test passes on, promoted the same way (SQ-2826).
  let ci = null;
  if (options.assertParentCiPassed || githubRemote) {
    const assertCiPassed = options.assertParentCiPassed
      ?? ((root, sha) => assertParentCiPassed(root, sha, spawnSync, [], { overridable: false }));
    const result = assertCiPassed(repoRoot, commit, []);
    ci = { status: 'passed', commit, conclusion: result?.conclusion ?? 'success' };
  }

  let publishLock = null;
  let publishLockAcquired = false;
  const created = [];
  let marketplacePublished = false;
  try {
    if (push) {
      publishLock = options.publishLock ?? createPublishLock(repoRoot);
      const acquired = await publishLock.acquire();
      if (!acquired?.ok) throw new Error(publishLockRefusal(acquired ?? {}));
      publishLockAcquired = true;
    }

    const confirmedTags = confirmRemoteUnmoved(git, { remote, publishBranch, commit, tags: publication.tags });
    const unpublished = missing.filter((tag) => !confirmedTags.has(tag));
    if (unpublished.length === 0) {
      log(`${publication.tag} is already published at ${commit}; nothing to publish.`);
      return {
        status: 'already-published', commit, previous, publication, missing: [], pushed: false,
        ci, githubRelease: null, syncCommands,
      };
    }

    const marketplacePush = tagRefspecs(unpublished.filter((tag) => tag === publication.tag));
    const pluginPush = tagRefspecs(publication.pluginTags.filter((tag) => unpublished.includes(tag)));
    const pushCommands = [marketplacePush, pluginPush]
      .filter((refspecs) => refspecs.length > 0)
      .map((refspecs) => pushCommand(remote, refspecs));

    try {
      for (const tag of unpublished) {
        const existing = git.tagTarget(tag);
        if (existing === commit) continue;
        if (existing !== null) {
          throw new Error(`local tag ${tag} points at ${existing} instead of ${commit}; delete that leftover, then finalize again`);
        }
        const plugin = publication.plugins.find((entry) => entry.tag === tag);
        git.tag(tag, plugin ? plugin.tagMessage : publication.tagMessage, commit);
        created.push(tag);
      }

      let pushed = false;
      let githubRelease = null;
      let remoteMoved = null;
      if (push) {
        if (marketplacePush.length > 0) {
          git.pushAtomic(remote, marketplacePush);
          marketplacePublished = true;
        }
        if (pluginPush.length > 0) git.pushAtomic(remote, pluginPush);
        remoteMoved = describeRemoteMovement(git, { remote, publishBranch, commit, tag: publication.tag });
        if (remoteMoved) log(remoteMoved.message);
        if (githubRemote) {
          const assertReleasePublished = options.assertGitHubReleasePublished
            ?? ((root, tag, releaseCommit) => assertGitHubReleasePublished(root, tag, releaseCommit));
          githubRelease = await assertReleasePublished(repoRoot, publication.tag, commit);
          if (githubRelease.status === 'deferred') log(githubRelease.message);
        }
        pushed = true;
        log(`published ${publication.tag} at ${commit}`);
      } else {
        log(`${publication.tag} is ready at ${commit}; publish it with:`);
        for (const command of pushCommands) log(`  ${command}`);
      }

      log(`bring ${publication.tag} back to ${baseBranch} through a PR:`);
      for (const command of syncCommands) log(`  ${command}`);

      return {
        status: 'published', commit, previous, publication, missing: unpublished, pushed, marketplacePush,
        pluginPush, pushCommands, created, ci, githubRelease, remoteMoved, syncCommands,
      };
    } catch (error) {
      // Only unpushed tags can be undone; a pushed tag is a published version and stays.
      if (!marketplacePublished) {
        const leftovers = [];
        for (const tag of created) {
          try {
            git.deleteTag(tag);
          } catch (_) {
            leftovers.push(tag);
          }
        }
        if (leftovers.length > 0) {
          throw new Error(
            `${error.message}\nNothing was published, but these local tags could not be deleted: ${leftovers.join(', ')}. ` +
            `Remove them with git update-ref -d refs/tags/<tag> before retrying.`,
            { cause: error },
          );
        }
        throw new Error(`${error.message}\nNothing was published; no tag was created.`, { cause: error });
      }
      throw new Error(
        `${error.message}\n${publication.tag} is already published at ${commit}. Inspect ${publication.pluginTags.join(', ')} on ` +
        `${remote}, then publish any missing plugin tags with:\n  ${pushCommand(remote, pluginPush)}`,
        { cause: error },
      );
    }
  } finally {
    if (publishLockAcquired) {
      const released = await publishLock.release();
      if (!released?.ok) throw new Error(publishLockReleaseFailure(released));
    }
  }
}

export async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      commit: { type: 'string' },
      'publish-branch': { type: 'string' },
      'base-branch': { type: 'string' },
      remote: { type: 'string' },
      push: { type: 'boolean' },
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
  const result = await finalize({
    repoRoot,
    commit: values.commit ?? null,
    publishBranch: values['publish-branch'] ?? 'main',
    baseBranch: values['base-branch'] ?? 'develop',
    remote: values.remote ?? 'origin',
    push: values.push === true,
    log: values.json ? () => {} : console.log,
  });

  if (values.json) {
    console.log(JSON.stringify({
      status: result.status,
      commit: result.commit,
      previous: result.previous,
      pushed: result.pushed ?? false,
      tags: result.publication.tags,
      missing: result.missing,
      pushCommands: result.pushCommands ?? [],
      syncCommands: result.syncCommands,
      ci: result.ci ?? null,
      githubRelease: result.githubRelease ?? null,
      remoteMoved: result.remoteMoved ?? null,
      publication: {
        marketplace: result.publication.marketplace,
        plugins: result.publication.plugins,
        tag: result.publication.tag,
      },
    }, null, 2));
  }
  return 0;
}

await runCli(import.meta.url, main);
