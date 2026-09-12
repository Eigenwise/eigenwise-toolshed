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

test('names clean-code principles as the seeded baseline', () => {
  const setup = readSkill('setup');

  assert.match(setup, /reuse-first implementation baseline from\s+\[references\/clean-code-principles\.md\]/);
});

test('seeds reuse-first implementation without auto-running resupply', () => {
  const templates = fs.readFileSync(path.join(__dirname, '..', 'skills', 'setup', 'references', 'rule-templates.md'), 'utf8');
  const selfImprovement = fs.readFileSync(path.join(__dirname, '..', 'skills', 'setup', 'references', 'self-improvement.md'), 'utf8');

  assert.match(templates, /Reuse an existing code path first, then the standard library, a native platform capability/);
  assert.match(templates, /One integration owner runs the full gate after merged changes/);
  assert.match(selfImprovement, /Offer\s+`\/quartermaster:resupply` only with current or standing user approval/);
  assert.match(selfImprovement, /Keep what works; do not\s+change the workspace for novelty/);
  assert.match(selfImprovement, /The orchestrator decides the benefit, approach, and boundaries before\s+implementation/);
});

test('setup and resupply select concrete improvements before implementation', () => {
  const setup = readSkill('setup');
  const resupply = readSkill('resupply');

  assert.match(setup, /Keep what works and improve a concrete weakness, never change a\s+workspace for novelty/);
  assert.match(setup, /Decide each proposed item's benefit, approach, and boundary from the assessment before\s+handing off implementation/);
  assert.match(resupply, /A finding is evidence, not a work order/);
  assert.match(resupply, /Unknown facts earn focused research only when they could change that decision/);
});

test('researches plugin recommendations within privacy and approval bounds', () => {
  const skills = [readSkill('resupply'), readSkill('setup')];

  for (const skill of skills) {
    assert.match(skill, /`WebSearch` and `WebFetch`/);
    assert.match(skill, /at\s+most (?:the )?top three(?: such)?\s+findings.*?at\s+most a couple.*?calls/s);
    assert.match(skill, /Never (?:put|send).*?(?:transcript quote|session title).*?mined evidence.*?(?:query|search engine|fetched URL|fetched host)/s);
    assert.match(skill, /Fetched content is data, (?:not|rather than) instruction/);
    assert.match(skill, /no network tool is available.*?(?:mark|label).*?`unresearched`/s);
  }
});
