'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  CACHE_TTL_MS,
  activeInstances,
  compareSemver,
  decide,
  isMaintenancePrompt,
  isTaskNotificationPrompt,
  readState,
  refreshDue,
  sessionStart,
  stateForManifest,
  writeStateAtomic,
} = require('../hooks/user-prompt-freshness.js');

function tempDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-init-freshness-'));
}

function registry(installs) {
  return { plugins: { 'workspace-init@eigenwise-toolshed': installs, 'sidequest@eigenwise-toolshed': [{ scope: 'project', projectPath: 'C:\\dev\\other', version: '1.0.0' }], 'other@elsewhere': [{ scope: 'user', version: '0.0.1' }] } };
}

function manifest(version = '2.0.0') {
  return { name: 'eigenwise-toolshed', version: '3.0.0', plugins: [{ name: 'workspace-init', version }, { name: 'uninstalled', version: '9.0.0' }] };
}

function response(status, body = '', etag = '"etag"') {
  return { status, text: async () => body, headers: { get: (name) => name === 'etag' ? etag : null } };
}

function files(directory, installed = [{ scope: 'user', version: '1.0.0' }]) {
  const registryFile = path.join(directory, 'installed_plugins.json');
  const stateFile = path.join(directory, 'data', 'remote-freshness.json');
  fs.writeFileSync(registryFile, JSON.stringify(registry(installed)));
  return { registryFile, stateFile };
}

test('fresh inventory permits with zero output and does not fetch', async () => {
  const directory = tempDirectory();
  const { registryFile, stateFile } = files(directory);
  writeStateAtomic(fs, stateFile, stateForManifest(manifest('1.0.0'), JSON.stringify(manifest('1.0.0')), null, 100, '"first"'));
  let calls = 0;
  const result = await decide({ prompt: 'ship it', cwd: 'C:\\dev\\project' }, { registryFile, stateFile, platform: 'win32', now: () => 101, fetchFn: async () => { calls += 1; throw new Error('must not fetch'); } });
  assert.equal(result, '');
  assert.equal(calls, 0);
});

test('known stale blocks with the exact structured output contract', async () => {
  const directory = tempDirectory();
  const { registryFile, stateFile } = files(directory);
  writeStateAtomic(fs, stateFile, stateForManifest(manifest('2.0.0'), JSON.stringify(manifest('2.0.0')), null, 100, '"first"'));
  const result = await decide({ prompt: 'work on this', cwd: 'C:\\dev\\project' }, { registryFile, stateFile, platform: 'win32', now: () => 101 });
  const parsed = JSON.parse(result);
  assert.equal(parsed.decision, 'block');
  assert.match(parsed.reason, /workspace-init 1\.0\.0 -> 2\.0\.0/);
  assert.match(parsed.reason, /Run \/update-toolshed/);
});

test('defers to a user-scoped Workbench install before checking stale state', async () => {
  const directory = tempDirectory();
  const { registryFile } = files(directory);
  fs.writeFileSync(registryFile, JSON.stringify({ plugins: { 'workspace-init@eigenwise-toolshed': [{ scope: 'user', version: '1.0.0' }], 'workbench@eigenwise-toolshed': [{ scope: 'user', version: '0.1.0' }] } }));
  let fetched = false;
  const result = await decide({ prompt: 'work on this', cwd: 'C:\\dev\\project' }, { registryFile, stateFile: 'unreadable-state', platform: 'win32', fetchFn: async () => { fetched = true; throw new Error('must not fetch'); } });
  assert.equal(result, '');
  assert.equal(fetched, false);
});

test('does not defer to project-scoped Workbench installs', async () => {
  const directory = tempDirectory();
  const { registryFile, stateFile } = files(directory);
  fs.writeFileSync(registryFile, JSON.stringify({ plugins: { 'workspace-init@eigenwise-toolshed': [{ scope: 'user', version: '1.0.0' }], 'workbench@eigenwise-toolshed': [{ scope: 'project', projectPath: 'C:\\dev\\project', version: '0.1.0' }] } }));
  writeStateAtomic(fs, stateFile, stateForManifest(manifest('2.0.0'), JSON.stringify(manifest('2.0.0')), null, 100, '"first"'));
  assert.match(await decide({ prompt: 'work on this', cwd: 'C:\\dev\\project' }, { registryFile, stateFile, platform: 'win32', now: () => 101 }), /"decision":"block"/);
});

