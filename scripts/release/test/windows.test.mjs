// Three real release windows off this repo's own history (git log, 2026-07-23 to 2026-07-25),
// replayed through the engine. SQ-841 measured the same three days as 43 publish commits and 43
// version bumps; batched, they are 3 cuts and 10 plugin bumps.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { cut } from '../cut.mjs';
import { createGit } from '../lib/git.mjs';
import { readValue } from '../lib/jsonedit.mjs';
import { fragmentText, makeRepo, recordingGit, remoteMutations } from './helpers.mjs';

const STARTING_VERSIONS = {
  'codebase-mapper': '2.11.1',
  'codex-gateway': '0.33.4',
  'live-rules': '2.7.1',
  sidequest: '3.6.17',
  workbench: '0.63.6',
};

const WINDOWS = [
  {
    date: '2026-07-23',
    publishCommits: 17,
    tickets: {
      sidequest: ['SQ-783', 'SQ-784', 'SQ-785', 'SQ-786', 'SQ-787', 'SQ-789', 'SQ-790', 'SQ-791', 'SQ-793', 'SQ-796', 'SQ-797', 'SQ-798', 'SQ-799'],
      'codex-gateway': ['SQ-794', 'SQ-795'],
      'codebase-mapper': ['SQ-792'],
      workbench: ['SQ-788'],
    },
    expected: { sidequest: '3.6.18', 'codex-gateway': '0.33.5', 'codebase-mapper': '2.11.2', workbench: '0.63.7' },
    marketplace: '3.208.0',
  },
  {
    date: '2026-07-24',
    publishCommits: 19,
    tickets: {
      sidequest: ['SQ-800', 'SQ-801', 'SQ-802', 'SQ-804', 'SQ-805', 'SQ-806', 'SQ-807', 'SQ-812', 'SQ-814', 'SQ-815', 'SQ-817', 'SQ-818', 'SQ-820', 'SQ-825'],
      'codex-gateway': ['SQ-810', 'SQ-811', 'SQ-813'],
      workbench: ['SQ-803', 'SQ-819', 'SQ-823'],
    },
    expected: { sidequest: '3.6.19', 'codex-gateway': '0.33.6', workbench: '0.63.8' },
    marketplace: '3.209.0',
  },
  {
    date: '2026-07-25',
    publishCommits: 7,
    // The live-rules doc commit that morning carried no board ref, which is exactly the churn this
    // model removes; under it that work needs a fragment, so the fixture gives it a stand-in ref.
    tickets: {
      sidequest: ['SQ-826', 'SQ-834'],
      workbench: ['SQ-827'],
      'live-rules': ['SQ-999'],
    },
    expected: { sidequest: '3.6.20', workbench: '0.63.9', 'live-rules': '2.7.2' },
    marketplace: '3.210.0',
  },
];

function pluginVersion(root, name) {
  return readValue(readFileSync(path.join(root, `plugins/${name}/.claude-plugin/plugin.json`), 'utf8'), ['version']);
}

function marketplace(root) {
  return JSON.parse(readFileSync(path.join(root, '.claude-plugin/marketplace.json'), 'utf8'));
}

function queue(root, window) {
  let seq = 0;
  for (const [plugin, refs] of Object.entries(window.tickets)) {
    for (const ref of refs) {
      seq += 1;
      writeFileSync(
        path.join(root, '.release/unreleased', `${ref}.md`),
        fragmentText(ref, {
          title: `${plugin} change ${ref}`,
          plugins: [plugin],
          bump: 'patch',
          commit: `${seq}`.padStart(7, 'a'),
        }),
      );
    }
  }
}

