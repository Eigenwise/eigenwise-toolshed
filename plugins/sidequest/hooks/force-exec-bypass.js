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

// src/hooks/force-exec-bypass.ts
var PASS_THROUGH_AGENT_TYPES = /* @__PURE__ */ new Set(["Explore", "claude-code-guide", "statusline-setup"]);
function fallbackClassify(type) {
  const readOnlyDispatch = /^sidequest-exec-dispatch-readonly-(low|medium|high|xhigh|max)$/.exec(type);
  if (readOnlyDispatch) return { kind: "read_only_codex_dispatch", effort: readOnlyDispatch[1] || null };
  const readOnlyBuiltin = /^sidequest-exec-readonly-(low|medium|high|xhigh|max)$/.exec(type);
  if (readOnlyBuiltin) return { kind: "read_only_claude_builtin", effort: readOnlyBuiltin[1] || null };
  const dispatch = /^sidequest-exec-dispatch-(low|medium|high|xhigh|max)$/.exec(type);
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
function isExecutorCaller(input) {
  if (!stringField(input, "agent_id")) return false;
  const type = stringField(input, "agent_type");
  if (!type) return false;
  return isCurrentExecutor(classifyExecutor(type)) || type.startsWith("sidequest-sq-") || type.startsWith("sidequest-ticket-") || type.startsWith("sidequest-native-");
}
function agentDenyReason(type, classification) {
  if (type.startsWith("sidequest-")) {
    if (classification.kind === "ticket" || classification.kind === "legacy_ticket") {
      return `sidequest: ${type} looks like a Sidequest executor name but is invalid or retired. Re-run dispatch and spawn the returned executor.`;
    }
    return `sidequest: ${type} is an unknown Sidequest agent type. Use the executor returned by dispatch.`;
  }
  return `sidequest: ${type || "custom"} is a generic Agent, not a Sidequest ticket executor. For a tiny lookup, use Read, Glob, Grep, or WebFetch inline. Any delegated work, including a quick investigation, needs a ticket: file a spike (usually codebase-exploration), route it, dispatch it, then spawn the returned executor.`;
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
function dispatchLaunches(prompt) {
  if (typeof prompt !== "string" || !prompt) return [];
  const headings = [...prompt.matchAll(/^Ref:\s*(SQ-\d+)\s*$/gim)];
  const launches = headings.map((match, index) => {
    const next = headings[index + 1];
    const section = prompt.slice(match.index, next ? next.index : prompt.length);
    return { ref: (match[1] || "").toUpperCase(), token: extractDispatchToken(section) };
  }).filter((launch) => Boolean(launch.ref && launch.token));
  if (launches.length) return launches;
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
  const refs = extractRefs(toolInput?.prompt);
  const token = extractDispatchToken(toolInput?.prompt);
  if (refs.length !== 1 || !token) return null;
  return `sidequest-${(refs[0] || "").toLowerCase()}-${token.slice(0, 12)}`;
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
  const refs = extractRefs(prompt);
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
        name: `sidequest-${launch.ref.toLowerCase()}-${launch.token.slice(0, 12)}`,
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
function main() {
  const input = readStdin();
  if (!input) return;
  const toolInput = toolInputOf(input);
  if (!toolInput) return;
  const type = String(toolInput.subagent_type || "");
  if (PASS_THROUGH_AGENT_TYPES.has(type)) return;
  const classification = classifyExecutor(type);
  if (!isCurrentExecutor(classification)) {
    if (isExecutorCaller(input) && !type.startsWith("sidequest-")) {
      writeJson({
        systemMessage: "sidequest: executor fan-out is allowed for this ticket. Spawn unnamed subagents only, keep them inside the ticket scope, and never file, route, or dispatch board tickets from an executor."
      });
      return;
    }
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
  const updatedInput = { ...toolInput, mode: "bypassPermissions" };
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
      writeDeny("PreToolUse", "sidequest: dispatch route marker must match the prepared spawn. Re-run dispatch and pass the returned spawn unchanged.");
      return;
    }
    if (!routeModels.length) {
      writeDeny("PreToolUse", "sidequest: dispatch executor is missing the route marker from spawn.prompt. Re-run dispatch and pass the returned spawn unchanged.");
      return;
    }
    const mismatch = markers.find((marker) => marker.effort !== classification.effort);
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
