"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { stableClaudeName, stableDispatchName, stableReadOnlyClaudeName, stableReadOnlyDispatchName } = require("./exec-names.js");
const crypto = require("crypto");
const store = require("./store.js");
const { worktreeRoot } = require("./worktrees.js");
const { spawnDescription } = store;
const { compileContextProjection, contextRetrieval, contextRevision } = require("./context-packet.js");
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
const EXECUTOR_CONTRADICTION_RULE = "Executor contradiction rule: An anchor is orientation, not a contract. When an anchor names the wrong file, locate the file the work actually needs. If that file is inside declared scope, correct the anchor in your handback and continue. Stop and report a contradiction only when the needed file is outside declared scope or the ticket premise is false. Scope limits writes, never reads: reading any worktree path is allowed. Before reporting, check it and include the checked path or target and result. An existing out-of-scope path or declared output is context, not a contradiction. After evidence of absence, do not redesign the ticket, reject the base, or invent a substitute.";
function defaultAgentsDir() {
  const explicit = process.env.SIDEQUEST_AGENTS_DIR;
  if (explicit && String(explicit).trim()) return path.resolve(String(explicit).trim());
  const home = process.env.SIDEQUEST_HOME;
  if (home && String(home).trim()) return path.join(path.resolve(String(home).trim()), "agents");
  return path.join(os.homedir(), ".claude", "agents");
}
const DISPATCH_MODEL_ID = "claude-codex-auto";
const ROUTE_MODEL_RE = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const EMITTED_ROUTE_MARKER_RE = /^\[switchboard-route model=[a-z0-9][a-z0-9.-]{0,63} effort=(low|medium|high|xhigh|max)\]$/;
const ROUTE_MARKER_RE = /^\[(?:switchboard-route|sidequest-route) model=[a-z0-9][a-z0-9.-]{0,63} effort=(low|medium|high|xhigh|max)\]$/;
function routeMarker(dispatchModel, effort) {
  const model = String(dispatchModel || "");
  const markerEffort = String(effort || "");
  if (!ROUTE_MODEL_RE.test(model)) throw new Error(`dispatch model id is not marker-safe: ${dispatchModel}`);
  if (!EXEC_EFFORTS.includes(markerEffort)) throw new Error(`dispatch effort is not marker-safe: ${effort}`);
  const marker = `[switchboard-route model=${model} effort=${markerEffort}]`;
  if (!EMITTED_ROUTE_MARKER_RE.test(marker)) throw new Error("dispatch route marker does not match the gateway grammar.");
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
const EXECUTOR_SKILLS = ["playbook:verify-discipline"];
const READ_ONLY_DENIED_TOOLS = [
  "Edit",
  "Write",
  "NotebookEdit",
  // A read-only ticket reports findings; it does not fan out or publish outward. Both
  // were already excluded by the old allow list, so this keeps behaviour identical.
  "Agent",
  "Artifact",
  // Drives the user's real, logged-in browser. Playwright is the isolated one and stays
  // available, per the house rule that UI verification goes through it.
  "mcp__claude-in-chrome"
];
function resolveReadOnlyTools(readOnlyDeniedTools) {
  const extra = Array.isArray(readOnlyDeniedTools) ? readOnlyDeniedTools : [];
  return {
    tools: null,
    disallowedTools: [.../* @__PURE__ */ new Set([...READ_ONLY_DENIED_TOOLS, ...extra])]
  };
}
function readOnlyNote() {
  return "\n\n**Read-only role:** Do not modify the repository working tree. Bash is for inspection, tests, and verification, not edits. Keep temporary files outside the repository working tree, and do not install packages into the project's package.json or node_modules. If this ticket requires an edit, write a board blocker comment naming the needed change and why, then release the ticket.";
}
function renderExecAgent({ name, effort, modelId, marker, extraNote, ticketBrief: ticketBrief2, tools, disallowedTools, skills = EXECUTOR_SKILLS }) {
  const template = fs.readFileSync(TEMPLATE_PATH, "utf8");
  const toolsLine = Array.isArray(tools) && tools.length ? `tools: ${tools.join(", ")}
` : "";
  const disallowedToolsLine = Array.isArray(disallowedTools) && disallowedTools.length ? `disallowedTools: ${disallowedTools.join(", ")}
` : "";
  const skillsLine = Array.isArray(skills) && skills.length ? `skills:
${skills.map((skill) => `  - ${skill}`).join("\n")}
` : "";
  return template.split("{{NAME}}").join(String(name)).split("{{EFFORT}}").join(String(effort)).split("{{MODEL_FRONTMATTER}}").join(modelId ? `
model: ${modelId}` : "").split("{{CHECKPOINT_TOOL_ROUNDS}}").join(String(EXECUTOR_CHECKPOINT_TOOL_ROUNDS)).split("permissionMode: bypassPermissions").join(`${toolsLine}${disallowedToolsLine}${skillsLine}permissionMode: bypassPermissions`).split("{{MARKER}}").join(marker || "").split("{{EXTRA_NOTE}}").join(extraNote || "").split("{{TICKET_BRIEF}}").join(`Teammate subagent fan-out must omit the Agent \`name\` parameter; named teammate spawns are rejected by the harness.${ticketBrief2 ? `

${ticketBrief2}` : ""}`);
}
function dispatchNote() {
  return `

_This agent is the shared Sidequest executor for every Codex-backed route at every effort. Its \`model: ${DISPATCH_MODEL_ID}\` pin is virtual: the codex-gateway shim resolves the real Codex model AND the reasoning effort from the \`[switchboard-route model=... effort=...]\` line in your spawn prompt, so NEVER write, quote, or echo such a line anywhere else. If the gateway reports a missing route marker, stop and report it — the orchestrator must redispatch. Refuse a batch whose tickets are stamped with different models or efforts: one spawn carries exactly one route marker._`;
}
function collapseEffortProse(body) {
  return body.split("Executes one or more sidequest tickets at high reasoning effort.").join("Executes one or more sidequest tickets at the reasoning effort set by the dispatch route marker.").split("running at **high** reasoning effort").join("running at the reasoning effort your dispatch route marker sets");
}
function renderDispatchAgent(_effort) {
  return collapseEffortProse(renderExecAgent({
    name: stableDispatchName(),
    effort: "high",
    modelId: DISPATCH_MODEL_ID,
    marker: MARKER,
    extraNote: dispatchNote()
  }));
}
function renderReadOnlyDispatchAgent(_effort, readOnlyDeniedTools) {
  const readOnlyTools = resolveReadOnlyTools(readOnlyDeniedTools);
  return collapseEffortProse(renderExecAgent({
    name: stableReadOnlyDispatchName(),
    effort: "high",
    modelId: DISPATCH_MODEL_ID,
    marker: MARKER,
    extraNote: `${dispatchNote()}${readOnlyNote()}`,
    tools: readOnlyTools.tools,
    disallowedTools: readOnlyTools.disallowedTools
  }));
}
function renderReadOnlyClaudeAgent(effort, readOnlyDeniedTools) {
  const readOnlyTools = resolveReadOnlyTools(readOnlyDeniedTools);
  return renderExecAgent({
    name: stableReadOnlyClaudeName(effort),
    effort,
    marker: MARKER,
    extraNote: readOnlyNote(),
    tools: readOnlyTools.tools,
    disallowedTools: readOnlyTools.disallowedTools
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
  const description = String(spec.description || "Sidequest ticket executor.").replace(/\s+/g, " ").trim();
  if (!description) throw new Error("native agent description is required.");
  if (!model || /[\r\n]/.test(model)) throw new Error("native agent model id is required and must be one line.");
  if (!NON_MAX_EFFORTS.includes(effort)) throw new Error(`native agent effort must be one of: ${NON_MAX_EFFORTS.join(", ")}.`);
  if (!runtime || /[\r\n]/.test(runtime)) throw new Error("native agent runtime must be a concrete one-line model identifier.");
  const session = String(spec.sessionId || "").replace(/[\r\n]/g, "");
  return [
    "---",
    `name: ${spec.name}`,
    `description: ${JSON.stringify(description)}`,
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
const EXPERIMENT_LOG_PACKET_MAX_BYTES = 12 * 1024;
const DISPATCH_UNCERTAINTY_PACKET_MAX_BYTES = 1024;
const DISPATCH_TICKET_CONTEXT_MAX_BYTES = 1200;
const DISPATCH_TITLE_MAX_BYTES = 96;
const DISPATCH_DESCRIPTION_MAX_BYTES = 360;
const DISPATCH_FILES_MAX_BYTES = 180;
const DISPATCH_ANCHORS_MAX_BYTES = 120;
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
function planDocumentPacket(ticket, slug) {
  if (!ticket || !slug) return null;
  const plan = store.ticketPlanInfo(slug, ticket.id || ticket.ref);
  if (!plan) return null;
  const planPath = path.resolve(plan.path);
  return `Plan document: \`${planPath}\` (revision ${plan.revision}, ${plan.by}, ${plan.at}). Read it with \`Read\` and offset/limit on demand; it is never inlined here.`;
}
function experimentCheckoutTarget(ticket) {
  const round = Number(ticket?.dispatch?.launchSeq);
  return Number.isInteger(round) && round > 1 ? `refs/sidequest/${ticket.ref}/r${round - 1} (continue from the prior round)` : "base (fresh direction)";
}
function experimentLogPacket(ticket, slug) {
  if (!ticket || !slug) return null;
  const experiment = store.experimentPacket(slug, ticket.id || ticket.ref);
  if (!experiment) return null;
  const storedPath = String(experiment.path || "").trim();
  if (!storedPath) return null;
  const logPath = path.resolve(storedPath);
  return boundedPacket([
    `Read the full log at \`${logPath}\` before the first edit.`,
    `Round checkout target: ${experimentCheckoutTarget(ticket)}.`,
    String(experiment.packet || "")
  ].join("\n\n"), EXPERIMENT_LOG_PACKET_MAX_BYTES, "\n\n[Experiment log packet truncated at 12 KB. Read the full log before the first edit.]");
}
function ticketRouteMarker(ticket) {
  const resolved = store.resolveExec(ticket.model, ticket.effort);
  return resolved && resolved.backend === "codex" && resolved.dispatchModel ? routeMarker(resolved.dispatchModel, ticket.effort) : null;
}
function ticketCloseout(ticket) {
  const resolved = store.resolveExec(ticket.model, ticket.effort);
  const effort = resolved && (resolved.effort || ticket.effort);
  if (!resolved || !effort) return null;
  if (store.sharedTreeArtifactMode(ticket)) {
    const root = ticket.dispatch.artifactRoot;
    const scope = ticket.dispatch.artifactScope;
    return `Closeout: this prepared shared-tree artifact dispatch may write only ${scope} inside approved artifact root ${root}. The shared checkout is the dispatch contract, so do not require a linked worktree. Close with done --model ${resolved.runsModel} --effort ${effort}, include the full final report in its completion comment, and do not commit or submit. Then stop without a routine SendMessage.`;
  }
  if (ticket?.dispatch?.readonly === true) {
    return `Closeout: this prepared dispatch is read-only. Close with done --model ${resolved.runsModel} --effort ${effort} and include the full final report in its completion comment. Do not commit or submit. Then stop without a routine SendMessage.`;
  }
  return `Closeout: this prepared dispatch is write-capable. Commit scoped repo changes, then put the full final report in submit.body with the commit hash and verification evidence. Do not post a separate pre-submit final-report comment. Submit writes the short terminal submission marker; do not repeat the report in another comment. For non-repo output, close with done --model ${resolved.runsModel} --effort ${effort}; its completion comment still carries the full report. Then stop without a routine SendMessage.`;
}
function ticketContinuationPacket(ticket) {
  const continuation = ticket?.dispatch?.continuation;
  if (continuation?.mode === "retained_worktree_resume" && continuation.sourceWorktree && continuation.commit) {
    const branch = continuation.sourceBranch || "(detached HEAD)";
    return [
      "Continuation handoff:",
      `The previous executor released this same ticket from retained worktree ${continuation.sourceWorktree}.`,
      `Previous branch: ${branch}`,
      `Checkpoint commit: ${continuation.commit}`,
      "After claiming and before any other work, call EnterWorktree with `path` set to that retained worktree.",
      `Then verify \`git rev-parse HEAD\` equals \`${continuation.commit}\` and continue from that checkpoint.`,
      "The board binds this ticket to the retained worktree at claim time. This continuation spawn starts without native worktree isolation so EnterWorktree can enter that retained worktree before any work.",
      "Do not cherry-pick the checkpoint or rediscover the checkpointed work."
    ].join("\n");
  }
  if (continuation?.mode === "dirty_worktree_resume" && continuation.sourceWorktree && continuation.commit) {
    return [
      "Continuation handoff:",
      `The previous executor released this same ticket with uncommitted work in retained worktree ${continuation.sourceWorktree}.`,
      `Recorded HEAD: ${continuation.commit}`,
      "After claiming and before any other work, call EnterWorktree with `path` set to that retained worktree.",
      `Then verify \`git rev-parse HEAD\` equals \`${continuation.commit}\`, preserve the existing working changes, and continue.`,
      "The board binds this ticket to the retained worktree at claim time. This continuation spawn starts without native worktree isolation so EnterWorktree can enter that retained worktree before any work."
    ].join("\n");
  }
  const fallback = ticket?.dispatch?.continuationFallback;
  if (!fallback?.reason) return null;
  const replay = Array.isArray(fallback.commits) && fallback.commits.length ? ` After claiming and before any other work, run \`git cherry-pick ${fallback.commits.join(" ")}\`. If the cherry-pick fails, stop and report the failure. Do not rediscover or rewrite the checkpointed work.` : "";
  return `Continuation fallback: the previous released worktree was not carried (${String(fallback.reason).replace(/_/g, " ")}). This dispatch uses a fresh worktree.${fallback.sourceWorktree ? ` Previous worktree: ${fallback.sourceWorktree}.` : ""}${replay}`.trim();
}
function ticketWorktreeSync(ticket, projectPath) {
  const dispatch = ticket?.dispatch;
  const root = String(projectPath || "").trim();
  const target = dispatch?.integrationTarget;
  const commit = String(dispatch?.baseCommit || "").trim();
  if (dispatch?.sharedTree !== false || !root || !target || !commit) return null;
  const branch = String(target.mode === "remote" ? `refs/remotes/origin/${target.branch}` : target.branch || "").trim();
  if (!branch) return null;
  return [
    `Worktree synchronization (run before work): check \`git merge-base --is-ancestor ${commit} HEAD\`.`,
    `If it fails, run \`git fetch ${quotedShellArgument(root)} ${quotedShellArgument(branch)}\` then \`git reset --hard ${commit}\`.`,
    "If fetching or resetting fails, stop and report the failure instead of working from the stale base."
  ].join(" ");
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
function findingCheckpointPacket(ticket) {
  const category = ticket?.category || {};
  const categoryText = [ticket?.categoryId, category.id, category.name].filter(Boolean).join(" ");
  const readOnly = ticket?.dispatch?.readonly === true;
  const analysis = /\b(?:analysis|research|investigation)\b/i.test(categoryText);
  if (!readOnly && !analysis) return null;
  const durableArtifact = readOnly ? "This is a read-only dispatch, so board comments are its only durable artifact." : "This is analysis, research, or investigation work.";
  return `${durableArtifact} Post each substantive intermediate finding as a ticket comment when it lands, including after a theory pass, a measurement, or a reproduction. Record findings only, not a progress diary. If the run dies, it should lose at most the current step, not the whole investigation.`;
}
function ticketWorktreeIdentity(ticket, projectPath) {
  const dispatch = ticket?.dispatch;
  const root = String(projectPath || "").trim();
  if (!dispatch || !root || dispatch.sharedTree == null) return null;
  const sharedTree = dispatch.sharedTree === true;
  const continuationWorktree = dispatch.continuation?.sourceWorktree;
  const worktree = sharedTree ? root : String(continuationWorktree || dispatch.worktree || "").trim();
  if (!worktree) return null;
  const gitDir = sharedTree ? path.join(root, ".git") : path.join(root, ".git", "worktrees", path.basename(worktree));
  const identity = `Worktree identity: ${sharedTree ? "shared tree" : "linked worktree"}
Path: ${worktree}
Git dir: ${gitDir}`;
  if (!sharedTree) return identity;
  return [
    identity,
    `Working directory binding: your inherited shell cwd is wherever the spawning session ran and may be a stale linked worktree outside ${root}.`,
    `Before any git or file operation, \`cd "${root}"\` and confirm \`git rev-parse --show-toplevel\` prints \`${root}\`.`,
    "If it still differs after cd, stop and report to the orchestrator. Do not release or write anything in the wrong tree."
  ].join("\n");
}
function ticketReadOnlyScratchSpace(ticket) {
  if (ticket?.dispatch?.readonly !== true) return null;
  return ticket.dispatch.sharedTree === true ? "Read-only shared checkout: keep temporary files in the session scratchpad, never the repository working tree. The scratchpad is shared, so it is not a durable ticket artifact." : "Read-only linked worktree: keep temporary files in your own worktree, not the shared session scratchpad.";
}
function ticketIsolationContract(ticket, projectPath) {
  if (!ticket || !ticket.dispatch || ticket.dispatch.sharedTree !== false) return null;
  const root = String(projectPath || "").trim() || "<board project path>";
  const dispatch = ticket.dispatch;
  const continuationWorktree = String(dispatch.continuation?.sourceWorktree || "").trim();
  const expected = continuationWorktree || String(dispatch.worktree || "").trim() || path.join(worktreeRoot(root), "agent-<your agent id>");
  return [[
    "Worktree isolation contract: this dispatch runs in its own linked worktree, never in the shared checkout.",
    `Expected worktree root: ${expected}`,
    "Confirm it before your first write, and again after any resume from a coordinator message: `git rev-parse --git-dir` must differ from `git rev-parse --git-common-dir`.",
    `If they match you are in the shared checkout ${root}. Stop. Write nothing, tell the orchestrator this ticket lost its worktree and needs re-dispatch, and name any work you already have staged there so it can be committed out of the shared tree rather than lost.`
  ].join("\n")];
}
const DEPENDENCY_LINK_TYPES = /* @__PURE__ */ new Set(["blocks", "blocked-by"]);
function linkedPlanSuffix(link, slug) {
  if (!slug || !link || !DEPENDENCY_LINK_TYPES.has(String(link.type))) return "";
  const plan = link.ref ? store.ticketPlanInfo(slug, link.ref) : null;
  return plan ? ` (plan: ${path.resolve(plan.path)})` : "";
}
function capturedVerifyCommand(verify) {
  const command = String(verify || "").trim();
  if (!command) return "";
  const encoded = Buffer.from(command, "utf8").toString("base64");
  const captureScript = path.join(__dirname, "verify-capture.js");
  return `node "${captureScript}" --base64 ${encoded}`;
}
function dispatchUncertaintyPacket(ticket, slug) {
  const warnings = store.dispatchUncertaintyWarnings(ticket, slug);
  if (!warnings.length) return null;
  return boundedPacket(
    `Flagged uncertainty:
${warnings.map((warning) => `- ${warning}`).join("\n")}`,
    DISPATCH_UNCERTAINTY_PACKET_MAX_BYTES,
    "\n[Additional dispatch uncertainty warnings truncated.]"
  );
}
const EXECUTOR_BRIEFING_MAX_BYTES = 24 * 1024;
const EXECUTOR_CONTRACT_MAX_BYTES = 12 * 1024;
function sha256Text(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}
function projectionRetrieval(tool, argumentsValue) {
  return { tool: String(tool), arguments: argumentsValue || {} };
}
function projectionCall(retrieval) {
  return `${retrieval.tool}(${JSON.stringify(retrieval.arguments)})`;
}
function briefingProjectArguments(project) {
  return project ? { project } : {};
}
function storySnapshot(ticket, slug) {
  const dispatch = ticket?.dispatch;
  const hasFrozenSnapshot = !!dispatch && Object.prototype.hasOwnProperty.call(dispatch, "storyContract");
  const snapshot = hasFrozenSnapshot ? dispatch.storyContract : store.storyExecutionContract(ticket?.storyId ? store.getStory(slug, ticket.storyId) : null);
  const story = ticket?.storyId && slug ? store.getStory(slug, ticket.storyId) : null;
  return {
    body: String(snapshot?.body || ""),
    revision: Number(snapshot?.revision) || 1,
    story: String(story?.ref || ticket?.storyId || ""),
    frozenAbsent: hasFrozenSnapshot && snapshot == null
  };
}
function storyContractRetrieval(ticket, snapshot, project, forceHandle = false) {
  const body = String(snapshot?.body || "");
  if (!forceHandle && !snapshot?.frozenAbsent && byteLength(body) <= EXECUTOR_CONTRACT_MAX_BYTES) {
    return projectionRetrieval("mcp__plugin_sidequest_board__story_contract", Object.assign(
      briefingProjectArguments(project),
      { story: snapshot.story, cursor: 0, limit: 16384, full: true }
    ));
  }
  const hash = sha256Text(body);
  return projectionRetrieval("mcp__plugin_sidequest_board__context_page", contextRetrieval({
    tool: "dispatch",
    project: String(project || ticket?.project || "unbound"),
    kind: "body",
    field: "dispatch.storyContract",
    position: "storyContract",
    revision: contextRevision(body),
    reason: "frozen-snapshot",
    selector: {
      ref: String(ticket?.ref || ""),
      snapshotRevision: Number(snapshot?.revision) || 1,
      sha256: hash,
      totalBytes: byteLength(body),
      ...snapshot?.frozenAbsent ? { frozenAbsent: true } : {}
    }
  }).arguments);
}
function storyContractProjectionBody(snapshot, retrieval, forceHandle = false) {
  if (snapshot.frozenAbsent) return "## Story execution contract\nFrozen dispatch snapshot contains no contract.";
  const totalBytes = byteLength(snapshot.body);
  const hash = sha256Text(snapshot.body);
  const metadata = `snapshot revision ${snapshot.revision}; sha256 ${hash}; totalBytes ${totalBytes}`;
  if (forceHandle || totalBytes > EXECUTOR_CONTRACT_MAX_BYTES) {
    return [
      `## Story execution contract (revision ${snapshot.revision}; ${metadata})`,
      "Required before editing: fetch the paged snapshot with " + projectionCall(retrieval) + ". For every later page, call context_page with the returned continuation verbatim. Do not combine a nextCursor with another handle or replace this frozen snapshot with a live contract."
    ].join("\n");
  }
  return `## Story execution contract (revision ${snapshot.revision})
Snapshot ${metadata}.
${snapshot.body}`;
}
function briefingCommentBody(comments) {
  const entries = Array.isArray(comments) ? comments.slice().reverse() : [];
  if (!entries.length) return "(No ticket comments were recorded.)";
  return [
    "## Newest ticket evidence and comments (newest first)",
    ...entries.map((comment, index) => [
      `### Comment ${entries.length - index}`,
      `Author: ${comment.by || "unknown"}`,
      `Kind: ${comment.kind || "comment"}`,
      `Recorded: ${comment.at || "(timestamp unavailable)"}`,
      "Body:",
      commentBody(comment)
    ].join("\n"))
  ].join("\n\n");
}
function executorSafetyBody(ticket, nonce, project, executor, closeout, worktreeIdentity, readOnlyScratchSpace, worktreeSync) {
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
  const verify = ticket.executorVerifyKind === "attestation" ? `Verify oracle: attestation. Record actual evidence for ${ticket.executorAttestationArtifact}.` : `Verify command: ${ticket.executorVerify || "(No exact verify command was recorded.)"}`;
  const highStakes = ticket?.highStakes ? [
    "High-stakes verification:",
    "Enumerate and check EVERY consumer of each changed surface. Run every affected consumer suite, including dashboard build/tests when board payloads change. A review-audit pass is mandatory before integration."
  ] : [];
  return [
    "## Dispatch, claim, worktree, lifecycle, and verification safety",
    "Claim first with this exact call. Do not pass direct or replace the prepared executor:",
    ["```javascript", claimCall, "```"].join("\n"),
    ...worktreeIdentity ? [worktreeIdentity] : [],
    ...readOnlyScratchSpace ? [readOnlyScratchSpace] : [],
    ...worktreeSync ? [worktreeSync] : [],
    ...ticketIsolationContract(ticket, project) || [],
    verify,
    ticket.executorVerify && ticket.executorVerifyKind !== "attestation" ? "Run it through " + capturedVerifyCommand(ticket.executorVerify) + "; post [sidequest:verify-start] before it only for background verification or an expected no-op, and always post [sidequest:verify-complete] with status first after it exits." : "",
    ...highStakes.length ? [highStakes.join("\n")] : [],
    closeout || "",
    "Stay within declared scope. If required context is omitted below, fetch it once with its listed retrieval call before editing. Do not guess or silently skip it."
  ].filter(Boolean).join("\n\n");
}
function rejectedSubmissionRows(ticket) {
  const rejections = Array.isArray(ticket?.rejectedSubmissions) ? ticket.rejectedSubmissions.filter((entry) => entry) : [];
  return rejections.map((rejected, index) => ({
    position: index + 1,
    commit: rejected.commit || null,
    quarantineRef: rejected.quarantineRef || `refs/sidequest/${ticket.ref}-rejected`,
    rejectedAt: rejected.rejectedAt || null,
    rejectedBy: rejected.rejectedBy || null,
    reason: boundedPacket(rejected.reason, 4096, "\n[Reason excerpt truncated.]"),
    review: boundedPacket(rejected.review, 2048, "\n[Review evidence excerpt truncated.]"),
    preservationState: rejected.preservationState || "preserved",
    ...rejected.preservationError ? { preservationError: rejected.preservationError } : {},
    ...rejected.supersededAt ? { supersededAt: rejected.supersededAt, supersededBy: rejected.supersededBy || null } : {}
  }));
}
function rejectedSubmissionHistoryRetrieval(ticket, slug) {
  const rows = rejectedSubmissionRows(ticket);
  return projectionRetrieval("mcp__plugin_sidequest_board__context_page", contextRetrieval({
    tool: "briefing",
    project: String(slug || ticket?.project || "unbound"),
    kind: "rows",
    field: "rejected-submissions",
    position: "rejected-submissions",
    revision: contextRevision(rows),
    reason: "mandatory-rejection-history",
    selector: { ref: String(ticket?.ref || "") }
  }).arguments);
}
function rejectedSubmissionHistoryBody(ticket, retrieval) {
  const rows = rejectedSubmissionRows(ticket);
  if (!rows.length) return null;
  const latest = rows[rows.length - 1];
  return [
    "## Rejected submission history",
    `${rows.length} prior candidate${rows.length === 1 ? " was" : "s were"} rejected. Do not resubmit any rejected commit or include one in an admitted range.`,
    `Latest rejected candidate (${latest.position}/${rows.length}): ${latest.commit || "(unknown commit)"}`,
    `Latest rejection reason:
${latest.reason || "(No reason recorded.)"}`,
    `Latest review evidence:
${latest.review || "(No review evidence recorded.)"}`,
    "Required before editing: fetch the complete oldest-first history with " + projectionCall(retrieval) + ". For every later page, call context_page with the returned continuation verbatim."
  ].join("\n");
}
function executorTaskBody(ticket, category, declaredFiles, uncertainty, planDocument, experimentLog, findingCheckpoints, continuation) {
  return [
    "## This ticket",
    `Ref: ${ticket.ref}`,
    `Title: ${ticket.title || "(Untitled ticket)"}`,
    `Description:
${ticket.description || "(No additional description was recorded.)"}`,
    `Category contract:
Category: ${category.id || ticket.categoryId || "(Unclassified)"}
Configured route: ${category.route?.model || "(No configured route)"} / ${category.route?.effort || "(No configured effort)"}
Dispatch route: ${ticket.model || category.route?.model || "(No route)"} / ${ticket.effort || category.route?.effort || "(No effort)"}
${category.contract || "(No category-specific executor instructions were recorded.)"}`,
    ...uncertainty ? [uncertainty] : [],
    EXECUTOR_CONTRADICTION_RULE,
    ...findingCheckpoints ? [`Durable finding checkpoints:
${findingCheckpoints}`] : [],
    ...continuation ? [continuation] : [],
    ...experimentLog ? [`Experiment log:
${experimentLog}`] : [],
    `Declared files:
${declaredFiles}`,
    ...planDocument ? [planDocument] : [],
    "Scope check: request scope when a needed path is outside the declared set. The answer is immediate. On refusal, commit in-scope work and release with kind `handback`, naming the refused paths. The orchestrator can expand the ticket files and redispatch. A declared directory covers descendants. On the first uncovered scope miss, sweep tests, fixtures, goldens, and generated outputs, then make one consolidated request. Never ship a compensating or downstream workaround inside scope instead: a verified workaround is not a substitute for the root fix."
  ].join("\n\n");
}
function taskAndScopeBody(ticket, slug) {
  const category = ticket?.category || {};
  const declared = Array.isArray(ticket?.files) ? ticket.files : [];
  const declaredFiles = declared.length ? declared.map((file) => `- ${file}`).join("\n") : "(No files were declared.)";
  const effectiveFiles = store.effectiveScope(slug, declared);
  const declaredKeys = new Set(declared.map((file) => process.platform === "win32" ? String(file).toLowerCase() : String(file)));
  const alwaysKeys = new Set((store.boardConfig(slug)?.alwaysInScope || []).map((file) => process.platform === "win32" ? String(file).toLowerCase() : String(file)));
  const generatedFiles = effectiveFiles.filter((file) => {
    const key = process.platform === "win32" ? String(file).toLowerCase() : String(file);
    return !declaredKeys.has(key) && !alwaysKeys.has(key);
  });
  const scopedFiles = generatedFiles.length ? `${declaredFiles}

Auto-paired tracked generated files (regenerate before verifying):
${generatedFiles.map((file) => `- ${file}`).join("\n")}` : declaredFiles;
  return executorTaskBody(ticket, category, scopedFiles, dispatchUncertaintyPacket(ticket, slug), planDocumentPacket(ticket, slug), experimentLogPacket(ticket, slug), findingCheckpointPacket(ticket), ticketContinuationPacket(ticket));
}
function taskAndScopeRetrieval(ticket, slug) {
  const body = taskAndScopeBody(ticket, slug);
  return projectionRetrieval("mcp__plugin_sidequest_board__context_page", contextRetrieval({
    tool: "briefing",
    project: String(slug || ticket?.project || "unbound"),
    kind: "body",
    field: "task-and-scope",
    position: "task-and-scope",
    revision: contextRevision(body),
    reason: "budget",
    selector: { ref: String(ticket?.ref || "") }
  }).arguments);
}
function executorHandlesBody(ticket, slug) {
  const links = Array.isArray(ticket.links) && ticket.links.length ? ticket.links.map((link) => `- ${link.type || "related"}: ${link.ref || "(unknown ticket)"}${linkedPlanSuffix(link, slug)}`).join("\n") : "(No ticket dependencies were recorded.)";
  return [
    "## Context handles and summaries",
    `Contract metadata:
${ticketContractsPacket(ticket)}`,
    `Readiness contract edges:
${ticketReadinessContractPacket(ticket, slug)}`,
    `Dependencies:
${links}`,
    `Attachments (inspect every readable attachment before implementation):
${ticketAssetsPacket(ticket, slug)}`
  ].join("\n\n");
}
function renderExecutorProjection(packet) {
  const items = packet.items.map((item) => item.body).filter(Boolean);
  const omissions = packet.omissions.length ? [
    "## Omitted context",
    ...packet.omissions.map((item) => {
      const required = item.id === "execution-contract" ? " Required before editing." : "";
      return "- " + item.id + " " + item.reason + " (originalBytes " + item.originalBytes + "). Retrieve with " + projectionCall(item.retrieval) + "." + required;
    })
  ].join("\n") : "";
  return [
    "## Executor ContextProjection v1",
    `Aggregate budget: ${EXECUTOR_BRIEFING_MAX_BYTES} bytes. Projection revision: ${packet.revision}. Projection hash: ${packet.hash}. Serialized bytes: ${packet.serializedBytes}.`,
    `Watermarks: ${Object.entries(packet.watermarks).map(([key, value]) => `${key}=${value}`).join(", ") || "(none)"}.`,
    ...items,
    ...omissions ? [omissions] : []
  ].join("\n\n");
}
function ticketBrief(ticket, nonce, marker, slug, projectPath) {
  if (slug && ticket?.ref && rejectedSubmissionRows(ticket).some((entry) => entry.preservationState === "pending")) {
    const reconciled = store.reconcileSubmissionRejections(slug, ticket.ref);
    if (reconciled.ok) ticket = reconciled.ticket;
  }
  const category = ticket.category || {};
  const project = String(projectPath || slug && store.readMeta(slug)?.path || "").trim();
  const executor = String(ticket.dispatchExecutor || ticket.exec?.agent || "").trim();
  const declared = Array.isArray(ticket.files) ? ticket.files : [];
  const declaredFiles = declared.length ? declared.map((file) => `- ${file}`).join("\n") : "(No files were declared.)";
  const effectiveFiles = store.effectiveScope(slug, declared);
  const declaredKeys = new Set(declared.map((file) => process.platform === "win32" ? String(file).toLowerCase() : String(file)));
  const alwaysKeys = new Set((store.boardConfig(slug)?.alwaysInScope || []).map((file) => process.platform === "win32" ? String(file).toLowerCase() : String(file)));
  const generatedFiles = effectiveFiles.filter((file) => {
    const key = process.platform === "win32" ? String(file).toLowerCase() : String(file);
    return !declaredKeys.has(key) && !alwaysKeys.has(key);
  });
  const scopedFiles = generatedFiles.length ? `${declaredFiles}

Auto-paired tracked generated files (regenerate before verifying):
${generatedFiles.map((file) => `- ${file}`).join("\n")}` : declaredFiles;
  const closeout = ticketCloseout(ticket);
  const worktreeSync = ticketWorktreeSync(ticket, project);
  const worktreeIdentity = ticketWorktreeIdentity(ticket, project);
  const readOnlyScratchSpace = ticketReadOnlyScratchSpace(ticket);
  const uncertainty = dispatchUncertaintyPacket(ticket, slug);
  const planDocument = planDocumentPacket(ticket, slug);
  const experimentLog = experimentLogPacket(ticket, slug);
  const findingCheckpoints = findingCheckpointPacket(ticket);
  const continuation = ticketContinuationPacket(ticket);
  const taskAndScope = taskAndScopeBody(ticket, slug);
  const taskRetrieval = taskAndScopeRetrieval(ticket, slug);
  const rejectionRetrieval = rejectedSubmissionHistoryRetrieval(ticket, slug || project);
  const rejectionHistory = rejectedSubmissionHistoryBody(ticket, rejectionRetrieval);
  const snapshot = storySnapshot(ticket, slug);
  const commentsRetrieval = projectionRetrieval("mcp__plugin_sidequest_board__comments", Object.assign(briefingProjectArguments(project), { ref: ticket.ref }));
  const ticketRetrieval = projectionRetrieval("mcp__plugin_sidequest_board__comments", Object.assign(briefingProjectArguments(project), { ref: ticket.ref }));
  const suffix = marker ? `

${marker}` : "";
  const artifactSafety = store.sharedTreeArtifactMode(ticket) ? `

Artifact lifecycle exception:
${ARTIFACT_LIFECYCLE_MARKER}
This dispatch deliberately runs in the shared checkout. Write only within the declared artifact scope. Do not apply the linked-worktree self-check, commit, or submit. Close with done after verification.` : "";
  const profileBudget = EXECUTOR_BRIEFING_MAX_BYTES - byteLength(suffix);
  const buildItems = (forceContractHandle = false) => {
    const contractRetrieval = storyContractRetrieval(ticket, snapshot, slug || project, forceContractHandle);
    return [
      { id: "safety", kind: "safety", priority: 600, order: 1, body: executorSafetyBody(ticket, nonce, project, executor, closeout, worktreeIdentity, readOnlyScratchSpace, worktreeSync) + artifactSafety, retrieval: ticketRetrieval },
      { id: "execution-contract", kind: "contract", priority: 500, order: 2, watermark: `${snapshot.revision}:${sha256Text(snapshot.body)}`, body: storyContractProjectionBody(snapshot, contractRetrieval, forceContractHandle), retrieval: contractRetrieval },
      ...rejectionHistory ? [{ id: "rejection-history", kind: "evidence", priority: 450, order: 3, body: rejectionHistory, retrieval: rejectionRetrieval }] : [],
      { id: "task-and-scope", kind: "task", priority: 300, order: 4, body: taskAndScope, retrieval: taskRetrieval },
      { id: "newest-comments", kind: "evidence", priority: 200, order: 5, body: briefingCommentBody(ticket.comments), retrieval: commentsRetrieval },
      { id: "handles", kind: "handle", priority: 100, order: 6, body: executorHandlesBody(ticket, slug), retrieval: ticketRetrieval }
    ];
  };
  const watermarks = {
    storyContractSnapshot: `${snapshot.revision}:${sha256Text(snapshot.body)}`
  };
  const compile = (forceContractHandle = false) => compileContextProjection({
    profile: { id: "executor-briefing", budgetBytes: profileBudget },
    revision: Number(ticket?.dispatch?.launchSeq) || 1,
    watermarks,
    items: buildItems(forceContractHandle)
  });
  let packet = compile();
  const contract = packet.items.find((item) => item.id === "execution-contract");
  if (!contract || contract.truncated || packet.omissions.some((item) => item.id === "execution-contract")) packet = compile(true);
  if (rejectionHistory) {
    const historyItem = packet.items.find((item) => item.id === "rejection-history");
    if (!historyItem || historyItem.truncated || packet.omissions.some((item) => item.id === "rejection-history")) {
      throw new RangeError("executor ContextProjection could not carry mandatory rejection-history retrieval");
    }
  }
  const rendered = renderExecutorProjection(packet);
  const result = `${rendered}${suffix}`;
  if (byteLength(result) > EXECUTOR_BRIEFING_MAX_BYTES) {
    throw new RangeError(`executor ContextProjection exceeded its ${EXECUTOR_BRIEFING_MAX_BYTES}-byte aggregate budget`);
  }
  return result;
}
function renderTicketBriefing(ticket, nonce, slug, projectPath) {
  if (typeof nonce !== "string" || !nonce.trim() || /[\r\n]/.test(nonce)) {
    throw new Error("dispatch briefing nonce is required and must be a non-empty one-line string.");
  }
  return ticketBrief(ticket, nonce.trim(), ticketRouteMarker(ticket), slug, projectPath);
}
function ticketIsolation(ticket, sharedTree) {
  const continuationMode = ticket?.dispatch?.continuation?.mode;
  return sharedTree === true || continuationMode === "retained_worktree_resume" || continuationMode === "dirty_worktree_resume" ? null : "worktree";
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
function dispatchTicketContext(ticket, projectPath) {
  const title = boundedPacket(
    ticket?.title || "(Untitled ticket)",
    DISPATCH_TITLE_MAX_BYTES,
    "[Title excerpt capped.]"
  );
  const description = boundedPacket(
    ticket?.description || "(No additional description was recorded.)",
    DISPATCH_DESCRIPTION_MAX_BYTES,
    "\n[Description excerpt capped. Full body is in briefing.]"
  );
  const declaredFiles = boundedPacket(
    Array.isArray(ticket?.files) && ticket.files.length ? ticket.files.map((file) => `- ${file}`).join("\n") : "(No files were declared.)",
    DISPATCH_FILES_MAX_BYTES,
    "\n[Declared files excerpt capped. Full scope is in briefing.]"
  );
  const anchors = boundedPacket(
    ticket?.executorAnchors || "(No anchors were recorded.)",
    DISPATCH_ANCHORS_MAX_BYTES,
    "\n[Anchors excerpt capped. Full anchors are in briefing.]"
  );
  return boundedPacket([
    `Title: ${title}`,
    `Description:
${description}`,
    `Declared files:
${declaredFiles}`,
    `Anchors:
${anchors}`
  ].join("\n\n"), DISPATCH_TICKET_CONTEXT_MAX_BYTES, "\n\n[Spawn orientation capped. Full implementation context is in briefing.]");
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
    "Implementation context:",
    dispatchTicketContext(ticket, project),
    "",
    "Fetch the token-gated briefing for comments, attachments, claim, verification, and lifecycle details.",
    `FIRST action: run \`${command}\` and execute exactly what it prints.`
  ].join("\n");
}
function agentSpawn(name, isolation, model, agentType, prompt, description) {
  const suppliedLabel = typeof description === "string" ? description : "";
  const taskLabel = suppliedLabel && !ROUTE_MARKER_RE.test(suppliedLabel) ? suppliedLabel : "Sidequest ticket executor.";
  return Object.assign(
    { subagent_type: agentType || name, name, mode: "bypassPermissions", description: taskLabel },
    isolation ? { isolation } : {},
    model ? { model } : {},
    prompt ? { prompt } : {}
  );
}
function createNativeAgent(spec, opts) {
  opts = opts || {};
  spec = spec || {};
  if (spec.agentType) {
    const runtime2 = spec.runtime != null ? spec.runtime : spec.runsModel;
    const name2 = spec.launchName ? String(spec.launchName) : nativeAgentName(spec.ref, runtime2, spec.nonce);
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
function stableInstallHash(skills = EXECUTOR_SKILLS, readOnlyDeniedTools) {
  let version = "0.0.0";
  try {
    version = JSON.parse(fs.readFileSync(path.join(__dirname, "..", ".claude-plugin", "plugin.json"), "utf8")).version || version;
  } catch (_) {
  }
  const template = fs.readFileSync(TEMPLATE_PATH, "utf8");
  const readOnlyTools = resolveReadOnlyTools(readOnlyDeniedTools);
  return crypto.createHash("sha256").update(JSON.stringify({ version, template, marker: MARKER, dispatchModel: DISPATCH_MODEL_ID, checkpointToolRounds: EXECUTOR_CHECKPOINT_TOOL_ROUNDS, readOnlyTools, skills })).digest("hex");
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
  const readOnlyDeniedTools = opts && opts.readOnlyDeniedTools;
  const installHash = stableInstallHash(EXECUTOR_SKILLS, readOnlyDeniedTools);
  if (readInstallHash(dir) === installHash) {
    return { written: 0, removed: 0, unchanged: 0, skipped: true, installHash };
  }
  const result = syncExecAgents(_prefs, { dir, readOnlyDeniedTools });
  return Object.assign({}, result, { skipped: false, installHash });
}
function syncExecAgents(_prefs, opts) {
  opts = opts || {};
  const dir = opts.dir || defaultAgentsDir();
  const readOnlyDeniedTools = opts.readOnlyDeniedTools;
  const wanted = /* @__PURE__ */ new Map();
  wanted.set(`${stableDispatchName()}.md`, renderDispatchAgent());
  wanted.set(`${stableReadOnlyDispatchName()}.md`, renderReadOnlyDispatchAgent(void 0, readOnlyDeniedTools));
  for (const effort of EXEC_EFFORTS) {
    wanted.set(`${stableClaudeName(effort)}.md`, renderExecAgent({
      name: stableClaudeName(effort),
      effort,
      marker: MARKER
    }));
    wanted.set(`${stableReadOnlyClaudeName(effort)}.md`, renderReadOnlyClaudeAgent(effort, readOnlyDeniedTools));
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
  writeInstallHash(dir, stableInstallHash(EXECUTOR_SKILLS, readOnlyDeniedTools));
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
  DISPATCH_MODEL_ID,
  READ_ONLY_DENIED_TOOLS,
  resolveReadOnlyTools,
  EXECUTOR_SKILLS,
  ticketCommentsPacket,
  ticketAssetsPacket,
  routeMarker,
  workflowRecipe,
  renderDispatchAgent,
  renderReadOnlyDispatchAgent,
  renderReadOnlyClaudeAgent,
  renderExecAgent,
  renderTicketBriefing,
  rejectedSubmissionRows,
  taskAndScopeBody,
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
  EXECUTOR_CONTRADICTION_RULE,
  defaultAgentsDir
};
