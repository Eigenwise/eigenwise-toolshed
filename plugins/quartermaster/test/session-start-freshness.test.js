'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  CACHE_MAX_AGE_MS,
  audit,
  boardMappings,
  createDebouncer,
  emitWarning,
  finding,
  findingText,
  sourceFreshness,
} = require('../hooks/session-start-freshness.js');

const now = Date.parse('2026-07-17T12:00:00Z');

// audit() falls back to os.homedir() when no home is given, so a fixture without one reads the
// developer's own ~/.claude/settings.json and passes or fails by whose machine it runs on.
const absentHome = path.join(os.tmpdir(), `quartermaster-freshness-absent-home-${process.pid}`);

function fixture(overrides = {}) {
  return {
    home: absentHome,
    now,
    registry: {
      plugins: {
        'sidequest@eigenwise-toolshed': [{ scope: 'project', projectPath: 'C:/work/one', version: '1.0.0' }],
        'plugin@other-marketplace': [{ scope: 'user', version: '1.0.0' }],
      },
    },
    marketplaces: {
      'eigenwise-toolshed': { autoUpdate: true, lastUpdated: new Date(now).toISOString() },
      'other-marketplace': { autoUpdate: true, lastUpdated: new Date(now).toISOString() },
    },
    manifestFor: (name) => ({
      plugins: name === 'eigenwise-toolshed'
        ? [{ name: 'sidequest', version: '1.0.0' }]
        : [{ name: 'plugin', version: '1.0.0' }],
    }),
    checkGateway: () => ({ available: true }),
    versions: { node: '22.5.0', claude: '2.1.0' },
    boards: [],
    ...overrides,
  };
}

test('enumerates every board and maps it to its Sidequest project install', () => {
  const result = audit(fixture({
    boards: [
      { name: 'One', path: 'C:/work/one' },
      { name: 'Two', path: 'C:/work/two' },
    ],
  }));

  assert.deepEqual(result.mappings, [
    { name: 'One', path: 'C:/work/one', status: 'installed' },
    { name: 'Two', path: 'C:/work/two', status: 'missing' },
  ]);
  assert.match(findingText(result.problems).join('\n'), /Sidequest board Two has no Sidequest install/);
});

test('maps a Sidequest board through an existing project alias', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'quartermaster-freshness-'));
  const project = path.join(directory, 'project');
  const alias = path.join(directory, 'project-alias');
  fs.mkdirSync(project);
  fs.symlinkSync(project, alias, 'junction');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const result = audit(fixture({
    registry: { plugins: { 'sidequest@eigenwise-toolshed': [{ scope: 'project', projectPath: project, version: '1.0.0' }] } },
    boards: [{ name: 'Alias', path: alias }],
  }));

  assert.equal(result.mappings[0].status, 'installed');
});

test('keeps other projects out of the SessionStart health context', () => {
  const result = audit(fixture({
    currentProject: 'C:/work/one/subdirectory',
    boards: [
      { name: 'One', path: 'C:/work/one' },
      { name: 'Two', path: 'C:/work/two' },
    ],
  }));

  assert.deepEqual(result.projectProblems, []);
  assert.match(findingText(result.problems).join('\n'), /Sidequest board Two has no Sidequest install/);
});

test('reports stale Sidequest worktree processes but ignores live worktrees', { skip: process.platform !== 'win32' && 'worktree root derivation uses host path semantics; the feature is win32-gated' }, () => {
  const project = 'C:/work/current';
  const stalePath = 'C:\\sidequest\\worktrees\\current-3e4fa2ae\\agent-stale';
  const livePath = 'C:\\sidequest\\worktrees\\current-3e4fa2ae\\agent-live';
  const result = audit(fixture({
    currentProject: project,
    platform: 'win32',
    sidequestHome: 'C:/sidequest',
    listProcesses: () => [
      { pid: 101, startTime: '2026-08-13T09:00:00Z', command: `node "${stalePath}\\gate.js"` },
      { pid: 102, startTime: '2026-08-13T09:01:00Z', command: `node "${livePath}\\server.js"` },
    ],
    existsSync: (pathname) => pathname !== stalePath,
  }));

  assert.deepEqual(result.staleProcesses, [
    { pid: 101, startTime: '2026-08-13T09:00:00Z', stalePath },
  ]);
});

