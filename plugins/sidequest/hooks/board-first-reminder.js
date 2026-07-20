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

// src/hooks/shared/output.ts
function writeJson(value) {
  process.stdout.write(JSON.stringify(value));
}
function writeContext(hookEventName, additionalContext) {
  writeJson({ hookSpecificOutput: { hookEventName, additionalContext } });
}

// src/hooks/shared/paths.ts
var import_node_path = __toESM(require("node:path"));
function pluginRoot() {
  return process.env.CLAUDE_PLUGIN_ROOT || import_node_path.default.join(__dirname, "..");
}
function runtimeModule(name) {
  return import_node_path.default.join(pluginRoot(), "lib", `${name}.js`);
}

// src/hooks/shared/session-state.ts
var import_node_fs2 = __toESM(require("node:fs"));
var import_node_os = __toESM(require("node:os"));
var import_node_path2 = __toESM(require("node:path"));
function sessionStateFile(prefix, sessionId) {
  const home = process.env.SIDEQUEST_HOME || import_node_path2.default.join(import_node_os.default.homedir(), ".claude", "sidequest");
  return import_node_path2.default.join(home, "tmp", "state", `${prefix}-${encodeURIComponent(sessionId)}.json`);
}
function readSessionState(file) {
  try {
    const parsed = JSON.parse(import_node_fs2.default.readFileSync(file, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}
function writeSessionState(file, state) {
  import_node_fs2.default.mkdirSync(import_node_path2.default.dirname(file), { recursive: true });
  import_node_fs2.default.writeFileSync(file, JSON.stringify(state));
}

// src/hooks/board-first-reminder.ts
var AUTOMATION_TAG = /^<(?:agent-message|local-command(?:-caveat)?|task-notification|task-progress|task-result)\b/i;
function boardFor(input) {
  const store = require(runtimeModule("store"));
  const start = stringField(input, "cwd") || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const found = store.findProject(store.nearestRepoRoot(start));
  if (!found.ok || !found.slug || !store.projectRoutingEnabled(found.slug)) return null;
  return found.slug;
}
function main() {
  const input = readStdin();
  if (!input || input.agent_id || input.agentId) return;
  const id = stringField(input, "session_id", "sessionId").trim();
  const prompt = stringField(input, "prompt").trim();
  if (!id || !prompt || AUTOMATION_TAG.test(prompt)) return;
  const file = sessionStateFile("board-first", id);
  const state = readSessionState(file);
  if (state.reminded || !boardFor(input)) return;
  state.reminded = true;
  writeSessionState(file, state);
  writeContext("UserPromptSubmit", "sidequest: substantive work goes through the board. File ticket(s) and dispatch, or claim --direct for deliberate inline work; trivial lookups are exempt.");
}
try {
  main();
} catch (_) {
  process.exit(0);
}
