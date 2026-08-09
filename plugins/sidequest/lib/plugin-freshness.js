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
var plugin_freshness_exports = {};
__export(plugin_freshness_exports, {
  SIDEQUEST_PLUGIN_ID: () => SIDEQUEST_PLUGIN_ID,
  compareSemver: () => compareSemver,
  installedSidequestVersion: () => installedSidequestVersion,
  loadedPluginVersion: () => loadedPluginVersion,
  loadedVersionStateFile: () => loadedVersionStateFile,
  reportLoadedSidequestVersion: () => reportLoadedSidequestVersion,
  sidequestDispatchRefusal: () => sidequestDispatchRefusal,
  sidequestReloadWarning: () => sidequestReloadWarning
});
module.exports = __toCommonJS(plugin_freshness_exports);
var import_node_crypto = __toESM(require("node:crypto"));
var import_node_fs = __toESM(require("node:fs"));
var import_node_os = __toESM(require("node:os"));
var import_node_path = __toESM(require("node:path"));
const SIDEQUEST_PLUGIN_ID = "sidequest@eigenwise-toolshed";
function claudeHome(options = {}) {
  return options.claudeHome || process.env.SIDEQUEST_CLAUDE_HOME || import_node_path.default.join(import_node_os.default.homedir(), ".claude");
}
function normalizedPath(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  return import_node_path.default.resolve(value).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}
function pathsOverlap(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}
function parseSemver(value) {
  const match = String(value || "").match(/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]+)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]+))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/);
  if (!match) return null;
  return { core: match.slice(1, 4).map(Number), prerelease: match[4] ? match[4].split(".") : [] };
}
function compareSemver(left, right) {
  const first = parseSemver(left);
  const second = parseSemver(right);
  if (!first || !second) return null;
  for (let index = 0; index < first.core.length; index += 1) {
    if (first.core[index] !== second.core[index]) return first.core[index] < second.core[index] ? -1 : 1;
  }
  if (!first.prerelease.length || !second.prerelease.length) {
    return first.prerelease.length === second.prerelease.length ? 0 : first.prerelease.length ? -1 : 1;
  }
  const length = Math.max(first.prerelease.length, second.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    if (first.prerelease[index] === void 0) return -1;
    if (second.prerelease[index] === void 0) return 1;
    if (first.prerelease[index] === second.prerelease[index]) continue;
    const firstNumber = /^\d+$/.test(first.prerelease[index]);
    const secondNumber = /^\d+$/.test(second.prerelease[index]);
    if (firstNumber && secondNumber) return Number(first.prerelease[index]) < Number(second.prerelease[index]) ? -1 : 1;
    if (firstNumber !== secondNumber) return firstNumber ? -1 : 1;
    return first.prerelease[index] < second.prerelease[index] ? -1 : 1;
  }
  return 0;
}
function registryInstalls(projectPath, options = {}) {
  let registry;
  try {
    registry = JSON.parse(import_node_fs.default.readFileSync(import_node_path.default.join(claudeHome(options), "plugins", "installed_plugins.json"), "utf8"));
  } catch (_) {
    return [];
  }
  const installs = registry.plugins?.[SIDEQUEST_PLUGIN_ID];
  if (!Array.isArray(installs)) return [];
  const currentPath = normalizedPath(projectPath);
  if (!currentPath) return [];
  return installs.filter((install) => {
    if (!install || typeof install !== "object") return false;
    if (install.scope === "user") return true;
    const installedProject = normalizedPath(install.projectPath);
    return installedProject !== null && pathsOverlap(currentPath, installedProject);
  });
}
function loadedPluginVersion(pluginRoot = process.env.CLAUDE_PLUGIN_ROOT) {
  if (!pluginRoot) return null;
  try {
    const manifest = JSON.parse(import_node_fs.default.readFileSync(import_node_path.default.join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8"));
    return typeof manifest.version === "string" ? manifest.version : null;
  } catch (_) {
    return null;
  }
}
function installedSidequestVersion(projectPath, options = {}) {
  const installs = registryInstalls(projectPath, options);
  const projectInstall = installs.find((install) => install.scope === "project" || install.scope === "local");
  const selected = projectInstall || installs.find((install) => install.scope === "user");
  return typeof selected?.version === "string" ? selected.version : null;
}
function sidequestDispatchRefusal(projectPath, options = {}) {
  const loadedVersion = loadedPluginVersion(options.pluginRoot);
  const installedVersion = installedSidequestVersion(projectPath, options);
  if (!installedVersion) return "";
  const comparison = compareSemver(loadedVersion, installedVersion);
  if (comparison === null) {
    return `Sidequest: cannot safely dispatch because the loaded or installed plugin version is missing or malformed (loaded ${loadedVersion || "unknown"}, installed ${installedVersion}). Run /reload-plugins or restart Claude Code before dispatching work.`;
  }
  if (comparison !== -1) return "";
  return `Sidequest: loaded ${loadedVersion}, installed ${installedVersion}. Run /reload-plugins or restart Claude Code before dispatching work.`;
}
function sidequestReloadWarning(projectPath, options = {}) {
  const loadedVersion = loadedPluginVersion(options.pluginRoot);
  const installedVersion = installedSidequestVersion(projectPath, options);
  if (!loadedVersion || !installedVersion || compareSemver(loadedVersion, installedVersion) !== -1) return "";
  return `Sidequest: loaded ${loadedVersion}, installed ${installedVersion}. Run /reload-plugins or restart Claude Code before dispatching work.`;
}
function stateDirectory(options = {}) {
  return options.stateDirectory || import_node_path.default.join(import_node_os.default.tmpdir(), "eigenwise-toolshed", "freshness-warnings", "loaded-plugin-versions");
}
function sessionId(input) {
  const value = input.session_id ?? input.sessionId;
  return value == null ? "" : String(value);
}
function loadedVersionStateFile(input, pluginId = SIDEQUEST_PLUGIN_ID, options = {}) {
  const id = sessionId(input);
  if (!id) return null;
  const digest = import_node_crypto.default.createHash("sha256").update(`${id}\0${pluginId}`).digest("hex");
  return import_node_path.default.join(stateDirectory(options), `${digest}.json`);
}
function reportLoadedSidequestVersion(input, options = {}) {
  const version = loadedPluginVersion(options.pluginRoot);
  const stateFile = loadedVersionStateFile(input, SIDEQUEST_PLUGIN_ID, options);
  if (!version || !stateFile) return version;
  try {
    import_node_fs.default.mkdirSync(import_node_path.default.dirname(stateFile), { recursive: true });
    import_node_fs.default.writeFileSync(stateFile, JSON.stringify({ pluginId: SIDEQUEST_PLUGIN_ID, version }));
  } catch (_) {
  }
  return version;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  SIDEQUEST_PLUGIN_ID,
  compareSemver,
  installedSidequestVersion,
  loadedPluginVersion,
  loadedVersionStateFile,
  reportLoadedSidequestVersion,
  sidequestDispatchRefusal,
  sidequestReloadWarning
});
