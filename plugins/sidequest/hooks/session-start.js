#!/usr/bin/env node
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
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

// src/hooks/shared/input.ts
var import_node_fs = __toESM(require("node:fs"));
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function readStdin() {
  try {
    const raw = import_node_fs.default.readFileSync(0, "utf8");
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}
function stringField(input, ...names) {
  for (const name of names) {
    const value = input[name];
    if (value != null) return String(value);
  }
  return "";
}
function isSubagent(input) {
  return ["agent_id", "agentId", "agent_type", "agentType"].some((name) => {
    const identity = String(input[name] || "").trim().toLowerCase();
    return identity && identity !== "main" && identity !== "main-thread";
  });
}

// src/hooks/shared/output.ts
var import_node_crypto = __toESM(require("node:crypto"));
var CONTEXT_BUDGETS = Object.freeze({
  SessionStart: 4 * 1024,
  UserPromptSubmit: 1024,
  PreToolUse: 768,
  PreCompact: 1500,
  PostCompact: 1500,
  SubagentStart: 512,
  SubagentStop: 512,
  Stop: 512,
  PostToolUseFailure: 512,
  TeammateIdle: 512
});
function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}
function contextBudget(hookEventName) {
  return CONTEXT_BUDGETS[hookEventName] || 512;
}
function stableWatermark(value) {
  return import_node_crypto.default.createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}
function truncateUtf8(value, maxBytes) {
  if (byteLength(value) <= maxBytes) return value;
  let truncated = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = byteLength(character);
    if (bytes + characterBytes > maxBytes) break;
    truncated += character;
    bytes += characterBytes;
  }
  return truncated;
}
function projectedText(hookEventName, value) {
  const budget = contextBudget(hookEventName);
  if (byteLength(value) <= budget) return value;
  const watermark = stableWatermark(value);
  const omission = `
[sidequest context v1 id=${hookEventName} revision=${watermark} watermark=${watermark}; content omitted for ${budget}B budget. Retrieve current board state with mcp__plugin_sidequest_board__comments({ref:"<ticket-ref>"}).]`;
  return `${truncateUtf8(value, Math.max(0, budget - byteLength(omission)))}${omission}`;
}
function writeJson(value) {
  process.stdout.write(JSON.stringify(value));
}
function writeContext(hookEventName, additionalContext) {
  writeJson({ hookSpecificOutput: { hookEventName, additionalContext: projectedText(hookEventName, additionalContext) } });
}

// src/hooks/shared/paths.ts
var import_node_path = __toESM(require("node:path"));
function pluginRoot() {
  return process.env.CLAUDE_PLUGIN_ROOT || import_node_path.default.join(__dirname, "..");
}
function runtimeModule(name) {
  return import_node_path.default.join(pluginRoot(), "lib", `${name}.js`);
}

// src/hooks/shared/compaction.ts
var import_node_fs2 = __toESM(require("node:fs"));
var import_node_os = __toESM(require("node:os"));
var import_node_path2 = __toESM(require("node:path"));
var TRANSCRIPT_BYTES_THRESHOLD = 3 * 1024 * 1024;
function disabledValue(value) {
  return ["0", "false", "no", "off"].includes(String(value || "").trim().toLowerCase());
}
function compactionSuggestionsEnabled() {
  return !disabledValue(process.env.SIDEQUEST_COMPACTION_SUGGESTIONS);
}
function isPrimarySession(input) {
  return !isSubagent(input);
}
function stateDirectory() {
  const home = String(process.env.SIDEQUEST_HOME || "").trim() || import_node_path2.default.join(import_node_os.default.homedir(), ".claude", "sidequest");
  return import_node_path2.default.join(home, "compaction-suggestions");
}
function stateFile(sessionId3) {
  return import_node_path2.default.join(stateDirectory(), `${encodeURIComponent(sessionId3)}.json`);
}
function transcriptBytes(transcriptPath) {
  try {
    return import_node_fs2.default.statSync(String(transcriptPath || "")).size;
  } catch (_) {
    return 0;
  }
}
function writeState(sessionId3, state) {
  try {
    import_node_fs2.default.mkdirSync(stateDirectory(), { recursive: true });
    import_node_fs2.default.writeFileSync(stateFile(sessionId3), JSON.stringify(state));
    return true;
  } catch (_) {
    return false;
  }
}
function initializeCompactionState(sessionId3, transcriptPath) {
  if (!sessionId3 || !compactionSuggestionsEnabled()) return;
  const file = stateFile(sessionId3);
  if (import_node_fs2.default.existsSync(file)) return;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  writeState(sessionId3, { resetAt: now, ticketBaselineAt: now, transcriptBytes: transcriptBytes(transcriptPath) });
}

