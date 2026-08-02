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

// src/hooks/near-turn-cap.ts
var import_node_fs2 = __toESM(require("node:fs"));
var import_node_os = __toESM(require("node:os"));
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
function writeContext(hookEventName, additionalContext) {
  writeJson({ hookSpecificOutput: { hookEventName, additionalContext } });
}

// src/hooks/near-turn-cap.ts
var LIMITS = { low: 50, medium: 100, high: 150, xhigh: 200, max: 250 };
var COUNTER_DIR = import_node_path.default.join(import_node_os.default.tmpdir(), "sidequest-near-turn-cap");
function isEffort(value) {
  return Object.prototype.hasOwnProperty.call(LIMITS, value);
}
function maxTurns(effort) {
  const raw = process.env.SIDEQUEST_EXEC_MAX_TURNS;
  if (raw != null && raw.trim() !== "") {
    const value = Number(raw.trim());
    if (Number.isInteger(value) && value > 0) return value;
  }
  return LIMITS[effort];
}
function effortFor(input, agentType) {
  const explicit = stringField(input, "effort").trim().toLowerCase();
  if (isEffort(explicit)) return explicit;
  const match = agentType.match(/-(low|medium|high|xhigh|max)$/);
  return match && isEffort(match[1] || "") ? match[1] : "medium";
}
var REWARN_EVERY = 4;
var FINAL_BAND_RESERVE = 15;
function main() {
  const input = readStdin();
  if (!input) return;
  const agentType = stringField(input, "agent_type", "agentType");
  const agentId = stringField(input, "agent_id", "agentId");
  if (!agentType.startsWith("sidequest-") || !agentId) return;
  const effort = effortFor(input, agentType);
  const cap = maxTurns(effort);
  const soft = Math.ceil(cap * 0.8);
  const finalBand = Math.max(soft + 1, cap - FINAL_BAND_RESERVE);
  import_node_fs2.default.mkdirSync(COUNTER_DIR, { recursive: true });
  const counterFile = import_node_path.default.join(COUNTER_DIR, encodeURIComponent(agentId));
  let prior = 0;
  let lastFinalWarn = 0;
  try {
    const parts = import_node_fs2.default.readFileSync(counterFile, "utf8").split(/\s+/);
    prior = Number(parts[0]) || 0;
    lastFinalWarn = Number(parts[1]) || 0;
  } catch (_) {
  }
  const count = prior + 1;
  if (count >= finalBand && (lastFinalWarn === 0 || count - lastFinalWarn >= REWARN_EVERY)) {
    import_node_fs2.default.writeFileSync(counterFile, `${count} ${count}`);
    writeContext("PreToolUse", `sidequest: TURN CAP IMMINENT — ${count} tool calls against a ${cap}-turn hard cap. At the cap the harness terminates this executor and uncommitted work is lost with NO report. Stop implementing now: commit verified in-scope work, post a "Continuation checkpoint" comment (commit, files touched, next steps, verify status), then release to todo.`);
    return;
  }
  import_node_fs2.default.writeFileSync(counterFile, `${count} ${lastFinalWarn}`);
  if (prior < soft && count >= soft) {
    writeContext("PreToolUse", `sidequest: this executor has made ${count} tool calls, near its ${cap}-turn backstop. Commit or publish any useful completed increment, then finish or release with findings if the briefing is larger than expected.`);
  }
}
try {
  main();
} catch (_) {
  process.exit(0);
}
