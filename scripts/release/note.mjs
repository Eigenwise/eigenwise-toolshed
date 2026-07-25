#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { fragmentFile, parseFragment, renderFragment, writeFragment } from './lib/fragments.mjs';
import { readManifest } from './lib/manifests.mjs';
import { LEVELS } from './lib/semver.mjs';
import { repoRootFrom, runCli, splitList, UsageError } from './lib/cli.mjs';

const USAGE = `Usage: node scripts/release/note.mjs <REF> --bump <${LEVELS.join('|')}> [--plugins a,b] [options]

Writes one release fragment to .release/unreleased/<REF>.md. Run it at integration time, in the
same push as the ticket's code, so the release cut can see what shipped.

  --title <text>       Ticket title (defaults to the board export's title)
  --plugins <a,b>      Plugins this ticket releases; omit to infer from --changed
  --bump <level>       ${LEVELS.join(' | ')} (applies to every named plugin)
  --level <p=level>    Per-plugin override, repeatable (e.g. --level workbench=patch)
  --commit <sha>       Integration commit, linked from the changelog
  --changed <paths>    Changed paths used to infer --plugins
  --body <text>        Extra detail rendered under the changelog entry
  --hold               Keep this fragment out of normal windows until it is unheld
  --from-json <file>   Read a board ticket export ("-" for stdin); flags win over its fields
  --force              Overwrite an existing fragment
  --dry-run            Print the fragment instead of writing it
  --json               Print the written path and parsed fragment as JSON
  --repo <dir>         Repository root (defaults to this script's repo)`;

function readJsonInput(source) {
  const text = source === '-' ? readFileSync(0, 'utf8') : readFileSync(source, 'utf8');
  const data = JSON.parse(text);
  return data?.ticket ?? data;
}

function inferPlugins(changed, knownPlugins) {
  const found = new Set();
  for (const file of changed) {
    const match = /^plugins\/([^/]+)\//.exec(file.replaceAll('\\', '/').replace(/^\.\//, ''));
    if (match && knownPlugins.has(match[1])) found.add(match[1]);
  }
  return [...found].sort();
}

export function buildFragment({ input = {}, manifest }) {
  const ref = input.ref;
  if (!ref) throw new UsageError('a board ref is required (e.g. SQ-843)');

  const changed = input.changed ?? [];
  const names = input.plugins ?? (changed.length > 0 ? inferPlugins(changed, manifest.plugins) : null);
  if (!names || names.length === 0) {
    throw new UsageError(`no plugins for ${ref}: pass --plugins, or --changed with paths under plugins/<name>/`);
  }

  const levels = input.levels ?? {};
  const plugins = names.map((name) => ({ name, level: levels[name] ?? input.bump ?? null }));
  const missing = plugins.filter((entry) => entry.level === null).map((entry) => entry.name);
  if (missing.length > 0) {
    throw new UsageError(`no bump level for ${missing.join(', ')}: pass --bump ${LEVELS.join('|')} or --level <plugin>=<level>`);
  }

  const draft = {
    ref,
    title: input.title ?? null,
    plugins,
    commit: input.commit ?? null,
    hold: input.hold === true,
    category: input.category ?? null,
    story: input.story ?? null,
    body: input.body ?? '',
  };
  if (!draft.title) throw new UsageError(`no title for ${ref}: pass --title or a board export that has one`);

  const file = fragmentFile(ref);
  const text = renderFragment(draft);
  return { text, file, fragment: parseFragment(file, text, { knownPlugins: manifest.plugins }) };
}

function collectInput(values, positionals) {
  const exported = values['from-json'] ? readJsonInput(values['from-json']) : {};

  const levels = {};
  for (const pair of values.level ?? []) {
    const [name, level] = pair.split('=');
    if (!name || !level) throw new UsageError(`--level expects <plugin>=<level>, got "${pair}"`);
    levels[name.trim()] = level.trim();
  }
  if (exported.plugins && !Array.isArray(exported.plugins) && typeof exported.plugins === 'object') {
    Object.assign(levels, exported.plugins);
  }

  const exportedPlugins = Array.isArray(exported.plugins)
    ? exported.plugins
    : exported.plugins && typeof exported.plugins === 'object'
      ? Object.keys(exported.plugins)
      : null;

  return {
    ref: positionals[0] ?? exported.ref ?? null,
    title: values.title ?? exported.title ?? null,
    plugins: splitList(values.plugins) ?? exportedPlugins,
    levels,
    bump: values.bump ?? exported.bump ?? null,
    commit: values.commit ?? exported.submission?.commit ?? exported.commit ?? null,
    changed: splitList(values.changed) ?? exported.changedPaths ?? exported.files ?? [],
    body: values.body ?? exported.body ?? '',
    hold: values.hold === true || exported.hold === true,
    category: exported.category ?? exported.categoryId ?? null,
    story: exported.story ?? null,
  };
}

export async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      title: { type: 'string' },
      plugins: { type: 'string' },
      bump: { type: 'string' },
      level: { type: 'string', multiple: true },
      commit: { type: 'string' },
      changed: { type: 'string' },
      body: { type: 'string' },
      hold: { type: 'boolean' },
      'from-json': { type: 'string' },
      force: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
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
  const manifest = readManifest(repoRoot);
  const { text, file, fragment } = buildFragment({ input: collectInput(values, positionals), manifest });

  if (values['dry-run']) {
    console.log(values.json ? JSON.stringify({ file, fragment }, null, 2) : text);
    return 0;
  }

  const written = writeFragment(repoRoot, fragment, { force: values.force === true });
  console.log(values.json ? JSON.stringify({ file: written, fragment }, null, 2) : `wrote ${written}`);
  return 0;
}

await runCli(import.meta.url, main);