test('reports freshness problems for the current project', () => {
  const result = audit(fixture({
    currentProject: 'C:/work/one',
    manifestFor: (name) => ({
      plugins: name === 'eigenwise-toolshed'
        ? [{ name: 'sidequest', version: '1.1.0' }]
        : [{ name: 'plugin', version: '1.0.0' }],
    }),
  }));

  assert.deepEqual(result.projectProblems, [finding('sidequest@eigenwise-toolshed 1.0.0 is behind cached 1.1.0')]);
});
test('reports Toolshed freshness while ignoring foreign installs', () => {
  const input = fixture({
    registry: {
      plugins: {
        'sidequest@eigenwise-toolshed': [{ scope: 'user', version: '1.0.0' }],
        'missing@other-marketplace': [{ scope: 'user', version: '1.0.0' }],
      },
    },
    manifestFor: (name) => ({
      plugins: name === 'eigenwise-toolshed'
        ? [{ name: 'sidequest', version: '1.1.0' }]
        : [{ name: 'different', version: '1.0.0' }],
    }),
  });

  const result = audit(input);
  assert.match(findingText(result.problems).join('\n'), /sidequest@eigenwise-toolshed 1.0.0 is behind cached 1.1.0/);
  assert.doesNotMatch(findingText(result.problems).join('\n'), /other-marketplace/);
});

test('ignores stale foreign marketplaces while reporting stale Toolshed freshness', () => {
  const result = audit(fixture({
    registry: {
      plugins: {
        'sidequest@eigenwise-toolshed': [{ scope: 'user', version: '1.0.0' }],
        'foo@contractify': [{ scope: 'user', version: '1.0.0' }],
      },
    },
    marketplaces: {
      'eigenwise-toolshed': { autoUpdate: true, lastUpdated: new Date(now - CACHE_MAX_AGE_MS - 1).toISOString() },
      contractify: { autoUpdate: false, lastUpdated: new Date(now - CACHE_MAX_AGE_MS - 1).toISOString() },
    },
  }));

  const problems = findingText(result.problems).join('\n');
  assert.match(problems, /eigenwise-toolshed marketplace cache is stale, installed freshness is unknown/);
  assert.doesNotMatch(problems, /contractify/);
});

test('compares rolling plugins against only their cached source path', () => {
  const calls = [];
  const freshness = sourceFreshness(
    { gitCommitSha: 'installed-sha' },
    { source: './plugins/rolling' },
    { installLocation: 'C:/cache/marketplace' },
    (args) => {
      calls.push(args);
      return { status: 0 };
    },
  );

  assert.equal(freshness, 'fresh');
  assert.deepEqual(calls, [
    ['-C', 'C:/cache/marketplace', 'merge-base', '--is-ancestor', 'installed-sha', 'HEAD'],
    ['-C', 'C:/cache/marketplace', 'diff', '--quiet', 'installed-sha..HEAD', '--', 'plugins/rolling'],
  ]);
});

test('does not call an unrelated cached git history stale', () => {
  const freshness = sourceFreshness(
    { gitCommitSha: 'unrelated-sha' },
    { source: './plugins/rolling' },
    { installLocation: 'C:/cache/marketplace' },
    () => ({ status: 1 }),
  );

  assert.equal(freshness, 'unknown');
});

test('does not flag rolling Toolshed plugins that match their cached source', () => {
  const result = audit(fixture({
    registry: {
      plugins: {
        'rolling@eigenwise-toolshed': [{ scope: 'user', gitCommitSha: 'installed-sha' }],
      },
    },
    manifestFor: () => ({ plugins: [{ name: 'rolling', source: './plugins/rolling' }] }),
    gitFreshness: () => 'fresh',
  }));

  assert.deepEqual(result.problems, []);
});

