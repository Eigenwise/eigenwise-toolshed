'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { createSignalCollector, normalizeCommand, tallyFromSignals } = require('../lib/signals.js');
const { streamTranscript } = require('../lib/stream.js');

function writeTranscript(records) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'quartermaster-test-')), 'session.jsonl');
  fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n'), 'utf8');
  return file;
}

function userPrompt(text, extra = {}) {
  return { type: 'user', message: { role: 'user', content: text }, timestamp: '2026-08-01T10:00:00Z', ...extra };
}

function assistantToolUse(name, input, extra = {}) {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: `tool-${name}-${Math.random()}`, name, input }] },
    timestamp: '2026-08-01T10:01:00Z',
    ...extra,
  };
}

async function collect(records) {
  const collector = createSignalCollector();
  const file = writeTranscript(records);
  await streamTranscript({ scope: 'main', file, sessionId: 'session-1' }, collector);
  return collector.finish();
}

test('counts denials with kind, tool, and target', async () => {
  const use = assistantToolUse('Bash', { command: 'npm test' });
  const toolUseId = use.message.content[0].id;
  const signals = await collect([
    use,
    {
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'denied' }] },
      toolUseResult: 'denied',
      toolDenialKind: 'permission-rule',
      timestamp: '2026-08-01T10:02:00Z',
    },
  ]);
  assert.equal(signals.friction.denials.total, 1);
  assert.equal(signals.friction.denials.byKind['permission-rule'], 1);
  assert.equal(signals.friction.denials.byTool.Bash, 1);
  assert.equal(signals.friction.denials.targets[0].target, 'npm test');
});

test('detects corrections and interrupts from user prompts', async () => {
  const signals = await collect([
    userPrompt('please add a login page'),
    userPrompt("no, that's wrong, I said use the existing form"),
    userPrompt('[Request interrupted by user]'),
    { type: 'assistant', message: { role: 'assistant', content: [] }, isAbortedMidStream: true, timestamp: '2026-08-01T10:03:00Z' },
  ]);
  assert.equal(signals.friction.corrections.count, 1);
  assert.match(signals.friction.corrections.samples[0].quote, /existing form/);
  assert.equal(signals.friction.interrupts, 2);
});

test('meta and tool-result user records are not prompts', async () => {
  const signals = await collect([
    userPrompt('<command-name>/model</command-name>', { isMeta: true }),
    userPrompt('real prompt here'),
  ]);
  assert.equal(signals.sessions[0].prompts, 1);
});

test('aggregates attribution from tool_use records', async () => {
  const signals = await collect([
    assistantToolUse('Skill', { skill: 'map-codebase' }, { attributionPlugin: 'codebase-mapper', attributionSkill: 'map-codebase' }),
    assistantToolUse('mcp__plugin_sidequest_board__dispatch', {}),
  ]);
  assert.equal(signals.attribution.plugins['codebase-mapper'], 1);
  assert.equal(signals.attribution.skills['map-codebase'], 1);
  assert.equal(signals.attribution.mcpServers['plugin:sidequest:board'], 1);
});

test('counts hook errors from attachments and habit commands', async () => {
  const signals = await collect([
    { type: 'attachment', attachment: { hookEvent: 'SessionStart', hookName: 'SessionStart:startup', exitCode: 1 }, timestamp: '2026-08-01T10:00:30Z' },
    assistantToolUse('Bash', { command: 'git   push origin main --force-with-lease' }),
    assistantToolUse('Bash', { command: 'git push' }),
    assistantToolUse('WebFetch', { url: 'https://docs.python.org/3/library/json.html' }),
  ]);
  assert.equal(signals.friction.hookErrors['SessionStart:startup'], 1);
  const gitPush = signals.habits.commandsTop.find((entry) => entry.name === 'git push');
  assert.equal(gitPush.count, 2);
  assert.equal(signals.habits.webFetchDomainsTop[0].name, 'docs.python.org');
});

test('normalizeCommand reduces to recognizable headlines', () => {
  assert.equal(normalizeCommand('FOO=1 git commit -m "x"'), 'git commit');
  assert.equal(normalizeCommand('node scripts/build/build.js --watch'), 'node build.js');
  assert.equal(normalizeCommand('C:\\tools\\rg.exe -n pattern'), 'rg');
  assert.equal(normalizeCommand('ls -la'), 'ls');
  assert.equal(normalizeCommand(''), null);
});

test('tallyFromSignals flattens per-session counts', async () => {
  const signals = await collect([
    userPrompt('do the thing'),
    userPrompt('no, not like that'),
  ]);
  const tally = tallyFromSignals(signals);
  assert.equal(tally.prompts, 2);
  assert.equal(tally.corrections, 1);
});
