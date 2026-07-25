import assert from 'node:assert/strict';
import test from 'node:test';

import { FragmentError, parseFragment, readFragments, renderFragment, writeFragment } from '../lib/fragments.mjs';
import { diskSource } from '../lib/treesource.mjs';
import { fragmentText, makeRepo } from './helpers.mjs';

const KNOWN = new Map([['sidequest', {}], ['workbench', {}], ['live-rules', {}]]);

function parse(ref, options) {
  return parseFragment(`.release/unreleased/${ref}.md`, fragmentText(ref, options), { knownPlugins: KNOWN });
}

test('a list of plugins inherits the fragment bump', () => {
  const fragment = parse('SQ-843', { plugins: ['sidequest', 'workbench'], bump: 'minor', commit: 'c7b2702' });
  assert.deepEqual(fragment.plugins, [
    { name: 'sidequest', level: 'minor' },
    { name: 'workbench', level: 'minor' },
  ]);
  assert.equal(fragment.hold, false);
  assert.equal(fragment.commit, 'c7b2702');
});

test('a map gives each plugin its own level', () => {
  const fragment = parse('SQ-843', { plugins: { sidequest: 'minor', workbench: 'patch' } });
  assert.deepEqual(fragment.plugins, [
    { name: 'sidequest', level: 'minor' },
    { name: 'workbench', level: 'patch' },
  ]);
});

test('a map entry with no level falls back to bump', () => {
  const text = '---\nref: SQ-1\ntitle: t\nbump: patch\nplugins:\n  sidequest:\n---\n';
  assert.deepEqual(parseFragment('.release/unreleased/SQ-1.md', text, { knownPlugins: KNOWN }).plugins, [
    { name: 'sidequest', level: 'patch' },
  ]);
});

test('malformed fragments are rejected one reason at a time', () => {
  const cases = [
    [{ plugins: ['sidequest'] }, /needs a "bump" level/],
    [{ plugins: [], bump: 'patch' }, /is empty/],
    [{ plugins: ['sidequest'], bump: 'huge' }, /not one of patch, minor, major/],
    [{ plugins: { sidequest: 'huge' } }, /expected one of patch, minor, major/],
    [{ plugins: ['sidequest', 'sidequest'], bump: 'patch' }, /listed twice/],
    [{ plugins: ['nope'], bump: 'patch' }, /not published in \.claude-plugin\/marketplace\.json/],
    [{ plugins: ['sidequest'], bump: 'patch', commit: 'nothex' }, /not a 7-40 character lowercase hex sha/],
    [{ plugins: ['sidequest'], bump: 'patch', extra: 'plugn: sidequest' }, /unknown field "plugn"/],
  ];
  for (const [options, pattern] of cases) {
    assert.throws(() => parse('SQ-1', options), pattern, `expected ${JSON.stringify(options)} to be rejected`);
  }
});

test('the filename has to match the ref', () => {
  assert.throws(
    () => parseFragment('.release/unreleased/SQ-2.md', fragmentText('SQ-1', { plugins: ['sidequest'], bump: 'patch' }), { knownPlugins: KNOWN }),
    /filename must be "SQ-1\.md"/,
  );
  assert.throws(
    () => parseFragment('.release/unreleased/sq-1.md', fragmentText('sq-1', { plugins: ['sidequest'], bump: 'patch' }), { knownPlugins: KNOWN }),
    /does not look like a board ref/,
  );
});

test('missing required fields name themselves', () => {
  assert.throws(
    () => parseFragment('.release/unreleased/SQ-1.md', '---\nref: SQ-1\ntitle: t\n---\n', { knownPlugins: KNOWN }),
    /missing required field "plugins"/,
  );
  assert.throws(
    () => parseFragment('.release/unreleased/SQ-1.md', '---\nref: SQ-1\nplugins: [sidequest]\nbump: patch\n---\n', { knownPlugins: KNOWN }),
    /missing required field "title"/,
  );
});

test('reading a directory collects every failure instead of stopping at the first', (t) => {
  const repo = makeRepo({
    plugins: { sidequest: '3.6.49', workbench: '0.63.11' },
    fragments: { 'SQ-1': { plugins: ['sidequest'], bump: 'patch' } },
    rawFragments: {
      'SQ-2.md': '---\nref: SQ-2\ntitle: t\nplugins: [ghost]\nbump: patch\n---\n',
      'SQ-3.md': 'no frontmatter at all\n',
      'notes.txt': 'stray file',
    },
  });
  t.after(repo.cleanup);

  const { fragments, errors } = readFragments(diskSource(repo.root), { knownPlugins: new Map([['sidequest', {}], ['workbench', {}]]) });
  assert.deepEqual(fragments.map((fragment) => fragment.ref), ['SQ-1']);
  assert.equal(errors.length, 3);
  assert.ok(errors.every((error) => error instanceof FragmentError));
  assert.match(errors.map((error) => error.message).join('\n'), /ghost/);
  assert.match(errors.map((error) => error.message).join('\n'), /must be \.md files/);
});

test('a second file claiming the same ref cannot get past the filename rule', (t) => {
  const repo = makeRepo({
    rawFragments: {
      'SQ-9.md': fragmentText('SQ-9', { plugins: ['sidequest'], bump: 'patch' }),
      'SQ-9.copy.md': fragmentText('SQ-9', { plugins: ['sidequest'], bump: 'minor' }),
    },
  });
  t.after(repo.cleanup);

  const { errors } = readFragments(diskSource(repo.root), { knownPlugins: new Map([['sidequest', {}]]) });
  assert.match(errors.map((error) => error.message).join('\n'), /filename must be "SQ-9\.md"/);
});

test('fragments sort by ref number, not by string', (t) => {
  const repo = makeRepo({
    fragments: {
      'SQ-9': { plugins: ['sidequest'], bump: 'patch' },
      'SQ-10': { plugins: ['sidequest'], bump: 'patch' },
      'SQ-100': { plugins: ['sidequest'], bump: 'patch' },
    },
  });
  t.after(repo.cleanup);

  const { fragments } = readFragments(diskSource(repo.root), { knownPlugins: new Map([['sidequest', {}]]) });
  assert.deepEqual(fragments.map((fragment) => fragment.ref), ['SQ-9', 'SQ-10', 'SQ-100']);
});

test('what note.mjs writes is exactly what the reader accepts', (t) => {
  const repo = makeRepo({ plugins: { sidequest: '3.6.49', workbench: '0.63.11' } });
  t.after(repo.cleanup);

  const source = parse('SQ-843', {
    plugins: { sidequest: 'minor', workbench: 'patch' },
    commit: 'c7b2702b2e2f041dff7fe513710de83d89198c55',
    hold: true,
    body: 'A detail line.',
  });
  const written = writeFragment(repo.root, source);
  assert.equal(written, '.release/unreleased/SQ-843.md');

  const reparsed = parseFragment(written, renderFragment(source), { knownPlugins: KNOWN });
  assert.deepEqual(reparsed.plugins, source.plugins);
  assert.equal(reparsed.hold, true);
  assert.equal(reparsed.body, 'A detail line.');
  assert.throws(() => writeFragment(repo.root, source), /already exists/);
});
