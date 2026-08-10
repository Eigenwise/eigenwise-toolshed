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
var freshness_exports = {};
__export(freshness_exports, {
  PythonFreshnessContributor: () => PythonFreshnessContributor,
  pythonFreshnessContributor: () => pythonFreshnessContributor
});
module.exports = __toCommonJS(freshness_exports);
var import_promises = require("node:fs/promises");
var import_node_path = __toESM(require("node:path"));
var import_projects = require("./projects.js");
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
const configurationNames = /* @__PURE__ */ new Set(["pyrightconfig.json", "pyproject.toml"]);
function isPythonSource(fileName) {
  return fileName.endsWith(".py") || fileName.endsWith(".pyi");
}
async function isVirtualEnvironment(directory) {
  if (ignoredDirectories.has(import_node_path.default.basename(directory))) return true;
  try {
    await (0, import_promises.access)(import_node_path.default.join(directory, "pyvenv.cfg"));
    return true;
  } catch {
    return false;
  }
}
async function isRelevantConfiguration(filePath) {
  if (import_node_path.default.basename(filePath) === "pyrightconfig.json") return true;
  if (import_node_path.default.basename(filePath) !== "pyproject.toml") return false;
  try {
    return (0, import_projects.isPythonPyproject)(await (0, import_promises.readFile)(filePath, "utf8"));
  } catch {
    return false;
  }
}
async function inputCandidates(directory) {
  let entries;
  try {
    entries = await (0, import_promises.readdir)(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const children = await Promise.all(entries.map(async (entry) => {
    const entryPath = import_node_path.default.join(directory, entry.name);
    if (entry.isDirectory()) return await isVirtualEnvironment(entryPath) ? [] : inputCandidates(entryPath);
    if (!entry.isFile()) return [];
    if (isPythonSource(entry.name)) return [{ absolutePath: entryPath, configuration: false }];
    return await isRelevantConfiguration(entryPath) ? [{ absolutePath: entryPath, configuration: true }] : [];
  }));
  return children.flat();
}
function stripJsonComments(contents) {
  let result = "";
  let quoted = false;
  let escaping = false;
  for (let index = 0; index < contents.length; index += 1) {
    const character = contents[index];
    const next = contents[index + 1];
    if (quoted) {
      result += character;
      if (escaping) escaping = false;
      else if (character === "\\") escaping = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') {
      quoted = true;
      result += character;
      continue;
    }
    if (character === "/" && next === "/") {
      index = contents.indexOf("\n", index);
      if (index === -1) break;
      result += "\n";
      continue;
    }
    if (character === "/" && next === "*") {
      const closingIndex = contents.indexOf("*/", index + 2);
      index = closingIndex === -1 ? contents.length : closingIndex + 1;
      continue;
    }
    result += character;
  }
  return result;
}
function jsonExtends(contents) {
  try {
    const parsed = JSON.parse(stripJsonComments(contents));
    if (typeof parsed !== "object" || parsed === null || !("extends" in parsed)) return null;
    return typeof parsed.extends === "string" ? parsed.extends : null;
  } catch {
    return null;
  }
}
function pyprojectExtends(contents) {
  const pyrightLines = [];
  let inPyrightSection = false;
  for (const line of contents.split(/\r?\n/)) {
    if (/^\s*\[tool\.pyright\]\s*$/i.test(line)) {
      inPyrightSection = true;
      continue;
    }
    if (inPyrightSection && /^\s*\[/.test(line)) break;
    if (inPyrightSection) pyrightLines.push(line);
  }
  return pyrightLines.join("\n").match(/^\s*extends\s*=\s*["']([^"']+)["']/mi)?.[1] ?? null;
}
async function inheritedConfigurationPath(configFile) {
  let contents;
  try {
    contents = await (0, import_promises.readFile)(configFile, "utf8");
  } catch {
    return null;
  }
  const extendsPath = import_node_path.default.basename(configFile) === "pyproject.toml" ? pyprojectExtends(contents) : jsonExtends(contents);
  if (extendsPath === null || extendsPath.trim() === "") return null;
  const resolvedPath = import_node_path.default.resolve(import_node_path.default.dirname(configFile), extendsPath);
  try {
    await (0, import_promises.access)(resolvedPath);
    return resolvedPath;
  } catch {
    return null;
  }
}
async function effectiveConfigurationPaths(inputs) {
  const pending = inputs.filter((input) => input.configuration).map((input) => import_node_path.default.resolve(input.absolutePath));
  const resolved = /* @__PURE__ */ new Set();
  while (pending.length > 0) {
    const configFile = pending.pop();
    if (resolved.has(configFile)) continue;
    resolved.add(configFile);
    const inheritedPath = await inheritedConfigurationPath(configFile);
    if (inheritedPath !== null) pending.push(inheritedPath);
  }
  return [...resolved].sort((left, right) => left.localeCompare(right));
}
class PythonFreshnessContributor {
  async collect(projectRoot) {
    const discoveredInputs = await inputCandidates(projectRoot);
    const effectiveConfigurations = await effectiveConfigurationPaths(discoveredInputs);
    const sourceInputs = discoveredInputs.filter((input) => !input.configuration);
    return [...sourceInputs, ...effectiveConfigurations.map((absolutePath) => ({ absolutePath, configuration: true }))].sort((left, right) => left.absolutePath.localeCompare(right.absolutePath));
  }
}
const pythonFreshnessContributor = new PythonFreshnessContributor();
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  PythonFreshnessContributor,
  pythonFreshnessContributor
});