test('reports rolling plugin freshness as unknown when local git cannot prove it', () => {
  const result = audit(fixture({
    registry: {
      plugins: {
        'rolling@eigenwise-toolshed': [{ scope: 'user', gitCommitSha: 'installed-sha' }],
      },
    },
    manifestFor: () => ({ plugins: [{ name: 'rolling', source: './plugins/rolling' }] }),
    gitFreshness: () => 'unknown',
  }));

  assert.match(findingText(result.problems).join('\n'), /rolling@eigenwise-toolshed freshness is unknown/);
});

test('reports stale marketplace caches without claiming remote freshness', () => {
  const result = audit(fixture({
    marketplaces: {
      'eigenwise-toolshed': { autoUpdate: true, lastUpdated: new Date(now - CACHE_MAX_AGE_MS - 1).toISOString() },
      'other-marketplace': { autoUpdate: true, lastUpdated: new Date(now).toISOString() },
    },
    manifestFor: (name) => ({ plugins: [{ name: name === 'eigenwise-toolshed' ? 'sidequest' : 'plugin', version: '9.0.0' }] }),
  }));

  assert.match(findingText(result.problems).join('\n'), /eigenwise-toolshed marketplace cache is stale, installed freshness is unknown/);
  assert.doesNotMatch(findingText(result.problems).join('\n'), /sidequest@eigenwise-toolshed.*behind/);
});

test('flags a codex proxy version below its bundled floor', () => {
  const result = audit(fixture({
    registry: {
      plugins: {
        'model-gateway@eigenwise-toolshed': [{ scope: 'user', version: '1.0.0', installPath: 'C:/gateway' }],
      },
    },
    manifestFor: () => ({ plugins: [{ name: 'model-gateway', version: '1.0.0' }] }),
    checkGateway: () => ({
      available: true,
      proxyVersion: '0.1.13',
      minProxyVersion: '0.1.14',
      auth: true,
      proxy: true,
      shim: true,
    }),
  }));

  assert.match(findingText(result.problems).join('\n'), /model-gateway proxy 0.1.13 is below required 0.1.14/);
});

test('stays silent for a healthy fleet', () => {
  const result = audit(fixture());
  assert.deepEqual(result.problems, []);
  assert.equal(emitWarning(result.problems), '');
});

test('collapses multiple problems into one actionable warning', () => {
  const message = emitWarning([
    'one', 'two', 'three', 'four', 'five', 'six',
  ].map((text) => finding(text)), createDebouncer(new Set()));

  assert.match(message, /^Toolshed local health: /);
  assert.match(message, /\+1 more/);
  assert.match(message, /Run \/update-toolshed/);
  assert.equal(message.split('\n').length, 1);
});

test('debounces the same state but reports a changed state', () => {
  const debouncer = createDebouncer(new Set());
  assert.match(emitWarning([finding('stale cache')], debouncer), /stale cache/);
  assert.equal(emitWarning([finding('stale cache')], debouncer), '');
  assert.match(emitWarning([finding('stale cache'), finding('proxy down')], debouncer), /proxy down/);
});

const hookPath = path.join(__dirname, '..', 'hooks', 'session-start-freshness.js');

function seedSidequestBoards(home, boards) {
  const { DatabaseSync } = require('node:sqlite');
  const directory = path.join(home, '.claude', 'sidequest');
  fs.mkdirSync(directory, { recursive: true });
  const database = new DatabaseSync(path.join(directory, 'sidequest.db'));
  database.exec('CREATE TABLE projects (slug TEXT PRIMARY KEY, data TEXT)');
  for (const board of boards) {
    database.prepare('INSERT INTO projects (slug, data) VALUES (?, ?)').run(board.name, JSON.stringify(board));
  }
  database.close();
}

