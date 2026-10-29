import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { cut } from '../cut.mjs';
import { makeGitRepo } from './realrepo.mjs';

const sidequestRoot = fileURLToPath(new URL('../../../plugins/sidequest/', import.meta.url));

function boardCommand(repo, argumentsList) {
  const result = spawnSync(process.execPath, [path.join(repo.root, 'plugins/sidequest/bin/sidequest.js'), ...argumentsList, '--project', repo.root], {
    cwd: repo.root, encoding: 'utf8', timeout: 15000,
    env: { ...process.env, SIDEQUEST_HOME: path.join(repo.base, 'board'), SIDEQUEST_TEST_MODE: '1', CLAUDE_PLUGIN_ROOT: path.join(repo.root, 'plugins/sidequest') },
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  return JSON.parse(result.stdout);
}

function seedBoard(repo) {
  mkdirSync(path.join(repo.root, 'plugins/sidequest/scripts'), { recursive: true });
  for (const file of ['package.json', 'scripts/owned-process-tree.js']) cpSync(path.join(sidequestRoot, file), path.join(repo.root, 'plugins/sidequest', file), { recursive: true });
  for (const directory of ['bin', 'lib']) cpSync(path.join(sidequestRoot, directory), path.join(repo.root, 'plugins/sidequest', directory), { recursive: true });
  const result = spawnSync(process.execPath, ['-e', `
    const store = require('./plugins/sidequest/lib/store.js');
    const database = require('./plugins/sidequest/lib/db.js');
    const { slug } = store.ensureProject(process.cwd());
    for (const title of ['First delivery', 'Second delivery']) {
      const ticket = store.createTicket(slug, { title, status: 'done' });
      ticket.completion = { delivery: { commit: '${'a'.repeat(40)}', targetBranch: 'develop' } };
      database.putRow(database.openDb(process.env.SIDEQUEST_HOME), 'tickets', { id: ticket.id, project: slug, ref: ticket.ref, status: 'done', archived: 0, ord: 0, claim_by: null, data: ticket });
    }
  `], { cwd: repo.root, encoding: 'utf8', timeout: 15000, env: { ...process.env, SIDEQUEST_HOME: path.join(repo.base, 'board'), SIDEQUEST_TEST_MODE: '1' } });
  assert.equal(result.status, 0, result.stderr);
}

test('prepare records both fragment tickets through the checkout CLI and repeats add nothing', async (context) => {
  const repo = makeGitRepo();
  context.after(repo.cleanup);
  seedBoard(repo);
  repo.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'patch' });
  repo.writeFragment('SQ-2', { plugins: ['workbench'], bump: 'patch' });
  repo.commit('integrate');
  const previousHome = process.env.SIDEQUEST_HOME;
  process.env.SIDEQUEST_HOME = path.join(repo.base, 'board');
  context.after(() => { if (previousHome === undefined) delete process.env.SIDEQUEST_HOME; else process.env.SIDEQUEST_HOME = previousHome; });
  const logs = [];
  const options = { repoRoot: repo.root, prepare: true, baseBranch: 'main', branchCheck: false, skipTests: true, log: (line) => logs.push(line) };
  const first = await cut(options);
  assert.equal(first.status, 'prepared');
  for (const [ref, plugin] of [['SQ-1', 'sidequest@3.6.18'], ['SQ-2', 'workbench@0.63.7']]) {
    const completion = boardCommand(repo, ['completion', ref, '--json']);
    assert.equal(completion.stage, 'released');
    assert.deepEqual(completion.facts.release, { version: first.plan.tag, evidence: 'release-record' });
    const duplicate = boardCommand(repo, ['release-record', ref, '--version', first.plan.tag, '--commit', first.commit, '--plugin', plugin]);
    assert.equal(duplicate.recorded, false);
    assert.equal(duplicate.record.commit, first.commit);
    assert.deepEqual(duplicate.record.plugins, [plugin]);
    assert.equal(duplicate.record.deliveryCommit, 'a'.repeat(40));
  }
  const second = await cut(options);
  assert.equal(second.status, 'nothing-to-release');
  assert.equal(logs.some((line) => line.startsWith('Warning:')), false);
});

test('prepare without an available board warns with every missed ref and completes', async (context) => {
  const repo = makeGitRepo();
  context.after(repo.cleanup);
  repo.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'patch' });
  repo.writeFragment('SQ-2', { plugins: ['workbench'], bump: 'patch' });
  repo.commit('integrate');
  const logs = [];
  const result = await cut({ repoRoot: repo.root, prepare: true, baseBranch: 'main', skipTests: true, log: (line) => logs.push(line) });
  assert.equal(result.status, 'prepared');
  assert.match(logs.join('\n'), /Warning: release records unavailable for SQ-1, SQ-2; release preparation continues/);
  assert.equal(repo.git('rev-parse', 'HEAD'), result.commit);
});
