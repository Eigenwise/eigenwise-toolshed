'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');
const { mine } = require('../lib/mine.js');
const { slugForProject } = require('../lib/paths.js');
const { resolveWindow } = require('../lib/scan.js');

function git(directory, argumentsList) {
  return execFileSync('git', ['-C', directory, ...argumentsList], { encoding: 'utf8', windowsHide: true });
}

function transcript(root, checkout, name, cwd, modifiedMs) {
  const directory = path.join(root, slugForProject(checkout));
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${name}.jsonl`);
  fs.writeFileSync(file, `malformed\n${JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: 'no, use the existing form' } })}\n`);
  fs.utimesSync(file, modifiedMs / 1000, modifiedMs / 1000);
  return file;
}

test('mine admits linked-checkout cwd sessions before applying the shared window cap', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'quartermaster-worktrees-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const project = path.join(directory, 'project');
  const linked = path.join(directory, 'linked');
  const root = path.join(directory, 'projects');
  fs.mkdirSync(project);
  git(project, ['init']);
  git(project, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture']);
  git(project, ['worktree', 'add', '--detach', linked]);
  const now = Date.now();
  transcript(root, project, 'main', project, now - 3000);
  const linkedFile = transcript(root, linked, 'linked', linked, now - 1000);
  transcript(root, linked, 'foreign', directory, now);
  transcript(root, linked, 'sibling-prefix', `${linked}-other`, now);
  transcript(root, linked, 'missing-cwd', undefined, now);
  transcript(root, linked, 'expired', linked, now - 40 * 86400000);
  const subagents = path.join(root, slugForProject(linked), 'linked', 'subagents');
  fs.mkdirSync(subagents, { recursive: true });
  fs.writeFileSync(path.join(subagents, 'agent.jsonl'), '{}');

  const options = { projectPath: project, root, days: 30, sessions: 1, now };
  const window = resolveWindow(options);
  assert.equal(window.sessionsAvailable, 2);
  assert.equal(window.boundBy, 'sessions');
  assert.equal(window.sessions[0].file, linkedFile);
  assert.equal(window.subagentsScanned, 1);
  assert.equal(resolveWindow({ ...options, projectPath: linked }).sessionsAvailable, 2);
  const output = await mine({ ...options, env: { CLAUDE_CONFIG_DIR: directory, QUARTERMASTER_STATE_DIR: path.join(directory, 'state') } });
  assert.equal(output.window.sessionsScanned, 1);
  assert.equal(output.friction.corrections.count, 1);
});

test('non-git project admits nested cwd and keeps explicit and global scans available', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'quartermaster-scan-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const project = path.join(directory, 'project');
  const nested = path.join(project, 'src');
  const root = path.join(directory, 'projects');
  fs.mkdirSync(nested, { recursive: true });
  const now = Date.now();
  transcript(root, project, 'nested', nested, now);
  transcript(root, project, 'foreign', directory, now);
  const file = transcript(root, project, 'long-record', nested, now);
  fs.writeFileSync(file, `${JSON.stringify({ padding: 'x'.repeat(70000) })}\n${JSON.stringify({ cwd: nested })}`);
  const options = { projectPath: project, root, now: now + 1000 };
  assert.equal(resolveWindow(options).sessionsAvailable, 2);
  assert.equal(resolveWindow({ ...options, slug: slugForProject(project) }).sessionsAvailable, 3);
  assert.equal(resolveWindow({ ...options, allProjects: true }).sessionsAvailable, 3);
});
