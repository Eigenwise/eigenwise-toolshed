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
var import_node_path5 = __toESM(require("node:path"));

// src/lib/exec-names.ts
var EFFORTS = Object.freeze(["low", "medium", "high", "xhigh", "max"]);
var CLAUDE_PREFIX = "sidequest-exec-";
var EVIDENCE_CLAUDE_PREFIX = "sidequest-exec-evidence-";
var EVIDENCE_DISPATCH_NAME = "sidequest-exec-dispatch-evidence";
var READ_ONLY_CLAUDE_PREFIX = "sidequest-exec-readonly-";
var DIAGNOSTIC_PROBE_NAME = "sidequest-diagnostic-probe";
var DISPATCH_NAME = "sidequest-exec-dispatch";
var READ_ONLY_DISPATCH_NAME = "sidequest-exec-dispatch-readonly";
function stableClaudeName(effort) {
  return `${CLAUDE_PREFIX}${effort}`;
}
function stableEvidenceClaudeName(effort) {
  return `${EVIDENCE_CLAUDE_PREFIX}${effort}`;
}
function isEvidenceExecutor(value) {
  if (typeof value !== "string") return false;
  const name = canonicalExecutorName(value);
  return name === EVIDENCE_DISPATCH_NAME || EFFORTS.some((effort) => name === stableEvidenceClaudeName(effort));
}
function stableReadOnlyClaudeName(effort) {
  return `${READ_ONLY_CLAUDE_PREFIX}${effort}`;
}
var BUNDLED_AGENT_NAMES = /* @__PURE__ */ new Set([
  DISPATCH_NAME,
  READ_ONLY_DISPATCH_NAME,
  EVIDENCE_DISPATCH_NAME,
  ...EFFORTS.map(stableEvidenceClaudeName),
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

// src/lib/evidence-writes.ts
var import_node_path2 = __toESM(require("node:path"));

// src/lib/kernel/worktree.ts
var import_node_fs = __toESM(require("node:fs"));
var import_node_path = __toESM(require("node:path"));
var import_node_crypto = __toESM(require("node:crypto"));
function platformPath(value) {
  return process.platform === "win32" ? value.toLowerCase() : value;
}
function canonicalPath(value) {
  const gitBashDrive = process.platform === "win32" ? /^\/([a-zA-Z])(?=\/|$)/.exec(value) : null;
  const resolved = import_node_path.default.resolve(gitBashDrive ? `${gitBashDrive[1]}:${value.slice(2)}` : value);
  const missing = [];
  let existing = resolved;
  while (!import_node_fs.default.existsSync(existing)) {
    const parent = import_node_path.default.dirname(existing);
    if (parent === existing) return platformPath(resolved);
    missing.unshift(import_node_path.default.basename(existing));
    existing = parent;
  }
  try {
    return platformPath(import_node_path.default.join(import_node_fs.default.realpathSync.native(existing), ...missing));
  } catch {
    return platformPath(resolved);
  }
}

// src/hooks/shared/shell-writes.ts
var SHELL_TOKEN_RE = /(@"\r?\n[\s\S]*?\r?\n"@|@'\r?\n[\s\S]*?\r?\n'@|"(?:[^"\\`]|[\\`][\s\S]|"")*"|'(?:[^']|'')*')|((?:\d|&)?>>?(?:&\d?)?|&&|\|\||[|;\n])|([^\s|;&<>"']+)|(<<<|<<-?)[ \t]*("[^"\r\n]*"|'[^'\r\n]*'|[^\s|;&<>"']+)?/g;
function unquote(word) {
  return word.replace(/^(["'])([\s\S]*)\1$/, "$2");
}
function heredocEnd(command, start, heredoc) {
  const terminator = heredoc.terminator.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const indentation = heredoc.stripTabs ? "\\t*" : "";
  const ending = new RegExp(`^${indentation}${terminator}\\r?(?:\\n|$)`, "m");
  const match = ending.exec(command.slice(start));
  return match ? start + match.index + match[0].length : command.length;
}
function recordHeredoc(match, heredocs) {
  if (match[4] === "<<<" || match[5] === void 0) return;
  heredocs.push({ terminator: unquote(match[5]), stripTabs: match[4] === "<<-" });
}
var SEGMENT_OPERATORS = /* @__PURE__ */ new Set(["&&", "||", "|", ";", "\n"]);
var NULL_SINKS = /* @__PURE__ */ new Set(["/dev/null", "nul", "$null"]);
var MUTATING_GIT = /* @__PURE__ */ new Set([
  "add",
  "am",
  "apply",
  "checkout",
  "cherry-pick",
  "clean",
  "commit",
  "merge",
  "mv",
  "pull",
  "push",
  "rebase",
  "reset",
  "restore",
  "revert",
  "rm",
  "stash",
  "switch"
]);
function operands(words) {
  return words.slice(1).filter((word) => !word.startsWith("-"));
}
function gitWriteTargets(words) {
  const flagIndex = words.indexOf("-C");
  const directory = flagIndex > 0 ? words[flagIndex + 1] : ".";
  const subcommand = operands(words).find((word) => word !== directory);
  return MUTATING_GIT.has(String(subcommand)) ? [directory || "."] : [];
}
var SED_SCRIPT_FLAGS = /* @__PURE__ */ new Set(["-e", "--expression", "-f", "--file"]);
function inPlaceEditTargets(words) {
  if (!words.some((word) => /^-[a-z]*i/i.test(word))) return [];
  const fileOperands = words.slice(1).filter((word, index, rest) => word && !word.startsWith("-") && !SED_SCRIPT_FLAGS.has(rest[index - 1] ?? ""));
  return words.some((word) => SED_SCRIPT_FLAGS.has(word)) ? fileOperands : fileOperands.slice(1);
}
function contentCmdletTargets(words) {
  const pathFlag = words.findIndex((word) => /^-(path|literalpath|filepath)$/i.test(word));
  if (pathFlag > 0) return words.slice(pathFlag + 1, pathFlag + 2);
  return words.slice(1).filter((word, index) => !word.startsWith("-") && !/^-(value|encoding|itemtype|width|name)$/i.test(words[index])).slice(0, 1);
}
var WRITE_TARGET_READERS = new Map([
  ...[
    "rm",
    "rmdir",
    "mv",
    "touch",
    "mkdir",
    "tee",
    "truncate",
    "chmod",
    "chown",
    "unlink",
    "remove-item",
    "move-item",
    "rename-item",
    "clear-content",
    "ri",
    "del",
    "erase",
    "rd",
    "md",
    "move",
    "ren"
  ].map((name) => [name, operands]),
  ...["set-content", "add-content", "out-file", "new-item", "ni"].map((name) => [name, contentCmdletTargets]),
  ...["cp", "copy", "copy-item", "ln", "install", "rsync"].map((name) => [name, (words) => operands(words).slice(-1)]),
  ["sed", inPlaceEditTargets],
  ["perl", inPlaceEditTargets],
  ["git", gitWriteTargets]
]);
function commandName(words) {
  return (words[0] || "").split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, "");
}
function isGitMutation(words) {
  return commandName(words) === "git" && gitWriteTargets(words).length > 0;
}
function commandWriteTargets(words) {
  const reader = WRITE_TARGET_READERS.get(commandName(words));
  return reader ? reader(words) : [];
}
function shellToken(match) {
  return match[2] ? { operator: match[2] } : { word: unquote(match[1] || match[3]) };
}
function shellTokens(command) {
  const lexer = new RegExp(SHELL_TOKEN_RE);
  const tokens = [];
  const heredocs = [];
  let match;
  while ((match = lexer.exec(command)) !== null) {
    if (match[4]) {
      recordHeredoc(match, heredocs);
      continue;
    }
    tokens.push(shellToken(match));
    if (match[2] === "\n") {
      lexer.lastIndex = heredocs.reduce((start, heredoc) => heredocEnd(command, start, heredoc), lexer.lastIndex);
      heredocs.length = 0;
    }
  }
  return tokens;
}
function shellSegments(command) {
  const segments = [{ words: [], redirects: [] }];
  let pendingRedirect = false;
  for (const token of shellTokens(command)) {
    const segment = segments[segments.length - 1];
    if ("word" in token) {
      (pendingRedirect ? segment.redirects : segment.words).push(token.word);
      pendingRedirect = false;
    } else if (SEGMENT_OPERATORS.has(token.operator)) {
      segments.push({ words: [], redirects: [] });
    } else {
      pendingRedirect = !token.operator.includes("&", 1);
    }
  }
  return segments;
}
function ignoredTarget(word) {
  return !word || word.startsWith("$") || NULL_SINKS.has(word.toLowerCase());
}

// src/lib/evidence-writes.ts
function within(root, target) {
  const relative = import_node_path2.default.relative(canonicalPath(root), canonicalPath(target));
  return relative !== ".." && !relative.startsWith(`..${import_node_path2.default.sep}`) && !import_node_path2.default.isAbsolute(relative);
}
function protectedRoots(scope) {
  return [scope.evidenceRepositoryRoot, scope.worktree].filter((root) => Boolean(root));
}
function evidencePathAllowed(target, scope) {
  if (!scope.evidenceMode || !import_node_path2.default.isAbsolute(target)) return false;
  if (protectedRoots(scope).some((root) => within(root, target))) return false;
  return (scope.evidenceWriteRoots ?? []).some((root) => within(root, target));
}
function refusal(scope) {
  return `sidequest: evidence executor may write only under admitted roots: ${(scope.evidenceWriteRoots ?? []).join(", ") || "(no live evidence scope)"}. Repository paths remain forbidden. Close through done, without commit or submit.`;
}
function nativeTarget(base, target) {
  const native = process.platform === "win32" ? target.replace(/^\/([a-z])(\/|$)/i, "$1:/") : target;
  return import_node_path2.default.resolve(base, native);
}
function segmentTargets(segment, base) {
  return [...segment.redirects, ...commandWriteTargets(segment.words)].filter((target) => !ignoredTarget(target)).map((target) => nativeTarget(base, target));
}
function changedDirectory(segment, base) {
  return segment.words[0] === "cd" && segment.words[1] ? nativeTarget(base, segment.words[1]) : base;
}
function segmentForbidden(segment, base, scope) {
  return isGitMutation(segment.words) || segmentTargets(segment, base).some((target) => !evidencePathAllowed(target, scope));
}
function shellDenial(command, cwd, scope) {
  let base = cwd;
  for (const segment of shellSegments(command)) {
    base = changedDirectory(segment, base);
    if (segmentForbidden(segment, base, scope)) return refusal(scope);
  }
  return null;
}
function fileDenial(input, _cwd, scope) {
  return evidencePathAllowed(String(input.file_path ?? input.path ?? ""), scope) ? null : refusal(scope);
}
var TOOL_GUARDS = {
  Bash: (input, cwd, scope) => shellDenial(String(input.command ?? ""), cwd, scope),
  PowerShell: (input, cwd, scope) => shellDenial(String(input.command ?? ""), cwd, scope),
  Write: fileDenial,
  Edit: fileDenial,
  MultiEdit: fileDenial,
  NotebookEdit: (_input, _cwd, scope) => refusal(scope),
  Agent: (_input, _cwd, scope) => refusal(scope),
  mcp__plugin_sidequest_board__commit: (_input, _cwd, scope) => refusal(scope),
  mcp__plugin_sidequest_board__submit: (_input, _cwd, scope) => refusal(scope),
  mcp__plugin_sidequest_board__integrate: (_input, _cwd, scope) => refusal(scope)
};
function evidenceToolDenial(tool, input, cwd, scope) {
  return TOOL_GUARDS[tool]?.(input, cwd, scope) ?? null;
}

// src/hooks/guard-worktree-isolation.ts
var import_node_child_process = require("node:child_process");

// src/hooks/shared/input.ts
var import_node_fs2 = __toESM(require("node:fs"));
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
var import_node_path3 = __toESM(require("node:path"));
function pluginRoot() {
  return process.env.CLAUDE_PLUGIN_ROOT || import_node_path3.default.join(__dirname, "..");
}
function runtimeModule(name) {
  return import_node_path3.default.join(pluginRoot(), "lib", `${name}.js`);
}

// src/hooks/shared/runtime-identity.ts
var import_node_fs3 = __toESM(require("node:fs"));
var import_node_path4 = __toESM(require("node:path"));
function canonicalPath2(value) {
  const kernel = require(runtimeModule("kernel/worktree"));
  return kernel.canonicalPath(value);
}
function boardVerificationEvidencePath(target, evidenceDirectory) {
  try {
    const store = require(runtimeModule("store"));
    return store.boardVerificationEvidencePath(target, evidenceDirectory);
  } catch (_) {
    return false;
  }
}
function dispatchEvidenceDirectory(found) {
  try {
    const store = require(runtimeModule("store"));
    return store.dispatchEvidenceDirectory(found.project, found.ref);
  } catch (_) {
    return null;
  }
}
function dispatchEvidenceScope(input) {
  const found = isolationExpectation(input, stringField(input, "agent_id", "agentId"), stringField(input, "agent_type", "agentType"), true, stringField(input, "cwd"));
  if (!found?.claimHeld || found.terminal) return null;
  const store = require(runtimeModule("store"));
  try {
    return store.getTicket(found.project, found.ref)?.dispatch ?? null;
  } catch {
    return null;
  }
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
  let directory = canonicalPath2(start);
  for (; ; ) {
    const gitEntry = import_node_path4.default.join(directory, ".git");
    let stats = null;
    try {
      stats = import_node_fs3.default.statSync(gitEntry);
    } catch (_) {
      stats = null;
    }
    if (stats) return { root: directory, linked: stats.isFile() };
    const parent = import_node_path4.default.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}
function isolationExpectation(input, agentId, executor, includeSessionFallback = true, observedWorktree = "") {
  try {
    const store = require(runtimeModule("store"));
    const found = store.dispatchIsolationExpectation({ agentId, executor, sessionId: hookSessionId(input), observedWorktree });
    return agentId && !includeSessionFallback && found?.matchedBy === "session" ? null : found;
  } catch (_) {
    return null;
  }
}
function identityDiagnosis(input, agentId, executor, observedWorktree) {
  try {
    const store = require(runtimeModule("store"));
    return store.dispatchIdentityDiagnosis({ agentId, executor, sessionId: hookSessionId(input), observedWorktree });
  } catch (_) {
    return null;
  }
}
function unboundClaim(input, executor, observedWorktree) {
  try {
    const store = require(runtimeModule("store"));
    return store.dispatchUnboundClaim({
      executor,
      sessionId: hookSessionId(input),
      observedWorktree,
      agentName: stringField(input, "agent_name", "agentName", "name")
    });
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

// src/hooks/guard-worktree-isolation.ts
var leaseKernel = require(runtimeModule("kernel/worktree"));
var WRITE_TOOLS = /* @__PURE__ */ new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
function targetPath(input) {
  const toolInput = input.tool_input;
  if (!isRecord(toolInput)) return "";
  const value = toolInput.file_path ?? toolInput.notebook_path ?? toolInput.path;
  const target = value == null ? "" : String(value);
  return target && import_node_path5.default.isAbsolute(target) ? import_node_path5.default.resolve(target) : "";
}
function samePath(a, b) {
  const normalize = (value) => {
    const resolved = canonicalPath2(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(a) === normalize(b);
}
function registeredProjectCheckout(root) {
  try {
    const store = require(runtimeModule("store"));
    return Boolean(store.findProject(root)?.ok);
  } catch (_) {
    return false;
  }
}
function observedWorktreeLease(found, worktree, agentId) {
  const git = (args) => (0, import_node_child_process.execFileSync)("git", args, {
    cwd: worktree,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"]
  }).trim();
  const gitPath = (value) => import_node_path5.default.isAbsolute(value) ? value : import_node_path5.default.resolve(worktree, value);
  const baselineAncestry = (baseline) => {
    if (!baseline) return "unknown";
    try {
      git(["merge-base", "--is-ancestor", baseline, "HEAD"]);
      return "ancestor";
    } catch (error) {
      return error.status === 1 ? "unrelated" : "unknown";
    }
  };
  const repository = found?.projectPath || worktree;
  return leaseKernel.createWorktreeLease({
    repository,
    gitDirectory: gitPath(git(["rev-parse", "--git-dir"])),
    commonGitDirectory: gitPath(git(["rev-parse", "--git-common-dir"])),
    dispatchRef: found?.ref || null,
    dispatchBaseline: found?.dispatchBaseline || null,
    sanctionedRevisions: found?.sanctionedRevisions || [],
    baselineAncestry: baselineAncestry(found?.dispatchBaseline || null),
    claimHeld: Boolean(found?.claimHeld),
    observedRevision: git(["rev-parse", "--verify", "HEAD^{commit}"]),
    observedWorktree: worktree,
    boundRevision: found?.expectedRevision || null,
    boundWorktree: found?.sharedTree ? found.projectPath : found?.expectedWorktree || null,
    boundGitDirectory: found?.sharedTree ? null : found?.expectedGitDirectory || null,
    boundCommonGitDirectory: found?.sharedTree ? null : found?.expectedCommonGitDirectory || null,
    boundCheckoutInstance: found?.sharedTree ? null : found?.expectedCheckoutInstance || null,
    identity: found?.identityBound ? { status: "bound", agentId } : { status: "unknown" },
    phase: found?.terminal ? "terminal" : found?.phase || "created",
    locked: false,
    liveness: found?.terminal ? { status: "terminal", evidence: "the dispatch is terminal" } : found ? { status: "live", evidence: `dispatch ${found.ref} is active` } : { status: "unknown", evidence: "no dispatch matched this agent" },
    provisioning: "host"
  });
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
var REFUSAL_FACT_LIMITS = { "writing to": 60, "lease decision": 240 };
var DEFAULT_REFUSAL_FACT_LIMIT = 140;
function boundedRefusal(summary, facts, recovery) {
  const factLines = facts.map(([label, value]) => `  ${label}: ${boundedText(value, REFUSAL_FACT_LIMITS[label] ?? DEFAULT_REFUSAL_FACT_LIMIT)}`);
  return [
    `sidequest: refusing this write. ${boundedText(summary, 180)}`,
    ...factLines,
    `Recovery: ${recovery}`
  ].join("\n");
}
function refusal2(found, target, repoRoot, cwd) {
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
function unmatchedWorktreeSummary(diagnosis) {
  if (diagnosis && diagnosis.live > 0 && diagnosis.session === 0) {
    return "No live dispatch record carries this session id. The dispatch was likely recorded under an older one (a board server started before /clear), not an executor fault.";
  }
  return "This isolated worktree matches no dispatch record, so it holds no write authority here.";
}
function unknownRefusalSummary(repo, diagnosis, unboundRef) {
  if (unboundRef) return `this executor's claim on ${unboundRef} is not bound to an agent id.`;
  if (!repo.linked) return "This executor has no active dispatch record for a shared-checkout write.";
  return unmatchedWorktreeSummary(diagnosis);
}
function unknownRefusal(target, repo, diagnosis, unboundRef = null) {
  const matches = diagnosis ? `live ${diagnosis.live}, session ${diagnosis.session}, session+executor ${diagnosis.sessionExecutor}, agent id ${diagnosis.agent}, worktree ${diagnosis.worktree}` : "(unavailable)";
  const recovery = unboundRef ? "Claim through the Sidequest MCP hook so it can attach this runtime agent id. Redispatch alone does not bind this claim; stop and report this refusal." : 'Do not work around this. If this is the same live claim after an API resume, call mcp__plugin_sidequest_board__dispatch({ ref: "<ref>", recoveryEvidence: "<observed refusal>", claimHolder: "<your by>", worktree: "<linked checkout>" }) before writing. It verifies the stored executor, re-mints the token, and re-binds this worktree without releasing. Otherwise stop owned background tasks, report these dispatch-record counts, and redispatch before making more changes.';
  return boundedRefusal(
    unknownRefusalSummary(repo, diagnosis, unboundRef),
    [["writing to", target], [repo.linked ? "isolated worktree" : "shared checkout", repo.root], ["dispatch records", matches]],
    recovery
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
  const expected = found.expectedWorktree || "(unavailable)";
  const worktreeFacts = found.expectedWorktree && samePath(expected, actualRoot) ? [["worktree", actualRoot]] : [["expected worktree", expected], ["actual worktree", actualRoot]];
  return boundedRefusal(
    `${found.ref} has no write lease for this linked worktree.`,
    [...worktreeFacts, ["writing to", target], ["lease decision", reason]],
    "Use the worktree assigned to this executor. If it no longer exists, stop and ask the orchestrator to redispatch the ticket."
  );
}
function protectedTargetPath(input, executor) {
  if (!isEvidenceExecutor(executor)) return targetPath(input);
  const argumentsInput = isRecord(input.tool_input) ? input.tool_input : {};
  const denial = evidenceToolDenial(stringField(input, "tool_name"), argumentsInput, stringField(input, "cwd"), dispatchEvidenceScope(input) || {});
  if (denial) writeDeny("PreToolUse", denial);
  return "";
}
function main() {
  const input = readStdin();
  if (!input || !WRITE_TOOLS.has(stringField(input, "tool_name"))) return;
  const agentId = stringField(input, "agent_id", "agentId");
  const executor = stringField(input, "agent_type", "agentType", "subagent_type");
  if (!agentId || !executorAgent(executor)) return;
  const target = protectedTargetPath(input, executor);
  if (!target) return;
  const repo = enclosingCheckout(import_node_path5.default.dirname(canonicalPath2(target)));
  if (!repo) return;
  let found = isolationExpectation(input, agentId, executor, true, repo.root);
  if (!found?.terminal && !found?.identityBound && (repo.linked || !found && registeredProjectCheckout(repo.root))) {
    bindObservedRuntimeIdentity(input, agentId, executor, repo.root);
    found = isolationExpectation(input, agentId, executor, true, repo.root);
  }
  if (boardVerificationEvidencePath(target, dispatchEvidenceDirectory(found))) return;
  if (found?.terminal) {
    writeDeny("PreToolUse", terminalRefusal(found, target));
    return;
  }
  if (!found) {
    try {
      const decision = leaseKernel.worktreeWriteDecision(observedWorktreeLease(null, repo.root, agentId), target);
      if (!decision.allowed) {
        const diagnosis = identityDiagnosis(input, agentId, executor, repo.root);
        const unbound = unboundClaim(input, executor, repo.root);
        writeDeny("PreToolUse", unknownRefusal(target, repo, diagnosis, unbound?.ref || null));
      }
    } catch (_) {
      const diagnosis = identityDiagnosis(input, agentId, executor, repo.root);
      const unbound = unboundClaim(input, executor, repo.root);
      writeDeny("PreToolUse", unknownRefusal(target, repo, diagnosis, unbound?.ref || null));
    }
    return;
  }
  try {
    const decision = leaseKernel.worktreeWriteDecision(observedWorktreeLease(found, repo.root, agentId), target);
    if (!decision.allowed) {
      const message = !found.sharedTree && repo.linked ? linkedWorktreeLeaseRefusal(found, target, repo.root, decision.reason) : !found.sharedTree ? refusal2(found, target, repo.root, stringField(input, "cwd")) : leaseRefusal(found, target, decision.reason);
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
