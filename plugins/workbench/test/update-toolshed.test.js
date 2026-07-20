'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  gatewayCommand,
  gatewayWiringMode,
  hasGatewayWiringMode,
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

test('dry-run scopes the update plan to Toolshed and does not enumerate third-party plugins', () => withRegistry(registry, (registryFile) => {
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
  assert.match(lines.join('\n'), /marketplace.*update.*eigenwise-toolshed/);
  assert.doesNotMatch(lines.join('\n'), /another-marketplace|managed-marketplace|other@another-marketplace/);
  assert.match(lines.join('\n'), /Other marketplaces are managed by Claude Code auto-update — not touched\./);
  assert.match(lines.join('\n'), /sidequest@eigenwise-toolshed \(project, C:\/work\/project\)/);
  assert.match(lines.join('\n'), /codex-gateway setup/);
}));

test('update and check modes touch only Toolshed installs', () => withRegistry(registry, (registryFile) => {
  const updateCalls = [];
  runUpdate({
    registryFile,
    options: { claude: 'claude', dryRun: false, check: false },
    run: (command) => {
      updateCalls.push(command);
      return { ok: true };
    },
    report: () => {},
  });

  assert.ok(updateCalls.some((command) => command.args.join(' ') === 'plugin marketplace update eigenwise-toolshed'));
  assert.equal(updateCalls.some((command) => command.args.join(' ').includes('another-marketplace') || command.args.join(' ').includes('other@')), false);

  const checkCalls = [];
  const lines = [];
  runUpdate({
    registryFile,
    options: { claude: 'claude', dryRun: false, check: true },
    run: (command) => {
      checkCalls.push(command);
      return { ok: true };
    },
    report: (line) => lines.push(line),
  });

  assert.equal(checkCalls.length, 1);
  assert.equal(checkCalls[0].args.at(-1), 'doctor');
  assert.equal(checkCalls[0].args.join(' ').includes('another-marketplace'), false);
  assert.match(lines.join('\n'), /Other marketplaces are managed by Claude Code auto-update — not touched\./);
}));

test('local mode wires recorded projects before removing the legacy global block', () => withRegistry(registry, (registryFile) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'toolshed-local-wiring-'));
  try {
    const calls = [];
    const result = runUpdate({
      home,
      registryFile,
      options: { claude: 'claude', dryRun: false, check: false },
      run: (command) => {
        calls.push(command);
        return { ok: true };
      },
      report: () => {},
    });

    const wiring = calls.filter((command) => command.args.includes('env'));
    assert.deepEqual(wiring.map((command) => command.args.slice(-2)), [
      ['env', '--write-project'],
      ['env', '--write-project'],
      ['--write-user', '--remove'],
    ]);
    assert.deepEqual(wiring.slice(0, 2).map((command) => command.cwd), ['C:/work/local', 'C:/work/project']);
    assert.equal(result.healedGatewayWiring.mode, 'local');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}));

test('local mode preserves global wiring when a recorded project fails', () => withRegistry(registry, (registryFile) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'toolshed-local-wiring-failure-'));
  try {
    const calls = [];
    runUpdate({
      home,
      registryFile,
      options: { claude: 'claude', dryRun: false, check: false },
      run: (command) => {
        calls.push(command);
        return { ok: !command.args.includes('--write-project') };
      },
      report: () => {},
    });

    assert.equal(calls.some((command) => command.args.includes('--remove')), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}));

test('global mode writes only user settings', () => withRegistry(registry, (registryFile) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'toolshed-global-wiring-'));
  try {
    const config = path.join(home, '.claude', 'codex-gateway', 'wiring.json');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, JSON.stringify({ mode: 'global' }));
    assert.equal(gatewayWiringMode(home), 'global');
    const calls = [];
    runUpdate({
      home,
      registryFile,
      options: { claude: 'claude', dryRun: false, check: false },
      run: (command) => {
        calls.push(command);
        return { ok: true };
      },
      report: () => {},
    });

    const wiring = calls.filter((command) => command.args.includes('env'));
    assert.deepEqual(wiring.map((command) => command.args.slice(-1)), [['--write-user']]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}));

test('mode switch migrates recorded projects and retains redundant local blocks', () => withRegistry(registry, (registryFile) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'toolshed-mode-switch-'));
  try {
    const lines = [];
    const calls = [];
    const result = runUpdate({
      home,
      registryFile,
      options: { claude: 'claude', dryRun: false, check: false, wiringMode: 'global' },
      run: (command) => {
        calls.push(command);
        return { ok: true };
      },
      report: (line) => lines.push(line),
    });

    assert.equal(hasGatewayWiringMode(home), true);
    assert.equal(gatewayWiringMode(home), 'global');
    assert.equal(result.healedGatewayWiring.mode, 'global');
    assert.deepEqual(calls.filter((command) => command.args.includes('env')).map((command) => command.args.slice(-1)), [['--write-user']]);
    assert.match(lines.join('\n'), /Existing per-project blocks remain in 2 recorded project\(s\); they are redundant/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}));

test('headless update defaults an unset wiring mode to per-project with a notice', () => withRegistry(registry, (registryFile) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'toolshed-default-mode-'));
  try {
    const lines = [];
    runUpdate({
      home,
      registryFile,
      options: { claude: 'claude', dryRun: false, check: false },
      run: () => ({ ok: true }),
      report: (line) => lines.push(line),
    });

    assert.equal(hasGatewayWiringMode(home), false);
    assert.match(lines.join('\n'), /Wiring mode defaulted to per-project; run \/workbench:update-toolshed --wiring-mode global to change\./);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
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
  assert.equal(failed.failures.length, 6);
  assert.match(failed.failures.join('\n'), /eigenwise-toolshed marketplace/);
  assert.doesNotMatch(failed.failures.join('\n'), /another-marketplace|other@another-marketplace/);
  assert.match(failed.failures.join('\n'), /codex-gateway setup/);
}));

test('parses check, dry-run, and wiring-mode options', () => {
  assert.deepEqual(parseArgs(['--check', '--dry-run', '--claude', 'claude-dev']), {
    check: true,
    dryRun: true,
    claude: 'claude-dev',
  });
  assert.deepEqual(parseArgs(['--wiring-mode', 'global']), {
    check: false,
    dryRun: false,
    claude: 'claude',
    wiringMode: 'global',
  });
  assert.throws(() => parseArgs(['--wiring-mode', 'elsewhere']), /--wiring-mode requires local or global/);
});
