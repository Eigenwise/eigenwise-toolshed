#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';

import { readRepoChangelog, releasedRefs } from './lib/changelog.mjs';
import { createGit } from './lib/git.mjs';
import { buildPlan, formatPlan, planCommitMessage, planPushCommand } from './lib/plan.mjs';
import { isHeld, readFragments } from './lib/fragments.mjs';
import { checkManifest, readManifest } from './lib/manifests.mjs';
import { createSuiteResolver } from './lib/suites.mjs';
import { commitSource, diskSource } from './lib/treesource.mjs';
import { repoRootFrom, runCli, splitList, today, UsageError } from './lib/cli.mjs';

const USAGE = `Usage: node scripts/release/plan.mjs [options]

Prints exactly what a cut would do and writes nothing.

  --mode <normal|hotfix>  Window kind (default normal)
  --tickets <a,b>         Refs to release in a hotfix, each named once
  --sha <rev>             Read every input from this commit instead of the working tree
  --date <YYYY-MM-DD>     Release date (defaults to the pinned commit's date)
  --force                 Include held fragments
  --json                  Machine-readable plan
  --repo <dir>            Repository root (defaults to this script's repo)`;

/**
 * With --sha, every input comes from that commit, so the plan describes the cut that commit would
 * produce. Without it, the plan describes the working tree and says so.
 */
export function loadPlan(repoRoot, { mode = 'normal', tickets = null, sha = null, date = null, force = false, git = null } = {}) {
  let pinned = null;
  let resolvedDate = date;
  if (sha) {
    if (!git) throw new Error('--sha needs a git runner to read the pinned tree');
    pinned = git.revParse(sha);
    resolvedDate ??= git.commitDate(pinned);
  }

  const source = pinned ? commitSource(git, pinned) : diskSource(repoRoot);

  const manifest = readManifest(source, repoRoot);
  const manifestErrors = checkManifest(manifest);
  if (manifestErrors.length > 0) {
    throw new Error(`manifest versions are inconsistent, refusing to plan a release:\n  ${manifestErrors.join('\n  ')}`);
  }

  const { fragments, errors } = readFragments(source, { knownPlugins: manifest.plugins });
  if (errors.length > 0) {
    throw new Error(`invalid release fragments:\n  ${errors.map((error) => error.message).join('\n  ')}`);
  }

  const plan = buildPlan({
    fragments,
    manifest,
    mode,
    tickets,
    released: releasedRefs(readRepoChangelog(source)),
    force,
    date: resolvedDate ?? today(),
    sha: pinned,
    suiteResolver: createSuiteResolver(repoRoot),
  });

  return { plan, manifest, fragments, hold: isHeld(source) };
}

export async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      mode: { type: 'string' },
      tickets: { type: 'string' },
      sha: { type: 'string' },
      date: { type: 'string' },
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
  const mode = values.mode ?? 'normal';
  if (mode === 'hotfix' && !values.tickets) throw new UsageError('--mode hotfix needs --tickets SQ-x[,SQ-y]');

  const { plan, hold } = loadPlan(repoRoot, {
    mode,
    tickets: splitList(values.tickets),
    sha: values.sha ?? null,
    date: values.date ?? null,
    force: values.force === true,
    git: createGit({ cwd: repoRoot }),
  });

  if (values.json) {
    console.log(JSON.stringify({
      ...plan,
      hold,
      commitMessage: plan.releasable ? planCommitMessage(plan) : null,
      pushCommand: plan.releasable ? planPushCommand(plan) : null,
    }, null, 2));
    return 0;
  }

  if (hold && mode === 'normal') {
    console.log(`.release/HOLD is set, so a normal cut would stop: ${hold}`);
    console.log('');
  }
  console.log(formatPlan(plan));
  return 0;
}

await runCli(import.meta.url, main);
