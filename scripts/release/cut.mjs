#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { applyChangelogs, readRepoChangelog, releasedFragmentFingerprints, REPO_CHANGELOG } from './lib/changelog.mjs';
import { createGit } from './lib/git.mjs';
import { fragmentFile, fragmentFingerprint, HOLD_FILE, isHeld, readFragments } from './lib/fragments.mjs';
import { assertGitHubReleasePublished, assertParentCiPassed, isGitHubRemote } from './lib/github.mjs';
import { applyVersions, checkManifest, readManifest } from './lib/manifests.mjs';
import { resolveInRepo } from './lib/paths.mjs';
import { buildPlan, formatPlan, planCommitMessage, planRefspecs } from './lib/plan.mjs';
import { createPublishLock, publishLockRefusal, publishLockReleaseFailure } from './lib/publishlock.mjs';
import { promotionCommands } from './lib/promotion.mjs';
import { createSuiteResolver } from './lib/suites.mjs';
import { commitSource, diskSource } from './lib/treesource.mjs';
import { repoRootFrom, runCli, splitList, UsageError } from './lib/cli.mjs';

export { assertGitHubReleasePublished, assertParentCiPassed };

const USAGE = `Usage: node scripts/release/cut.mjs [options]

Builds a release window in the working tree and stops just short of publishing it. Everything is
local until --push.

--prepare is the entry for a protected publish branch: it builds the window on a release branch cut
from --base-branch, creates no tags, and never touches the publish branch. The promotion PR carries
it to the publish branch, and scripts/release/finalize.mjs tags the merged commit.

Without --prepare the cut publishes directly: it atomically pairs the verified release commit with
the marketplace tag, then pushes the plugin tags separately. That path needs an unprotected publish
branch and an explicit --direct-publish; it is refused by default.

  --prepare                Build the window on a release branch for a promotion PR; never tag
  --base-branch <name>     Branch a --prepare window is cut from (default develop)
  --release-branch <name>  Release branch to create (default release/v<marketplace-version>)
  --sha <rev>              Pin the window to this commit (default HEAD). Every input is read from it
  --mode <normal|hotfix>   Window kind (default normal)
  --tickets <a,b>          Refs to release in a hotfix, each named once
  --date <YYYY-MM-DD>      Release date (defaults to the pinned commit's date)
  --publish-branch <name>  Branch the release lands on (default main)
  --remote <name>          Remote to publish to (default origin)
  --dry-run                Plan only: no file writes, no git mutations
  --push                   Acquire the publish lock and push (the release branch under --prepare)
  --skip-tests             Do not run the changed plugins' suites
  --no-merge               The tree is already prepared; skip the fast-forward merge
  --no-branch-check        Allow cutting from a branch other than the one the window is cut from
  --allow-dirty            Tolerate unstaged or untracked files (staged changes are never allowed)
  --force                  Override .release/HOLD, held fragments, and existing tags
  --direct-publish         Allow --push without --prepare to move the publish branch itself. Off by
                           default: it only works where the publish branch is unprotected
  --ci-override <reason>   Proceed after a failed or missing Test workflow, recording why
  --json                   Machine-readable result
  --repo <dir>             Repository root (defaults to this script's repo)`;

// Anything that lets a suite authenticate to a remote, or reconfigure git underneath the engine,
// is removed before the suite runs. The engine still re-verifies every ref afterwards, because
// stripping credentials is a reduction in reach, not a proof.
const SUITE_CREDENTIAL_DENYLIST = [
  'GITHUB_TOKEN', 'GH_TOKEN', 'GH_ENTERPRISE_TOKEN', 'RELEASE_TOKEN', 'GITHUB_ACTIONS_TOKEN',
  'NPM_TOKEN', 'NODE_AUTH_TOKEN', 'NPM_CONFIG__AUTH', 'NPM_CONFIG__AUTHTOKEN',
  'GIT_ASKPASS', 'SSH_ASKPASS', 'SSH_AUTH_SOCK', 'GIT_SSH', 'GIT_SSH_COMMAND',
  'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL',
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'GITLAB_TOKEN', 'CI_JOB_TOKEN',
];