function hookOutput({ registry, manifest, loadedVersion, marketplaces = {}, input = {}, boards = [] }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quartermaster-freshness-'));
  const cache = path.join(home, 'marketplace');
  const pluginRoot = path.join(home, 'quartermaster');
  try {
    if (boards.length) seedSidequestBoards(home, boards);
    fs.mkdirSync(path.join(home, '.claude', 'plugins'), { recursive: true });
    fs.mkdirSync(path.join(cache, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(pluginRoot, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), registry);
    fs.writeFileSync(path.join(home, '.claude', 'plugins', 'known_marketplaces.json'), JSON.stringify({
      'eigenwise-toolshed': {
        autoUpdate: true,
        lastUpdated: new Date().toISOString(),
        installLocation: cache,
      },
      ...marketplaces,
    }));
    fs.writeFileSync(path.join(cache, '.claude-plugin', 'marketplace.json'), manifest);
    fs.writeFileSync(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: loadedVersion }));
    const output = childProcess.execFileSync(process.execPath, [hookPath], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_PLUGIN_ROOT: pluginRoot },
      input: JSON.stringify(input),
      timeout: 10_000,
    });
    return output ? JSON.parse(output) : null;
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function hookFixture(plugins, versions) {
  return {
    registry: JSON.stringify({ plugins }),
    manifest: JSON.stringify({
      plugins: Object.entries(versions).map(([name, version]) => ({ name, version })),
    }),
  };
}

test('writes a reload notice to SessionStart hook stdout for the current project', () => {
  const output = hookOutput({
    ...hookFixture({
      'quartermaster@eigenwise-toolshed': [{ scope: 'project', projectPath: 'C:/work/current', version: '0.49.0' }],
    }, { quartermaster: '0.49.0' }),
    loadedVersion: '0.48.0',
    input: { cwd: 'C:/work/current' },
  });

  assert.equal(output.systemMessage, 'Toolshed: quartermaster 0.48.0 loaded, 0.49.0 installed — /reload-plugins to pick it up.');
  assert.equal(output.hookSpecificOutput, undefined);
});

test('SQ-1900: a finding the user has to fix reaches the user, not only the model', () => {
  const output = hookOutput({
    ...hookFixture({
      'quartermaster@eigenwise-toolshed': [{ scope: 'project', projectPath: 'C:/work/current', version: '0.49.0' }],
    }, { quartermaster: '0.49.0' }),
    loadedVersion: '0.49.0',
    input: { cwd: 'C:/work/current' },
    boards: [{ name: 'current', path: 'C:/work/current' }],
  });

  assert.equal(
    output.systemMessage,
    'Toolshed needs you: Sidequest board current has no Sidequest install — ask me for the Toolshed health report.',
  );
  assert.match(output.hookSpecificOutput.additionalContext, /Sidequest board current has no Sidequest install/);
});

test('SQ-1900: a healthy project says nothing to the user at all', () => {
  const output = hookOutput({
    ...hookFixture({
      'quartermaster@eigenwise-toolshed': [{ scope: 'project', projectPath: 'C:/work/current', version: '0.49.0' }],
      'sidequest@eigenwise-toolshed': [{ scope: 'project', projectPath: 'C:/work/current', version: '2.42.0' }],
    }, { quartermaster: '0.49.0', sidequest: '2.42.0' }),
    loadedVersion: '0.49.0',
    input: { cwd: 'C:/work/current' },
    boards: [{ name: 'current', path: 'C:/work/current' }],
  });

  assert.equal(output, null, 'a session start with nothing wrong emits no systemMessage and no context');
});

test('writes cached update availability to SessionStart hook stdout for the current project', () => {
  const output = hookOutput({
    ...hookFixture({
      'quartermaster@eigenwise-toolshed': [{ scope: 'project', projectPath: 'C:/work/current', version: '0.49.0' }],
      'sidequest@eigenwise-toolshed': [{ scope: 'project', projectPath: 'C:/work/current', version: '2.41.0' }],
    }, { quartermaster: '0.50.0', sidequest: '2.42.0' }),
    loadedVersion: '0.49.0',
    input: { cwd: 'C:/work/current' },
  });

  assert.equal(output.systemMessage, 'Toolshed update available (cached): quartermaster 0.49.0 → 0.50.0 — /update-toolshed, then /reload-plugins.');
});

