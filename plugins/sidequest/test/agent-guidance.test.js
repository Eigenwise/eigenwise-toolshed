'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
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

test('ephemeral dispatch guidance prevents registration wait stalls', () => {
  assert.match(skill, /Never end the turn waiting for registration/);
  assert.match(skill, /background timer/);
  assert.match(orchestration, /Never end a turn waiting for registration/);
  assert.match(orchestration, /Any session\nmay adopt an unspawned prepared definition/);
});

test('dispatch guidance requires board confirmation after an Agent launch', () => {
  assert.match(orchestration, /Agent acknowledgement means only\n`launched`/);
  assert.match(orchestration, /Pulse the ticket immediately/);
  assert.match(orchestration, /missing claim means diagnose or respawn/);
});

test('post-wave seam review stays scoped and event-driven', () => {
  assert.match(orchestration, /Review seams once after a wave closes/);
  assert.match(orchestration, /next natural wakeup, inspect one combined diff\/stat/);
  assert.match(orchestration, /overlapping edits, shared interfaces\/contracts, duplicate\n  implementations, and incompatible assumptions/);
  assert.match(orchestration, /proceed without a broad review/);
  assert.match(orchestration, /narrowly scoped review-audit follow-up for the affected files/);
  assert.match(orchestration, /do not reopen completed\n  tickets or rerun every ticket's verification/);
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

test('complete Sidequest doctrine stays shipped and current', () => {
  assert.match(skill, /Cut along affected surfaces/);
  assert.match(skill, /store, CLI, MCP surface, skill\/docs, and applicable full test directory/);
  assert.match(readme, /scope work by affected\nsurfaces/);
  assert.match(skill, /~\/.claude\/sidequest\/sidequest\.db/);
  assert.match(readme, /loaded MCP server or old session can still write the old store/);
  assert.match(skill, /Do not recreate a standalone Switchboard/);
  assert.match(readme, /Do not recreate a standalone\nSwitchboard/);
  assert.match(orchestration, /Salvage before redispatch/);
  assert.match(skill, /Executors bounce back, they don't grind/);
  assert.match(skill, /release \+ report fast/);
  assert.match(orchestration, /payload and context bloat/);
  assert.match(orchestration, /lingering workers/);
  assert.match(orchestration, /route anomalies/);
  assert.match(orchestration, /board hygiene/);
  assert.match(orchestration, /steerable background execution by default/i);
  assert.match(readme, /\*\*Routed repo lifecycle:\*\* dispatch → token claim → scoped commit → submit →\s+orchestrator publish/);
  assert.match(readme, /matching versions in both\n  `\.claude-plugin\/plugin\.json` and `\.claude-plugin\/marketplace\.json`/);
  assert.match(orchestration, /exact executor name, and the stamped effort/);
  assert.match(orchestration, /never add, rewrite, or combine markers/);
  for (const source of [readme, skill, orchestration]) {
    assert.doesNotMatch(source, new RegExp('native' + '_agent', 'i'));
    assert.doesNotMatch(source, new RegExp(['MCP `dispatch`', ' are disabled'].join(''), 'i'));
  }
});
