import assert from 'node:assert/strict';
import test from 'node:test';

import {
  releasedRefs,
  renderPluginSection,
  renderRepoSection,
  repoChangelogHeader,
  repoSectionHeading,
  upsertSection,
} from '../lib/changelog.mjs';

const PLAN = {
  mode: 'normal',
  date: '2026-07-25',
  tag: 'v3.208.0',
  publishBranch: 'main',
  repository: 'https://github.com/Eigenwise/eigenwise-toolshed',
  marketplace: { from: '3.207.0', to: '3.208.0', level: 'minor' },
  plugins: [
    {
      name: 'sidequest',
      from: '3.6.49',
      to: '3.7.0',
      level: 'minor',
      entries: [
        { ref: 'SQ-800', title: 'Lean default board reads', level: 'minor', commit: 'c7b2702b2e2f041dff7fe513710de83d89198c55', body: '' },
        { ref: 'SQ-817', title: 'Fix the Bash path guard', level: 'patch', commit: null, body: 'Heredocs stopped tripping it.' },
        { ref: 'SQ-834', title: 'Drop the old claim API', level: 'major', commit: null, body: '' },
      ],
    },
    {
      name: 'workbench',
      from: '0.63.11',
      to: '0.63.12',
      level: 'patch',
      entries: [{ ref: 'SQ-823', title: 'Canonicalize span attributes', level: 'patch', commit: null, body: '' }],
    },
  ],
};

test('entries group by what the change was, in a fixed order', () => {
  const section = renderRepoSection(PLAN);
  assert.match(section, /^## v3\.208\.0 \(2026-07-25\)$/m);
  assert.match(section, /^### sidequest 3\.6\.49 → 3\.7\.0$/m);
  assert.match(section, /^### workbench 0\.63\.11 → 0\.63\.12$/m);

  const order = [...section.matchAll(/^#### (.+)$/gm)].map((match) => match[1]);
  assert.deepEqual(order, ['Breaking changes', 'Features', 'Fixes', 'Fixes']);

  assert.match(section, /- Drop the old claim API \(SQ-834\)/);
  assert.match(section, /- Lean default board reads \(SQ-800\) \[`c7b2702`\]\(https:\/\/github\.com\/Eigenwise\/eigenwise-toolshed\/commit\/c7b2702b2e2f041dff7fe513710de83d89198c55\)/);
  assert.match(section, /^ {2}Heredocs stopped tripping it\.$/m);
});

test('a plugin changelog only carries that plugin', () => {
  const section = renderPluginSection(PLAN.plugins[1], PLAN);
  assert.match(section, /^## 0\.63\.12 \(2026-07-25\)$/m);
  assert.match(section, /Released in v3\.208\.0, up from 0\.63\.11\./);
  assert.match(section, /^### Fixes$/m, 'groups sit one level under the version, not two');
  assert.doesNotMatch(section, /^#### /m);
  assert.match(section, /Canonicalize span attributes \(SQ-823\)/);
  assert.doesNotMatch(section, /sidequest/);
});

test('rerunning a cut regenerates the same file instead of stacking sections', () => {
  const header = repoChangelogHeader();
  const first = upsertSection('', repoSectionHeading(PLAN), renderRepoSection(PLAN), header);
  const again = upsertSection(first, repoSectionHeading(PLAN), renderRepoSection(PLAN), header);
  assert.equal(again, first);
  assert.equal([...first.matchAll(/^## v3\.208\.0 /gm)].length, 1);
  assert.ok(first.startsWith('# Changelog'));
});

test('the seeded changelog keeps its header when the first window lands on it', () => {
  const header = repoChangelogHeader();
  const seeded = upsertSection(header, repoSectionHeading(PLAN), renderRepoSection(PLAN), header);

  assert.equal([...seeded.matchAll(/^# Changelog$/gm)].length, 1);
  assert.ok(seeded.startsWith(header.trimEnd()));
  assert.match(seeded, /nothing here is hand-written\.\n\n## v3\.208\.0 /);
  assert.equal(upsertSection(seeded, repoSectionHeading(PLAN), renderRepoSection(PLAN), header), seeded);
});

test('a corrected rerun replaces the section rather than appending a second one', () => {
  const header = repoChangelogHeader();
  const first = upsertSection('', repoSectionHeading(PLAN), renderRepoSection(PLAN), header);
  const corrected = upsertSection(first, repoSectionHeading(PLAN), '## v3.208.0 (2026-07-25)\n\ncorrected\n', header);
  assert.equal([...corrected.matchAll(/^## v3\.208\.0 /gm)].length, 1);
  assert.match(corrected, /corrected/);
  assert.doesNotMatch(corrected, /Lean default board reads/);
});

test('the newest window goes on top and older ones survive', () => {
  const header = repoChangelogHeader();
  const older = upsertSection('', '## v3.208.0 (2026-07-25)', '## v3.208.0 (2026-07-25)\n\nold window\n', header);
  const newer = upsertSection(older, '## v3.209.0 (2026-07-26)', '## v3.209.0 (2026-07-26)\n\nnew window\n', header);
  assert.deepEqual([...newer.matchAll(/^## (v[\d.]+) /gm)].map((match) => match[1]), ['v3.209.0', 'v3.208.0']);
  assert.match(newer, /old window/);
});

test('the changelog is the ledger of what has already shipped', () => {
  const text = upsertSection('', repoSectionHeading(PLAN), renderRepoSection(PLAN), repoChangelogHeader());
  assert.deepEqual([...releasedRefs(text)].sort(), ['SQ-800', 'SQ-817', 'SQ-823', 'SQ-834']);
  assert.equal(releasedRefs('').size, 0);
  assert.equal(releasedRefs('- not an entry SQ-1').size, 0, 'a ref needs its parentheses to count');
});

test('a hotfix window says so', () => {
  const section = renderRepoSection({ ...PLAN, mode: 'hotfix', tag: 'v3.207.1' });
  assert.match(section, /^## v3\.207\.1 \(2026-07-25\)$/m);
  assert.match(section, /Hotfix release cut from `main`\./);
});