// A suite run from inside Claude Code inherits a real session and agent identity,
// and CI has neither. Sidequest reads exactly these when a claim binds an isolated
// dispatch, so leaving them set let a test that never passed --session bind off the
// developer's own session and go green locally while CI refused unbound_dispatch.
// A test that needs an identity sets its own.
const SUITE_RUNTIME_IDENTITY_DENYLIST = [
  'CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID', 'SIDEQUEST_SESSION', 'SIDEQUEST_AGENT',
];

export function suiteEnvironment(base = process.env) {
  const env = { ...base };
  for (const name of SUITE_CREDENTIAL_DENYLIST) delete env[name];
  for (const name of SUITE_RUNTIME_IDENTITY_DENYLIST) delete env[name];
  for (const name of Object.keys(env)) {
    if (name.startsWith('GIT_CONFIG_')) delete env[name];
  }
  delete env.GIT_HTTP_EXTRAHEADER;
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
  env.GIT_CONFIG_SYSTEM = env.GIT_CONFIG_GLOBAL;
  env.npm_config_ignore_scripts = base.npm_config_ignore_scripts ?? '';
  return env;
}

export function defaultSuiteRunner(repoRoot, { log = console.log, tag = 'release' } = {}) {
  return (suite) => {
    const command = suite.setup ? `${suite.setup} && ${suite.command}` : suite.command;
    const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    const logRelative = path.join('.release', 'logs', `${tag}-${suite.plugin}-${timestamp}.log`);
    const logPath = resolveInRepo(repoRoot, logRelative, `suite log for "${suite.plugin}"`);
    log(`running ${suite.plugin}: ${command}`);
    const result = spawnSync(command, {
      cwd: resolveInRepo(repoRoot, suite.cwd, `suite directory for "${suite.plugin}"`),
      shell: true,
      stdio: ['inherit', 'pipe', 'pipe'],
      windowsHide: true,
      env: suiteEnvironment(),
      encoding: 'utf8',
    });
    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';
    process.stdout.write(stdout);
    process.stderr.write(stderr);
    mkdirSync(path.dirname(logPath), { recursive: true });
    writeFileSync(logPath, stdout + stderr);
    return { code: result.status ?? 1, command, logPath: logRelative };
  };
}

function assertNoStaleTags(git, plan, { remote, force }) {
  const localTags = new Set(git.localTags());
  const remoteTags = new Set(git.remoteTags(remote));
  const remoteClashes = plan.tags.filter((tag) => remoteTags.has(tag));
  const localOnlyClashes = plan.tags.filter((tag) => localTags.has(tag) && !remoteTags.has(tag));
  if (remoteClashes.length === 0 && localOnlyClashes.length === 0) return;
  if (force) return;
  if (remoteClashes.length > 0) {
    throw new Error(
      `these tags already exist on ${remote}: ${remoteClashes.join(', ')}. ` +
      'Cut a new window instead of moving a published tag; --force only when you are deliberately repairing the remote state.',
    );
  }
  throw new Error(
    `these local tags are leftovers from an unpublished attempt: ${localOnlyClashes.join(', ')}. ` +
    `Verify they are absent from ${remote}, delete the local tags, then retry; --force only if you know the tags are safe to reuse.`,
  );
}

function preparedRecoveryInstructions({ pinned, baseBranch, releaseBranch, rolledBack }) {
  if (rolledBack) {
    return releaseBranch
      ? `Nothing was published. The prepared branch ${releaseBranch} was deleted and ${baseBranch} never moved.`
      : `Nothing was published and no release branch was created; ${baseBranch} never moved.`;
  }
  return [
    `Nothing was published. To undo this prepared window:`,
    `  git reset --hard ${pinned}`,
    `  git checkout ${baseBranch}`,
    ...(releaseBranch ? [`  git branch -D ${releaseBranch}`] : []),
  ].join('\n');
}

