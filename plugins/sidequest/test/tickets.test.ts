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

test('verify accepts single-quoted jq bindings, named captures and grep patterns on add and update', (context) => {
  const executableDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-verify-tools-'));
  fs.writeFileSync(path.join(executableDirectory, 'jq'), '');
  fs.writeFileSync(path.join(executableDirectory, 'grep'), '');
  const originalPath = process.env.PATH;
  process.env.PATH = executableDirectory + path.delimiter + originalPath;
  context.after(() => { process.env.PATH = originalPath; });
  const commands = [
    "jq -e '.items as $st | $st | length > 0' data.json",
    'jq -r -e \'.name | capture("(?<s>[a-z]+)") | .s\' data.json',
    "grep -c '<li>' index.html",
    "echo '${SQ_VERIFY_UNSET_3864} %SQ_VERIFY_UNSET_3864% $SQ_VERIFY_UNSET_3864'",
    "echo 'literal' '$SQ_VERIFY_UNSET_3864'",
    'echo "it\'s literal"',
  ];
  for (const command of commands) {
    assert.deepEqual(store.verifyCommandErrors(command), [], command);
    const ticket = store.createTicket(slug, { title: 'Quoted verify', executorVerify: command });
    assert.equal(store.updateTicket(slug, ticket.ref, { executorVerify: command }).executorVerify, command);
  }
});

test('verify still refuses unquoted placeholders and variable expansions outside single quotes', () => {
  assert.equal(process.env.SQ_VERIFY_UNSET_3864, undefined);
  const commands = [
    'echo "$SQ_VERIFY_UNSET_3864"',
    'echo "\'$SQ_VERIFY_UNSET_3864\'"',
    'echo ${SQ_VERIFY_UNSET_3864}',
    'echo %SQ_VERIFY_UNSET_3864%',
    "echo 'literal' $SQ_VERIFY_UNSET_3864",
  ];
  for (const command of commands) {
    assert.match(store.verifyCommandErrors(command).join('\n'), /unset environment variable SQ_VERIFY_UNSET_3864/);
    assert.throws(() => store.createTicket(slug, { executorVerify: command }), /unset environment variable SQ_VERIFY_UNSET_3864/);
  }
  assert.match(store.verifyCommandErrors('echo <placeholder>').join('\n'), /unresolved placeholder/);
  assert.match(store.verifyCommandErrors('echo "<placeholder>"').join('\n'), /unresolved placeholder/);
  assert.deepEqual(store.verifyCommandErrors('echo ${SQ_VERIFY_UNSET_3864:-/tmp}'), []);
});

test('verify reports each unset variable once across repeated dollar, brace and percent references', () => {
  const errors = store.verifyCommandErrors('echo $SQ_VERIFY_UNSET_3864 ${SQ_VERIFY_UNSET_3864} %SQ_VERIFY_UNSET_3864% $SQ_VERIFY_UNSET_3864');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /unset environment variable SQ_VERIFY_UNSET_3864/);
});

test('verify shared quote scanner preserves quoted and escaped semicolons', () => {
  assert.deepEqual(store.verifyCommandErrors("echo 'one;two'"), []);
  assert.deepEqual(store.verifyCommandErrors('echo "one;two"'), []);
  assert.deepEqual(store.verifyCommandErrors('echo one\\;two'), []);
  assert.match(store.verifyCommandErrors("echo 'one'; echo two").join('\n'), /cannot use `;` command chaining/);
  assert.match(store.verifyCommandErrors('echo "one"; echo two').join('\n'), /cannot use `;` command chaining/);
});

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
