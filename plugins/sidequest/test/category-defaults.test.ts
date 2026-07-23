import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const { DEFAULT_CATEGORIES } = require('../lib/category-defaults.js') as { DEFAULT_CATEGORIES: unknown };
const snapshotPath = path.join(__dirname, 'fixtures', 'category-defaults.json');

test('seeded categories match the checked-in global category snapshot', () => {
  const snapshot: unknown = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  assert.deepEqual(DEFAULT_CATEGORIES, snapshot);
});

test('hard coding excludes stakes alone from classification', () => {
  const hard = (DEFAULT_CATEGORIES as any[]).find((category) => category.id === 'coding.hard');
  assert.match(hard.description, /do not make a ticket hard/);
});
