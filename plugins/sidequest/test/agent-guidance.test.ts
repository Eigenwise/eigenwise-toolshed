import './_temp-cleanup.js';
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const agentsync = require('../lib/agentsync.js');

const ROOT = path.join(__dirname, '..');
const skill = fs.readFileSync(path.join(ROOT, 'skills', 'sidequest', 'SKILL.md'), 'utf8');
const userStory = fs.readFileSync(path.join(ROOT, 'skills', 'user-story', 'SKILL.md'), 'utf8');
const verifyDiscipline = fs.readFileSync(path.join(ROOT, 'skills', 'verify-discipline', 'SKILL.md'), 'utf8');
const ticketAuthoring = fs.readFileSync(path.join(ROOT, 'skills', 'sidequest', 'references', 'ticket-authoring.md'), 'utf8');
const orchestration = fs.readFileSync(path.join(ROOT, 'skills', 'sidequest', 'references', 'orchestration.md'), 'utf8');
const publishing = fs.readFileSync(path.join(ROOT, 'skills', 'sidequest', 'references', 'publishing.md'), 'utf8');
const invocationContracts = fs.readFileSync(path.join(ROOT, 'skills', 'sidequest', 'references', 'invocation-contracts.md'), 'utf8');
const externalTrackers = fs.readFileSync(path.join(ROOT, 'skills', 'sidequest', 'references', 'external-trackers.md'), 'utf8');
const readonlyGuidance = fs.readFileSync(path.join(ROOT, 'skills', 'sidequest', 'references', 'readonly-guidance.md'), 'utf8');
const executorTemplate = fs.readFileSync(path.join(ROOT, 'scripts', '_exec-template.md'), 'utf8');
const activeGuidance = [skill, orchestration, executorTemplate];

