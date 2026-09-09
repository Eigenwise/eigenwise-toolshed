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

test('seeds reuse-first implementation without auto-running resupply', () => {
  const templates = fs.readFileSync(path.join(__dirname, '..', 'skills', 'setup', 'references', 'rule-templates.md'), 'utf8');
  const selfImprovement = fs.readFileSync(path.join(__dirname, '..', 'skills', 'setup', 'references', 'self-improvement.md'), 'utf8');

  assert.match(templates, /Reuse an existing code path first, then the standard library, a native platform capability/);
  assert.match(templates, /One integration owner runs the full gate after merged changes/);
  assert.match(selfImprovement, /Offer\s+`\/quartermaster:resupply` only with current or standing user approval/);
});
