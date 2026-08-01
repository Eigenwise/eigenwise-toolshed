'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const skill = fs.readFileSync(path.join(root, 'skills', 'init-workspace', 'SKILL.md'), 'utf8');
const catalog = fs.readFileSync(path.join(root, 'skills', 'init-workspace', 'references', 'stack-plugins.md'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const telemetrySkill = fs.readFileSync(path.join(root, 'skills', 'enable-project-telemetry', 'SKILL.md'), 'utf8');
const observability = fs.readFileSync(path.join(root, 'skills', 'init-workspace', 'references', 'observability.md'), 'utf8');
const ruleTemplates = fs.readFileSync(path.join(root, 'skills', 'init-workspace', 'references', 'rule-templates.md'), 'utf8');
const selfImprovement = fs.readFileSync(path.join(root, 'skills', 'init-workspace', 'references', 'self-improvement.md'), 'utf8');
const doctorSkill = fs.readFileSync(path.join(root, 'skills', 'workbench-doctor', 'SKILL.md'), 'utf8');

test('init-workspace enables agent teams and doctor only reports masked projects', () => {
  assert.match(skill, /enableAgentTeams/);
  assert.match(skill, /CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1"/);
  assert.match(skill, /Never\n  write it to shared `\.claude\/settings\.json`/);
  assert.match(doctorSkill, /agentTeamsWarning/);
  assert.match(doctorSkill, /prints nothing when the project has no `env` block or already enables teams/);
  assert.match(doctorSkill, /Do not fix it from the doctor/);
});

test('init-workspace configures a global compaction window and a project-local policy through explicit choices', () => {
  assert.match(skill, /### Compaction configuration/);
  assert.match(skill, /Ask one `AskUserQuestion` that explicitly records both settings before any write/);
  assert.match(skill, /read\n`~\/.claude\/settings\.json` and the project's `\.claude\/settings\.local\.json` first/);
  assert.match(skill, /Show the global\n`autoCompactWindow` and the project's `SIDEQUEST_COMPACTION_POLICY` values/);
  assert.match(skill, /leftover `autoCompactWindow`.*overrides the\nglobal preference and offer to remove it/s);
  assert.match(skill, /recommended 350000 \(trigger ~317k\)/);
  assert.match(skill, /aggressive 250000 \(trigger\n  ~217k\)/);
  assert.match(skill, /leave default \(on 1M-pinned models auto-compact effectively never fires: trigger = window\n  - 33k\)/);
  assert.match(skill, /custom 100000-1000000/);
  assert.match(skill, /removes `autoCompactWindow` from\n  `~\/.claude\/settings\.json`/);
  assert.match(skill, /project environment settings mask global env/);
  assert.match(skill, /experimental until the US-40 spike verdict/);
  assert.match(skill, /configureSidequestCompaction/);
  assert.match(skill, /removeProjectAutoCompactWindow/);
  assert.match(skill, /preserving its existing keys including `env`, `enabledPlugins`, and\n`marketplaces`/);
  assert.match(skill, /writes only\n`SIDEQUEST_COMPACTION_POLICY` to the project's `\.claude\/settings\.local\.json` `env` block/);
  assert.doesNotMatch(skill, /writes that project's `\.claude\/settings\.local\.json`,\n  preserves unknown top-level keys/);
});

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

test('init-workspace offers Git before writing greenfield workspace artifacts', () => {
  const stack = skill.indexOf('Stack** — confirm what you detected');
  const gitSetup = skill.indexOf('### Git setup for non-repos');
  const phaseTwo = skill.indexOf('## Phase 2 — Install, then pre-reload writes');

  assert.ok(stack >= 0 && stack < gitSetup && gitSetup < phaseTwo);
  assert.match(skill, /not a git repo, ask once with `AskUserQuestion`/);
  assert.match(skill, /before any pre-reload artifact is written/);
  assert.match(skill, /preserves the workspace setup and lets future sessions share it/);
  assert.match(skill, /On yes, run `git init` in the project root/);
  assert.match(skill, /stack-appropriate `\.gitignore`/);
  assert.match(skill, /Never overwrite an existing `\.gitignore`/);
  assert.match(skill, /On no, respect it without asking again/);
  assert.match(skill, /Never auto-commit/);
  assert.match(skill, /they declined Git setup, say once that the workspace is uncommitted/);
});

test('Workbench skills hand off global gateway wiring to the installed gateway skill', () => {
  for (const document of [skill, telemetrySkill]) {
    assert.match(document, /invoke\s+`\/model-gateway:model-gateway` and use its `env --write-user` command/);
    assert.match(document, /installed plugin command\s+is not on PATH/);
    assert.doesNotMatch(document, /`codex-gateway env --/);
    // The mode interview is gone with per-project wiring. Leaving any of it behind
    // would have a skill ask a question the CLI can no longer answer.
    assert.doesNotMatch(document, /--show-mode|--mode global|--mode local|--write-project/);
    assert.doesNotMatch(document, /ask exactly once/);
  }
  assert.match(skill, /wiring is global-only, so there is no per-project gateway\s+choice to make/);
  assert.match(telemetrySkill, /wiring is global and has no mode to choose, so do not ask about it/);
});

test('init-workspace starts with telemetry consent, project intent, then the live plugin picker', () => {
  const telemetry = skill.indexOf('### Telemetry consent');
  const intent = skill.indexOf('### Project intent');
  const picker = skill.indexOf('### Plugin picker');
  const assessment = skill.indexOf('## Phase 0 — Assess');

  assert.ok(telemetry >= 0 && telemetry < intent && intent < picker && picker < assessment);
  assert.match(skill, /This is the first question in the whole flow/);
  assert.match(skill, /Each project must opt in: this writes only its `\.claude\/settings\.local\.json`/);
  assert.match(skill, /local Collector to local Grafana/);
  assert.match(skill, /API-equivalent cost; input, output, and cache\ntoken totals; tool-call names and counts; plus model, session, agent, and activity information/);
  assert.match(skill, /never records\nprompt or response text, code or file contents, tool inputs or results, credentials, or environment values/);
  assert.match(skill, /restart Claude Code.*re-run `\/workbench:init-workspace`/s);
  assert.match(skill, /What is this project for, and who is\nit for\? One or two lines is plenty\./);
  assert.match(skill, /Keep the answer in the session\/bootstrap plan/);
  assert.match(skill, /Read the current Toolshed marketplace manifest and\n`references\/stack-plugins\.md`/);
  assert.match(skill, /recommendation grounded in the stated project purpose and any visible stack signals/);
  assert.match(skill, /recommended for this project because \.\.\./);
  assert.match(skill, /probably not needed\nhere/);
  assert.match(skill, /Do not fall back to generic core\/extra tiers/);
  assert.match(skill, /Do not maintain a hard-coded plugin\s+list in this skill/);
  assert.match(skill, /already-installed\s+state/);
  assert.match(skill, /The project-intent answer was collected before the picker/);
  assert.doesNotMatch(skill, /1\. \*\*What is this project and who is it for\?\*\*/);
});

test('init-workspace rechecks pending telemetry once in Phase 4', () => {
  const phaseFour = skill.indexOf('## Phase 4 — Post-reload: build and verify');
  const telemetryCheck = skill.indexOf('1. **Telemetry.**', phaseFour);

  assert.ok(phaseFour >= 0 && telemetryCheck > phaseFour);
  assert.match(skill, /A healthy-observer `not-found` means telemetry is\n\*\*configured, pending first export\*\*, never verified/);
  assert.match(skill, /schedules exactly one re-check in Phase 4 after real session usage exists/);
  assert.match(skill, /verify-project-telemetry\.js" --project "<absolute-current-project-dir>"/);
  assert.match(skill, /Report it as unverified and give the user that exact command to run later/);
  assert.match(skill, /Do not schedule another re-check/);
  assert.strictEqual((skill.match(/verify-project-telemetry\.js/g) || []).length, 1);
});

test('init-workspace keeps CLAUDE.md and live rules as complementary defaults', () => {
  assert.match(skill, /Recommend a lightweight static one seeded through `\/init`/);
  assert.match(skill, /Either answer keeps the live-rules plan/);
  assert.match(skill, /whether setup creates\s+always-loaded project context; live rules still handle conditional behavioral enforcement/);
  assert.match(skill, /Recommend a lightweight `CLAUDE\.md` alongside live rules/);
  assert.match(skill, /They have separate jobs: `CLAUDE\.md` is the\nalways-loaded, static project context/);
  assert.match(skill, /Live rules are conditional, targeted behavioral enforcement that gets injected when applicable/);
  assert.match(skill, /One does\nnot replace the other; together they are the default setup/);
  assert.doesNotMatch(skill, /rely on live rules instead/i);
});

test('init-workspace writes new live rules as atomic files with a verified manifest', () => {
  assert.match(skill, /[Cc]reate a new workspace's `\.claude\/live-rules\/`\s+directory directly/);
  assert.match(skill, /every accepted project rule as one\s+`\.claude\/live-rules\/rules\/<stable-name>\.md`/);
  assert.match(skill, /SHA-256 hash of\s+the exact UTF-8 rule file contents/);
  assert.match(skill, /Generate and validate those hashes mechanically, never by hand/);
  assert.match(skill, /fresh workspace never creates\s+`\.claude\/live-rules\.md`/);
  assert.match(skill, /migrate its rules into atomic files without deleting the\noriginal/);

  assert.match(ruleTemplates, /individual rule files/);
  assert.match(ruleTemplates, /never a new `\.claude\/live-rules\.md`/);
  assert.match(ruleTemplates, /"version": 1/);
  assert.match(ruleTemplates, /"path": "rules\/atomic-commits\.md"/);
  assert.match(ruleTemplates, /"hash": "<sha256 of the exact rules\/atomic-commits\.md contents>"/);
  assert.match(ruleTemplates, /temporary sibling, validate every hash/);
  assert.doesNotMatch(ruleTemplates, /File header/);

  assert.match(selfImprovement, /`\.claude\/live-rules\/rules\/self-improvement\.md`/);
  assert.match(selfImprovement, /`\.claude\/live-rules\/manifest\.json`/);
  assert.doesNotMatch(selfImprovement, /Install this rule into `\.claude\/live-rules\.md`/);
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

test('init-workspace proposes a routing profile from repository signals', () => {
  const routing = skill.indexOf('### Routing profile');
  const phaseOne = skill.indexOf('## Phase 1 — Interview and selection');

  assert.ok(routing >= 0 && routing < phaseOne);
  assert.match(skill, /code and build files → `coding`/);
  assert.match(skill, /docs, posts, or\ncontent → `writing`/);
  assert.match(skill, /source corpora, datasets, or citation-heavy material → `research`/);
  assert.match(skill, /audio, scores,\nor music-production files → `creative-music`/);
  assert.match(skill, /Use one `AskUserQuestion`/);
  assert.match(skill, /\*\*Use this profile\*\*, \*\*Choose\nanother starter\*\*, or \*\*Make a project profile\*\*/);
  assert.match(skill, /sidequest profile list/);
  assert.match(skill, /<project>-routing/);
  assert.match(skill, /sidequest profile create <project>-routing --from <starter>/);
  assert.match(skill, /sidequest profile use <project>-routing --project <board>/);
  assert.match(skill, /never `--profile\s+<starter>`/);
  assert.match(skill, /do not turn category routing into\na form or walk through every category/);
  assert.match(skill, /Phase 4\s+applies the profile/);
  assert.match(skill, /apply the profile recorded after Phase 0/);
});
