'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnGatewayProcessSync } = require('./support.js');

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
  const result = spawnGatewayProcessSync(process.execPath, [CLI, ...args], {
    cwd: project,
    encoding: 'utf8',
    timeout: 20000,
    isolatedOverrides: {
      CODEX_GATEWAY_PORT: '9',
      CODEX_GATEWAY_WORKER_PORT: '9',
      CODEX_GATEWAY_PROXY_PORT: '9',
    },
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

function gatewaySettings(extraEnv = {}) {
  return {
    enabledPlugins: { 'model-gateway@eigenwise-toolshed': true },
    env: {
      ANTHROPIC_BASE_URL: DEFAULT_BASE_URL,
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
      CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: '1',
      ENABLE_TOOL_SEARCH: 'true',
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000',
      ...extraEnv,
    },
  };
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

test('env --write-project normalizes a legacy gateway model cache through the canonical window policy', (t) => {
  const { home, project } = fixture(t);
  const cache = path.join(home, '.claude', 'cache', 'gateway-models.json');
  writeJson(cache, {
    baseUrl: DEFAULT_BASE_URL,
    fetchedAt: 1,
    models: [
      { id: 'claude-gpt-6-astra', display_name: 'GPT-6 Astra (Codex)' },
      { id: 'anthropic-custom', display_name: 'Anthropic Custom' },
    ],
  });

  assert.equal(run(home, project, ['env', '--write-project']).code, 0);

  assert.deepEqual(JSON.parse(fs.readFileSync(cache, 'utf8')).models, [
    { id: 'claude-gpt-6-astra[1m]', display_name: 'GPT-6 Astra (Codex)' },
    { id: 'anthropic-custom', display_name: 'Anthropic Custom' },
  ]);
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
  const result = spawnGatewayProcessSync(process.execPath, ['-e', script], {
    cwd: project,
    encoding: 'utf8',
    timeout: 20000,
    isolatedOverrides: {
      CODEX_GATEWAY_PORT: '9',
      CODEX_GATEWAY_WORKER_PORT: '9',
      CODEX_GATEWAY_PROXY_PORT: '9',
    },
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

function runDoctor(home, project, extraEnv = {}, readinessOverrides = {}) {
  const readiness = {
    ready: true,
    state: 'ready',
    checks: { proxyBinary: false, proxyModels: true, codexAuth: true, shimRunning: true, servingVersion: 'test', servingVersionMatches: true },
    ...readinessOverrides,
  };
  return runNode(home, project, `require(${JSON.stringify(COMMANDS)}).commands.doctor({ readiness: ${JSON.stringify(readiness)} })`, extraEnv);
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

test('doctor and SessionStart give conditional forced-host guidance before auth advice', (t) => {
  const { home, project } = fixture(t);
  const wiredFile = path.join(project, '.claude', 'settings.local.json');
  wireProject(project);
  const environment = { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' };
  const doctor = runDoctor(home, project, environment);

  assert.notEqual(doctor.code, 0);
  assert.match(doctor.output, /process env ANTHROPIC_BASE_URL .*bypasses model-gateway/);
  assert.match(doctor.output, new RegExp(wiredFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(doctor.output, /user-controlled Claude Code CLI launch can correct or unset ANTHROPIC_BASE_URL/);
  assert.match(doctor.output, /If a host replaces it, use the supported Claude Code CLI on this wired project/);
  assert.match(doctor.output, /Desktop routing is unsupported under forced overrides on Windows and macOS/);
  assert.match(doctor.output, /Settings, parent, and User-scope edits cannot be promised to win/);
  assert.doesNotMatch(doctor.output, /Correct ANTHROPIC_BASE_URL in the launching environment/);
  assert.doesNotMatch(doctor.output, /Desktop.*(?:repair|restore|correct)/i);
  assert.doesNotMatch(doctor.output, /env --write-project/);

  const expectedNotice = `Model Gateway is bypassed: process env ANTHROPIC_BASE_URL (https://api.anthropic.com) shadows wired ${wiredFile}. A user-controlled Claude Code CLI launch can correct or unset ANTHROPIC_BASE_URL, then restart. If a host replaces it, use the supported Claude Code CLI on this wired project; Desktop routing is unsupported under forced overrides on Windows and macOS. Settings, parent, and User-scope edits cannot be promised to win.`;
  for (const codexAuth of [true, false]) {
    const notice = runNode(home, project, `
      const { effectiveBaseUrl } = require(${JSON.stringify(SETTINGS_WIRING)});
      const { sessionStartWiringNotice } = require(${JSON.stringify(COMMANDS)});
      process.stdout.write(sessionStartWiringNotice({
        readiness: { checks: { codexAuth: ${codexAuth} } },
        effectiveWiring: effectiveBaseUrl(),
        projectWirings: [],
      }));
    `, environment);

    assert.equal(notice.code, 0, notice.output);
    assert.equal(notice.output, expectedNotice);
    assert.doesNotMatch(notice.output, /Correct ANTHROPIC_BASE_URL in the launching environment/);
    assert.doesNotMatch(notice.output, /Desktop.*(?:repair|restore|correct)/i);
    assert.doesNotMatch(notice.output, /signed in to ChatGPT/);
    assert.doesNotMatch(notice.output, /Offer to run its login/);
  }
});

test('doctor and SessionStart accept matching process gateway URLs', (t) => {
  const { home, project } = fixture(t);

  for (const baseUrl of [DEFAULT_BASE_URL, COMPAT_BASE_URL]) {
    wireProject(project, baseUrl);
    const doctor = runDoctor(home, project, { ANTHROPIC_BASE_URL: baseUrl });

    assert.equal(doctor.code, 0, doctor.output);
    assert.match(doctor.output, /wiring: effective process env \[model-gateway\]/);
    assert.doesNotMatch(doctor.output, /bypasses model-gateway/);
    assert.doesNotMatch(doctor.output, /wiring is not configured/);
    assert.doesNotMatch(doctor.output, /ERROR:/);

    const sessionStart = runNode(home, project, `
      const { isWired, sessionStartWiringNotice, effectiveBaseUrl } = require(${JSON.stringify(COMMANDS)});
      if (!isWired()) process.stdout.write(sessionStartWiringNotice({
        readiness: { checks: { codexAuth: false } },
        effectiveWiring: effectiveBaseUrl(),
        projectWirings: [],
      }));
    `, { ANTHROPIC_BASE_URL: baseUrl });

    assert.equal(sessionStart.code, 0, sessionStart.output);
    assert.equal(sessionStart.output, '');
  }
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

test('unsafe RC preflight recognizes normalized HTTPS Anthropic process overrides only', (t) => {
  const { home, project } = fixture(t);
  const script = `process.stdout.write(JSON.stringify(require(${JSON.stringify(SETTINGS_WIRING)}).unsafeRemoteControlProcessEnv()))`;

  for (const baseUrl of ['https://api.anthropic.com', 'HTTPS://API.ANTHROPIC.COM:443/']) {
    const result = runNode(home, project, script, { ANTHROPIC_BASE_URL: baseUrl });
    assert.equal(result.code, 0, result.output);
    assert.equal(JSON.parse(result.output).value, baseUrl);
  }
  for (const baseUrl of ['http://api.anthropic.com', 'http://127.0.0.1:9', 'https://api.anthropic.com:444']) {
    const result = runNode(home, project, script, { ANTHROPIC_BASE_URL: baseUrl });
    assert.equal(result.code, 0, result.output);
    assert.equal(JSON.parse(result.output), null);
  }
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

test('doctor retains a process-env gateway mode conflict', (t) => {
  const { home, project } = fixture(t);
  const local = path.join(project, '.claude', 'settings.local.json');
  wireProject(project, COMPAT_BASE_URL);

  const result = runDoctor(home, project, { ANTHROPIC_BASE_URL: DEFAULT_BASE_URL });

  assert.notEqual(result.code, 0);
  assert.match(result.output, /effective process env ANTHROPIC_BASE_URL uses default mode/);
  assert.match(result.output, new RegExp(`shadowed ${local.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} uses compat mode`));
  assert.match(result.output, /Process env wins/);
  assert.doesNotMatch(result.output, /bypasses model-gateway/);
});

test('syncCompatMode makes verified settings authoritative after migrating legacy wiring', (t) => {
  const { home, project } = fixture(t);
  const legacyFile = path.join(project, '.claude', 'settings.json');
  const localFile = path.join(project, '.claude', 'settings.local.json');
  writeJson(legacyFile, gatewaySettings());

  const synchronized = syncCompatMode(home, project, {
    ok: true,
    compat: { hostsDetected: true, port80Bound: true, hostsLine: '127.0.0.1 api.anthropic.com' },
  }, 'compat');

  assert.deepEqual(synchronized.result, { mode: 'compat', compat: {
    hostsDetected: true, port80Bound: true, hostsLine: '127.0.0.1 api.anthropic.com',
  }, changed: true });
  assert.equal(JSON.parse(fs.readFileSync(localFile, 'utf8')).env.ANTHROPIC_BASE_URL, COMPAT_BASE_URL);
  assert.equal(JSON.parse(fs.readFileSync(legacyFile, 'utf8')).env, undefined);
});

test('syncCompatMode reports its verified default write after legacy compat migration', (t) => {
  const { home, project } = fixture(t);
  const legacyFile = path.join(project, '.claude', 'settings.json');
  const localFile = path.join(project, '.claude', 'settings.local.json');
  writeJson(legacyFile, gatewaySettings({ ANTHROPIC_BASE_URL: COMPAT_BASE_URL }));
  writeJson(localFile, { env: { PROJECT_LOCAL_VALUE: 'keep-me' } });

  const synchronized = syncCompatMode(home, project, {
    ok: true,
    compat: { hostsDetected: false, port80Bound: false },
  }, null);

  assert.equal(synchronized.result.mode, 'default');
  assert.equal(synchronized.result.changed, true);
  const local = JSON.parse(fs.readFileSync(localFile, 'utf8')).env;
  assert.equal(local.ANTHROPIC_BASE_URL, DEFAULT_BASE_URL);
  assert.equal(local.PROJECT_LOCAL_VALUE, 'keep-me');
  assert.equal(JSON.parse(fs.readFileSync(legacyFile, 'utf8')).env, undefined);
});

test('required compat refuses unknown health before migrating legacy settings', (t) => {
  const { home, project } = fixture(t);
  const legacyFile = path.join(project, '.claude', 'settings.json');
  const localFile = path.join(project, '.claude', 'settings.local.json');
  writeJson(legacyFile, gatewaySettings());
  const original = fs.readFileSync(legacyFile, 'utf8');

  const synchronized = syncCompatMode(home, project, null, 'compat');

  assert.deepEqual(synchronized.result, { mode: 'default', compat: { hostsDetected: false, port80Bound: false }, changed: false });
  assert.equal(fs.readFileSync(legacyFile, 'utf8'), original);
  assert.equal(fs.existsSync(localFile), false);
});

test('syncCompatMode reports observed environment-only compat wiring without creating settings', (t) => {
  const { home, project } = fixture(t);
  const localFile = path.join(project, '.claude', 'settings.local.json');
  const healthyCompat = { ok: true, compat: { hostsDetected: true, port80Bound: true } };

  const defaultEnvironment = syncCompatMode(home, project, healthyCompat, 'compat', {
    extraEnv: { ANTHROPIC_BASE_URL: DEFAULT_BASE_URL },
  });
  assert.equal(defaultEnvironment.result.mode, 'default');
  assert.equal(defaultEnvironment.result.changed, false);
  assert.equal(fs.existsSync(localFile), false);

  const compatEnvironment = syncCompatMode(home, project, healthyCompat, 'compat', {
    extraEnv: { ANTHROPIC_BASE_URL: COMPAT_BASE_URL },
  });
  assert.equal(compatEnvironment.result.mode, 'compat');
  assert.equal(compatEnvironment.result.changed, false);
  assert.equal(fs.existsSync(localFile), false);
  assert.equal(fs.existsSync(wiringConfig(home)), false);
  assert.equal(fs.existsSync(projectRegistry(home)), false);
  assert.deepEqual(fs.readdirSync(home), []);
  assert.deepEqual(fs.readdirSync(project), []);
});

test('syncCompatMode rejects an unverified write instead of attesting compat', (t) => {
  const { home, project } = fixture(t);
  const legacyFile = path.join(project, '.claude', 'settings.json');
  const localFile = path.join(project, '.claude', 'settings.local.json');
  writeJson(legacyFile, gatewaySettings());

  const synchronized = syncCompatMode(home, project, {
    ok: true,
    compat: { hostsDetected: true, port80Bound: true },
  }, 'compat', { ignoreCompatWrite: true });

  assert.match(synchronized.error, /Could not verify gateway settings/);
  assert.equal(JSON.parse(fs.readFileSync(localFile, 'utf8')).env.ANTHROPIC_BASE_URL, DEFAULT_BASE_URL);
  assert.equal(JSON.parse(fs.readFileSync(legacyFile, 'utf8')).env, undefined);
});

// SQ-1901. `ensure --quiet` runs from SessionStart, whose stdout is model context and nothing else, so an
// actionable state was told to the model and to nobody who could fix it: a session sat unwired for hours and it
// took asking which hooks had run to find out. systemMessage is the only user-visible channel, and Claude Code
// reads it only from a JSON stdout on a zero exit.
function runHook(home, project, environment = {}) {
  const { ANTHROPIC_BASE_URL, ...inherited } = process.env;
  const result = spawnGatewayProcessSync(process.execPath, [CLI, 'ensure', '--quiet'], {
    cwd: project,
    encoding: 'utf8',
    timeout: 30000,
    isolatedOverrides: {
      CODEX_GATEWAY_PORT: '9',
      CODEX_GATEWAY_WORKER_PORT: '9',
      CODEX_GATEWAY_PROXY_PORT: '9',
    },
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

function syncCompatMode(home, project, health, requiredMode, { ignoreCompatWrite = false, extraEnv = {} } = {}) {
  const result = runNode(home, project, `
    const fs = require('node:fs');
    const http = require('node:http');
    const localFile = require('node:path').join(process.cwd(), '.claude', 'settings.local.json');
    const originalWrite = fs.writeFileSync;
    if (${JSON.stringify(ignoreCompatWrite)}) {
      fs.writeFileSync = (file, value, ...rest) => {
        if (file === localFile && String(value).includes(${JSON.stringify(COMPAT_BASE_URL)})) return;
        return originalWrite(file, value, ...rest);
      };
    }
    const server = http.createServer((request, response) => {
      response.end(JSON.stringify(${JSON.stringify(health)}));
    });
    server.listen(0, '127.0.0.1', async () => {
      process.env.CODEX_GATEWAY_WORKER_PORT = String(server.address().port);
      try {
        const result = await require(${JSON.stringify(COMMANDS)}).syncCompatMode({ requiredMode: ${JSON.stringify(requiredMode)} });
        process.stdout.write(JSON.stringify({ result }));
      } catch (error) {
        process.stdout.write(JSON.stringify({ error: error.message }));
      } finally {
        server.close();
      }
    });
  `, extraEnv);
  assert.equal(result.code, 0, result.output);
  const output = result.output.trim();
  return JSON.parse(output.slice(output.lastIndexOf('\n') + 1));
}

function migrateWithUnreadableUserIdentity(home, project) {
  const result = runNode(home, project, `
    const fs = require('node:fs');
    const realpath = fs.realpathSync.native;
    let calls = 0;
    fs.realpathSync.native = (...args) => {
      if (calls++ === 1) {
        const error = new Error('synthetic user identity failure');
        error.code = 'EACCES';
        throw error;
      }
      return realpath(...args);
    };
    process.stdout.write(JSON.stringify(require(${JSON.stringify(SETTINGS_WIRING)}).migrateLegacyProjectSettings()));
  `);
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

test('migration preserves user settings that resolve to the legacy file', (t) => {
  const { home } = fixture(t);
  const userFile = path.join(home, '.claude', 'settings.json');
  const localFile = path.join(home, '.claude', 'settings.local.json');
  writeJson(userFile, gatewaySettings({ USER_UNRELATED: 'keep-user' }));
  const userBytes = fs.readFileSync(userFile, 'utf8');

  assert.deepEqual(migrateLegacyProjectSettings(home, home), { migrated: false });
  assert.equal(fs.readFileSync(userFile, 'utf8'), userBytes, 'home migration preserves deliberate user-scope gateway wiring byte-for-byte');
  assert.equal(fs.existsSync(localFile), false);
  assert.equal(runHook(home, home).code, 0);
  assert.equal(fs.readFileSync(userFile, 'utf8'), userBytes);
  assert.equal(fs.existsSync(localFile), false);

  const homeAlias = path.join(path.dirname(home), 'home-alias');
  fs.symlinkSync(home, homeAlias, 'junction');
  assert.deepEqual(migrateLegacyProjectSettings(home, homeAlias), { migrated: false });
  assert.equal(fs.readFileSync(userFile, 'utf8'), userBytes, 'junction migration preserves deliberate user-scope gateway wiring byte-for-byte');
  assert.equal(fs.existsSync(localFile), false);
});

test('migration keeps separate-project overrides and fails closed on uncertain identity', (t) => {
  const { home, project } = fixture(t);
  const userFile = path.join(home, '.claude', 'settings.json');
  const legacyFile = path.join(project, '.claude', 'settings.json');
  const localFile = path.join(project, '.claude', 'settings.local.json');
  writeJson(userFile, gatewaySettings({ USER_UNRELATED: 'keep-user' }));
  const userBytes = fs.readFileSync(userFile, 'utf8');
  writeJson(legacyFile, gatewaySettings({ SHARED_UNRELATED: 'keep-shared' }));
  writeJson(localFile, { env: {
    ANTHROPIC_BASE_URL: COMPAT_BASE_URL,
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: '32000',
    PROJECT_LOCAL_UNRELATED: 'keep-local',
  } });

  assert.equal(migrateLegacyProjectSettings(home, project).migrated, true);
  assert.equal(fs.readFileSync(userFile, 'utf8'), userBytes);
  assert.deepEqual(JSON.parse(fs.readFileSync(legacyFile, 'utf8')).env, { SHARED_UNRELATED: 'keep-shared' });
  const local = JSON.parse(fs.readFileSync(localFile, 'utf8')).env;
  assert.equal(local.ANTHROPIC_BASE_URL, COMPAT_BASE_URL);
  assert.equal(local.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '32000');
  assert.equal(local.PROJECT_LOCAL_UNRELATED, 'keep-local');
  assert.equal(local.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, '1');

  const missingUser = fixture(t);
  const missingLegacy = path.join(missingUser.project, '.claude', 'settings.json');
  writeJson(missingLegacy, gatewaySettings());
  assert.equal(migrateLegacyProjectSettings(missingUser.home, missingUser.project).migrated, true);
  assert.equal(fs.existsSync(path.join(missingUser.home, '.claude', 'settings.json')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(missingUser.project, '.claude', 'settings.local.json'), 'utf8')).env.ANTHROPIC_BASE_URL, DEFAULT_BASE_URL);

  const unreadableUser = fixture(t);
  const unreadableLegacy = path.join(unreadableUser.project, '.claude', 'settings.json');
  const unreadableLocal = path.join(unreadableUser.project, '.claude', 'settings.local.json');
  writeJson(path.join(unreadableUser.home, '.claude', 'settings.json'), gatewaySettings());
  writeJson(unreadableLegacy, gatewaySettings());
  const legacyBytes = fs.readFileSync(unreadableLegacy, 'utf8');
  assert.deepEqual(migrateWithUnreadableUserIdentity(unreadableUser.home, unreadableUser.project), { migrated: false });
  assert.equal(fs.readFileSync(unreadableLegacy, 'utf8'), legacyBytes);
  assert.equal(fs.existsSync(unreadableLocal), false);
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
