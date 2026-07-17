'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-config-test-'));
process.env.SWITCHBOARD_CONFIG_HOME = path.join(root, 'user-home');
process.env.SWITCHBOARD_HOME = path.join(root, 'legacy-home');
delete process.env.SWITCHBOARD_CONFIG_USER_FILE;
delete process.env.SWITCHBOARD_CONFIG_PROJECT_FILE;
delete process.env.SWITCHBOARD_CONFIG_OVERRIDES;

const config = require('../lib/config.js');
const migrate = require('../lib/migrate.js');

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function route(model, effort) {
  return { model, effort };
}

test('layered config merges category rows and only narrows model caps', () => {
  const project = path.join(root, 'project-layering');
  const user = config.userConfigPath();
  write(user, {
    schemaVersion: 1,
    routing: false,
    allowedModels: ['sonnet', 'opus'],
    allowedRoutes: [route('sonnet', 'medium'), route('opus', 'high')],
    categories: {
      general: { route: route('opus', 'high') },
      focused: {
        id: 'focused',
        name: 'Focused',
        description: 'User category.',
        contract: 'Use the focused route.',
        route: route('opus', 'high'),
        fallback: null,
        enabled: true,
      },
    },
  });
  write(config.projectConfigPath(project), {
    schemaVersion: 1,
    routing: true,
    allowedModels: ['haiku', 'sonnet'],
    allowedRoutes: [route('sonnet', 'medium')],
    categories: {
      focused: { enabled: false },
      general: { enabled: false, description: 'Cannot disable general.' },
    },
  });

  const loaded = config.loadConfig({ projectPath: project, overrides: { categories: { focused: { contract: 'Test override.' } } } }).config;
  assert.strictEqual(loaded.routing, true, 'scalar project layer replaces user value');
  assert.deepStrictEqual(loaded.allowedModels, ['sonnet']);
  assert.deepStrictEqual(loaded.allowedRoutes, [route('sonnet', 'medium')]);
  assert.strictEqual(loaded.categories.focused.enabled, false);
  assert.strictEqual(loaded.categories.focused.contract, 'Test override.');
  assert.strictEqual(loaded.categories.general.enabled, true);
  assert.strictEqual(loaded.categories.general.description, 'Cannot disable general.');
});

test('future schema config is readable but blocks writes with upgrade guidance', () => {
  const file = path.join(root, 'future', 'switchboard.json');
  write(file, { schemaVersion: 2 });
  assert.strictEqual(config.readLayer(file).schemaVersion, 2);
  assert.throws(() => config.writeConfig(file, config.DEFAULT_CONFIG), /schemaVersion 2; this binary supports 1\. Upgrade Switchboard before writing this file/);
});

test('migration previews caps, leaves legacy prefs intact, and applies only on request', () => {
  const source = migrate.legacyPrefsPath();
  const target = config.userConfigPath();
  fs.rmSync(path.dirname(target), { recursive: true, force: true });
  write(source, {
    haiku: false,
    sonnet: true,
    opus: true,
    fable: false,
    efforts: {
      sonnet: { low: false, medium: true, high: true, xhigh: false, max: false },
      opus: { low: true, medium: false, high: true, xhigh: true, max: true },
    },
    routing: false,
    routingBias: 4,
  });

  const preview = migrate.previewMigration();
  assert.strictEqual(preview.found, true);
  assert.strictEqual(fs.existsSync(target), false, 'preview never writes the new config');
  assert.deepStrictEqual(preview.summary.allowedModels, ['opus', 'sonnet']);
  assert.deepStrictEqual(preview.ignored, ['routingBias']);
  assert.deepStrictEqual(preview.summary.allowedRoutes, [
    route('opus', 'low'), route('opus', 'high'), route('opus', 'xhigh'), route('opus', 'max'),
    route('sonnet', 'medium'), route('sonnet', 'high'),
  ]);

  migrate.applyMigration();
  assert.strictEqual(fs.existsSync(source), true, 'legacy prefs remain for rollback');
  const stored = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.strictEqual(stored.schemaVersion, 1);
  assert.strictEqual(stored.routing, false);
  assert.throws(() => migrate.applyMigration(), /Refusing to overwrite existing Switchboard config/);
});

test('migrate CLI requires dry-run or explicit apply and legacy JSON stays marked', () => {
  const bin = path.resolve(__dirname, '../bin/switchboard.js');
  const env = Object.assign({}, process.env, {
    SWITCHBOARD_CONFIG_HOME: path.join(root, 'cli-user'),
    SWITCHBOARD_HOME: path.join(root, 'cli-legacy'),
  });
  write(path.join(env.SWITCHBOARD_HOME, 'prefs.json'), { routing: true, routingBias: 0 });
  const absent = spawnSync(process.execPath, [bin, 'migrate'], { env, encoding: 'utf8' });
  assert.notStrictEqual(absent.status, 0);
  const dryRun = spawnSync(process.execPath, [bin, 'migrate', '--dry-run'], { env, encoding: 'utf8' });
  assert.strictEqual(dryRun.status, 0, dryRun.stderr);
  assert.strictEqual(JSON.parse(dryRun.stdout).applied, false);
  assert.strictEqual(fs.existsSync(path.join(env.SWITCHBOARD_CONFIG_HOME, 'switchboard.json')), false);
  const legacyRoute = spawnSync(process.execPath, [bin, 'route', '6', '--json'], { env, encoding: 'utf8' });
  assert.strictEqual(legacyRoute.status, 0, legacyRoute.stderr);
  assert.strictEqual(JSON.parse(legacyRoute.stdout).legacy, true);
});
