'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const skill = fs.readFileSync(path.join(__dirname, '..', 'skills', 'sidequest', 'SKILL.md'), 'utf8');
const routingGuide = fs.readFileSync(path.join(__dirname, '..', 'skills', 'sidequest', 'references', 'routing-guide.md'), 'utf8');
const orchestration = fs.readFileSync(path.join(__dirname, '..', 'skills', 'sidequest', 'references', 'orchestration.md'), 'utf8');

// SKILL.md loads into the orchestrator (the priciest model) every session, so
// its size is a budget like the hook byte budgets: detail belongs in
// references/ that load on demand. Raise this only with a deliberate decision.
test('SKILL.md stays inside its session-load byte budget', () => {
  assert.ok(Buffer.byteLength(skill, 'utf8') <= 16000,
    `SKILL.md is ${Buffer.byteLength(skill, 'utf8')} bytes; budget is 16000 — move detail into references/`);
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

test('sidequest guidance bans proxy waiters for executors', () => {
  assert.match(skill, /Never proxy-wait/);
  assert.match(orchestration, /No proxy waiters/);
  // The ban must name the side channels and preserve legitimate readiness watches.
  assert.match(orchestration, /Bash, PowerShell,\s+`Monitor`, or cron/);
  assert.match(orchestration, /one-shot readiness watch/);
});
