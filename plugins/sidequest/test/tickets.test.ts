import './_temp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

process.env.SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-refs-home-'));
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-refs-project-'));
process.env.CLAUDE_PROJECT_DIR = project;
const store = require('../lib/store');
const slug = store.ensureProject(project).slug;
execFileSync('git', ['init', '-b', 'main', project], { stdio: 'pipe' });
execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:owner/repository.git'], { cwd: project });

const { githubRepository } = require('../lib/external-refs');

test('ticket refs normalize every accepted form, dedupe keys and reject unknown forms', () => {
  const cases = [
    ['GH-123', 'GH-123', 'https://github.com/owner/repository/issues/123'],
    ['#123', 'GH-123', 'https://github.com/owner/repository/issues/123'],
    ['other/repo#42', 'GH-42', 'https://github.com/other/repo/issues/42'],
    ['https://github.com/other/repo/issues/41', 'GH-41', 'https://github.com/other/repo/issues/41'],
    ['https://github.com/other/repo/pull/40', 'GH-40', 'https://github.com/other/repo/pull/40'],
    ['ABC2-39', 'ABC2-39', null],
  ];
  for (const [input, key, url] of cases) {
    const ticket = store.createTicket(slug, { title: 'Reference normalization', refs: [input, input] });
    assert.deepEqual(ticket.externalRefs, [{ key, url }]);
  }
  assert.throws(() => store.createTicket(slug, { refs: ['https://evil.test/issues/1'] }), /Accepted: GH-123/);
  assert.throws(() => store.createTicket(slug, { refs: 'GH-1' }), /array of strings/);
  assert.throws(() => store.createTicket(slug, { refs: [123] }), /array of strings/);
});

test('Jira configuration resolves keys and updates preserve or replace refs', () => {
  const config = store.setBoardConfig(slug, { jiraBaseUrl: 'https://team.atlassian.net/' });
  assert.equal(config.config.jiraBaseUrl, 'https://team.atlassian.net');
  const ticket = store.createTicket(slug, { refs: ['ABC-12'] });
  assert.deepEqual(ticket.externalRefs, [{ key: 'ABC-12', url: 'https://team.atlassian.net/browse/ABC-12' }]);
  assert.deepEqual(store.updateTicket(slug, ticket.ref, { title: 'Kept' }).externalRefs, ticket.externalRefs);
  assert.deepEqual(store.updateTicket(slug, ticket.ref, { refs: [] }).externalRefs, []);
  assert.throws(() => store.setBoardConfig(slug, { jiraBaseUrl: 'javascript:alert(1)' }), /HTTP/);
  assert.throws(() => store.setBoardConfig(slug, { jiraBaseUrl: 'https://user:secret@example.com' }), /credentials/);
  store.setBoardConfig(slug, { jiraBaseUrl: null });
});

test('GitHub origin parsing accepts native remote forms and local refs require an origin', () => {
  for (const remote of ['git@github.com:owner/repo.git', 'https://github.com/owner/repo.git', 'ssh://git@github.com/owner/repo.git']) {
    assert.equal(githubRepository(remote), 'owner/repo');
  }
  assert.equal(githubRepository('https://github.com.evil.test/owner/repo'), null);
  execFileSync('git', ['remote', 'remove', 'origin'], { cwd: project });
  assert.throws(() => store.createTicket(slug, { refs: ['#1'] }), /GitHub origin required/);
});
