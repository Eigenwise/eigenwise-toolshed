'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const skill = fs.readFileSync(path.join(root, 'skills', 'init-workspace', 'SKILL.md'), 'utf8');
const catalog = fs.readFileSync(path.join(root, 'skills', 'init-workspace', 'references', 'stack-plugins.md'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const observability = fs.readFileSync(path.join(root, 'skills', 'init-workspace', 'references', 'observability.md'), 'utf8');

test('init-workspace installs selected plugins before dependent workspace artifacts', () => {
  assert.match(skill, /only prerequisite is \*\*Workbench installed at user scope\*\*/);
  assert.match(skill, /Build the installer plan in the \*\*current session scratchpad\*\*/);
  assert.match(skill, /bin\/install-workspace-plugins\.js/);
  assert.match(skill, /install-workspace-plugins\.js" --plan .* --check/);
  assert.match(skill, /install-workspace-plugins\.js" --plan/);
  assert.match(skill, /before writing any artifact that\ndepends on a selected plugin/);
  assert.match(skill, /Do \*\*not\*\* hand-write or merge `enabledPlugins`/);
});

test('init-workspace keeps a single failure-safe reload boundary', () => {
  assert.match(skill, /Default every selected workspace plugin to `project`/);
  assert.match(skill, /`local` only when the user explicitly/);
  assert.match(skill, /`user` only when they explicitly request a cross-project install/);
  assert.match(skill, /If either command fails, stop/);
  assert.match(skill, /Do not write dependent artifacts, request\na reload/);
  assert.match(skill, /Run \*\*`\/reload-plugins`\*\*/);
  assert.match(skill, /`\/reload-plugins --force`/);
  assert.match(skill, /confirm every selected plugin is\ninstalled, enabled, and at its requested scope/);
});

test('init-workspace asks for wiring mode only on an unset machine', () => {
  assert.match(skill, /Global \(all projects wired automatically via user settings\) or per-project \(each project opts in via its private settings\.local\.json — recommended\)\?/);
  assert.match(skill, /Persist the choice with `codex-gateway env --mode global` or `codex-gateway env --mode local`/);
  assert.match(skill, /do not ask again once a mode exists/);
  assert.match(skill, /wiring mode defaulted to per-project; run codex-gateway env --mode global to change/);
});

test('init-workspace starts with telemetry consent and then the live plugin picker', () => {
  const telemetry = skill.indexOf('### Telemetry consent');
  const picker = skill.indexOf('### Plugin picker');
  const assessment = skill.indexOf('## Phase 0 — Assess');

  assert.ok(telemetry >= 0 && telemetry < picker && picker < assessment);
  assert.match(skill, /This is the first question in the whole flow/);
  assert.match(skill, /`\.claude\/settings\.local\.json`, not shared or user settings/);
  assert.match(skill, /restart Claude Code.*re-run `\/workbench:init-workspace`/s);
  assert.match(skill, /Read the current Toolshed marketplace manifest and\n`references\/stack-plugins\.md`/);
  assert.match(skill, /Do not maintain a hard-coded plugin list in this skill/);
  assert.match(skill, /already-installed state/);
});

test('catalog has reproducible current plugin sources and LSP checks', () => {
  assert.match(catalog, /`typescript-lsp@claude-plugins-official`/);
  assert.match(catalog, /`typescript-language-server --version`/);
  assert.match(catalog, /`npm install -g typescript-language-server typescript`/);
  assert.match(catalog, /`Eigenwise\/eigenwise-toolshed`/);
  assert.match(catalog, /`cloudflare\/skills`/);
  assert.match(catalog, /`sveltejs\/ai-tools`/);
  assert.doesNotMatch(catalog, /vscode-langservers|claude-code-lsps|claude-ai-workshop/);
});

test('Workbench README describes the install-one-plugin bootstrap', () => {
  assert.match(readme, /one bootstrap entrypoint/);
  assert.match(readme, /installs the selected plugins at project scope by default/);
  assert.match(readme, /verifies every selected plugin works/);
});

test('observability retention guidance matches the store', () => {
  for (const document of [readme, observability]) {
    assert.match(document, /stays until (?:you|the user) deletes? it/);
    assert.doesNotMatch(document, /retained for 30 days|retained for 365 days|under 24 hours|age-prune/);
  }
  assert.match(observability, /--delete-data/);
});
