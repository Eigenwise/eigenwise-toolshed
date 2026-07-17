'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DEFAULT_CATEGORIES } = require('../lib/category-defaults.js');

const snapshotPath = path.join(__dirname, 'fixtures', 'category-defaults.json');

test('seeded categories match the checked-in global category snapshot', () => {
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  assert.deepEqual(DEFAULT_CATEGORIES, snapshot);
});