test('keeps third-party freshness and other projects out of SessionStart output', () => {
  const output = hookOutput({
    registry: JSON.stringify({
      plugins: {
        'plugin@other-marketplace': [{ scope: 'user', version: '1.0.0' }],
      },
    }),
    manifest: JSON.stringify({ plugins: [] }),
    loadedVersion: '0.49.0',
    marketplaces: {
      'other-marketplace': {
        autoUpdate: false,
        lastUpdated: new Date().toISOString(),
      },
    },
    input: { cwd: 'C:/work/current' },
  });

  assert.equal(output, null);
});

test('keeps another project cached update out of every SessionStart output', () => {
  const output = hookOutput({
    ...hookFixture({
      'sidequest@eigenwise-toolshed': [{ scope: 'project', projectPath: 'C:/work/other', version: '1.0.0' }],
    }, { sidequest: '1.1.0' }),
    loadedVersion: '0.49.0',
    input: { cwd: 'C:/work/current' },
  });

  assert.equal(output, null);
});

test('keeps another project reload notice out of every SessionStart output', () => {
  const output = hookOutput({
    ...hookFixture({
      'quartermaster@eigenwise-toolshed': [{ scope: 'project', projectPath: 'C:/work/other', version: '0.50.0' }],
    }, { quartermaster: '0.50.0' }),
    loadedVersion: '0.49.0',
    input: { cwd: 'C:/work/current' },
  });

  assert.equal(output, null);
});

test('emits no SessionStart output without a usable current project', () => {
  const output = hookOutput({
    ...hookFixture({
      'quartermaster@eigenwise-toolshed': [{ scope: 'project', projectPath: 'C:/work/current', version: '0.50.0' }],
      'sidequest@eigenwise-toolshed': [{ scope: 'project', projectPath: 'C:/work/current', version: '1.0.0' }],
    }, { quartermaster: '0.50.0', sidequest: '1.1.0' }),
    loadedVersion: '0.49.0',
  });

  assert.equal(output, null);
});

test('writes a project-scoped health warning to SessionStart context', () => {
  const output = hookOutput({
    ...hookFixture({
      'sidequest@eigenwise-toolshed': [{ scope: 'project', projectPath: 'C:/work/current', version: '1.0.0' }],
    }, { sidequest: '1.1.0' }),
    loadedVersion: '0.49.0',
    input: { cwd: 'C:/work/current/subdirectory' },
  });

  assert.equal(output.hookSpecificOutput.additionalContext, 'Toolshed project health: sidequest@eigenwise-toolshed 1.0.0 is behind cached 1.1.0.');
  assert.equal(output.systemMessage, 'Toolshed update available (cached): sidequest 1.0.0 → 1.1.0 — /update-toolshed, then /reload-plugins.');
});

test('emits no SessionStart message when every version is current', () => {
  const output = hookOutput({
    ...hookFixture({ 'quartermaster@eigenwise-toolshed': [{ scope: 'user', version: '0.49.0' }] }, { quartermaster: '0.49.0' }),
    loadedVersion: '0.49.0',
  });

  assert.equal(output, null);
});

test('fails open without a SessionStart message for malformed local state', () => {
  const output = hookOutput({
    registry: '{malformed',
    manifest: '{malformed',
    loadedVersion: '0.49.0',
  });

  assert.equal(output, null);
});

test('limits update notices to one plugin', () => {
  const output = hookOutput({
    ...hookFixture({
      'alpha@eigenwise-toolshed': [{ scope: 'project', projectPath: 'C:/work/current', version: '1.0.0' }],
      'beta@eigenwise-toolshed': [{ scope: 'project', projectPath: 'C:/work/current', version: '1.0.0' }],
      'gamma@eigenwise-toolshed': [{ scope: 'project', projectPath: 'C:/work/current', version: '1.0.0' }],
      'omega@eigenwise-toolshed': [{ scope: 'project', projectPath: 'C:/work/current', version: '1.0.0' }],
    }, { alpha: '1.1.0', beta: '1.1.0', gamma: '1.1.0', omega: '1.1.0' }),
    loadedVersion: '0.49.0',
    input: { cwd: 'C:/work/current' },
  });

  assert.equal(output.systemMessage, 'Toolshed update available (cached): alpha 1.0.0 → 1.1.0 — /update-toolshed, then /reload-plugins.');
});

