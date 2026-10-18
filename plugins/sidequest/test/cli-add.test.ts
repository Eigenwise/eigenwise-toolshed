import './_temp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-gh-import-'));
const stub = path.join(directory, 'gh-stub.cjs');
fs.writeFileSync(stub, `if (/gh(?:\\.exe)?$/.test(process.execPath)) {
  require('node:fs').writeFileSync(process.env.GH_ARGUMENTS, JSON.stringify([require('node:path').basename(process.argv[1]), ...process.argv.slice(2)]));
  if (process.env.GH_FAIL) { process.stderr.write('authentication required'); process.exit(1); }
  process.stdout.write(JSON.stringify({number: 123, title: 'Imported issue', body: 'Before<!-- private --> ![image](https://example.com/x.png) <img src="x"> After', url: process.env.GH_URL}));
  process.exit(0);
}`);
const executable = path.join(directory, process.platform === 'win32' ? 'gh.exe' : 'gh');
fs.linkSync(process.execPath, executable);
const environment = {
  ...process.env,
  PATH: directory + path.delimiter + process.env.PATH,
  NODE_OPTIONS: (process.env.NODE_OPTIONS ?? '') + ' --require=' + JSON.stringify(stub.replaceAll('\\', '/')),
  SIDEQUEST_HOME: path.join(directory, 'home'),
  CLAUDE_PROJECT_DIR: directory,
  GH_ARGUMENTS: path.join(directory, 'arguments.json'),
  GH_URL: 'https://github.com/owner/repo/issues/123',
};

function run(arguments_: string[], extra: Record<string, string> = {}) {
  return spawnSync(process.execPath, [path.join(root, 'bin/sidequest.js'), ...arguments_], { env: { ...environment, ...extra }, encoding: 'utf8', timeout: 30000 });
}

test('CLI --github imports sanitized issue and PR bodies using gh on PATH', () => {
  const { sanitizeIssueBody } = require('../lib/github-import');
  assert.equal(sanitizeIssueBody('Before ![image][ref] ![shortcut] <!--hidden--> After'), 'Before    After');
  for (const kind of ['issues', 'pull']) {
    const url = 'https://github.com/owner/repo/' + kind + '/123';
    const result = run(['add', '--github', url, '--unclassified', '--json'], { GH_URL: url });
    assert.equal(result.status, 0, result.stderr);
    const ticket = JSON.parse(result.stdout).ticket;
    assert.equal(ticket.title, 'GH-123: Imported issue');
    assert.equal(ticket.description, 'Before   After');
    assert.deepEqual(ticket.externalRefs, [{ key: 'GH-123', url }]);
    assert.deepEqual(JSON.parse(fs.readFileSync(environment.GH_ARGUMENTS, 'utf8')), [kind === 'pull' ? 'pr' : 'issue', 'view', url, '--json', 'number,title,body,url']);
  }
});

test('CLI GitHub failures name authentication and retry commands', () => {
  const result = run(['add', '--github', environment.GH_URL, '--unclassified'], { GH_FAIL: '1' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /gh auth login/);
  assert.match(result.stderr, /gh issue view/);
  const missing = run(['add', '--github', environment.GH_URL, '--unclassified'], { PATH: '' });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /Install gh if missing/);
  assert.match(missing.stderr, /gh auth login/);
});

test('CLI --refs works on add and update', () => {
  const added = run(['add', '-t', 'Refs', '--refs', 'owner/repo#9', '--unclassified', '--json']);
  assert.equal(added.status, 0, added.stderr);
  const ticket = JSON.parse(added.stdout).ticket;
  const updated = run(['update', ticket.ref, '--refs', 'ABC-22', '--json']);
  assert.equal(updated.status, 0, updated.stderr);
  assert.deepEqual(JSON.parse(updated.stdout).ticket.externalRefs, [{ key: 'ABC-22', url: null }]);
});
