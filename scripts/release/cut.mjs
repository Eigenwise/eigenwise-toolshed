#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { applyChangelogs, readRepoChangelog, releasedRefs, REPO_CHANGELOG } from './lib/changelog.mjs';
import { createGit } from './lib/git.mjs';
import { fragmentFile, FRAGMENT_DIR, HOLD_FILE, isHeld, parseFragment, readFragments } from './lib/fragments.mjs';
import { applyVersions, checkManifest, readManifest } from './lib/manifests.mjs';
import { buildPlan, formatPlan, planCommitMessage, planPushCommand } from './lib/plan.mjs';
import { createSuiteResolver } from './lib/suites.mjs';
import { repoRootFrom, runCli, splitList, UsageError } from './lib/cli.mjs';

const USAGE = `Usage: node scripts/release/cut.mjs [options]

Builds a release window in the working tree and stops just short of publishing it. Everything is
local until --push, and the publish itself is a single atomic ref update.

  --sha <rev>              Pin the window to this commit (default HEAD)
  --mode <normal|hotfix>   Window kind (default normal)
  --tickets <a,b>          Refs to release in a hotfix
  --date <YYYY-MM-DD>      Release date (defaults to the pinned commit's date)
  --publish-branch <name>  Branch the release lands on (default main)
  --remote <name>          Remote to publish to (default origin)
  --dry-run                Plan only: no file writes, no git mutations
  --push                   Run the atomic push instead of only printing it
  --skip-tests             Do not run the changed plugins' suites
  --no-merge               The tree is already prepared; skip the fast-forward merge
  --no-branch-check        Allow cutting from a branch other than --publish-branch
  --allow-dirty            Proceed with uncommitted changes in the tree
  --force                  Override .release/HOLD, held fragments, and existing tags
  --json                   Machine-readable result
  --repo <dir>             Repository root (defaults to this script's repo)`;

export function defaultSuiteRunner(repoRoot, { log = console.log } = {}) {
  return (suite) => {
    const command = suite.setup ? `${suite.setup} && ${suite.command}` : suite.command;
    log(`running ${suite.plugin}: ${command}`);
    const result = spawnSync(command, {
      cwd: path.join(repoRoot, suite.cwd),
      shell: true,
      stdio: 'inherit',
      windowsHide: true,
    });
    return { code: result.status ?? 1, command };
  };
}

function fragmentsFromCommit(git, pinned, knownPlugins) {
  const files = git.listFiles(pinned, FRAGMENT_DIR).filter((file) => file.endsWith('.md'));
  const fragments = [];
  for (const file of files) {
    const text = git.showFile(pinned, file);
    if (text !== null) fragments.push(parseFragment(file, text, { knownPlugins }));
  }
  return fragments;
}

function assertNoStaleTags(git, plan, { remote, checkRemote, force }) {
  const existing = new Set(git.localTags());
  if (checkRemote) for (const tag of git.remoteTags(remote)) existing.add(tag);
  const clashes = plan.tags.filter((tag) => existing.has(tag));
  if (clashes.length === 0) return;
  if (force) return;
  throw new Error(
    `these tags already exist, so this window was published (or half-published) before: ${clashes.join(', ')}. ` +
    'Cut a new window instead of moving a tag; --force only if you know the tag is a local leftover.',
  );
}

/**
 * Builds the whole release locally, then publishes it with one atomic ref update. Everything
 * before that push is disposable: a failure leaves no tag, no release commit on the remote, and
 * the fragments still queued for the next window.
 */
