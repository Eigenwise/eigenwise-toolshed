"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var integration_tests_exports = {};
__export(integration_tests_exports, {
  integrationTestBatches: () => integrationTestBatches,
  runImportingIntegrationTests: () => runImportingIntegrationTests,
  selectIntegrationTests: () => selectIntegrationTests
});
module.exports = __toCommonJS(integration_tests_exports);
var import_node_fs = __toESM(require("node:fs"));
var import_node_path = __toESM(require("node:path"));
var import_process = require("./ports/process.js");
const MODULE_EXTENSIONS = ["", ".ts", ".tsx", ".js", ".mjs", ".cjs", "/index.ts", "/index.js"];
const STATIC_MODULE_SPECIFIER = /\b(?:import\s+(?:[^;'"()]*?\s+from\s*)?|export\s+[^;'"()]*?\s+from\s*|require\s*\(\s*)['"]([^'"\r\n]+)['"]/g;
function moduleIdentity(file) {
  return import_node_path.default.resolve(file).replaceAll("\\", "/");
}
function sourceIdentity(file, plugin) {
  const relative = import_node_path.default.relative(plugin, file).replaceAll("\\", "/");
  if (relative.startsWith("lib/")) {
    const source = moduleIdentity(import_node_path.default.join(plugin, "src", relative)).replace(/\.[cm]?js$/, ".ts");
    if (import_node_fs.default.existsSync(source)) return source;
  }
  if (relative.startsWith("src/")) return moduleIdentity(file).replace(/\.[cm]?js$/, ".ts");
  return moduleIdentity(file);
}
function existingModule(file) {
  return MODULE_EXTENSIONS.map((extension) => file + extension).find((candidate) => import_node_fs.default.existsSync(candidate) && import_node_fs.default.statSync(candidate).isFile());
}
function importedModule(importer, specifier, plugin) {
  if (!specifier.startsWith(".")) return void 0;
  const imported = import_node_path.default.resolve(import_node_path.default.dirname(importer), specifier);
  const source = sourceIdentity(imported, plugin);
  return existingModule(source) ?? existingModule(imported);
}
function staticImports(file, plugin) {
  const imports = Array.from(import_node_fs.default.readFileSync(file, "utf8").matchAll(STATIC_MODULE_SPECIFIER), (match) => match[1]);
  return imports.map((specifier) => importedModule(file, specifier, plugin)).filter((imported) => imported !== void 0);
}
function directoryFiles(directory) {
  if (!import_node_fs.default.existsSync(directory)) return [];
  return import_node_fs.default.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entryFiles(directory, entry));
}
function entryFiles(directory, entry) {
  const file = import_node_path.default.join(directory, entry.name);
  if (entry.isDirectory()) return directoryFiles(file);
  return entry.isFile() ? [file] : [];
}
function importingTest(file) {
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file);
}
function importedGraph(tests, plugin) {
  const graph = /* @__PURE__ */ new Map();
  const pending = tests.slice();
  while (pending.length) recordImports(pending.pop(), plugin, graph, pending);
  return graph;
}
function recordImports(file, plugin, graph, pending) {
  const identity = moduleIdentity(file);
  if (graph.has(identity)) return;
  const imports = staticImports(file, plugin);
  graph.set(identity, imports.map(moduleIdentity));
  pending.push(...imports);
}
function dependentModules(graph, changed) {
  const dependents = /* @__PURE__ */ new Map();
  for (const [importer, imports] of graph) {
    for (const imported of imports) dependents.set(imported, [...dependents.get(imported) ?? [], importer]);
  }
  const affected = new Set(changed);
  const pending = Array.from(changed);
  while (pending.length) addDependents(pending.pop(), dependents, affected, pending);
  return affected;
}
function addDependents(file, dependents, affected, pending) {
  for (const dependent of dependents.get(file) ?? []) {
    if (affected.has(dependent)) continue;
    affected.add(dependent);
    pending.push(dependent);
  }
}
function pluginSelection(project, pluginName, changedPaths) {
  const plugin = import_node_path.default.join(project, "plugins", pluginName);
  const tests = directoryFiles(import_node_path.default.join(plugin, "test")).filter(importingTest);
  const graph = importedGraph(tests, plugin);
  const changed = new Set(changedPaths.map((file) => sourceIdentity(import_node_path.default.resolve(project, file), plugin)));
  const affected = dependentModules(graph, changed);
  return {
    plugin: `plugins/${pluginName}`,
    files: tests.filter((file) => affected.has(moduleIdentity(file))).map((file) => import_node_path.default.relative(plugin, file).replaceAll("\\", "/")).sort()
  };
}
function quoteArgument(value) {
  if (process.platform === "win32") return '"' + value.replaceAll('"', '""') + '"';
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
function pinnedTestPatterns(command) {
  return Array.from(command.matchAll(/"([^"]*)"|'([^']*)'|([^\s]+)/g), (match) => (match[1] ?? match[2] ?? match[3]).replaceAll("\\", "/"));
}
function pinnedTestFile(selection, file, patterns) {
  const pluginPaths = patterns.filter((pattern) => pattern.startsWith("plugins/"));
  const localPathsApply = pluginPaths.length === 0 || pluginPaths.some((pattern) => pattern.startsWith(selection.plugin + "/")) || pluginPaths.includes(selection.plugin);
  return patterns.some((pattern) => localPathsApply && import_node_path.default.matchesGlob(file, pattern) || import_node_path.default.matchesGlob(`${selection.plugin}/${file}`, pattern));
}
function testFileCommand(project, plugin, file) {
  const manifestPath = import_node_path.default.join(project, plugin, "package.json");
  const manifest = import_node_fs.default.existsSync(manifestPath) ? JSON.parse(import_node_fs.default.readFileSync(manifestPath, "utf8")) : {};
  const runner = manifest.scripts?.["test:files"] ? "npm run test:files --" : "node --test";
  return `${runner} --test-concurrency=1 ${quoteArgument(file.replaceAll("[", "[[]"))}`;
}
function integrationTestBatches(project, selections, pinnedCommand, timeoutMilliseconds) {
  if (/\btest:full\b/.test(pinnedCommand)) return [];
  const patterns = pinnedTestPatterns(pinnedCommand);
  return selections.flatMap((selection) => selection.files.filter((file) => !pinnedTestFile(selection, file, patterns)).map((file) => ({
    plugin: selection.plugin,
    file,
    command: testFileCommand(project, selection.plugin, file),
    timeoutMilliseconds: Math.min(timeoutMilliseconds, 6e5)
  })));
}
function runImportingIntegrationTests(project, changedPaths, pinned, timeoutMilliseconds, environment) {
  const selections = selectIntegrationTests(project, changedPaths);
  const batches = integrationTestBatches(project, selections, pinned.command || "", timeoutMilliseconds);
  const results = [];
  for (const batch of batches) {
    if (pinned.status !== "passed") break;
    const result = (0, import_process.runProcessVerification)({ kind: "command", command: batch.command, evidenceContract: "Importing test file passes on the merged tree" }, {
      cwd: import_node_path.default.join(project, batch.plugin),
      timeoutMilliseconds: batch.timeoutMilliseconds,
      logPath: `${pinned.logPath}.import-${results.length}.log`,
      environment
    });
    results.push(result);
    if (result.status !== "passed") return { ...result, integrationTests: selections, importingTestResults: results };
  }
  return { ...pinned, integrationTests: selections, importingTestResults: results };
}
function selectIntegrationTests(project, changedPaths) {
  const pluginNames = changedPaths.map((file) => /^plugins\/([^/]+)\//.exec(file.replaceAll("\\", "/"))?.[1]).filter((name) => name !== void 0);
  return Array.from(new Set(pluginNames), (plugin) => pluginSelection(project, plugin, changedPaths));
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  integrationTestBatches,
  runImportingIntegrationTests,
  selectIntegrationTests
});
