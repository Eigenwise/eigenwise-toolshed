'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const skill = fs.readFileSync(path.join(ROOT, 'skills', 'sidequest', 'SKILL.md'), 'utf8');
const orchestration = fs.readFileSync(path.join(ROOT, 'skills', 'sidequest', 'references', 'orchestration.md'), 'utf8');
const publishing = fs.readFileSync(path.join(ROOT, 'skills', 'sidequest', 'references', 'publishing.md'), 'utf8');
const executorTemplate = fs.readFileSync(path.join(ROOT, 'scripts', '_exec-template.md'), 'utf8');

test('comment guidance makes durable handoffs concise and consumable', () => {
  assert.match(executorTemplate, /cross-actor handoffs, not a work diary/);
  assert.match(executorTemplate, /Do not post routine progress narration or self-logs/);
  assert.match(executorTemplate, /Do not dump an entire green test log/);
  assert.match(skill, /Before integrating or closing a submitted ticket, read\n`sidequest comments <ref> --json`/);
  assert.match(publishing, /Read each submitted handoff/);
  assert.match(publishing, /Do not cherry-pick until the thread is understood/);
});

test('planning guidance keeps Sidequest stories optional and distinct from Claude Code', () => {
  assert.match(skill, /Sidequest's own optional\n\s+`US-n` grouping, not a Claude Code feature/);
  assert.match(skill, /shared outcome, dependencies, or waves/);
  assert.match(skill, /leave independent or small work as atomic tickets/);
});

test('workflow guidance suggests a documented Claude Code script shape', () => {
  assert.match(orchestration, /built with `agent\(\)` and `pipeline\(\)`/);
  assert.doesNotMatch(orchestration, /`parallel\(\)`/);
  assert.match(orchestration, /`pipeline\(tickets, ticket => agent\(ticket\.prompt, \{ label: ticket\.ref \}\)\)`/);
});

test('ephemeral dispatch guidance prevents registration wait stalls', () => {
  assert.match(skill, /Never end the turn waiting for registration/);
  assert.match(skill, /background timer/);
  assert.match(orchestration, /Never end a turn waiting for registration/);
  assert.match(orchestration, /Any session\nmay adopt an unspawned prepared definition/);
});
