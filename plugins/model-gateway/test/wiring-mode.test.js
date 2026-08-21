'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const CLI = path.join(__dirname, '..', 'bin', 'model-gateway.js');
const DEFAULT_BASE_URL = 'http://127.0.0.1:9';
const COMPAT_BASE_URL = 'http://api.anthropic.com';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-wiring-'));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { home, project };
}

function run(home, project, args) {
  const { ANTHROPIC_BASE_URL, ...environment } = process.env;
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: project,
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...environment,
      HOME: home,
      USERPROFILE: home,
      CODEX_GATEWAY_PORT: '9',
      CODEX_GATEWAY_PROXY_PORT: '9',
    },
  });
  assert.ifError(result.error);
  return { code: result.status, output: result.stdout + result.stderr };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function wireProject(project, baseUrl = DEFAULT_BASE_URL) {
  writeJson(path.join(project, '.claude', 'settings.local.json'), { env: { ANTHROPIC_BASE_URL: baseUrl } });
}

function wiringConfig(home) {
  return path.join(home, '.claude', 'model-gateway', 'wiring.json');
}

function projectRegistry(home) {
  return path.join(home, '.claude', 'model-gateway', 'wired-projects.json');
}

test('env --write-project wires the current project-local settings', (t) => {
  const { home, project } = fixture(t);

  assert.equal(run(home, project, ['env', '--write-project']).code, 0);
  const settings = JSON.parse(fs.readFileSync(path.join(project, '.claude', 'settings.local.json'), 'utf8'));
  assert.equal(settings.env.ANTHROPIC_BASE_URL, DEFAULT_BASE_URL);
  assert.equal(fs.existsSync(path.join(home, '.claude', 'settings.json')), false);
});

test('env --write-user keeps a deliberate shared fallback available', (t) => {
  const { home, project } = fixture(t);

  assert.equal(run(home, project, ['env', '--write-user']).code, 0);
  const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  assert.equal(settings.env.ANTHROPIC_BASE_URL, DEFAULT_BASE_URL);
});

test('retired wiring-mode flags fail loudly', (t) => {
  const { home, project } = fixture(t);

  for (const retired of [['env', '--mode', 'local'], ['env', '--mode', 'global'], ['env', '--show-mode']]) {
    const result = run(home, project, retired);
    assert.equal(result.code, 2, `${retired.join(' ')} should exit 2`);
    assert.match(result.output, /env --write-project/);
  }
  assert.equal(fs.existsSync(path.join(project, '.claude', 'settings.local.json')), false);
});

test('writing project wiring retires a stale local wiring-mode config', (t) => {
  const { home, project } = fixture(t);
  writeJson(wiringConfig(home), { mode: 'local' });

  assert.equal(run(home, project, ['env', '--write-project']).code, 0);
  assert.equal(fs.existsSync(wiringConfig(home)), false);
});

test('project wiring registry records writes and prunes missing or unowned settings', (t) => {
  const { home, project } = fixture(t);
  const otherProject = path.join(path.dirname(project), 'other-project');
  fs.mkdirSync(otherProject);

  wireProject(project);
  wireProject(otherProject);
  assert.equal(run(home, project, ['env', '--write-user']).code, 0);
  assert.equal(run(home, otherProject, ['env', '--write-user']).code, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(projectRegistry(home), 'utf8')).projects, [project, otherProject]);

  fs.rmSync(path.join(project, '.claude', 'settings.local.json'));
  writeJson(path.join(otherProject, '.claude', 'settings.local.json'), { env: { ANTHROPIC_BASE_URL: 'http://user-owned.example' } });
  assert.equal(run(home, project, ['env', '--write-user']).code, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(projectRegistry(home), 'utf8')).projects, []);
});

test('project wiring registry deduplicates an existing project alias', (t) => {
  const { home, project } = fixture(t);
  const alias = path.join(path.dirname(project), 'project-alias');
  fs.symlinkSync(project, alias, 'junction');
  wireProject(project);

  assert.equal(run(home, project, ['env', '--write-user']).code, 0);
  assert.equal(run(home, alias, ['env', '--write-user']).code, 0);
  assert.equal(JSON.parse(fs.readFileSync(projectRegistry(home), 'utf8')).projects.length, 1);
});