function releaseRecoveryInstructions(plan, originalHead, remote, marketplacePublished, { rolledBack = false } = {}) {
  if (marketplacePublished) {
    return [
      `The marketplace commit and tag ${plan.tag} are already published.`,
      `Inspect ${plan.pluginTags.join(', ')} on the remote, then publish any missing plugin tags with:`,
      `  ${pushCommand(remote, pluginTagRefspecs(plan))}`,
    ].join('\n');
  }
  if (rolledBack) {
    return `The local release window was rolled back to ${originalHead} and its tags were deleted.`;
  }
  return [
    'The release commit and tags are local only. To undo this local window:',
    `  git reset --hard ${originalHead}`,
    ...plan.tags.map((tag) => `  git update-ref -d refs/tags/${tag}`),
  ].join('\n');
}

function rollBackLocalReleaseWindow(git, plan, originalHead) {
  git.resetHard(originalHead);
  for (const tag of plan.tags) git.deleteTag(tag);
}

function rollBackPreparedRelease(git, { pinned, baseBranch, releaseBranch }) {
  git.resetHard(pinned);
  if (!releaseBranch) return;
  git.switchBranch(baseBranch);
  git.deleteBranch(releaseBranch);
}

function marketplaceRefspecs(plan, commit) {
  const sha = commit ?? plan.commit ?? '<release-sha>';
  return [
    `${sha}:refs/heads/${plan.publishBranch}`,
    `refs/tags/${plan.tag}:refs/tags/${plan.tag}`,
  ];
}

function pluginTagRefspecs(plan) {
  return plan.pluginTags.map((tag) => `refs/tags/${tag}:refs/tags/${tag}`);
}

function pushCommand(remote, refspecs) {
  return ['git', 'push', '--atomic', remote, ...refspecs].join(' ');
}

function publishCommands(plan, { remote, commit }) {
  const commands = [pushCommand(remote, marketplaceRefspecs(plan, commit))];
  const pluginRefs = pluginTagRefspecs(plan);
  if (pluginRefs.length > 0) commands.push(pushCommand(remote, pluginRefs));
  return commands;
}

/**
 * The release commit and its tags are the verified artefact. Suites run arbitrary repository code,
 * so nothing they could have done to the local refs is allowed to reach the remote.
 */
function assertReleaseIntact(git, plan, commit, { tags = true } = {}) {
  const head = git.revParse('HEAD');
  if (head !== commit) {
    throw new Error(`HEAD moved from the verified release commit ${commit} to ${head} while the suites ran; nothing was published`);
  }
  const staged = git.stagedFiles();
  if (staged.length > 0) {
    throw new Error(`the suites left staged changes (${staged.slice(0, 5).join(', ')}); the verified release commit is no longer what the tree says, nothing was published`);
  }
  if (!tags) return;
  for (const tag of plan.tags) {
    const target = git.tagTarget(tag);
    if (target !== commit) {
      throw new Error(`tag ${tag} points at ${target ?? 'nothing'} instead of the verified release commit ${commit}; nothing was published`);
    }
  }
}

/**
 * Builds the whole release locally, then either hands it to a promotion PR (--prepare) or
 * atomically publishes its commit and marketplace tag. Plugin tags follow in a separate atomic
 * update, so the tag that triggers the GitHub Release workflow never shares a push with more than
 * three tags. Everything before that stays local.
 */
