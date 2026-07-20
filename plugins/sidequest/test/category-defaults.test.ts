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
