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
  isAgentGeneratedPrompt,
  isMaintenancePrompt,
  isToolshedDevProject,
} = require('../hooks/user-prompt-freshness.js');

const ambientProjectDirectory = process.env.CLAUDE_PROJECT_DIR;

// CLAUDE_PROJECT_DIR is a dev-checkout signal to the hook, so an ambient value from whatever
// session runs this suite would turn every hard-block assertion below into a reload warning.
test.before(() => { delete process.env.CLAUDE_PROJECT_DIR; });
test.after(() => { if (ambientProjectDirectory !== undefined) process.env.CLAUDE_PROJECT_DIR = ambientProjectDirectory; });

function tempDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-freshness-'));
}

function registry(installs) {
  return { plugins: { 'workbench@eigenwise-toolshed': installs, 'sidequest@eigenwise-toolshed': [{ scope: 'project', projectPath: 'C:\\dev\\other', version: '1.0.0' }], 'other@elsewhere': [{ scope: 'user', version: '0.0.1' }] } };
}

// A session running an OLDER workbench than the one installed: the only state that hard-blocks.
// `project` lives under the temp root so it is absolute on the running platform and has no
// marketplace manifest above it — a Windows-shaped literal is relative on Linux, and resolving it
// against the suite's cwd walked dev-checkout detection straight into this repo. The per-case
// warning set and state directory keep warn-once decisions from leaking between tests.
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

test('loaded workbench older than the installed registry blocks until reload', () => {
  const { pluginRoot, project, options } = reloadPending(tempDirectory());
  assert.match(decide({ prompt: 'continue', cwd: project }, options), /still loaded workbench 1\.0\.0 while the installed version is 2\.0\.0/);

  // Reloading catches the loaded version up to installed and clears the block.
  fs.writeFileSync(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: '2.0.0' }));
  assert.equal(decide({ prompt: 'continue', cwd: project }, options), '');
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

const monitorEventNotification = `<task-notification>
<task-id>monitor-s7-evals</task-id>
<summary>Monitor event: "S7 evals and training failures"</summary>
<event>{"event":"monitor","failures":3}</event>
If this event is something the user would act on now, send a PushNotification with the relevant details.
</task-notification>`;

test('agent-generated continuations pass with one reload warning', () => {
  const { project, options } = reloadPending(tempDirectory());
  const prompt = '<agent-message>Executor completed.</agent-message>';
  const first = JSON.parse(decide({ prompt, cwd: project, session_id: 'session-agent' }, options));
  assert.equal(first.hookSpecificOutput.additionalContext, 'Workbench 2.0.0 installed, session loaded 1.0.0. Reload when convenient.');
  assert.equal(decide({ prompt, cwd: project, session_id: 'session-agent' }, options), '');
  assert.equal(isAgentGeneratedPrompt(prompt), true);
  assert.equal(isAgentGeneratedPrompt('<local-command-caveat>Use the CLI result.</local-command-caveat>'), true);
  assert.equal(isAgentGeneratedPrompt(completeTaskNotification), true);
  assert.equal(isAgentGeneratedPrompt(monitorEventNotification), true);
});

test('task-notification prefixes never hard-block during a reload window', () => {
  const { project, options } = reloadPending(tempDirectory());
  const result = JSON.parse(decide({
    prompt: monitorEventNotification,
    cwd: project,
    session_id: 'session-monitor',
  }, options));
  assert.equal(result.hookSpecificOutput.additionalContext, 'Workbench 2.0.0 installed, session loaded 1.0.0. Reload when convenient.');
  assert.equal(decide({
    prompt: '<task-notification>unrecognized shape',
    cwd: project,
    session_id: 'session-monitor',
  }, options), '');
  assert.match(decide({
    prompt: 'quoted <task-notification>unrecognized shape',
    cwd: project,
  }, options), /"decision":"block"/);
});

test('toolshed source checkout warns instead of blocking a human prompt', () => {
  const directory = tempDirectory();
  const { options } = reloadPending(directory);
  const project = path.join(directory, 'toolshed', 'plugins', 'workbench');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(path.join(directory, 'toolshed', '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'toolshed', '.claude-plugin', 'marketplace.json'), JSON.stringify({
    name: 'eigenwise-toolshed',
    plugins: [{ name: 'workbench', source: './plugins/workbench' }],
  }));
  const result = JSON.parse(decide({ prompt: 'keep working', cwd: project, session_id: 'session-dev' }, options));
  assert.equal(result.hookSpecificOutput.additionalContext, 'Workbench 2.0.0 installed, session loaded 1.0.0. Reload when convenient.');
});

test('ordinary human prompts still hard-block during a reload window', () => {
  const { project, options } = reloadPending(tempDirectory());
  assert.match(decide({ prompt: 'keep working', cwd: project }, options), /"decision":"block"/);
});

// This suite runs from plugins/workbench, so a relative cwd resolves inside the toolshed checkout
// and would find the repo's own marketplace manifest if the walk did not require an absolute path.
test('a project directory that is not absolute is never a toolshed checkout', () => {
  const { options } = reloadPending(tempDirectory());
  const relative = path.join('plugins', 'workbench');
  assert.equal(isToolshedDevProject({ cwd: relative }, fs), false);
  assert.match(decide({ prompt: 'keep working', cwd: relative }, options), /"decision":"block"/);
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
