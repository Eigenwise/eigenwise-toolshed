import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { runGuard } from '../guard.mjs';
import { createGit } from '../lib/git.mjs';
import { DEFAULT_SCHEMA, load, Type } from '../vendor/js-yaml.mjs';
import { fileGit, makeRepo, marketplaceJson } from './helpers.mjs';

const PLUGINS = { sidequest: '3.6.49', workbench: '0.63.11' };

function setup(t, { published = null, ...repoOptions } = {}) {
  const repo = makeRepo({ plugins: PLUGINS, ...repoOptions });
  t.after(repo.cleanup);
  const files = published
    ? { '.claude-plugin/marketplace.json': marketplaceJson({ version: published.version, plugins: published.plugins }) }
    : {};
  return { root: repo.root, git: createGit({ cwd: repo.root, run: fileGit(files) }) };
}

const reasons = (result) => result.failures.join('\n');

const workflowPath = path.resolve(import.meta.dirname, '../../../.github/workflows/test.yml');

const localScalarTag = new Type('!', { kind: 'scalar', multi: true, construct: (value) => value });
const localSequenceTag = new Type('!', { kind: 'sequence', multi: true, construct: (value) => value });
const localMappingTag = new Type('!', { kind: 'mapping', multi: true, construct: (value) => value });
const workflowSchema = DEFAULT_SCHEMA.extend([localScalarTag, localSequenceTag, localMappingTag]);

function parseWorkflow(source) {
  return load(source, { schema: workflowSchema });
}

function affectedPluginTimeout(source) {
  return parseWorkflow(source)?.jobs?.['affected-plugin']?.['timeout-minutes'];
}

test('affected-plugin keeps its 60 minute timeout, matrix, and PR-only cancellation', () => {
  const workflow = parseWorkflow(readFileSync(workflowPath, 'utf8'));
  assert.equal(workflow.jobs['affected-plugin']['timeout-minutes'], 60);
  assert.equal(workflow.jobs['affected-plugin'].strategy.matrix, '${{ fromJSON(needs.plugin-matrix.outputs.matrix) }}');
  assert.equal(workflow.concurrency['cancel-in-progress'], "${{ github.event_name == 'pull_request' }}");
});

test('the affected-plugin timeout stays at job level regardless of key ordering', () => {
  for (const job of [
    [
      '    timeout-minutes: 5',
      '    strategy:',
      '      matrix: ${{ fromJSON(needs.plugin-matrix.outputs.matrix) }}',
      '      timeout-minutes: 60',
    ],
    [
      '    strategy:',
      '      matrix: ${{ fromJSON(needs.plugin-matrix.outputs.matrix) }}',
      '      timeout-minutes: 60',
      '    timeout-minutes: 5',
    ],
  ]) {
    const workflow = ['jobs:', '  affected-plugin:', ...job].join('\n');
    assert.equal(affectedPluginTimeout(workflow), 5);
  }
});

test('the affected-plugin timeout accepts quoted scalars and GitHub Actions expressions', () => {
  for (const [timeout, expected] of [
    ['"60"', '60'],
    ["'60'", '60'],
    ['${{ matrix.timeout }}', '${{ matrix.timeout }}'],
  ]) {
    const workflow = ['jobs:', '  affected-plugin:', `    timeout-minutes: ${timeout}`].join('\n');
    assert.equal(affectedPluginTimeout(workflow), expected);
  }
});

test('the affected-plugin timeout resolves flow and alias job mappings', () => {
  const flowWorkflow = 'jobs: { affected-plugin: { strategy: { timeout-minutes: 60 }, timeout-minutes: 5 } }';
  const aliasWorkflow = [
    'job-template: &base_job',
    '  strategy:',
    '    timeout-minutes: 60',
    '  timeout-minutes: 5',
    'jobs:',
    '  affected-plugin: *base_job',
  ].join('\n');

  assert.equal(affectedPluginTimeout(flowWorkflow), 5);
  assert.equal(affectedPluginTimeout(aliasWorkflow), 5);
});

test('the affected-plugin timeout cannot borrow a later job value', () => {
  const laterJobHeaders = [
    'FutureJob: &base_job',
    'FutureJob   :   &base_job',
    'FutureJob: !future',
    '"FutureJob": &base_job',
    '"FutureJob": !future &base_job # a later job',
    'FUTURE-JOB: !future &base_job',
  ];

  for (const header of laterJobHeaders) {
    const workflow = [
      'jobs:',
      '  affected-plugin: # timeout intentionally absent',
      '    strategy:',
      '      matrix: ${{ fromJSON(needs.plugin-matrix.outputs.matrix) }}',
      '      timeout-minutes: 60',
      `  ${header}`,
      '    timeout-minutes: 60',
    ].join('\r\n');

    assert.equal(affectedPluginTimeout(workflow), undefined, header);
  }
});

test('malformed workflow YAML fails instead of returning a timeout scalar', () => {
  const workflow = ['jobs:', '  affected-plugin:', '    timeout-minutes: [5'].join('\n');
  assert.throws(() => affectedPluginTimeout(workflow), /unexpected end of the stream|missed comma/);
});

test('a clean tree passes', (t) => {
  const context = setup(t, { fragments: { 'SQ-1': { plugins: ['sidequest'], bump: 'patch' } } });
  const result = runGuard(context.root, { git: context.git });
  assert.deepEqual(result.failures, []);
  assert.equal(result.ok, true);
  assert.equal(result.fragments, 1);
});

test('a plugin whose two version fields disagree fails', (t) => {
  const context = setup(t);
  const manifestPath = path.join(context.root, 'plugins/workbench/.claude-plugin/plugin.json');
  writeFileSync(manifestPath, readFileSync(manifestPath, 'utf8').replace('0.63.11', '0.63.5'));

  const result = runGuard(context.root, { git: context.git });
  assert.equal(result.ok, false);
  assert.match(reasons(result), /"workbench" version mismatch/);
});