export async function cut(options = {}) {
  const {
    repoRoot,
    mode = 'normal',
    tickets = null,
    sha = null,
    date = null,
    publishBranch = 'main',
    prepare = false,
    baseBranch = null,
    releaseBranch = null,
    remote = 'origin',
    dryRun = false,
    push = false,
    skipTests = false,
    noMerge = false,
    branchCheck = true,
    allowDirty = false,
    force = false,
    directPublish = false,
    ciOverrideReason = null,
    log = console.log,
  } = options;

  if (!repoRoot) throw new UsageError('cut() needs a repoRoot');
  // Direct publication pushes the publish branch itself. Here that branch is protected, so this
  // repository releases through --prepare plus a promotion PR and finalize.mjs; the old path stays
  // reachable for repositories with an unprotected publish branch, but only when asked for by name.
  if (push && !prepare && !directPublish) {
    throw new UsageError(
      `publishing ${publishBranch} directly is off by default: this repository's publish branch is protected and moves ` +
      'only through a reviewed promotion PR. Use --prepare --push, merge the PR it prints, then ' +
      'node scripts/release/finalize.mjs --push. --direct-publish is only for a repository whose publish branch is unprotected.',
    );
  }
  // A prepared window is cut from the integration branch and promoted; a direct window is cut from
  // the publish branch itself.
  const windowBranch = baseBranch ?? (prepare ? 'develop' : publishBranch);
  const git = options.git ?? createGit({ cwd: repoRoot, dryRun });

  const loadManifest = (source) => {
    const loaded = readManifest(source, repoRoot);
    const errors = checkManifest(loaded);
    if (errors.length > 0) {
      throw new Error(`manifest versions are inconsistent, refusing to cut:\n  ${errors.join('\n  ')}`);
    }
    return loaded;
  };

  const pinned = git.revParse(sha ?? 'HEAD');
  const basePin = git.revParse('HEAD');

  // A staged file would ride along in the release commit no matter which paths the engine adds,
  // so the index has to be empty even when the caller tolerates a dirty tree.
  const staged = git.stagedFiles();
  if (staged.length > 0) {
    throw new Error(`the index has staged changes (${staged.slice(0, 5).join(', ')}); a release commit may only contain what the cut generated`);
  }
  if (!allowDirty && !git.isClean()) {
    throw new Error('the working tree has uncommitted changes; cut from a clean checkout or pass --allow-dirty');
  }
  if (branchCheck) {
    const branch = git.currentBranch();
    if (branch !== windowBranch) {
      const hint = prepare
        ? `check out ${windowBranch} or pass --no-branch-check`
        : `check out ${windowBranch} or pass --no-branch-check. A protected ${publishBranch} is released with --prepare plus a promotion PR, then node scripts/release/finalize.mjs`;
      throw new Error(`cutting from "${branch}" but this window is cut from "${windowBranch}"; ${hint}`);
    }
  }

  const windowSource = commitSource(git, pinned);
  const baseSource = mode === 'hotfix' ? commitSource(git, basePin) : windowSource;

  if (mode === 'normal' && !force) {
    const reason = isHeld(windowSource) ?? isHeld(diskSource(repoRoot));
    if (reason !== null) {
      log(`release held by ${HOLD_FILE}: ${reason}`);
      return { status: 'held', reason, plan: null };
    }
  }

  if (mode === 'hotfix' && (!tickets || tickets.length === 0)) {
    throw new UsageError('--mode hotfix needs --tickets SQ-x[,SQ-y]');
  }

  // A normal window is only what a fast-forward would produce. If the pin does not already contain
  // the publish branch, no plan built from it describes the cut that would follow.
  if (mode === 'normal' && pinned !== basePin && !git.isAncestor(basePin, pinned)) {
    throw new Error(`${windowBranch} (${basePin}) is not an ancestor of the pin ${pinned}, so this window could not fast-forward; choose a pin descended from ${windowBranch}`);
  }

  const manifest = loadManifest(baseSource);
  const released = releasedFragmentFingerprints(readRepoChangelog(baseSource));
  const { fragments, errors } = readFragments(windowSource, { knownPlugins: manifest.plugins });
  if (errors.length > 0) throw new Error(`invalid release fragments:\n  ${errors.map((error) => error.message).join('\n  ')}`);

  const plan = buildPlan({
    fragments,
    manifest,
    mode,
    tickets,
    released,
    force,
    date: date ?? git.commitDate(pinned),
    sha: pinned,
    base: basePin,
    publishBranch,
    suiteResolver: createSuiteResolver(repoRoot),
  });

  if (!plan.releasable) {
    log('nothing to release: no selected fragments in .release/unreleased/');
    return { status: 'nothing-to-release', plan };
  }

  assertNoStaleTags(git, plan, { remote, force });
  const preparedBranchName = prepare ? (releaseBranch ?? `release/${plan.tag}`) : null;
  if (prepare && !dryRun && git.branchExists(preparedBranchName)) {
    throw new Error(`branch "${preparedBranchName}" already exists; delete that leftover release branch or pass --release-branch <name>`);
  }

  const githubRemote = !dryRun && isGitHubRemote(git.remoteUrl(remote));
  let ci = null;
  if (!dryRun && (options.assertParentCiPassed || githubRemote)) {
    const parent = git.remoteBranchHead(remote, windowBranch);
    const assertCiPassed = options.assertParentCiPassed
      ?? ((repoRoot, commit, suites) => assertParentCiPassed(repoRoot, commit, spawnSync, suites));
    try {
      const result = assertCiPassed(repoRoot, parent, plan.suites);
      ci = { status: 'passed', commit: parent, conclusion: result?.conclusion ?? 'success' };
    } catch (error) {
      if (!ciOverrideReason) throw error;
      ci = { status: 'overridden', commit: parent, reason: ciOverrideReason, error: error.message };
    }
  }

  if (dryRun) {
    const pushCommands = prepare
      ? promotionCommands({ remote, releaseBranch: preparedBranchName, publishBranch, tag: plan.tag })
      : publishCommands(plan, { remote, commit: null });
    log(formatPlan(plan).replace(/^publish:.*$/m, `publish:     ${pushCommands.join('\n             ')}`));
    return { status: 'dry-run', plan, pushCommands, releaseBranch: preparedBranchName };
  }

  let publishLock = null;
  let publishLockAcquired = false;
  let preparedBranch = null;
  try {
    if (push) {
      publishLock = options.publishLock ?? createPublishLock(repoRoot);
      const acquired = await publishLock.acquire();
      if (!acquired?.ok) throw new Error(publishLockRefusal(acquired ?? {}));
      publishLockAcquired = true;
    }

    // The plan was read from the pin, so the tree the writes land on has to BE the pin. A prepared
    // window gets its own branch at the pin, so the integration branch never carries the release
    // commit and the promotion PR is the only thing that can move the publish branch.
    if (prepare) {
      git.switchNewBranch(preparedBranchName, pinned);
      preparedBranch = preparedBranchName;
    }
    if (mode === 'normal') {
      if (!prepare && !noMerge && pinned !== basePin) git.mergeFastForward(pinned);
      const head = git.revParse('HEAD');
      if (head !== pinned) {
        throw new Error(`the working tree is at ${head} but the window was planned from ${pinned}; refusing to release a tree nobody planned`);
      }
    }

    if (mode === 'hotfix') {
      for (const fragment of plan.selected) {
        if (!fragment.commit) throw new Error(`${fragment.ref} has no "commit" field, so a hotfix cannot cherry-pick it`);
        if (git.isAncestor(fragment.commit, 'HEAD')) continue;
        git.cherryPick(fragment.commit);
      }
    }

    // The tree changed under the plan (merge or cherry-picks), so re-check the two things the plan
    // assumed about it before writing anything.
    const disk = diskSource(repoRoot);
    const current = loadManifest(disk);
    const moved = plan.plugins.filter((plugin) => current.plugins.get(plugin.name)?.version !== plugin.from);
    if (moved.length > 0) {
      throw new Error(
        `plugin versions moved after the plan was built: ${moved.map((plugin) => plugin.name).join(', ')}. ` +
        'Only a cut may write a version, so those commits must not be released this way.',
      );
    }
    const releasedNow = releasedFragmentFingerprints(readRepoChangelog(disk));
    const alreadyOut = plan.selected.filter((fragment) => releasedNow.has(fragmentFingerprint(fragment)));
    if (alreadyOut.length > 0) {
      throw new Error(`${alreadyOut.map((fragment) => fragment.ref).join(', ')} became released while this cut was building; nothing was published`);
    }

    const touched = [
      ...applyVersions(repoRoot, current, { plugins: plan.plugins, marketplaceVersion: plan.marketplace.to }),
      ...applyChangelogs(repoRoot, plan),
    ];

    const consumed = [];
    for (const fragment of plan.selected) {
      const relative = fragmentFile(fragment.ref);
      const absolute = resolveInRepo(repoRoot, relative, `fragment for ${fragment.ref}`);
      if (existsSync(absolute)) {
        rmSync(absolute);
        consumed.push(relative);
      }
    }

    const message = planCommitMessage(plan);
    git.add([...new Set([...touched, ...consumed])].sort());
    git.commit(message);
    const commit = git.revParse('HEAD');
    // A prepared window is untagged on purpose: the tag must name the commit that actually lands on
    // the publish branch, and only finalize.mjs knows that sha.
    if (!prepare) {
      git.tag(plan.tag, message, commit);
      for (const plugin of plan.plugins) {
        git.tag(`${plugin.name}-v${plugin.to}`, `${plugin.name} ${plugin.to} (${plan.tag})`, commit);
      }
    }
    plan.commit = commit;

    let marketplacePublished = false;
    try {
      const failures = [];
      const runSuite = options.runSuite ?? defaultSuiteRunner(repoRoot, { log, tag: plan.tag });
      if (!skipTests) {
        for (const suite of plan.suites) {
          const result = runSuite(suite);
          if (result.code !== 0) {
            const logNotice = result.logPath ? ` (log: ${result.logPath})` : '';
            failures.push(`${suite.plugin}: ${result.command} exited ${result.code}${logNotice}`);
          }
        }
      }
      if (failures.length > 0) {
        throw new Error(
          `release suites failed, nothing was published:\n  ${failures.join('\n  ')}`,
        );
      }
      assertReleaseIntact(git, plan, commit, { tags: !prepare });

      if (prepare) {
        const branchPush = [`${commit}:refs/heads/${preparedBranchName}`];
        let pushed = false;
        if (push) {
          git.pushAtomic(remote, branchPush);
          pushed = true;
          log(`pushed ${preparedBranchName} (${commit}); promote it with:`);
        } else {
          log(`prepared ${plan.tag} on ${preparedBranchName} as ${commit}; promote it with:`);
        }
        if (ci?.status === 'passed') log(`Test CI on ${remote}/${windowBranch} (${ci.commit}) passed.`);
        else if (ci?.status === 'overridden') log(`Test CI on ${remote}/${windowBranch} (${ci.commit}) was overridden: ${ci.reason}`);
        const promotion = promotionCommands({ remote, releaseBranch: preparedBranchName, publishBranch, tag: plan.tag, pushed });
        for (const command of promotion) log(`  ${command}`);
        return {
          status: 'prepared', plan, commit, message, pushed, releaseBranch: preparedBranchName,
          baseBranch: windowBranch, branchPush, pushCommands: promotion, touched, consumed, ci,
          githubRelease: null,
        };
      }

      const refspecs = planRefspecs(plan, commit);
      const marketplacePush = marketplaceRefspecs(plan, commit);
      const pluginPush = pluginTagRefspecs(plan);
      const pushCommands = publishCommands(plan, { remote, commit });
      let pushed = false;
      let githubRelease = null;
      if (push) {
        git.pushAtomic(remote, marketplacePush);
        marketplacePublished = true;
        if (pluginPush.length > 0) git.pushAtomic(remote, pluginPush);
        if (githubRemote) {
          const assertReleasePublished = options.assertGitHubReleasePublished
            ?? ((repoRoot, tag, releaseCommit) => assertGitHubReleasePublished(repoRoot, tag, releaseCommit));
          githubRelease = await assertReleasePublished(repoRoot, plan.tag, commit);
          if (githubRelease.status === 'deferred') log(githubRelease.message);
        }
        pushed = true;
        log(`published ${plan.tag} (${commit})`);
      } else {
        log(`built ${plan.tag} locally as ${commit}; publish it with:`);
        if (ci?.status === 'passed') {
          log(`Test CI on ${remote}/${publishBranch} (${ci.commit}) passed.`);
        } else if (ci?.status === 'overridden') {
          log(`Test CI on ${remote}/${publishBranch} (${ci.commit}) was overridden: ${ci.reason}`);
        }
        for (const command of pushCommands) log(`  ${command}`);
      }

      return {
        status: 'cut', plan, commit, message, pushed, refspecs, marketplacePush, pluginPush,
        pushCommands, touched, consumed, ci, githubRelease,
      };
    } catch (error) {
      const recovery = (rolledBack) => (prepare
        ? preparedRecoveryInstructions({ pinned, baseBranch: windowBranch, releaseBranch: preparedBranch, rolledBack })
        : releaseRecoveryInstructions(plan, basePin, remote, marketplacePublished, { rolledBack }));
      if (!marketplacePublished) {
        try {
          if (prepare) rollBackPreparedRelease(git, { pinned, baseBranch: windowBranch, releaseBranch: preparedBranch });
          else rollBackLocalReleaseWindow(git, plan, basePin);
        } catch (rollbackError) {
          throw new Error(
            `${error.message}\nAutomatic rollback failed: ${rollbackError.message}\n${recovery(false)}`,
            { cause: error },
          );
        }
      }
      throw new Error(`${error.message}\n${recovery(!marketplacePublished)}`, { cause: error });
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
      sha: { type: 'string' },
      mode: { type: 'string' },
      tickets: { type: 'string' },
      date: { type: 'string' },
      'publish-branch': { type: 'string' },
      prepare: { type: 'boolean' },
      'base-branch': { type: 'string' },
      'release-branch': { type: 'string' },
      remote: { type: 'string' },
      'dry-run': { type: 'boolean' },
      push: { type: 'boolean' },
      'skip-tests': { type: 'boolean' },
      'no-merge': { type: 'boolean' },
      'no-branch-check': { type: 'boolean' },
      'allow-dirty': { type: 'boolean' },
      force: { type: 'boolean' },
      'direct-publish': { type: 'boolean' },
      'ci-override': { type: 'string' },
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
  const result = await cut({
    repoRoot,
    mode: values.mode ?? 'normal',
    tickets: splitList(values.tickets),
    sha: values.sha ?? null,
    date: values.date ?? null,
    publishBranch: values['publish-branch'] ?? 'main',
    prepare: values.prepare === true,
    baseBranch: values['base-branch'] ?? null,
    releaseBranch: values['release-branch'] ?? null,
    remote: values.remote ?? 'origin',
    dryRun: values['dry-run'] === true,
    push: values.push === true,
    skipTests: values['skip-tests'] === true,
    noMerge: values['no-merge'] === true,
    branchCheck: values['no-branch-check'] !== true,
    allowDirty: values['allow-dirty'] === true,
    force: values.force === true,
    directPublish: values['direct-publish'] === true,
    ciOverrideReason: values['ci-override'] ?? null,
    log: values.json ? () => {} : console.log,
  });

  if (values.json) {
    console.log(JSON.stringify({
      status: result.status,
      commit: result.commit ?? null,
      pushed: result.pushed ?? false,
      pushCommand: result.pushCommand ?? null,
      pushCommands: result.pushCommands ?? [],
      releaseBranch: result.releaseBranch ?? null,
      refspecs: result.refspecs ?? [],
      ci: result.ci ?? null,
      githubRelease: result.githubRelease ?? null,
      touched: result.touched ?? [],
      consumed: result.consumed ?? [],
      plan: result.plan,
      changelog: REPO_CHANGELOG,
    }, null, 2));
  }
  return 0;
}

await runCli(import.meta.url, main);