test('hooks.json registers the freshness hooks and nothing observability owns', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'hooks', 'hooks.json'), 'utf8')).hooks;
  const commandsFor = (event) => (hooks[event] || []).flatMap((group) => group.hooks.map((h) => h.command)).join(' ');
  assert.ok(commandsFor('SessionStart').includes('session-start-freshness.js'));
  assert.ok(commandsFor('SessionStart').includes('billing-path-check.js'));
  assert.ok(commandsFor('SessionStart').includes('marketplace-freshness-cache.js'));
  assert.ok(commandsFor('UserPromptSubmit').includes('user-prompt-freshness.js'));
  const all = Object.keys(hooks).map(commandsFor).join(' ');
  assert.ok(!all.includes('observability'), 'observability hooks belong to the observability plugin');
  assert.ok(!all.includes('request-body-preflight'), 'the request-body preflight belongs to the observability plugin');
});

test('parses a healthy gateway doctor report, including the prefixed version line', () => {
  const { parseGatewayDoctorOutput } = require('../hooks/session-start-freshness.js');
  const healthy = [
    'binary: C:/Users/user/.claude/model-gateway/bin/claude-code-proxy.exe',
    'version: claude-code-proxy 0.1.33',
    'codex auth: authenticated',
    'grok auth: present (0.2.112)',
    'proxy (claude-code-proxy) on :18765: answering /v1/models',
    'models advertised to Claude Code: 19',
    'shim (model router) on :18764: running (serving 0.48.6)',
    'serving shim version: 0.48.6',
  ].join('\n');

  assert.deepEqual(parseGatewayDoctorOutput(healthy), {
    available: true,
    proxyVersion: '0.1.33',
    auth: true,
    proxy: true,
    shim: true,
  });
});

test('parses a down gateway doctor report as down', () => {
  const { parseGatewayDoctorOutput } = require('../hooks/session-start-freshness.js');
  const down = [
    'version: claude-code-proxy 0.1.33',
    'codex auth: MISSING',
    'proxy (claude-code-proxy) on :18765: DOWN',
    'shim (model router) on :18764: DOWN',
  ].join('\n');

  const parsed = parseGatewayDoctorOutput(down);
  assert.equal(parsed.auth, false);
  assert.equal(parsed.proxy, false);
  assert.equal(parsed.shim, false);
});

test('a healthy doctor report produces no gateway problems from the audit', () => {
  const { parseGatewayDoctorOutput } = require('../hooks/session-start-freshness.js');
  const healthy = [
    'version: claude-code-proxy 0.1.33',
    'codex auth: authenticated',
    'proxy (claude-code-proxy) on :18765: answering /v1/models',
    'shim (model router) on :18764: running (serving 0.48.6)',
  ].join('\n');

  const result = audit(fixture({
    registry: {
      plugins: {
        'model-gateway@eigenwise-toolshed': [{ scope: 'user', version: '1.0.0', installPath: 'C:/gateway' }],
      },
    },
    manifestFor: () => ({ plugins: [{ name: 'model-gateway', version: '1.0.0' }] }),
    checkGateway: () => ({ minProxyVersion: '0.1.14', ...parseGatewayDoctorOutput(healthy) }),
  }));

  assert.doesNotMatch(findingText(result.problems).join('\n'), /model-gateway/);
});

test('the doctor phrasings the audit parses still exist in model-gateway', () => {
  const commandsSource = fs.readFileSync(
    path.join(__dirname, '..', '..', 'model-gateway', 'lib', 'commands.js'),
    'utf8',
  );
  assert.match(commandsSource, /proxy \(claude-code-proxy\)[^\n]*answering \/v1\/models/,
    'model-gateway reworded the healthy proxy line; update parseGatewayDoctorOutput in session-start-freshness.js');
  assert.match(commandsSource, /shim \(model router\)[^\n]*running/,
    'model-gateway reworded the healthy shim line; update parseGatewayDoctorOutput in session-start-freshness.js');
  assert.match(commandsSource, /codex auth: \$\{[^}]*'authenticated'/,
    'model-gateway reworded the codex auth line; update parseGatewayDoctorOutput in session-start-freshness.js');
});

