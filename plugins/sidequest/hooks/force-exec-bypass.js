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

// src/lib/git-process.ts
var import_node_child_process = __toESM(require("node:child_process"));
var import_node_util = require("node:util");
var GIT_OUTPUT_MAX_BUFFER = 256 * 1024 * 1024;
var execFileCallback = (0, import_node_util.promisify)(import_node_child_process.default.execFile);
function execFileSync(file, args, options = {}) {
  return import_node_child_process.default.execFileSync(file, args, { maxBuffer: GIT_OUTPUT_MAX_BUFFER, windowsHide: true, ...options });
}

// src/hooks/force-exec-bypass.ts
var import_node_fs8 = __toESM(require("node:fs"));
var import_node_os5 = __toESM(require("node:os"));
var import_node_path8 = __toESM(require("node:path"));

// src/hooks/shared/input.ts
var import_node_fs = __toESM(require("node:fs"));

// src/lib/exec-names.ts
var EFFORTS = Object.freeze(["low", "medium", "high", "xhigh", "max"]);
var CLAUDE_PREFIX = "sidequest-exec-";
var DISPATCH_PREFIX = "sidequest-exec-dispatch-";
var READ_ONLY_CLAUDE_PREFIX = "sidequest-exec-readonly-";
var READ_ONLY_DISPATCH_PREFIX = "sidequest-exec-dispatch-readonly-";
var DISCOVERED_MODEL_PREFIX = "sidequest-exec-model-";
var READ_ONLY_DISCOVERED_MODEL_PREFIX = "sidequest-exec-readonly-model-";
var TICKET_PREFIX = "sidequest-sq-";
var LEGACY_TICKET_PREFIX = "sidequest-ticket-";
var DIAGNOSTIC_PROBE_NAME = "sidequest-diagnostic-probe";
function isEffort(value) {
  return typeof value === "string" && EFFORTS.includes(value);
}
var AGENT_NAME_MAX_LENGTH = 64;
var LAUNCH_SLUG_MAX_WORDS = 3;
var LAUNCH_SLUG_MAX_LENGTH = 24;
var ROUTE_MODEL_TOKEN_MAX_LENGTH = 24;
var LAUNCH_SLUG_FILLER = /* @__PURE__ */ new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "from",
  "in",
  "into",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "over",
  "per",
  "that",
  "the",
  "their",
  "then",
  "this",
  "to",
  "under",
  "via",
  "when",
  "while",
  "with",
  "without"
]);
function slugTokens(value) {
  return String(value == null ? "" : value).normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
}
function refSlug(ref) {
  return slugTokens(ref).join("-");
}
function titleSlug(title) {
  const tokens = slugTokens(title);
  const meaningful = tokens.filter((token) => !LAUNCH_SLUG_FILLER.has(token));
  const chosen = (meaningful.length ? meaningful : tokens).slice(0, LAUNCH_SLUG_MAX_WORDS);
  let slug = "";
  for (const token of chosen) {
    const next = slug ? `${slug}-${token}` : token;
    if (next.length > LAUNCH_SLUG_MAX_LENGTH) break;
    slug = next;
  }
  if (!slug && chosen.length) slug = String(chosen[0]).slice(0, LAUNCH_SLUG_MAX_LENGTH);
  return slug;
}
function routeModelToken(resolvedExec) {
  if (!resolvedExec || typeof resolvedExec !== "object") return "";
  const exec = resolvedExec;
  const isClaude = exec.backend === "claude";
  const value = isClaude ? String(exec.runsModel || exec.dispatchModel || "") : String(exec.runsLabel || exec.dispatchModel || exec.runsModel || "");
  const tokens = slugTokens(value).filter((token2) => !isClaude || token2 !== "claude");
  const token = isClaude ? tokens.join("-") : tokens.at(-1) || "";
  return token.slice(0, ROUTE_MODEL_TOKEN_MAX_LENGTH);
}
function dispatchLaunchName(ref, title, resolvedExec, effort, sequence) {
  const base = refSlug(ref) || "sidequest";
  const model = routeModelToken(resolvedExec);
  const routeEffort = isEffort(effort) ? effort : "";
  const route = [model, routeEffort].filter(Boolean);
  const seq = Number(sequence);
  const suffix = Number.isInteger(seq) && seq > 1 ? `-${seq}` : "";
  const fixedName = [base, ...route].join("-") + suffix;
  const availableTitleLength = AGENT_NAME_MAX_LENGTH - fixedName.length - 1;
  const slug = titleSlug(title).slice(0, Math.max(availableTitleLength, 0)).replace(/-+$/, "");
  return slug ? [base, slug, ...route].join("-") + suffix : fixedName;
}
var DISPATCH_NAME = "sidequest-exec-dispatch";
var READ_ONLY_DISPATCH_NAME = "sidequest-exec-dispatch-readonly";
function stableClaudeName(effort) {
  return `${CLAUDE_PREFIX}${effort}`;
}
function stableReadOnlyClaudeName(effort) {
  return `${READ_ONLY_CLAUDE_PREFIX}${effort}`;
}
var DISCOVERED_MODEL_SUFFIX_RE = /^[a-z0-9][a-z0-9-]*-(low|medium|high|xhigh|max)$/;
function discoveredModelEffort(name, prefix) {
  const effort = DISCOVERED_MODEL_SUFFIX_RE.exec(name.slice(prefix.length))?.[1];
  return name.startsWith(prefix) && isEffort(effort) ? effort : null;
}
function classifyDiscoveredModel(name) {
  const readOnlyEffort = discoveredModelEffort(name, READ_ONLY_DISCOVERED_MODEL_PREFIX);
  if (readOnlyEffort) return { kind: "read_only_discovered_model", effort: readOnlyEffort };
  const effort = discoveredModelEffort(name, DISCOVERED_MODEL_PREFIX);
  return effort ? { kind: "discovered_model", effort } : null;
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
function isReadOnlyExecutor(name) {
  const kind = classify(name).kind;
  return kind === "read_only_codex_dispatch" || kind === "read_only_claude_builtin" || kind === "read_only_discovered_model";
}
function classify(value) {
  if (typeof value !== "string" || !value) return { kind: "unknown", effort: null };
  const name = canonicalExecutorName(value);
  if (name === READ_ONLY_DISPATCH_NAME) return { kind: "read_only_codex_dispatch", effort: null };
  if (name === DISPATCH_NAME) return { kind: "codex_dispatch", effort: null };
  if (name === DIAGNOSTIC_PROBE_NAME) return { kind: "unknown", effort: null };
  const discoveredModel = classifyDiscoveredModel(name);
  if (discoveredModel) return discoveredModel;
  if (name.startsWith(READ_ONLY_DISPATCH_PREFIX)) {
    const effort = name.slice(READ_ONLY_DISPATCH_PREFIX.length);
    if (isEffort(effort)) return { kind: "read_only_codex_dispatch", effort };
    return { kind: "ticket", effort: null };
  }
  if (name.startsWith(READ_ONLY_CLAUDE_PREFIX)) {
    const effort = name.slice(READ_ONLY_CLAUDE_PREFIX.length);
    if (isEffort(effort)) return { kind: "read_only_claude_builtin", effort };
    return { kind: "ticket", effort: null };
  }
  if (name.startsWith(DISPATCH_PREFIX)) {
    const effort = name.slice(DISPATCH_PREFIX.length);
    if (isEffort(effort)) return { kind: "codex_dispatch", effort };
    return { kind: "ticket", effort: null };
  }
  if (name.startsWith(CLAUDE_PREFIX)) {
    const effort = name.slice(CLAUDE_PREFIX.length);
    if (isEffort(effort)) return { kind: "claude_builtin", effort };
    return { kind: "ticket", effort: null };
  }
  if (name.startsWith(TICKET_PREFIX)) return { kind: "ticket", effort: null };
  if (name.startsWith(LEGACY_TICKET_PREFIX)) return { kind: "legacy_ticket", effort: null };
  return { kind: "unknown", effort: null };
}

// src/hooks/shared/input.ts
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function readStdin() {
  try {
    const raw = import_node_fs.default.readFileSync(0, "utf8");
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
function writeContext(hookEventName, additionalContext, initialUserMessage = "") {
  writeJson({
    hookSpecificOutput: {
      hookEventName,
      additionalContext: projectedText(hookEventName, additionalContext),
      ...initialUserMessage ? { initialUserMessage } : {}
    }
  });
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
function writeToolUpdate(updatedInput, systemMessage) {
  const context = systemMessage ? projectedText("PreToolUse", systemMessage) : "";
  writeJson({
    ...context ? { systemMessage: context } : {},
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      updatedInput,
      ...context ? { additionalContext: context } : {}
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

// src/hooks/shared/read-only-shell.ts
var import_node_fs4 = __toESM(require("node:fs"));
var import_node_os2 = __toESM(require("node:os"));
var import_node_path4 = __toESM(require("node:path"));

// src/hooks/shared/runtime-identity.ts
var import_node_fs3 = __toESM(require("node:fs"));
var import_node_path3 = __toESM(require("node:path"));
function canonicalPath(value) {
  const kernel = require(runtimeModule("kernel/worktree"));
  return kernel.canonicalPath(value);
}
function enclosingCheckout(start) {
  let directory = canonicalPath(start);
  for (; ; ) {
    const gitEntry = import_node_path3.default.join(directory, ".git");
    let stats = null;
    try {
      stats = import_node_fs3.default.statSync(gitEntry);
    } catch (_) {
      stats = null;
    }
    if (stats) return { root: directory, linked: stats.isFile() };
    const parent = import_node_path3.default.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

// src/hooks/shared/read-only-shell.ts
var SHELL_TOKEN_RE = /((?:\d|&)?>>?(?:&\d?)?|&&|\|\||[|;\n])|("(?:[^"\\]|\\.)*"|'[^']*'|[^\s|;&<>"']+)/g;
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
function inPlaceEditTargets(words) {
  return words.some((word) => /^-[a-z]*i/i.test(word)) ? operands(words).slice(1) : [];
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
    "set-content",
    "add-content",
    "out-file",
    "new-item",
    "move-item",
    "rename-item",
    "clear-content",
    "ri",
    "ni",
    "del",
    "erase",
    "rd",
    "md",
    "move",
    "ren"
  ].map((name) => [name, operands]),
  ...["cp", "copy", "copy-item", "ln", "install", "rsync"].map((name) => [name, (words) => operands(words).slice(-1)]),
  ["sed", inPlaceEditTargets],
  ["perl", inPlaceEditTargets],
  ["git", gitWriteTargets]
]);
function commandWriteTargets(words) {
  const name = import_node_path4.default.basename(words[0] || "").toLowerCase().replace(/\.exe$/, "");
  const reader = WRITE_TARGET_READERS.get(name);
  return reader ? reader(words) : [];
}
function shellTokens(command) {
  return [...command.matchAll(SHELL_TOKEN_RE)].map((match) => match[1] ? { operator: match[1] } : { word: match[2].replace(/^(["'])([\s\S]*)\1$/, "$2") });
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
function nativePath(word) {
  if (word === "~" || word.startsWith("~/")) return import_node_path4.default.join(import_node_os2.default.homedir(), word.slice(1));
  return process.platform === "win32" ? word.replace(/^\/([a-z])(\/|$)/i, "$1:/") : word;
}
function resolvedTarget(base, word) {
  return ignoredTarget(word) ? null : canonicalPath(import_node_path4.default.resolve(base, nativePath(word)));
}
function mainCheckoutOf(linkedRoot) {
  const pointer = /^gitdir:\s*(.+)$/m.exec(import_node_fs4.default.readFileSync(import_node_path4.default.join(linkedRoot, ".git"), "utf8"));
  return pointer ? canonicalPath(import_node_path4.default.resolve(linkedRoot, pointer[1].trim(), "..", "..", "..")) : null;
}
function checkoutRoots(cwd) {
  const checkout = enclosingCheckout(cwd);
  if (!checkout) return [];
  const main2 = checkout.linked ? mainCheckoutOf(checkout.root) : null;
  return main2 ? [checkout.root, main2] : [checkout.root];
}
function comparable(value) {
  return process.platform === "win32" ? value.toLowerCase() : value;
}
function isWithin(root, target) {
  const relative = import_node_path4.default.relative(comparable(root), comparable(target));
  return !relative.startsWith("..") && !import_node_path4.default.isAbsolute(relative);
}
function insideAny(roots, target) {
  return roots.some((root) => isWithin(root, target));
}
function nextBase(words, base) {
  return words[0] === "cd" && words[1] ? resolvedTarget(base, words[1]) || base : base;
}
function segmentWriteTargets(segment, base) {
  return [...segment.redirects, ...commandWriteTargets(segment.words)].map((word) => resolvedTarget(base, word)).filter((target) => target !== null);
}
function firstCheckoutWrite(command, cwd) {
  const roots = checkoutRoots(cwd);
  let base = canonicalPath(cwd);
  for (const segment of shellSegments(command)) {
    base = nextBase(segment.words, base);
    const blocked = segmentWriteTargets(segment, base).find((target) => insideAny(roots, target));
    if (blocked) return blocked;
  }
  return null;
}
function readOnlyShellRefusal(command, cwd) {
  const blocked = firstCheckoutWrite(command, cwd);
  return blocked ? `sidequest: read-only executor, refusing a shell write inside the repository checkout (${blocked}). Keep temporary files and evidence outside the checkout, in your scratchpad or the ticket's verification directory. If the ticket needs a repository change, comment the needed edit on the ticket and release it instead.` : null;
}

// src/lib/board-mcp-liveness.ts
var import_node_fs6 = __toESM(require("node:fs"));
var import_node_os3 = __toESM(require("node:os"));
var import_node_path6 = __toESM(require("node:path"));

// src/lib/kernel/worktree.ts
var import_node_fs5 = __toESM(require("node:fs"));
var import_node_path5 = __toESM(require("node:path"));
var import_node_crypto2 = __toESM(require("node:crypto"));
function platformPath(value) {
  return process.platform === "win32" ? value.toLowerCase() : value;
}
function canonicalPath2(value) {
  const gitBashDrive = process.platform === "win32" ? /^\/([a-zA-Z])(?=\/|$)/.exec(value) : null;
  const resolved = import_node_path5.default.resolve(gitBashDrive ? `${gitBashDrive[1]}:${value.slice(2)}` : value);
  const missing = [];
  let existing = resolved;
  while (!import_node_fs5.default.existsSync(existing)) {
    const parent = import_node_path5.default.dirname(existing);
    if (parent === existing) return platformPath(resolved);
    missing.unshift(import_node_path5.default.basename(existing));
    existing = parent;
  }
  try {
    return platformPath(import_node_path5.default.join(import_node_fs5.default.realpathSync.native(existing), ...missing));
  } catch {
    return platformPath(resolved);
  }
}

// src/lib/board-mcp-liveness.ts
var MARKER_PREFIX = "board-mcp-";
var MARKER_SUFFIX = ".json";
function boardMcpMarkerDirectory() {
  const home = process.env.SIDEQUEST_HOME || import_node_path6.default.join(import_node_os3.default.homedir(), ".claude", "sidequest");
  return import_node_path6.default.join(home, "tmp", "state");
}
function markerField(value, key) {
  return value !== null && typeof value === "object" ? Reflect.get(value, key) : void 0;
}
function markerText(value, key, fallback) {
  const text = markerField(value, key);
  return typeof text === "string" ? text : fallback;
}
function markerPid(value) {
  const pid = markerField(value, "pid");
  return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : 0;
}
function legacySessionId(name) {
  return decodeURIComponent(name.slice(MARKER_PREFIX.length, -MARKER_SUFFIX.length));
}
function readMarker(directory, name) {
  const file = import_node_path6.default.join(directory, name);
  try {
    const value = JSON.parse(import_node_fs6.default.readFileSync(file, "utf8"));
    const pid = markerPid(value);
    if (!pid) return [];
    return [{ pid, sessionId: markerText(value, "sessionId", legacySessionId(name)), project: markerText(value, "project", ""), file }];
  } catch (_) {
    return [];
  }
}
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}
function markerServesSessionOrProject(marker, sessionId, projectKey) {
  return marker.sessionId === sessionId || projectKey !== "" && marker.project === projectKey;
}
function observeMarkers(markers, sessionId, projectKey, directory) {
  const candidates = markers.filter((marker) => markerServesSessionOrProject(marker, sessionId, projectKey));
  const live = candidates.find((marker) => processAlive(marker.pid));
  if (live) return { state: live.sessionId === sessionId ? "live" : "rotated", marker: live };
  const exited = candidates.find((marker) => marker.sessionId === sessionId) || candidates[0];
  return exited ? { state: "exited", marker: exited } : { state: "absent", directory };
}
function isMarkerName(name) {
  return name.startsWith(MARKER_PREFIX) && name.endsWith(MARKER_SUFFIX);
}
function unlistableMarkers(error, directory) {
  const code = error instanceof Error && "code" in error ? error.code : "";
  return code === "ENOENT" ? { state: "absent", directory } : { state: "unreadable", directory, detail: String(error) };
}
function observeBoardMcp(sessionId, project) {
  const directory = boardMcpMarkerDirectory();
  let names;
  try {
    names = import_node_fs6.default.readdirSync(directory).filter(isMarkerName);
  } catch (error) {
    return unlistableMarkers(error, directory);
  }
  const markers = names.flatMap((name) => readMarker(directory, name));
  return observeMarkers(markers, sessionId, project ? canonicalPath2(project) : "", directory);
}

// src/lib/dispatch-preflight.ts
var import_node_child_process2 = require("node:child_process");
var import_node_crypto3 = require("node:crypto");
var import_node_fs7 = __toESM(require("node:fs"));
var import_node_os4 = __toESM(require("node:os"));
var import_node_path7 = __toESM(require("node:path"));
var PLUGIN_ID = "sidequest@eigenwise-toolshed";
var REPAIR_COMMAND = "claude plugin install sidequest@eigenwise-toolshed --scope project";
var FILE_READ_RETRY_DELAYS_MS = [20, 60, 140, 300];
var RETRYABLE_FILE_READ_CODES = /* @__PURE__ */ new Set(["EPERM", "EACCES", "EBUSY", "ENOENT"]);
function isRetryableFileReadError(error) {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const code = error.code;
  return typeof code === "string" && RETRYABLE_FILE_READ_CODES.has(code);
}
function readFileSyncWithRetry(filePath, encoding) {
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; ; attempt += 1) {
    try {
      return encoding ? import_node_fs7.default.readFileSync(filePath, encoding) : import_node_fs7.default.readFileSync(filePath);
    } catch (error) {
      const delay = FILE_READ_RETRY_DELAYS_MS[attempt];
      if (delay == null || !isRetryableFileReadError(error)) throw error;
      Atomics.wait(waitBuffer, 0, 0, delay);
    }
  }
}
function claudeHomeDir(opts = {}) {
  return opts.claudeHome || process.env.SIDEQUEST_CLAUDE_HOME || import_node_path7.default.join(import_node_os4.default.homedir(), ".claude");
}
function normalizeDir(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  return import_node_path7.default.resolve(value).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}
function jsonRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  const record = jsonRecord(value);
  if (!record) return value;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonicalJson(record[key])]));
}
function canonicalJsonFile(filePath) {
  let content;
  try {
    content = readFileSyncWithRetry(filePath, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`could not read ${filePath}: ${detail}`);
  }
  try {
    return canonicalJson(JSON.parse(content));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`could not parse ${filePath}: ${detail}`);
  }
}
function installRuntimeSnapshot(installPath, version) {
  if (typeof installPath !== "string" || !installPath.trim()) return { detail: "the registry entry has no installPath" };
  if (typeof version !== "string" || !version.trim()) return { detail: `the registry entry for ${installPath} has no plugin version` };
  try {
    const mcpManifest = canonicalJsonFile(import_node_path7.default.join(installPath, ".mcp.json"));
    const hooks = canonicalJsonFile(import_node_path7.default.join(installPath, "hooks", "hooks.json"));
    const manifest = jsonRecord(mcpManifest);
    const mcpServers = jsonRecord(manifest?.mcpServers);
    const identity = (0, import_node_crypto3.createHash)("sha256").update(JSON.stringify({
      schemaVersion: 2,
      plugin: { id: PLUGIN_ID, version: version.trim() },
      mcpManifest,
      hooks
    })).digest("hex");
    return { identity, advertisesBoardMcp: Boolean(mcpServers && Object.keys(mcpServers).length) };
  } catch (error) {
    return { detail: error instanceof Error ? error.message : String(error) };
  }
}
function checkSidequestInstall(projectPath, opts = {}) {
  const claudeHome = claudeHomeDir(opts);
  const registryPath = import_node_path7.default.join(claudeHome, "plugins", "installed_plugins.json");
  let registry;
  try {
    registry = JSON.parse(readFileSyncWithRetry(registryPath, "utf8"));
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
    const snapshot = installRuntimeSnapshot(install.installPath, install.version);
    if ("detail" in snapshot) {
      return {
        ok: false,
        reason: "runtime_unreadable",
        registryPath,
        ...typeof install.installPath === "string" ? { installPath: install.installPath } : {},
        detail: snapshot.detail
      };
    }
    if (snapshot.advertisesBoardMcp) {
      return { ok: true, registryPath, installPath: install.installPath, version: install.version.trim(), identity: snapshot.identity };
    }
  }
  return { ok: false, reason: "stale", registryPath, detail: "the .mcp.json snapshot declares no MCP server" };
}
function repairGuidance() {
  return `Run \`${REPAIR_COMMAND}\` from / for the target project, then start a new session or run \`/reload-plugins\` before dispatching again.`;
}
function installRefusalMessage(check, projectPath) {
  if (check.reason === "registry_unreadable") {
    return `Dispatch refused: could not read Claude Code's plugin registry at ${check.registryPath} (${check.detail}). Fix or remove the corrupt registry, confirm sidequest@eigenwise-toolshed is installed for ${projectPath}, then dispatch again.`;
  }
  if (check.reason === "runtime_unreadable") {
    return `Dispatch refused: could not compute the lifecycle-compatible Sidequest install identity for ${check.installPath || projectPath} (${check.detail}). Prepared dispatch compatibility requires the registry plugin version, .mcp.json, and hooks/hooks.json. ${repairGuidance()}`;
  }
  if (check.reason === "stale") {
    return `Dispatch refused: the sidequest@eigenwise-toolshed install registered for ${projectPath} (checked ${check.registryPath}) does not declare a board MCP server, so prepared dispatch compatibility cannot be proven. ${repairGuidance()}`;
  }
  return `Dispatch refused: sidequest@eigenwise-toolshed has no install with a lifecycle-compatible runtime registered for ${projectPath} in ${check.registryPath}. A \`.claude/settings.json\` enabledPlugins entry is not proof of an install. ${repairGuidance()}`;
}

// src/hooks/force-exec-bypass.ts
var { canonicalPath: canonicalPath3 } = require(import_node_path8.default.join(__dirname, "..", "lib", "worktrees.js"));
var { isInScope: scopeMatch } = require(import_node_path8.default.join(__dirname, "..", "lib", "scope-match.js"));
var PASS_THROUGH_AGENT_TYPES = /* @__PURE__ */ new Set(["Explore", "claude-code-guide", "statusline-setup"]);
var EXECUTOR_HELPER_TYPES = /* @__PURE__ */ new Set(["Explore", "claude-code-guide", "web-researcher", "general-purpose"]);
var HELPER_REVIEW_WORK_RE = /\b(?:audits?|auditors?|auditing|audited|reviews?|reviewers?|reviewing|reviewed|review-audit)\b/i;
var WRITE_TOOLS = /* @__PURE__ */ new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
var SHELL_TOOLS = /* @__PURE__ */ new Set(["Bash", "PowerShell"]);
function fallbackClassify(type) {
  const readOnlyDispatch = /^sidequest-exec-dispatch-readonly(?:-(low|medium|high|xhigh|max))?$/.exec(type);
  if (readOnlyDispatch) return { kind: "read_only_codex_dispatch", effort: readOnlyDispatch[1] || null };
  const readOnlyBuiltin = /^sidequest-exec-readonly-(low|medium|high|xhigh|max)$/.exec(type);
  if (readOnlyBuiltin) return { kind: "read_only_claude_builtin", effort: readOnlyBuiltin[1] || null };
  const dispatch = /^sidequest-exec-dispatch(?:-(low|medium|high|xhigh|max))?$/.exec(type);
  if (dispatch) return { kind: "codex_dispatch", effort: dispatch[1] || null };
  const builtin = /^sidequest-exec-(low|medium|high|xhigh|max)$/.exec(type);
  if (builtin) return { kind: "claude_builtin", effort: builtin[1] || null };
  if (type === DIAGNOSTIC_PROBE_NAME) return { kind: "diagnostic", effort: null };
  if (/^sidequest-ticket-/.test(type)) return { kind: "legacy_ticket", effort: null };
  if (/^sidequest-(?:sq-|exec-)/.test(type)) return { kind: "ticket", effort: null };
  return { kind: "unknown", effort: null };
}
function classifyExecutor(type) {
  if (type === DIAGNOSTIC_PROBE_NAME) return { kind: "diagnostic", effort: null };
  try {
    return require(runtimeModule("exec-names")).classify(type);
  } catch (_) {
    return fallbackClassify(type);
  }
}
var CURRENT_EXECUTOR_KINDS = /* @__PURE__ */ new Set([
  "claude_builtin",
  "codex_dispatch",
  "discovered_model",
  "read_only_claude_builtin",
  "read_only_codex_dispatch",
  "read_only_discovered_model"
]);
function isCurrentExecutor(classification) {
  return CURRENT_EXECUTOR_KINDS.has(classification.kind);
}
var FRONTMATTER_MODEL_KINDS = /* @__PURE__ */ new Set([
  "codex_dispatch",
  "read_only_codex_dispatch",
  "discovered_model",
  "read_only_discovered_model"
]);
function isSubagentCaller(input) {
  return Boolean(stringField(input, "agent_id"));
}
function helperDenyReason(type) {
  return `sidequest: ${type || "unnamed"} is not an allowed executor helper. Route matching category work through its Sidequest ticket executor.`;
}
function helperReviewWorkDenyReason() {
  return "sidequest: helper prompts that request audit or review work must run through the board as a review-audit ticket executor.";
}
function isHelperReviewWork(toolInput) {
  return HELPER_REVIEW_WORK_RE.test(`${String(toolInput.prompt || "")}
${String(toolInput.description || "")}`);
}
function helperModelDenyReason(type) {
  return `sidequest: executor helper ${type} needs an explicit Agent model. Nested spawns do not inherit the parent route, so a default model would silently weaken the helper.`;
}
function helperEvidenceRule(input) {
  const transcriptPath = stringField(input, "transcript_path", "transcriptPath").trim();
  const sessionPaths = transcriptPath ? [transcriptPath, import_node_path8.default.join(import_node_path8.default.dirname(transcriptPath), "subagents")] : [];
  const knownLocations = sessionPaths.length ? ` Current session self-reference locations: ${sessionPaths.join(", ")}.` : "";
  return "\n\nEvidence rule: quoted ticket strings appear in this session’s context and generated transcripts. A match in the parent or helper session transcript, subagent transcript, or task-output files is self-reference, not evidence: report it as such. Do not search session, transcript, or task-output directories for evidence. Cite only the directly reachable artifact under investigation; if it is outside the parent worktree or otherwise unavailable, report a visibility block rather than a finding." + knownLocations;
}
function rewriteExecutorHelper(input, toolInput, type) {
  if (!EXECUTOR_HELPER_TYPES.has(type)) {
    writeDeny("PreToolUse", helperDenyReason(type));
    return;
  }
  if (isHelperReviewWork(toolInput)) {
    writeDeny("PreToolUse", helperReviewWorkDenyReason());
    return;
  }
  const hasModel = Object.prototype.hasOwnProperty.call(toolInput, "model") && toolInput.model != null && toolInput.model !== "";
  if (!hasModel) {
    writeDeny("PreToolUse", helperModelDenyReason(type));
    return;
  }
  const updatedInput = {
    ...toolInput,
    prompt: `${String(toolInput.prompt || "")}${helperEvidenceRule(input)}`,
    mode: "bypassPermissions",
    run_in_background: true
  };
  delete updatedInput.isolation;
  writeToolUpdate(updatedInput, "sidequest: executor helpers run in the background from the parent working tree. If the target is unavailable there, report the visibility block instead of returning clean findings.");
}
function isDiagnosticProbe(type, toolInput) {
  return type === DIAGNOSTIC_PROBE_NAME && toolInput.description === "Sidequest dispatch self-test." && toolInput.prompt === "Diagnose Sidequest dispatch machinery. Read package.json, then report whether the Agent spawn can use a read-only tool." && !Object.hasOwn(toolInput, "model") && !Object.hasOwn(toolInput, "isolation");
}
function diagnosticProbeDenyReason() {
  return `sidequest: ${DIAGNOSTIC_PROBE_NAME} is reserved for a foreground dispatch self-test. Use description "Sidequest dispatch self-test." and prompt "Diagnose Sidequest dispatch machinery. Read package.json, then report whether the Agent spawn can use a read-only tool." Omit model, ticket refs, isolation, and background mode. Ordinary work needs a ticket.`;
}
function sidequestTypeDenyReason(type, classification) {
  if (classification.kind === "ticket" || classification.kind === "legacy_ticket") {
    return `sidequest: ${type} looks like a Sidequest executor name but is invalid or retired. Re-run dispatch and spawn the returned executor.`;
  }
  return `sidequest: ${type} is an unknown Sidequest agent type. Use the executor returned by dispatch.`;
}
function genericAgentDenyReason(type) {
  return `sidequest: ${type || "custom"} is a generic Agent, not a Sidequest ticket executor. For a tiny lookup, use Read, Glob, Grep, or WebFetch inline, not WebSearch. A usable route needs a fresh Board MCP dispatch and its exact returned executor. Board MCP is the lifecycle authority: reload or reconnect Sidequest, then re-dispatch. Do not use a raw Agent or Sidequest CLI fallback. Any delegated work, including a quick investigation, needs a ticket: file a spike (usually codebase-exploration), route it, dispatch it, then spawn the returned executor. The blocked work still gates any dependent action: do not proceed to a PR, merge, publish, or ship until its ticket is filed, dispatched, and closed; rerouting around this block is a violation.`;
}
function missingInstallDenyReason(input, type) {
  const project = registeredProjectPath(input);
  if (!project) return null;
  const check = checkSidequestInstall(project);
  return check.ok ? null : `sidequest: ${type || "custom"} is a generic Agent, and this project cannot dispatch a ticket executor either. ${installRefusalMessage(check, project)}`;
}
var BOARD_MCP_RECONNECT = "Stop and report this to the user instead of retrying. The user must run /mcp and reconnect plugin:sidequest:board, or restart Claude Code. Do not use a raw Agent or Sidequest CLI fallback.";
function boardMcpDownReason(input) {
  const sessionId = stringField(input, "session_id", "sessionId").trim();
  if (!sessionId) return null;
  return boardMcpDownDescription(observeBoardMcp(sessionId, process.env.CLAUDE_PROJECT_DIR || stringField(input, "cwd")));
}
function boardMcpDownDescription(observed) {
  if (observed.state === "exited") {
    return `sidequest: the Board MCP server last recorded for this session or project (pid ${observed.marker.pid}, ${observed.marker.file}) has exited. ${BOARD_MCP_RECONNECT}`;
  }
  if (observed.state === "absent") {
    return `sidequest: no Board MCP server has recorded itself for this session or project in ${observed.directory}. ${BOARD_MCP_RECONNECT}`;
  }
  if (observed.state === "unreadable") {
    return `sidequest: could not read Board MCP liveness markers in ${observed.directory} (${observed.detail}), so the board server state is unknown. If board tools answer, dispatch through them; otherwise the user must run /mcp and reconnect plugin:sidequest:board. Do not use a raw Agent or Sidequest CLI fallback.`;
  }
  return null;
}
function agentDenyReason(input, type, classification) {
  if (type.startsWith("sidequest-")) return sidequestTypeDenyReason(type, classification);
  return missingInstallDenyReason(input, type) || boardMcpDownReason(input) || genericAgentDenyReason(type);
}
var EXPLORE_FREE_SPAWNS = 2;
var DENIED_WORK_PROMPT_PREFIX_CHARS = 160;
var DENIED_WORK_MAX_RECORDS = 20;
function guardSessionId(input) {
  return (stringField(input, "session_id", "sessionId") || process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || "").trim();
}
function normalizedWork(value) {
  return String(value ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}
function deniedWorkPromptPrefix(toolInput) {
  return normalizedWork(toolInput.prompt).slice(0, DENIED_WORK_PROMPT_PREFIX_CHARS);
}
function deniedWorkRecords(state) {
  if (!Array.isArray(state.deniedWork)) return [];
  return state.deniedWork.filter((record) => isRecord(record) && typeof record.description === "string" && typeof record.promptPrefix === "string");
}
function recordDeniedGenericWork(input, toolInput) {
  const sessionId = guardSessionId(input);
  if (!sessionId) return;
  try {
    const file = sessionStateFile("explore-fanout", sessionId);
    const state = readSessionState(file);
    const records = deniedWorkRecords(state);
    records.push({ description: normalizedWork(toolInput.description), promptPrefix: deniedWorkPromptPrefix(toolInput) });
    state.deniedWork = records.slice(-DENIED_WORK_MAX_RECORDS);
    writeSessionState(file, state);
  } catch (_) {
  }
}
function matchesDeniedWork(records, toolInput) {
  const description = normalizedWork(toolInput.description);
  const promptPrefix = deniedWorkPromptPrefix(toolInput);
  return records.some((record) => record.description !== "" && record.description === description || record.promptPrefix !== "" && record.promptPrefix === promptPrefix);
}
function guardMainSessionExplore(input, toolInput) {
  const sessionId = guardSessionId(input);
  if (!sessionId || dispatchAdmission(input).status !== "routed") return;
  const file = sessionStateFile("explore-fanout", sessionId);
  const state = readSessionState(file);
  if (matchesDeniedWork(deniedWorkRecords(state), toolInput)) {
    writeDeny("PreToolUse", "sidequest: this Explore spawn matches work a generic Agent was already denied for. The block applied to the work, not the agent type. File a spike ticket (usually codebase-exploration), route it, dispatch it, then spawn the returned executor; rerouting denied work through Explore is a violation.");
    return;
  }
  const priorPasses = Number(state.explorePasses) || 0;
  const boardInteraction = Boolean(readSessionState(sessionStateFile("inline-work", sessionId)).boardInteraction);
  if (priorPasses >= EXPLORE_FREE_SPAWNS && !boardInteraction) {
    writeDeny("PreToolUse", `sidequest: Explore spawn ${priorPasses + 1} this session with no board interaction. Explore inherits the session model; investigation at this scale belongs on the board, where a codebase-exploration spike runs a cheaper route. File the spike, route it, dispatch it, then spawn the returned executor.`);
    return;
  }
  state.explorePasses = priorPasses + 1;
  writeSessionState(file, state);
  if (priorPasses < EXPLORE_FREE_SPAWNS) {
    writeContext("PreToolUse", "sidequest: Explore is for quick evidence sweeps and inherits the session model. Deep or fan-out investigation belongs on the board: file a spike ticket (usually codebase-exploration), route it, dispatch it, and spawn the returned executor on its cheaper route.");
  }
}
var REF_RE = /\bSQ-\d+\b/gi;
function extractRefs(prompt) {
  if (typeof prompt !== "string" || !prompt) return [];
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const match of prompt.match(REF_RE) || []) {
    const ref = match.toUpperCase();
    if (!seen.has(ref)) {
      seen.add(ref);
      out.push(ref);
    }
  }
  return out;
}
function extractProjectArg(prompt) {
  if (typeof prompt !== "string" || !prompt) return null;
  const matches = [...prompt.matchAll(/--project\s+"([^"]+)"|--project[=\s]+(\S+)/g)];
  const match = matches.at(-1);
  return match ? match[1] || match[2] || null : null;
}
function extractDispatchTokenFile(prompt) {
  if (typeof prompt !== "string" || !prompt) return null;
  const matches = [...prompt.matchAll(/--token-file\s+"([^"]+)"|--token-file[=\s]+(\S+)/g)];
  const match = matches.at(-1);
  return match ? match[1] || match[2] || null : null;
}
function dispatchRefs(prompt) {
  if (typeof prompt !== "string" || !prompt) return [];
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const match of prompt.matchAll(/briefing\s+(SQ-\d+)\s+--token-file\s+(?:"[^"]+"|\S+)/gi)) {
    const ref = (match[1] || "").toUpperCase();
    if (ref && !seen.has(ref)) {
      seen.add(ref);
      out.push(ref);
    }
  }
  return out;
}
function dispatchLaunches(prompt) {
  if (typeof prompt !== "string" || !prompt) return [];
  const headings = [...prompt.matchAll(/^Ref:\s*(SQ-\d+)\s*$/gim)];
  const launches = headings.map((match, index) => {
    const next = headings[index + 1];
    const section = prompt.slice(match.index, next ? next.index : prompt.length);
    return { ref: (match[1] || "").toUpperCase(), tokenFile: extractDispatchTokenFile(section) };
  }).filter((launch) => Boolean(launch.ref && launch.tokenFile));
  if (launches.length) return launches;
  return [...prompt.matchAll(/briefing\s+(SQ-\d+)\s+--token-file\s+(?:"([^"]+)"|(\S+))/gi)].map((match) => ({ ref: (match[1] || "").toUpperCase(), tokenFile: match[2] || match[3] || "" })).filter((launch) => Boolean(launch.ref && launch.tokenFile));
}
function toolInputOf(input) {
  return isRecord(input.tool_input) ? input.tool_input : null;
}
var CLOSEOUT_UPDATE_FIELDS = /* @__PURE__ */ new Set([
  "files",
  "status",
  "readonly",
  "readonlyOverride",
  "workingTreeDelivery",
  "externalDeliverable",
  "verify",
  "verifyKind",
  "attestationArtifact",
  "verifyCwd",
  "executorVerify",
  "executorVerifyKind",
  "executorAttestationArtifact",
  "executorVerifyCwd"
]);
function executorLiveClaimMutationRefusal(input) {
  if (!isSubagentCaller(input)) return false;
  const toolName = stringField(input, "tool_name");
  const toolInput = toolInputOf(input);
  if (toolName === "mcp__plugin_sidequest_board__update" && toolInput && Array.from(CLOSEOUT_UPDATE_FIELDS).some((field) => Object.hasOwn(toolInput, field))) {
    writeDeny("PreToolUse", "sidequest: subagents cannot update closeout fields through MCP. Use scopeRequest for files, or ask the orchestrator to set other closeout flags from the main thread.");
    return true;
  }
  if (toolName === "mcp__plugin_sidequest_board__remove" && toolInput && toolInput.force === true) {
    writeDeny("PreToolUse", "sidequest: subagents cannot force-remove a ticket. Release your claim, or ask the orchestrator to remove it from the main thread.");
    return true;
  }
  return false;
}
function dispatchAgentName(input) {
  const toolInput = toolInputOf(input);
  const dispatched = dispatchRefs(toolInput?.prompt);
  const refs = dispatched.length ? dispatched : extractRefs(toolInput?.prompt);
  const launch = dispatched[0];
  if (refs.length !== 1 || dispatched.length && !launch) return null;
  return dispatchLaunchName(refs[0]);
}
function recordAuthoritativeLaunch(input, type, agentName) {
  const toolInput = toolInputOf(input);
  if (!toolInput) return;
  const launches = dispatchLaunches(toolInput.prompt);
  const projectArg = extractProjectArg(toolInput.prompt) || stringField(input, "cwd") || process.env.CLAUDE_PROJECT_DIR;
  const sessionId = stringField(input, "session_id", "sessionId") || process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID;
  if (!launches.length || !projectArg || !sessionId) return;
  try {
    const store = require(runtimeModule("store"));
    const found = store.findProject(projectArg);
    if (!found.ok || !found.slug) return;
    for (const launch of launches) {
      store.recordDispatchLaunch(found.slug, launch.ref, {
        tokenFile: launch.tokenFile,
        executor: type,
        sessionId,
        agentName: agentName || toolInput.name
      });
    }
  } catch (_) {
  }
}
function resolveStampedModel(input) {
  const toolInput = toolInputOf(input);
  const prompt = toolInput?.prompt;
  const dispatched = dispatchRefs(prompt);
  const refs = dispatched.length ? dispatched : extractRefs(prompt);
  if (!refs.length) return { status: "no-refs", refs };
  let store;
  try {
    store = require(runtimeModule("store"));
  } catch (_) {
    return { status: "error", refs };
  }
  const projectArg = extractProjectArg(prompt) || stringField(input, "cwd") || process.env.CLAUDE_PROJECT_DIR;
  const found = projectArg ? store.findProject(projectArg) : { ok: false };
  if (!found.ok || !found.slug) return { status: "no-project", refs };
  const models = /* @__PURE__ */ new Set();
  for (const ref of refs) {
    const ticket = store.getTicket(found.slug, ref);
    if (!ticket) return { status: "ticket-not-found", refs, missing: ref };
    if (!ticket.exec?.model) return { status: "ticket-not-builtin", refs, ref };
    models.add(ticket.exec.model);
  }
  if (models.size !== 1) return { status: "conflicting", refs, models: [...models] };
  return { status: "ok", refs, model: [...models][0] };
}
function requestedProject(input) {
  return extractProjectArg(toolInputOf(input)?.prompt) || stringField(input, "cwd") || process.env.CLAUDE_PROJECT_DIR || "";
}
function registeredProjectPath(input) {
  const project = requestedProject(input);
  if (!project) return "";
  try {
    const found = require(runtimeModule("store")).findProject(project);
    return found.ok ? found.meta?.path || project : "";
  } catch (_) {
    return "";
  }
}
function dispatchAdmission(input) {
  const project = requestedProject(input);
  if (!project) return { status: "no-project" };
  try {
    const store = require(runtimeModule("store"));
    const found = store.findProject(project);
    return found.ok && found.slug ? store.projectDispatchAdmission(found.slug) : { status: "no-project" };
  } catch (_) {
    return { status: "no-project" };
  }
}
var ROUTE_MARKER_RE = /^\[sidequest-route model=([a-z0-9][a-z0-9.-]{0,63}) effort=(low|medium|high|xhigh|max)(?: ticket=[A-Za-z][A-Za-z0-9_-]{0,63})?\]$/gm;
function dispatchRouteMarkers(input) {
  const prompt = toolInputOf(input)?.prompt;
  if (typeof prompt !== "string" || !prompt) return [];
  return [...prompt.matchAll(ROUTE_MARKER_RE)].map((match) => ({ model: match[1] || "", effort: match[2] || "" }));
}
function preparedBriefingCommand(ticket, project) {
  try {
    const agentsync = require(runtimeModule("agentsync"));
    const stub = agentsync.renderDispatchStub(ticket, project);
    return /^FIRST action: run `([^`]+)` and execute exactly what it prints\.$/m.exec(stub)?.[1] || null;
  } catch (_) {
    return null;
  }
}
function preparedLaunchExec(store, ticket) {
  const route = ticket.dispatch?.route;
  return route?.model && route.effort ? store.resolveExec(route.model, route.effort) : null;
}
function preparedDispatchValidation(input) {
  const prompt = toolInputOf(input)?.prompt;
  if (typeof prompt !== "string") return { status: "none" };
  const commands = [...prompt.matchAll(/^FIRST action: run `([^`]+)` and execute exactly what it prints\.$/gm)];
  if (commands.length !== 1) return { status: "none" };
  const command = commands[0]?.[1];
  const ref = /\bbriefing\s+(SQ-\d+)\b/i.exec(command || "")?.[1]?.toUpperCase();
  const project = extractProjectArg(command);
  if (!ref || !project) return { status: "none" };
  try {
    const store = require(runtimeModule("store"));
    const found = store.findProject(project);
    if (!found.ok || !found.slug) return { status: "none" };
    const ticket = store.getTicket(found.slug, ref);
    if (!ticket?.dispatch) return { status: "none" };
    const briefingCommand = preparedBriefingCommand(ticket, project);
    if (!briefingCommand) return { status: "none" };
    if (command !== briefingCommand) return { status: "stale" };
    const description = ticket.dispatch.description;
    const route = ticket.dispatch.route;
    const resolvedExec = preparedLaunchExec(store, ticket);
    return {
      status: "valid",
      spawn: {
        briefingCommand,
        continuationWorktree: String(ticket.dispatch.continuation?.sourceWorktree || "").trim() || null,
        description: typeof description === "string" && description ? description : null,
        executor: typeof ticket.dispatchExecutor === "string" ? ticket.dispatchExecutor : "",
        name: ticket.dispatch.launchName || dispatchLaunchName(ticket.ref || ref, ticket.title, resolvedExec, route?.effort, ticket.dispatch.launchSeq),
        reducedAgentSchema: ticket.dispatch.reducedAgentSchema === true,
        ref,
        project,
        route: typeof route?.model === "string" && typeof route.effort === "string" ? { model: route.model, effort: route.effort, marker: typeof route.marker === "string" && route.marker ? route.marker : null } : null
      }
    };
  } catch (_) {
    return { status: "none" };
  }
}
function hasExactPreparedBriefing(prompt, spawn) {
  return typeof prompt === "string" && prompt.includes(`FIRST action: run \`${spawn.briefingCommand}\` and execute exactly what it prints.`);
}
function correctionMessage(corrections) {
  return corrections.length ? `sidequest: corrected prepared dispatch ${corrections.join(" and ")}.` : null;
}
function denyReason(result, type) {
  const retry = "Re-read the wave (`ready --brief`) and re-spawn with `model: exec.model`.";
  const ticketRetry = "Include the dispatch briefing (with its SQ-n ref) in the prompt, or file a ticket and dispatch it via Board MCP first.";
  const base = `sidequest: ${type} was spawned without \`model\` and it couldn't be resolved`;
  switch (result.status) {
    case "no-refs":
      return `sidequest: ${type} is missing its dispatched ticket — no SQ-\\d+ ticket ref was found in the prompt. ${ticketRetry}`;
    case "no-project":
      return `${base} — the board for ${result.refs.join(", ")} couldn't be determined (no --project, cwd, or CLAUDE_PROJECT_DIR resolved to a registered board). ${retry}`;
    case "ticket-not-found":
      return `sidequest: ${type}'s dispatched ticket ${result.missing} isn't on the resolved board. Re-read the wave (\`ready --brief\`) rather than retyping refs. ${ticketRetry}`;
    case "ticket-not-builtin":
      return `${base} — ${result.ref} resolves to a Codex route, which spawns its own pinned executor, not a builtin. Re-read the wave (\`ready --brief\`) and spawn its \`exec.agent\` instead.`;
    case "conflicting":
      return `${base} — ${result.refs.join(", ")} resolve to conflicting concrete models (${(result.models || []).join(", ")}). That's an illegal mixed-model batch: split it per model and re-spawn each with its own \`model: exec.model\`.`;
    default:
      return `${base}. ${retry}`;
  }
}
function liveDispatchBinding(ticket, sessionId, agentId) {
  const dispatch = ticket.dispatch;
  return dispatch?.sessionId === sessionId && !dispatch.terminalAt && dispatch.agentId === agentId;
}
function dispatchIdentityMatches(ticket, agentId, type) {
  const dispatch = ticket.dispatch;
  if (dispatch?.agentId === agentId) return true;
  const agentName = dispatch?.agentName;
  return Boolean(agentName && (agentId === agentName || agentId.startsWith(`${agentName}-`) || agentId.startsWith(`a${agentName}-`) || type === agentName || type.startsWith(`${agentName}-`) || type.startsWith(`a${agentName}-`)));
}
function dispatchAttemptRef(input) {
  const toolName = stringField(input, "tool_name");
  const toolInput = toolInputOf(input);
  if (toolName === "mcp__plugin_sidequest_board__dispatch") {
    const ref = stringField(toolInput || {}, "ref").toUpperCase();
    return /^SQ-\d+$/.test(ref) ? ref : null;
  }
  if (toolName !== "Bash" && toolName !== "PowerShell") return null;
  const command = stringField(toolInput || {}, "command");
  const match = /\bsidequest(?:\.js)?["']?\s+dispatch\s+(SQ-\d+)\b/i.exec(command);
  return match ? match[1].toUpperCase() : null;
}
function activeExecutorTicketRefs(input) {
  const agentId = stringField(input, "agent_id", "agentId");
  const executor = stringField(input, "agent_type", "agentType", "subagent_type");
  const sessionId = stringField(input, "session_id", "sessionId") || process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || "";
  if (!agentId || !sessionId || !isCurrentExecutor(classifyExecutor(executor))) return /* @__PURE__ */ new Set();
  try {
    const store = require(runtimeModule("store"));
    const refs = /* @__PURE__ */ new Set();
    for (const project of store.listProjects({ all: true })) {
      for (const ticket of store.listTickets(project.slug)) {
        if (ticket.dispatch?.sessionId !== sessionId || ticket.dispatch?.terminalAt) continue;
        if (dispatchIdentityMatches(ticket, agentId, executor) && ticket.ref) refs.add(ticket.ref.toUpperCase());
      }
    }
    return refs;
  } catch (_) {
    return /* @__PURE__ */ new Set();
  }
}
function terminalExecutorTicket(input) {
  const agentId = stringField(input, "agent_id", "agentId");
  const executor = stringField(input, "agent_type", "agentType", "subagent_type");
  const sessionId = stringField(input, "session_id", "sessionId") || process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || "";
  if (!agentId || !sessionId || !isCurrentExecutor(classifyExecutor(executor))) return null;
  try {
    const store = require(runtimeModule("store"));
    const matches = [];
    let liveBinding = false;
    for (const project of store.listProjects({ all: true })) {
      for (const ticket of store.listTickets(project.slug)) {
        liveBinding = liveBinding || liveDispatchBinding(ticket, sessionId, agentId);
        if (!ticket.ref || ticket.dispatch?.sessionId !== sessionId || !dispatchIdentityMatches(ticket, agentId, executor)) continue;
        if (!ticket.dispatch?.terminalAt) return null;
        if (ticket.claim?.by) continue;
        if (ticket.submission?.supersededBy?.ref || ticket.completion?.supersededBy?.ref) {
          const by = String(ticket.completion?.by || "the control plane").trim();
          matches.push({ ref: ticket.ref, closedBy: `superseded by ${ticket.submission?.supersededBy?.ref || ticket.completion?.supersededBy?.ref} through ${by}`, outcome: "superseded" });
        } else if (ticket.status === "done" || ticket.archived) {
          const by = String(ticket.completion?.by || "the control plane").trim();
          const action = ticket.completion?.purpose === "grooming" ? "groomClosed" : "delivered";
          matches.push({ ref: ticket.ref, closedBy: `${action} by ${by}`, outcome: ticket.archived ? "archived" : "done" });
        }
      }
    }
    return !liveBinding && matches.length === 1 ? matches[0] || null : null;
  } catch (_) {
    return null;
  }
}
function guardTerminalExecutor(input) {
  const terminal = terminalExecutorTicket(input);
  if (!terminal) return false;
  writeDeny(
    "PreToolUse",
    `sidequest: ${terminal.ref} is closed (${terminal.outcome}; ${terminal.closedBy}). End this turn now without further calls.`
  );
  return true;
}
function guardOwnTicketDispatch(input) {
  const ref = dispatchAttemptRef(input);
  if (!ref || !activeExecutorTicketRefs(input).has(ref)) return false;
  writeDeny(
    "PreToolUse",
    `sidequest: refusing to dispatch ${ref} from its active executor. Release ${ref} with a reason so the orchestrator can redispatch it; do not rotate this dispatch token yourself.`
  );
  return true;
}
function helperScope(store, project, projectPath, ticket) {
  return {
    ref: ticket.ref,
    projectPath,
    files: store.executionScope(project, ticket),
    evidenceDirectory: String(ticket.dispatch?.evidenceDirectory || "").trim()
  };
}
function evidenceScope(ticket) {
  const evidenceDirectory = String(ticket.dispatch?.evidenceDirectory || "").trim();
  return ticket.ref && evidenceDirectory ? { ref: ticket.ref, evidenceDirectory } : null;
}
function helperScopeResolution(status, scopes, evidenceScopes) {
  return { status, scopes, evidenceScopes };
}
function helperScopes(input) {
  const agentId = stringField(input, "agent_id", "agentId");
  const type = stringField(input, "agent_type", "agentType", "subagent_type");
  const sessionId = stringField(input, "session_id", "sessionId") || process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || "";
  if (!agentId || !type || !sessionId || isCurrentExecutor(classifyExecutor(type))) return helperScopeResolution("no-active-ticket", [], []);
  try {
    const store = require(runtimeModule("store"));
    const activeTickets = [];
    const recoveryTickets = [];
    const evidenceScopes = [];
    for (const project of store.listProjects({ all: true })) {
      const projectPath = String(store.readMeta(project.slug)?.path || "").trim();
      if (!projectPath) continue;
      for (const ticket of store.listTickets(project.slug)) {
        const evidence = evidenceScope(ticket);
        if (evidence) evidenceScopes.push(evidence);
        if (!ticket.ref || ticket.dispatch?.sessionId !== sessionId) continue;
        const candidate = { project: project.slug, projectPath, ticket };
        if (ticket.claim?.by && !ticket.dispatch?.terminalAt) activeTickets.push(candidate);
        if (dispatchIdentityMatches(ticket, agentId, type)) recoveryTickets.push(candidate);
      }
    }
    const ownedTickets = activeTickets.filter(({ ticket }) => dispatchIdentityMatches(ticket, agentId, type));
    if (ownedTickets.length === 1) {
      const owner = ownedTickets[0];
      return helperScopeResolution("ok", [helperScope(store, owner.project, owner.projectPath, owner.ticket)], evidenceScopes);
    }
    if (ownedTickets.length > 1) return helperScopeResolution("no-owner", ownedTickets.map((owner) => helperScope(store, owner.project, owner.projectPath, owner.ticket)), evidenceScopes);
    if (recoveryTickets.length === 1) {
      const owner = recoveryTickets[0];
      return helperScopeResolution("recovery-owner", [helperScope(store, owner.project, owner.projectPath, owner.ticket)], evidenceScopes);
    }
    if (activeTickets.length === 1) {
      const owner = activeTickets[0];
      return helperScopeResolution("ok", [helperScope(store, owner.project, owner.projectPath, owner.ticket)], evidenceScopes);
    }
    return helperScopeResolution(
      activeTickets.length ? "no-owner" : "no-active-ticket",
      activeTickets.map((owner) => helperScope(store, owner.project, owner.projectPath, owner.ticket)),
      evidenceScopes
    );
  } catch (_) {
    return helperScopeResolution("no-active-ticket", [], []);
  }
}
function writeTargetValue(input) {
  const toolInput = toolInputOf(input);
  if (!toolInput) return "";
  const raw = toolInput.file_path ?? toolInput.notebook_path ?? toolInput.path;
  return raw == null ? "" : String(raw).trim();
}
function writeTarget(input) {
  const raw = writeTargetValue(input);
  if (!raw) return "";
  const cwd = stringField(input, "cwd") || process.cwd();
  return import_node_path8.default.resolve(cwd, raw);
}
function restoresCommittedContent(input, target) {
  try {
    const toolInput = toolInputOf(input);
    const toolName = stringField(input, "tool_name");
    let restored;
    if (toolName === "Write" && typeof toolInput?.content === "string") {
      restored = toolInput.content;
    } else if (toolName === "Edit" && typeof toolInput?.old_string === "string" && typeof toolInput.new_string === "string") {
      const current = import_node_fs8.default.readFileSync(target, "utf8");
      const first = current.indexOf(toolInput.old_string);
      if (first < 0 || !toolInput.replace_all && current.indexOf(toolInput.old_string, first + toolInput.old_string.length) >= 0) return false;
      restored = toolInput.replace_all ? current.split(toolInput.old_string).join(toolInput.new_string) : `${current.slice(0, first)}${toolInput.new_string}${current.slice(first + toolInput.old_string.length)}`;
    } else {
      return false;
    }
    const repository = canonicalPath3(execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: import_node_path8.default.dirname(target),
      encoding: "utf8",
      windowsHide: true
    }).trim());
    const relative = import_node_path8.default.relative(repository, canonicalPath3(target)).replace(/\\/g, "/");
    if (!relative || relative === ".." || relative.startsWith("../") || import_node_path8.default.isAbsolute(relative)) return false;
    const committed = execFileSync("git", ["show", `HEAD:${relative}`], {
      cwd: repository,
      windowsHide: true
    });
    return Buffer.from(restored, "utf8").equals(committed);
  } catch (_) {
    return false;
  }
}
function relativeInside(root, target) {
  const relative = import_node_path8.default.relative(root, target).replace(/\\/g, "/");
  return relative && relative !== ".." && !relative.startsWith("../") && !import_node_path8.default.isAbsolute(relative) ? relative : null;
}
function linkedWorktreeRelative(target, projectPath) {
  let existing = import_node_path8.default.dirname(target);
  while (!import_node_fs8.default.existsSync(existing)) {
    const parent = import_node_path8.default.dirname(existing);
    if (parent === existing) return null;
    existing = parent;
  }
  try {
    const checkout = canonicalPath3(execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: existing,
      encoding: "utf8",
      windowsHide: true
    }).trim());
    const commonOutput = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: checkout,
      encoding: "utf8",
      windowsHide: true
    }).trim();
    const common = canonicalPath3(import_node_path8.default.isAbsolute(commonOutput) ? commonOutput : import_node_path8.default.resolve(checkout, commonOutput));
    if (common !== canonicalPath3(import_node_path8.default.join(projectPath, ".git"))) return null;
    return relativeInside(checkout, target);
  } catch (_) {
    return null;
  }
}
function projectRelative(target, projectPath) {
  const direct = relativeInside(projectPath, target);
  if (direct) {
    const legacyWorktree = /^\.claude\/worktrees\/[^/]+\/(.+)$/.exec(direct);
    return legacyWorktree ? legacyWorktree[1] || null : direct;
  }
  return linkedWorktreeRelative(target, projectPath);
}
function inScope(target, scope) {
  const canonicalTarget = canonicalPath3(target);
  const relative = projectRelative(canonicalTarget, canonicalPath3(scope.projectPath));
  if (relative != null) return scopeMatch(relative, scope.files);
  return scopeMatch(canonicalTarget, scope.files.filter((file) => import_node_path8.default.isAbsolute(file)).map(canonicalPath3));
}
function evidencePathRelation(target, scope) {
  const evidenceDirectory = canonicalPath3(scope.evidenceDirectory);
  const canonicalTarget = canonicalPath3(target);
  if (relativeInside(evidenceDirectory, canonicalTarget) != null) return "inside";
  if (evidenceDirectory === canonicalTarget || relativeInside(canonicalTarget, evidenceDirectory) != null) return "related";
  return null;
}
function evidenceTraversalAttempt(input, scope) {
  const rawTarget = writeTargetValue(input);
  if (!rawTarget) return false;
  const cwd = stringField(input, "cwd") || process.cwd();
  const candidate = (import_node_path8.default.isAbsolute(rawTarget) ? rawTarget : import_node_path8.default.join(cwd, rawTarget)).replace(/\\/g, "/");
  const evidenceDirectory = import_node_path8.default.resolve(scope.evidenceDirectory).replace(/\\/g, "/").replace(/\/+$/, "");
  const comparableCandidate = process.platform === "win32" ? candidate.toLowerCase() : candidate;
  const comparableDirectory = process.platform === "win32" ? evidenceDirectory.toLowerCase() : evidenceDirectory;
  if (!comparableCandidate.startsWith(`${comparableDirectory}/`)) return false;
  return comparableCandidate.slice(comparableDirectory.length + 1).split("/").includes("..");
}
function denyEvidenceWrite(target) {
  writeDeny(
    "PreToolUse",
    `sidequest: refusing helper write to ${target}. Board-owned verification evidence is writable only by a helper resolved to its active ticket owner. Do not request scope for board-owned verification evidence.`
  );
}
function isScratchpadPath(target) {
  const configuredRoot = process.env.CLAUDE_SCRATCHPAD_DIR || process.env.CLAUDE_CODE_SCRATCHPAD_DIR;
  const roots = [configuredRoot, import_node_path8.default.join(import_node_os5.default.tmpdir(), "claude")].filter((root) => Boolean(root));
  return roots.some((root) => {
    const relative = import_node_path8.default.relative(import_node_path8.default.resolve(root), target);
    return Boolean(relative) && relative !== ".." && !relative.startsWith(`..${import_node_path8.default.sep}`) && !import_node_path8.default.isAbsolute(relative);
  });
}
function guardHelperWrite(input) {
  const resolution = helperScopes(input);
  const target = writeTarget(input);
  if (!target) return;
  const evidenceRelations = resolution.evidenceScopes.map((scope2) => evidencePathRelation(target, scope2));
  const evidenceTarget = evidenceRelations.some((relation) => relation != null) || resolution.evidenceScopes.some((scope2) => evidenceTraversalAttempt(input, scope2));
  if (resolution.status === "no-active-ticket") {
    if (evidenceTarget) denyEvidenceWrite(target);
    return;
  }
  const matchingScopes = resolution.scopes.filter((scope2) => inScope(target, scope2));
  if ((resolution.status === "recovery-owner" || resolution.status === "no-owner") && matchingScopes.length === 1 && restoresCommittedContent(input, target)) return;
  if (resolution.status === "no-owner" || resolution.status === "recovery-owner") {
    writeDeny(
      "PreToolUse",
      `sidequest: refusing helper write to ${target}. No active ticket is bound to acting agent ${stringField(input, "agent_id", "agentId")}; refusing to borrow another ticket's scope.`
    );
    return;
  }
  const scope = resolution.scopes[0];
  const ownedEvidenceRelation = evidencePathRelation(target, scope);
  if (evidenceTarget && ownedEvidenceRelation !== "inside") {
    denyEvidenceWrite(target);
    return;
  }
  if (isScratchpadPath(target) || ownedEvidenceRelation === "inside" || inScope(target, scope)) return;
  const display = projectRelative(target, scope.projectPath) || target;
  writeDeny(
    "PreToolUse",
    `sidequest: refusing helper write to ${display}. It is outside ${scope.ref}'s effective scope. Ask the parent executor to request scope; a granted ruling takes effect immediately. File a new ticket when this work belongs elsewhere.`
  );
}
function guardReadOnlyShell(input) {
  if (!isReadOnlyExecutor(stringField(input, "agent_type", "agentType"))) return;
  const refusal = readOnlyShellRefusal(String(toolInputOf(input)?.command ?? ""), stringField(input, "cwd") || process.cwd());
  if (refusal) writeDeny("PreToolUse", refusal);
}
function spawnPermissionFields(reducedAgentSchema, type) {
  return reducedAgentSchema || isReadOnlyExecutor(type) ? {} : { mode: "bypassPermissions" };
}
function guardLateSteer(input) {
  const toolInput = toolInputOf(input);
  const recipient = String(toolInput?.to || "").trim();
  const message = toolInput?.message;
  if (!recipient || typeof message !== "string" || !message.trim()) return;
  try {
    const store = require(runtimeModule("store"));
    const terminal = store.terminalDispatchTarget(recipient);
    if (!terminal) return;
    if (terminal.outcome !== "died") {
      writeDeny(
        "PreToolUse",
        `sidequest: ${terminal.ref} is terminal (${terminal.outcome}) and ${recipient} cannot receive messages. File a follow-up ticket for changes, or redispatch the existing ticket when it was released without a pending submission.`
      );
      return;
    }
    const sender = stringField(input, "agent_id", "agentId") || "orchestrator";
    const recorded = store.addComment(terminal.slug, terminal.ref, {
      by: sender,
      body: `Late steer to ${recipient}, which had already finished (${terminal.outcome}). Recorded here so it is not lost:

${message.trim()}`
    });
    writeDeny(
      "PreToolUse",
      `sidequest: ${terminal.ref} is already ${terminal.outcome} and ${recipient} has ended, so this steer would be dropped. ${recorded?.ok ? "It is now a comment on the ticket." : "Record it on the ticket yourself."} Re-dispatch ${terminal.ref} if the work itself must change.`
    );
  } catch (_) {
  }
}
function main() {
  const input = readStdin();
  if (!input) return;
  const toolName = stringField(input, "tool_name");
  if (guardTerminalExecutor(input)) return;
  if (guardOwnTicketDispatch(input)) return;
  if (executorLiveClaimMutationRefusal(input)) return;
  if (toolName === "SendMessage") {
    guardLateSteer(input);
    return;
  }
  if (WRITE_TOOLS.has(toolName)) {
    guardHelperWrite(input);
    return;
  }
  if (SHELL_TOOLS.has(toolName)) {
    guardReadOnlyShell(input);
    return;
  }
  if (toolName !== "Agent") return;
  const toolInput = toolInputOf(input);
  if (!toolInput) return;
  const type = canonicalExecutorName(String(toolInput.subagent_type || ""));
  const classification = classifyExecutor(type);
  if (isSubagentCaller(input) && !isCurrentExecutor(classification)) {
    rewriteExecutorHelper(input, toolInput, type);
    return;
  }
  if (PASS_THROUGH_AGENT_TYPES.has(type)) {
    if (type === "Explore") guardMainSessionExplore(input, toolInput);
    return;
  }
  if (classification.kind === "diagnostic") {
    if (!isDiagnosticProbe(type, toolInput)) {
      writeDeny("PreToolUse", diagnosticProbeDenyReason());
      return;
    }
    writeToolUpdate({ ...toolInput, mode: "bypassPermissions", run_in_background: false });
    return;
  }
  const isDispatchExecutor = classification.kind === "codex_dispatch" || classification.kind === "read_only_codex_dispatch";
  const admission = dispatchAdmission(input);
  if (isCurrentExecutor(classification) && (admission.status === "routing-disabled" || admission.status === "no-usable-route")) {
    writeDeny("PreToolUse", "sidequest: this project has no usable executor route. Continue only bounded inline work, or restore routing and an available category route before a fresh Board MCP dispatch.");
    return;
  }
  if (!isCurrentExecutor(classification) && !type.startsWith("sidequest-") && (admission.status === "routing-disabled" || admission.status === "no-usable-route")) {
    writeDeny("PreToolUse", "sidequest: this project has no usable executor route. Continue bounded inline work with direct tools; do not create a fake Sidequest or raw Agent lifecycle fallback.");
    return;
  }
  const dispatchValidation = preparedDispatchValidation(input);
  if (isDispatchExecutor && dispatchValidation.status !== "valid") {
    writeDeny("PreToolUse", dispatchValidation.status === "stale" ? "sidequest: dispatch briefing command is stale or drifted. Re-run dispatch and pass its spawn unchanged." : "sidequest: dispatch executor requires the exact prepared FIRST action briefing command. Re-run dispatch and pass its spawn unchanged.");
    return;
  }
  const preparedSpawn = dispatchValidation.spawn;
  const preparedRoute = preparedSpawn?.route;
  const markers = dispatchRouteMarkers(input);
  if (isDispatchExecutor) {
    if (!preparedSpawn || !hasExactPreparedBriefing(toolInput.prompt, preparedSpawn) || type !== preparedSpawn.executor) {
      writeDeny("PreToolUse", "sidequest: dispatch executor requires the exact prepared FIRST action briefing command and executor. Re-run dispatch and pass its spawn unchanged.");
      return;
    }
    const route = preparedRoute;
    const expectedMarker = route?.marker ?? route?.model;
    if (!route || markers.length !== 1 || markers[0]?.model !== expectedMarker || markers[0]?.effort !== route.effort) {
      writeDeny("PreToolUse", `sidequest: ticket resolved route is ${route?.model || "unavailable"} / ${route?.effort || "unavailable"}. Re-run dispatch and pass its spawn unchanged.`);
      return;
    }
  }
  if (!isCurrentExecutor(classification)) {
    if (!type.startsWith("sidequest-") && admission.status === "routed") recordDeniedGenericWork(input, toolInput);
    writeDeny("PreToolUse", agentDenyReason(input, type, classification));
    return;
  }
  const subagentOverride = String(process.env.CLAUDE_CODE_SUBAGENT_MODEL || "").trim();
  if (subagentOverride) {
    writeDeny(
      "PreToolUse",
      `sidequest: CLAUDE_CODE_SUBAGENT_MODEL="${subagentOverride}" is set — it overrides every sidequest executor's routed model (a Codex route would silently run on a Claude model; builtins collapse to one route), defeating routing. Unset it before spawning sidequest executors.`
    );
    return;
  }
  if (preparedSpawn?.continuationWorktree && Object.hasOwn(toolInput, "isolation") && !isSubagentCaller(input)) {
    writeDeny(
      "PreToolUse",
      `sidequest: ${preparedSpawn.ref} continues the retained checkout ${preparedSpawn.continuationWorktree}, so its prepared spawn carries no isolation field. Spawn it unchanged: an added isolation asks the harness to create a checkout the board cannot bind, and the Agent call fails before the executor starts.`
    );
    return;
  }
  const reducedAgentSchema = preparedSpawn?.reducedAgentSchema === true;
  const permissionFields = spawnPermissionFields(reducedAgentSchema, type);
  const updatedInput = {
    ...toolInput,
    ...permissionFields,
    ...!reducedAgentSchema && isSubagentCaller(input) ? { run_in_background: true } : {}
  };
  if (reducedAgentSchema) delete updatedInput.name;
  if (!permissionFields.mode) delete updatedInput.mode;
  if (isSubagentCaller(input)) delete updatedInput.isolation;
  const corrections = [];
  if (preparedSpawn?.description && toolInput.description !== preparedSpawn.description) {
    updatedInput.description = preparedSpawn.description;
    corrections.push("description");
  }
  if (preparedSpawn && !reducedAgentSchema && toolInput.name !== preparedSpawn.name) {
    updatedInput.name = preparedSpawn.name;
    corrections.push("name");
  }
  const requestedAgentName = typeof toolInput.name === "string" ? toolInput.name : null;
  const launchAgentName = preparedSpawn?.name || requestedAgentName || dispatchAgentName(input);
  if (launchAgentName && !reducedAgentSchema) updatedInput.name = launchAgentName;
  const preparedCorrection = correctionMessage(corrections);
  if (FRONTMATTER_MODEL_KINDS.has(classification.kind)) {
    const hadModel = Object.prototype.hasOwnProperty.call(toolInput, "model");
    if (hadModel) delete updatedInput.model;
    recordAuthoritativeLaunch(input, type, launchAgentName);
    const messages = [
      preparedCorrection,
      hadModel ? `sidequest: removed the Agent model override for ${type}; its frontmatter pin selects the routed backend.` : null
    ].filter((message) => Boolean(message));
    writeToolUpdate(updatedInput, messages.join(" "));
    return;
  }
  const hasModel = Object.prototype.hasOwnProperty.call(toolInput, "model") && toolInput.model != null && toolInput.model !== "";
  if (!hasModel) {
    const result2 = resolveStampedModel(input);
    if (result2.status === "ok" && result2.model) {
      updatedInput.model = result2.model;
      recordAuthoritativeLaunch(input, type, launchAgentName);
      writeToolUpdate(updatedInput, [
        preparedCorrection,
        `sidequest: ${type} spawned without a model — injected "${result2.model}" from ${result2.refs.join(", ")}'s resolved category route. Always pass model: exec.model on Claude routes.`
      ].filter(Boolean).join(" "));
      return;
    }
    writeDeny("PreToolUse", denyReason(result2, type));
    return;
  }
  const result = resolveStampedModel(input);
  if (admission.status === "routed" && (result.status === "no-refs" || result.status === "ticket-not-found")) {
    writeDeny("PreToolUse", denyReason(result, type));
    return;
  }
  if (result.status === "ok" && result.model !== toolInput.model) {
    recordAuthoritativeLaunch(input, type, launchAgentName);
    writeToolUpdate(updatedInput, [
      preparedCorrection,
      `sidequest: ${type} was spawned with model "${String(toolInput.model)}" but ${result.refs.join(", ")} resolves to "${result.model}" — kept the caller's value; confirm the cap is deliberate.`
    ].filter(Boolean).join(" "));
    return;
  }
  recordAuthoritativeLaunch(input, type, launchAgentName);
  writeToolUpdate(updatedInput, preparedCorrection);
}
try {
  main();
} catch (_) {
  process.exit(0);
}
