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
  beginIntegrationProgress: () => beginIntegrationProgress,
  deliveryOutcomeState: () => deliveryOutcomeState,
  finishIntegrationProgress: () => finishIntegrationProgress,
  integrationCaptureEnvironment: () => integrationCaptureEnvironment,
  integrationProgressPath: () => integrationProgressPath,
  integrationProgressSummary: () => integrationProgressSummary,
  integrationTestBatches: () => integrationTestBatches,
  onIntegrationProgress: () => onIntegrationProgress,
  phaseBudgetResult: () => phaseBudgetResult,
  readIntegrationProgress: () => readIntegrationProgress,
  reportIntegrationProgress: () => reportIntegrationProgress,
  runImportingIntegrationTests: () => runImportingIntegrationTests,
  selectIntegrationTests: () => selectIntegrationTests
});
module.exports = __toCommonJS(integration_tests_exports);
var import_node_fs = __toESM(require("node:fs"));
var import_node_path = __toESM(require("node:path"));
var import_process = require("./ports/process.js");
const { resolveSuite } = require("./suite-resolver.js");
const PLUGIN_RUNNER_SPECIFIER = /^claude-code(?:\/|$)/;
const DEFAULT_PLUGIN_RUNNER = "claude plugin test .";
const PLUGIN_RUNNER_SPLIT = "Tests that import claude-code or live under a hooks module root run through the plugin runner (its moduleTest command, else claude plugin test .), never node --test; without a runnable claude CLI they are recorded as unverified (or toolchain_missing) and do not fail delivery.";
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
  return existingModule(source) ?? existingModule(imported) ?? existingModule(imported.replace(/\.([cm]?)js$/, ".$1ts"));
}
function moduleSpecifiers(file) {
  return Array.from(import_node_fs.default.readFileSync(file, "utf8").matchAll(STATIC_MODULE_SPECIFIER), (match) => match[1]);
}
function staticImports(file, plugin) {
  return moduleSpecifiers(file).map((specifier) => importedModule(file, specifier, plugin)).filter((imported) => imported !== void 0);
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
function hooksModuleRoots(plugin) {
  const hooks = import_node_path.default.join(plugin, "hooks");
  const manifest = import_node_path.default.join(hooks, "hooks.json");
  if (!import_node_fs.default.existsSync(manifest)) return [];
  const modules = JSON.parse(import_node_fs.default.readFileSync(manifest, "utf8")).modules;
  if (!Array.isArray(modules)) return [];
  const hooksIdentity = moduleIdentity(hooks);
  return modules.filter((entry) => typeof entry === "string").map((entry) => moduleIdentity(import_node_path.default.dirname(import_node_path.default.join(hooks, entry)))).filter((root) => root === hooksIdentity || root.startsWith(hooksIdentity + "/"));
}
function pluginRunnerTest(file, moduleRoots) {
  const identity = moduleIdentity(file);
  return moduleRoots.some((root) => identity.startsWith(root + "/")) || moduleSpecifiers(file).some((specifier) => PLUGIN_RUNNER_SPECIFIER.test(specifier));
}
function discoveredTests(plugin, moduleRoots) {
  const files = [import_node_path.default.join(plugin, "test"), ...moduleRoots].flatMap(directoryFiles).filter(importingTest);
  return Array.from(new Set(files.map((file) => import_node_path.default.resolve(file))));
}
function pluginRelative(plugin, files) {
  return files.map((file) => import_node_path.default.relative(plugin, file).replaceAll("\\", "/")).sort();
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
  const moduleRoots = hooksModuleRoots(plugin);
  const tests = discoveredTests(plugin, moduleRoots);
  const guidance = changedPaths.some(guidancePath) ? tests.filter((file) => /(?:^|[/\\])(?:agent-guidance|skill|compatibility)\.test\.[jt]s$/.test(file)) : [];
  const graph = importedGraph(tests, plugin);
  const changed = new Set(changedPaths.map((file) => sourceIdentity(import_node_path.default.resolve(project, file), plugin)));
  const affected = dependentModules(graph, changed);
  const selected = tests.filter((file) => affected.has(moduleIdentity(file)) || guidance.includes(file));
  const pluginRunnerFiles = selected.filter((file) => pluginRunnerTest(file, moduleRoots));
  return {
    plugin: `plugins/${pluginName}`,
    files: pluginRelative(plugin, selected.filter((file) => !pluginRunnerFiles.includes(file))),
    ...pluginRunnerFiles.length ? { pluginRunnerFiles: pluginRelative(plugin, pluginRunnerFiles) } : {}
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
function performanceTest(file) {
  return /(?:^|[./_-])(?:perf|benchmark)(?:[./_-]|$)/i.test(file);
}
function testScripts(project, plugin) {
  const manifestPath = import_node_path.default.join(project, plugin, "package.json");
  if (!import_node_fs.default.existsSync(manifestPath)) return {};
  return JSON.parse(import_node_fs.default.readFileSync(manifestPath, "utf8")).scripts ?? {};
}
function pluginTestFiles(project, plugin) {
  const root = import_node_path.default.join(project, plugin);
  const moduleRoots = hooksModuleRoots(root);
  return pluginRelative(root, directoryFiles(import_node_path.default.join(root, "test")).filter((file) => importingTest(file) && !pluginRunnerTest(file, moduleRoots)));
}
function testBatchCommand(scripts, files, normalSuite) {
  if (normalSuite) return scripts["test:full"] ? "npm run test:full" : "npm test";
  const runner = scripts["test:files"] ? "npm run test:files --" : "node --test";
  return runner + " --test-concurrency=1 " + files.map((file) => quoteArgument(file.replaceAll("[", "[[]"))).join(" ");
}
function pluginRunnerBatch(project, selection, timeoutMilliseconds) {
  if (!selection.pluginRunnerFiles?.length) return [];
  const command = resolveSuite(project, { name: import_node_path.default.basename(selection.plugin), dir: selection.plugin })?.moduleTest ?? DEFAULT_PLUGIN_RUNNER;
  return [{ plugin: selection.plugin, files: selection.pluginRunnerFiles, command, timeoutMilliseconds, shape: "plugin-runner" }];
}
function pluginTestBatch(project, selection, patterns, timeoutMilliseconds, fileThreshold) {
  return [...nodeTestBatch(project, selection, patterns, timeoutMilliseconds, fileThreshold), ...pluginRunnerBatch(project, selection, timeoutMilliseconds)];
}
function nodeTestBatch(project, selection, patterns, timeoutMilliseconds, fileThreshold) {
  const files = selection.files.filter((file) => !performanceTest(file) && !pinnedTestFile(selection, file, patterns));
  if (!files.length) return [];
  const normalSuite = files.length > fileThreshold;
  const batchFiles = normalSuite ? pluginTestFiles(project, selection.plugin).filter((file) => !performanceTest(file)) : files;
  const scripts = testScripts(project, selection.plugin);
  return [{
    plugin: selection.plugin,
    files: batchFiles,
    command: testBatchCommand(scripts, batchFiles, normalSuite),
    timeoutMilliseconds,
    shape: normalSuite ? scripts["test:full"] ? "test:full" : "npm-test" : "selected-files"
  }];
}
function integrationTestBatches(project, selections, pinnedCommand, timeoutMilliseconds, fileThreshold = 40) {
  if (/\btest:full\b/.test(pinnedCommand)) return [];
  const patterns = pinnedTestPatterns(pinnedCommand);
  return selections.flatMap((selection) => pluginTestBatch(project, selection, patterns, timeoutMilliseconds, fileThreshold));
}
function selectionWithExclusions(project, selection) {
  const excludedFiles = pluginTestFiles(project, selection.plugin).filter(performanceTest);
  return { ...selection, excludedFiles };
}
function integrationCaptureEnvironment(boardDirectory, environment) {
  const { liveVerificationCaptureCount } = require("./verify-capture.js");
  return { ...environment, SIDEQUEST_LIVE_VERIFY_CAPTURE_COUNT: String(liveVerificationCaptureCount(boardDirectory)) };
}
function phaseBudgetResult(result) {
  if (!/Sidequest .* tests exceeded their \d+ms phase budget/.test(result.outputTail ?? "")) return result;
  return { ...result, evidence: "Phase budget failure. " + result.evidence, failureIdentities: [...result.failureIdentities ?? [], "phase_budget_exceeded"] };
}
function runImportBatch(project, batch, logPath, pinned, environment) {
  const started = Date.now();
  const result = (0, import_process.runProcessVerification)({ kind: "command", command: batch.command, evidenceContract: "Importing tests pass on the merged tree" }, {
    cwd: import_node_path.default.join(project, batch.plugin),
    timeoutMilliseconds: batch.timeoutMilliseconds,
    logPath,
    environment
  });
  const receipt = { ...phaseBudgetResult(result), liveVerifyCaptureCount: Number(environment.SIDEQUEST_LIVE_VERIFY_CAPTURE_COUNT || 0), batchShape: batch.shape, timeoutMilliseconds: batch.timeoutMilliseconds, durationMilliseconds: Date.now() - started };
  if (pinned.logPath) import_node_fs.default.appendFileSync(pinned.logPath, "\nImport-walk batch: " + JSON.stringify(receipt) + "\n");
  return receipt;
}
function executeImportBatches(project, batches, pinned, environment) {
  if (pinned.status !== "passed") return [];
  for (const [index, batch] of batches.entries()) {
    reportIntegrationProgress("importing tests", `${batch.plugin}/${batch.files.join(", ")}`, { index: index + 1, count: batches.length });
    const receipt = runImportBatch(project, batch, pinned.logPath + ".import-" + index + ".log", pinned, environment);
    if (receipt.status !== "passed") return [receipt];
  }
  return [];
}
function environmentPath(environment) {
  return Object.entries(environment).find(([key]) => key.toUpperCase() === "PATH")?.[1] ?? "";
}
function claudeCliAvailable(environment) {
  const extensions = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  const candidates = environmentPath(environment).split(import_node_path.default.delimiter).filter(Boolean).flatMap((directory) => extensions.map((extension) => import_node_path.default.join(directory, "claude" + extension)));
  return candidates.some((candidate) => import_node_fs.default.existsSync(candidate) && import_node_fs.default.statSync(candidate).isFile());
}
function executePluginRunner(project, batch, index, pinned, environment) {
  const target = { plugin: batch.plugin, files: batch.files };
  if (!claudeCliAvailable(environment)) return { ...target, command: batch.command, status: "unverified", evidence: "The claude CLI is not on PATH, so these plugin-runner tests did not run here; CI runs them." };
  reportIntegrationProgress("plugin-runner tests", `${batch.plugin}/${batch.files.join(", ")}`);
  return { ...target, ...runImportBatch(project, batch, pinned.logPath + ".plugin-runner-" + index + ".log", pinned, environment) };
}
const PLUGIN_RUNNER_NOT_FAILED = /* @__PURE__ */ new Set(["passed", "unverified", "toolchain_missing"]);
function pluginRunnerFailed(result) {
  return !PLUGIN_RUNNER_NOT_FAILED.has(result.status);
}
function executePluginRunners(project, batches, pinned, environment) {
  if (pinned.status !== "passed") return [];
  const results = [];
  for (const [index, batch] of batches.entries()) {
    const result = executePluginRunner(project, batch, index, pinned, environment);
    results.push(result);
    if (pluginRunnerFailed(result)) break;
  }
  return results;
}
function runImportingIntegrationTests(project, changedPaths, pinned, timeoutMilliseconds, environment, fileThreshold = 40) {
  const started = Date.now();
  const selections = selectIntegrationTests(project, changedPaths).map((selection) => selectionWithExclusions(project, selection));
  const batches = integrationTestBatches(project, selections, pinned.command || "", timeoutMilliseconds, fileThreshold);
  const failures = executeImportBatches(project, batches.filter((batch) => batch.shape !== "plugin-runner"), pinned, environment);
  const pluginRunnerResults = failures.length ? [] : executePluginRunners(project, batches.filter((batch) => batch.shape === "plugin-runner"), pinned, environment);
  const importingTestResults = [...failures, ...pluginRunnerResults.filter(pluginRunnerFailed)];
  const importingTestSummary = { selectedFiles: selections.reduce((total, selection) => total + selection.files.length + (selection.pluginRunnerFiles?.length ?? 0), 0), durationMilliseconds: Date.now() - started, timeoutMilliseconds, exclusionReason: "Wall-clock performance and benchmark files are excluded from selected-file batches; full gates own their exclusions.", pluginRunnerSplit: PLUGIN_RUNNER_SPLIT };
  if (pinned.logPath) import_node_fs.default.appendFileSync(pinned.logPath, "\nImport-walk gate: " + JSON.stringify({ ...importingTestSummary, selections, batches, pluginRunnerResults }) + "\n");
  return { ...importingTestResults[0] ?? pinned, integrationTests: selections, importingTestResults, pluginRunnerResults, importingTestSummary };
}
function guidancePath(file) {
  return /^(?:docs\/|plugins\/[^/]+\/(?:skills|docs)\/).*\.md$/.test(file.replaceAll("\\", "/"));
}
function selectIntegrationTests(project, changedPaths) {
  const pluginNames = changedPaths.map((file) => /^plugins\/([^/]+)\//.exec(file.replaceAll("\\", "/"))?.[1]).filter((name) => name !== void 0);
  if (changedPaths.some((file) => /^docs\/.*\.md$/.test(file))) pluginNames.push("sidequest");
  return Array.from(new Set(pluginNames), (plugin) => pluginSelection(project, plugin, changedPaths));
}
const progressListeners = /* @__PURE__ */ new Set();
let activeProgress = null;
function integrationProgressPath(boardDirectory, ref) {
  return import_node_path.default.join(boardDirectory, "integrations", `${ref.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`);
}
function onIntegrationProgress(listener) {
  progressListeners.add(listener);
  return () => {
    progressListeners.delete(listener);
  };
}
function writeProgressFile(file, record) {
  try {
    import_node_fs.default.mkdirSync(import_node_path.default.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    import_node_fs.default.writeFileSync(temporary, JSON.stringify(record));
    import_node_fs.default.renameSync(temporary, file);
  } catch {
    try {
      import_node_fs.default.writeFileSync(file, JSON.stringify(record));
    } catch {
    }
  }
}
function publishProgress() {
  if (!activeProgress) return;
  const { files, record } = activeProgress;
  for (const file of files) writeProgressFile(file, record);
  for (const listener of progressListeners) {
    try {
      listener(record);
    } catch {
    }
  }
}
function beginIntegrationProgress(files, refs, logPath) {
  const now = (/* @__PURE__ */ new Date()).toISOString();
  activeProgress = {
    files,
    record: { state: "running", refs, logPath, phase: "merging", currentFile: null, fileIndex: null, fileCount: null, startedAt: now, updatedAt: now, pid: process.pid }
  };
  publishProgress();
}
function reportIntegrationProgress(phase, currentFile = null, position = null) {
  if (!activeProgress) return;
  activeProgress.record = {
    ...activeProgress.record,
    phase,
    currentFile,
    fileIndex: position ? position.index : null,
    fileCount: position ? position.count : null,
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  publishProgress();
}
function integrationProgressSummary(progress) {
  const file = progress.currentFile ? ` ${progress.currentFile}` : "";
  const position = progress.fileIndex ? ` (${progress.fileIndex}/${progress.fileCount})` : "";
  return `integrate ${progress.refs}: ${progress.phase}${file}${position}`;
}
function deliveryOutcomeState(outcome) {
  if (outcome.ok) return "delivered";
  const reason = String(outcome.reason || "");
  if (reason.endsWith("rollback_failed")) return "rollback_failed";
  return /_(?:post_merge|wave_delivery)$/.test(reason) ? "rolled_back" : "refused";
}
function finishIntegrationProgress(outcome) {
  if (!activeProgress) return;
  const state = deliveryOutcomeState(outcome);
  activeProgress.record = {
    ...activeProgress.record,
    state,
    phase: "finished",
    currentFile: null,
    fileIndex: null,
    fileCount: null,
    updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    ...state === "delivered" ? {} : { reason: String(outcome.reason || "unknown") }
  };
  publishProgress();
  activeProgress = null;
}
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}
function isIntegrationProgress(value) {
  return typeof value === "object" && value !== null && "state" in value && "refs" in value && "pid" in value;
}
function readIntegrationProgress(file) {
  let parsed;
  try {
    parsed = JSON.parse(import_node_fs.default.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (!isIntegrationProgress(parsed)) return null;
  return parsed.state === "running" ? { ...parsed, writerAlive: processAlive(Number(parsed.pid)) } : parsed;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  beginIntegrationProgress,
  deliveryOutcomeState,
  finishIntegrationProgress,
  integrationCaptureEnvironment,
  integrationProgressPath,
  integrationProgressSummary,
  integrationTestBatches,
  onIntegrationProgress,
  phaseBudgetResult,
  readIntegrationProgress,
  reportIntegrationProgress,
  runImportingIntegrationTests,
  selectIntegrationTests
});