test('three real windows batch 43 publish commits into 3 cuts and 10 plugin bumps', async (t) => {
  const repo = makeRepo({ plugins: STARTING_VERSIONS });
  t.after(repo.cleanup);

  const bumped = [];
  const tags = [];
  let publishCommitsReplaced = 0;
  let ticketCount = 0;

  for (const window of WINDOWS) {
    queue(repo.root, window);
    const { run, calls } = recordingGit({ date: window.date });

    const result = await cut({
      repoRoot: repo.root,
      git: createGit({ cwd: repo.root, run }),
      push: true,
      runSuite: () => ({ code: 0 }),
      log: () => {},
    });

    assert.equal(result.status, 'cut', `${window.date} should cut`);
    assert.equal(result.plan.date, window.date);
    assert.deepEqual(
      Object.fromEntries(result.plan.plugins.map((plugin) => [plugin.name, plugin.to])),
      window.expected,
      `${window.date} bumps`,
    );
    assert.equal(marketplace(repo.root).version, window.marketplace);
    assert.equal(result.plan.tag, `v${window.marketplace}`);
    assert.deepEqual(remoteMutations(calls).length, 1, `${window.date} publishes with exactly one push`);

    for (const plugin of result.plan.plugins) bumped.push(`${plugin.name} ${plugin.from} -> ${plugin.to}`);
    tags.push(...result.plan.tags);
    publishCommitsReplaced += window.publishCommits;
    ticketCount += Object.values(window.tickets).flat().length;
  }

  assert.equal(publishCommitsReplaced, 43, 'the three days really were 43 publish commits');
  assert.equal(ticketCount, 41, '40 board tickets plus the stand-in for the unticketed live-rules commit');
  assert.equal(bumped.length, 10, '43 version bumps become 10');
  assert.equal(tags.length, 13, '3 window tags plus one per bumped plugin');

  assert.deepEqual(bumped, [
    'codebase-mapper 2.11.1 -> 2.11.2',
    'codex-gateway 0.33.4 -> 0.33.5',
    'sidequest 3.6.17 -> 3.6.18',
    'workbench 0.63.6 -> 0.63.7',
    'codex-gateway 0.33.5 -> 0.33.6',
    'sidequest 3.6.18 -> 3.6.19',
    'workbench 0.63.7 -> 0.63.8',
    'live-rules 2.7.1 -> 2.7.2',
    'sidequest 3.6.19 -> 3.6.20',
    'workbench 0.63.8 -> 0.63.9',
  ]);
});

test('thirteen sidequest tickets in one day move sidequest once', async (t) => {
  const repo = makeRepo({ plugins: STARTING_VERSIONS });
  t.after(repo.cleanup);
  queue(repo.root, WINDOWS[0]);
  const { run } = recordingGit({ date: WINDOWS[0].date });

  const result = await cut({ repoRoot: repo.root, git: createGit({ cwd: repo.root, run }), runSuite: () => ({ code: 0 }), log: () => {} });

  const sidequest = result.plan.plugins.find((plugin) => plugin.name === 'sidequest');
  assert.equal(sidequest.entries.length, 13);
  assert.equal(sidequest.from, '3.6.17');
  assert.equal(sidequest.to, '3.6.18');
  assert.equal(pluginVersion(repo.root, 'live-rules'), '2.7.1', 'a plugin nobody touched keeps its version');
  assert.equal(pluginVersion(repo.root, 'codebase-mapper'), '2.11.2');
});

test('each window leaves one changelog section and every ticket keeps its entry', async (t) => {
  const repo = makeRepo({ plugins: STARTING_VERSIONS });
  t.after(repo.cleanup);

  for (const window of WINDOWS) {
    queue(repo.root, window);
    const { run } = recordingGit({ date: window.date });
    await cut({ repoRoot: repo.root, git: createGit({ cwd: repo.root, run }), runSuite: () => ({ code: 0 }), log: () => {} });
  }

  const changelog = readFileSync(path.join(repo.root, 'CHANGELOG.md'), 'utf8');
  assert.deepEqual([...changelog.matchAll(/^## (v[\d.]+) \((\d{4}-\d{2}-\d{2})\)$/gm)].map((match) => match[1]), [
    'v3.210.0',
    'v3.209.0',
    'v3.208.0',
  ]);

  for (const window of WINDOWS) {
    for (const ref of Object.values(window.tickets).flat()) {
      assert.match(changelog, new RegExp(`\\(${ref}\\)`), `${ref} should be in the changelog`);
    }
  }

  const sidequestLog = readFileSync(path.join(repo.root, 'plugins/sidequest/CHANGELOG.md'), 'utf8');
  assert.deepEqual([...sidequestLog.matchAll(/^## ([\d.]+) /gm)].map((match) => match[1]), ['3.6.20', '3.6.19', '3.6.18']);
  assert.doesNotMatch(sidequestLog, /SQ-788/, 'a workbench ticket never lands in the sidequest changelog');

  assert.equal(
    readFileSync(path.join(repo.root, 'plugins/codebase-mapper/CHANGELOG.md'), 'utf8').match(/^## /gm).length,
    1,
    'a plugin that shipped in one window has one section',
  );
});
