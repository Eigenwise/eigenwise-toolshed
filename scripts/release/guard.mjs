#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { readRepoChangelog, releasedRefs, REPO_CHANGELOG } from './lib/changelog.mjs';
import { createGit } from './lib/git.mjs';
import { fragmentFile, readFragments } from './lib/fragments.mjs';
import { checkManifest, MARKETPLACE_PATH, readManifest } from './lib/manifests.mjs';
import { readValue } from './lib/jsonedit.mjs';
import { repoRootFrom, runCli, splitList } from './lib/cli.mjs';

const MODES = ['fragments', 'dev', 'main'];

const USAGE = `Usage: node scripts/release/guard.mjs [--mode ${MODES.join('|')}] [options]

Fails when the tree breaks a release invariant. Safe to run anywhere: it reads, never writes.

  --mode <${MODES.join('|')}>   How strict to be (default dev)
  --publish-ref <rev>          Compare versions against this ref (e.g. origin/main)
  --default-branch <name>      The repository's default branch, asserted to be the publish branch
  --publish-branch <name>      Branch the marketplace serves (default main)
  --changed <paths>            Changed paths to check fragment coverage against
  --changed-file <path>        Read changed paths from a file, one per line ("-" for stdin)
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

export function runGuard(repoRoot, {
  mode = 'dev',
  publishRef = null,
  defaultBranch = null,
  publishBranch = 'main',
  changed = null,
  git = null,
} = {}) {
  const failures = [];
  const notes = [];
  const fail = (message) => failures.push(message);

  if (!MODES.includes(mode)) {
    fail(`unknown --mode "${mode}" (expected ${MODES.join(', ')})`);
    return { ok: false, mode, failures, notes };
  }

  const manifest = readManifest(repoRoot);
  for (const error of checkManifest(manifest)) fail(error);

  const { fragments, errors } = readFragments(repoRoot, { knownPlugins: manifest.plugins });
  for (const error of errors) fail(error.message);

  const released = releasedRefs(readRepoChangelog(repoRoot));
  for (const fragment of fragments) {
    if (released.has(fragment.ref)) {
      fail(`${fragmentFile(fragment.ref)} is still queued but ${fragment.ref} already has a ${REPO_CHANGELOG} entry; a cut would release it twice`);
    }
  }

  if (defaultBranch !== null && defaultBranch !== publishBranch) {
    fail(`the repository default branch is "${defaultBranch}" but the marketplace must serve "${publishBranch}"; a fresh install follows the default branch`);
  }

  if (publishRef && git) {
    const marketplaceAtRef = git.showFile(publishRef, MARKETPLACE_PATH);
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
      if (mode === 'main' && changed) {
        const bumped = new Set();
        for (const entry of published.plugins ?? []) {
          const plugin = manifest.plugins.get(entry.name);
          if (plugin && plugin.version !== entry.version) bumped.add(entry.name);
        }
        for (const name of new Set(changed.map((file) => pluginOf(file, manifest)).filter(Boolean))) {
          if (!bumped.has(name)) {
            fail(`"${name}" changed on ${publishBranch} without a version bump, so no installed copy will ever re-extract it`);
          }
        }
        if (bumped.size > 0 && !changed.includes(REPO_CHANGELOG)) {
          fail(`versions moved (${[...bumped].sort().join(', ')}) without touching ${REPO_CHANGELOG}; releases are generated, not hand-edited`);
        }
      }
    }
  } else if (publishRef) {
    notes.push('--publish-ref was given without a git runner, so version drift was not checked');
  }

  if (changed) {
    const covered = new Set(fragments.flatMap((fragment) => fragment.plugins.map((entry) => entry.name)));
    const uncovered = new Set();
    for (const file of changed) {
      if (file.endsWith('/CHANGELOG.md')) continue;
      const name = pluginOf(file, manifest);
      if (name && !covered.has(name)) uncovered.add(name);
    }
    for (const name of [...uncovered].sort()) {
      fail(`"${name}" changed with no fragment naming it; run node scripts/release/note.mjs <REF> --plugins ${name} --bump <level> so the change gets released`);
    }
  }

  return { ok: failures.length === 0, mode, failures, notes, fragments: fragments.length };
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

  const result = runGuard(repoRoot, {
    mode: values.mode ?? 'dev',
    publishRef: values['publish-ref'] ?? null,
    defaultBranch: values['default-branch'] ?? null,
    publishBranch: values['publish-branch'] ?? 'main',
    changed: changed ? normalizePaths(changed) : null,
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