test('user wiring reports conflicting current project wiring without changing it', (t) => {
  const { home, project } = fixture(t);
  const localFile = path.join(project, '.claude', 'settings.local.json');
  writeJson(localFile, { env: { ANTHROPIC_BASE_URL: COMPAT_BASE_URL, UNRELATED: 'keep-me' } });
  const before = fs.readFileSync(localFile, 'utf8');

  const result = run(home, project, ['env', '--write-user']);

  assert.equal(result.code, 0);
  assert.match(result.output, /1 recorded project-local wiring entry overrides the user-scoped URL/);
  assert.match(result.output, new RegExp(localFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(result.output, /--reconcile/);
  assert.equal(fs.readFileSync(localFile, 'utf8'), before);
  assert.deepEqual(JSON.parse(fs.readFileSync(projectRegistry(home), 'utf8')).projects, [project]);
});

test('user-fallback reconciliation removes only plugin-owned project env entries', (t) => {
  const { home, project } = fixture(t);
  const localFile = path.join(project, '.claude', 'settings.local.json');
  wireProject(project, COMPAT_BASE_URL);
  writeJson(localFile, { env: { ANTHROPIC_BASE_URL: COMPAT_BASE_URL, UNRELATED: 'keep-me' } });

  const result = run(home, project, ['env', '--write-user', '--reconcile']);

  assert.equal(result.code, 0);
  assert.match(result.output, /removed model-gateway-owned wiring from 1 project/);
  assert.deepEqual(JSON.parse(fs.readFileSync(localFile, 'utf8')), { env: { UNRELATED: 'keep-me' } });
  assert.deepEqual(JSON.parse(fs.readFileSync(projectRegistry(home), 'utf8')).projects, []);
});

test('user-fallback reconciliation leaves agreeing project wiring alone', (t) => {
  const { home, project } = fixture(t);
  const localFile = path.join(project, '.claude', 'settings.local.json');
  wireProject(project);
  const before = fs.readFileSync(localFile, 'utf8');

  const result = run(home, project, ['env', '--write-user', '--reconcile']);

  assert.equal(result.code, 0);
  assert.doesNotMatch(result.output, /recorded project-local wiring .* overrides/);
  assert.equal(fs.readFileSync(localFile, 'utf8'), before);
  assert.deepEqual(JSON.parse(fs.readFileSync(projectRegistry(home), 'utf8')).projects, [project]);
});

test('doctor fails when wiring is not configured', (t) => {
  const { home, project } = fixture(t);

  const result = run(home, project, ['doctor']);

  assert.notEqual(result.code, 0);
  assert.match(result.output, /wiring is not configured/);
  assert.match(result.output, /env --write-project/);
});

test('doctor skips a project env block without ANTHROPIC_BASE_URL', (t) => {
  const { home, project } = fixture(t);
  writeJson(path.join(home, '.claude', 'settings.json'), { env: { ANTHROPIC_BASE_URL: DEFAULT_BASE_URL } });
  writeJson(path.join(project, '.claude', 'settings.local.json'), { env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' } });

  const result = run(home, project, ['doctor']);

  assert.doesNotMatch(result.output, /masks global user wiring/);
  assert.match(result.output, /user settings\.json: wired .*\[effective\]/);
  assert.match(result.output, /project settings\.local\.json: not wired .*\[default write target\]/);
});

test('user fallback preserves existing user env values', (t) => {
  const { home, project } = fixture(t);
  const userSettings = path.join(home, '.claude', 'settings.json');
  writeJson(userSettings, {
    env: {
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
      CLAUDE_CODE_USE_POWERSHELL_TOOL: '1',
    },
  });

  assert.equal(run(home, project, ['env', '--write-user']).code, 0);
  const settings = JSON.parse(fs.readFileSync(userSettings, 'utf8'));
  assert.equal(settings.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS, '1');
  assert.equal(settings.env.CLAUDE_CODE_USE_POWERSHELL_TOOL, '1');
  assert.equal(settings.env.ANTHROPIC_BASE_URL, DEFAULT_BASE_URL);
});

const SETTINGS_WIRING = path.join(__dirname, '..', 'lib', 'settings-wiring.js');
const COMMANDS = path.join(__dirname, '..', 'lib', 'commands.js');

function runNode(home, project, script, extraEnv = {}) {
  const { ANTHROPIC_BASE_URL, ...environment } = process.env;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: project,
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...environment,
      HOME: home,
      USERPROFILE: home,
      CODEX_GATEWAY_PORT: '9',
      CODEX_GATEWAY_PROXY_PORT: '9',
      ...extraEnv,
    },
  });
  assert.ifError(result.error);
  return { code: result.status, output: result.stdout + result.stderr };
}

function resolveEffective(home, project, extraEnv) {
  const result = runNode(home, project, `process.stdout.write(JSON.stringify(require(${JSON.stringify(SETTINGS_WIRING)}).effectiveBaseUrl()))`, extraEnv);
  assert.equal(result.code, 0);
  return JSON.parse(result.output);
}

function runDoctor(home, project) {
  const readiness = {
    ready: true,
    state: 'ready',
    checks: { proxyBinary: false, proxyModels: true, codexAuth: true, shimRunning: true, servingVersion: 'test', servingVersionMatches: true },
  };
  return runNode(home, project, `require(${JSON.stringify(COMMANDS)}).commands.doctor({ readiness: ${JSON.stringify(readiness)} })`);
}

test('doctor reports project-local wiring as the effective source', (t) => {
  const { home, project } = fixture(t);
  wireProject(project);

  const result = runDoctor(home, project);

  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /wiring: effective project settings\.local\.json .*\[model-gateway\]/);
  assert.match(result.output, /default wiring target: this project's \.claude\/settings\.local\.json/);
  assert.match(result.output, /project settings\.local\.json: wired .*\[effective\] \[default write target\]/);
  assert.match(result.output, /user settings\.json: not wired/);
});

test('SessionStart local wiring notice does not say the project is unwired', (t) => {
  const { home, project } = fixture(t);
  wireProject(project);

  const result = runNode(home, project, `
    const { effectiveBaseUrl } = require(${JSON.stringify(SETTINGS_WIRING)});
    const { sessionStartWiringNotice } = require(${JSON.stringify(COMMANDS)});
    process.stdout.write(sessionStartWiringNotice({
      readiness: { checks: { codexAuth: true } },
      effectiveWiring: effectiveBaseUrl(),
      projectWirings: [],
    }));
  `);

  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /wired to model-gateway through project settings\.local\.json/);
  assert.doesNotMatch(result.output, /not wired to model-gateway/);
});