// A real directory, because the detector reads the filesystem: an injected existsSync would also decide the
// stale-worktree sweep, and the fake project paths every other test uses are exactly what keeps this quiet there.
function mappedProject(t, { withMap = true } = {}) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'quartermaster-mapped-project-'));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  if (withMap) fs.mkdirSync(path.join(project, '.claude', '.codebase-info'), { recursive: true });
  return project;
}

test('SQ-2209: a codebase map with no codebase-mapper install reaches the user', (t) => {
  const project = mappedProject(t);
  const output = hookOutput({
    ...hookFixture({
      'quartermaster@eigenwise-toolshed': [{ scope: 'project', projectPath: project, version: '0.49.0' }],
    }, { quartermaster: '0.49.0' }),
    loadedVersion: '0.49.0',
    input: { cwd: project },
  });

  assert.match(output.systemMessage, /this project has a codebase map but no codebase-mapper install/);
  assert.match(output.hookSpecificOutput.additionalContext, /nothing maintains it/);
});

test('SQ-2209: a user-scope codebase-mapper is named as such, and a project install says nothing', (t) => {
  const project = mappedProject(t);
  const fixture = (instances) => hookOutput({
    ...hookFixture({
      'quartermaster@eigenwise-toolshed': [{ scope: 'project', projectPath: project, version: '0.49.0' }],
      'codebase-mapper@eigenwise-toolshed': instances,
    }, { quartermaster: '0.49.0', 'codebase-mapper': '2.15.5' }),
    loadedVersion: '0.49.0',
    input: { cwd: project },
  });

  assert.match(
    fixture([{ scope: 'user', version: '2.15.5' }]).systemMessage,
    /no project\/local codebase-mapper install/,
  );
  assert.equal(fixture([{ scope: 'project', projectPath: project, version: '2.15.5' }]), null);
});

function enablePlugins(directory, file, enabledPlugins) {
  fs.mkdirSync(path.join(directory, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(directory, '.claude', file), JSON.stringify({ enabledPlugins }));
}

test('SQ-2237: project settings without a codebase-mapper install report a dead flag', (t) => {
  const project = mappedProject(t);
  enablePlugins(project, 'settings.json', { 'codebase-mapper@eigenwise-toolshed': true });
  const output = (mapperInstances = []) => hookOutput({
    ...hookFixture({
      'quartermaster@eigenwise-toolshed': [{ scope: 'project', projectPath: project, version: '0.49.0' }],
      'codebase-mapper@eigenwise-toolshed': mapperInstances,
    }, { quartermaster: '0.49.0', 'codebase-mapper': '2.15.5' }),
    loadedVersion: '0.49.0',
    input: { cwd: project },
  });

  assert.match(output().systemMessage, /codebase-mapper enabled in .claude\/settings.json but no matching project install/);
  assert.match(output().hookSpecificOutput.additionalContext, /hooks are not running/);
  assert.match(output().hookSpecificOutput.additionalContext, /install codebase-mapper at project scope or remove the dead enabledPlugins entry/);
  assert.equal(output([{ scope: 'project', projectPath: project, version: '2.15.5' }]), null);

  enablePlugins(project, 'settings.local.json', { 'codebase-mapper@eigenwise-toolshed': false });
  assert.match(output().systemMessage, /this project has a codebase map but no codebase-mapper install/);
  assert.doesNotMatch(output().systemMessage, /hooks are not running/);
});

test('SQ-2237: user settings without a user codebase-mapper install report a dead flag', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quartermaster-settings-home-'));
  const project = mappedProject(t);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  enablePlugins(home, 'settings.json', { 'codebase-mapper@eigenwise-toolshed': true });
  const result = (mapperInstances) => audit(fixture({
    home,
    currentProject: project,
    registry: { plugins: { 'codebase-mapper@eigenwise-toolshed': mapperInstances } },
  }));

  assert.match(findingText(result([]).projectProblems).join('\n'), /enabled in ~\/\.claude\/settings.json but no matching user install/);
  assert.match(findingText(result([]).projectProblems).join('\n'), /hooks are not running/);
  assert.doesNotMatch(findingText(result([{ scope: 'user', version: '2.15.5' }]).projectProblems).join('\n'), /hooks are not running/);
  assert.match(findingText(result([{ scope: 'user', version: '2.15.5' }]).projectProblems).join('\n'), /no project\/local codebase-mapper install/);
});