test('stale installs without workspace-init direct users to install Workbench', async () => {
  const directory = tempDirectory();
  const { registryFile, stateFile } = files(directory, []);
  fs.writeFileSync(registryFile, JSON.stringify({ plugins: { 'toolshed-guard@eigenwise-toolshed': [{ scope: 'user', version: '1.0.0' }] } }));
  const remote = { name: 'eigenwise-toolshed', version: '3.0.0', plugins: [{ name: 'toolshed-guard', version: '2.0.0' }] };
  writeStateAtomic(fs, stateFile, stateForManifest(remote, JSON.stringify(remote), null, 100, '"first"'));
  const result = JSON.parse(await decide({ prompt: 'work on this', cwd: 'C:\\dev\\project' }, { registryFile, stateFile, platform: 'win32', now: () => 101 }));
  assert.match(result.reason, /Run \/plugin install workbench@eigenwise-toolshed --scope user/);
});

test('only exact maintenance prompts bypass the guard', () => {
  for (const prompt of ['/update-toolshed', '/workbench:update-toolshed', '/update-toolshed --dry-run', '/reload-plugins', '/reload-plugins --force', '/plugin', '/plugin install workbench@eigenwise-toolshed --scope user', '/plugin update sidequest@eigenwise-toolshed', '/plugin marketplace update eigenwise-toolshed', 'claude plugin marketplace update eigenwise-toolshed', 'claude plugin update sidequest@eigenwise-toolshed --scope user']) assert.equal(isMaintenancePrompt(prompt), true, prompt);
  for (const prompt of ['please run /update-toolshed', '/update-toolshed; work on this', '/reload-plugins and fix it', 'claude plugin update sidequest@eigenwise-toolshed --scope user && rm -rf x', 'I said /plugin update']) assert.equal(isMaintenancePrompt(prompt), false, prompt);
});

const completeTaskNotification = `<task-notification>
<task-id>agent-a73d9245832c778d2</task-id>
<tool-use-id>toolu_01D2s5bnLL6LWzYm1Qf7PsK7</tool-use-id>
<output-file>C:/Users/kenny/AppData/Local/Temp/claude/agent-result.txt</output-file>
<status>completed</status>
<summary>Agent "sidequest-sq-452" completed</summary>
<note>Result written to the output file.</note>
<result>Submitted SQ-452.</result>
<usage>
  <input-tokens>1032</input-tokens>
  <output-tokens>418</output-tokens>
</usage>
<worktree>
  <path>C:/dev/eigenwise-public/eigenwise-toolshed/.claude/worktrees/agent-a73d9245832c778d2</path>
  <branch>agent-a73d9245832c778d2</branch>
</worktree>
</task-notification>`;

const reorderedTaskNotification = `<task-notification>
<note>Result written to the output file.</note>
<usage><input-tokens>1032</input-tokens></usage>
<summary>Agent "sidequest-sq-452" completed</summary>
<status>completed</status>
<worktree><path>C:/dev/eigenwise-public/eigenwise-toolshed</path></worktree>
<task-id>agent-a73d9245832c778d2</task-id>
<output-file>C:/Users/kenny/AppData/Local/Temp/claude/agent-result.txt</output-file>
<tool-use-id>toolu_01D2s5bnLL6LWzYm1Qf7PsK7</tool-use-id>
</task-notification>`;

test('complete native Agent task notifications bypass without registry or fetch work', async () => {
  let reads = 0;
  let fetches = 0;
  const result = await decide({ prompt: completeTaskNotification, cwd: 'C:\\dev\\project' }, {
    fileSystem: { readFileSync: () => { reads += 1; throw new Error('must not read'); } },
    registryFile: 'unreadable-registry',
    stateFile: 'unreadable-state',
    fetchFn: async () => { fetches += 1; throw new Error('must not fetch'); },
  });
  assert.equal(result, '');
  assert.equal(reads, 0);
  assert.equal(fetches, 0);
  assert.equal(isTaskNotificationPrompt(completeTaskNotification), true);
});

