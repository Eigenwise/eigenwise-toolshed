"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { stableClaudeName, stableDispatchName, stableReadOnlyClaudeName, stableReadOnlyDispatchName } = require("./exec-names.js");
const crypto = require("crypto");
const store = require("./store.js");
const { spawnDescription } = store;
const TEMPLATE_PATH = path.join(__dirname, "..", "scripts", "_exec-template.md");
const LEGACY_MARKER = "<!-- generated-by: sidequest-agentsync -->";
const MARKER = "<!-- generated-by: sidequest-agentsync gen2 -->";
const TEMP_MARKER = "<!-- generated-by: sidequest-native-agent -->";
const TEMP_PREFIX = "sidequest-native-";
const TICKET_PREFIX = "sidequest-ticket-";
const RELOAD_NOTICE = "Reload plugins before spawning newly created temporary native agents.";
const RESTART_NOTICE = RELOAD_NOTICE;
const ARTIFACT_LIFECYCLE_MARKER = "[sidequest-artifact-mode]";
const NON_MAX_EFFORTS = ["low", "medium", "high", "xhigh"];
const EXEC_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const EXECUTOR_CHECKPOINT_TOOL_ROUNDS = 100;
const EXEC_MAX_TURNS = { low: 50, medium: 100, high: 150, xhigh: 200, max: 250 };
function execMaxTurns(effort) {
  const raw = process.env.SIDEQUEST_EXEC_MAX_TURNS;
  if (raw != null && String(raw).trim() !== "") {
    const n = Number(String(raw).trim());
    if (Number.isInteger(n) && n > 0) return n;
  }
  return EXEC_MAX_TURNS[effort] || EXEC_MAX_TURNS.medium;
}
function defaultAgentsDir() {
  const explicit = process.env.SIDEQUEST_AGENTS_DIR;
  if (explicit && String(explicit).trim()) return path.resolve(String(explicit).trim());
  const home = process.env.SIDEQUEST_HOME;
  if (home && String(home).trim()) return path.join(path.resolve(String(home).trim()), "agents");
  return path.join(os.homedir(), ".claude", "agents");
}
const DISPATCH_MODEL_ID = "claude-codex-auto";
const ROUTE_MODEL_RE = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const ROUTE_MARKER_RE = /^\[sidequest-route model=[a-z0-9][a-z0-9.-]{0,63} effort=(low|medium|high|xhigh|max)\]$/;
function routeMarker(dispatchModel, effort) {
  const model = String(dispatchModel || "");
  const markerEffort = String(effort || "");
  if (!ROUTE_MODEL_RE.test(model)) throw new Error(`dispatch model id is not marker-safe: ${dispatchModel}`);
  if (!EXEC_EFFORTS.includes(markerEffort)) throw new Error(`dispatch effort is not marker-safe: ${effort}`);
  const marker = `[sidequest-route model=${model} effort=${markerEffort}]`;
  if (!ROUTE_MARKER_RE.test(marker)) throw new Error("dispatch route marker does not match the gateway grammar.");
  return marker;
}
function workflowRecipe(category, resolved) {
  const exec = resolved && resolved.exec;
  if (!category || !exec) throw new Error("A resolved category route is required.");
  const recipe = {
    project: category.project,
    category: category.id,
    categoryName: category.name,
    backend: exec.backend,
    route: { model: resolved.model, effort: resolved.effort },
    runsLabel: exec.runsLabel,
    agent: null,
    effortCarrier: null,
    warnings: Array.isArray(resolved.warnings) ? resolved.warnings.slice() : []
  };
  if (exec.backend === "codex") {
    recipe.agent = {
      model: DISPATCH_MODEL_ID,
      promptPrefix: `${routeMarker(exec.dispatchModel, resolved.effort)}

`
    };
    recipe.effortCarrier = "marker";
  } else {
    recipe.agent = { model: exec.model, promptPrefix: "" };
    recipe.effortCarrier = "none";
  }
  return recipe;
}
const READ_ONLY_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "WebSearch",
  "WebFetch",
  "Bash",
  "ToolSearch",
  "SendMessage",
  "mcp__plugin_sidequest_board__*"
];
function readOnlyNote() {
  return "\n\n**Read-only role:** Your tools cannot change files. If this ticket requires an edit, write a board blocker comment naming the needed change and why, then release the ticket. Do not try to work around the tool restriction.";
}
function renderExecAgent({ name, effort, modelId, marker, extraNote, ticketBrief: ticketBrief2, tools }) {
  const template = fs.readFileSync(TEMPLATE_PATH, "utf8");
  const toolsLine = Array.isArray(tools) && tools.length ? `tools: ${tools.join(", ")}
` : "";
  return template.split("{{NAME}}").join(String(name)).split("{{EFFORT}}").join(String(effort)).split("{{MODEL_FRONTMATTER}}").join(modelId ? `
model: ${modelId}` : "").split("{{MAX_TURNS}}").join(String(execMaxTurns(String(effort)))).split("{{CHECKPOINT_TOOL_ROUNDS}}").join(String(EXECUTOR_CHECKPOINT_TOOL_ROUNDS)).split("permissionMode: bypassPermissions").join(`${toolsLine}permissionMode: bypassPermissions`).split("{{MARKER}}").join(marker || "").split("{{EXTRA_NOTE}}").join(extraNote || "").split("{{TICKET_BRIEF}}").join(`Teammate subagent fan-out must omit the Agent \`name\` parameter; named teammate spawns are rejected by the harness.${ticketBrief2 ? `

${ticketBrief2}` : ""}`);
}
function dispatchNote(effort) {
  return `

_This agent is the shared Sidequest executor for every Codex-backed route at \`${effort}\` effort. Its \`model: ${DISPATCH_MODEL_ID}\` pin is virtual: the codex-gateway shim resolves the real Codex model from the \`[sidequest-route model=... effort=...]\` line in your spawn prompt, whose effort mirrors this def frontmatter for gateway-side audit, so NEVER write, quote, or echo such a line anywhere else. If the gateway reports a missing route marker, stop and report it — the orchestrator must redispatch. Refuse a batch whose tickets are stamped with different models: one spawn carries exactly one route marker. The \`effort\` frontmatter above is forwarded to the model's reasoning effort._`;
}
function renderDispatchAgent(effort) {
  return renderExecAgent({
    name: stableDispatchName(effort),
    effort,
    modelId: DISPATCH_MODEL_ID,
    marker: MARKER,
    extraNote: dispatchNote(effort)
  });
}
function renderReadOnlyDispatchAgent(effort) {
  return renderExecAgent({
    name: stableReadOnlyDispatchName(effort),
    effort,
    modelId: DISPATCH_MODEL_ID,
    marker: MARKER,
    extraNote: `${dispatchNote(effort)}${readOnlyNote()}`,
    tools: READ_ONLY_TOOLS
  });
}
function renderReadOnlyClaudeAgent(effort) {
  return renderExecAgent({
    name: stableReadOnlyClaudeName(effort),
    effort,
    marker: MARKER,
    extraNote: readOnlyNote(),
    tools: READ_ONLY_TOOLS
  });
}
function refToken(ref) {
  return String(ref || "ticket").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "ticket";
}
function runtimeToken(runtime) {
  return String(runtime || "").toLowerCase().replace(/^codex-/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
function nativeAgentName(ref, runtime, nonce) {
  const ticket = refToken(ref);
  const token = runtimeToken(runtime);
  const base = token ? `${TEMP_PREFIX}${ticket}-${token}` : `${TEMP_PREFIX}${ticket}`;
  if (nonce == null || nonce === "") return base;
  const suffix = String(nonce).toLowerCase();
  if (!/^[a-z0-9]{6,32}$/.test(suffix)) throw new Error("native agent nonce must be 6-32 lowercase alphanumeric characters.");
  return `${base}-${suffix}`;
}
function temporaryAgentFile(name, dir) {
  if (!String(name || "").startsWith(TEMP_PREFIX)) {
    throw new Error("temporary agent name must use a Sidequest temporary prefix.");
  }
  return path.join(dir || defaultAgentsDir(), `${name}.md`);
}
function nativeAgentSource(spec) {
  const tools = Array.isArray(spec.tools) && spec.tools.length ? spec.tools : ["Read", "Glob", "Grep", "Edit", "Write", "Bash", "SendMessage"];
  if (!tools.every((tool) => /^[A-Za-z][A-Za-z0-9:_-]*$/.test(String(tool)))) throw new Error("native agent tools must be valid tool names.");
  const model = String(spec.modelId || "").trim();
  const effort = String(spec.effort || "").trim();
  const runtime = String(spec.runtime || spec.runsModel || "").trim();
  if (!model || /[\r\n]/.test(model)) throw new Error("native agent model id is required and must be one line.");
  if (!NON_MAX_EFFORTS.includes(effort)) throw new Error(`native agent effort must be one of: ${NON_MAX_EFFORTS.join(", ")}.`);
  if (!runtime || /[\r\n]/.test(runtime)) throw new Error("native agent runtime must be a concrete one-line model identifier.");
  const session = String(spec.sessionId || "").replace(/[\r\n]/g, "");
  return [
    "---",
    `name: ${spec.name}`,
    "description: Temporary Sidequest native executor. Removed after this run.",
    `model: ${model}`,
    `effort: ${effort}`,
    `tools: ${tools.join(", ")}`,
    "permissionMode: bypassPermissions",
    "---",
    TEMP_MARKER,
    `<!-- sidequest-native-session: ${session} -->`,
    `<!-- sidequest-native-runtime: ${runtime} -->`,
    "You are a temporary Sidequest executor. Follow the exact task prompt from your parent. Stay within its ticket scope, verify the requested behavior, and report concise evidence. The parent owns orchestration. Before ending after success or failure, run the cleanup command supplied in your task prompt.",
    ""
  ].join("\n");
}
function waitForNativeAgentReload(waitMs) {
  const ms = Number.isFinite(Number(waitMs)) ? Math.max(0, Number(waitMs)) : 175;
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
const TICKET_DESCRIPTION_MAX_BYTES = 8 * 1024;
const TICKET_COMMENTS_MAX_BYTES = 6 * 1024;
const TICKET_COMMENT_BODY_MAX_BYTES = 768;
const TICKET_PRIORITY_COMMENT_BODY_MAX_BYTES = 4 * 1024;
const TICKET_COMMENT_PACKET_MARKER_RESERVE_BYTES = 384;
function byteLength(value) {
  return Buffer.byteLength(String(value || ""), "utf8");
}
function utf8Excerpt(value, maxBytes) {
  const source = String(value || "");
  const limit = Math.max(0, Number(maxBytes) || 0);
  if (byteLength(source) <= limit) return { text: source, truncated: false };
  let text = "";
  let used = 0;
  for (const character of source) {
    const size = byteLength(character);
    if (used + size > limit) break;
    text += character;
    used += size;
  }
  return { text, truncated: true };
}
function boundedPacket(value, maxBytes, marker) {
  const source = String(value || "");
  const limit = Math.max(0, Number(maxBytes) || 0);
  if (byteLength(source) <= limit) return source;
  const suffix = String(marker || "");
  return `${utf8Excerpt(source, Math.max(0, limit - byteLength(suffix))).text}${suffix}`;
}
function commentBody(comment) {
  return comment && Object.hasOwn(comment, "body") ? String(comment.body) : String(comment || "");
}
function isPriorityComment(comment) {
  const kind = String(comment && comment.kind || "");
  const body = commentBody(comment);
  return /\b(?:decision|constraint)\b/i.test(kind) || /(?:^|\n)\s*(?:decision|constraint)\s*:/i.test(body);
}
function commentPacketEntry(comment, index, bodyLimit) {
  const body = commentBody(comment);
  const marker = "\n\n[Comment body excerpt truncated. Fetch specifics with compact comments reads.]";
  const excerpt = boundedPacket(body, bodyLimit, marker);
  return [
    `### Comment ${Number(index) + 1}`,
    `Author: ${comment && comment.by ? comment.by : "unknown"}`,
    `Kind: ${comment && comment.kind ? comment.kind : "comment"}`,
    `Recorded: ${comment && comment.at ? comment.at : "(timestamp unavailable)"}`,
    "Body:",
    excerpt
  ].join("\n");
}
function commentPacketMarker(omitted, excerpts, decisionInHistory) {
  const omittedText = omitted ? ` ${omitted} earlier comment(s) were omitted.` : "";
  const excerptText = excerpts ? ` ${excerpts} included comment body excerpt(s) were truncated.` : "";
  const historyText = decisionInHistory ? " A decision or constraint is in omitted history: fetch the full thread." : " Read the full thread only when this packet flags a decision or constraint in omitted history.";
  return `[Comment packet truncated.${omittedText}${excerptText} Fetch specifics with compact comments reads (latest-first).${historyText}]`;
}
function ticketDescriptionPacket(description) {
  return boundedPacket(
    description || "(No additional description was recorded.)",
    TICKET_DESCRIPTION_MAX_BYTES,
    "\n\n[Description truncated at 8 KB. Fetch ticket specifics before acting.]"
  );
}
function ticketCommentsPacket(comments) {
  if (!Array.isArray(comments) || !comments.length) return "(No ticket comments were recorded.)";
  const complete = comments.map((comment, index) => commentPacketEntry(comment, index, Number.MAX_SAFE_INTEGER)).join("\n\n");
  if (byteLength(complete) <= TICKET_COMMENTS_MAX_BYTES) return complete;
  const selected = [];
  let bytes = 0;
  for (let index = comments.length - 1; index >= 0; index--) {
    const comment = comments[index];
    const priority = isPriorityComment(comment);
    const entry = commentPacketEntry(
      comment,
      index,
      priority ? TICKET_PRIORITY_COMMENT_BODY_MAX_BYTES : TICKET_COMMENT_BODY_MAX_BYTES
    );
    const separatorBytes = selected.length ? byteLength("\n\n") : 0;
    if (bytes + separatorBytes + byteLength(entry) > TICKET_COMMENTS_MAX_BYTES - TICKET_COMMENT_PACKET_MARKER_RESERVE_BYTES) break;
    selected.push({ entry, priority, truncated: entry.includes("[Comment body excerpt truncated.") });
    bytes += separatorBytes + byteLength(entry);
  }
  const omitted = comments.length - selected.length;
  const excerpts = selected.filter((entry) => entry.truncated).length;
  const decisionInHistory = comments.slice(0, omitted).some(isPriorityComment);
  const marker = commentPacketMarker(omitted, excerpts, decisionInHistory);
  const entries = selected.map((entry) => entry.entry).join("\n\n");
  return `${entries}${entries ? "\n\n" : ""}${marker}`;
}
function ticketAssetsPacket(ticket, slug) {
  const assets = Array.isArray(ticket && ticket.assets) ? ticket.assets : [];
  if (!assets.length) return "(No attachments were recorded.)";
  if (!slug) return assets.map((asset) => `- WARNING: attachment "${asset}" cannot be resolved because the ticket project is unavailable. Report this blocker before implementation.`).join("\n");
  return assets.map((asset) => {
    const absolutePath = path.resolve(store.assetPath(slug, ticket.id, asset));
    try {
      const stat = fs.statSync(absolutePath);
      fs.accessSync(absolutePath, fs.constants.R_OK);
      if (!stat.isFile()) throw new Error("not a file");
      return `- \`${absolutePath}\`
  Inspect this attachment before implementation.`;
    } catch (_) {
      return `- WARNING: attachment \`${absolutePath}\` is missing or unreadable. Report this blocker before implementation.`;
    }
  }).join("\n");
}
function ticketRouteMarker(ticket) {
  const resolved = store.resolveExec(ticket.model, ticket.effort);
  return resolved && resolved.backend === "codex" && resolved.dispatchModel ? routeMarker(resolved.dispatchModel, ticket.effort) : null;
}
function ticketCloseout(ticket) {
  const resolved = store.resolveExec(ticket.model, ticket.effort);
  const effort = resolved && (resolved.effort || ticket.effort);
  return resolved && effort ? `Closeout: submit for repo work; otherwise done --model ${resolved.runsModel} --effort ${effort}. After submit, keep the terminal board comment to the commit hash, verify evidence, and a reference to the submission instead of repeating its narrative. Non-repo done comments still carry the full report. Then stop without a routine SendMessage.` : null;
}
function ticketWorktreeSetup(ticket, slug) {
  if (!ticket || !ticket.dispatch || ticketIsolation(ticket, ticket.dispatch.sharedTree) !== "worktree") return null;
  const config = store.boardConfig(slug);
  return config && config.worktreeSetup ? config.worktreeSetup : null;
}
function storyContractPacket(ticket, slug) {
  const snapshot = ticket && ticket.dispatch && ticket.dispatch.storyContract ? ticket.dispatch.storyContract : store.storyExecutionContract(ticket && ticket.storyId ? store.getStory(slug, ticket.storyId) : null);
  if (!snapshot || !snapshot.body) return null;
  return `## Story execution contract (revision ${Number(snapshot.revision) || 1})
${snapshot.body}`;
}
function ticketContractsPacket(ticket) {
  const contracts = store.normalizeContracts(ticket && ticket.contracts);
  const entries = [
    ...contracts.produces.map((name) => `- produces: ${name}`),
    ...contracts.changes.map((name) => `- changes: ${name}`),
    ...contracts.consumes.map((name) => `- consumes: ${name}`)
  ];
  if (ticket && ticket.contractWaiver) entries.push("- reviewed waiver: true");
  return entries.length ? entries.join("\n") : "(No contract metadata was recorded.)";
}
function ticketReadinessContractPacket(ticket, slug) {
  if (!ticket || !slug) return "(No contract-edge sequencing applies.)";
  const dependencies = store.readyWaveDependencies(slug).filter((edge) => edge.before === ticket.ref || edge.after === ticket.ref);
  return dependencies.length ? dependencies.map((edge) => `- ${edge.reason}`).join("\n") : "(No contract-edge sequencing applies.)";
}
function ticketBrief(ticket, nonce, marker, slug, projectPath) {
  const category = ticket.category || {};
  const project = String(projectPath || slug && store.readMeta(slug)?.path || "").trim();
  const executor = String(ticket.dispatchExecutor || ticket.exec?.agent || "").trim();
  const claimCall = [
    "mcp__plugin_sidequest_board__claim({",
    `  ref: ${JSON.stringify(ticket.ref)},`,
    '  by: "<choose a unique id>",',
    `  executor: ${JSON.stringify(executor)},`,
    `  effort: ${JSON.stringify(ticket.effort)},`,
    `  project: ${JSON.stringify(project)},`,
    `  token: ${JSON.stringify(nonce)}`,
    "})"
  ].join("\n");
  const comments = ticketCommentsPacket(ticket.comments);
  const commentHeading = comments.includes("[Comment packet truncated.") ? "Comment packet (newest-first excerpts; read full history only when flagged below):" : "Complete comment thread (chronological, inspect every entry before implementation):";
  const links = Array.isArray(ticket.links) && ticket.links.length ? ticket.links.map((link) => `- ${link.type || "related"}: ${link.ref || "(unknown ticket)"}`).join("\n") : "(No ticket dependencies were recorded.)";
  const declaredFiles = Array.isArray(ticket.files) && ticket.files.length ? ticket.files.map((file) => `- ${file}`).join("\n") : "(No files were declared.)";
  const labels = Array.isArray(ticket.labels) && ticket.labels.length ? ticket.labels.join(", ") : "(No labels were recorded.)";
  const closeout = ticketCloseout(ticket);
  const worktreeSetup = ticketWorktreeSetup(ticket, slug);
  const contract = storyContractPacket(ticket, slug);
  const parts = [
    "",
    ...contract ? [contract] : [],
    "## This ticket",
    `Ref: ${ticket.ref}`,
    `Title: ${ticket.title || "(Untitled ticket)"}`,
    `Description:
${ticketDescriptionPacket(ticket.description)}`,
    `Category contract:
Category: ${category.id || ticket.categoryId || "(Unclassified)"}
Configured route: ${category.route?.model || "(No configured route)"} / ${category.route?.effort || "(No configured effort)"}
Dispatch route: ${ticket.model || category.route?.model || "(No route)"} / ${ticket.effort || category.route?.effort || "(No effort)"}
${category.contract || "(No category-specific executor instructions were recorded.)"}`,
    `Anchors:
${ticket.executorAnchors || "(No anchors were recorded.)"}`,
    `Verify command:
${ticket.executorVerify || "(No exact verify command was recorded.)"}`,
    ...ticket.highStakes ? ["High-stakes verification:\nEnumerate and check EVERY consumer of each changed surface. Run every affected consumer suite, including dashboard build/tests when board payloads change. A review-audit pass is mandatory before integration."] : [],
    ...worktreeSetup ? [`Worktree setup (run before verify): ${worktreeSetup}`] : [],
    `Declared files:
${declaredFiles}`,
    "Scope expansion: if work needs an undeclared path, call scope-request with that path and pause with your claim held. Do not release or weaken scope lint; the orchestrator approves by updating the ticket files, then this executor continues.",
    `Contract metadata:
${ticketContractsPacket(ticket)}`,
    `Readiness contract edges:
${ticketReadinessContractPacket(ticket, slug)}`,
    `Ticket state:
Status: ${ticket.status || "(Unknown)"}
Priority: ${ticket.priority || "(Unknown)"}
Labels: ${labels}
Story: ${ticket.storyId || "(No story)"}
Dependencies:
${links}`,
    `${commentHeading}
${comments}`,
    `Attachments (inspect every readable attachment before implementation):
${ticketAssetsPacket(ticket, slug)}`,
    ...closeout ? [closeout] : [],
    "Dispatch claim guard:",
    "Copy this claim call verbatim, replacing only the `by` placeholder with a unique id:",
    `\`\`\`javascript
${claimCall}
\`\`\``,
    "Do not pass `direct`. Do not substitute the model slug for `executor`. A token refusal means this dispatch was superseded or you are not its prepared executor. Stop and report that refusal."
  ];
  if (store.sharedTreeArtifactMode(ticket)) {
    parts.push(
      "Artifact lifecycle exception:",
      `${ARTIFACT_LIFECYCLE_MARKER}
This shared-tree artifact ticket may leave verified changes in its declared scope and close with done. Do not commit or submit it. All project source remains read-only.`
    );
  }
  if (marker) {
    parts.push("Model route (gateway dispatch marker — never write another):", marker);
  }
  return parts.join("\n\n");
}
function renderTicketBriefing(ticket, nonce, slug, projectPath) {
  if (typeof nonce !== "string" || !nonce.trim() || /[\r\n]/.test(nonce)) {
    throw new Error("dispatch briefing nonce is required and must be a non-empty one-line string.");
  }
  return ticketBrief(ticket, nonce.trim(), ticketRouteMarker(ticket), slug, projectPath);
}
function ticketIsolation(ticket, sharedTree) {
  return sharedTree === true ? null : "worktree";
}
function withProjectIdentity(prompt, projectPath) {
  const text = String(prompt || "").trim();
  if (!text) throw new Error("Agent spawn prompt is required.");
  const project = String(projectPath || "").trim();
  if (!project) return text;
  return `${text}

Dispatch board identity: --project "${project.replace(/"/g, '\\"')}"`;
}
function quotedShellArgument(value) {
  return `"${String(value || "").replace(/"/g, '\\"')}"`;
}
function dispatchLauncherPath() {
  return path.join(store.homeRoot(), "sidequest-launcher.js");
}
function dispatchLauncherSource() {
  return `'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function compareVersions(left, right) {
  const parts = (value) => String(value || '').split(/[^0-9]+/).map(Number);
  const a = parts(left);
  const b = parts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function currentSidequestCli() {
  const claudeHome = process.env.SIDEQUEST_CLAUDE_HOME || path.join(os.homedir(), '.claude');
  const registryPath = path.join(claudeHome, 'plugins', 'installed_plugins.json');
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  const installs = registry.plugins?.['sidequest@eigenwise-toolshed'] || [];
  const candidates = installs
    .filter((install) => install?.installPath)
    .map((install) => ({ ...install, script: path.join(install.installPath, 'bin', 'sidequest.js') }))
    .filter((install) => fs.existsSync(install.script));
  candidates.sort((left, right) => compareVersions(right.version, left.version)
    || String(right.lastUpdated || '').localeCompare(String(left.lastUpdated || '')));
  return candidates[0]?.script;
}

const script = currentSidequestCli();
if (!script) throw new Error("Sidequest is not installed in Claude Code's plugin registry.");
const result = spawnSync(process.execPath, [script, ...process.argv.slice(2)], { stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
process.exit(result.status == null ? 1 : result.status);
`;
}
function ensureDispatchLauncher() {
  const filePath = dispatchLauncherPath();
  const source = dispatchLauncherSource();
  let current = null;
  try {
    current = fs.readFileSync(filePath, "utf8");
  } catch (_) {
  }
  if (current !== source) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 448 });
    fs.writeFileSync(filePath, source, { encoding: "utf8", mode: 384 });
  }
  return filePath;
}
function renderDispatchStub(ticket, nonce, projectPath) {
  const project = String(projectPath || "").trim();
  if (!project) throw new Error("Dispatch board project path is required.");
  const marker = ticketRouteMarker(ticket);
  const command = [
    "node",
    quotedShellArgument(ensureDispatchLauncher()),
    "briefing",
    String(ticket.ref),
    "--token",
    String(nonce).trim(),
    "--project",
    quotedShellArgument(project)
  ].join(" ");
  return [
    ...marker ? [marker, ""] : [],
    `Prepared Sidequest executor: ${ticket.dispatchExecutor}.`,
    `Ticket: ${ticket.ref}.`,
    `Dispatch board identity: --project ${quotedShellArgument(project)}.`,
    "",
    `FIRST action: run \`${command}\` and execute exactly what it prints.`
  ].join("\n");
}
function agentSpawn(name, isolation, model, agentType, prompt, description) {
  return Object.assign(
    { subagent_type: agentType || name, name, mode: "bypassPermissions" },
    description ? { description } : {},
    isolation ? { isolation } : {},
    model ? { model } : {},
    prompt ? { prompt } : {}
  );
}
function createNativeAgent(spec, opts) {
  opts = opts || {};
  spec = spec || {};
  if (spec.agentType) {
    const name2 = nativeAgentName(spec.ref, spec.runtime, spec.nonce);
    const model = spec.spawnModel == null ? null : String(spec.spawnModel).trim();
    return {
      name: name2,
      file: null,
      fallback: true,
      spawn: agentSpawn(name2, spec.isolation, model, String(spec.agentType), spec.prompt, spec.description),
      cleanup: { name: name2, sessionId: spec.sessionId || null }
    };
  }
  const dir = opts.dir || defaultAgentsDir();
  fs.mkdirSync(dir, { recursive: true });
  const runtime = spec.runtime != null ? spec.runtime : spec.runsModel;
  const explicitNonce = spec.nonce != null ? spec.nonce : null;
  let name = nativeAgentName(spec.ref, runtime, explicitNonce);
  if (explicitNonce == null && fs.existsSync(temporaryAgentFile(name, dir))) {
    name = nativeAgentName(spec.ref, runtime, crypto.randomBytes(4).toString("hex"));
  }
  let file = temporaryAgentFile(name, dir);
  for (let attempt = 0; ; attempt++) {
    const source = nativeAgentSource(Object.assign({}, spec, { name }));
    try {
      fs.writeFileSync(file, source, { flag: "wx" });
      break;
    } catch (err) {
      if (err && err.code === "EEXIST" && explicitNonce == null && attempt < 25) {
        name = nativeAgentName(spec.ref, runtime, crypto.randomBytes(4).toString("hex"));
        file = temporaryAgentFile(name, dir);
        continue;
      }
      throw err;
    }
  }
  waitForNativeAgentReload(opts.waitMs);
  return {
    name,
    file,
    spawn: agentSpawn(name, spec.isolation, spec.spawnModel, void 0, spec.prompt, spec.description),
    cleanup: { name, sessionId: spec.sessionId || null }
  };
}
function cleanupNativeAgents(opts) {
  opts = opts || {};
  const dir = opts.dir || defaultAgentsDir();
  const name = opts.name ? String(opts.name) : null;
  const sessionId = opts.sessionId == null ? null : String(opts.sessionId);
  let removed = 0;
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => (f.startsWith(TEMP_PREFIX) || f.startsWith(TICKET_PREFIX)) && f.endsWith(".md"));
  } catch (_) {
    return { removed };
  }
  for (const fileName of files) {
    if (name && fileName !== `${name}.md`) continue;
    const file = path.join(dir, fileName);
    let source = "";
    try {
      source = fs.readFileSync(file, "utf8");
    } catch (_) {
      continue;
    }
    if (!source.includes(TEMP_MARKER)) continue;
    if (sessionId && !source.includes(`<!-- sidequest-native-session: ${sessionId} -->`)) continue;
    if (opts.staleBefore != null) {
      let stat;
      try {
        stat = fs.statSync(file);
      } catch (_) {
        continue;
      }
      if (stat.mtimeMs >= Number(opts.staleBefore)) continue;
    }
    try {
      fs.unlinkSync(file);
      removed++;
    } catch (_) {
    }
  }
  return { removed };
}
function hasStableMarker(source) {
  return source.includes(MARKER) || source.includes(LEGACY_MARKER);
}
const INSTALL_HASH_FILE = ".sidequest-install-hash";
function stableInstallHash() {
  let version = "0.0.0";
  try {
    version = JSON.parse(fs.readFileSync(path.join(__dirname, "..", ".claude-plugin", "plugin.json"), "utf8")).version || version;
  } catch (_) {
  }
  const template = fs.readFileSync(TEMPLATE_PATH, "utf8");
  const maxTurnsOverride = String(process.env.SIDEQUEST_EXEC_MAX_TURNS || "").trim();
  return crypto.createHash("sha256").update(JSON.stringify({ version, template, marker: MARKER, dispatchModel: DISPATCH_MODEL_ID, maxTurns: EXEC_MAX_TURNS, checkpointToolRounds: EXECUTOR_CHECKPOINT_TOOL_ROUNDS, maxTurnsOverride, readOnlyTools: READ_ONLY_TOOLS })).digest("hex");
}
function installHashPath(dir) {
  return path.join(dir || defaultAgentsDir(), INSTALL_HASH_FILE);
}
function readInstallHash(dir) {
  try {
    return fs.readFileSync(installHashPath(dir), "utf8").trim();
  } catch (_) {
    return "";
  }
}
function writeInstallHash(dir, hash) {
  fs.writeFileSync(installHashPath(dir), hash + "\n");
}
function syncExecAgentsIfChanged(_prefs, opts) {
  const dir = opts && opts.dir ? opts.dir : defaultAgentsDir();
  const installHash = stableInstallHash();
  if (readInstallHash(dir) === installHash) {
    return { written: 0, removed: 0, unchanged: 0, skipped: true, installHash };
  }
  const result = syncExecAgents(_prefs, { dir });
  return Object.assign({}, result, { skipped: false, installHash });
}
function syncExecAgents(_prefs, opts) {
  opts = opts || {};
  const dir = opts.dir || defaultAgentsDir();
  const wanted = /* @__PURE__ */ new Map();
  for (const effort of EXEC_EFFORTS) {
    wanted.set(`${stableDispatchName(effort)}.md`, renderDispatchAgent(effort));
    wanted.set(`${stableClaudeName(effort)}.md`, renderExecAgent({
      name: stableClaudeName(effort),
      effort,
      marker: MARKER
    }));
    wanted.set(`${stableReadOnlyDispatchName(effort)}.md`, renderReadOnlyDispatchAgent(effort));
    wanted.set(`${stableReadOnlyClaudeName(effort)}.md`, renderReadOnlyClaudeAgent(effort));
  }
  let existing = [];
  try {
    fs.mkdirSync(dir, { recursive: true });
    existing = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".md"));
  } catch (_) {
    existing = [];
  }
  let written = 0;
  let removed = 0;
  let unchanged = 0;
  for (const [filename, content] of wanted) {
    const filePath = path.join(dir, filename);
    let prev = null;
    try {
      prev = fs.readFileSync(filePath, "utf8");
    } catch (_) {
      prev = null;
    }
    if (prev !== null && !hasStableMarker(prev)) continue;
    if (prev === content) {
      unchanged++;
      continue;
    }
    fs.writeFileSync(filePath, content);
    written++;
  }
  const wantedNames = new Set(wanted.keys());
  for (const filename of existing) {
    if (wantedNames.has(filename)) continue;
    const filePath = path.join(dir, filename);
    let body = null;
    try {
      body = fs.readFileSync(filePath, "utf8");
    } catch (_) {
      continue;
    }
    if (body == null || !hasStableMarker(body)) continue;
    try {
      fs.unlinkSync(filePath);
      removed++;
    } catch (_) {
    }
  }
  writeInstallHash(dir, stableInstallHash());
  return { written, removed, unchanged };
}
module.exports = {
  LEGACY_MARKER,
  MARKER,
  TEMP_MARKER,
  TEMP_PREFIX,
  TICKET_PREFIX,
  RELOAD_NOTICE,
  RESTART_NOTICE,
  ARTIFACT_LIFECYCLE_MARKER,
  NON_MAX_EFFORTS,
  EXECUTOR_CHECKPOINT_TOOL_ROUNDS,
  EXEC_MAX_TURNS,
  DISPATCH_MODEL_ID,
  READ_ONLY_TOOLS,
  execMaxTurns,
  ticketCommentsPacket,
  ticketAssetsPacket,
  routeMarker,
  workflowRecipe,
  renderDispatchAgent,
  renderReadOnlyDispatchAgent,
  renderReadOnlyClaudeAgent,
  renderExecAgent,
  renderTicketBriefing,
  createNativeAgent,
  cleanupNativeAgents,
  nativeAgentName,
  nativeAgentSource,
  withProjectIdentity,
  renderDispatchStub,
  ensureDispatchLauncher,
  agentSpawn,
  spawnDescription,
  ticketIsolation,
  syncExecAgents,
  syncExecAgentsIfChanged,
  stableInstallHash,
  defaultAgentsDir
};
