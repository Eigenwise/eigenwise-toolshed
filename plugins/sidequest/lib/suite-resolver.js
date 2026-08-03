"use strict";
const { existsSync, readdirSync, readFileSync } = require("node:fs");
const path = require("node:path");
function resolveSuite(repoRoot, plugin) {
  const packagePath = path.join(repoRoot, plugin.dir, "package.json");
  if (existsSync(packagePath)) {
    const scripts = JSON.parse(readFileSync(packagePath, "utf8")).scripts ?? {};
    for (const script of ["test:full", "test"]) {
      if (scripts[script]) {
        return {
          plugin: plugin.name,
          cwd: plugin.dir,
          setup: "npm ci",
          command: script === "test" ? "npm test" : `npm run ${script}`
        };
      }
    }
  }
  const testDir = path.join(repoRoot, plugin.dir, "test");
  if (existsSync(testDir) && readdirSync(testDir).some((name) => name.endsWith(".test.js"))) {
    return { plugin: plugin.name, cwd: plugin.dir, setup: null, command: 'node --test "test/*.test.js"' };
  }
  return null;
}
function createSuiteResolver(repoRoot) {
  return (plugin) => resolveSuite(repoRoot, plugin);
}
module.exports = { resolveSuite, createSuiteResolver };
