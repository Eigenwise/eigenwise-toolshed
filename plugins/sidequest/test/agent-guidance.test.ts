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
const ticketAuthoring = fs.readFileSync(path.join(ROOT, 'skills', 'sidequest', 'references', 'ticket-authoring.md'), 'utf8');
const orchestration = fs.readFileSync(path.join(ROOT, 'skills', 'sidequest', 'references', 'orchestration.md'), 'utf8');
const invocationContracts = fs.readFileSync(path.join(ROOT, 'skills', 'sidequest', 'references', 'invocation-contracts.md'), 'utf8');
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
  assert.match(executorTemplate, /name the assertion in the test that ran and was not skipped/);
  assert.match(executorTemplate, /state that the state directory started empty/);
  assert.match(executorTemplate, /both names must cover the changed behavior, not an unrelated test/);
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
