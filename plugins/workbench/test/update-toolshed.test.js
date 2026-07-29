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
      { scope: 'project', projectPath: os.tmpdir(), version: '1.0.0', installPath: 'C:/cache/sidequest', gitCommitSha: 'project-sha' },
      { scope: 'local', projectPath: process.cwd(), version: '1.0.0', installPath: 'C:/cache/sidequest', gitCommitSha: 'local-sha' },
    ],
    'model-gateway@eigenwise-toolshed': [
      { scope: 'user', installPath: 'C:/cache/model-gateway/0.2.0', lastUpdated: '2026-07-17T12:00:00Z', gitCommitSha: 'gateway-sha' },
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
    'model-gateway@eigenwise-toolshed',
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
  assert.equal(project.cwd, registry.plugins['sidequest@eigenwise-toolshed'][1].projectPath);
  assert.equal(local.cwd, registry.plugins['sidequest@eigenwise-toolshed'][2].projectPath);
  assert.equal(user.cwd, undefined);
});

test('uses the installed model-gateway setup and doctor commands', () => {
  const installs = installedPlugins(registry);
  const setup = gatewayCommand(installs, 'setup');
  const doctor = gatewayCommand(installs, 'doctor');

  assert.equal(setup.args.at(-1), 'setup');
  assert.equal(setup.args.at(-2), path.join('C:/cache/model-gateway/0.2.0', 'bin', 'model-gateway.js'));
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
  assert.ok(lines.some((line) => line.includes(`sidequest@eigenwise-toolshed (project, ${registry.plugins['sidequest@eigenwise-toolshed'][1].projectPath})`)));
  assert.match(lines.join('\n'), /model-gateway setup/);
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

test('legacy codex-gateway installs stop before stale updates, setup, or wiring', () => {
  const legacy = structuredClone(registry);
  delete legacy.plugins['model-gateway@eigenwise-toolshed'];
  legacy.plugins['codex-gateway@eigenwise-toolshed'] = [{
    scope: 'user',
    version: '0.37.0',
    installPath: 'C:/cache/codex-gateway/0.37.0',
  }];

  return withRegistry(legacy, (registryFile) => {
    const calls = [];
    const lines = [];
    const result = runUpdate({
      registryFile,
      options: { claude: 'claude', dryRun: false, check: false },
      run: (command) => {
        calls.push(command);
        return { ok: true };
      },
      report: (line) => lines.push(line),
    });

    assert.equal(result.ok, false);
    assert.equal(result.migrationRequired, true);
    assert.equal(calls.length, 0);
    assert.doesNotMatch(lines.join('\n'), /plugin update codex-gateway/);
    assert.match(lines.join('\n'), /normal updater will not run stale codex-gateway setup or wiring/);
    assert.match(lines.join('\n'), /Close every Claude Code session using Codex/);
    assert.match(lines.join('\n'), /--migrate-model-gateway --confirm-sessions-closed/);
  });
});

test('deferred migration installs model-gateway, moves owned state, verifies it, then retires codex-gateway', () => {
  const legacy = structuredClone(registry);
  delete legacy.plugins['model-gateway@eigenwise-toolshed'];
  legacy.plugins['codex-gateway@eigenwise-toolshed'] = [{
    scope: 'user',
    version: '0.37.0',
    installPath: 'C:/cache/codex-gateway/0.37.0',
  }];

  return withRegistry(legacy, (registryFile) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'toolshed-gateway-rename-'));
    try {
      const legacyState = path.join(home, '.claude', 'codex-gateway');
      fs.mkdirSync(legacyState, { recursive: true });
      fs.writeFileSync(path.join(legacyState, 'wiring.json'), '{"mode":"local"}\n');
      const calls = [];
      const result = require('../bin/update-toolshed.js').runModelGatewayMigration({
        home,
        registryFile,
        options: { claude: 'claude', dryRun: false, check: false, confirmSessionsClosed: true },
        run: (command) => {
          calls.push(command);
          if (command.args.join(' ') === 'plugin install model-gateway@eigenwise-toolshed --scope user') {
            const next = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
            next.plugins['model-gateway@eigenwise-toolshed'] = [{
              scope: 'user',
              installPath: 'C:/cache/model-gateway/0.39.0',
              lastUpdated: '2026-07-29T00:00:00Z',
            }];
            fs.writeFileSync(registryFile, JSON.stringify(next));
          }
          return { ok: true };
        },
        report: () => {},
      });

      assert.equal(result.ok, true);
      assert.equal(fs.existsSync(path.join(home, '.claude', 'codex-gateway')), false);
      assert.equal(fs.existsSync(path.join(home, '.claude', 'model-gateway', 'wiring.json')), true);
      assert.deepEqual(calls.map((command) => command.args.at(-1)), [
        'user', 'setup', 'ensure', 'doctor', '--write-project', '--write-project', '--remove', 'user',
      ]);
      assert.equal(calls.at(-1).args.join(' '), 'plugin uninstall codex-gateway@eigenwise-toolshed --scope user');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

test('deferred migration leaves an already-migrated install alone', () => withRegistry(registry, (registryFile) => {
  const calls = [];
  const result = require('../bin/update-toolshed.js').runModelGatewayMigration({
    registryFile,
    options: { claude: 'claude', dryRun: false, check: false, confirmSessionsClosed: true },
    run: (command) => {
      calls.push(command);
      return { ok: true };
    },
    report: () => {},
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 0);
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
    assert.deepEqual(wiring.slice(0, 2).map((command) => command.cwd), [
      registry.plugins['sidequest@eigenwise-toolshed'][2].projectPath,
      registry.plugins['sidequest@eigenwise-toolshed'][1].projectPath,
    ]);
    assert.equal(result.healedGatewayWiring.mode, 'local');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}));

test('skips stale project installs without blocking local gateway migration', () => {
  const stalePath = path.join(os.tmpdir(), `toolshed-stale-project-${process.pid}-${Date.now()}`);
  const configured = structuredClone(registry);
  configured.plugins['sidequest@eigenwise-toolshed'].push({
    scope: 'local',
    projectPath: stalePath,
    version: '1.0.0',
    installPath: 'C:/cache/sidequest',
    gitCommitSha: 'stale-sha',
  });

  return withRegistry(configured, (registryFile) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'toolshed-stale-wiring-'));
    try {
      const calls = [];
      const lines = [];
      const result = runUpdate({
        home,
        registryFile,
        options: { claude: 'claude', dryRun: false, check: false },
        run: (command) => {
          calls.push(command);
          return { ok: true };
        },
        report: (line) => lines.push(line),
      });

      assert.equal(result.ok, true);
      assert.deepEqual(result.failures, []);
      assert.equal(result.staleInstances.length, 1);
      assert.equal(calls.some((command) => command.cwd === stalePath), false);
      assert.equal(calls.some((command) => command.args.includes('--remove')), true);
      assert.match(lines.join('\n'), /Skipped 1 stale project install\(s\): directory no longer exists/);
      assert.match(lines.join('\n'), /The plugin registry was left unchanged/);
      assert.doesNotMatch(lines.join('\n'), /Completed with \d+ failure/);
      const saved = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
      assert.ok(saved.plugins['sidequest@eigenwise-toolshed'].some((install) => install.projectPath === stalePath));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

test('GCs only missing Sidequest agent worktree registry entries and preserves a backup', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toolshed-agent-worktree-'));
  const missingAgentWorktree = path.join(root, '.claude', 'worktrees', 'agent-gone');
  const liveAgentWorktree = path.join(root, '.claude', 'worktrees', 'agent-live');
  const missingProject = path.join(root, 'deleted-project');
  fs.mkdirSync(liveAgentWorktree, { recursive: true });

  const configured = structuredClone(registry);
  configured.plugins['sidequest@eigenwise-toolshed'].push(
    { scope: 'local', projectPath: missingAgentWorktree, version: '1.0.0' },
    { scope: 'local', projectPath: liveAgentWorktree, version: '1.0.0' },
    { scope: 'project', projectPath: missingProject, version: '1.0.0' },
  );

  try {
    withRegistry(configured, (registryFile) => {
      const original = fs.readFileSync(registryFile, 'utf8');
      const lines = [];
      const result = runUpdate({
        registryFile,
        options: { claude: 'claude', dryRun: false, check: false },
        run: () => ({ ok: true }),
        report: (line) => lines.push(line),
      });

      const saved = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
      const paths = saved.plugins['sidequest@eigenwise-toolshed'].map((install) => install.projectPath);
      assert.equal(result.registryGc.cleaned, true);
      assert.equal(result.registryGc.entries.length, 1);
      assert.equal(paths.includes(missingAgentWorktree), false);
      assert.ok(paths.includes(liveAgentWorktree));
      assert.ok(paths.includes(missingProject));
      assert.ok(fs.existsSync(result.registryGc.backupPath));
      assert.equal(fs.readFileSync(result.registryGc.backupPath, 'utf8'), original);
      assert.match(lines.join('\n'), /Removed 1 stale Sidequest agent worktree plugin registry install/);
      assert.match(lines.join('\n'), new RegExp(`Registry backup: ${result.registryGc.backupPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      assert.match(lines.join('\n'), /Skipped 1 stale project install\(s\): directory no longer exists/);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('check mode reports stale Sidequest agent worktree entries without changing the registry', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toolshed-agent-worktree-check-'));
  const missingAgentWorktree = path.join(root, '.claude', 'worktrees', 'agent-gone');
  const configured = structuredClone(registry);
  configured.plugins['sidequest@eigenwise-toolshed'].push({ scope: 'local', projectPath: missingAgentWorktree, version: '1.0.0' });

  try {
    withRegistry(configured, (registryFile) => {
      const original = fs.readFileSync(registryFile, 'utf8');
      const lines = [];
      const result = runUpdate({
        registryFile,
        options: { claude: 'claude', dryRun: false, check: true },
        run: () => ({ ok: true }),
        report: (line) => lines.push(line),
      });

      assert.equal(result.registryGc.cleaned, false);
      assert.equal(result.registryGc.entries.length, 1);
      assert.equal(fs.readFileSync(registryFile, 'utf8'), original);
      assert.match(lines.join('\n'), /Found 1 stale Sidequest agent worktree plugin registry install/);
      assert.match(lines.join('\n'), /Registry cleanup was not run in check mode/);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('reports invalid plugin registries and leaves them untouched', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'toolshed-invalid-registry-'));
  const registryFile = path.join(directory, 'installed_plugins.json');
  fs.writeFileSync(registryFile, '{ not valid JSON');
  const lines = [];

  try {
    assert.throws(() => runUpdate({
      registryFile,
      options: { claude: 'claude', dryRun: false, check: false },
      report: (line) => lines.push(line),
    }));
    assert.equal(fs.readFileSync(registryFile, 'utf8'), '{ not valid JSON');
    assert.deepEqual(fs.readdirSync(directory), ['installed_plugins.json']);
    assert.match(lines.join('\n'), /Registry GC skipped: .*Registry was left unchanged/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('local mode preserves global wiring when a recorded project fails', () => withRegistry(registry, (registryFile) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'toolshed-local-wiring-failure-'));
  try {
    const calls = [];
    const lines = [];
    const result = runUpdate({
      home,
      registryFile,
      options: { claude: 'claude', dryRun: false, check: false },
      run: (command) => {
        calls.push(command);
        return { ok: !command.args.includes('--write-project') };
      },
      report: (line) => lines.push(line),
    });

    assert.equal(result.ok, false);
    assert.ok(result.failures.some((failure) => failure.includes('model-gateway wire project')));
    assert.match(lines.join('\n'), /Gateway local wiring kept legacy global settings because one or more recorded projects could not be wired/);
    assert.equal(calls.some((command) => command.args.includes('--remove')), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}));

test('global mode writes only user settings', () => withRegistry(registry, (registryFile) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'toolshed-global-wiring-'));
  try {
    const config = path.join(home, '.claude', 'model-gateway', 'wiring.json');
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
  assert.match(failed.failures.join('\n'), /model-gateway setup/);
}));

test('reports version transitions and gateway interruption before setup', () => withRegistry(registry, (registryFile) => {
  const configured = structuredClone(registry);
  configured.plugins['model-gateway@eigenwise-toolshed'][0].version = '0.2.0';
  fs.writeFileSync(registryFile, JSON.stringify(configured));
  const lines = [];
  runUpdate({
    registryFile,
    options: { claude: 'claude', dryRun: false, check: false },
    run: (command) => {
      if (command.args.join(' ') === 'plugin update model-gateway@eigenwise-toolshed --scope user') {
        const next = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
        next.plugins['model-gateway@eigenwise-toolshed'][0].version = '0.3.0';
        fs.writeFileSync(registryFile, JSON.stringify(next));
      }
      return { ok: true };
    },
    report: (line) => lines.push(line),
  });

  assert.match(lines.join('\n'), /model-gateway@eigenwise-toolshed 0\.2\.0 -> 0\.3\.0/);
  assert.match(lines.join('\n'), /Live Claude Code sessions using Codex stay connected/);
  assert.match(lines.join('\n'), /cannot reliably list commit subjects/);
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
  assert.deepEqual(parseArgs(['--migrate-model-gateway', '--confirm-sessions-closed']), {
    check: false,
    dryRun: false,
    claude: 'claude',
    migrateModelGateway: true,
    confirmSessionsClosed: true,
  });
  assert.throws(() => parseArgs(['--wiring-mode', 'elsewhere']), /--wiring-mode requires local or global/);
});
