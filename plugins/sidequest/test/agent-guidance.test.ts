import './_temp-cleanup.js';
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const skill = fs.readFileSync(path.join(ROOT, 'skills', 'sidequest', 'SKILL.md'), 'utf8');
const orchestration = fs.readFileSync(path.join(ROOT, 'skills', 'sidequest', 'references', 'orchestration.md'), 'utf8');
const executorTemplate = fs.readFileSync(path.join(ROOT, 'scripts', '_exec-template.md'), 'utf8');
const activeGuidance = [skill, orchestration, executorTemplate];

test('published guidance excludes retired instructions', () => {
  assert.doesNotMatch(orchestration, /ephemeral|registration wait|waiting for registration/);
  assert.doesNotMatch(executorTemplate, /sidequest submit <ref>/);
  assert.doesNotMatch(executorTemplate, /comments digest/i);
  assert.doesNotMatch(orchestration, /It carries the full ticket contract/);
  assert.doesNotMatch(skill, /user-granted `direct-ok` label/);
  assert.doesNotMatch(skill, /on ambiguity, growing scope, or two failed\s+attempts they release \+ report fast/);
  assert.doesNotMatch(orchestration, /executors bounce back on\s+ambiguity/);
  for (const source of activeGuidance) {
    assert.doesNotMatch(source, /\b(?:one|two|three|\d+)\s+(?:failed|unproductive|honest|unsuccessful)?\s*(?:attempts?|failures?|stops?)\b/i);
  }
  assert.match(executorTemplate, /useful edits, a scoped commit, or meaningful verification expose an interpretive or correctness concern, keep the claim and worktree alive/);
  assert.match(executorTemplate, /newly supplied token-gated briefing and live board state as authoritative over an inherited transcript that says the ticket is terminal/);
  assert.match(executorTemplate, /wait for corrected evidence or a decision through `SendMessage` so the same executor can continue/);
  assert.match(skill, /For useful work\s+needing a decision, `SendMessage` the same agent and keep its claim and worktree/);
  assert.match(orchestration, /Correct the live worker before replacing it/);
  assert.match(skill, /Don't accept a green suite as proof of coverage; review execution evidence/);
  assert.match(executorTemplate, /name the assertion in the test that ran and was not skipped/);
  assert.match(executorTemplate, /state that the state directory started empty/);
  assert.match(executorTemplate, /both names must cover the changed behavior, not an unrelated test/);

  for (const source of [skill, orchestration]) {
    assert.doesNotMatch(source, new RegExp('native' + '_agent', 'i'));
    assert.doesNotMatch(source, new RegExp(['MCP `dispatch`', ' are disabled'].join(''), 'i'));
  }
});

export {};
