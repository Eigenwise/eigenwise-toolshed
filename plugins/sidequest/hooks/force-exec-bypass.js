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
var import_node_fs2 = __toESM(require("node:fs"));
var import_node_os = __toESM(require("node:os"));
var import_node_path2 = __toESM(require("node:path"));

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

// src/hooks/shared/paths.ts
var import_node_path = __toESM(require("node:path"));
function pluginRoot() {
  return process.env.CLAUDE_PLUGIN_ROOT || import_node_path.default.join(__dirname, "..");
}
function runtimeModule(name) {
  return import_node_path.default.join(pluginRoot(), "lib", `${name}.js`);
}

// src/lib/exec-names.ts
var EFFORTS = Object.freeze(["low", "medium", "high", "xhigh", "max"]);
var AGENT_NAME_MAX_LENGTH = 64;
var LAUNCH_SLUG_MAX_WORDS = 3;
var LAUNCH_SLUG_MAX_LENGTH = 24;
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
function dispatchLaunchName(ref, title, sequence) {
  const base = refSlug(ref) || "sidequest";
  const slug = titleSlug(title);
  const seq = Number(sequence);
  const suffix = Number.isInteger(seq) && seq > 1 ? `-${seq}` : "";
  let name = slug ? `${base}-${slug}` : base;
  const budget = AGENT_NAME_MAX_LENGTH - suffix.length;
  if (name.length > budget) name = name.slice(0, budget).replace(/-+$/, "");
  return `${name}${suffix}`;
}

