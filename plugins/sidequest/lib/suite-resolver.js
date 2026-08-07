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
function resolveSuite(repoRoot, plugin) {
  const pluginDir = path.join(repoRoot, plugin.dir);
  const packageJson = readJson(path.join(pluginDir, "package.json"));
  const pluginManifest = readJson(path.join(pluginDir, ".claude-plugin", "plugin.json"));
  for (const script of ["test:full", "test"]) {
    if (packageJson.scripts?.[script]) {
      return {
        plugin: plugin.name,
        cwd: plugin.dir,
        setup: "npm ci",
        command: script === "test" ? "npm test" : `npm run ${script}`
      };
    }
  }
  const testDir = path.join(pluginDir, "test");
  if (existsSync(testDir) && readdirSync(testDir).some((name) => name.endsWith(".test.js"))) {
    const timeout = declaredSuiteTimeout(pluginManifest);
    return { plugin: plugin.name, cwd: plugin.dir, setup: null, command: `node --test --test-timeout=${timeout} "test/*.test.js"` };
  }
  return null;
}
function createSuiteResolver(repoRoot) {
  return (plugin) => resolveSuite(repoRoot, plugin);
}
module.exports = { resolveSuite, createSuiteResolver };
