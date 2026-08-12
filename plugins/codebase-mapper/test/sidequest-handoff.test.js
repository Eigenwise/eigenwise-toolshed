'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const mapSkill = fs.readFileSync(path.join(root, 'skills', 'map-codebase', 'SKILL.md'), 'utf8');
const updateSkill = fs.readFileSync(path.join(root, 'skills', 'update-codebase-map', 'SKILL.md'), 'utf8');

function sidequestHandoff(skill) {
  const handoffStart = skill.indexOf('### Sidequest handoff');
  const refreshStart = skill.indexOf('Use the handoff only');
  const start = handoffStart === -1 ? refreshStart : handoffStart;
  const end = skill.indexOf('\n### ', start + 5);
  assert.notEqual(start, -1, 'the skill must define a Sidequest handoff');
  return skill.slice(start, end === -1 ? undefined : end);
}

function assertArtifactContract(skill, label) {
  const handoff = sidequestHandoff(skill);
  assert.match(handoff, /files:\s*\["\.claude\/\.codebase-info\/"\]/, `${label} names one map write root`);
  assert.match(handoff, /\{\s*sharedTree:\s*true\s*\}/, `${label} uses shared-tree artifact mode`);
  // The skills are operational guidance, so this boundary is observable only in its contract text.
  assert.match(handoff, /Artifact write carve-out:\s+write only \.claude\/\.codebase-info\/\*\*; all project source is read-only\./, `${label} excludes source writes`);
  assert.match(handoff, /never touch\s+`CLAUDE\.md`/, `${label} excludes CLAUDE.md writes`);
}

test('initial map handoff keeps the map artifact write boundary', () => {
  const handoff = sidequestHandoff(mapSkill);
  assertArtifactContract(mapSkill, 'initial map');
  assert.match(handoff, /category_list/);
  assert.match(handoff, /codebase-exploration/);
});

test('initial map handoff permits only one diagnosis-led retry', () => {
  // Retry count is guidance rather than executable code, so the smallest distinctive contract phrase is the assertion.
  assert.match(mapSkill, /at\s+most one diagnose-first redispatch/);
  assert.match(mapSkill, /After a second failure/);
});

test('incremental map refreshes inline and reserves handoff for large drifts', () => {
  assert.match(updateSkill, /touches fewer than ~15 files across already-mapped areas/);
  assert.match(updateSkill, /Do not create a ticket or dispatch an agent for this case\./);
  assert.match(updateSkill, /handoff only for a full remap or a large structural drift/);
  assert.match(updateSkill, /a new subsystem, a deleted service,\s*or the first Dockerfile or datastore/);
});

test('large incremental map handoff keeps the artifact boundary and retry limit', () => {
  assertArtifactContract(updateSkill, 'incremental map');
  assert.match(updateSkill, /Retry once only\s+when a diagnosis changes the\s+launch/);
});

test('map skill hash checks normalize CRLF documents', () => {
  for (const skill of [mapSkill, updateSkill]) {
    assert.match(skill, /readFileSync\(p\+n,'utf8'\)/);
    assert.match(skill, /b\.replace\(\/\\r\/g,''\)/);
  }
});

test('large maps use read-only area tickets and one artifact writer', () => {
  assert.match(mapSkill, /read-only area\s+tickets/);
  assert.match(mapSkill, /final artifact-writer ticket depending on them/);
  assert.match(updateSkill, /read-only area tickets and one dependent final\s+artifact writer/);
});
