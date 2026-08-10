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
  TypeScriptFreshnessContributor: () => TypeScriptFreshnessContributor,
  buildRelevantInputManifest: () => buildRelevantInputManifest,
  projectInputs: () => projectInputs,
  snapshotIsFresh: () => snapshotIsFresh,
  typeScriptFreshnessContributor: () => typeScriptFreshnessContributor
});
module.exports = __toCommonJS(freshness_exports);
var import_node_crypto = require("node:crypto");
var import_promises = require("node:fs/promises");
var import_node_path = __toESM(require("node:path"));
var import_ignored_directories = require("./ignored-directories.js");
var import_paths = require("./paths.js");
const relevantExtensions = /* @__PURE__ */ new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const configurationNames = /* @__PURE__ */ new Set(["tsconfig.json", "jsconfig.json"]);
function contentHash(content) {
  return (0, import_node_crypto.createHash)("sha256").update(content).digest("hex");
}
function manifestHash(inputs) {
  return (0, import_node_crypto.createHash)("sha256").update(inputs.map((input) => `${input.path}\0${input.contentHash}\0${input.configuration}`).join("\n")).digest("hex");
}
function isRelevantSource(filePath) {
  return relevantExtensions.has(import_node_path.default.extname(filePath));
}
function importEsmModule(specifier) {
  return new Function("moduleSpecifier", "return import(moduleSpecifier);")(specifier);
}
function isSemanticTypeScriptModule(value) {
  return typeof value === "object" && value !== null && "API" in value && typeof value.API === "function";
}
async function loadSemanticTypeScript() {
  const semanticTypeScript = await importEsmModule("typescript/unstable/sync");
  if (!isSemanticTypeScriptModule(semanticTypeScript)) {
    throw new Error("the pinned TypeScript runtime does not expose its sync semantic API");
  }
  return semanticTypeScript;
}
async function inputCandidates(directory) {
  const entries = await (0, import_promises.readdir)(directory, { withFileTypes: true });
  const children = await Promise.all(entries.map(async (entry) => {
    const entryPath = import_node_path.default.join(directory, entry.name);
    if (entry.isDirectory()) return await (0, import_ignored_directories.isIgnoredDirectory)(entryPath) ? [] : inputCandidates(entryPath);
    if (!entry.isFile() || !isRelevantSource(entryPath) && !configurationNames.has(entry.name)) return [];
    return [{ absolutePath: entryPath, configuration: configurationNames.has(entry.name) }];
  }));
  return children.flat();
}
async function existingCanonicalPaths(candidates) {
  const existing = /* @__PURE__ */ new Set();
  await Promise.all([...candidates].map(async (candidate) => {
    try {
      await (0, import_promises.access)(candidate);
      existing.add((0, import_paths.canonicalFilesystemPath)(candidate));
    } catch {
    }
  }));
  return existing;
}
async function effectiveConfigurationPaths(projectRoot, discoveredInputs) {
  const rootConfigurations = discoveredInputs.filter((input) => input.configuration).map((input) => import_node_path.default.resolve(input.absolutePath));
  const semanticReads = new Set(rootConfigurations);
  const semanticTypeScript = await loadSemanticTypeScript();
  const api = new semanticTypeScript.API({
    cwd: projectRoot,
    fs: {
      readFile(fileName) {
        semanticReads.add(import_node_path.default.resolve(fileName));
        return void 0;
      }
    }
  });
  try {
    for (const configFile of rootConfigurations) api.parseConfigFile(configFile);
  } finally {
    api.close();
  }
  return existingCanonicalPaths(semanticReads);
}
class TypeScriptFreshnessContributor {
  async collect(projectRoot) {
    const discoveredInputs = await inputCandidates(projectRoot);
    const configurationPaths = await effectiveConfigurationPaths(projectRoot, discoveredInputs);
    return [
      ...discoveredInputs.filter((input) => !input.configuration),
      ...[...configurationPaths].map((absolutePath) => ({ absolutePath, configuration: true }))
    ];
  }
}
const typeScriptFreshnessContributor = new TypeScriptFreshnessContributor();
function manifestPath(projectRoot, absolutePath) {
  const relativePath = import_node_path.default.relative(projectRoot, absolutePath);
  if (relativePath !== ".." && !relativePath.startsWith(`..${import_node_path.default.sep}`) && !import_node_path.default.isAbsolute(relativePath)) {
    return (0, import_paths.normalizeProjectRelativePath)(relativePath);
  }
  return `external-config/${contentHash(import_node_path.default.resolve(absolutePath))}`;
}
async function normalizedCandidates(projectRoot, contributors) {
  const candidates = (await Promise.all(contributors.map((contributor) => contributor.collect(projectRoot)))).flat();
  const configurationByPath = /* @__PURE__ */ new Map();
  for (const candidate of candidates) {
    try {
      await (0, import_promises.access)(candidate.absolutePath);
      const canonicalPath = (0, import_paths.canonicalFilesystemPath)(candidate.absolutePath);
      configurationByPath.set(canonicalPath, configurationByPath.get(canonicalPath) === true || candidate.configuration);
    } catch {
    }
  }
  return configurationByPath;
}
async function buildRelevantInputManifest(projectRoot, contributors = [typeScriptFreshnessContributor]) {
  const canonicalRoot = (0, import_paths.canonicalFilesystemPath)(projectRoot);
  const candidates = await normalizedCandidates(canonicalRoot, contributors);
  const inputs = await Promise.all([...candidates].map(async ([absolutePath, configuration]) => ({
    path: manifestPath(canonicalRoot, absolutePath),
    contentHash: contentHash(await (0, import_promises.readFile)(absolutePath, "utf8")),
    configuration
  })));
  inputs.sort((left, right) => left.path.localeCompare(right.path));
  const configurationInputs = inputs.filter((input) => input.configuration);
  return {
    inputs,
    sourceManifestHash: manifestHash(inputs),
    configHash: manifestHash(configurationInputs)
  };
}
function snapshotIsFresh(snapshot, manifest) {
  return snapshot.sourceManifestHash === manifest.sourceManifestHash && snapshot.configHash === manifest.configHash;
}
function projectInputs(manifest, project) {
  const projectRelativeRoot = import_node_path.default.relative(import_node_path.default.dirname(project.root), project.root).replaceAll("\\", "/");
  return manifest.inputs.filter((input) => projectRelativeRoot === "" || input.path.startsWith(`${projectRelativeRoot}/`));
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  TypeScriptFreshnessContributor,
  buildRelevantInputManifest,
  projectInputs,
  snapshotIsFresh,
  typeScriptFreshnessContributor
});
