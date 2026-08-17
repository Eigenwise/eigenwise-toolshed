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

// src/hooks/diagnostic-worktree-warning.ts
var diagnostic_worktree_warning_exports = {};
__export(diagnostic_worktree_warning_exports, {
  diagnosticWorktreeWarning: () => diagnosticWorktreeWarning
});
module.exports = __toCommonJS(diagnostic_worktree_warning_exports);
var import_node_fs2 = __toESM(require("node:fs"));
var import_node_path2 = __toESM(require("node:path"));

// src/hooks/shared/input.ts
var import_node_fs = __toESM(require("node:fs"));
function stringField(input, ...names) {
  for (const name of names) {
    const value = input[name];
    if (value != null) return String(value);
  }
  return "";
}

// src/hooks/shared/paths.ts
var import_node_path = __toESM(require("node:path"));
function pluginRoot() {
  return process.env.CLAUDE_PLUGIN_ROOT || import_node_path.default.join(__dirname, "..");
}
function runtimeModule(name) {
  return import_node_path.default.join(pluginRoot(), "lib", `${name}.js`);
}

// src/hooks/diagnostic-worktree-warning.ts
var ENDED_RUN_WINDOW_MS = 2 * 60 * 60 * 1e3;
function gitDirectory(entry) {
  try {
    if (import_node_fs2.default.statSync(entry).isDirectory()) return entry;
    const linkedGitDirectory = /^gitdir:\s*(.+)$/m.exec(import_node_fs2.default.readFileSync(entry, "utf8"))?.[1];
    return linkedGitDirectory ? import_node_path2.default.resolve(import_node_path2.default.dirname(entry), linkedGitDirectory.trim()) : null;
  } catch (_) {
    return null;
  }
}
function checkoutLocation(start) {
  let current = import_node_path2.default.resolve(start);
  for (; ; ) {
    const found = gitDirectory(import_node_path2.default.join(current, ".git"));
    if (found) {
      if (import_node_path2.default.basename(found) === ".git") return { checkoutRoot: current, projectRoot: current };
      const commonGitDirectory = import_node_path2.default.resolve(found, "..", "..");
      if (import_node_path2.default.basename(commonGitDirectory) === ".git") return { checkoutRoot: current, projectRoot: import_node_path2.default.dirname(commonGitDirectory) };
      return null;
    }
    const parent = import_node_path2.default.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
function comparablePath(value) {
  try {
    const lease = require(runtimeModule("kernel/worktree"));
    return lease.canonicalPath(value);
  } catch (_) {
    const resolved = import_node_path2.default.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  }
}
function agentWorktreeRoots(projectRoot) {
  try {
    const worktrees = require(runtimeModule("worktrees"));
    return worktrees.agentWorktreeRoots(projectRoot);
  } catch (_) {
    return [import_node_path2.default.join(projectRoot, ".claude", "worktrees")];
  }
}
function endedRecently(dispatch, now) {
  const at = Date.parse(String(dispatch.terminalAt || dispatch.launchedAt || dispatch.preparedAt || ""));
  return Number.isFinite(at) && now - at <= ENDED_RUN_WINDOW_MS;
}
function lifecycleOf(store, ticket, dispatch, now) {
  if (!dispatch.terminalAt) return ticket.claim?.by && !store.claimReclaimable(ticket, now) ? "live" : "ended";
  return store.pendingSubmission(ticket) ? "candidate" : "ended";
}
function boardWorktrees(projectRoot, now) {
  try {
    const store = require(runtimeModule("store"));
    const project = store.findProject(projectRoot);
    if (!project.ok || !project.slug) return [];
    return store.listTickets(project.slug).flatMap((ticket) => {
      const dispatch = ticket.dispatch;
      const worktree = String(dispatch?.worktree || "").trim();
      if (!dispatch || !worktree || dispatch.sharedTree !== false) return [];
      const lifecycle = lifecycleOf(store, ticket, dispatch, now);
      if (lifecycle === "ended" && !endedRecently(dispatch, now)) return [];
      return [{ worktree, ref: String(ticket.ref || ""), lifecycle, onDisk: import_node_fs2.default.existsSync(worktree) }];
    });
  } catch (_) {
    return [];
  }
}
function unclaimedWorktreeDirectories(roots) {
  return roots.flatMap((root) => {
    try {
      return import_node_fs2.default.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name.startsWith("agent-")).map((entry) => ({ worktree: import_node_path2.default.join(root, entry.name), ref: "", lifecycle: "ended", onDisk: true }));
    } catch (_) {
      return [];
    }
  });
}
function foreignWorktrees(location, roots, now) {
  const own = comparablePath(location.checkoutRoot);
  const byPath = /* @__PURE__ */ new Map();
  for (const candidate of [...boardWorktrees(location.projectRoot, now), ...unclaimedWorktreeDirectories(roots)]) {
    const key = comparablePath(candidate.worktree);
    if (key === own || byPath.has(key)) continue;
    byPath.set(key, candidate);
  }
  return [...byPath.values()];
}
function refList(worktrees) {
  const refs = worktrees.map((entry) => entry.ref).filter(Boolean).sort();
  return refs.length ? refs.join(", ") : "an unnamed dispatch";
}
function warningFor(worktrees, roots) {
  const live = worktrees.filter((entry) => entry.lifecycle === "live");
  const candidates = worktrees.filter((entry) => entry.lifecycle === "candidate");
  const gone = worktrees.filter((entry) => !entry.onDisk);
  const sentences = [
    `sidequest: ${worktrees.length} foreign agent worktree${worktrees.length === 1 ? "" : "s"} in play, and Claude Code delivers their LSP diagnostics into YOUR context because that registry is keyed per session, not per agent.`,
    `Nothing under ${roots.join(" or ")} is yours.`
  ];
  if (gone.length) sentences.push(`${gone.length} of those ${gone.length === 1 ? "paths is" : "paths are"} already gone from disk, and a diagnostic naming a path that no longer exists is always false.`);
  if (live.length) sentences.push(`${live.length} hold${live.length === 1 ? "s" : ""} a live claim (${refList(live)}): errors there are expected mid-refactor state and never outrank that executor's own verify.`);
  if (candidates.length) sentences.push(`Actionable exception: ${refList(candidates)} hold${candidates.length === 1 ? "s" : ""} a candidate awaiting integration, so a diagnostic in that worktree outweighs an executor's \`verify passed\` and is worth reading before you integrate.`);
  sentences.push("Keep error-severity diagnostics in your own files actionable.");
  return sentences.join(" ");
}
function diagnosticWorktreeWarning(input, now = Date.now()) {
  const start = stringField(input, "cwd", "project_dir", "projectDir") || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const location = checkoutLocation(start);
  if (!location) return "";
  const roots = agentWorktreeRoots(location.projectRoot);
  const worktrees = foreignWorktrees(location, roots, now);
  return worktrees.length ? warningFor(worktrees, roots) : "";
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  diagnosticWorktreeWarning
});