test('a malformed fragment fails with its own reason', (t) => {
  const context = setup(t, { rawFragments: { 'SQ-2.md': '---\nref: SQ-2\ntitle: t\nplugins: [ghost]\nbump: patch\n---\n' } });
  const result = runGuard(context.root, { git: context.git });
  assert.match(reasons(result), /ghost/);
});

test('a queued copy of a fragment that already shipped fails loudly', (t) => {
  const context = setup(t, {
    fragments: { 'SQ-1': { title: 'Already out', plugins: ['sidequest'], bump: 'patch' } },
    changelog: '# Changelog\n\n## v3.207.0 (2026-07-24)\n\n#### Fixes\n- Already out (SQ-1)\n',
  });
  const result = runGuard(context.root, { git: context.git });
  assert.match(reasons(result), /SQ-1\.md is still queued even though this exact fragment already has a CHANGELOG\.md entry/);
});

test('a new fragment may reuse a released ref', (t) => {
  const context = setup(t, {
    fragments: { 'SQ-1': { title: 'New dispatch binding', plugins: ['sidequest'], bump: 'patch' } },
    changelog: '# Changelog\n\n## v3.207.0 (2026-07-24)\n\n#### Fixes\n- Already out (SQ-1)\n',
  });
  assert.deepEqual(runGuard(context.root, { git: context.git }).failures, []);
});

test('the marketplace has to serve the default branch', (t) => {
  const context = setup(t);
  assert.equal(runGuard(context.root, { git: context.git, defaultBranch: 'main' }).ok, true);
  assert.match(
    reasons(runGuard(context.root, { git: context.git, defaultBranch: 'dev' })),
    /default branch is "dev" but the marketplace must serve "main"/,
  );
});

test('versions may not move on the integration branch', (t) => {
  const context = setup(t, { published: { version: '3.207.0', plugins: { sidequest: '3.6.48', workbench: '0.63.11' } } });
  const result = runGuard(context.root, { git: context.git, mode: 'dev', publishRef: 'origin/main' });
  assert.equal(result.ok, false);
  assert.match(reasons(result), /"sidequest" is 3\.6\.49 here but 3\.6\.48 on origin\/main/);
});

test('a back-merged tree matches the publish branch and passes', (t) => {
  const context = setup(t, { published: { version: '3.207.0', plugins: PLUGINS } });
  assert.deepEqual(runGuard(context.root, { git: context.git, mode: 'dev', publishRef: 'origin/main' }).failures, []);
});

test('the marketplace counter may not move on the integration branch either', (t) => {
  const context = setup(t, { published: { version: '3.206.0', plugins: PLUGINS } });
  assert.match(
    reasons(runGuard(context.root, { git: context.git, mode: 'dev', publishRef: 'origin/main' })),
    /version is 3\.207\.0 but origin\/main has 3\.206\.0/,
  );
});

test('a publish branch with no marketplace yet is a note, not a failure', (t) => {
  const context = setup(t);
  const result = runGuard(context.root, { git: context.git, mode: 'dev', publishRef: 'origin/main' });
  assert.deepEqual(result.failures, []);
  assert.match(result.notes.join('\n'), /has no \.claude-plugin\/marketplace\.json yet/);
});

test('changed plugin source needs a fragment naming that plugin', (t) => {
  const context = setup(t, { fragments: { 'SQ-1': { plugins: ['sidequest'], bump: 'patch' } } });

  const covered = runGuard(context.root, { git: context.git, changed: ['plugins/sidequest/src/lib/board.ts'] });
  assert.deepEqual(covered.failures, []);

  const uncovered = runGuard(context.root, {
    git: context.git,
    changed: ['plugins/sidequest/src/lib/board.ts', 'plugins/workbench/hooks/freshness.js'],
  });
  assert.match(reasons(uncovered), /"workbench" changed with no fragment naming it/);
  assert.match(reasons(uncovered), /note\.mjs <REF> --plugins workbench/);
});

test('generated changelogs and unpublished plugins never demand a fragment', (t) => {
  const context = setup(t);
  const result = runGuard(context.root, {
    git: context.git,
    changed: ['plugins/sidequest/CHANGELOG.md', 'plugins/test-support/index.js', 'docs/src/content/docs/x.md', 'README.md'],
  });
  assert.deepEqual(result.failures, []);
});

test('on the publish branch a changed plugin must carry its bump and changelog', (t) => {
  const context = setup(t, { published: { version: '3.206.0', plugins: { sidequest: '3.6.48', workbench: '0.63.11' } } });

  const missingBump = runGuard(context.root, {
    git: context.git,
    mode: 'main',
    publishRef: 'origin/main',
    changed: ['plugins/sidequest/src/a.ts', 'plugins/workbench/hooks/b.js'],
  });
  assert.match(reasons(missingBump), /"workbench" changed on main without a version bump/);
  assert.match(reasons(missingBump), /versions moved \(sidequest\) without touching CHANGELOG\.md/);

  const complete = runGuard(context.root, {
    git: context.git,
    mode: 'main',
    publishRef: 'origin/main',
    changed: ['plugins/sidequest/src/a.ts', 'CHANGELOG.md'],
  });
  assert.deepEqual(complete.failures.filter((failure) => !failure.includes('no fragment naming it')), []);
});

test('an unknown mode is refused rather than silently skipping every check', (t) => {
  const context = setup(t);
  const result = runGuard(context.root, { git: context.git, mode: 'whatever' });
  assert.equal(result.ok, false);
  assert.match(reasons(result), /unknown --mode "whatever"/);
});