// src/hooks/shared/sweep-handoff.ts
var import_node_child_process = require("node:child_process");
var import_node_crypto2 = __toESM(require("node:crypto"));
var import_node_fs3 = __toESM(require("node:fs"));
var import_node_os2 = __toESM(require("node:os"));
var import_node_path3 = __toESM(require("node:path"));
var DEFAULT_DEADLINE_MS = 2500;
var DEFERRAL_NOTICE = "sidequest: worktree sweep exceeded its SessionStart budget and is still running in the background. Its report arrives on the next session start.";
var HANDOFF_FAILED_NOTICE = "sidequest: worktree sweep could not run, so stale agent worktrees were not collected this session.";
function deadlineMs() {
  const raw = Number(process.env.SIDEQUEST_SWEEP_DEADLINE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_DEADLINE_MS;
}
function stateDirectory2() {
  const home = String(process.env.SIDEQUEST_HOME || "").trim() || import_node_path3.default.join(import_node_os2.default.homedir(), ".claude", "sidequest");
  return import_node_path3.default.join(home, "sweep-reports");
}
function reportFile(cwd) {
  const key = import_node_crypto2.default.createHash("sha1").update(import_node_path3.default.resolve(cwd || ".")).digest("hex").slice(0, 16);
  return import_node_path3.default.join(stateDirectory2(), `${key}.json`);
}
function drainReport(cwd) {
  const file = reportFile(cwd);
  let raw;
  try {
    raw = import_node_fs3.default.readFileSync(file, "utf8");
  } catch (_) {
    return null;
  }
  import_node_fs3.default.rmSync(file, { force: true });
  try {
    const parsed = JSON.parse(raw);
    const notices = parsed?.notices;
    return Array.isArray(notices) ? notices.map((notice) => String(notice)).filter(Boolean) : [];
  } catch (_) {
    return [];
  }
}
function sweepCwd(data) {
  return stringField(data, "cwd", "project_dir", "projectDir") || process.env.CLAUDE_PROJECT_DIR || process.cwd();
}
async function runSweep(data) {
  const cwd = sweepCwd(data);
  const carried = drainReport(cwd) || [];
  const budget = deadlineMs();
  let child;
  try {
    child = (0, import_node_child_process.spawn)(process.execPath, [
      import_node_path3.default.join(pluginRoot(), "hooks", "sweep-worktrees.js"),
      "--cwd",
      cwd,
      "--session",
      stringField(data, "session_id", "sessionId")
    ], { detached: true, stdio: "ignore", windowsHide: true });
  } catch (_) {
    return [...carried, HANDOFF_FAILED_NOTICE];
  }
  const outcome = await new Promise((resolve) => {
    if (budget === 0) return resolve("deferred");
    const timer = setTimeout(() => resolve("deferred"), budget);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve("exited");
    });
    child.once("error", () => {
      clearTimeout(timer);
      resolve("failed");
    });
  });
  if (outcome === "failed") return [...carried, HANDOFF_FAILED_NOTICE];
  if (outcome === "deferred") {
    child.unref();
    return [...carried, DEFERRAL_NOTICE];
  }
  const report = drainReport(cwd);
  return report === null ? [...carried, HANDOFF_FAILED_NOTICE] : [...carried, ...report];
}