test('SessionStart skips unwired notices for project-local wiring without a user setting', (t) => {
  const { home, project } = fixture(t);
  wireProject(project);

  const result = runNode(home, project, `
    const { isWired, sessionStartWiringNotice, effectiveBaseUrl } = require(${JSON.stringify(COMMANDS)});
    if (!isWired()) process.stdout.write(sessionStartWiringNotice({
      readiness: { checks: { codexAuth: true } },
      effectiveWiring: effectiveBaseUrl(),
      projectWirings: [],
    }));
  `);

  assert.equal(result.code, 0, result.output);
  assert.equal(result.output, '');
});

test('SessionStart names recorded project-local wiring before project setup', (t) => {
  const { home, project } = fixture(t);
  const siblingFile = path.join(path.dirname(project), 'sibling', '.claude', 'settings.local.json');

  const result = runNode(home, project, `
    const { sessionStartWiringNotice } = require(${JSON.stringify(COMMANDS)});
    process.stdout.write(sessionStartWiringNotice({
      readiness: { checks: { codexAuth: true } },
      effectiveWiring: { source: null, file: null, value: null },
      projectWirings: [{ file: ${JSON.stringify(siblingFile)} }],
    }));
  `);

  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /recorded project-local wiring exists/);
  assert.match(result.output, new RegExp(siblingFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(result.output, /this project's \.claude\/settings\.local\.json/);
  assert.match(result.output, /env --write-project/);
});

test('doctor explains the no-model-fallback diagnostic for model divergence', (t) => {
  const { home, project } = fixture(t);
  const result = runDoctor(home, project);

  assert.match(result.output, /CLAUDE_CODE_NO_MODEL_FALLBACK=true/);
  assert.match(result.output, /throwaway session/);
  assert.match(result.output, /unset it afterwards/);
  assert.match(result.output, /transient 5xx/);
});

test('effectiveBaseUrl follows Claude Code precedence and reports shadowed definitions', (t) => {
  const { home, project } = fixture(t);
  const local = path.join(project, '.claude', 'settings.local.json');
  const shared = path.join(project, '.claude', 'settings.json');
  const user = path.join(home, '.claude', 'settings.json');
  writeJson(local, { env: { ANTHROPIC_BASE_URL: 'http://local.example' } });
  writeJson(shared, { env: { ANTHROPIC_BASE_URL: 'http://shared.example' } });
  writeJson(user, { env: { ANTHROPIC_BASE_URL: 'http://user.example' } });

  let result = resolveEffective(home, project, { ANTHROPIC_BASE_URL: 'http://env.example' });
  assert.equal(result.source, 'env');
  assert.equal(result.value, 'http://env.example');
  assert.deepEqual(result.shadowed.map(({ source }) => source), ['project-local', 'project-shared', 'user']);

  result = resolveEffective(home, project);
  assert.equal(result.source, 'project-local');
  assert.equal(result.value, 'http://local.example');
  assert.deepEqual(result.shadowed.map(({ source }) => source), ['project-shared', 'user']);

  fs.rmSync(local);
  result = resolveEffective(home, project);
  assert.equal(result.source, 'project-shared');
  assert.equal(result.value, 'http://shared.example');
  assert.deepEqual(result.shadowed.map(({ source }) => source), ['user']);

  fs.rmSync(shared);
  result = resolveEffective(home, project);
  assert.equal(result.source, 'user');
  assert.equal(result.value, 'http://user.example');
  assert.deepEqual(result.shadowed, []);
});

test('effectiveBaseUrl skips absent, unparsable, and env-less settings files', (t) => {
  const { home, project } = fixture(t);
  const local = path.join(project, '.claude', 'settings.local.json');
  const shared = path.join(project, '.claude', 'settings.json');
  const user = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(local), { recursive: true });
  fs.writeFileSync(local, '{');
  writeJson(shared, { env: { OTHER_VALUE: 'present' } });
  writeJson(user, { env: { ANTHROPIC_BASE_URL: 'http://user.example' } });

  const result = resolveEffective(home, project);
  assert.deepEqual(result, {
    value: 'http://user.example',
    source: 'user',
    file: user,
    shadowed: [],
  });
});

test('effectiveBaseUrl is re-exported through commands', (t) => {
  const { home, project } = fixture(t);
  const result = runNode(home, project, `process.stdout.write(typeof require(${JSON.stringify(COMMANDS)}).effectiveBaseUrl)`);
  assert.equal(result.code, 0);
  assert.equal(result.output, 'function');
});

test('doctor fails on a selected-mode contradiction and passes when modes agree', (t) => {
  const { home, project } = fixture(t);
  const local = path.join(project, '.claude', 'settings.local.json');
  const user = path.join(home, '.claude', 'settings.json');
  writeJson(local, { env: { ANTHROPIC_BASE_URL: DEFAULT_BASE_URL } });
  writeJson(user, { env: { ANTHROPIC_BASE_URL: 'http://api.anthropic.com' } });

  let result = runDoctor(home, project);
  assert.notEqual(result.code, 0);
  assert.match(result.output, /effective .*settings\.local\.json uses default mode/);
  assert.match(result.output, /shadowed .*settings\.json uses compat mode/);
  assert.match(result.output, /Project settings\.local\.json wins/);
  assert.match(result.output, /env --write-project/);

  writeJson(user, { env: { ANTHROPIC_BASE_URL: DEFAULT_BASE_URL } });
  result = runDoctor(home, project);
  assert.equal(result.code, 0);
  assert.match(result.output, /wiring precedence: project settings\.local\.json wins over user settings\.json/);
  assert.doesNotMatch(result.output, /ERROR:/);
});

// SQ-1901. `ensure --quiet` runs from SessionStart, whose stdout is model context and nothing else, so an
// actionable state was told to the model and to nobody who could fix it: a session sat unwired for hours and it
// took asking which hooks had run to find out. systemMessage is the only user-visible channel, and Claude Code
// reads it only from a JSON stdout on a zero exit.
function runHook(home, project, environment = {}) {
  const { ANTHROPIC_BASE_URL, ...inherited } = process.env;
  const result = spawnSync(process.execPath, [CLI, 'ensure', '--quiet'], {
    cwd: project,
    encoding: 'utf8',
    timeout: 30000,
    env: { ...inherited, HOME: home, USERPROFILE: home, CODEX_GATEWAY_PORT: '9', CODEX_GATEWAY_PROXY_PORT: '9', ...environment },
  });
  assert.ifError(result.error);
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function migrateLegacyProjectSettings(home, project) {
  const result = runNode(home, project, `process.stdout.write(JSON.stringify(require(${JSON.stringify(SETTINGS_WIRING)}).migrateLegacyProjectSettings()))`);
  assert.equal(result.code, 0, result.output);
  return JSON.parse(result.output);
}

test('SessionStart leaves a recorded project\'s unwired committed settings byte-identical', (t) => {
  const { home, project } = fixture(t);
  const legacyFile = path.join(project, '.claude', 'settings.json');
  wireProject(project);
  writeJson(projectRegistry(home), { projects: [project] });
  const original = JSON.stringify({
    enabledPlugins: { 'model-gateway@eigenwise-toolshed': true },
    env: { ENABLE_TOOL_SEARCH: 'true' },
  }, null, 2) + '\n';
  fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
  fs.writeFileSync(legacyFile, original);

  assert.deepEqual(migrateLegacyProjectSettings(home, project), { migrated: false });
  assert.equal(fs.readFileSync(legacyFile, 'utf8'), original);
  assert.equal(runHook(home, project).code, 0);
  assert.equal(fs.readFileSync(legacyFile, 'utf8'), original);
});

test('SessionStart migrates a gateway-owned committed settings file', (t) => {
  const { home, project } = fixture(t);
  const legacyFile = path.join(project, '.claude', 'settings.json');
  writeJson(legacyFile, {
    enabledPlugins: { 'model-gateway@eigenwise-toolshed': true },
    env: {
      ANTHROPIC_BASE_URL: DEFAULT_BASE_URL,
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
      CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: '1',
      ENABLE_TOOL_SEARCH: 'true',
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '950000',
    },
  });

  assert.equal(runHook(home, project).code, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(legacyFile, 'utf8')), {
    enabledPlugins: { 'model-gateway@eigenwise-toolshed': true },
  });
});

test('SQ-1901: the SessionStart hook shows the user an actionable state instead of only the model', (t) => {
  const { home, project } = fixture(t);

  const hook = runHook(home, project);

  assert.equal(hook.code, 0);
  const output = JSON.parse(hook.stdout);
  assert.match(output.systemMessage, /installed but not set up/);
  assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(output.hookSpecificOutput.additionalContext, /installed but not set up/);
});

test('SQ-1901: a refusal state reaches the user through the hook and still fails a direct ensure', (t) => {
  const { home, project } = fixture(t);
  writeJson(path.join(home, '.claude', 'settings.json'), { env: { ANTHROPIC_BASE_URL: DEFAULT_BASE_URL } });

  // Wired with no proxy binary: exactly the shape that refused Codex dispatch while the user was told nothing.
  const hook = runHook(home, project);
  assert.equal(hook.code, 0, 'a nonzero exit would trade the user-visible line for a bare "hook failed" badge');
  const output = JSON.parse(hook.stdout);
  assert.match(output.systemMessage, /claude-code-proxy is missing/);
  assert.match(output.systemMessage, /setup/);

  const direct = run(home, project, ['ensure']);
  assert.equal(direct.code, 1, 'a person or the updater running ensure still gets a failing exit code');
  assert.match(direct.output, /claude-code-proxy is missing/);
  assert.doesNotMatch(direct.output, /hookSpecificOutput/);
});

test('SQ-1901: only states someone must act on become the user line', (t) => {
  const { home, project } = fixture(t);

  const output = JSON.parse(runHook(home, project).stdout);

  // The context carries everything the hook printed; the user line is built from the actionable notices alone, so
  // routine output (a catalog write, a pin sync) never reaches the transcript.
  assert.equal(output.systemMessage, output.hookSpecificOutput.additionalContext.split('\n').pop());
  assert.equal(output.systemMessage.includes('\n'), false);
});
