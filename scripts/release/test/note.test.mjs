import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { buildFragment, main } from '../note.mjs';
import { parseFragment } from '../lib/fragments.mjs';
import { readManifest } from '../lib/manifests.mjs';
import { makeRepo } from './helpers.mjs';

const PLUGINS = { 'codex-gateway': '0.33.4', sidequest: '3.6.49', workbench: '0.63.11' };

function setup(t, options = {}) {
  const repo = makeRepo({ plugins: PLUGINS, ...options });
  t.after(repo.cleanup);
  return { root: repo.root, manifest: readManifest(repo.root) };
}

test('a fragment is written in the format the reader accepts', (t) => {
  const { manifest } = setup(t);
  const { text, file, fragment } = buildFragment({
    manifest,
    input: { ref: 'SQ-843', title: 'Build the release engine', plugins: ['sidequest'], bump: 'minor', commit: 'c7b2702' },
  });

  assert.equal(file, '.release/unreleased/SQ-843.md');
  assert.equal(fragment.ref, 'SQ-843');
  assert.deepEqual(fragment.plugins, [{ name: 'sidequest', level: 'minor' }]);
  assert.match(text, /^ref: SQ-843$/m);
  assert.match(text, /^bump: minor$/m);
  assert.match(text, /^plugins: \[sidequest\]$/m);
  assert.deepEqual(parseFragment(file, text, { knownPlugins: manifest.plugins }).plugins, fragment.plugins);
});

test('plugins are inferred from the paths a ticket changed', (t) => {
  const { manifest } = setup(t);
  const { fragment } = buildFragment({
    manifest,
    input: {
      ref: 'SQ-1',
      title: 't',
      bump: 'patch',
      changed: [
        'plugins/sidequest/src/lib/board.ts',
        'plugins/sidequest/test/board.test.ts',
        'plugins\\workbench\\hooks\\freshness.js',
        'plugins/test-support/index.js',
        'docs/src/content/docs/x.md',
      ],
    },
  });
  assert.deepEqual(fragment.plugins.map((entry) => entry.name), ['sidequest', 'workbench'], 'unpublished plugins are not released');
});

test('a per-plugin level beats the fragment default', (t) => {
  const { manifest } = setup(t);
  const { fragment } = buildFragment({
    manifest,
    input: { ref: 'SQ-1', title: 't', plugins: ['sidequest', 'workbench'], bump: 'patch', levels: { sidequest: 'minor' } },
  });
  assert.deepEqual(fragment.plugins, [
    { name: 'sidequest', level: 'minor' },
    { name: 'workbench', level: 'patch' },
  ]);
});

test('a fragment with nothing to release is refused, not invented', (t) => {
  const { manifest } = setup(t);
  const cases = [
    [{ title: 't', plugins: ['sidequest'], bump: 'patch' }, /board ref is required/],
    [{ ref: 'SQ-1', title: 't', bump: 'patch', changed: ['docs/x.md'] }, /no plugins for SQ-1/],
    [{ ref: 'SQ-1', title: 't', plugins: ['sidequest'] }, /no bump level for sidequest/],
    [{ ref: 'SQ-1', plugins: ['sidequest'], bump: 'patch' }, /no title for SQ-1/],
    [{ ref: 'SQ-1', title: 't', plugins: ['ghost'], bump: 'patch' }, /not published/],
  ];
  for (const [input, pattern] of cases) {
    assert.throws(() => buildFragment({ manifest, input }), pattern, JSON.stringify(input));
  }
});

test('a board export supplies the fields and the CLI overrides them', async (t) => {
  const context = setup(t);
  t.mock.method(console, 'log', () => {});

  const exportPath = path.join(context.root, 'ticket.json');
  writeFileSync(exportPath, JSON.stringify({
    ref: 'SQ-834',
    title: 'Harden shared-tree recovery',
    categoryId: 'coding.normal',
    submission: { commit: 'fdfdb8f3c049e962652970899998538bfcb882d2' },
    changedPaths: ['plugins/sidequest/src/lib/publish.ts'],
  }));

  assert.equal(await main(['--from-json', exportPath, '--bump', 'patch', '--repo', context.root]), 0);

  const written = readFileSync(path.join(context.root, '.release/unreleased/SQ-834.md'), 'utf8');
  const fragment = parseFragment('.release/unreleased/SQ-834.md', written, { knownPlugins: context.manifest.plugins });
  assert.equal(fragment.title, 'Harden shared-tree recovery');
  assert.equal(fragment.commit, 'fdfdb8f3c049e962652970899998538bfcb882d2');
  assert.equal(fragment.category, 'coding.normal');
  assert.deepEqual(fragment.plugins, [{ name: 'sidequest', level: 'patch' }]);

  await assert.rejects(
    () => main(['--from-json', exportPath, '--bump', 'patch', '--repo', context.root]),
    /already exists/,
  );
  assert.equal(await main(['--from-json', exportPath, '--bump', 'minor', '--repo', context.root, '--force']), 0);
  assert.match(readFileSync(path.join(context.root, '.release/unreleased/SQ-834.md'), 'utf8'), /^bump: minor$/m);
});

test('a dry run prints the fragment and writes nothing', async (t) => {
  const context = setup(t);
  const printed = [];
  t.mock.method(console, 'log', (line) => printed.push(line));

  await main(['SQ-9', '--title', 'A title', '--plugins', 'workbench', '--bump', 'patch', '--dry-run', '--repo', context.root]);

  assert.equal(existsSync(path.join(context.root, '.release/unreleased/SQ-9.md')), false);
  assert.match(printed.join('\n'), /^ref: SQ-9$/m);
});

test('a held fragment records that it is held', (t) => {
  const { manifest } = setup(t);
  const { text } = buildFragment({
    manifest,
    input: { ref: 'SQ-1', title: 't', plugins: ['sidequest'], bump: 'patch', hold: true, body: 'Waiting on the docs.' },
  });
  assert.match(text, /^hold: true$/m);
  assert.match(text, /Waiting on the docs\./);
});