// src/hooks/shared/worktree-sweep.ts
var import_node_child_process2 = require("node:child_process");
var import_node_fs4 = __toESM(require("node:fs"));
var import_promises = require("node:fs/promises");
var import_node_os3 = __toESM(require("node:os"));
var import_node_path4 = __toESM(require("node:path"));
var DEFAULT_NOT_INTEGRATED_SALVAGE_AGE_HOURS = 7 * 24;
function stateFile2() {
  const home = String(process.env.SIDEQUEST_HOME || "").trim() || import_node_path4.default.join(import_node_os3.default.homedir(), ".claude", "sidequest");
  return import_node_path4.default.join(home, "worktree-sweep-sessions.json");
}
function readState() {
  try {
    return JSON.parse(import_node_fs4.default.readFileSync(stateFile2(), "utf8"));
  } catch (_) {
    return {};
  }
}
function writeState2(state) {
  try {
    import_node_fs4.default.mkdirSync(import_node_path4.default.dirname(stateFile2()), { recursive: true });
    import_node_fs4.default.writeFileSync(stateFile2(), JSON.stringify(state), "utf8");
  } catch (_) {
  }
}
function sessionId(data) {
  return stringField(data, "session_id", "sessionId") || process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || "";
}
function sessionWorktreePath(start) {
  const resolved = import_node_path4.default.resolve(start);
  let candidate = resolved;
  for (; ; ) {
    try {
      if (import_node_fs4.default.existsSync(import_node_path4.default.join(candidate, ".git"))) return candidate;
    } catch (_) {
      return resolved;
    }
    const parent = import_node_path4.default.dirname(candidate);
    if (parent === candidate) return resolved;
    candidate = parent;
  }
}
function currentProject(data, store) {
  const start = stringField(data, "cwd", "project_dir", "projectDir") || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const currentPath = store.nearestRepoRoot(start);
  const found = store.findProject(currentPath);
  return {
    project: found.ok && found.slug && found.meta?.path ? { slug: found.slug, path: found.meta.path } : null,
    sessionPath: sessionWorktreePath(start)
  };
}
function registerSweepSession(data) {
  const id = sessionId(data);
  if (!id) return;
  try {
    const store = require(runtimeModule("store"));
    const { project, sessionPath } = currentProject(data, store);
    if (!project) return;
    const state = readState();
    state.sessions = state.sessions || {};
    state.sessions[id] = sessionPath;
    writeState2(state);
  } catch (_) {
  }
}

