'use strict';

const { existsSync, readdirSync, readFileSync } = require('node:fs');
const path = require('node:path');

const DEFAULT_TEST_TIMEOUT = 120000;
const MAX_TEST_TIMEOUT = 3600000;

function readJson(filePath: string) {
  return existsSync(filePath) ? JSON.parse(readFileSync(filePath, 'utf8')) : {};
}

// The returned command is executed by a shell during a release cut, and this
// value comes from a plugin manifest that a third-party plugin can author.
// Anything but a bounded integer is discarded rather than interpolated.
function declaredSuiteTimeout(pluginManifest: any): number {
  const declared = pluginManifest.suiteTimeout;
  const usable = Number.isInteger(declared) && declared > 0 && declared <= MAX_TEST_TIMEOUT;
  return usable ? declared : DEFAULT_TEST_TIMEOUT;
}

type ResolvedSuite = {
  plugin: string;
  cwd: string;
  setup: string | null;
  command: string;
  moduleTest?: string;
  shards?: { windows: number };
};

const MODULE_TEST_COMMANDS = new Map([
  ['sidequest', 'node scripts/test-guards-module.mjs'],
]);

const SUITE_SHARDS = new Map<string, { windows: number }>([
  ['sidequest', { windows: 3 }],
]);

function includeModuleTests(pluginDirectory: string, suite: ResolvedSuite): ResolvedSuite {
  const shards = SUITE_SHARDS.get(suite.plugin);
  if (shards) suite = { ...suite, shards };
  const hooks = readJson(path.join(pluginDirectory, 'hooks', 'hooks.json'));
  if (!Array.isArray(hooks.modules)) return suite;
  return { ...suite, moduleTest: MODULE_TEST_COMMANDS.get(suite.plugin) ?? 'claude plugin test .' };
}

function resolveSuite(repoRoot: string, plugin: any) {
  const pluginDir = path.join(repoRoot, plugin.dir);
  const packageJson = readJson(path.join(pluginDir, 'package.json'));
  const pluginManifest = readJson(path.join(pluginDir, '.claude-plugin', 'plugin.json'));
  for (const script of ['test:full', 'test']) {
    if (packageJson.scripts?.[script]) {
      return includeModuleTests(pluginDir, {
        plugin: plugin.name,
        cwd: plugin.dir,
        setup: 'npm ci',
        command: script === 'test' ? 'npm test' : `npm run ${script}`,
      });
    }
  }

  const testDir = path.join(pluginDir, 'test');
  if (existsSync(testDir) && readdirSync(testDir).some((name: string) => name.endsWith('.test.js'))) {
    const timeout = declaredSuiteTimeout(pluginManifest);
    return includeModuleTests(pluginDir, { plugin: plugin.name, cwd: plugin.dir, setup: null, command: `node --test --test-timeout=${timeout} "test/*.test.js"` });
  }

  return null;
}

function createSuiteResolver(repoRoot: string) {
  return (plugin: any) => resolveSuite(repoRoot, plugin);
}

module.exports = { resolveSuite, createSuiteResolver };