test('published guidance excludes retired instructions', () => {
  assert.doesNotMatch(orchestration, /ephemeral|registration wait|waiting for registration/);
  assert.doesNotMatch(executorTemplate, /sidequest submit <ref>/);
  assert.doesNotMatch(executorTemplate, /comments digest/i);
  assert.doesNotMatch(orchestration, /It carries the full ticket contract/);
  assert.doesNotMatch(skill, /user-granted `direct-ok` label/);
  assert.doesNotMatch(skill, /on ambiguity, growing scope, or two failed\s+attempts they release \+ report fast/);
  assert.doesNotMatch(orchestration, /executors bounce back on\s+ambiguity/);
  for (const source of activeGuidance) {
    assert.doesNotMatch(source, /\b(?:one|two|three|\d+)\s+(?:failed|unproductive|honest|unsuccessful)?\s*(?:attempts?|failures?|stops?)\b/i);
  }
  assert.match(executorTemplate, /useful edits, a scoped commit, or meaningful verification expose an interpretive or correctness concern, keep the claim and worktree alive/);
  assert.match(executorTemplate, /newly supplied token-gated briefing and live board state as authoritative over an inherited transcript that says the ticket is terminal/);
  assert.match(executorTemplate, /wait for corrected evidence or a decision through `SendMessage` so the same executor can continue/);
  assert.match(skill, /For useful work\s+needing a decision, `SendMessage` the same agent and keep its claim and worktree/);
  assert.match(orchestration, /Correct the live worker before replacing it/);
  assert.match(skill, /Don't accept a green suite as proof of coverage; review execution evidence/);
  assert.match(executorTemplate, /Trace the actual call flow before implementing/);
  assert.match(executorTemplate, /smallest shared-root fix/);
  assert.match(executorTemplate, /Prefer measured deletion/);
  assert.match(executorTemplate, /orchestrator owns one combined final full gate after integration/);
  assert.match(executorTemplate, /smallest meaningful runnable\s+regression/);
  assert.match(executorTemplate, /Do not claim broader coverage ran when it did not/);
  assert.match(executorTemplate, /name the assertion in the test that ran and was not skipped/);
  assert.match(executorTemplate, /state that the state directory started empty/);
  assert.match(executorTemplate, /both names must cover the changed behavior, not an unrelated test/);
  assert.match(verifyDiscipline, /one combined full gate after integration/);
  assert.match(verifyDiscipline, /smallest meaningful\s+runnable regression/);
  assert.match(userStory, /Named uncertainty or safety-sensitive seam/);
  assert.match(ticketAuthoring, /do not invent a test count/);
  assert.match(orchestration, /read each submit report, then run one combined full gate for the wave/);
  assert.match(orchestration, /Retire terminal teammates/);
  assert.match(orchestration, /TaskStop\(\{ task_id: "<agent name>" \}\)`\s+once/);
  assert.match(orchestration, /Claude Code host action, not a Sidequest tool/);
  assert.match(orchestration, /Never stop a live claim, retained continuation,\s+or candidate awaiting\s+integration/);
  assert.match(orchestration, /Do not wake a completed executor, poll FleetView, or create a cleanup loop/);
  assert.match(skill, /TaskStop\(\{ task_id: "<agent name>" \}\)/);
  assert.match(executorTemplate, /After terminal closeout, the board terminal state is authoritative/);

  for (const source of [skill, orchestration]) {
    assert.doesNotMatch(source, new RegExp('native' + '_agent', 'i'));
    assert.doesNotMatch(source, new RegExp(['MCP `dispatch`', ' are disabled'].join(''), 'i'));
  }
});

test('sidequest listing description covers board use and inline exceptions', () => {
  const frontmatter = skill.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(frontmatter, 'skill frontmatter must be present');
  const frontmatterLines = frontmatter[1].split(/\r?\n/);
  const descriptionStart = frontmatterLines.findIndex((line: string) => /^description:\s*>-?\s*$/.test(line));
  assert.notEqual(descriptionStart, -1, 'skill description must use a folded frontmatter value');
  const descriptionLines: string[] = [];
  for (const line of frontmatterLines.slice(descriptionStart + 1)) {
    if (!/^\s+/.test(line)) break;
    descriptionLines.push(line.trim());
  }
  const description = descriptionLines.join(' ');
  assert.ok(description.length > 0, 'skill description must not be empty');
  assert.ok(description.length <= 1536, `skill description is ${description.length} characters`);
  assert.match(description, /\bUse for\b/);
  assert.match(description, /\bStay inline for\b/);
});

test('external tracker guidance keeps authored GitHub communication self-contained', () => {
  assert.match(externalTrackers, /GitHub issue bodies, comments, replies, and closure notes you author must stand alone/);
  assert.match(externalTrackers, /sanitized reproduction, relevant findings, and version/);
  assert.match(externalTrackers, /publicly resolvable issue, PR,\s+commit, or release links/);
  assert.match(externalTrackers, /local `SQ-`\/`US-` identifiers, board slugs, local-only evidence paths/);
  assert.match(externalTrackers, /Keep those references in local\s+Sidequest threads with the GitHub link back/);
  assert.match(externalTrackers, /Preserve reporter text unless you are authorized to edit\s+it/);
  assert.match(externalTrackers, /existing user or team authorization applies to that public action/);
  assert.match(externalTrackers, /sanitation controls content, not posting authority/);
  assert.doesNotMatch(externalTrackers, /update the \*\*external\*\* tracker\/PR as the team expects/);
  assert.match(externalTrackers, /do not strip diagnostic error text or hand-edit historical changelogs or generated release\s+history/);
});

test('operating guidance uses live taxonomy and consistent recon boundaries', () => {
  const categoryDefaults = require('../lib/category-defaults.js').DEFAULT_CATEGORIES as Array<{ id: string }>;
  const starterCategories = new Set(categoryDefaults.map((category) => category.id));
  for (const category of ['review-audit', 'source-lookup', 'evidence-research', 'codebase-exploration']) {
    assert.ok(starterCategories.has(category), `${category} must remain a starter category`);
  }

  const operationalGuidance = [skill, userStory, orchestration, publishing];
  for (const source of operationalGuidance) {
    assert.doesNotMatch(source, /`docs-writing`|`security-audit`/);
  }
  for (const source of [skill, userStory, orchestration]) {
    assert.match(source, /bounded recon.*named anchors/i);
    assert.match(source, /unfamiliar[\s\S]{0,80}deep investigation/i);
  }
});

test('publishing consumes reports and oracles without an orchestrator diff review', () => {
  assert.match(publishing, /consume each submission report and the delivery and\s+merged-tree gate evidence/);
  assert.match(publishing, /A deterministic singleton needs no bound review/);
  assert.match(publishing, /Bind a `review-audit` ticket/);
  assert.match(publishing, /Do not inspect executor source or diffs/);
  assert.doesNotMatch(publishing, /Review the integrated diff/);
  assert.doesNotMatch(publishing, /Read the diff yourself/);
  assert.match(publishing, /use `sidequest rework <ref>/);
  assert.match(publishing, /only for an actual integration bounce/);
});

test('published guidance pins surgical planning before substantial dispatch', () => {
  assert.match(skill, /Before dispatching substantial or ambiguous work, pin a contract/);
  assert.match(userStory, /Outcome and explicit non-goals/);
  assert.match(userStory, /Smallest authority/);
  assert.match(userStory, /Surgical boundaries/);
  assert.match(userStory, /bounded executable done-oracle per piece/);
  assert.match(userStory, /Review budget/);
  assert.match(userStory, /Design-reopen evidence/);
  assert.match(userStory, /"do your thing", "use your judgment", or "whatever you think"/);
  assert.match(userStory, /use two\s+or three bounded proposals only when the approach is genuinely contested/);
  assert.match(ticketAuthoring, /Unrelated findings become separately prioritized tickets/);
  assert.match(ticketAuthoring, /After two independently rejected candidates in one defect chain/);
});

test('the invocation contracts reference is derived from the accepted synonyms and published enums', () => {
  const mcp = require('../lib/mcp.js');
  assert.match(skill, /references\/invocation-contracts\.md/);

  for (const [tool, aliases] of Object.entries(mcp.ARGUMENT_ALIASES as Record<string, Record<string, string>>)) {
    assert.match(invocationContracts, new RegExp(`\`${tool}\``), `${tool} is missing from the synonym list`);
    for (const [from, to] of Object.entries(aliases)) {
      assert.match(invocationContracts, new RegExp(`\`${from}\`[^\\n]*\`${to}\``), `${tool} accepts ${from} for ${to}, undocumented`);
    }
  }
  assert.match(
    invocationContracts,
    new RegExp(`priority: "${mcp.COERCED_PRIORITY.from}"[^\\n]*"${mcp.COERCED_PRIORITY.to}"`),
    'the priority coercion is undocumented',
  );

  const byName = new Map((mcp.toolDescriptors() as Array<{ name: string; inputSchema: any }>).map((tool) => [tool.name, tool]));
  for (const [tool, property] of [['release', 'kind'], ['add', 'verifyKind']] as Array<[string, string]>) {
    for (const value of byName.get(tool)!.inputSchema.properties[property].enum as string[]) {
      assert.ok(invocationContracts.includes(value), `${tool}.${property} value "${value}" is not explained`);
    }
  }
  const waiverSchema = byName.get('integrate')!.inputSchema.properties.verificationWaiver;
  assert.deepEqual(Object.keys(waiverSchema.properties), ['authority', 'reason', 'affectedGate', 'scope', 'expiresAt']);
  assert.match(invocationContracts, /skipVerify: true[^\n]*verificationWaiver/);

  // An agent reads the schema description on the way in and this file when it needs the reason, so the
  // grammar has to be one string in both places: three tickets in a row were refused for guessing it.
  const publishedVerify = byName.get('add')!.inputSchema.properties.verify.description as string;
  const grammar = publishedVerify.slice(publishedVerify.indexOf('`'), publishedVerify.lastIndexOf('`') + 1);
  assert.ok(grammar.length > 40, publishedVerify);
  assert.ok(invocationContracts.includes(grammar), `the reference does not carry the published grammar: ${grammar}`);
});

test('read-only report guidance preserves Sidequest review authority', () => {
  assert.match(skill, /references\/readonly-guidance\.md/);
  assert.match(readonlyGuidance, /existing readonly `review-audit` category/);
  assert.match(readonlyGuidance, /immutable `reviewTarget`/);
  assert.match(readonlyGuidance, /file and line, known ceiling, observable upgrade trigger, and replacement/);
  assert.match(readonlyGuidance, /A missing ceiling or trigger is itself a finding/);
  assert.match(readonlyGuidance, /Call a gain unmeasured unless a matched baseline/);
  assert.match(readonlyGuidance, /routed report capability is unavailable/);
});

test('every implementation executor leaves candidate reviews to the orchestrator', () => {
  const implementationExecutors = agentsync.implementationExecutorSources();
  assert.ok(implementationExecutors.size > 0);

  for (const [filename, source] of implementationExecutors) {
    assert.doesNotMatch(filename, /readonly/i, filename);
    assert.match(source, /genuine mid-task side issue while your claim is live/, filename);
    assert.match(source, /Never create, dispatch, assign, or link a review or audit ticket for your own work or candidate\./, filename);
    assert.match(source, /Never review your own work or candidate\./, filename);
    assert.match(source, /Commit and submit, then stop\./, filename);
    assert.match(source, /orchestrator reads the terminal submission, binds an independent review to its exact immutable candidate and parent under a fresh identity/, filename);
    assert.match(source, /A read-only review executor may report its findings and close normally\./, filename);
  }
});

export {};
