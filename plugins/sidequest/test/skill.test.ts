import './_temp-cleanup.js';
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const skillRoot = path.join(__dirname, '..', 'skills', 'sidequest');
const skill = fs.readFileSync(path.join(skillRoot, 'SKILL.md'), 'utf8');
const boardFeatures = fs.readFileSync(path.join(skillRoot, 'references', 'board-features.md'), 'utf8');

// SKILL.md loads every session, so its size is a budget like the hook byte
// budgets: detail belongs in references/ that load on demand.
test('SKILL.md stays inside its session-load byte budget', () => {
  assert.ok(Buffer.byteLength(skill, 'utf8') <= 17600,
    `SKILL.md is ${Buffer.byteLength(skill, 'utf8')} bytes; budget is 17600 — move detail into references/`);
});

// The two behaviors the board depends on, and the reason it still exists.
test('the skill tells the agent to capture asides without asking', () => {
  assert.match(skill, /file it and keep going/i);
  assert.match(skill, /File it without asking/);
  assert.match(skill, /dies with the context window/);
});

test('the skill forbids picking work off the board unprompted', () => {
  assert.match(skill, /Do not pick work off the board on your own/);
  assert.match(skill, /Work a ticket when the user asks for that\s+ticket/);
  assert.match(skill, /Suggest, then wait/);
});

// The strip removed dispatch and routing. A skill that still describes them
// would send the agent looking for commands that no longer exist.
test('the skill carries no orchestration vocabulary', () => {
  // One sentence names what is gone, on purpose; everything else must be clean.
  const disclaimer = /There is no dispatch, no routing, no executors, no claims\./;
  assert.match(skill, /It tracks work\. It does not run it\./);
  assert.match(skill, disclaimer);
  const body = skill.replace(disclaimer, '');
  for (const dead of [
    /dispatch/i, /executor/i, /\brouting\b/i, /\broute\b/i, /categor/i, /complexity/i,
    /solo-fit/i, /fan-out/i, /\bwave\b/i, /\bclaim/i, /TaskOutput/i, /\bsubmit\b/i, /\bpulse\b/i,
  ]) {
    assert.doesNotMatch(body, dead, `SKILL.md still mentions ${dead}`);
  }
});

test('the skill documents only commands the CLI still has', () => {
  const cli = fs.readFileSync(path.join(__dirname, '..', 'src', 'bin', 'sidequest.ts'), 'utf8');
  for (const command of ['add', 'list', 'update', 'comment', 'done', 'link', 'archive', 'rm', 'dashboard']) {
    assert.match(skill, new RegExp(`sidequest ${command}\\b`), `SKILL.md should document ${command}`);
    assert.match(cli, new RegExp(`case '${command}'`), `CLI should still dispatch ${command}`);
  }
});

test('reference files the skill points at exist and stay orchestration-free', () => {
  for (const name of ['board-features.md', 'external-trackers.md']) {
    assert.match(skill, new RegExp(`references/${name.replace('.', '\\.')}`));
    assert.ok(fs.existsSync(path.join(skillRoot, 'references', name)), `${name} is missing`);
  }
  const listed = fs.readdirSync(path.join(skillRoot, 'references')).sort();
  assert.deepEqual(listed, ['board-features.md', 'external-trackers.md']);
  assert.doesNotMatch(boardFeatures, /execution contract|story log/);
});