test('SQ-2211: a Toolshed marketplace declaration with auto-update on is not reported as off', (t) => {
  const project = mappedProject(t, { withMap: false });
  const output = () => hookOutput({
    ...hookFixture({
      'quartermaster@eigenwise-toolshed': [{ scope: 'project', projectPath: project, version: '0.49.0' }],
    }, { quartermaster: '0.49.0' }),
    marketplaces: { 'eigenwise-toolshed': { lastUpdated: new Date().toISOString() } },
    loadedVersion: '0.49.0',
    input: { cwd: project },
  });

  assert.match(output().systemMessage, /eigenwise-toolshed auto-update is off/);

  fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(project, '.claude', 'settings.json'), JSON.stringify({
    extraKnownMarketplaces: { 'eigenwise-toolshed': { autoUpdate: true } },
  }));
  // A later layer that names the marketplace without a flag must not read as a disable.
  fs.writeFileSync(path.join(project, '.claude', 'settings.local.json'), JSON.stringify({
    extraKnownMarketplaces: { 'eigenwise-toolshed': { source: { source: 'github', repo: 'eigenwise/eigenwise-toolshed' } } },
  }));
  assert.doesNotMatch(output().systemMessage, /eigenwise-toolshed auto-update is off/);
});

test('SQ-2237: settings-only Sidequest enablement reports a board dead flag', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quartermaster-settings-home-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'quartermaster-settings-board-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  enablePlugins(project, 'settings.local.json', { 'sidequest@eigenwise-toolshed': true });

  const board = { name: 'current', path: project };
  const enabledWithoutInstall = boardMappings([board], [], home);
  assert.equal(enabledWithoutInstall.mappings[0].status, 'missing');
  assert.match(findingText(enabledWithoutInstall.problems).join('\n'), /Sidequest enabled in .claude\/settings.local.json but no matching project install/);
  assert.match(findingText(enabledWithoutInstall.problems).join('\n'), /hooks are not running/);
  assert.match(findingText(enabledWithoutInstall.problems).join('\n'), /install Sidequest at project scope or remove the dead enabledPlugins entry/);

  const enabledAndInstalled = boardMappings([board], [{ id: 'sidequest@eigenwise-toolshed', scope: 'project', projectPath: project }], home);
  assert.deepEqual(enabledAndInstalled.problems, []);
  assert.equal(enabledAndInstalled.mappings[0].status, 'installed');

  enablePlugins(home, 'settings.json', { 'sidequest@eigenwise-toolshed': true });
  const otherBoard = { name: 'other', path: path.join(home, 'board-without-settings') };
  const userEnabledWithoutInstall = boardMappings([otherBoard], [], home);
  assert.match(findingText(userEnabledWithoutInstall.problems).join('\n'), /enabled in ~\/\.claude\/settings.json but no matching user install/);
  assert.match(findingText(userEnabledWithoutInstall.problems).join('\n'), /hooks are not running/);

  const userEnabledAndInstalled = boardMappings([otherBoard], [{ id: 'sidequest@eigenwise-toolshed', scope: 'user' }], home);
  assert.equal(userEnabledAndInstalled.mappings[0].status, 'user-only');
  assert.deepEqual(findingText(userEnabledAndInstalled.problems), ['Sidequest board other has no project/local Sidequest install']);
});

test('SQ-2209: a project without a codebase map is not asked to install a mapper', (t) => {
  const project = mappedProject(t, { withMap: false });

  assert.equal(hookOutput({
    ...hookFixture({
      'quartermaster@eigenwise-toolshed': [{ scope: 'project', projectPath: project, version: '0.49.0' }],
    }, { quartermaster: '0.49.0' }),
    loadedVersion: '0.49.0',
    input: { cwd: project },
  }), null);
});
