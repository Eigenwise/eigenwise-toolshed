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
  discoverProjects: () => discoverProjects,
  projectConfigFiles: () => projectConfigFiles
});
module.exports = __toCommonJS(projects_exports);
var import_promises = require("node:fs/promises");
var import_node_path = __toESM(require("node:path"));
var import_paths = require("./paths.js");
const configurationNames = /* @__PURE__ */ new Set(["tsconfig.json", "jsconfig.json"]);
const ignoredDirectories = /* @__PURE__ */ new Set([".git", "node_modules"]);
function removeJsonComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
function isStringArray(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}
function hasProperty(value, property) {
  return property in value;
}
function optionalProperty(value, property) {
  return hasProperty(value, property) ? value[property] : void 0;
}
function isProjectConfiguration(value) {
  if (typeof value !== "object" || value === null) return false;
  const references = optionalProperty(value, "references");
  const files = optionalProperty(value, "files");
  const include = optionalProperty(value, "include");
  const exclude = optionalProperty(value, "exclude");
  return (references === void 0 || Array.isArray(references)) && (files === void 0 || isStringArray(files)) && (include === void 0 || isStringArray(include)) && (exclude === void 0 || isStringArray(exclude));
}
async function readConfiguration(configFile) {
  const text = await (0, import_promises.readFile)(configFile, "utf8");
  try {
    const parsed = JSON.parse(removeJsonComments(text));
    return isProjectConfiguration(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
async function configurationFiles(directory) {
  const entries = await (0, import_promises.readdir)(directory, { withFileTypes: true });
  const nestedFiles = await Promise.all(entries.map(async (entry) => {
    const entryPath = import_node_path.default.join(directory, entry.name);
    if (entry.isDirectory()) {
      return ignoredDirectories.has(entry.name) ? [] : configurationFiles(entryPath);
    }
    return entry.isFile() && configurationNames.has(entry.name) ? [entryPath] : [];
  }));
  return nestedFiles.flat();
}
function isSolutionConfiguration(configuration) {
  return (configuration.references?.length ?? 0) > 0 && configuration.files === void 0 && configuration.include === void 0 && configuration.exclude === void 0;
}
function languageForConfig(configFile) {
  return import_node_path.default.basename(configFile) === "jsconfig.json" ? "javascript" : "typescript";
}
function descriptorForConfig(configFile) {
  const root = (0, import_paths.normalizeProjectRoot)(import_node_path.default.dirname(configFile));
  return {
    id: (0, import_paths.projectIdentity)(root),
    root,
    configFile: (0, import_paths.normalizeProjectRoot)(configFile),
    language: languageForConfig(configFile)
  };
}
async function discoverProjects(projectRoot) {
  const normalizedRoot = (0, import_paths.normalizeProjectRoot)(projectRoot);
  const discoveredConfigFiles = await configurationFiles(normalizedRoot);
  const configurations = await Promise.all(discoveredConfigFiles.map(async (configFile) => ({
    configFile,
    configuration: await readConfiguration(configFile)
  })));
  const leafProjects = configurations.filter(({ configuration }) => !isSolutionConfiguration(configuration)).map(({ configFile }) => descriptorForConfig(configFile)).sort((left, right) => (left.configFile ?? "").localeCompare(right.configFile ?? ""));
  if (leafProjects.length > 0) return leafProjects;
  if (discoveredConfigFiles.length > 0) return [];
  return [{
    id: (0, import_paths.projectIdentity)(normalizedRoot),
    root: normalizedRoot,
    configFile: null,
    language: "typescript"
  }];
}
function projectConfigFiles(projects) {
  return projects.map((project) => project.configFile).filter((configFile) => configFile !== null).sort();
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  discoverProjects,
  projectConfigFiles
});
