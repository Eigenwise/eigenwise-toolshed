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

// src/lib/plugin-freshness.ts
var import_node_crypto = __toESM(require("node:crypto"));
var import_node_fs = __toESM(require("node:fs"));
var import_node_os = __toESM(require("node:os"));
var import_node_path = __toESM(require("node:path"));
var SIDEQUEST_PLUGIN_ID = "sidequest@eigenwise-toolshed";
function loadedPluginVersion(pluginRoot2 = process.env.CLAUDE_PLUGIN_ROOT) {
  if (!pluginRoot2) return null;
  try {
    const manifest = JSON.parse(import_node_fs.default.readFileSync(import_node_path.default.join(pluginRoot2, ".claude-plugin", "plugin.json"), "utf8"));
    return typeof manifest.version === "string" ? manifest.version : null;
  } catch (_) {
    return null;
  }
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
  const pluginRoot2 = options.pluginRoot || process.env.CLAUDE_PLUGIN_ROOT;
  const version = loadedPluginVersion(pluginRoot2);
  const stateFile = loadedVersionStateFile(input, SIDEQUEST_PLUGIN_ID, options);
  if (!version || !stateFile || !pluginRoot2) return version;
  try {
    import_node_fs.default.mkdirSync(import_node_path.default.dirname(stateFile), { recursive: true });
    import_node_fs.default.writeFileSync(stateFile, JSON.stringify({ pluginId: SIDEQUEST_PLUGIN_ID, pluginRoot: pluginRoot2, version }));
  } catch (_) {
  }
  return version;
}

// src/hooks/shared/input.ts
var import_node_fs2 = __toESM(require("node:fs"));

// src/lib/exec-names.ts
var EFFORTS = Object.freeze(["low", "medium", "high", "xhigh", "max"]);
var CLAUDE_PREFIX = "sidequest-exec-";
var READ_ONLY_CLAUDE_PREFIX = "sidequest-exec-readonly-";
var DIAGNOSTIC_PROBE_NAME = "sidequest-diagnostic-probe";
var DISPATCH_NAME = "sidequest-exec-dispatch";
var READ_ONLY_DISPATCH_NAME = "sidequest-exec-dispatch-readonly";
function stableClaudeName(effort) {
  return `${CLAUDE_PREFIX}${effort}`;
}
function stableReadOnlyClaudeName(effort) {
  return `${READ_ONLY_CLAUDE_PREFIX}${effort}`;
}
var BUNDLED_AGENT_NAMES = /* @__PURE__ */ new Set([
  DISPATCH_NAME,
  READ_ONLY_DISPATCH_NAME,
  DIAGNOSTIC_PROBE_NAME,
  ...EFFORTS.map(stableClaudeName),
  ...EFFORTS.map(stableReadOnlyClaudeName)
]);
var PLUGIN_NAMESPACE = "sidequest:";
function canonicalExecutorName(name) {
  if (!name.startsWith(PLUGIN_NAMESPACE)) return name;
  const unqualifiedName = name.slice(PLUGIN_NAMESPACE.length);
  return BUNDLED_AGENT_NAMES.has(unqualifiedName) ? unqualifiedName : name;
}

