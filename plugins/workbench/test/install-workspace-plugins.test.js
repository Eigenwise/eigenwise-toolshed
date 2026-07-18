'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  computeDelta,
  normalizeProjectPath,
  runInstall,
  validatePlan,
} = require('../bin/install-workspace-plugins.js');

function withWorkspace(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-plugin-install-'));
  try {
    return callback(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function planFor(projectDir, overrides = {}) {
  return {
    version: 1,
    projectDir,
    marketplaces: [{ name: 'eigenwise-toolshed', source: 'Eigenwise/eigenwise-toolshed' }],
    plugins: [{ id: 'codebase-mapper@eigenwise-toolshed', scope: 'project', role: 'core' }],
    userScopeConfirmed: false,
    ...overrides,
  };
}

function inventoryRunner({ marketplaces = [], plugins = [], fail = () => false } = {}) {
  const calls = [];
  const state = { marketplaces: structuredClone(marketplaces), plugins: structuredClone(plugins) };
  const run = (command) => {
    calls.push(command);
    if (fail(command, calls.length)) return { ok: false, output: 'planned failure', status: 1 };

    if (command.args.join(' ') === 'plugin marketplace list --json') {
      return { ok: true, output: JSON.stringify(state.marketplaces), status: 0 };
    }
    if (command.args.join(' ') === 'plugin list --json') {
      return { ok: true, output: JSON.stringify(state.plugins), status: 0 };
    }
    if (command.args.slice(0, 3).join(' ') === 'plugin marketplace add') {
      const source = command.args[3];
      const name = source === 'Eigenwise/eigenwise-toolshed' ? 'eigenwise-toolshed' : source;
      state.marketplaces.push({ name, source: 'github', repo: source });
      return { ok: true, output: 'added marketplace', status: 0 };
    }
    if (command.args.slice(0, 2).join(' ') === 'plugin install') {
      const replacement = {
        id: command.args[2],
        scope: command.args[4],
        enabled: true,
        projectPath: command.args[4] === 'user' ? undefined : command.cwd,
      };
      const existing = state.plugins.findIndex((plugin) => plugin.id === replacement.id
        && plugin.scope === replacement.scope && plugin.projectPath === replacement.projectPath);
      if (existing >= 0) state.plugins[existing] = replacement;
      else state.plugins.push(replacement);
      return { ok: true, output: 'installed plugin', status: 0 };
    }
    throw new Error(`Unexpected command: ${command.args.join(' ')}`);
  };
  return { calls, run, state };
}

test('installs a fresh portable marketplace and selected plugin from the project root', () => withWorkspace((projectDir) => {
  const runner = inventoryRunner();
  const result = runInstall({ plan: planFor(projectDir), run: runner.run });

  assert.equal(result.ok, true);
  assert.equal(result.reloadRequired, true);
  assert.deepEqual(runner.calls.map((call) => call.args), [
    ['plugin', 'marketplace', 'list', '--json'],
    ['plugin', 'list', '--json'],
    ['plugin', 'marketplace', 'add', 'Eigenwise/eigenwise-toolshed', '--scope', 'project'],
    ['plugin', 'marketplace', 'list', '--json'],
    ['plugin', 'install', 'codebase-mapper@eigenwise-toolshed', '--scope', 'project'],
    ['plugin', 'list', '--json'],
  ]);
  assert.equal(runner.calls[2].cwd, projectDir);
  assert.equal(runner.calls[4].cwd, projectDir);
  assert.deepEqual(result.installed, ['codebase-mapper@eigenwise-toolshed']);
}));

test('does no mutations when every selected plugin is enabled at the planned scope', () => withWorkspace((projectDir) => {
  const runner = inventoryRunner({
    marketplaces: [{ name: 'eigenwise-toolshed', source: 'github', repo: 'Eigenwise/eigenwise-toolshed' }],
    plugins: [{ id: 'codebase-mapper@eigenwise-toolshed', scope: 'project', enabled: true, projectPath: projectDir }],
  });
  const result = runInstall({ plan: planFor(projectDir), run: runner.run });

  assert.equal(result.ok, true);
  assert.equal(result.reloadRequired, false);
  assert.equal(runner.calls.length, 2);
  assert.deepEqual(result.plugins.map((plugin) => plugin.status), ['skipped']);
}));

test('reports a same-id plugin at a different project or scope without moving it', () => withWorkspace((projectDir) => {
  const runner = inventoryRunner({
    marketplaces: [{ name: 'eigenwise-toolshed', source: 'github', repo: 'Eigenwise/eigenwise-toolshed' }],
    plugins: [{ id: 'codebase-mapper@eigenwise-toolshed', scope: 'project', enabled: true, projectPath: path.join(projectDir, 'other') }],
  });
  const projectMismatch = runInstall({ plan: planFor(projectDir), run: runner.run });
  assert.equal(projectMismatch.ok, false);
  assert.equal(projectMismatch.plugins[0].status, 'scope-mismatch');
  assert.equal(runner.calls.length, 2);

  const scopeDelta = computeDelta(planFor(projectDir), runner.state.marketplaces, [{ id: 'codebase-mapper@eigenwise-toolshed', scope: 'local', enabled: true, projectPath: projectDir }]);
  assert.equal(scopeDelta.plugins[0].status, 'scope-mismatch');
}));

test('installs a missing marketplace before any selected plugin', () => withWorkspace((projectDir) => {
  const runner = inventoryRunner();
  const result = runInstall({ plan: planFor(projectDir, { plugins: [] }), run: runner.run });

  assert.equal(result.ok, true);
  assert.deepEqual(result.marketplaces.map((marketplace) => marketplace.status), ['missing']);
  assert.equal(runner.calls[2].args[2], 'add');
  assert.equal(runner.calls[2].args[3], 'Eigenwise/eigenwise-toolshed');
  assert.equal(runner.calls.some((call) => call.args[1] === 'install'), false);
}));

test('normalizes Windows project paths when comparing project installs', () => {
  assert.equal(normalizeProjectPath('C:\\Work\\Repo\\'), normalizeProjectPath('c:/work/repo'));
  const delta = computeDelta(planFor('C:/Work/Repo'), [{ name: 'eigenwise-toolshed', source: 'github', repo: 'Eigenwise/eigenwise-toolshed' }], [
    { id: 'codebase-mapper@eigenwise-toolshed', scope: 'project', enabled: true, projectPath: 'c:\\work\\repo' },
  ]);
  assert.equal(delta.plugins[0].status, 'skipped');
});

test('dry-run inventories state and reports mutations without executing them', () => withWorkspace((projectDir) => {
  const runner = inventoryRunner();
  const result = runInstall({ plan: planFor(projectDir), options: { dryRun: true }, run: runner.run });

  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(runner.calls.length, 2);
  assert.deepEqual(result.steps.slice(2).map((step) => step.status), ['dry-run', 'dry-run']);
}));

test('rejects malformed plans before querying or mutating Claude state', () => withWorkspace((projectDir) => {
  const runner = inventoryRunner();
  const malformed = planFor(projectDir, {
    marketplaces: [{ name: 'untrusted', source: 'somebody/random-repo' }],
  });

  assert.throws(() => runInstall({ plan: malformed, run: runner.run }), /not an approved portable source/);
  assert.equal(runner.calls.length, 0);
  assert.throws(() => validatePlan(planFor(projectDir, {
    plugins: [{ id: 'codebase-mapper@eigenwise-toolshed', scope: 'user' }],
  })), /userScopeConfirmed/);
}));

test('installs disabled selected plugins again so Claude can enable them', () => withWorkspace((projectDir) => {
  const runner = inventoryRunner({
    marketplaces: [{ name: 'eigenwise-toolshed', source: 'github', repo: 'Eigenwise/eigenwise-toolshed' }],
    plugins: [{ id: 'codebase-mapper@eigenwise-toolshed', scope: 'project', enabled: false, projectPath: projectDir }],
  });
  const result = runInstall({ plan: planFor(projectDir), run: runner.run });

  assert.equal(result.ok, true);
  assert.equal(result.plugins[0].status, 'disabled');
  assert.equal(runner.calls.filter((call) => call.args[1] === 'install').length, 1);
}));

test('stops after a failed step and keeps completed marketplace work for a safe rerun', () => withWorkspace((projectDir) => {
  const runner = inventoryRunner({
    fail: (command) => command.args[1] === 'install' && command.args[2] === 'optional-plugin@eigenwise-toolshed',
  });
  const plan = planFor(projectDir, {
    plugins: [
      { id: 'codebase-mapper@eigenwise-toolshed', scope: 'project', role: 'core' },
      { id: 'optional-plugin@eigenwise-toolshed', scope: 'project', role: 'optional' },
    ],
  });
  const result = runInstall({ plan, run: runner.run });

  assert.equal(result.ok, false);
  assert.match(result.failure.command, /optional-plugin@eigenwise-toolshed/);
  assert.equal(result.failure.output, 'planned failure');
  assert.equal(runner.state.marketplaces.length, 1);
  assert.equal(runner.state.plugins.some((plugin) => plugin.id === 'codebase-mapper@eigenwise-toolshed'), true);
  assert.equal(runner.state.plugins.some((plugin) => plugin.id === 'optional-plugin@eigenwise-toolshed'), false);
  assert.equal(runner.calls.at(-1).args[2], 'optional-plugin@eigenwise-toolshed');
}));
