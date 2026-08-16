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

// src/hooks/shared/runtime-identity.ts
var import_node_fs2 = __toESM(require("node:fs"));
var import_node_path2 = __toESM(require("node:path"));

// src/hooks/shared/paths.ts
var import_node_path = __toESM(require("node:path"));
function pluginRoot() {
  return process.env.CLAUDE_PLUGIN_ROOT || import_node_path.default.join(__dirname, "..");
}
function runtimeModule(name) {
  return import_node_path.default.join(pluginRoot(), "lib", `${name}.js`);
}

// src/hooks/shared/runtime-identity.ts
function canonicalPath(value) {
  const kernel = require(runtimeModule("kernel/worktree"));
  return kernel.canonicalPath(value);
}
function executorAgent(type) {
  if (!type) return false;
  try {
    return require(runtimeModule("exec-names")).classify(type).kind !== "unknown";
  } catch (_) {
    return /^sidequest-exec-/.test(type);
  }
}
function hookSessionId(input) {
  return stringField(input, "session_id", "sessionId") || process.env.CLAUDE_CODE_SESSION_ID || "";
}
function enclosingCheckout(start) {
  let directory = canonicalPath(start);
  for (; ; ) {
    const gitEntry = import_node_path2.default.join(directory, ".git");
    let stats = null;
    try {
      stats = import_node_fs2.default.statSync(gitEntry);
    } catch (_) {
      stats = null;
    }
    if (stats) return { root: directory, linked: stats.isFile() };
    const parent = import_node_path2.default.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}
function isolationExpectation(input, agentId, executor) {
  try {
    const store = require(runtimeModule("store"));
    return store.dispatchIsolationExpectation({ agentId, executor, sessionId: hookSessionId(input) });
  } catch (_) {
    return null;
  }
}
function bindObservedRuntimeIdentity(input, agentId, executor, worktree) {
  try {
    const store = require(runtimeModule("store"));
    const sessionId = hookSessionId(input);
    if (!sessionId) return;
    store.bindDispatchAgent(
      sessionId,
      executor,
      agentId,
      stringField(input, "agent_name", "agentName", "name") || null,
      worktree
    );
  } catch (_) {
  }
}

// src/hooks/bind-runtime-identity.ts
function main() {
  const input = readStdin();
  if (!input) return;
  const agentId = stringField(input, "agent_id", "agentId");
  const executor = stringField(input, "agent_type", "agentType", "subagent_type");
  if (!agentId || !executorAgent(executor)) return;
  const cwd = stringField(input, "cwd");
  if (!cwd) return;
  const checkout = enclosingCheckout(cwd);
  if (!checkout?.linked) return;
  const found = isolationExpectation(input, agentId, executor);
  if (found?.terminal || found?.identityBound) return;
  bindObservedRuntimeIdentity(input, agentId, executor, checkout.root);
}
try {
  main();
} catch (_) {
  process.exit(0);
}
