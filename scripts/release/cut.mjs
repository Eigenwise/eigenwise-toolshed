#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { applyChangelogs, readRepoChangelog, releasedRefs, REPO_CHANGELOG } from './lib/changelog.mjs';
import { createGit } from './lib/git.mjs';
import { fragmentFile, HOLD_FILE, isHeld, readFragments } from './lib/fragments.mjs';
import { applyVersions, checkManifest, readManifest } from './lib/manifests.mjs';
import { resolveInRepo } from './lib/paths.mjs';
import { buildPlan, formatPlan, planCommitMessage, planPushCommand, planRefspecs } from './lib/plan.mjs';
import { createSuiteResolver } from './lib/suites.mjs';
import { commitSource, diskSource } from './lib/treesource.mjs';
import { repoRootFrom, runCli, splitList, UsageError } from './lib/cli.mjs';

const USAGE = `Usage: node scripts/release/cut.mjs [options]

Builds a release window in the working tree and stops just short of publishing it. Everything is
local until --push, and the publish itself is a single atomic ref update of the exact commit whose
suites passed.

  --sha <rev>              Pin the window to this commit (default HEAD). Every input is read from it
  --mode <normal|hotfix>   Window kind (default normal)
  --tickets <a,b>          Refs to release in a hotfix, each named once
  --date <YYYY-MM-DD>      Release date (defaults to the pinned commit's date)
  --publish-branch <name>  Branch the release lands on (default main)
  --remote <name>          Remote to publish to (default origin)
  --dry-run                Plan only: no file writes, no git mutations
  --push                   Run the atomic push instead of only printing it
  --skip-tests             Do not run the changed plugins' suites
  --no-merge               The tree is already prepared; skip the fast-forward merge
  --no-branch-check        Allow cutting from a branch other than --publish-branch
  --allow-dirty            Tolerate unstaged or untracked files (staged changes are never allowed)
  --force                  Override .release/HOLD, held fragments, and existing tags
  --json                   Machine-readable result
  --repo <dir>             Repository root (defaults to this script's repo)`;

// Anything that lets a suite authenticate to a remote, or reconfigure git underneath the engine,
// is removed before the suite runs. The engine still re-verifies every ref afterwards, because
// stripping credentials is a reduction in reach, not a proof.
const SUITE_CREDENTIAL_DENYLIST = [
  'GITHUB_TOKEN', 'GH_TOKEN', 'GH_ENTERPRISE_TOKEN', 'RELEASE_TOKEN', 'GITHUB_ACTIONS_TOKEN',
  'NPM_TOKEN', 'NODE_AUTH_TOKEN', 'NPM_CONFIG__AUTH', 'NPM_CONFIG__AUTHTOKEN',
  'GIT_ASKPASS', 'SSH_ASKPASS', 'SSH_AUTH_SOCK', 'GIT_SSH', 'GIT_SSH_COMMAND',
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'GITLAB_TOKEN', 'CI_JOB_TOKEN',
];

export function suiteEnvironment(base = process.env) {
  const env = { ...base };
  for (const name of SUITE_CREDENTIAL_DENYLIST) delete env[name];
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
 * The release commit and its tags are the verified artefact. Suites run arbitrary repository code,
 * so nothing they could have done to the local refs is allowed to reach the remote.
 */
function assertReleaseIntact(git, plan, commit) {
  const head = git.revParse('HEAD');
  if (head !== commit) {
    throw new Error(`HEAD moved from the verified release commit ${commit} to ${head} while the suites ran; nothing was published`);
  }
  const staged = git.stagedFiles();
  if (staged.length > 0) {
    throw new Error(`the suites left staged changes (${staged.slice(0, 5).join(', ')}); the verified release commit is no longer what the tree says, nothing was published`);
  }
  for (const tag of plan.tags) {
    const target = git.tagTarget(tag);
    if (target !== commit) {
      throw new Error(`tag ${tag} points at ${target ?? 'nothing'} instead of the verified release commit ${commit}; nothing was published`);
    }
  }
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
    if (branch !== publishBranch) {
      throw new Error(`cutting from "${branch}" but the release lands on "${publishBranch}"; check out ${publishBranch} or pass --no-branch-check`);
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
    throw new Error(`${publishBranch} (${basePin}) is not an ancestor of the pin ${pinned}, so this window could not fast-forward; choose a pin descended from ${publishBranch}`);
  }

  const manifest = loadManifest(baseSource);
  const released = releasedRefs(readRepoChangelog(baseSource));
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

  assertNoStaleTags(git, plan, { remote, checkRemote: push, force });

  if (dryRun) {
    log(formatPlan(plan));
    return { status: 'dry-run', plan, pushCommand: planPushCommand(plan, { remote }) };
  }

  // The plan was read from the pin, so the tree the writes land on has to BE the pin.
  if (mode === 'normal') {
    if (!noMerge && pinned !== basePin) git.mergeFastForward(pinned);
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
  const releasedNow = releasedRefs(readRepoChangelog(disk));
  const alreadyOut = plan.selected.filter((fragment) => releasedNow.has(fragment.ref));
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
  git.tag(plan.tag, message);
  for (const plugin of plan.plugins) {
    git.tag(`${plugin.name}-v${plugin.to}`, `${plugin.name} ${plugin.to} (${plan.tag})`);
  }
  plan.commit = commit;

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
      `release suites failed, nothing was published:\n  ${failures.join('\n  ')}\n` +
      'The release commit and tags are local only. Fix the failing suite, then rerun the release window.',
    );
  }
  assertReleaseIntact(git, plan, commit);

  const refspecs = planRefspecs(plan, commit);
  const pushCommand = planPushCommand(plan, { remote, commit });
  let pushed = false;
  if (push) {
    git.pushAtomic(remote, refspecs);
    pushed = true;
    log(`published ${plan.tag} (${commit})`);
  } else {
    log(`built ${plan.tag} locally as ${commit}; publish it with:`);
    log(`  ${pushCommand}`);
  }

  return { status: 'cut', plan, commit, message, pushed, pushCommand, refspecs, touched, consumed };
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
      refspecs: result.refspecs ?? [],
      touched: result.touched ?? [],
      consumed: result.consumed ?? [],
      plan: result.plan,
      changelog: REPO_CHANGELOG,
    }, null, 2));
  }
  return 0;
}

await runCli(import.meta.url, main);
