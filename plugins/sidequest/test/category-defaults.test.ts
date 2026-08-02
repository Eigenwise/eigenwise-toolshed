import './_temp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const { DEFAULT_CATEGORIES, ROUTING_PROFILE_SEED_REVISION, STARTER_ROUTING_PROFILES } = require('../lib/category-defaults.js') as {
  DEFAULT_CATEGORIES: unknown;
  ROUTING_PROFILE_SEED_REVISION: number;
  STARTER_ROUTING_PROFILES: Array<{ id: string; categories: any[] }>;
};
const snapshotPath = path.join(__dirname, 'fixtures', 'category-defaults.json');

test('seeded categories match the checked-in global category snapshot', () => {
  const snapshot: unknown = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  assert.deepEqual(DEFAULT_CATEGORIES, snapshot);
  assert.equal(ROUTING_PROFILE_SEED_REVISION, 5);
});

test('hard coding excludes stakes alone from classification', () => {
  const hard = (DEFAULT_CATEGORIES as any[]).find((category) => category.id === 'coding.hard');
  assert.match(hard.description, /do not make a ticket hard/);
});

test('experiment category preserves its human-verdict and round protocol gate', () => {
  const experiment = (DEFAULT_CATEGORIES as any[]).find((category) => category.id === 'experiment');
  assert.deepEqual(experiment.route, { model: 'opus', effort: 'high' });
  assert.deepEqual(experiment.fallback, { model: 'codex-gpt-5-6-sol', effort: 'high' });
  assert.equal(experiment.readonly, false);
  assert.match(experiment.description, /ONLY when the verdict is a human's judgement/);
  assert.match(experiment.description, /If a test can decide, it is coding or debugging/);
  assert.match(experiment.contract, /Read the experiment log fully before the first edit/);
  assert.match(experiment.contract, /one hypothesis per round/i);
  assert.match(experiment.contract, /sidequest\/experiment\/<ref>/);
  assert.match(experiment.contract, /refs\/sidequest\/<ref>\/r<N>/);
  assert.match(experiment.contract, /blind ranked comparison/);
  assert.match(experiment.contract, /Never paraphrase the user's verdict/);
  assert.match(experiment.contract, /release and the oracle ask/);
});

test('starter profiles expose the re-derived capability sets', () => {
  const expectedIds: Record<string, string[]> = {
    coding: [
      'codebase-exploration',
      'debugging',
      'experiment',
      'implementation-explanation',
      'general',
      'coding.hard',
      'source-lookup',
      'evidence-research',
      'review-audit',
      'spike-investigation',
      'coding.normal',
      'coding.easy',
      'behavior-verification',
      'interaction-design-implementation',
      'visual-evaluation',
    ],
    'creative-music': ['concept-framing', 'musical-generation', 'evaluative-revision', 'context-research', 'general'],
    research: ['source-lookup', 'evidence-investigation', 'evidence-synthesis', 'general'],
    writing: ['prose-generation', 'meaning-preserving-revision', 'source-verification', 'general'],
  };

  assert.deepEqual(
    Object.fromEntries(STARTER_ROUTING_PROFILES.map((profile) => [profile.id, profile.categories.map((category) => category.id)])),
    expectedIds,
  );
});

test('every starter category carries a distinct full resolution contract', () => {
  for (const profile of STARTER_ROUTING_PROFILES) {
    const resolutionKeys = profile.categories.map((category) => {
      assert.equal(typeof category.contract, 'string', `${profile.id}/${category.id} has no contract`);
      assert.ok(category.contract.trim(), `${profile.id}/${category.id} has an empty contract`);
      assert.match(category.description, /medium|high|xhigh|expensive|default|mechanic/i, `${profile.id}/${category.id} does not justify its route`);
      return JSON.stringify({
        route: category.route,
        contract: category.contract,
        readonly: category.readonly ?? false,
        artifactRoots: category.artifactRoots,
      });
    });

    assert.equal(new Set(resolutionKeys).size, profile.categories.length, `${profile.id} contains redundant categories`);
  }
});
