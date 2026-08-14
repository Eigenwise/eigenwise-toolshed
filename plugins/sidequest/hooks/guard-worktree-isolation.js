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

// src/hooks/guard-worktree-isolation.ts
var import_node_fs2 = __toESM(require("node:fs"));
var import_node_path2 = __toESM(require("node:path"));
var import_node_child_process = require("node:child_process");

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
function writeDeny(hookEventName, permissionDecisionReason) {
  writeJson({
    hookSpecificOutput: {
      hookEventName,
      permissionDecision: "deny",
      permissionDecisionReason: projectedText(hookEventName, permissionDecisionReason)
    }
  });
}

// src/hooks/shared/paths.ts
var import_node_path = __toESM(require("node:path"));
function pluginRoot() {
  return process.env.CLAUDE_PLUGIN_ROOT || import_node_path.default.join(__dirname, "..");
}
function runtimeModule(name) {
  return import_node_path.default.join(pluginRoot(), "lib", `${name}.js`);
}

// src/hooks/guard-worktree-isolation.ts
var leaseKernel = require(runtimeModule("kernel/worktree"));
var WRITE_TOOLS = /* @__PURE__ */ new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
function targetPath(input) {
  const toolInput = input.tool_input;
  if (!isRecord(toolInput)) return "";
  const value = toolInput.file_path ?? toolInput.notebook_path ?? toolInput.path;
  const target = value == null ? "" : String(value);
  return target && import_node_path2.default.isAbsolute(target) ? import_node_path2.default.resolve(target) : "";
}
function canonicalPath(value) {
  return leaseKernel.canonicalPath(value);
}
function repoRootFor(target) {
  let directory = import_node_path2.default.dirname(canonicalPath(target));
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
function samePath(a, b) {
  const normalize = (value) => {
    const resolved = canonicalPath(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(a) === normalize(b);
}
function observedWorktreeLease(found, worktree, agentId) {
  const git = (args) => (0, import_node_child_process.execFileSync)("git", args, {
    cwd: worktree,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"]
  }).trim();
  const gitPath = (value) => import_node_path2.default.isAbsolute(value) ? value : import_node_path2.default.resolve(worktree, value);
  const repository = found?.projectPath || worktree;
  return leaseKernel.createWorktreeLease({
    repository,
    gitDirectory: gitPath(git(["rev-parse", "--git-dir"])),
    commonGitDirectory: gitPath(git(["rev-parse", "--git-common-dir"])),
    dispatchRef: found?.ref || null,
    dispatchBaseline: found?.dispatchBaseline || null,
    observedRevision: git(["rev-parse", "--verify", "HEAD^{commit}"]),
    observedWorktree: worktree,
    boundRevision: found?.expectedRevision || null,
    boundWorktree: found?.sharedTree ? found.projectPath : found?.expectedWorktree || null,
    boundGitDirectory: found?.sharedTree ? null : found?.expectedGitDirectory || null,
    boundCommonGitDirectory: found?.sharedTree ? null : found?.expectedCommonGitDirectory || null,
    identity: found?.identityBound ? { status: "bound", agentId } : { status: "unknown" },
    phase: found?.terminal ? "terminal" : found?.phase || "created",
    locked: false,
    liveness: found?.terminal ? { status: "terminal", evidence: "the dispatch is terminal" } : found ? { status: "live", evidence: `dispatch ${found.ref} is active` } : { status: "unknown", evidence: "no dispatch matched this agent" },
    provisioning: "host"
  });
}
function executorAgent(type) {
  if (!type) return false;
  try {
    return require(runtimeModule("exec-names")).classify(type).kind !== "unknown";
  } catch (_) {
    return /^sidequest-exec-/.test(type);
  }
}
function expectation(input, agentId, executor) {
  try {
    const store = require(runtimeModule("store"));
    return store.dispatchIsolationExpectation({
      agentId,
      executor,
      sessionId: stringField(input, "session_id", "sessionId") || process.env.CLAUDE_CODE_SESSION_ID || ""
    });
  } catch (_) {
    return null;
  }
}
function expectedWorktree(found) {
  if (found.sharedTree && found.projectPath) return found.projectPath;
  return found.expectedWorktree || "(immutable worktree binding unavailable)";
}
function boundedText(value, limit) {
  if (Buffer.byteLength(value, "utf8") <= limit) return value;
  const suffix = "…";
  let result = "";
  let bytes = Buffer.byteLength(suffix, "utf8");
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > limit) break;
    result += character;
    bytes += characterBytes;
  }
  return `${result}${suffix}`;
}
function boundedRefusal(summary, facts, recovery) {
  const detailLimit = recovery.startsWith("Use the worktree assigned") ? 140 : 100;
  const factLines = facts.map(([label, value]) => `  ${label}: ${boundedText(value, label === "writing to" ? 60 : detailLimit)}`);
  return [
    `sidequest: refusing this write. ${boundedText(summary, 180)}`,
    ...factLines,
    `Recovery: ${recovery}`
  ].join("\n");
}
function refusal(found, target, repoRoot, cwd) {
  const expected = expectedWorktree(found);
  const sharedCheckout = `${repoRoot}${cwd && !samePath(cwd, repoRoot) ? ` (cwd ${cwd})` : ""}`;
  return boundedRefusal(
    `${found.ref} was dispatched with worktree isolation, but this write lands in the SHARED checkout.`,
    [["expected worktree", expected], ["writing to", target], ["shared checkout", sharedCheckout]],
    `This is a harness worktree-loss failure, not executor behavior. Stop writing, tell the orchestrator "${found.ref} lost its worktree, re-dispatch it", and leave the shared tree untouched. Report any staged work.`
  );
}
function terminalRefusal(found, target) {
  return boundedRefusal(
    `${found.ref} already reached a terminal board state, so this executor has no legal write target.`,
    [["writing to", target]],
    "Do not work around this or re-arm any Monitor. Stop owned background tasks and end this executor. Redispatch the ticket if more work is needed."
  );
}
function unknownRefusal(target) {
  return boundedRefusal(
    "This executor has no active dispatch record for a shared-checkout write.",
    [["writing to", target]],
    "Do not work around this. Stop any owned background tasks and end the executor. Redispatch before making more changes."
  );
}
function leaseRefusal(found, target, reason) {
  return boundedRefusal(
    `${found?.ref || "This executor"} has no write lease for the observed worktree.`,
    [["writing to", target], ["lease decision", reason]],
    "Do not work around this. Stop writing and ask the orchestrator to redispatch the ticket."
  );
}
function linkedWorktreeLeaseRefusal(found, target, actualRoot, reason) {
  return boundedRefusal(
    `${found.ref} has no write lease for this linked worktree.`,
    [["expected worktree", found.expectedWorktree || "(unavailable)"], ["actual worktree", actualRoot], ["writing to", target], ["lease decision", reason]],
    "Use the worktree assigned to this executor. If it no longer exists, stop and ask the orchestrator to redispatch the ticket."
  );
}
function main() {
  const input = readStdin();
  if (!input || !WRITE_TOOLS.has(stringField(input, "tool_name"))) return;
  const agentId = stringField(input, "agent_id", "agentId");
  const executor = stringField(input, "agent_type", "agentType", "subagent_type");
  if (!agentId || !executorAgent(executor)) return;
  const target = targetPath(input);
  if (!target) return;
  const found = expectation(input, agentId, executor);
  if (found?.terminal) {
    writeDeny("PreToolUse", terminalRefusal(found, target));
    return;
  }
  const repo = repoRootFor(target);
  if (!repo) return;
  if (!found) {
    try {
      const decision = leaseKernel.worktreeWriteDecision(observedWorktreeLease(null, repo.root, agentId), target);
      if (!decision.allowed) writeDeny("PreToolUse", unknownRefusal(target));
    } catch (_) {
      writeDeny("PreToolUse", unknownRefusal(target));
    }
    return;
  }
  try {
    const decision = leaseKernel.worktreeWriteDecision(observedWorktreeLease(found, repo.root, agentId), target);
    if (!decision.allowed) {
      const message = !found.sharedTree && repo.linked ? linkedWorktreeLeaseRefusal(found, target, repo.root, decision.reason) : !found.sharedTree ? refusal(found, target, repo.root, stringField(input, "cwd")) : leaseRefusal(found, target, decision.reason);
      writeDeny("PreToolUse", message);
    }
  } catch (_) {
    writeDeny("PreToolUse", leaseRefusal(found, target, "the observed Git facts could not hydrate a lease."));
  }
}
try {
  main();
} catch (_) {
  process.exit(0);
}
