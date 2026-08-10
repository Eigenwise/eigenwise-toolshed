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
var projects_exports = {};
__export(projects_exports, {
  discoverPythonProjects: () => discoverPythonProjects,
  isPythonPyproject: () => isPythonPyproject
});
module.exports = __toCommonJS(projects_exports);
var import_promises = require("node:fs/promises");
var import_node_path = __toESM(require("node:path"));
var import_paths = require("../../paths.js");
const configurationNames = /* @__PURE__ */ new Set(["pyrightconfig.json", "pyproject.toml"]);
const ignoredDirectories = /* @__PURE__ */ new Set([
  ".git",
  ".eggs",
  ".mypy_cache",
  ".nox",
  ".pytest_cache",
  ".ruff_cache",
  ".tox",
  "__pycache__",
  "build",
  "dist",
  "env",
  "node_modules",
  "venv",
  "virtualenv"
]);
const virtualEnvironmentMarker = "pyvenv.cfg";
function pythonConfigurationPriority(configuration) {
  return configuration.configurationName === "pyrightconfig.json" ? 0 : 1;
}
function isPythonSource(fileName) {
  return fileName.endsWith(".py") || fileName.endsWith(".pyi");
}
function isPythonBuildBackend(value) {
  return /(?:flit|hatch|maturin|pdm|poetry|setuptools|uv)/i.test(value);
}
function isPythonPyproject(contents) {
  return /^\s*requires-python\s*=/mi.test(contents) || /^\s*\[tool\.(?:pyright|poetry|hatch(?:\.[^\]]+)?|pdm|setuptools(?:\.[^\]]+)?|flit(?:\.[^\]]+)?|uv(?:\.[^\]]+)?)\]/mi.test(contents) || /^\s*build-backend\s*=\s*["']([^"']+)["']/mi.test(contents) && isPythonBuildBackend(contents.match(/^\s*build-backend\s*=\s*["']([^"']+)["']/mi)?.[1] ?? "");
}
async function isVirtualEnvironment(directory) {
  if (ignoredDirectories.has(import_node_path.default.basename(directory))) return true;
  try {
    await (0, import_promises.access)(import_node_path.default.join(directory, virtualEnvironmentMarker));
    return true;
  } catch {
    return false;
  }
}
async function configurationAt(filePath) {
  const configurationName = import_node_path.default.basename(filePath);
  if (configurationName === "pyrightconfig.json") {
    return { absolutePath: filePath, configurationName };
  }
  if (configurationName !== "pyproject.toml") return null;
  try {
    return isPythonPyproject(await (0, import_promises.readFile)(filePath, "utf8")) ? { absolutePath: filePath, configurationName } : null;
  } catch {
    return null;
  }
}
async function walkPythonTree(directory, configurations, pythonFiles) {
  let entries;
  try {
    entries = await (0, import_promises.readdir)(directory, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  await Promise.all(entries.map(async (entry) => {
    const entryPath = import_node_path.default.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!await isVirtualEnvironment(entryPath)) await walkPythonTree(entryPath, configurations, pythonFiles);
      return;
    }
    if (!entry.isFile()) return;
    if (configurationNames.has(entry.name)) {
      const configuration = await configurationAt(entryPath);
      if (configuration !== null) configurations.push(configuration);
    }
    if (isPythonSource(entry.name)) pythonFiles.push(entryPath);
  }));
}
function descriptor(root, configFile) {
  const normalizedRoot = (0, import_paths.normalizeProjectRoot)(root);
  return {
    id: (0, import_paths.projectIdentity)(normalizedRoot),
    root: normalizedRoot,
    configFile: configFile === null ? null : (0, import_paths.normalizeProjectRoot)(configFile),
    language: "python"
  };
}
function sourceRoots(projectRoot, pythonFiles) {
  const roots = /* @__PURE__ */ new Set();
  for (const pythonFile of pythonFiles) {
    let directory = import_node_path.default.dirname(pythonFile);
    while (directory !== projectRoot && directory !== import_node_path.default.dirname(directory)) {
      if (import_node_path.default.basename(directory) === "src") {
        roots.add(directory);
        break;
      }
      directory = import_node_path.default.dirname(directory);
    }
  }
  if (roots.size === 0 && pythonFiles.length > 0) roots.add(projectRoot);
  return [...roots].sort((left, right) => left.localeCompare(right));
}
async function discoverPythonProjects(projectRoot) {
  const normalizedRoot = (0, import_paths.normalizeProjectRoot)(projectRoot);
  const configurations = [];
  const pythonFiles = [];
  await walkPythonTree(normalizedRoot, configurations, pythonFiles);
  const selectedConfigurations = /* @__PURE__ */ new Map();
  for (const configuration of configurations.sort((left, right) => left.absolutePath.localeCompare(right.absolutePath))) {
    const root = (0, import_paths.normalizeProjectRoot)(import_node_path.default.dirname(configuration.absolutePath));
    const current = selectedConfigurations.get(root);
    if (current === void 0 || pythonConfigurationPriority(configuration) < pythonConfigurationPriority(current)) {
      selectedConfigurations.set(root, configuration);
    }
  }
  const configuredProjects = [...selectedConfigurations.entries()].map(([root, configuration]) => descriptor(root, configuration.absolutePath)).sort((left, right) => (left.configFile ?? "").localeCompare(right.configFile ?? ""));
  if (configuredProjects.length > 0) return configuredProjects;
  return sourceRoots(normalizedRoot, pythonFiles).map((root) => descriptor(root, null));
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  discoverPythonProjects,
  isPythonPyproject
});