// src/hooks/shared/input.ts
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function readStdin() {
  try {
    const raw = import_node_fs2.default.readFileSync(0, "utf8");
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    for (const field of ["agent_type", "agentType", "subagent_type"]) {
      const executor = parsed[field];
      if (typeof executor === "string") parsed[field] = canonicalExecutorName(executor);
    }
    return parsed;
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
var import_node_crypto2 = __toESM(require("node:crypto"));
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
  return import_node_crypto2.default.createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
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
function writeContext(hookEventName, additionalContext, initialUserMessage = "") {
  writeJson({
    hookSpecificOutput: {
      hookEventName,
      additionalContext: projectedText(hookEventName, additionalContext),
      ...initialUserMessage ? { initialUserMessage } : {}
    }
  });
}

// src/hooks/shared/paths.ts
var import_node_path2 = __toESM(require("node:path"));
function pluginRoot() {
  return process.env.CLAUDE_PLUGIN_ROOT || import_node_path2.default.join(__dirname, "..");
}
function runtimeModule(name) {
  return import_node_path2.default.join(pluginRoot(), "lib", `${name}.js`);
}

// src/hooks/shared/session-state.ts
var import_node_fs3 = __toESM(require("node:fs"));
var import_node_os2 = __toESM(require("node:os"));
var import_node_path3 = __toESM(require("node:path"));
function sessionStateFile(prefix, sessionId2) {
  const home = process.env.SIDEQUEST_HOME || import_node_path3.default.join(import_node_os2.default.homedir(), ".claude", "sidequest");
  return import_node_path3.default.join(home, "tmp", "state", `${prefix}-${encodeURIComponent(sessionId2)}.json`);
}
function readSessionState(file) {
  try {
    const parsed = JSON.parse(import_node_fs3.default.readFileSync(file, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}
function writeSessionState(file, state) {
  import_node_fs3.default.mkdirSync(import_node_path3.default.dirname(file), { recursive: true });
  import_node_fs3.default.writeFileSync(file, JSON.stringify(state));
}

// src/hooks/board-first-reminder.ts
var AUTOMATION_TAG = /^<(?:agent-message|local-command(?:-caveat)?|task-notification|task-progress|task-result)\b/i;
var CHANGE_VERB = /\b(?:add|build|implement|fix|refactor|change|update|create|write|remove|delete|rename|move|migrate|rewrite|port|wire|improve|investigate|audit|debug|make)\b/i;
var GREETING_LENGTH = 60;
var INLINE_WORK_WINDOW_KEYS = ["boardInteraction", "readActions", "substantiveActions", "soloChoiceSurfaced", "investigationChoiceSurfaced"];
var ROUTED_BOARD_REMINDER = "sidequest: gather enough read-only evidence, using Explore only for a quick sweep (it inherits the session model; deep or fan-out investigation is a codebase-exploration spike), then file precise tickets with add and dispatch them without offering. Only a one-or-two-file edit at a known location stays inline.";
var NEW_BOARD_HINT = "sidequest: no board here yet. For multi-file or multi-step work, the first add creates this repo's board and dispatch is ready through the default profile; file the ticket and dispatch it without offering.";
function projectRoot(input, store) {
  return store.nearestRepoRoot(stringField(input, "cwd") || process.env.CLAUDE_PROJECT_DIR || process.cwd());
}
function boardReminder(input) {
  const store = require(runtimeModule("store"));
  const root = projectRoot(input, store);
  const found = store.findProject(root);
  if (!found.ok) return store.boardRootRefusal(root, { implicit: true }) ? null : NEW_BOARD_HINT;
  return store.projectDispatchAdmission(String(found.slug)).status === "routed" ? ROUTED_BOARD_REMINDER : null;
}
function looksLikeWorkRequest(prompt) {
  return CHANGE_VERB.test(prompt) || prompt.length > GREETING_LENGTH;
}
function reopenInlineWorkWindow(sessionId2) {
  const file = sessionStateFile("inline-work", sessionId2);
  const state = readSessionState(file);
  if (!state.boardInteraction) return;
  for (const key of INLINE_WORK_WINDOW_KEYS) delete state[key];
  writeSessionState(file, { ...state, boardTouchedEarlier: true });
}
function remindOnce(input, sessionId2, prompt) {
  const file = sessionStateFile("board-first", sessionId2);
  const state = readSessionState(file);
  if (state.reminded || !looksLikeWorkRequest(prompt)) return;
  const reminder = boardReminder(input);
  if (!reminder) return;
  state.reminded = true;
  writeSessionState(file, state);
  writeContext("UserPromptSubmit", reminder);
}
function humanPrompt(input) {
  const prompt = stringField(input, "prompt").trim();
  return AUTOMATION_TAG.test(prompt) ? "" : prompt;
}
function main() {
  const input = readStdin();
  if (!input) return;
  reportLoadedSidequestVersion(input);
  const sessionId2 = stringField(input, "session_id", "sessionId").trim();
  const prompt = humanPrompt(input);
  if (isSubagent(input) || !sessionId2 || !prompt) return;
  reopenInlineWorkWindow(sessionId2);
  remindOnce(input, sessionId2, prompt);
}
try {
  main();
} catch (_) {
  process.exit(0);
}