// src/hooks/diagnostic-worktree-warning.ts
var import_node_fs5 = __toESM(require("node:fs"));
var import_node_path5 = __toESM(require("node:path"));
var ENDED_RUN_WINDOW_MS = 2 * 60 * 60 * 1e3;
function gitDirectory(entry) {
  try {
    if (import_node_fs5.default.statSync(entry).isDirectory()) return entry;
    const linkedGitDirectory = /^gitdir:\s*(.+)$/m.exec(import_node_fs5.default.readFileSync(entry, "utf8"))?.[1];
    return linkedGitDirectory ? import_node_path5.default.resolve(import_node_path5.default.dirname(entry), linkedGitDirectory.trim()) : null;
  } catch (_) {
    return null;
  }
}
function checkoutLocation(start) {
  let current = import_node_path5.default.resolve(start);
  for (; ; ) {
    const found = gitDirectory(import_node_path5.default.join(current, ".git"));
    if (found) {
      if (import_node_path5.default.basename(found) === ".git") return { checkoutRoot: current, projectRoot: current };
      const commonGitDirectory = import_node_path5.default.resolve(found, "..", "..");
      if (import_node_path5.default.basename(commonGitDirectory) === ".git") return { checkoutRoot: current, projectRoot: import_node_path5.default.dirname(commonGitDirectory) };
      return null;
    }
    const parent = import_node_path5.default.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
function comparablePath(value) {
  try {
    const lease = require(runtimeModule("kernel/worktree"));
    return lease.canonicalPath(value);
  } catch (_) {
    const resolved = import_node_path5.default.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  }
}
function agentWorktreeRoots(projectRoot) {
  try {
    const worktrees = require(runtimeModule("worktrees"));
    return worktrees.agentWorktreeRoots(projectRoot);
  } catch (_) {
    return [import_node_path5.default.join(projectRoot, ".claude", "worktrees")];
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
      return [{ worktree, ref: String(ticket.ref || ""), lifecycle, onDisk: import_node_fs5.default.existsSync(worktree) }];
    });
  } catch (_) {
    return [];
  }
}
function unclaimedWorktreeDirectories(roots) {
  return roots.flatMap((root) => {
    try {
      return import_node_fs5.default.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name.startsWith("agent-")).map((entry) => ({ worktree: import_node_path5.default.join(root, entry.name), ref: "", lifecycle: "ended", onDisk: true }));
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

// src/lib/plugin-freshness.ts
var import_node_crypto3 = __toESM(require("node:crypto"));
var import_node_fs6 = __toESM(require("node:fs"));
var import_node_os4 = __toESM(require("node:os"));
var import_node_path6 = __toESM(require("node:path"));
var SIDEQUEST_PLUGIN_ID = "sidequest@eigenwise-toolshed";
function claudeHome(options = {}) {
  return options.claudeHome || process.env.SIDEQUEST_CLAUDE_HOME || import_node_path6.default.join(import_node_os4.default.homedir(), ".claude");
}
function normalizedPath(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  return import_node_path6.default.resolve(value).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
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
    registry = JSON.parse(import_node_fs6.default.readFileSync(import_node_path6.default.join(claudeHome(options), "plugins", "installed_plugins.json"), "utf8"));
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
function loadedPluginVersion(pluginRoot2 = process.env.CLAUDE_PLUGIN_ROOT) {
  if (!pluginRoot2) return null;
  try {
    const manifest = JSON.parse(import_node_fs6.default.readFileSync(import_node_path6.default.join(pluginRoot2, ".claude-plugin", "plugin.json"), "utf8"));
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
function sidequestReloadWarning(projectPath, options = {}) {
  const loadedVersion = loadedPluginVersion(options.pluginRoot);
  const installedVersion = installedSidequestVersion(projectPath, options);
  if (!loadedVersion || !installedVersion || compareSemver(loadedVersion, installedVersion) !== -1) return "";
  return `Sidequest: loaded ${loadedVersion}, installed ${installedVersion}. Run /reload-plugins or restart Claude Code before dispatching work.`;
}
function stateDirectory3(options = {}) {
  return options.stateDirectory || import_node_path6.default.join(import_node_os4.default.tmpdir(), "eigenwise-toolshed", "freshness-warnings", "loaded-plugin-versions");
}
function sessionId2(input) {
  const value = input.session_id ?? input.sessionId;
  return value == null ? "" : String(value);
}
function loadedVersionStateFile(input, pluginId = SIDEQUEST_PLUGIN_ID, options = {}) {
  const id = sessionId2(input);
  if (!id) return null;
  const digest = import_node_crypto3.default.createHash("sha256").update(`${id}\0${pluginId}`).digest("hex");
  return import_node_path6.default.join(stateDirectory3(options), `${digest}.json`);
}
function reportLoadedSidequestVersion(input, options = {}) {
  const version = loadedPluginVersion(options.pluginRoot);
  const stateFile3 = loadedVersionStateFile(input, SIDEQUEST_PLUGIN_ID, options);
  if (!version || !stateFile3) return version;
  try {
    import_node_fs6.default.mkdirSync(import_node_path6.default.dirname(stateFile3), { recursive: true });
    import_node_fs6.default.writeFileSync(stateFile3, JSON.stringify({ pluginId: SIDEQUEST_PLUGIN_ID, version }));
  } catch (_) {
  }
  return version;
}

// src/hooks/session-start.ts
var MAX_SESSION_CONTEXT_BYTES = 4 * 1024;
var MAX_WORKFORCE_BYTES = 800;
var MAX_WORKFORCE_DESCRIPTION = 90;
function truncateText(value, max) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length <= max ? text : text.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
}
function workforceSection() {
  try {
    const store = require(runtimeModule("store"));
    const start = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const found = store.findProject(store.nearestRepoRoot(start));
    const project = found.ok && found.slug ? found.slug : "";
    if (!project || store.projectDispatchAdmission(project).status !== "routed") return "";
    const header = "YOUR EXECUTORS — delegate work AND investigation to them:";
    const entries = store.getCategories({ project, includeDisabled: false }).map((category) => {
      const route = store.resolveCategoryRoute(category);
      return {
        id: String(category.id || "").trim(),
        route: `(${route.model}·${route.effort})`,
        description: truncateText(category.description, MAX_WORKFORCE_DESCRIPTION),
        usable: Boolean(route.exec)
      };
    }).filter((entry) => entry.usable);
    const priority = /* @__PURE__ */ new Set(["codebase-exploration", "debugging", "spike-investigation", "source-lookup", "evidence-research", "visual-evaluation"]);
    const preferred = [...entries.filter((entry) => priority.has(entry.id)), ...entries.filter((entry) => !priority.has(entry.id))];
    const bytesFor = (lines) => Buffer.byteLength([header, ...lines].join("\n"));
    const base = preferred.map((entry) => `${entry.id} — ${entry.route}`);
    if (bytesFor(base) > MAX_WORKFORCE_BYTES) {
      const bounded = [];
      for (let index = 0; index < base.length; index += 1) {
        const line = base[index] || "";
        const truncation = `… ${base.length - index} more enabled categories.`;
        if (bytesFor([...bounded, line, truncation]) > MAX_WORKFORCE_BYTES) return [header, ...bounded, truncation].join("\n");
        bounded.push(line);
      }
    }
    const descriptions = /* @__PURE__ */ new Map();
    for (const entry of preferred) {
      if (!entry.description) continue;
      descriptions.set(entry.id, entry.description);
      const lines = preferred.map((candidate) => `${candidate.id} — ${descriptions.get(candidate.id) ? descriptions.get(candidate.id) + " " : ""}${candidate.route}`);
      if (bytesFor(lines) > MAX_WORKFORCE_BYTES) descriptions.delete(entry.id);
    }
    return [header, ...preferred.map((entry) => `${entry.id} — ${descriptions.get(entry.id) || "enabled"} ${entry.route}`)].join("\n");
  } catch (_) {
    return "";
  }
}
function truncateUtf82(value, maxBytes) {
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character);
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}
function withWorkforce(context) {
  const section = workforceSection();
  if (!section) return truncateUtf82(context, MAX_SESSION_CONTEXT_BYTES);
  const contextBytes = MAX_SESSION_CONTEXT_BYTES - Buffer.byteLength(section) - 1;
  return `${truncateUtf82(context, Math.max(0, contextBytes))}
${section}`;
}
function nudgeOff() {
  const value = String(process.env.SIDEQUEST_NUDGE || "").trim().toLowerCase();
  return value === "off" || value === "0" || value === "false" || value === "no";
}
function checkpointingGuidance(data) {
  const model = stringField(data, "model").toLowerCase();
  const tier = model.includes("haiku") ? "Haiku" : model.includes("sonnet") ? "Sonnet" : "";
  if (!tier) return "";
  return ` CHECKPOINT MODE (${tier}): proceed on cheap reversible config and route edits; ask before irreversible spend, deletion, or an incomplete-evidence judgment.`;
}
function dispatchAdmissionStatus(data) {
  try {
    const store = require(runtimeModule("store"));
    const start = stringField(data, "cwd", "project_dir", "projectDir") || process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const found = store.findProject(store.nearestRepoRoot(start));
    return found.ok && found.slug ? store.projectDispatchAdmission(found.slug).status : "no-project";
  } catch (_) {
    return "no-project";
  }
}
function emit(context, notice) {
  const output = notice ? `${notice}
${context}` : context;
  writeContext("SessionStart", withWorkforce(output));
}
async function main() {
  const data = readStdin();
  if (!data) return;
  if (isPrimarySession(data)) {
    const sessionId3 = stringField(data, "session_id", "sessionId") || process.env.CLAUDE_CODE_SESSION_ID || "";
    initializeCompactionState(sessionId3, data.transcript_path || data.transcriptPath);
  }
  reportLoadedSidequestVersion(data, { pluginRoot: pluginRoot() });
  const freshnessNotice = sidequestReloadWarning(stringField(data, "cwd", "project_dir", "projectDir") || process.env.CLAUDE_PROJECT_DIR || process.cwd(), { pluginRoot: pluginRoot() });
  registerSweepSession(data);
  let sweepNotices = [];
  try {
    sweepNotices = await runSweep(data);
  } catch (error) {
    sweepNotices = [`sidequest: worktree sweep failed: ${error instanceof Error ? error.message : String(error)}`];
  }
  const source = stringField(data, "source");
  const restartNotice = [
    freshnessNotice,
    source === "compact" || source === "resume" ? "" : diagnosticWorktreeWarning(data),
    ...sweepNotices
  ].filter(Boolean).join("\n");
  if (nudgeOff()) return;
  const cli = `node "${pluginRoot()}/bin/sidequest.js"`;
  const watch = `Arm a persistent Monitor running ${cli} watch --project <path>; it interrupts you on scope requests, blockers, and failed GitHub CI runs. Skip it if Monitor is unavailable.`;
  const dispatchAdmission = dispatchAdmissionStatus(data);
  const boardAuthorization = dispatchAdmission === "routed" ? "Quick edits at a location the user named or that is already known stay inline with no justification or board ceremony, as do operational requests and direct questions. A usable Sidequest project route is standing authorization to file tickets and dispatch returned executors without offering it or asking for a further user request when work is a multi-file change, at an unknown location that needs discovery, or an investigation. For independent per-item work, shard tickets and dispatch concurrently; isolated-worktree overlap is an integration concern, while sequential dependencies or a shared design decision stay together. For middle-ground work kept inline, state in the reply why inline serves the user better than an executor. Ask before work beyond the approved scope unless explicit standing permission covers it." : "Sidequest has no usable project route here, so substantive work may stay inline. The first Board MCP call auto-registers this project; then use board_config to enable a category with an available executor before asking for board dispatch.";
  const inlineBoundary = dispatchAdmission === "routed" ? "" : "Specific one-file or one-prompt asks stay inline unless dependency or risk warrants dispatch; say why. Ask before work beyond the approved scope unless explicit standing permission covers it.";
  const fanoutGuidance = dispatchAdmission === "routed" ? "" : "For independent per-item work, shard tickets and dispatch concurrently; isolated-worktree overlap is an integration concern, while sequential dependencies or a shared design decision stay together.";
  const upstreamDefects = "If Sidequest itself misbehaves (a refusal contradicting observed state, a dead retrieval handle, a guard loop, a reproducible tool error), report it to the user with the reproducing evidence as an upstream defect; never encode a workaround into project rules, hooks, or memory, and mark any unavoidable stopgap temporary, naming the defect it awaits.";
  const checkpoint = checkpointingGuidance(data);
  const recovery = "Context is UTF-8 bounded. Omitted details name a typed board retrieval call.";
  if (source === "compact" || source === "resume") {
    emit(
      `=== sidequest (active — context restored) ===
${recovery}
ROLE: ORCHESTRATOR. ${checkpoint}${checkpoint ? " " : ""}${boardAuthorization} ${watch} ${inlineBoundary} ${fanoutGuidance} ${upstreamDefects} Dispatch executors with the returned spawn unchanged. Ticket and dispatch before multi-file investigation. never TaskOutput. Reconnect Board MCP, re-dispatch, and spawn the exact returned executor before recovering lifecycle work. Use pulse/changes for liveness; a restored window replays background-task reminders that can name already-finished agents, so believe the board over them and do not investigate. After terminal board evidence is consumed and its handoff is preserved, retire the exact native teammate once with TaskStop({ task_id: "<agent name>" }); TaskStop is Claude Code host cleanup, not a Sidequest tool. Keep live claims, retained continuations, and integration candidates steerable. If a board path refuses verified work, deliver it yourself through groomClose with deliveryCommit and record the refusal evidence. Board MCP is the lifecycle authority; no Sidequest CLI or raw Agent fallback.`,
      restartNotice
    );
    return;
  }
  emit(
    `=== sidequest (active) ===
${recovery}
ROLE: ORCHESTRATOR. ${checkpoint}${checkpoint ? " " : ""}${boardAuthorization} ${watch} ${inlineBoundary} ${fanoutGuidance} ${upstreamDefects} Substantive multi-file changes and investigations need tickets, then dispatch and the returned executor. Operational requests can run inline. Use board MCP tools first. Tiny lookups use Read, Glob, Grep, or WebFetch. Do not use TaskOutput. One diagnose-first retry; two failures need evidence and user escalation. After terminal board evidence is consumed and its handoff is preserved, retire the exact native teammate once with TaskStop({ task_id: "<agent name>" }); TaskStop is Claude Code host cleanup, not a Sidequest tool. Keep live claims, retained continuations, and integration candidates steerable. When a board path refuses verified work, deliver it yourself through groomClose with deliveryCommit and record the refusal evidence. Workers own claimed work and report conflicts, verification, and cleanup.`,
    restartNotice
  );
}
main().catch((error) => {
  console.error(`sidequest: session-start failed: ${error instanceof Error ? error.message : String(error)}`);
});
