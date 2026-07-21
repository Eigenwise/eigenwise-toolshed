'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const mapSkill = fs.readFileSync(path.join(root, 'skills', 'map-codebase', 'SKILL.md'), 'utf8');
const updateSkill = fs.readFileSync(path.join(root, 'skills', 'update-codebase-map', 'SKILL.md'), 'utf8');

const artifactMarker = 'Shared-tree artifact mode: leave the generated map as working-tree output; verify, comment, and close with done. Do not commit, submit, push, or edit source.';
const carveOut = 'Artifact write carve-out: write only .claude/.codebase-info/**; all project source is read-only.';
const sharedTreeReason = 'Shared-tree dispatch is required because the map must describe the current working tree, including intentional uncommitted source, and the generated .claude/.codebase-info/** files must remain visible to the invoking session.';

test('initial-map handoff requires the live Sidequest artifact contract', () => {
  for (const tool of ['category_list', 'add', 'comment', 'dispatch', 'pulse', 'Agent']) {
    assert.match(mapSkill, new RegExp(`\\b${tool}\\b`));
  }
  assert.match(mapSkill, /codebase-exploration/);
  assert.match(mapSkill, /files: \["\.claude\/\.codebase-info\/"\]/);
  assert.match(mapSkill, new RegExp(carveOut.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(mapSkill, new RegExp(artifactMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(mapSkill, /\{ sharedTree: true \}/);
  assert.match(mapSkill, /Pass every returned spawn field to the native `Agent` unchanged/);
  assert.match(mapSkill, /Do not poll or start a proxy\s+waiter/);
  assert.match(mapSkill, /never touch\s+`CLAUDE\.md`/);
});

test('map handoff verifies artifacts and falls back only after one diagnosis-led retry', () => {
  assert.match(mapSkill, /node -e "const fs=require\('node:fs'\)/);
  assert.match(mapSkill, /at\s+most one diagnose-first redispatch/);
  assert.match(mapSkill, /After a second failure/);
  assert.match(mapSkill, /inline fallback/);
  assert.match(mapSkill, new RegExp(sharedTreeReason.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('incremental handoff keeps no-ops inline and uses the same artifact rules', () => {
  assert.match(updateSkill, /A true no-op stays inline/);
  assert.match(updateSkill, /category_list/, 'checks the live category');
  assert.match(updateSkill, new RegExp(carveOut.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(updateSkill, new RegExp(artifactMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(updateSkill, /\{ sharedTree: true \}/);
  assert.match(updateSkill, /Retry once only\s+when a diagnosis changes the\s+launch/);
  assert.match(updateSkill, /leave the map and state\s+untouched/);
});

test('large maps use area tickets and a dependent final artifact writer', () => {
  assert.match(mapSkill, /read-only area\s+tickets/);
  assert.match(mapSkill, /final artifact-writer ticket depending on them/);
  assert.match(mapSkill, /Do not\s+create nested generic tasks/);
  assert.match(updateSkill, /read-only area tickets and one dependent final\s+artifact writer/);
});
