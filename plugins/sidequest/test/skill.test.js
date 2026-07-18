'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const skill = fs.readFileSync(path.join(__dirname, '..', 'skills', 'sidequest', 'SKILL.md'), 'utf8');

test('sidequest skill bans TaskOutput for native Agent launches', () => {
  assert.match(skill, /Native Agent results arrive automatically/);
  assert.match(skill, /Never use `TaskOutput`/);
  assert.match(skill, /`pulse <ref>` \/ `changes --since`/);
  assert.match(skill, /`TaskStop` only after terminal board evidence/);
});
