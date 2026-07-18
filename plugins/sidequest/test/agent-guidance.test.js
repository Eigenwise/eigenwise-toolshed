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

test('shared-tree guidance detects foreign staging and absorbed scope patches', () => {
  assert.match(executorTemplate, /immediately after claiming and before work, inspect `git diff --cached --name-only`/);
  assert.match(executorTemplate, /any staged path outside the declared scope is foreign work/);
  assert.match(executorTemplate, /save the declared-scope staged patch with `git diff --cached --binary -- <declared-scope> > <scratchpad>\/scope\.patch`/);
  assert.match(executorTemplate, /git log --format="%H\|%an\|%ae\|%s" <pre-sync-head>\.\.HEAD -- <declared-scope>/);
  assert.match(executorTemplate, /`git apply --check --reverse --cached <saved-patch>` proves it was absorbed/);
  assert.match(executorTemplate, /must be restored with `git apply --cached <saved-patch>`/);
  assert.match(executorTemplate, /If it includes any path outside the declared scope, treat it as foreign work: do not commit/);
});
