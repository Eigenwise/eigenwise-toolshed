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
var dispatch_preflight_exports = {};
__export(dispatch_preflight_exports, {
  assertDispatchTransport: () => assertDispatchTransport,
  assertSidequestInstall: () => assertSidequestInstall,
  checkSidequestInstall: () => checkSidequestInstall,
  ensurePythonIoEncoding: () => ensurePythonIoEncoding,
  installRefusalMessage: () => installRefusalMessage,
  localAheadOfUpstreamWarning: () => localAheadOfUpstreamWarning,
  transportRefusalMessage: () => transportRefusalMessage
});
module.exports = __toCommonJS(dispatch_preflight_exports);
var import_node_child_process = require("node:child_process");
var import_node_crypto = require("node:crypto");
var import_node_fs = __toESM(require("node:fs"));
var import_node_os = __toESM(require("node:os"));
var import_node_path = __toESM(require("node:path"));
function localAheadOfUpstreamWarning(projectPath, branch) {
  try {
    const upstream = (0, import_node_child_process.execFileSync)("git", ["rev-parse", "--abbrev-ref", `${branch}@{upstream}`], {
      cwd: projectPath,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    if (!upstream) return null;
    const count = Number((0, import_node_child_process.execFileSync)("git", ["rev-list", "--count", `${upstream}..${branch}`], {
      cwd: projectPath,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"]
    }).trim());
    if (!Number.isInteger(count) || count < 1) return null;
    const remote = (0, import_node_child_process.execFileSync)("git", ["config", "--get", `branch.${branch}.remote`], {
      cwd: projectPath,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    return remote ? {
      count,
      message: `Local ${branch} is ${count} commit${count === 1 ? "" : "s"} ahead of ${upstream}; isolated worktrees fork the local tracking ref. Push first: git push ${remote} ${branch}`
    } : null;
  } catch (_) {
    return null;
  }
}
const PLUGIN_ID = "sidequest@eigenwise-toolshed";
const REPAIR_COMMAND = "claude plugin install sidequest@eigenwise-toolshed --scope project";
function claudeHomeDir(opts = {}) {
  return opts.claudeHome || process.env.SIDEQUEST_CLAUDE_HOME || import_node_path.default.join(import_node_os.default.homedir(), ".claude");
}
function projectContainsPythonSource(projectPath) {
  const pending = [projectPath];
  while (pending.length) {
    const directory = pending.pop();
    if (!directory) continue;
    let entries;
    try {
      entries = import_node_fs.default.readdirSync(directory, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const candidate = import_node_path.default.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".py")) return true;
    }
  }
  return false;
}
function ensurePythonIoEncoding(projectPath, opts = {}) {
  if ((opts.platform || process.platform) !== "win32" || !projectContainsPythonSource(projectPath)) return { written: false };
  const settingsPath = import_node_path.default.join(projectPath, ".claude", "settings.local.json");
  let settings = {};
  try {
    settings = JSON.parse(import_node_fs.default.readFileSync(settingsPath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw new Error(`Dispatch refused: could not read project settings at ${settingsPath}: ${error.message}`);
  }
  const environment = settings.env;
  if (environment != null && (typeof environment !== "object" || Array.isArray(environment))) {
    throw new Error(`Dispatch refused: project settings env must be an object at ${settingsPath}.`);
  }
  if (environment && Object.hasOwn(environment, "PYTHONIOENCODING")) return { written: false, settingsPath };
  settings.env = { ...environment || {}, PYTHONIOENCODING: "utf-8" };
  import_node_fs.default.mkdirSync(import_node_path.default.dirname(settingsPath), { recursive: true });
  import_node_fs.default.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}
`, "utf8");
  return { written: true, settingsPath };
}
function normalizeDir(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  return import_node_path.default.resolve(value).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}
function installIdentity(installPath) {
  try {
    const manifest = import_node_fs.default.readFileSync(import_node_path.default.join(installPath, ".mcp.json"));
    return (0, import_node_crypto.createHash)("sha256").update(manifest).digest("hex");
  } catch (_) {
    return null;
  }
}
function installAdvertisesBoardMcp(installPath) {
  if (typeof installPath !== "string" || !installPath) return false;
  let manifest;
  try {
    manifest = JSON.parse(import_node_fs.default.readFileSync(import_node_path.default.join(installPath, ".mcp.json"), "utf8"));
  } catch (_) {
    return false;
  }
  return Boolean(manifest && manifest.mcpServers && typeof manifest.mcpServers === "object" && Object.keys(manifest.mcpServers).length > 0);
}
function checkSidequestInstall(projectPath, opts = {}) {
  const claudeHome = claudeHomeDir(opts);
  const registryPath = import_node_path.default.join(claudeHome, "plugins", "installed_plugins.json");
  let registry;
  try {
    registry = JSON.parse(import_node_fs.default.readFileSync(registryPath, "utf8"));
  } catch (err) {
    if (err && err.code === "ENOENT") return { ok: false, reason: "missing", registryPath };
    return { ok: false, reason: "registry_unreadable", registryPath, detail: String(err && err.message || err) };
  }
  const installs = registry?.plugins?.[PLUGIN_ID];
  if (!Array.isArray(installs) || !installs.length) return { ok: false, reason: "missing", registryPath };
  const target = normalizeDir(projectPath);
  const matching = installs.filter((install) => {
    if (!install) return false;
    if (install.scope === "user") return true;
    if (!target) return false;
    return normalizeDir(install.projectPath) === target;
  });
  if (!matching.length) return { ok: false, reason: "missing", registryPath };
  for (const install of matching) {
    const identity = typeof install.installPath === "string" ? installIdentity(install.installPath) : null;
    if (identity && installAdvertisesBoardMcp(install.installPath)) {
      return { ok: true, registryPath, installPath: install.installPath, identity };
    }
  }
  return { ok: false, reason: "stale", registryPath };
}
function repairGuidance() {
  return `Run \`${REPAIR_COMMAND}\` from / for the target project, then start a new session or run \`/reload-plugins\` before dispatching again.`;
}
function installRefusalMessage(check, projectPath) {
  if (check.reason === "registry_unreadable") {
    return `Dispatch refused: could not read Claude Code's plugin registry at ${check.registryPath} (${check.detail}). Fix or remove the corrupt registry, confirm sidequest@eigenwise-toolshed is installed for ${projectPath}, then dispatch again.`;
  }
  if (check.reason === "stale") {
    return `Dispatch refused: the sidequest@eigenwise-toolshed install registered for ${projectPath} (checked ${check.registryPath}) is missing or no longer declares the board MCP server. ${repairGuidance()}`;
  }
  return `Dispatch refused: sidequest@eigenwise-toolshed has no install registered for ${projectPath} in ${check.registryPath}. A \`.claude/settings.json\` enabledPlugins entry is not proof of an install. ${repairGuidance()}`;
}
function assertSidequestInstall(projectPath, opts = {}) {
  const check = checkSidequestInstall(projectPath, opts);
  if (!check.ok) throw new Error(installRefusalMessage(check, projectPath));
  return check;
}
function transportRefusalMessage() {
  return "Dispatch refused: the CLI cannot prove this Claude Code session has the Sidequest board MCP connected — a fresh native Agent could still receive zero board tools even though the target project's install looks fine. Run `/reload-plugins` in this session, then dispatch again through the board MCP `dispatch`/`native_agent` tool (reaching that tool is itself proof the MCP is connected). If you are intentionally running the CLI outside Claude Code for diagnostics, pass --unverified-transport to proceed anyway; it does NOT prove any session will have the board MCP available.";
}
function assertDispatchTransport(transport, opts = {}) {
  if (transport !== "cli") return;
  if (opts.allowUnverifiedTransport) return;
  throw new Error(transportRefusalMessage());
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  assertDispatchTransport,
  assertSidequestInstall,
  checkSidequestInstall,
  ensurePythonIoEncoding,
  installRefusalMessage,
  localAheadOfUpstreamWarning,
  transportRefusalMessage
});
