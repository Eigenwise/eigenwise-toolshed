"use strict";
const { existsSync, readdirSync, readFileSync } = require("node:fs");
const path = require("node:path");
const DEFAULT_TEST_TIMEOUT = 12e4;
const MAX_TEST_TIMEOUT = 36e5;
function readJson(filePath) {
  return existsSync(filePath) ? JSON.parse(readFileSync(filePath, "utf8")) : {};
}
function declaredSuiteTimeout(pluginManifest) {
  const declared = pluginManifest.suiteTimeout;
  const usable = Number.isInteger(declared) && declared > 0 && declared <= MAX_TEST_TIMEOUT;
  return usable ? declared : DEFAULT_TEST_TIMEOUT;
}
const MODULE_TEST_COMMANDS = /* @__PURE__ */ new Map([
  ["sidequest", "node scripts/test-guards-module.mjs"]
]);
const SUITE_SHARDS = /* @__PURE__ */ new Map([
  ["sidequest", { windows: 3 }]
]);
function includeModuleTests(pluginDirectory, suite) {
  const shards = SUITE_SHARDS.get(suite.plugin);
  if (shards) suite = { ...suite, shards };
  const hooks = readJson(path.join(pluginDirectory, "hooks", "hooks.json"));
  if (!Array.isArray(hooks.modules)) return suite;
  return { ...suite, moduleTest: MODULE_TEST_COMMANDS.get(suite.plugin) ?? "claude plugin test ." };
}
function packageScriptSuite(plugin, scripts) {
  for (const script of ["test:full", "test"]) {
    if (scripts?.[script]) {
      return {
        plugin: plugin.name,
        cwd: plugin.dir,
        setup: "npm ci",
        command: script === "test" ? "npm test" : `npm run ${script}`
      };
    }
  }
  return null;
}
function directTestSuite(pluginDirectory, plugin, pluginManifest) {
  const testDirectory = path.join(pluginDirectory, "test");
  if (existsSync(testDirectory) && readdirSync(testDirectory).some((name) => name.endsWith(".test.js"))) {
    const timeout = declaredSuiteTimeout(pluginManifest);
    return { plugin: plugin.name, cwd: plugin.dir, setup: null, command: `node --test --test-timeout=${timeout} "test/*.test.js"` };
  }
  return null;
}
function resolveSuite(repoRoot, plugin) {
  const pluginDirectory = path.join(repoRoot, plugin.dir);
  const packageJson = readJson(path.join(pluginDirectory, "package.json"));
  const pluginManifest = readJson(path.join(pluginDirectory, ".claude-plugin", "plugin.json"));
  const suite = packageScriptSuite(plugin, packageJson.scripts) ?? directTestSuite(pluginDirectory, plugin, pluginManifest);
  return suite ? includeModuleTests(pluginDirectory, suite) : null;
}
function createSuiteResolver(repoRoot) {
  return (plugin) => resolveSuite(repoRoot, plugin);
}
module.exports = { resolveSuite, createSuiteResolver };