export async function cut(options = {}) {
  const {
    repoRoot,
    mode = 'normal',
    tickets = null,
    sha = null,
    date = null,
    publishBranch = 'main',
    integrationBranch = 'dev',
    remote = 'origin',
    dryRun = false,
    push = false,
    skipTests = false,
    noMerge = false,
    branchCheck = true,
    allowDirty = false,
    force = false,
    log = console.log,
  } = options;

  if (!repoRoot) throw new UsageError('cut() needs a repoRoot');
  const git = options.git ?? createGit({ cwd: repoRoot, dryRun });
  const runSuite = options.runSuite ?? defaultSuiteRunner(repoRoot, { log });

  const loadManifest = () => {
    const loaded = readManifest(repoRoot);
    const errors = checkManifest(loaded);
    if (errors.length > 0) {
      throw new Error(`manifest versions are inconsistent, refusing to cut:\n  ${errors.join('\n  ')}`);
    }
    return loaded;
  };

  const pinned = git.revParse(sha ?? 'HEAD');
  if (!allowDirty && !git.isClean()) {
    throw new Error('the working tree has uncommitted changes; cut from a clean checkout or pass --allow-dirty');
  }
  if (branchCheck) {
    const branch = git.currentBranch();
    if (branch !== publishBranch) {
      throw new Error(`cutting from "${branch}" but the release lands on "${publishBranch}"; check out ${publishBranch} or pass --no-branch-check`);
    }
  }

  if (mode === 'normal' && !force) {
    const heldByTree = isHeld(repoRoot);
    const heldAtPin = git.showFile(pinned, HOLD_FILE);
    const reason = heldByTree ?? (heldAtPin === null ? null : heldAtPin.trim() || 'no reason given');
    if (reason !== null) {
      log(`release held by ${HOLD_FILE}: ${reason}`);
      return { status: 'held', reason, plan: null };
    }
  }

  if (mode === 'hotfix' && (!tickets || tickets.length === 0)) {
    throw new UsageError('--mode hotfix needs --tickets SQ-x[,SQ-y]');
  }
  const merging = mode === 'normal' && !dryRun && !noMerge;
  if (merging) git.mergeFastForward(pinned);

  // Read after the merge: a fast-forward moves the very manifests this cut is about to rewrite.
  let manifest = loadManifest();
  const released = releasedRefs(readRepoChangelog(repoRoot));

  const fragmentsOnDisk = () => {
    const { fragments: onDisk, errors } = readFragments(repoRoot, { knownPlugins: manifest.plugins });
    if (errors.length > 0) throw new Error(`invalid release fragments:\n  ${errors.map((error) => error.message).join('\n  ')}`);
    return onDisk;
  };

  let fragments;
  if (merging) {
    fragments = fragmentsOnDisk();
  } else {
    const fromCommit = fragmentsFromCommit(git, pinned, manifest.plugins);
    fragments = fromCommit.length > 0 || mode === 'hotfix' ? fromCommit : fragmentsOnDisk();
  }

  const plan = buildPlan({
    fragments,
    manifest,
    mode,
    tickets,
    released,
    force,
    date: date ?? git.commitDate(pinned),
    sha: pinned,
    publishBranch,
    suiteResolver: createSuiteResolver(repoRoot),
  });

  if (!plan.releasable) {
    log('nothing to release: no selected fragments in .release/unreleased/');
    return { status: 'nothing-to-release', plan };
  }

  assertNoStaleTags(git, plan, { remote, checkRemote: push, force });

  if (dryRun) {
    log(formatPlan(plan));
    return { status: 'dry-run', plan, pushCommand: planPushCommand(plan, { remote }) };
  }

  if (mode === 'hotfix') {
    for (const fragment of plan.selected) {
      if (!fragment.commit) throw new Error(`${fragment.ref} has no "commit" field, so a hotfix cannot cherry-pick it`);
      if (git.isAncestor(fragment.commit, 'HEAD')) continue;
      git.cherryPick(fragment.commit);
    }
    manifest = loadManifest();
    const moved = plan.plugins.filter((plugin) => manifest.plugins.get(plugin.name)?.version !== plugin.from);
    if (moved.length > 0) {
      throw new Error(
        `cherry-picking moved plugin versions, which only a cut may do: ${moved.map((plugin) => plugin.name).join(', ')}. ` +
        'Those commits carry a version bump and must not be hotfixed directly.',
      );
    }
  }

  const touched = [
    ...applyVersions(repoRoot, manifest, {
      plugins: new Map(plan.plugins.map((plugin) => [plugin.name, plugin.to])),
      marketplaceVersion: plan.marketplace.to,
    }),
    ...applyChangelogs(repoRoot, plan),
  ];

  const consumed = [];
  for (const fragment of plan.selected) {
    const relative = fragmentFile(fragment.ref);
    const absolute = path.join(repoRoot, relative);
    if (existsSync(absolute)) {
      rmSync(absolute);
      consumed.push(relative);
    }
  }

  const message = planCommitMessage(plan);
  git.add([...new Set([...touched, ...consumed])].sort());
  git.commit(message);
  git.tag(plan.tag, message);
  for (const plugin of plan.plugins) {
    git.tag(`${plugin.name}-v${plugin.to}`, `${plugin.name} ${plugin.to} (${plan.tag})`);
  }

  const failures = [];
  if (!skipTests) {
    for (const suite of plan.suites) {
      const result = runSuite(suite);
      if (result.code !== 0) failures.push(`${suite.plugin}: ${result.command} exited ${result.code}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `release suites failed, nothing was published:\n  ${failures.join('\n  ')}\n` +
      `The release commit and tags are local only. Fix on ${integrationBranch}, then let the next window pick it up.`,
    );
  }

  const commit = git.revParse('HEAD');
  const pushCommand = planPushCommand(plan, { remote });
  let pushed = false;
  if (push) {
    git.pushAtomic(remote, [`HEAD:${publishBranch}`, ...plan.tags]);
    pushed = true;
    log(`published ${plan.tag} (${commit})`);
    log(`now restore the invariant: git push ${remote} HEAD:${integrationBranch}`);
  } else {
    log(`built ${plan.tag} locally as ${commit}; publish it with:`);
    log(`  ${pushCommand}`);
  }

  return { status: 'cut', plan, commit, message, pushed, pushCommand, touched, consumed };
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
      'integration-branch': { type: 'string' },
      remote: { type: 'string' },
      'dry-run': { type: 'boolean' },
      push: { type: 'boolean' },
      'skip-tests': { type: 'boolean' },
      'no-merge': { type: 'boolean' },
      'no-branch-check': { type: 'boolean' },
      'allow-dirty': { type: 'boolean' },
      force: { type: 'boolean' },
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
    integrationBranch: values['integration-branch'] ?? 'dev',
    remote: values.remote ?? 'origin',
    dryRun: values['dry-run'] === true,
    push: values.push === true,
    skipTests: values['skip-tests'] === true,
    noMerge: values['no-merge'] === true,
    branchCheck: values['no-branch-check'] !== true,
    allowDirty: values['allow-dirty'] === true,
    force: values.force === true,
    log: values.json ? () => {} : console.log,
  });

  if (values.json) {
    console.log(JSON.stringify({
      status: result.status,
      commit: result.commit ?? null,
      pushed: result.pushed ?? false,
      pushCommand: result.pushCommand ?? null,
      touched: result.touched ?? [],
      consumed: result.consumed ?? [],
      plan: result.plan,
      changelog: REPO_CHANGELOG,
    }, null, 2));
  }
  return 0;
}

await runCli(import.meta.url, main);
