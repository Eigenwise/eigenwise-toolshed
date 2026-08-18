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

// src/hooks/force-exec-bypass.ts
var import_node_child_process = require("node:child_process");
var import_node_fs3 = __toESM(require("node:fs"));
var import_node_os2 = __toESM(require("node:os"));
var import_node_path3 = __toESM(require("node:path"));

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
function writeContext(hookEventName, additionalContext) {
  writeJson({ hookSpecificOutput: { hookEventName, additionalContext: projectedText(hookEventName, additionalContext) } });
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

// src/lib/exec-names.ts
var EFFORTS = Object.freeze(["low", "medium", "high", "xhigh", "max"]);
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

// src/hooks/force-exec-bypass.ts
var { canonicalPath } = require(import_node_path3.default.join(__dirname, "..", "lib", "worktrees.js"));
var PASS_THROUGH_AGENT_TYPES = /* @__PURE__ */ new Set(["Explore", "claude-code-guide", "statusline-setup"]);
var EXECUTOR_HELPER_TYPES = /* @__PURE__ */ new Set(["Explore", "claude-code-guide", "web-researcher", "general-purpose"]);
var HELPER_REVIEW_WORK_RE = /\b(?:audits?|auditors?|auditing|audited|reviews?|reviewers?|reviewing|reviewed|review-audit)\b/i;
var WRITE_TOOLS = /* @__PURE__ */ new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
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
function isCurrentExecutor(classification) {
  return classification.kind === "claude_builtin" || classification.kind === "codex_dispatch" || classification.kind === "read_only_claude_builtin" || classification.kind === "read_only_codex_dispatch";
}
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
  const sessionPaths = transcriptPath ? [transcriptPath, import_node_path3.default.join(import_node_path3.default.dirname(transcriptPath), "subagents")] : [];
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
function agentDenyReason(type, classification) {
  if (type.startsWith("sidequest-")) {
    if (classification.kind === "ticket" || classification.kind === "legacy_ticket") {
      return `sidequest: ${type} looks like a Sidequest executor name but is invalid or retired. Re-run dispatch and spawn the returned executor.`;
    }
    return `sidequest: ${type} is an unknown Sidequest agent type. Use the executor returned by dispatch.`;
  }
  return `sidequest: ${type || "custom"} is a generic Agent, not a Sidequest ticket executor. For a tiny lookup, use Read, Glob, Grep, or WebFetch inline, not WebSearch. A usable route needs a fresh Board MCP dispatch and its exact returned executor. Board MCP is the lifecycle authority: reload or reconnect Sidequest, then re-dispatch. Do not use a raw Agent or Sidequest CLI fallback. Any delegated work, including a quick investigation, needs a ticket: file a spike (usually codebase-exploration), route it, dispatch it, then spawn the returned executor. The blocked work still gates any dependent action: do not proceed to a PR, merge, publish, or ship until its ticket is filed, dispatched, and closed; rerouting around this block is a violation.`;
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
function dispatchAdmission(input) {
  const toolInput = toolInputOf(input);
  const project = extractProjectArg(toolInput?.prompt) || stringField(input, "cwd") || process.env.CLAUDE_PROJECT_DIR;
  if (!project) return { status: "no-project" };
  try {
    const store = require(runtimeModule("store"));
    const found = store.findProject(project);
    return found.ok && found.slug ? store.projectDispatchAdmission(found.slug) : { status: "no-project" };
  } catch (_) {
    return { status: "no-project" };
  }
}
var ROUTE_MARKER_RE = /^\[sidequest-route model=([a-z0-9][a-z0-9.-]{0,63}) effort=(low|medium|high|xhigh|max)\]$/gm;
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
        description: typeof description === "string" && description ? description : null,
        executor: typeof ticket.dispatchExecutor === "string" ? ticket.dispatchExecutor : "",
        name: ticket.dispatch.launchName || dispatchLaunchName(ticket.ref || ref, ticket.title, resolvedExec, route?.effort, ticket.dispatch.launchSeq),
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
    for (const project of store.listProjects({ all: true })) {
      for (const ticket of store.listTickets(project.slug)) {
        if (!ticket.ref || ticket.dispatch?.sessionId !== sessionId || !ticket.dispatch?.terminalAt || ticket.claim?.by || !dispatchIdentityMatches(ticket, agentId, executor)) continue;
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
    return matches.length === 1 ? matches[0] || null : null;
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
  return { ref: ticket.ref, projectPath, files: store.effectiveScope(project, ticket.files) };
}
function helperScopes(input) {
  const agentId = stringField(input, "agent_id", "agentId");
  const type = stringField(input, "agent_type", "agentType", "subagent_type");
  const sessionId = stringField(input, "session_id", "sessionId") || process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || "";
  if (!agentId || !type || !sessionId || isCurrentExecutor(classifyExecutor(type))) return { status: "no-active-ticket", scopes: [] };
  try {
    const store = require(runtimeModule("store"));
    const activeTickets = [];
    const recoveryTickets = [];
    for (const project of store.listProjects({ all: true })) {
      const projectPath = String(store.readMeta(project.slug)?.path || "").trim();
      if (!projectPath) continue;
      for (const ticket of store.listTickets(project.slug)) {
        if (!ticket.ref || ticket.dispatch?.sessionId !== sessionId) continue;
        const candidate = { project: project.slug, projectPath, ticket };
        if (ticket.claim?.by && !ticket.dispatch?.terminalAt) activeTickets.push(candidate);
        if (dispatchIdentityMatches(ticket, agentId, type)) recoveryTickets.push(candidate);
      }
    }
    const ownedTickets = activeTickets.filter(({ ticket }) => dispatchIdentityMatches(ticket, agentId, type));
    if (ownedTickets.length === 1) {
      const owner = ownedTickets[0];
      return { status: "ok", scopes: [helperScope(store, owner.project, owner.projectPath, owner.ticket)] };
    }
    if (ownedTickets.length > 1) return { status: "no-owner", scopes: ownedTickets.map((owner) => helperScope(store, owner.project, owner.projectPath, owner.ticket)) };
    if (recoveryTickets.length === 1) {
      const owner = recoveryTickets[0];
      return { status: "recovery-owner", scopes: [helperScope(store, owner.project, owner.projectPath, owner.ticket)] };
    }
    if (activeTickets.length === 1) {
      const owner = activeTickets[0];
      return { status: "ok", scopes: [helperScope(store, owner.project, owner.projectPath, owner.ticket)] };
    }
    return { status: activeTickets.length ? "no-owner" : "no-active-ticket", scopes: activeTickets.map((owner) => helperScope(store, owner.project, owner.projectPath, owner.ticket)) };
  } catch (_) {
    return { status: "no-active-ticket", scopes: [] };
  }
}
function writeTarget(input) {
  const toolInput = toolInputOf(input);
  if (!toolInput) return "";
  const raw = toolInput.file_path ?? toolInput.notebook_path ?? toolInput.path;
  if (raw == null || !String(raw).trim()) return "";
  const cwd = stringField(input, "cwd") || process.cwd();
  return import_node_path3.default.resolve(cwd, String(raw));
}
function restoresCommittedContent(input, target) {
  try {
    const toolInput = toolInputOf(input);
    const toolName = stringField(input, "tool_name");
    let restored;
    if (toolName === "Write" && typeof toolInput?.content === "string") {
      restored = toolInput.content;
    } else if (toolName === "Edit" && typeof toolInput?.old_string === "string" && typeof toolInput.new_string === "string") {
      const current = import_node_fs3.default.readFileSync(target, "utf8");
      const first = current.indexOf(toolInput.old_string);
      if (first < 0 || !toolInput.replace_all && current.indexOf(toolInput.old_string, first + toolInput.old_string.length) >= 0) return false;
      restored = toolInput.replace_all ? current.split(toolInput.old_string).join(toolInput.new_string) : `${current.slice(0, first)}${toolInput.new_string}${current.slice(first + toolInput.old_string.length)}`;
    } else {
      return false;
    }
    const repository = canonicalPath((0, import_node_child_process.execFileSync)("git", ["rev-parse", "--show-toplevel"], {
      cwd: import_node_path3.default.dirname(target),
      encoding: "utf8",
      windowsHide: true
    }).trim());
    const relative = import_node_path3.default.relative(repository, canonicalPath(target)).replace(/\\/g, "/");
    if (!relative || relative === ".." || relative.startsWith("../") || import_node_path3.default.isAbsolute(relative)) return false;
    const committed = (0, import_node_child_process.execFileSync)("git", ["show", `HEAD:${relative}`], {
      cwd: repository,
      windowsHide: true
    });
    return Buffer.from(restored, "utf8").equals(committed);
  } catch (_) {
    return false;
  }
}
function relativeInside(root, target) {
  const relative = import_node_path3.default.relative(root, target).replace(/\\/g, "/");
  return relative && relative !== ".." && !relative.startsWith("../") && !import_node_path3.default.isAbsolute(relative) ? relative : null;
}
function linkedWorktreeRelative(target, projectPath) {
  let existing = import_node_path3.default.dirname(target);
  while (!import_node_fs3.default.existsSync(existing)) {
    const parent = import_node_path3.default.dirname(existing);
    if (parent === existing) return null;
    existing = parent;
  }
  try {
    const checkout = canonicalPath((0, import_node_child_process.execFileSync)("git", ["rev-parse", "--show-toplevel"], {
      cwd: existing,
      encoding: "utf8",
      windowsHide: true
    }).trim());
    const commonOutput = (0, import_node_child_process.execFileSync)("git", ["rev-parse", "--git-common-dir"], {
      cwd: checkout,
      encoding: "utf8",
      windowsHide: true
    }).trim();
    const common = canonicalPath(import_node_path3.default.isAbsolute(commonOutput) ? commonOutput : import_node_path3.default.resolve(checkout, commonOutput));
    if (common !== canonicalPath(import_node_path3.default.join(projectPath, ".git"))) return null;
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
  const relative = projectRelative(canonicalPath(target), canonicalPath(scope.projectPath));
  if (!relative) return false;
  const key = process.platform === "win32" ? relative.toLowerCase() : relative;
  return scope.files.some((file) => {
    const normalized = String(file || "").trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
    const scopeKey = process.platform === "win32" ? normalized.toLowerCase() : normalized;
    return key === scopeKey || key.startsWith(`${scopeKey}/`);
  });
}
function isScratchpadPath(target) {
  const configuredRoot = process.env.CLAUDE_SCRATCHPAD_DIR || process.env.CLAUDE_CODE_SCRATCHPAD_DIR;
  const roots = [configuredRoot, import_node_path3.default.join(import_node_os2.default.tmpdir(), "claude")].filter((root) => Boolean(root));
  return roots.some((root) => {
    const relative = import_node_path3.default.relative(import_node_path3.default.resolve(root), target);
    return Boolean(relative) && relative !== ".." && !relative.startsWith(`..${import_node_path3.default.sep}`) && !import_node_path3.default.isAbsolute(relative);
  });
}
function guardHelperWrite(input) {
  const resolution = helperScopes(input);
  if (resolution.status === "no-active-ticket") return;
  const target = writeTarget(input);
  if (!target) return;
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
  if (isScratchpadPath(target) || inScope(target, scope)) return;
  const display = projectRelative(target, scope.projectPath) || target;
  writeDeny(
    "PreToolUse",
    `sidequest: refusing helper write to ${display}. It is outside ${scope.ref}'s effective scope. Route this path through the parent executor as a scope request or file a new ticket.`
  );
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
  if (toolName === "SendMessage") {
    guardLateSteer(input);
    return;
  }
  if (WRITE_TOOLS.has(toolName)) {
    guardHelperWrite(input);
    return;
  }
  if (toolName !== "Agent") return;
  const toolInput = toolInputOf(input);
  if (!toolInput) return;
  const type = String(toolInput.subagent_type || "");
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
    writeDeny("PreToolUse", agentDenyReason(type, classification));
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
  const updatedInput = {
    ...toolInput,
    mode: "bypassPermissions",
    ...isSubagentCaller(input) ? { run_in_background: true } : {}
  };
  if (isSubagentCaller(input)) delete updatedInput.isolation;
  const corrections = [];
  if (preparedSpawn?.description && toolInput.description !== preparedSpawn.description) {
    updatedInput.description = preparedSpawn.description;
    corrections.push("description");
  }
  if (preparedSpawn && toolInput.name !== preparedSpawn.name) {
    updatedInput.name = preparedSpawn.name;
    corrections.push("name");
  }
  const requestedAgentName = typeof toolInput.name === "string" ? toolInput.name : null;
  const launchAgentName = preparedSpawn?.name || requestedAgentName || dispatchAgentName(input);
  if (launchAgentName) updatedInput.name = launchAgentName;
  const preparedCorrection = correctionMessage(corrections);
  if (isDispatchExecutor) {
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
