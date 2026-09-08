'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

function readSkill(name) {
  return fs.readFileSync(path.join(__dirname, '..', 'skills', name, 'SKILL.md'), 'utf8');
}

test('documents namespaced Quartermaster commands and Live Rules deduplication', () => {
  const doctor = readSkill('toolshed-doctor');
  const setup = readSkill('setup');

  assert.match(doctor, /`\/quartermaster:update-toolshed`, then `\/reload-plugins`/);
  assert.doesNotMatch(doctor, /`\/update-toolshed`/);
  assert.match(setup, /injects a rule again only when it newly matches or its content\/hash changes/);
  assert.match(setup, /Unchanged rules do not repeat on every prompt or edit/);
  assert.doesNotMatch(setup, /every prompt for the always-on ones/);
});
