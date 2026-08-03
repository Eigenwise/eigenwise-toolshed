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

// src/hooks/guard-oversized-skill.ts
var import_node_fs2 = __toESM(require("node:fs"));
var import_node_path = __toESM(require("node:path"));

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
function writeDeny(hookEventName, permissionDecisionReason) {
  writeJson({
    hookSpecificOutput: {
      hookEventName,
      permissionDecision: "deny",
      permissionDecisionReason
    }
  });
}

// src/hooks/guard-oversized-skill.ts
var MAX_ENTRY_SKILL_BYTES = 256 * 1024;
var SKILL_DIRECTORY_ENV = ["CLAUDE_BUNDLED_SKILLS_DIR", "CLAUDE_CODE_BUNDLED_SKILLS_DIR", "SIDEQUEST_BUNDLED_SKILLS_DIR"];
var SKILL_PATH_FIELDS = ["skill_path", "skillPath", "path"];
function isDispatchedExecutor(input) {
  const agentType = stringField(input, "agent_type", "agentType");
  return /^sidequest-exec-dispatch(?:-readonly)?(?:-(?:low|medium|high|xhigh|max))?$/.test(agentType);
}
function skillName(input) {
  if (!isRecord(input.tool_input)) return null;
  const value = input.tool_input.skill;
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9_-]*$/i.test(value)) return null;
  return value;
}
function configuredSkillDirectory(toolInput, name) {
  for (const field of SKILL_PATH_FIELDS) {
    const value = toolInput[field];
    if (typeof value !== "string") continue;
    const directory = import_node_path.default.resolve(value);
    if (import_node_path.default.basename(directory) === name && import_node_fs2.default.existsSync(directory)) return directory;
  }
  for (const variable of SKILL_DIRECTORY_ENV) {
    const root = process.env[variable];
    if (!root) continue;
    const directory = import_node_path.default.resolve(root, name);
    if (import_node_fs2.default.existsSync(directory)) return directory;
  }
  return null;
}
function entryFileBytes(directory) {
  return import_node_fs2.default.statSync(import_node_path.default.join(directory, "SKILL.md")).size;
}
function main() {
  const input = readStdin();
  if (!input || input.tool_name !== "Skill" || !isDispatchedExecutor(input)) return;
  const name = skillName(input);
  if (!name || !isRecord(input.tool_input)) return;
  const directory = configuredSkillDirectory(input.tool_input, name);
  if (!directory) return;
  const bytes = entryFileBytes(directory);
  if (bytes <= MAX_ENTRY_SKILL_BYTES) return;
  writeDeny("PreToolUse", `sidequest: ${name} exceeds the ${MAX_ENTRY_SKILL_BYTES}-byte executor skill budget. Loading it can overflow this executor's context. Use a targeted Read for the directly needed material.`);
}
try {
  main();
} catch (_) {
  process.exit(0);
}