// src/hooks/force-exec-bypass.ts
var { canonicalPath } = require(import_node_path2.default.join(__dirname, "..", "lib", "worktrees.js"));
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
  if (/^sidequest-ticket-/.test(type)) return { kind: "legacy_ticket", effort: null };
  if (/^sidequest-(?:sq-|exec-)/.test(type)) return { kind: "ticket", effort: null };
  return { kind: "unknown", effort: null };
}
function classifyExecutor(type) {
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
  const sessionPaths = transcriptPath ? [transcriptPath, import_node_path2.default.join(import_node_path2.default.dirname(transcriptPath), "subagents")] : [];
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
  writeJson({
    systemMessage: "sidequest: executor helpers run in the background from the parent working tree. If the target is unavailable there, report the visibility block instead of returning clean findings.",
    hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput }
  });
}
function agentDenyReason(type, classification) {
  if (type.startsWith("sidequest-")) {
    if (classification.kind === "ticket" || classification.kind === "legacy_ticket") {
      return `sidequest: ${type} looks like a Sidequest executor name but is invalid or retired. Re-run dispatch and spawn the returned executor.`;
    }
    return `sidequest: ${type} is an unknown Sidequest agent type. Use the executor returned by dispatch.`;
  }
  return `sidequest: ${type || "custom"} is a generic Agent, not a Sidequest ticket executor. For a tiny lookup, use Read, Glob, Grep, or WebFetch inline, not WebSearch. WebSearch is executor-only: file and dispatch a research ticket. Any delegated work, including a quick investigation, needs a ticket: file a spike (usually codebase-exploration), route it, dispatch it, then spawn the returned executor. The blocked work still gates any dependent action: do not proceed to a PR, merge, publish, or ship until its ticket is filed, dispatched, and closed; rerouting around this block is a violation.`;
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
function extractDispatchToken(prompt) {
  if (typeof prompt !== "string" || !prompt) return null;
  const matches = [...prompt.matchAll(/--token\s+([^\s`"']+)/g)];
  const match = matches.at(-1);
  return match ? match[1] || null : null;
}
function dispatchRefs(prompt) {
  if (typeof prompt !== "string" || !prompt) return [];
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const match of prompt.matchAll(/briefing\s+(SQ-\d+)\s+--token\s+[^\s`"']+/gi)) {
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
    return { ref: (match[1] || "").toUpperCase(), token: extractDispatchToken(section) };
  }).filter((launch) => Boolean(launch.ref && launch.token));
  if (launches.length) return launches;
  const briefings = [...prompt.matchAll(/briefing\s+(SQ-\d+)\s+--token\s+([^\s`"']+)/gi)].map((match) => ({ ref: (match[1] || "").toUpperCase(), token: match[2] || "" })).filter((launch) => Boolean(launch.ref && launch.token));
  if (briefings.length) return briefings;
  const refs = extractRefs(prompt);
  const tokens = [...prompt.matchAll(/--token\s+([^\s`"']+)/g)].map((match) => match[1] || "");
  if (refs.length === tokens.length) return refs.map((ref, index) => ({ ref, token: tokens[index] || "" }));
  return refs.length === 1 && tokens.length === 1 ? [{ ref: refs[0] || "", token: tokens[0] || "" }] : [];
}
function toolInputOf(input) {
  return isRecord(input.tool_input) ? input.tool_input : null;
}
function dispatchAgentName(input) {
  const toolInput = toolInputOf(input);
  const dispatched = dispatchRefs(toolInput?.prompt);
  const refs = dispatched.length ? dispatched : extractRefs(toolInput?.prompt);
  const token = extractDispatchToken(toolInput?.prompt);
  if (refs.length !== 1 || !token) return null;
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
        token: launch.token,
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
var ROUTE_MARKER_RE = /^\[sidequest-route model=([a-z0-9][a-z0-9.-]{0,63}) effort=(low|medium|high|xhigh|max)\]$/gm;
function dispatchRouteMarkers(input) {
  const prompt = toolInputOf(input)?.prompt;
  if (typeof prompt !== "string" || !prompt) return [];
  return [...prompt.matchAll(ROUTE_MARKER_RE)].map((match) => ({ model: match[1] || "", effort: match[2] || "" }));
}
function preparedDispatchValidation(input) {
  const toolInput = toolInputOf(input);
  if (!toolInput) return { status: "none" };
  const launches = dispatchLaunches(toolInput.prompt);
  if (launches.length !== 1) return { status: "none" };
  const launch = launches[0];
  const project = extractProjectArg(toolInput.prompt) || stringField(input, "cwd") || process.env.CLAUDE_PROJECT_DIR;
  if (!launch || !project) return { status: "none" };
  try {
    const store = require(runtimeModule("store"));
    const found = store.findProject(project);
    if (!found.ok || !found.slug) return { status: "none" };
    const ticket = store.getTicket(found.slug, launch.ref);
    if (!ticket) return { status: "none" };
    if (ticket.dispatchNonce !== launch.token) return { status: "stale" };
    const description = ticket.dispatch?.description;
    const route = ticket.dispatch?.route;
    return {
      status: "valid",
      spawn: {
        description: typeof description === "string" && description ? description : null,
        // Records prepared before launch naming existed still get a readable
        // name: ref plus title is the same derivation the store now stores.
        name: ticket.dispatch?.launchName || dispatchLaunchName(ticket.ref || launch.ref, ticket.title, ticket.dispatch?.launchSeq),
        ref: launch.ref,
        token: launch.token,
        project,
        route: typeof route?.model === "string" && typeof route.effort === "string" ? { model: route.model, effort: route.effort, marker: typeof route.marker === "string" && route.marker ? route.marker : null } : null
      }
    };
  } catch (_) {
    return { status: "none" };
  }
}
function briefingCommandDrifted(prompt, spawn) {
  if (typeof prompt !== "string" || !/FIRST action:\s*run/i.test(prompt)) return false;
  const command = /FIRST action:\s*run\s+`([^`]+)`/i.exec(prompt)?.[1];
  if (!command) return true;
  const refs = extractRefs(command);
  return !/sidequest-launcher\.js["']?\s+briefing\b/i.test(command) || refs.length !== 1 || refs[0] !== spawn.ref || extractDispatchToken(command) !== spawn.token || extractProjectArg(command) !== spawn.project;
}
function correctionMessage(corrections) {
  return corrections.length ? `sidequest: corrected prepared dispatch ${corrections.join(" and ")}.` : null;
}
function denyReason(result, type) {
  const retry = "Re-read the wave (`ready --brief`) and re-spawn with `model: exec.model`.";
  const base = `sidequest: ${type} was spawned without \`model\` and it couldn't be resolved`;
  switch (result.status) {
    case "no-refs":
      return `${base} — no SQ-\\d+ ticket ref was found in the prompt. ${retry}`;
    case "no-project":
      return `${base} — the board for ${result.refs.join(", ")} couldn't be determined (no --project, cwd, or CLAUDE_PROJECT_DIR resolved to a registered board). ${retry}`;
    case "ticket-not-found":
      return `${base} — ${result.missing} wasn't found on the resolved board. ${retry}`;
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
  return import_node_path2.default.resolve(cwd, String(raw));
}
function restoresCommittedContent(input, target) {
  try {
    const toolInput = toolInputOf(input);
    const toolName = stringField(input, "tool_name");
    let restored;
    if (toolName === "Write" && typeof toolInput?.content === "string") {
      restored = toolInput.content;
    } else if (toolName === "Edit" && typeof toolInput?.old_string === "string" && typeof toolInput.new_string === "string") {
      const current = import_node_fs2.default.readFileSync(target, "utf8");
      const first = current.indexOf(toolInput.old_string);
      if (first < 0 || !toolInput.replace_all && current.indexOf(toolInput.old_string, first + toolInput.old_string.length) >= 0) return false;
      restored = toolInput.replace_all ? current.split(toolInput.old_string).join(toolInput.new_string) : `${current.slice(0, first)}${toolInput.new_string}${current.slice(first + toolInput.old_string.length)}`;
    } else {
      return false;
    }
    const repository = canonicalPath((0, import_node_child_process.execFileSync)("git", ["rev-parse", "--show-toplevel"], {
      cwd: import_node_path2.default.dirname(target),
      encoding: "utf8",
      windowsHide: true
    }).trim());
    const relative = import_node_path2.default.relative(repository, canonicalPath(target)).replace(/\\/g, "/");
    if (!relative || relative === ".." || relative.startsWith("../") || import_node_path2.default.isAbsolute(relative)) return false;
    const committed = (0, import_node_child_process.execFileSync)("git", ["show", `HEAD:${relative}`], {
      cwd: repository,
      windowsHide: true
    });
    return Buffer.from(restored, "utf8").equals(committed);
  } catch (_) {
    return false;
  }
}
function projectRelative(target, projectPath) {
  const relative = import_node_path2.default.relative(projectPath, target).replace(/\\/g, "/");
  if (!relative || relative === ".." || relative.startsWith("../") || import_node_path2.default.isAbsolute(relative)) return null;
  const worktree = /^\.claude\/worktrees\/[^/]+\/(.+)$/.exec(relative);
  return worktree ? worktree[1] || null : relative;
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
  const roots = [configuredRoot, import_node_path2.default.join(import_node_os.default.tmpdir(), "claude")].filter((root) => Boolean(root));
  return roots.some((root) => {
    const relative = import_node_path2.default.relative(import_node_path2.default.resolve(root), target);
    return Boolean(relative) && relative !== ".." && !relative.startsWith(`..${import_node_path2.default.sep}`) && !import_node_path2.default.isAbsolute(relative);
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
  if (PASS_THROUGH_AGENT_TYPES.has(type)) return;
  if (!isCurrentExecutor(classification)) {
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
  const dispatchValidation = preparedDispatchValidation(input);
  if (dispatchValidation.status === "stale") {
    writeDeny("PreToolUse", "sidequest: dispatch token is stale or rotated. Re-run dispatch and pass its spawn unchanged.");
    return;
  }
  const preparedSpawn = dispatchValidation.spawn;
  if (preparedSpawn && briefingCommandDrifted(toolInput.prompt, preparedSpawn)) {
    writeDeny("PreToolUse", "sidequest: dispatch briefing command must match the prepared spawn. Re-run dispatch and pass its spawn unchanged.");
    return;
  }
  const corrections = [];
  if (preparedSpawn?.description && toolInput.description !== preparedSpawn.description) {
    updatedInput.description = preparedSpawn.description;
    corrections.push("description");
  }
  if (preparedSpawn && toolInput.name !== preparedSpawn.name) {
    updatedInput.name = preparedSpawn.name;
    corrections.push("name");
  }
  const launchAgentName = preparedSpawn?.name || dispatchAgentName(input);
  if (launchAgentName) updatedInput.name = launchAgentName;
  const preparedCorrection = correctionMessage(corrections);
  if (classification.kind === "codex_dispatch" || classification.kind === "read_only_codex_dispatch") {
    const markers = dispatchRouteMarkers(input);
    const routeModels = [...new Set(markers.map((marker) => marker.model))];
    if (preparedSpawn?.route && markers.some((marker) => marker.model !== (preparedSpawn.route?.marker ?? preparedSpawn.route?.model) || marker.effort !== preparedSpawn.route?.effort)) {
      const route = preparedSpawn.route;
      const resolvedRoute = route ? `${route.model} / ${route.effort}` : "the prepared ticket route";
      writeDeny("PreToolUse", `sidequest: ticket resolved route is ${resolvedRoute}. A model cannot be overridden at spawn time. Set this ticket's route override before dispatching, then re-run dispatch and pass the returned spawn unchanged.`);
      return;
    }
    if (!routeModels.length) {
      writeDeny("PreToolUse", "sidequest: dispatch executor is missing the route marker from spawn.prompt. Re-run dispatch and pass the returned spawn unchanged.");
      return;
    }
    const mismatch = classification.effort === null ? null : markers.find((marker) => marker.effort !== classification.effort);
    if (mismatch) {
      writeDeny("PreToolUse", `sidequest: dispatch executor effort "${classification.effort}" does not match route marker effort "${mismatch.effort}". Re-run dispatch and pass the returned spawn unchanged.`);
      return;
    }
    if (routeModels.length > 1) {
      writeDeny(
        "PreToolUse",
        `sidequest: this batch mixes tickets stamped with different models (${routeModels.join(", ")}) under one dispatch executor — every ticket would silently run on the last route marker's model. Split the batch per model and re-spawn each with its own dispatch prompt.`
      );
      return;
    }
    const hadModel = Object.prototype.hasOwnProperty.call(toolInput, "model");
    if (hadModel) delete updatedInput.model;
    recordAuthoritativeLaunch(input, type, launchAgentName);
    const messages = [
      preparedCorrection,
      hadModel ? `sidequest: removed the Agent model override for ${type}; its frontmatter pin selects the routed backend.` : null
    ].filter((message) => Boolean(message));
    writeJson({
      ...messages.length ? { systemMessage: messages.join(" ") } : {},
      hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput }
    });
    return;
  }
  const hasModel = Object.prototype.hasOwnProperty.call(toolInput, "model") && toolInput.model != null && toolInput.model !== "";
  if (!hasModel) {
    const result2 = resolveStampedModel(input);
    if (result2.status === "ok" && result2.model) {
      updatedInput.model = result2.model;
      recordAuthoritativeLaunch(input, type, launchAgentName);
      writeJson({
        systemMessage: [
          preparedCorrection,
          `sidequest: ${type} spawned without a model — injected "${result2.model}" from ${result2.refs.join(", ")}'s resolved category route. Always pass model: exec.model on Claude routes.`
        ].filter(Boolean).join(" "),
        hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput }
      });
      return;
    }
    writeDeny("PreToolUse", denyReason(result2, type));
    return;
  }
  const result = resolveStampedModel(input);
  if (result.status === "ok" && result.model !== toolInput.model) {
    recordAuthoritativeLaunch(input, type, launchAgentName);
    writeJson({
      systemMessage: [
        preparedCorrection,
        `sidequest: ${type} was spawned with model "${String(toolInput.model)}" but ${result.refs.join(", ")} resolves to "${result.model}" — kept the caller's value; confirm the cap is deliberate.`
      ].filter(Boolean).join(" "),
      hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput }
    });
    return;
  }
  recordAuthoritativeLaunch(input, type, launchAgentName);
  writeJson({
    ...preparedCorrection ? { systemMessage: preparedCorrection } : {},
    hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput }
  });
}
try {
  main();
} catch (_) {
  process.exit(0);
}
