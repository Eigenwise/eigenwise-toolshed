import './_temp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const { DEFAULT_CATEGORIES, ROUTING_PROFILE_SEED_REVISION } = require('../lib/category-defaults.js') as {
  DEFAULT_CATEGORIES: unknown;
  ROUTING_PROFILE_SEED_REVISION: number;
};
const snapshotPath = path.join(__dirname, 'fixtures', 'category-defaults.json');

test('seeded categories match the checked-in global category snapshot', () => {
  const snapshot: unknown = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  assert.deepEqual(DEFAULT_CATEGORIES, snapshot);
  assert.equal(ROUTING_PROFILE_SEED_REVISION, 4);
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
