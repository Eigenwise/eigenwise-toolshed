import './_temp-cleanup.js';
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const skill = fs.readFileSync(path.join(__dirname, '..', 'skills', 'sidequest', 'SKILL.md'), 'utf8');

// SKILL.md loads into the orchestrator (the priciest model) every session, so
// its size is a budget like the hook byte budgets: detail belongs in
// references/ that load on demand. Raise this only with a deliberate decision.
//
// Raised 17600 -> 18000 on 2026-08-06, deliberately. SQ-1381 landed guidance
// that saves minutes of executor wall-clock per run and put the file 72 bytes
// over. Getting back under took four prose edits and three full gate runs, and
// the edits were driven by the byte count rather than by whether the wording
// was better. A budget that shapes prose it was never meant to judge needs
// headroom; one that never binds is not a budget. 18000 keeps it binding.
//
// SQ-1238 deleted this file's six prose assertions and kept only this one. A
// threshold on a real cost is not a prose pin: it fails on the file growing,
// never on the same words being rewrapped or reworded.
//
// Raised 18000 -> 18400 on 2026-08-06, deliberately. SQ-1391 added the claim
// lifecycle rule (submit is terminal; a submitted ticket cannot be amended by
// messaging its executor) and landed 21 bytes over. That rule exists because an
// orchestrator burned an executor turn and two idle-hook stops rediscovering it,
// and it only works on the surface that loads at the moment of temptation, so
// moving it into references/ would delete its reason for existing. Trimming
// wording to reclaim 21 bytes is the failure mode the previous note describes.
//
// SQ-2249 expands the session-load description with the board-versus-inline
// calibration needed in every listing, so keep the budget binding with modest
// headroom rather than trimming that contract.
test('SKILL.md stays inside its session-load byte budget', () => {
  assert.ok(Buffer.byteLength(skill, 'utf8') <= 18500,
    `SKILL.md is ${Buffer.byteLength(skill, 'utf8')} bytes; budget is 18500 — move detail into references/`);
});