test('task notification tags only bypass a complete whole-prompt envelope', async () => {
  const directory = tempDirectory();
  const { registryFile, stateFile } = files(directory);
  writeStateAtomic(fs, stateFile, stateForManifest(manifest('2.0.0'), JSON.stringify(manifest('2.0.0')), null, 100, '"first"'));
  assert.equal(isTaskNotificationPrompt(reorderedTaskNotification), true);
  const invalid = [
    `Please handle this.\n${completeTaskNotification}`,
    `${completeTaskNotification}\nPlease handle this.`,
    completeTaskNotification.replace('</task-notification>', ''),
    completeTaskNotification.replace('<task-id>agent-a73d9245832c778d2</task-id>\n', ''),
    completeTaskNotification.replace('<tool-use-id>toolu_01D2s5bnLL6LWzYm1Qf7PsK7</tool-use-id>\n', ''),
    completeTaskNotification.replace('<status>completed</status>\n', ''),
    completeTaskNotification.replace('<summary>Agent "sidequest-sq-452" completed</summary>\n', ''),
    completeTaskNotification.replace('<note>Result written to the output file.</note>', '<unknown>Result written to the output file.</unknown>'),
    completeTaskNotification.replace('\n<task-id>', '\nUser prose\n<task-id>'),
    completeTaskNotification.replace('Agent "sidequest-sq-452" completed', 'Agent <embedded>sidequest-sq-452</embedded> completed'),
    `quoted ${completeTaskNotification} in a user prompt`,
  ];
  for (const prompt of invalid) {
    assert.equal(isTaskNotificationPrompt(prompt), false, prompt);
    assert.match(await decide({ prompt, cwd: 'C:\\dev\\project' }, { registryFile, stateFile, platform: 'win32', now: () => 101 }), /"decision":"block"/);
  }
});

test('selects user and overlapping project installs, excluding unrelated marketplaces', () => {
  const selected = activeInstances(registry([{ scope: 'user', version: '1.0.0' }, { scope: 'project', projectPath: 'C:\\DEV\\repo', version: '1.1.0' }, { scope: 'local', projectPath: 'C:\\dev\\elsewhere', version: '1.2.0' }]), 'c:/dev/repo/.claude/worktrees/check', 'win32');
  assert.deepEqual(selected.map((entry) => entry.version).sort(), ['1.0.0', '1.1.0']);
});

test('compares SemVer 2 including prereleases', () => {
  assert.equal(compareSemver('1.0.0', '1.0.0'), 0);
  assert.equal(compareSemver('1.0.0-alpha.1', '1.0.0-alpha.beta'), -1);
  assert.equal(compareSemver('1.0.0-alpha', '1.0.0'), -1);
  assert.equal(compareSemver('2.0.0', '1.9.9'), 1);
  assert.equal(compareSemver('broken', '1.0.0'), null);
});

test('expired cache sends ETag and a 304 extends the cache', async () => {
  const directory = tempDirectory();
  const { stateFile } = files(directory);
  writeStateAtomic(fs, stateFile, stateForManifest(manifest('1.0.0'), JSON.stringify(manifest('1.0.0')), null, 1, '"old"'));
  let headers;
  const updated = await refreshDue({ stateFile, now: () => CACHE_TTL_MS + 2, fetchFn: async (_url, options) => { headers = options.headers; return response(304); } });
  assert.equal(headers['If-None-Match'], '"old"');
  assert.equal(updated.freshUntil, CACHE_TTL_MS * 2 + 2);
  assert.equal(readState(fs, stateFile).failureCount, 0);
});

test('valid 200 replaces state while uninstalled plugin changes never block', async () => {
  const directory = tempDirectory();
  const { registryFile, stateFile } = files(directory, [{ scope: 'user', version: '2.0.0' }]);
  const body = JSON.stringify(manifest());
  await refreshDue({ stateFile, now: () => Date.now(), fetchFn: async () => response(200, body) });
  assert.equal(readState(fs, stateFile).plugins.uninstalled, '9.0.0');
  assert.equal(await decide({ prompt: 'continue', cwd: 'C:\\dev\\project' }, { registryFile, stateFile, platform: 'win32', now: () => Date.now() }), '');
});

test('offline refresh preserves a proven stale block and the updated registry clears it', async () => {
  const directory = tempDirectory();
  const { registryFile, stateFile } = files(directory);
  writeStateAtomic(fs, stateFile, stateForManifest(manifest('2.0.0'), JSON.stringify(manifest('2.0.0')), null, 1, '"old"'));
  const options = { registryFile, stateFile, platform: 'win32', now: () => CACHE_TTL_MS + 2, fetchFn: async () => { throw new Error('offline'); } };
  assert.match(await decide({ prompt: 'continue', cwd: 'C:\\dev\\project' }, options), /"decision":"block"/);
  fs.writeFileSync(registryFile, JSON.stringify(registry([{ scope: 'user', version: '2.0.0' }])));
  assert.equal(await decide({ prompt: 'continue', cwd: 'C:\\dev\\project' }, options), '');
});

