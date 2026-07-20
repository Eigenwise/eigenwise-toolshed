'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  gatewayCommand,
  installedPlugins,
  marketplacesFor,
  parseArgs,
  runUpdate,
  updateCommand,
} = require('../bin/update-toolshed.js');

const registry = {
  version: 1,
  plugins: {
    'sidequest@eigenwise-toolshed': [
      { scope: 'user', version: '1.0.0', gitCommitSha: 'user-sha' },
      { scope: 'project', projectPath: 'C:/work/project', version: '1.0.0', installPath: 'C:/cache/sidequest', gitCommitSha: 'project-sha' },
      { scope: 'local', projectPath: 'C:/work/local', version: '1.0.0', installPath: 'C:/cache/sidequest', gitCommitSha: 'local-sha' },
    ],
    'codex-gateway@eigenwise-toolshed': [
      { scope: 'user', installPath: 'C:/cache/codex-gateway/0.2.0', lastUpdated: '2026-07-17T12:00:00Z', gitCommitSha: 'gateway-sha' },
    ],
    'other@another-marketplace': [{ scope: 'user', installPath: 'C:/cache/other', gitCommitSha: 'other-sha' }],
    'managed@managed-marketplace': [{ scope: 'managed', installPath: 'C:/cache/managed', gitCommitSha: 'managed-sha' }],
  },
};

function withRegistry(value, callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'toolshed-updater-'));
  const file = path.join(directory, 'installed_plugins.json');
  fs.writeFileSync(file, JSON.stringify(value));
  try {
    return callback(file);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('enumerates every user, project, and local install across marketplaces', () => {
  const installs = installedPlugins(registry);
  assert.equal(installs.length, 5);
  assert.deepEqual(marketplacesFor(registry), ['another-marketplace', 'eigenwise-toolshed', 'managed-marketplace']);
  assert.deepEqual(installs.map((install) => install.id), [
    'other@another-marketplace',
    'codex-gateway@eigenwise-toolshed',
    'sidequest@eigenwise-toolshed',
    'sidequest@eigenwise-toolshed',
    'sidequest@eigenwise-toolshed',
  ]);
});

test('routes project and local updates through the recorded project directory', () => {
  const project = updateCommand({ id: 'sidequest@eigenwise-toolshed', ...registry.plugins['sidequest@eigenwise-toolshed'][1] }, 'claude');
  const local = updateCommand({ id: 'sidequest@eigenwise-toolshed', ...registry.plugins['sidequest@eigenwise-toolshed'][2] }, 'claude');
  const user = updateCommand({ id: 'sidequest@eigenwise-toolshed', scope: 'user' }, 'claude');

  assert.deepEqual(project.args, ['plugin', 'update', 'sidequest@eigenwise-toolshed', '--scope', 'project']);
  assert.equal(project.cwd, 'C:/work/project');
  assert.equal(local.cwd, 'C:/work/local');
  assert.equal(user.cwd, undefined);
});

test('uses the installed codex-gateway setup and doctor commands', () => {
  const installs = installedPlugins(registry);
  const setup = gatewayCommand(installs, 'setup');
  const doctor = gatewayCommand(installs, 'doctor');

  assert.equal(setup.args.at(-1), 'setup');
  assert.equal(setup.args.at(-2), path.join('C:/cache/codex-gateway/0.2.0', 'bin', 'codex-gateway.js'));
  assert.equal(doctor.args.at(-1), 'doctor');
});

test('dry-run refreshes every marketplace and reports every plugin scope without executing', () => withRegistry(registry, (registryFile) => {
  const calls = [];
  const lines = [];
  const result = runUpdate({
    registryFile,
    options: { claude: 'claude', dryRun: true, check: false },
    run: (command) => {
      calls.push(command);
      return { ok: true };
    },
    report: (line) => lines.push(line),
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 0);
  assert.match(lines.join('\n'), /marketplace.*update.*another-marketplace/);
  assert.match(lines.join('\n'), /marketplace.*update.*eigenwise-toolshed/);
  assert.match(lines.join('\n'), /marketplace.*update.*managed-marketplace/);
  assert.match(lines.join('\n'), /other@another-marketplace \(user\)/);
  assert.match(lines.join('\n'), /sidequest@eigenwise-toolshed \(project, C:\/work\/project\)/);
  assert.match(lines.join('\n'), /codex-gateway setup/);
}));

test('check mode skips updates but runs gateway doctor', () => withRegistry(registry, (registryFile) => {
  const calls = [];
  runUpdate({
    registryFile,
    options: { claude: 'claude', dryRun: false, check: true },
    run: (command) => {
      calls.push(command);
      return { ok: true };
    },
    report: () => {},
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.at(-1), 'doctor');
}));

test('heals stale Workbench status line pins after updating', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'toolshed-statusline-'));
  try {
    const registryFile = path.join(home, '.claude', 'plugins', 'installed_plugins.json');
    const settingsFile = path.join(home, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(registryFile), { recursive: true });
    const workbenchCache = path.join(home, 'cache', 'workbench', '0.30.0');
    fs.mkdirSync(path.join(workbenchCache, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(workbenchCache, 'bin', 'workbench-statusline.js'), 'module.exports = { main() {} };');
    const configuredRegistry = structuredClone(registry);
    configuredRegistry.plugins['workbench@eigenwise-toolshed'] = [{ scope: 'user', version: '0.30.0', installPath: workbenchCache }];
    fs.writeFileSync(registryFile, JSON.stringify(configuredRegistry));
    fs.writeFileSync(settingsFile, JSON.stringify({
      statusLine: { type: 'command', command: 'node "C:/Users/example/.claude/plugins/cache/eigenwise-toolshed/workbench/0.20.0/bin/workbench-statusline.js"' },
    }));

    const result = runUpdate({
      home,
      registryFile,
      options: { claude: 'claude', dryRun: false, check: false },
      run: () => ({ ok: true }),
      report: () => {},
    });

    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    assert.equal(result.healedStatuslines.length, 1);
    assert.equal(settings.statusLine.command, `node --no-warnings "${path.join(home, '.claude', 'workbench-statusline.js')}"`);
    assert.ok(fs.existsSync(path.join(home, '.claude', 'workbench-statusline.js')));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('continues after failures and returns every failed operation', () => withRegistry(registry, (registryFile) => {
  const failed = runUpdate({
    registryFile,
    options: { claude: 'claude', dryRun: false, check: false },
    run: () => ({ ok: false, error: 'unreachable' }),
    report: () => {},
  });

  assert.equal(failed.ok, false);
  assert.equal(failed.failures.length, 10);
  assert.match(failed.failures.join('\n'), /another-marketplace marketplace/);
  assert.match(failed.failures.join('\n'), /eigenwise-toolshed marketplace/);
  assert.match(failed.failures.join('\n'), /other@another-marketplace/);
  assert.match(failed.failures.join('\n'), /codex-gateway setup/);
  assert.match(failed.failures.join('\n'), /codex-gateway doctor/);
}));

test('parses check and dry-run options', () => {
  assert.deepEqual(parseArgs(['--check', '--dry-run', '--claude', 'claude-dev']), {
    check: true,
    dryRun: true,
    claude: 'claude-dev',
  });
});
