'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  gatewayCommand,
  installedToolshedPlugins,
  parseArgs,
  runUpdate,
  updateCommand,
} = require('../bin/update-toolshed.js');

const registry = {
  plugins: {
    'sidequest@eigenwise-toolshed': [
      { scope: 'user', version: '1.0.0' },
      { scope: 'project', projectPath: 'C:/work/project', version: '1.0.0' },
      { scope: 'local', projectPath: 'C:/work/local', version: '1.0.0' },
    ],
    'codex-gateway@eigenwise-toolshed': [
      { scope: 'user', installPath: 'C:/cache/codex-gateway/0.2.0', lastUpdated: '2026-07-17T12:00:00Z' },
    ],
    'other@another-marketplace': [{ scope: 'user' }],
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

test('enumerates every toolshed install and excludes other marketplaces', () => {
  const installs = installedToolshedPlugins(registry);
  assert.equal(installs.length, 4);
  assert.deepEqual(installs.map((install) => install.id), [
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
  const installs = installedToolshedPlugins(registry);
  const setup = gatewayCommand(installs, 'setup');
  const doctor = gatewayCommand(installs, 'doctor');

  assert.equal(setup.args.at(-1), 'setup');
  assert.equal(setup.args.at(-2), path.join('C:/cache/codex-gateway/0.2.0', 'bin', 'codex-gateway.js'));
  assert.equal(doctor.args.at(-1), 'doctor');
});

test('dry-run reports commands without executing them', () => withRegistry(registry, (registryFile) => {
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
  assert.match(lines.join('\n'), /plugin.*marketplace.*update/);
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

test('continues after failures and returns every failed operation', () => withRegistry(registry, (registryFile) => {
  const failed = runUpdate({
    registryFile,
    options: { claude: 'claude', dryRun: false, check: false },
    run: () => ({ ok: false, error: 'unreachable' }),
    report: () => {},
  });

  assert.equal(failed.ok, false);
  assert.equal(failed.failures.length, 7);
  assert.match(failed.failures.join('\n'), /eigenwise-toolshed marketplace/);
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