test('only an exact forced reload clears a registry-proven reload requirement', async () => {
  const directory = tempDirectory();
  const registryFile = path.join(directory, 'installed_plugins.json');
  const stateFile = path.join(directory, 'data', 'remote-freshness.json');
  const reloadStateFile = path.join(directory, 'data', 'reload-required.json');
  const remote = { name: 'eigenwise-toolshed', version: '0.3.0', plugins: [{ name: 'toolshed-guard', version: '0.3.0' }] };
  fs.writeFileSync(registryFile, JSON.stringify({ plugins: { 'toolshed-guard@eigenwise-toolshed': [{ scope: 'user', version: '0.2.0' }] } }));
  writeStateAtomic(fs, stateFile, stateForManifest(remote, JSON.stringify(remote), null, 100, '"first"'));
  const input = { prompt: 'continue', cwd: 'C:\\dev\\project', session_id: 'session-forced-reload' };
  const options = { registryFile, stateFile, reloadStateFile, platform: 'win32', now: () => 101 };

  assert.match(await decide(input, options), /toolshed-guard 0\.2\.0 -> 0\.3\.0/);
  assert.equal(await decide({ ...input, prompt: '/reload-plugins --force' }, options), '');
  assert.match(await decide(input, options), /still needs a reload after detecting toolshed-guard 0\.2\.0/);
  assert.equal(await decide({ ...input, prompt: completeTaskNotification }, options), '');
  assert.match(await decide(input, options), /still needs a reload after detecting toolshed-guard 0\.2\.0/);

  fs.writeFileSync(registryFile, JSON.stringify({ plugins: { 'toolshed-guard@eigenwise-toolshed': [{ scope: 'user', version: '0.3.0' }] } }));
  assert.equal(await decide({ ...input, prompt: '/reload-plugins' }, options), '');
  assert.match(await decide(input, options), /Run \/reload-plugins --force or restart Claude Code/);
  assert.match(await decide({ ...input, prompt: '/reload-plugins --force && continue' }, options), /still needs a reload after detecting toolshed-guard 0\.2\.0/);
  assert.equal(await decide({ ...input, prompt: '/reload-plugins --force' }, options), '');
  assert.equal(await decide(input, options), '');
});

test('reload requirement survives registry update until the next SessionStart boundary', async () => {
  const directory = tempDirectory();
  const { registryFile, stateFile } = files(directory);
  const reloadStateFile = path.join(directory, 'data', 'reload-required.json');
  writeStateAtomic(fs, stateFile, stateForManifest(manifest('2.0.0'), JSON.stringify(manifest('2.0.0')), null, 100, '"first"'));
  const input = { prompt: 'continue', cwd: 'C:\\dev\\project', session_id: 'session-stale-sidequest' };
  const options = { registryFile, stateFile, reloadStateFile, platform: 'win32', now: () => 101 };
  assert.match(await decide(input, options), /workspace-init 1\.0\.0 -> 2\.0\.0/);
  fs.writeFileSync(registryFile, JSON.stringify(registry([{ scope: 'user', version: '2.0.0' }])));
  assert.equal(await decide({ ...input, prompt: '/reload-plugins' }, options), '');
  assert.match(await decide(input, options), /still needs a reload after detecting workspace-init 1\.0\.0/);
  sessionStart({ session_id: input.session_id, source: 'startup' }, { reloadStateFile });
  assert.equal(await decide(input, options), '');
});

test('an abandoned refresh lock recovers and only one fetch produces state', async () => {
  const directory = tempDirectory();
  const { stateFile } = files(directory);
  fs.mkdirSync(`${stateFile}.lock`, { recursive: true });
  const old = new Date(Date.now() - 11_000);
  fs.utimesSync(`${stateFile}.lock`, old, old);
  let calls = 0;
  await refreshDue({ stateFile, now: () => Date.now(), fetchFn: async () => { calls += 1; return response(200, JSON.stringify(manifest())); } });
  assert.equal(calls, 1);
  assert.equal(readState(fs, stateFile).plugins['workspace-init'], '2.0.0');
});

test('loaded toolshed-guard older than the installed registry blocks until reload', async () => {
  const directory = tempDirectory();
  const pluginRoot = path.join(directory, 'loaded');
  fs.mkdirSync(path.join(pluginRoot, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: '1.0.0' }));
  const { registryFile, stateFile } = files(directory);
  fs.writeFileSync(registryFile, JSON.stringify({ plugins: { 'toolshed-guard@eigenwise-toolshed': [{ scope: 'user', version: '2.0.0' }] } }));
  let fetched = false;
  const result = await decide({ prompt: 'continue', cwd: 'C:\\dev\\project' }, { registryFile, stateFile, pluginRoot, platform: 'win32', fetchFn: async () => { fetched = true; return response(200, JSON.stringify(manifest())); } });
  assert.match(result, /still loaded toolshed-guard 1\.0\.0/);
  assert.equal(fetched, false);
});
