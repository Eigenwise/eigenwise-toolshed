'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  activeInstances,
  compareSemver,
  decide,
  isMaintenancePrompt,
} = require('../hooks/user-prompt-freshness.js');

function tempDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-freshness-'));
}

function registry(installs) {
  return { plugins: { 'workbench@eigenwise-toolshed': installs, 'sidequest@eigenwise-toolshed': [{ scope: 'project', projectPath: 'C:\\dev\\other', version: '1.0.0' }], 'other@elsewhere': [{ scope: 'user', version: '0.0.1' }] } };
}

// A session running an OLDER workbench than the installed copy. Each case gets independent
// warning state, so the once-per-session behavior cannot leak between tests.
function reloadPending(directory) {
  const registryFile = path.join(directory, 'installed_plugins.json');
  const pluginRoot = path.join(directory, 'loaded');
  fs.mkdirSync(path.join(pluginRoot, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: '1.0.0' }));
  fs.writeFileSync(registryFile, JSON.stringify({ plugins: { 'workbench@eigenwise-toolshed': [{ scope: 'user', version: '2.0.0' }] } }));
  return {
    registryFile,
    pluginRoot,
    project: path.join(directory, 'consumer'),
    options: {
      registryFile,
      pluginRoot,
      warningStateDirectory: path.join(directory, 'warnings'),
      warnedReloads: new Set(),
    },
  };
}

test('a session with no reload pending permits with empty output and never fetches', () => {
  const directory = tempDirectory();
  const registryFile = path.join(directory, 'installed_plugins.json');
  fs.writeFileSync(registryFile, JSON.stringify(registry([{ scope: 'user', version: '1.0.0' }])));
  let fetches = 0;
  const result = decide({ prompt: 'ship it', cwd: 'C:\\dev\\project' }, { registryFile, platform: 'win32', fetchFn: async () => { fetches += 1; throw new Error('must not fetch'); } });
  assert.equal(result, '');
  assert.equal(fetches, 0);
});

test('installed behind the central marketplace is no longer blocked (regression: SQ-495)', () => {
  // workbench installed at 1.0.0 while the marketplace has since moved far ahead. Previously
  // this hard-blocked EVERY prompt (and trapped unrelated projects on each toolshed release).
  // Being behind is not a corruption risk, so it must permit — and must not reach the network.
  const directory = tempDirectory();
  const registryFile = path.join(directory, 'installed_plugins.json');
  fs.writeFileSync(registryFile, JSON.stringify(registry([{ scope: 'user', version: '1.0.0' }])));
  let fetches = 0;
  const result = decide({ prompt: 'drop this zip and work on it', cwd: 'C:\\dev\\unrelated' }, {
    registryFile, platform: 'win32', fetchFn: async () => { fetches += 1; throw new Error('must not fetch'); },
  });
  assert.equal(result, '');
  assert.equal(fetches, 0);
});

test('loaded workbench older than the installed registry permits the prompt with a reload warning', () => {
  const { pluginRoot, project, options } = reloadPending(tempDirectory());
  const output = JSON.parse(decide({ prompt: 'continue', cwd: project, session_id: 'session-freshness' }, options));
  assert.equal(output.decision, undefined);
  assert.equal(output.hookSpecificOutput.additionalContext, 'Workbench 2.0.0 is installed, but this session loaded 1.0.0. This prompt is proceeding. Reload with /reload-plugins or restart Claude Code before relying on the updated plugin code.');

  fs.writeFileSync(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: '2.0.0' }));
  assert.equal(decide({ prompt: 'continue', cwd: project, session_id: 'session-reloaded' }, options), '');
});

test('maintenance and reload prompts are always allowed, even inside the reload window', () => {
  const { project, options } = reloadPending(tempDirectory());
  for (const prompt of ['/reload-plugins', '/reload-plugins --force', '/update-toolshed', '/plugin']) {
    assert.equal(decide({ prompt, cwd: project }, options), '', prompt);
  }
});

test('the bypass env var disables the guard entirely', () => {
  const { project, options } = reloadPending(tempDirectory());
  const previous = process.env.EIGENWISE_TOOLSHED_FRESHNESS_BYPASS;
  process.env.EIGENWISE_TOOLSHED_FRESHNESS_BYPASS = '1';
  try {
    assert.equal(decide({ prompt: 'continue', cwd: project }, options), '');
  } finally {
    if (previous === undefined) delete process.env.EIGENWISE_TOOLSHED_FRESHNESS_BYPASS;
    else process.env.EIGENWISE_TOOLSHED_FRESHNESS_BYPASS = previous;
  }
});

test('only exact maintenance prompts bypass the guard', () => {
  for (const prompt of ['/update-toolshed', '/update-toolshed --dry-run', '/workbench:update-toolshed', '/workbench:update-toolshed --check', '/workbench-doctor', '/workbench:workbench-doctor', '/reload-plugins', '/reload-plugins --force', '/plugin', '/plugin update sidequest@eigenwise-toolshed', '/plugin marketplace update eigenwise-toolshed', 'claude plugin marketplace update eigenwise-toolshed', 'claude plugin update sidequest@eigenwise-toolshed --scope user']) assert.equal(isMaintenancePrompt(prompt), true, prompt);
  for (const prompt of ['please run /update-toolshed', '/update-toolshed; work on this', '/workbench:update-toolshed; work on this', '/workbench:workbench-doctor now', '/reload-plugins and fix it', 'claude plugin update sidequest@eigenwise-toolshed --scope user && rm -rf x', 'I said /plugin update']) assert.equal(isMaintenancePrompt(prompt), false, prompt);
});

test('all prompts pass through and warn only once for the session', () => {
  const { project, registryFile, options } = reloadPending(tempDirectory());
  const first = JSON.parse(decide({ prompt: 'keep working', cwd: project, session_id: 'session-warning' }, options));
  assert.equal(first.decision, undefined);
  assert.match(first.hookSpecificOutput.additionalContext, /This prompt is proceeding\./);
  fs.writeFileSync(registryFile, JSON.stringify({ plugins: { 'workbench@eigenwise-toolshed': [{ scope: 'user', version: '3.0.0' }] } }));
  assert.equal(decide({ prompt: 'continue', cwd: project, session_id: 'session-warning' }, options), '');

  const nextSession = JSON.parse(decide({ prompt: 'continue', cwd: project, session_id: 'another-session' }, options));
  assert.match(nextSession.hookSpecificOutput.additionalContext, /Workbench 3\.0\.0 is installed/);
});

test('selects user and overlapping project installs, excluding unrelated marketplaces', () => {
  const selected = activeInstances(registry([{ scope: 'user', version: '1.0.0' }, { scope: 'project', projectPath: 'C:\\DEV\\repo', version: '1.1.0' }, { scope: 'local', projectPath: 'C:\\dev\\elsewhere', version: '1.2.0' }]), 'c:/dev/repo/.claude/worktrees/check', 'eigenwise-toolshed', 'win32');
  assert.deepEqual(selected.map((entry) => entry.version).sort(), ['1.0.0', '1.1.0']);
});

test('compares SemVer 2 including prereleases', () => {
  assert.equal(compareSemver('1.0.0', '1.0.0'), 0);
  assert.equal(compareSemver('1.0.0-alpha.1', '1.0.0-alpha.beta'), -1);
  assert.equal(compareSemver('1.0.0-alpha', '1.0.0'), -1);
  assert.equal(compareSemver('2.0.0', '1.9.9'), 1);
  assert.equal(compareSemver('broken', '1.0.0'), null);
});
