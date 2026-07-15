'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

process.env.SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-category-band-test-'));
process.env.SIDEQUEST_DISCOVERY_DIRS = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-category-band-catalog-'));
const store = require('../lib/store.js');

test('legacy complexity bands are fixed category mappings', () => {
  for (let complexity = 1; complexity <= 10; complexity++) {
    const expected = complexity <= 3 ? 'coding.easy' : complexity <= 6 ? 'coding.normal' : 'coding.hard';
    assert.equal(store.legacyCategoryForComplexity(complexity), expected);
  }
});

test('invalid legacy complexity has no routing category', () => {
  for (const value of [null, '', 0, 11, 'bad']) assert.equal(store.legacyCategoryForComplexity(value), null);
});

test('category filters select stable policy while model filters select resolved runtime', () => {
  const project = store.ensureProject(path.join(store.homeRoot(), 'project'));
  store.createTicket(project.slug, { title: 'easy', category: 'coding.easy' });
  store.createTicket(project.slug, { title: 'hard', category: 'coding.hard' });
  assert.deepEqual(store.readyTickets(project.slug, { category: 'coding.easy' }).map((ticket) => ticket.title), ['easy']);
  const easyModel = store.getTicket(project.slug, 'SQ-1').model;
  assert.deepEqual(store.readyTickets(project.slug, { model: easyModel }).map((ticket) => ticket.title), ['easy']);
  assert.throws(() => store.readyTickets(project.slug, { model: 'missing-model' }), /Unknown model/);
});
