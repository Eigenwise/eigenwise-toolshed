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
var integration_quality_exports = {};
__export(integration_quality_exports, {
  configuredIntegrationGate: () => configuredIntegrationGate,
  runIntegrationQuality: () => runIntegrationQuality
});
module.exports = __toCommonJS(integration_quality_exports);
var import_node_fs = __toESM(require("node:fs"));
var import_node_os = __toESM(require("node:os"));
var import_node_path = __toESM(require("node:path"));
var import_node_url = require("node:url");
var import_process = require("./ports/process.js");
function sameProject(left, right) {
  return import_node_path.default.resolve(left).replaceAll("\\", "/").toLowerCase() === import_node_path.default.resolve(right).replaceAll("\\", "/").toLowerCase();
}
function applicableInstall(install, project) {
  if (install.scope === "user") return true;
  return typeof install.projectPath === "string" && sameProject(install.projectPath, project);
}
function configuredIntegrationGate(project) {
  const home = process.env.SIDEQUEST_CLAUDE_HOME || import_node_path.default.join(import_node_os.default.homedir(), ".claude");
  const registryPath = import_node_path.default.join(home, "plugins", "installed_plugins.json");
  if (!import_node_fs.default.existsSync(registryPath)) return void 0;
  const registry = JSON.parse(import_node_fs.default.readFileSync(registryPath, "utf8"));
  const installs = registry.plugins?.["quality-gate@eigenwise-toolshed"] ?? [];
  return installs.find((install) => applicableInstall(install, project))?.installPath;
}
function quoteArgument(value) {
  if (process.platform === "win32") return '"' + value.replaceAll('"', '""') + '"';
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
function runNativeReport(gate, input, command, name) {
  const output = import_node_path.default.join(input.directory, name + ".json");
  const invocation = [process.execPath, import_node_path.default.join(gate, "bin", "quality-gate.js"), ...command].map(quoteArgument).join(" ");
  const result = (0, import_process.runProcessVerification)({ kind: "command", command: invocation + " > " + quoteArgument(output), evidenceContract: "Native quality-gate report" }, {
    cwd: input.project,
    timeoutMilliseconds: input.timeoutMilliseconds,
    logPath: import_node_path.default.join(input.directory, name + ".log")
  });
  if (result.status !== "passed" && result.status !== "failed_suite") throw new Error(result.evidence);
  const report = JSON.parse(import_node_fs.default.readFileSync(output, "utf8"));
  if (!Array.isArray(report.failures) || !Array.isArray(report.unverified)) throw new Error("Native quality-gate report has no failures/unverified rows");
  return report;
}
function generatedCounterpart(file, files) {
  const source = file.replace(/\/(lib|bin)\//, "/src/$1/").replace(/\.js$/, ".ts");
  return source !== file && files.includes(source);
}
function sourceFiles(input) {
  return input.changedPaths.filter((file) => /\.[cm]?[jt]sx?$/.test(file)).filter((file) => !generatedCounterpart(file, input.changedPaths)).filter((file) => import_node_fs.default.existsSync(import_node_path.default.resolve(input.project, file)));
}
function emptyQuality(status) {
  return { status, enforced: 0, failures: [], unverified: [], branches: [] };
}
function unverifiedQuality(error) {
  return { ...emptyQuality("unverified"), unverified: [{ name: "integration measurement", unverified: String(error) }] };
}
function reportQuality(report, base) {
  const enforced = (report.changedMetrics ?? []).filter((row) => row.classification !== "legacy-unchanged");
  const floorFailures = enforced.filter((row) => (row.complexity ?? 0) >= 6).map((row) => `${row.relativePath}:${row.line} ${row.name} cc=${row.complexity} (complexity floor)`);
  const failures = [...report.failures, ...floorFailures];
  const unverified = report.unverified;
  const measured = { ...emptyQuality("measured"), baseline: base, enforced: enforced.length, failures, unverified };
  return {
    ...measured,
    status: qualityStatus(failures, unverified),
    worstBody: enforced.slice().sort((left, right) => (right.crap ?? -1) - (left.crap ?? -1))[0],
    branches: enforced.map((row) => ({ file: row.relativePath, name: row.name, conditions: row.branches ?? [] }))
  };
}
function qualityStatus(failures, unverified) {
  if (failures.length) return "failed";
  return unverified.length ? "unverified" : "measured";
}
function measuredQuality(gate, input, captureDirectory) {
  const files = sourceFiles(input);
  if (!files.length) return emptyQuality("measured");
  const report = runNativeReport(gate, input, ["measure", "--json", "--project", input.project, "--base", input.base, "--coverage", captureDirectory, ...files], "measure");
  return reportQuality(report, input.base);
}
function persistQuality(input, quality) {
  const receipt = import_node_path.default.join(input.directory, "receipt.json");
  const recorded = { ...quality, receipt };
  import_node_fs.default.writeFileSync(receipt, JSON.stringify(recorded, null, 2) + "\n");
  return recorded;
}
function captureEnvironment(gate, directory, environment) {
  const preload = "--import=" + (0, import_node_url.pathToFileURL)(import_node_path.default.join(gate, "lib", "core.mjs")).href;
  return { ...environment, NODE_OPTIONS: [environment.NODE_OPTIONS, preload].filter(Boolean).join(" "), QUALITY_GATE_V8_CAPTURE: import_node_path.default.join(directory, "coverage") };
}
function participantQuality(gate, input, captureDirectory) {
  import_node_fs.default.mkdirSync(input.directory, { recursive: true });
  let quality;
  try {
    quality = measuredQuality(gate, input, captureDirectory);
  } catch (error) {
    quality = unverifiedQuality(error);
  }
  return persistQuality(input, quality);
}
function unavailableQuality(inputs, verify, error, environment) {
  const quality = inputs.map((input) => {
    import_node_fs.default.mkdirSync(input.directory, { recursive: true });
    return persistQuality(input, unverifiedQuality(error));
  });
  return { ...verify(environment), quality };
}
function runIntegrationQuality(inputs, verify, environment = process.env) {
  const primary = inputs[0];
  let gate;
  try {
    gate = configuredIntegrationGate(primary.registeredProject);
  } catch (error) {
    return unavailableQuality(inputs, verify, error, environment);
  }
  if (!gate) return { ...verify(environment), quality: [emptyQuality("none")] };
  const captureDirectory = import_node_path.default.join(primary.directory, "coverage");
  import_node_fs.default.mkdirSync(captureDirectory, { recursive: true });
  const verification = verify(captureEnvironment(gate, primary.directory, environment));
  const quality = inputs.map((input) => participantQuality(gate, input, captureDirectory));
  const failures = quality.flatMap((result) => result.failures);
  if (!failures.length) return { ...verification, quality };
  return { ...verification, quality, status: "failed_check", evidence: "Native quality gate refused delivery: " + failures.map((row) => JSON.stringify(row)).join("; "), failureIdentities: ["quality:measured-failure"] };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  configuredIntegrationGate,
  runIntegrationQuality
});
