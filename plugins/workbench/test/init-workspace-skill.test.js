'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const skill = fs.readFileSync(path.join(root, 'skills', 'init-workspace', 'SKILL.md'), 'utf8');
const catalog = fs.readFileSync(path.join(root, 'skills', 'init-workspace', 'references', 'stack-plugins.md'), 'utf8');
const ruleTemplates = fs.readFileSync(path.join(root, 'skills', 'init-workspace', 'references', 'rule-templates.md'), 'utf8');
const selfImprovement = fs.readFileSync(path.join(root, 'skills', 'init-workspace', 'references', 'self-improvement.md'), 'utf8');

test('init-workspace excludes retired instructions', () => {
  assert.doesNotMatch(skill, /writes that project's `\.claude\/settings\.local\.json`,\n  preserves unknown top-level keys/);
  assert.doesNotMatch(skill, /`codex-gateway env --/);
  assert.doesNotMatch(skill, /--show-mode|--mode global|--mode local|--write-project/);
  assert.doesNotMatch(skill, /ask exactly once/);
  assert.doesNotMatch(skill, /then re-run `\/workbench:init-workspace`/);
  assert.doesNotMatch(skill, /1\. \*\*What is this project and who is it for\?\*\*/);
  assert.doesNotMatch(skill, /rely on live rules instead/i);
  assert.doesNotMatch(ruleTemplates, /File header/);
  assert.doesNotMatch(selfImprovement, /Install this rule into `\.claude\/live-rules\.md`/);
  assert.doesNotMatch(catalog, /vscode-langservers|claude-code-lsps|claude-ai-workshop/);
});
