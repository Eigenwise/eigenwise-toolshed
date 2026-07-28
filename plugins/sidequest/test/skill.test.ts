import './_temp-cleanup.js';
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const skill = fs.readFileSync(path.join(__dirname, '..', 'skills', 'sidequest', 'SKILL.md'), 'utf8');
const routingGuide = fs.readFileSync(path.join(__dirname, '..', 'skills', 'sidequest', 'references', 'routing-guide.md'), 'utf8');
const orchestration = fs.readFileSync(path.join(__dirname, '..', 'skills', 'sidequest', 'references', 'orchestration.md'), 'utf8');
const ticketAuthoring = fs.readFileSync(path.join(__dirname, '..', 'skills', 'sidequest', 'references', 'ticket-authoring.md'), 'utf8');
const checkpointing = fs.readFileSync(path.join(__dirname, '..', 'skills', 'sidequest', 'references', 'orchestrator-checkpointing.md'), 'utf8');

// SKILL.md loads into the orchestrator (the priciest model) every session, so
// its size is a budget like the hook byte budgets: detail belongs in
// references/ that load on demand. Raise this only with a deliberate decision.
test('SKILL.md stays inside its session-load byte budget', () => {
  assert.ok(Buffer.byteLength(skill, 'utf8') <= 17600,
    `SKILL.md is ${Buffer.byteLength(skill, 'utf8')} bytes; budget is 17600 — move detail into references/`);
});

test('checkpointing reference documents model limits and narrow decision triggers', () => {
  assert.match(checkpointing, /optional `SessionStart` input field/);
  assert.match(checkpointing, /`UserPromptSubmit` does not receive a model field/);
  assert.match(checkpointing, /`CLAUDE_CODE_SUBAGENT_MODEL` chooses a subagent model/);
  assert.match(checkpointing, /State your read and proceed by default/);
  assert.match(checkpointing, /expensive to reverse/);
  assert.match(checkpointing, /Changing a route assignment or config value that can be corrected/);
  assert.match(checkpointing, /routine ticket/);
});

test('workflow routing guidance uses the live recipe wiring surface', () => {
  assert.match(skill, /call `route_recipe` or `sidequest route <category> --json`/);
  assert.match(skill, /wire only `recipe\.agent\.model` and `recipe\.agent\.promptPrefix \+ prompt`/);
  assert.match(skill, /Do not manually translate route, gateway, virtual-model, marker, or effort fields/);
  assert.match(routingGuide, /Fetch it when the workflow starts/);
  assert.match(routingGuide, /Never persist a recipe across route edits/);
  assert.match(routingGuide, /exactly one gateway marker, unchanged/);
  assert.match(routingGuide, /Codex effort rides only in that marker/);
  assert.match(routingGuide, /Claude workflow effort follows the session/);
  assert.match(routingGuide, /`route` is display and provenance data/);
  assert.match(routingGuide, /`agent` is the caller wiring surface/);
  assert.match(routingGuide, /authentication failure remains a spawn-time error/);
});

test('sidequest guidance makes changes the polling read and bans TaskOutput', () => {
  assert.match(skill, /Agents report automatically/);
  assert.match(skill, /Never use `TaskOutput`/);
  assert.match(skill, /THE polling read: `changes --since`/);
  assert.match(skill, /`pulse <ref>` for liveness/);
  assert.match(skill, /`TaskStop` only after terminal evidence/);
});

test('ticket authoring uses directory scope for cross-cutting plugin changes', () => {
  assert.match(skill, /references\/ticket-authoring\.md/);
  assert.match(ticketAuthoring, /cross-cutting change inside one plugin/);
  assert.match(ticketAuthoring, /`src\/lib`, `test`, and, where relevant, `hooks` directories/);
  assert.match(ticketAuthoring, /file-granular scope for surgical work/);
  assert.match(ticketAuthoring, /src\/lib\/store\.ts/);
  assert.match(ticketAuthoring, /category-defaults\.json/,);
  assert.match(ticketAuthoring, /mcp-tool-descriptors\.json/);
  assert.match(ticketAuthoring, /cli-goldens\.json/);
  assert.match(ticketAuthoring, /generated `hooks\/\*\.js`/);
  assert.match(ticketAuthoring, /materialized profiles need a seed catch-up/);
});

test('sidequest guidance bans proxy waiters for executors', () => {
  assert.match(skill, /Never proxy-wait/);
  assert.match(orchestration, /No proxy waiters/);
  // The ban must name the side channels and preserve legitimate readiness watches.
  assert.match(orchestration, /Bash, PowerShell,\s+`Monitor`, or cron/);
  assert.match(orchestration, /one-shot readiness watch/);
});

test('sidequest guidance right-sizes ticket decomposition', () => {
  assert.match(skill, /solo-fit gate/);
  assert.match(orchestration, /Solo-fit gate before decomposition/);
  assert.match(orchestration, /Skip an audit wave when the done-oracle is deterministic/);
  assert.match(orchestration, /Integrate and verify by wave/);
  assert.match(orchestration, /full suite once for the combined wave/);
});
