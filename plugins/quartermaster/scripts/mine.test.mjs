import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { OUTPUT_BUDGET_BYTES, commandPrefix, mine, projectSlug, renderWithinBudget } from './mine.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mine.mjs');
const SECRET = 'hunter2-do-not-print';
const NOW = Date.parse('2026-11-16T12:00:00Z');

function prompt(text, extra = {}) {
  return { type: 'user', timestamp: '2026-11-10T10:00:00Z', message: { role: 'user', content: text }, ...extra };
}

function toolUse(id, name, input, extra = {}) {
  return { type: 'assistant', timestamp: '2026-11-10T10:01:00Z', message: { content: [{ type: 'tool_use', id, name, input }] }, ...extra };
}

function toolResult(id, text, extra = {}, blockExtra = {}) {
  return {
    type: 'user',
    timestamp: '2026-11-10T10:02:00Z',
    toolUseResult: {},
    message: { content: [{ type: 'tool_result', tool_use_id: id, content: text, ...blockExtra }] },
    ...extra,
  };
}

function humanSession() {
  return [
    prompt(`please fix the login bug, the password is ${SECRET}`),
    toolUse('a1', 'Bash', { command: `cd /repo && FOO=1 npm test -- --grep ${SECRET}` }),
    toolResult('a1', 'ok'),
    toolUse('a2', 'Bash', { command: `git push origin ${SECRET}` }),
    toolResult('a2', 'rejected', { toolDenialKind: 'user-rejected' }, { is_error: true }),
    toolUse('a3', 'Read', { file_path: `/repo/${SECRET}.txt` }),
    toolResult('a3', `file body ${SECRET}`, {}, { is_error: true }),
    toolUse('a4', 'Bash', { command: 'rm -rf build' }),
    toolResult('a4', 'PreToolUse:Bash hook error: blocked', { toolDenialKind: 'permission-rule' }, { is_error: true }),
    toolUse('a5', 'Skill', { skill: 'sidequest:plan' }),
    toolResult('a5', 'loaded'),
    prompt('<command-name>/quartermaster:outfit</command-name>'),
    toolUse('s1', 'Bash', { command: 'npm publish' }, { isSidechain: true }),
    prompt('<task-notification>agent finished</task-notification>'),
  ];
}

function writeTranscript(directory, name, records, modifiedMs = NOW) {
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${name}.jsonl`);
  writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\nnot json\n`);
  utimesSync(file, new Date(modifiedMs), new Date(modifiedMs));
  return file;
}

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'qm-mine-'));
  const projectPath = path.join(root, 'work', 'app');
  const projectsRoot = path.join(root, 'config', 'projects');
  const slug = projectSlug(projectPath);
  return { root, projectPath, projectsRoot, slug, environment: { CLAUDE_CONFIG_DIR: path.join(root, 'config') } };
}

test('commandPrefix keeps the first two words and drops arguments', () => {
  assert.equal(commandPrefix('git push --force origin main'), 'git push');
  assert.equal(commandPrefix('cd "/some path" && FOO=bar npm run build'), 'npm run');
  assert.equal(commandPrefix('C:/tools/node.exe ./scripts/x.js'), 'node');
  assert.equal(commandPrefix('ls -la /secret'), 'ls');
  assert.equal(commandPrefix('docker 3f9a2b7c1d logs'), 'docker');
  assert.equal(commandPrefix('   '), null);
});

test('aggregates a human session and never prints prompt text, arguments or file contents', async (context) => {
  const { root, projectPath, projectsRoot, slug, environment } = fixture();
  context.after(() => rmSync(root, { recursive: true, force: true }));
  writeTranscript(path.join(projectsRoot, slug), 'one', humanSession());

  const summary = await mine(projectPath, environment, NOW);
  const text = renderWithinBudget(summary);

  assert.equal(text.includes(SECRET), false);
  assert.equal(summary.sessionsScanned, 1);
  assert.equal(summary.humanSessions, 1);
  assert.equal(summary.from, '2026-11-10');
  assert.deepEqual(summary.commands.map((entry) => entry.name).sort(), ['git push', 'npm test', 'rm']);
  assert.deepEqual(summary.toolFailures, [{ name: 'Read', count: 1, sessions: 1 }]);
  assert.deepEqual(summary.denialsByTool, [{ name: 'Bash', count: 1, sessions: 1 }]);
  assert.deepEqual(summary.denialsByKind, [{ name: 'user-rejected', count: 1, sessions: 1 }]);
  assert.deepEqual(summary.hookBlocks, [{ name: 'Bash', count: 1, sessions: 1 }]);
  assert.deepEqual(summary.skills, [{ name: 'sidequest:plan', count: 1, sessions: 1 }]);
  assert.deepEqual(summary.slashCommands, [{ name: 'quartermaster:outfit', count: 1, sessions: 1 }]);
});

test('skips sessions nobody typed into twice, other projects, and transcripts outside the window', async (context) => {
  const { root, projectPath, projectsRoot, slug, environment } = fixture();
  context.after(() => rmSync(root, { recursive: true, force: true }));
  writeTranscript(path.join(projectsRoot, slug), 'spawned', [prompt('run the hook job'), toolUse('b1', 'Bash', { command: 'make all' })]);
  writeTranscript(path.join(projectsRoot, `${slug}-other`), 'other', humanSession());
  writeTranscript(path.join(projectsRoot, slug), 'old', humanSession(), NOW - 200 * 86400000);
  writeTranscript(path.join(projectsRoot, `${slug}--claude-worktrees-feature`), 'worktree', humanSession());

  const summary = await mine(projectPath, environment, NOW);

  assert.equal(summary.sessionsScanned, 2);
  assert.equal(summary.humanSessions, 1);
  assert.equal(summary.commands.some((entry) => entry.name === 'make'), false);
});

test('output stays within the byte budget however many habits there are', () => {
  const commands = Array.from({ length: 500 }, (_, index) => ({ name: `tool${'x'.repeat(50)}${index} sub`, count: 500 - index, sessions: 1 }));
  const summary = { slug: 'x', commands, toolFailures: commands, denialsByTool: commands, denialsByKind: commands, hookBlocks: commands, skills: commands, slashCommands: commands };

  const text = renderWithinBudget(summary);

  assert.ok(Buffer.byteLength(text) <= OUTPUT_BUDGET_BYTES);
  assert.equal(JSON.parse(text).truncated, true);
});

test('the command line prints one JSON object and writes nothing', (context) => {
  const { root, projectPath, projectsRoot, slug, environment } = fixture();
  context.after(() => rmSync(root, { recursive: true, force: true }));
  writeTranscript(path.join(projectsRoot, slug), 'one', humanSession());
  const before = readdirSync(root, { recursive: true }).sort();

  const run = spawnSync(process.execPath, [SCRIPT, projectPath], { env: { ...process.env, ...environment }, encoding: 'utf8' });

  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).humanSessions, 1);
  assert.deepEqual(readdirSync(root, { recursive: true }).sort(), before);
});
