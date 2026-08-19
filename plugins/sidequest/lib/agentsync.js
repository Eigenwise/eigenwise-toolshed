"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("node:child_process");
const { stableClaudeName, stableDispatchName, stableReadOnlyClaudeName, stableReadOnlyDispatchName, DIAGNOSTIC_PROBE_NAME } = require("./exec-names.js");
const { createWorktreeLease, worktreeResumeDecision } = require("./kernel/worktree.js");
const crypto = require("crypto");
const store = require("./store.js");
const { worktreeRoot } = require("./worktrees.js");
const { spawnDescription } = store;
const { compileContextProjection } = require("./context-packet.js");
const { canonicalPreparedDispatchExecutor } = require("./prepared-dispatch.js");
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
const EMITTED_ROUTE_MARKER_RE = /^\[sidequest-route model=[a-z0-9][a-z0-9.-]{0,63} effort=(low|medium|high|xhigh|max)\]$/;
const EMBEDDED_ROUTE_MARKER_RE = /\[sidequest-route model=[a-z0-9][a-z0-9.-]{0,63} effort=(?:low|medium|high|xhigh|max)\]/gi;
function routeMarker(dispatchModel, effort) {
  const model = String(dispatchModel || "");
  const markerEffort = String(effort || "");
  if (!ROUTE_MODEL_RE.test(model)) throw new Error(`dispatch model id is not marker-safe: ${dispatchModel}`);
  if (!EXEC_EFFORTS.includes(markerEffort)) throw new Error(`dispatch effort is not marker-safe: ${effort}`);
  const marker = `[sidequest-route model=${model} effort=${markerEffort}]`;
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
const EXECUTOR_SKILLS = ["sidequest:verify-discipline"];
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
function renderDiagnosticProbe() {
  return [
    "---",
    `name: ${DIAGNOSTIC_PROBE_NAME}`,
    "description: Sidequest dispatch self-test.",
    "model: haiku",
    "maxTurns: 3",
    "tools: Read, Glob, Grep",
    "permissionMode: bypassPermissions",
    "---",
    MARKER,
    "Diagnose only the Agent spawn path. Read repository files and report concise evidence. Do not edit, run commands, use network tools, delegate, mention tickets, or investigate ordinary work.",
    ""
  ].join("\n");
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

_This agent is the shared Sidequest executor for every Codex-backed route at every effort. Its \`model: ${DISPATCH_MODEL_ID}\` pin is virtual: the codex-gateway shim resolves the real Codex model AND the reasoning effort from the \`[sidequest-route model=... effort=...]\` line in your spawn prompt, so NEVER write, quote, or echo such a line anywhere else. If the gateway reports a missing route marker, stop and report it — the orchestrator must redispatch. Refuse a batch whose tickets are stamped with different models or efforts: one spawn carries exactly one route marker._`;
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
function implementationExecutorSources() {
  const sources = /* @__PURE__ */ new Map();
  sources.set(`${stableDispatchName()}.md`, renderDispatchAgent());
  for (const effort of EXEC_EFFORTS) {
    sources.set(`${stableClaudeName(effort)}.md`, renderExecAgent({
      name: stableClaudeName(effort),
      effort,
      marker: MARKER
    }));
  }
  return sources;
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
function commentBody(comment) {
  return comment && Object.hasOwn(comment, "body") ? String(comment.body) : String(comment || "");
}
function commentPacketEntry(comment, index) {
  return [
    `### Comment ${Number(index) + 1}`,
    `Author: ${comment && comment.by ? comment.by : "unknown"}`,
    `Kind: ${comment && comment.kind ? comment.kind : "comment"}`,
    `Recorded: ${comment && comment.at ? comment.at : "(timestamp unavailable)"}`,
    "Body:",
    commentBody(comment)
  ].join("\n");
}
function ticketDescriptionPacket(description) {
  return String(description || "(No additional description was recorded.)");
}
function ticketCommentsPacket(comments) {
  if (!Array.isArray(comments) || !comments.length) return "(No ticket comments were recorded.)";
  return comments.map((comment, index) => commentPacketEntry(comment, index)).join("\n\n");
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
  return [
    "Read the full log at " + logPath + " before the first edit.",
    "Round checkout target: " + experimentCheckoutTarget(ticket) + ".",
    String(experiment.packet || "")
  ].join("\n\n");
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
  return `Closeout: this prepared dispatch is write-capable. Commit scoped repo changes, then put the full final report in submit.body with the commit hash and verification execution evidence: changed behavior, named assertion, and empty-state proof for acquisition, install, download, or cache work. Do not post a separate pre-submit final-report comment. Submit writes the short terminal submission marker; do not repeat the report in another comment. For non-repo output, close with done --model ${resolved.runsModel} --effort ${effort}; its completion comment still carries the full report. Then stop without a routine SendMessage.`;
}
function continuationResumeDecision(continuation) {
  if (!continuation?.lease) return { allowed: false, reason: "the continuation has no immutable worktree lease." };
  try {
    const observedRevision = execFileSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
      cwd: continuation.lease.observedWorktree,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    return worktreeResumeDecision(createWorktreeLease({ ...continuation.lease, observedRevision }));
  } catch (_) {
    return { allowed: false, reason: "the retained worktree revision could not be observed." };
  }
}
function retainedWorktreeAccess(worktree) {
  return [
    `Work in that retained worktree by absolute path, and do NOT call EnterWorktree: it only accepts worktrees under \`<repo>/.claude/worktrees\`, so it can never enter a board-retained one.`,
    `Run git there as \`git -C ${worktree} <command>\`, and give Edit and Write absolute paths under it. Your own working directory stays the shared checkout, where mutating git is refused by design.`
  ];
}
function ticketContinuationPacket(ticket) {
  const continuation = ticket?.dispatch?.continuation;
  const resume = continuationResumeDecision(continuation);
  if (continuation?.mode === "retained_worktree_resume" && continuation.sourceWorktree && continuation.commit && resume.allowed) {
    const branch = continuation.sourceBranch || "(detached HEAD)";
    return [
      "Continuation handoff:",
      `The previous executor released this same ticket from retained worktree ${continuation.sourceWorktree}.`,
      `Previous branch: ${branch}`,
      `Checkpoint commit: ${continuation.commit}`,
      ...retainedWorktreeAccess(continuation.sourceWorktree),
      `Before any other work, verify \`git -C ${continuation.sourceWorktree} rev-parse HEAD\` equals \`${continuation.commit}\` and continue from that checkpoint.`,
      "The board binds this ticket to the retained worktree at claim time, so that tree is the only place your writes are authorized.",
      "Do not cherry-pick the checkpoint or rediscover the checkpointed work."
    ].join("\n");
  }
  if (continuation?.mode === "dirty_worktree_resume" && continuation.sourceWorktree && continuation.commit && resume.allowed) {
    return [
      "Continuation handoff:",
      `The previous executor released this same ticket with uncommitted work in retained worktree ${continuation.sourceWorktree}.`,
      `Recorded HEAD: ${continuation.commit}`,
      ...retainedWorktreeAccess(continuation.sourceWorktree),
      `Before any other work, verify \`git -C ${continuation.sourceWorktree} rev-parse HEAD\` equals \`${continuation.commit}\` and that \`git -C ${continuation.sourceWorktree} status --porcelain\` still lists the retained changes.`,
      "Those changes were never committed and never stashed, so that worktree is the only copy anywhere. Preserve them and continue from them.",
      "The board binds this ticket to the retained worktree at claim time, so that tree is the only place your writes are authorized."
    ].join("\n");
  }
  if (continuation && !resume.allowed) return `Continuation fallback: the retained worktree lease refused resume (${resume.reason}). This dispatch uses a fresh worktree.`;
  const fallback = ticket?.dispatch?.continuationFallback;
  if (!fallback?.reason) return null;
  const replay = Array.isArray(fallback.commits) && fallback.commits.length ? ` After claiming and before any other work, run \`git cherry-pick ${fallback.commits.join(" ")}\`. If the cherry-pick fails, stop and report the failure. Do not rediscover or rewrite the checkpointed work.` : "";
  const cause = String(fallback.cause || "").trim();
  const evidence = cause ? ` Validation evidence: ${cause}.` : "";
  return `Continuation fallback: the previous released worktree was not carried (${String(fallback.reason).replace(/_/g, " ")}). This dispatch uses a fresh worktree.${fallback.sourceWorktree ? ` Previous worktree: ${fallback.sourceWorktree}.` : ""}${evidence}${replay}`.trim();
}
function ticketWorktreeSync(ticket, projectPath) {
  const dispatch = ticket?.dispatch;
  const root = String(projectPath || "").trim();
  const target = dispatch?.integrationTarget;
  const commit = String(dispatch?.baseCommit || "").trim();
  if (dispatch?.sharedTree !== false || !root) return null;
  const reviewCandidate = dispatch?.reviewTarget?.candidate;
  if (reviewCandidate?.source === "git" && commit) {
    return [
      `Candidate synchronization (run before any review work): the commit under review is ${commit}.`,
      `Check \`git rev-parse HEAD\`; if it differs, run \`git checkout --detach ${commit}\` and check again.`,
      "No fetch is needed: this worktree shares the project repository's object database.",
      `If that checkout fails, stop and report that the candidate is not present in this worktree. Do not review what the worktree happens to hold: a baseline suite plus \`git show\` is not a review of ${commit}.`,
      `A review also ENDS on its candidate: leave HEAD at ${commit}, because the board reads this worktree's revision when you close and refuses a verdict formed on a different tree. Comparing against the integration branch never needs HEAD to move, so use \`git diff ${commit}...main\` or \`git show\` instead of checking anything else out.`
    ].join(" ");
  }
  if (!target || !commit) return null;
  const branch = String(target.mode === "remote" ? `refs/remotes/origin/${target.branch}` : target.branch || "").trim();
  if (!branch) return null;
  const continuation = dispatch?.continuation;
  const checkpointBase = String(continuation?.baseCommit || "").trim();
  const checkpoint = continuation?.mode === "retained_worktree_resume" && checkpointBase && continuation.commit;
  if (checkpoint) {
    return [
      `Worktree synchronization (run before work): check \`git merge-base --is-ancestor ${commit} HEAD\`.`,
      `If it fails, run \`git fetch ${quotedShellArgument(root)} ${quotedShellArgument(branch)}\` then \`git rebase --onto ${commit} ${checkpointBase}\`.`,
      "If the rebase conflicts, stop and report the conflict. Do not reset the retained checkpoint or resolve toward either side."
    ].join(" ");
  }
  if (continuation?.mode === "dirty_worktree_resume") {
    if (!checkpointBase) {
      return [
        `Worktree synchronization (run before work): this worktree holds uncommitted work retained from the previous attempt. Check \`git merge-base --is-ancestor ${commit} HEAD\` and change nothing if it passes.`,
        "If it fails, stop and report that the retained base was not recorded. Do not move the base or discard anything: the retained changes exist nowhere else."
      ].join(" ");
    }
    return [
      `Worktree synchronization (run before work): this worktree holds uncommitted work retained from the previous attempt. Check \`git merge-base --is-ancestor ${commit} HEAD\` and change nothing if it passes.`,
      `If it fails, preserve before moving: commit every retained change on this worktree's own branch with \`git add -A && git commit\`, confirm \`git status --porcelain\` is empty and \`git show --stat HEAD\` lists every file you expected, then run \`git fetch ${quotedShellArgument(root)} ${quotedShellArgument(branch)}\` and \`git rebase --onto ${commit} ${checkpointBase}\`.`,
      "Never check out or discard over the retained changes, and never use `git stash`: the stash stack is shared across worktrees and concurrent sessions on this machine, so a pop can take an entry that is not yours.",
      "Rebase, never merge. Cutting a release deletes the `.release/unreleased/*.md` fragments it consumed, and merging an older base forward resurrects them, which re-ships changelog entries for already-released work.",
      "If the commit, the rebase, or either verification fails, stop and report it rather than moving the base with unpreserved work in the tree."
    ].join(" ");
  }
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
  const artifactMode = store.sharedTreeArtifactMode(ticket);
  const analysis = /\b(?:analysis|research|investigation)\b/i.test(categoryText);
  if (!readOnly && !analysis) return null;
  const durableArtifact = artifactMode ? "This shared-tree artifact dispatch may write only its declared artifact scope; board comments hold its findings." : readOnly ? "This is a read-only dispatch, so board comments are its only durable artifact." : "This is analysis, research, or investigation work.";
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
  const gitDir = sharedTree ? path.join(root, ".git") : String(dispatch.worktreeGitDirectory || "").trim() || "(recorded Git directory unavailable)";
  const identity = `Worktree identity: ${sharedTree ? "shared tree" : "linked worktree"}
Path: ${worktree}
Git dir: ${gitDir}`;
  if (!sharedTree) return identity;
  return [
    identity,
    `Dispatch admission verified the spawning runtime was rooted in ${root}.`,
    `Before any git or file operation, confirm \`git rev-parse --show-toplevel\` prints \`${root}\`.`,
    "If it differs, stop and report to the orchestrator. Do not release or write anything in the wrong tree."
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
  const expected = continuationWorktree || String(dispatch.worktree || "").trim() || "(immutable worktree binding unavailable; writes will be refused)";
  return [[
    "Worktree isolation contract: this dispatch runs in its own linked worktree, never in the shared checkout.",
    "The harness refuses heredocs in isolated worktrees; Write scripts to your scratchpad and run them by path.",
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
  return `Flagged uncertainty:
${warnings.map((warning) => `- ${warning}`).join("\n")}`;
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
function storyDecisionLogSnapshot(ticket, slug) {
  const revision = Number(ticket?.dispatch?.storyLogRevision);
  if (!Number.isInteger(revision) || revision < 0 || !ticket?.storyId || !slug) return null;
  const story = store.getStory(slug, ticket.storyId);
  const entries = story ? store.storyDecisionLog(story, { full: true }).entries.filter((entry) => Number(entry.seq) <= revision) : [];
  return { revision, story: String(story?.ref || ticket.storyId), entries };
}
function storyDecisionLogProjectionBody(snapshot) {
  if (!snapshot) return "";
  const entries = snapshot.entries || [];
  const countLabel = `${entries.length} ${entries.length === 1 ? "entry" : "entries"}`;
  return [
    `## Story decision log (${snapshot.story}, ${countLabel} through #${snapshot.revision})`,
    "Pinned at dispatch preparation. The contract above outranks these.",
    ...entries.map((entry) => `- #${entry.seq} ${entry.kind} (${entry.ref || "orchestrator"}, ${entry.by}): ${entry.text}`)
  ].join("\n");
}
function storyContractProjectionBody(snapshot) {
  if (snapshot.frozenAbsent) return "## Story execution contract\nFrozen dispatch snapshot contains no contract.";
  return `## Story execution contract (revision ${snapshot.revision})
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
function executorSafetyBody(ticket, nonce, tokenFile, project, executor, closeout, worktreeIdentity, readOnlyScratchSpace, worktreeSync) {
  const claimCall = [
    "mcp__plugin_sidequest_board__claim({",
    `  ref: ${JSON.stringify(ticket.ref)},`,
    '  by: "<choose a unique id>",',
    `  executor: ${JSON.stringify(executor)},`,
    `  effort: ${JSON.stringify(ticket.effort)},`,
    `  project: ${JSON.stringify(project)},`,
    `  tokenFile: ${JSON.stringify(tokenFile)}`,
    "})"
  ].join("\n");
  const requirement = ticket.dispatch?.verificationRequirement || ticket.lifecycleAttempt?.verificationRequirement || null;
  const verifierPrefix = requirement ? "Pinned verifier" : "Legacy verifier";
  const verifierKind = requirement?.kind || ticket.executorVerifyKind || "command";
  const verifierArtifact = requirement?.artifact || ticket.executorAttestationArtifact;
  const verifierEvidence = requirement?.evidenceContract || ticket.executorVerify || "No exact verifier was recorded.";
  const verify = verifierKind === "attestation" ? `${verifierPrefix}: attestation. Record actual evidence for ${verifierArtifact || "the declared artifact"}.` : verifierKind === "manual" ? `${verifierPrefix}: manual. Record evidence matching: ${verifierEvidence}.` : requirement?.command ? `${verifierPrefix}: ${verifierKind}. Command: ${requirement.command}` : `${verifierPrefix}: ${verifierKind}. Evidence contract: ${verifierEvidence}`;
  const verifierCommand = requirement?.command || (ticket.executorVerifyKind !== "attestation" ? ticket.executorVerify : "");
  const highStakes = ticket?.highStakes ? [
    "High-stakes verification:",
    "Enumerate and check EVERY consumer of each changed surface. Run every affected consumer suite, including dashboard build/tests when board payloads change. A review-audit pass is mandatory before integration."
  ] : [];
  const boundReview = boundReviewGuidance(ticket);
  return [
    "## Dispatch, claim, worktree, lifecycle, and verification safety",
    "Claim first with this exact call. Do not pass direct or replace the prepared executor:",
    ["```javascript", claimCall, "```"].join("\n"),
    ...worktreeIdentity ? [worktreeIdentity] : [],
    ...readOnlyScratchSpace ? [readOnlyScratchSpace] : [],
    ...worktreeSync ? [worktreeSync] : [],
    ...ticketIsolationContract(ticket, project) || [],
    verify,
    verifierCommand ? "Run it through " + capturedVerifyCommand(verifierCommand) + "; this is the pinned verifier. Run it in the FOREGROUND with an explicit generous timeout of up to 600000 ms. A backgrounded verify's completion does not wake you, so going idle on it parks the claim indefinitely. If it genuinely exceeds the 10-minute Bash ceiling, use bounded foreground until-loops instead of backgrounding or going idle; post [sidequest:verify-start] before it only for an expected no-op, and always post [sidequest:verify-complete] with status first after it exits. Executors may report evidence only; they cannot replace, skip, or weaken this verifier." : "Record evidence for the pinned verifier. Executors may not replace, skip, or weaken it; skipping requires an authorized bounded waiver recorded as a Diagnostic.",
    "Execution survival: Budget tool calls and run the declared verify command early, rather than only at the end. If the budget nears exhaustion after partly completing the contract, commit and submit the verified portion with evidence and plainly name what remains: a partial submission with proof beats a dead run. Never leave verified work uncommitted. Board MCP is the executor lifecycle authority. If its transport is unavailable, do not use the Sidequest CLI or raw Agent as a fallback: reload or reconnect Sidequest, then re-dispatch.",
    "If Sidequest itself misbehaves, such as a refusal that contradicts observed state, a dead retrieval handle, a guard loop, or a reproducible tool error, report it to the user with the reproducing evidence and treat it as an upstream defect. Executors also put that evidence in a ticket comment so the orchestrator sees it. Do not encode a workaround in project rules, hooks, or memory; any unavoidable stopgap must be marked temporary and name the defect it awaits.",
    ...highStakes.length ? [highStakes.join("\n")] : [],
    boundReview || "",
    closeout || "",
    "Stay within declared scope. This briefing includes the complete task, scope, comments, and contract. Do not use context_page for briefing sections."
  ].filter(Boolean).join("\n\n");
}
function boundReviewGuidance(ticket) {
  const target = ticket?.reviewTarget;
  if (!target) return null;
  const source = String(target.ref || target.ticketId || "its bound source ticket");
  const candidate = String(target.candidate?.value || "its bound candidate");
  return [
    "Bound review closeout:",
    `This ticket is bound to ${source} at candidate ${candidate}. You cannot reject that candidate, and no by, reviewRef, session, or publish-lock value changes that: rework, submit --clear, reclaim, and amendment all refuse with candidate_review_locked and write nothing on either half of the binding.`,
    `A pass closes normally with done. A confirmed defect records its exact evidence in a comment on this review ticket and then releases THIS ticket with kind oracle, naming what a human must decide. Leave ${source} untouched; integration stays blocked, and the orchestrator repairs through a fresh ticket, dispatch, claim, commit, review, and candidate.`
  ].join("\n");
}
function rejectedSubmissionRows(ticket) {
  const rejections = Array.isArray(ticket?.rejectedSubmissions) ? ticket.rejectedSubmissions.filter((entry) => entry) : [];
  return rejections.map((rejected, index) => ({
    position: index + 1,
    commit: rejected.commit || null,
    quarantineRef: rejected.quarantineRef || `refs/sidequest/${ticket.ref}-rejected`,
    rejectedAt: rejected.rejectedAt || null,
    rejectedBy: rejected.rejectedBy || null,
    reason: String(rejected.reason || ""),
    review: String(rejected.review || ""),
    preservationState: rejected.preservationState || "preserved",
    ...rejected.preservationError ? { preservationError: rejected.preservationError } : {},
    ...rejected.supersededAt ? { supersededAt: rejected.supersededAt, supersededBy: rejected.supersededBy || null } : {}
  }));
}
function rejectedSubmissionHistoryBody(ticket) {
  const rows = rejectedSubmissionRows(ticket);
  if (!rows.length) return null;
  return [
    "## Rejected submission history",
    `${rows.length} prior candidate${rows.length === 1 ? " was" : "s were"} rejected. Do not resubmit any rejected commit or include one in an admitted range.`,
    ...rows.map((rejected) => [
      `### Rejected candidate ${rejected.position}/${rows.length}`,
      `Commit: ${rejected.commit || "(unknown commit)"}`,
      `Quarantine ref: ${rejected.quarantineRef}`,
      `Rejection reason:
${rejected.reason || "(No reason recorded.)"}`,
      `Review evidence:
${rejected.review || "(No review evidence recorded.)"}`
    ].join("\n"))
  ].join("\n\n");
}
function oracleHandoffPacket(ticket) {
  const oracle = ticket?.oracle;
  if (!oracle?.ask) return null;
  const verdict = oracle.verdict?.text ? ` Human verdict: ${oracle.verdict.text}` : "";
  return `Oracle handoff: ${ticket.status === "awaiting-oracle" ? "awaiting a human verdict" : "verdict recorded"}. Ask: ${oracle.ask}.${verdict}`;
}
function ticketReleaseFragmentScope(ticket) {
  const fragment = store.commitScope?.ticketReleaseFragment(ticket?.ref);
  return fragment ? `

Implicit release fragment (write only this ticket's):
- ${fragment}` : "";
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
    ...oracleHandoffPacket(ticket) ? [oracleHandoffPacket(ticket)] : [],
    ...experimentLog ? [`Experiment log:
${experimentLog}`] : [],
    `Declared files:
${declaredFiles}${ticketReleaseFragmentScope(ticket)}`,
    ...planDocument ? [planDocument] : [],
    "Never hold a claim waiting for a human verdict. Release with kind `oracle`, provide the ask in `oracle`, and exit so the ticket parks as awaiting-oracle. A user is not a board fallback: when no board path remains, comment the evidence and release with kind `technical_blocker`; never compose a command for a human to run.\n\nScope check: request scope when a needed path is outside the declared set. The answer is immediate. On refusal, commit in-scope work and release with kind `handback`, naming the refused paths. The orchestrator can expand the ticket files and redispatch. A declared directory covers descendants. On the first uncovered scope miss, sweep tests, fixtures, goldens, and generated outputs, then make one consolidated request. Never ship a compensating or downstream workaround inside scope instead: a verified workaround is not a substitute for the root fix."
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
  return [
    "## Executor briefing",
    ...items
  ].join("\n\n");
}
function ticketBrief(ticket, nonce, marker, slug, projectPath) {
  if (slug && ticket?.ref && rejectedSubmissionRows(ticket).some((entry) => entry.preservationState === "pending")) {
    const reconciled = store.reconcileSubmissionRejections(slug, ticket.ref);
    if (reconciled.ok) ticket = reconciled.ticket;
  }
  const project = String(projectPath || slug && store.readMeta(slug)?.path || "").trim();
  const executor = canonicalPreparedDispatchExecutor(ticket) || "";
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
  const rejectionHistory = rejectedSubmissionHistoryBody(ticket);
  const snapshot = storySnapshot(ticket, slug);
  const storyLog = storyDecisionLogSnapshot(ticket, slug);
  const suffix = marker ? `

${marker}` : "";
  const artifactSafety = store.sharedTreeArtifactMode(ticket) ? `

Artifact lifecycle exception:
${ARTIFACT_LIFECYCLE_MARKER}
This dispatch deliberately runs in the shared checkout. Write only within the declared artifact scope. Do not apply the linked-worktree self-check, commit, or submit. Close with done after verification.` : "";
  const packet = compileContextProjection({
    profile: { id: "executor-briefing" },
    revision: Number(ticket?.dispatch?.launchSeq) || 1,
    items: [
      { id: "safety", kind: "safety", priority: 600, order: 1, body: executorSafetyBody(ticket, nonce, ticket?.dispatch?.tokenFile, project, executor, closeout, worktreeIdentity, readOnlyScratchSpace, worktreeSync) + artifactSafety },
      { id: "execution-contract", kind: "contract", priority: 500, order: 2, body: storyContractProjectionBody(snapshot) },
      ...storyLog ? [{ id: "story-decision-log", kind: "evidence", priority: 475, order: 3, body: storyDecisionLogProjectionBody(storyLog) }] : [],
      ...rejectionHistory ? [{ id: "rejection-history", kind: "evidence", priority: 450, order: 4, body: rejectionHistory }] : [],
      { id: "task-and-scope", kind: "task", priority: 300, order: 5, body: taskAndScope },
      { id: "newest-comments", kind: "evidence", priority: 200, order: 6, body: briefingCommentBody(ticket.comments) },
      { id: "handles", kind: "handle", priority: 100, order: 7, body: executorHandlesBody(ticket, slug) }
    ]
  });
  return `${renderExecutorProjection(packet)}${suffix}`;
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
const BRIEFING_FILE_TRANSPORT_THRESHOLD_CHARS = 28e3;
function briefingTransportFilePath(ticket, slug) {
  const dispatch = ticket?.dispatch || {};
  const identity = [slug, ticket?.ref, dispatch.launchSeq, ticket?.dispatchNonce].map((value) => String(value || "")).join("\n");
  const directory = crypto.createHash("sha256").update(identity, "utf8").digest("hex");
  return path.join(store.homeRoot(), "briefings", directory, "briefing.txt");
}
function transportExecutorBriefing(briefing, ticket, slug, projectPath) {
  const fullBriefing = String(briefing || "");
  if (fullBriefing.length <= BRIEFING_FILE_TRANSPORT_THRESHOLD_CHARS) return fullBriefing;
  const briefingPath = briefingTransportFilePath(ticket, slug);
  fs.mkdirSync(path.dirname(briefingPath), { recursive: true, mode: 448 });
  fs.writeFileSync(briefingPath, fullBriefing, { encoding: "utf8", mode: 384 });
  const tokenFile = String(ticket?.dispatch?.tokenFile || "").trim() || "(supplied to this briefing command)";
  return [
    `Token-gated executor briefing for ${ticket?.ref || "(unknown ticket)"}.`,
    `Project: ${String(projectPath || "").trim() || "(unavailable)"}. Token file: ${tokenFile}.`,
    `Before acting, Read "${briefingPath}" in full. It contains the exact claim call, worktree contract, complete task and scope, comments, and verification instructions.`
  ].join("\n");
}
function dispatchTicketContext(ticket, projectPath) {
  const title = String(ticket?.title || "(Untitled ticket)");
  const description = String(ticket?.description || "(No additional description was recorded.)");
  const declaredFiles = Array.isArray(ticket?.files) && ticket.files.length ? ticket.files.map((file) => `- ${file}`).join("\n") : "(No files were declared.)";
  const anchors = String(ticket?.executorAnchors || "(No anchors were recorded.)");
  return [
    `Title: ${title}`,
    `Description:
${description}`,
    `Declared files:
${declaredFiles}${ticketReleaseFragmentScope(ticket)}`,
    `Anchors:
${anchors}`
  ].join("\n\n");
}
function renderDispatchStub(ticket, projectPath) {
  const project = String(projectPath || "").trim();
  const tokenFile = String(ticket?.dispatch?.tokenFile || "").trim();
  if (!project) throw new Error("Dispatch board project path is required.");
  if (!tokenFile) throw new Error("Dispatch token file path is required.");
  const marker = ticketRouteMarker(ticket);
  const command = [
    "node",
    quotedShellArgument(ensureDispatchLauncher()),
    "briefing",
    String(ticket.ref),
    "--token-file",
    quotedShellArgument(tokenFile),
    "--project",
    quotedShellArgument(project)
  ].join(" ");
  const label = String(ticket?.dispatch?.description || spawnDescription(ticket, store.resolveExec(ticket?.model, ticket?.effort))).replace(EMBEDDED_ROUTE_MARKER_RE, " ").replace(/\s+/g, " ").trim() || "Sidequest ticket executor.";
  return [
    label,
    "Implementation context:",
    dispatchTicketContext(ticket, project),
    "",
    "Use the dispatched token file path exactly.",
    `FIRST action: run \`${command}\` and execute exactly what it prints.`,
    ...marker ? ["", marker] : []
  ].join("\n");
}
function agentSpawn(name, isolation, model, agentType, prompt, description) {
  const suppliedLabel = typeof description === "string" ? description.replace(EMBEDDED_ROUTE_MARKER_RE, "").replace(/\s+/g, " ").trim() : "";
  const taskLabel = suppliedLabel || "Sidequest ticket executor.";
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
  wanted.set(`${DIAGNOSTIC_PROBE_NAME}.md`, renderDiagnosticProbe());
  for (const [filename, source] of implementationExecutorSources()) {
    wanted.set(filename, source);
  }
  wanted.set(`${stableReadOnlyDispatchName()}.md`, renderReadOnlyDispatchAgent(void 0, readOnlyDeniedTools));
  for (const effort of EXEC_EFFORTS) {
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
  implementationExecutorSources,
  ticketCommentsPacket,
  ticketAssetsPacket,
  routeMarker,
  workflowRecipe,
  renderDispatchAgent,
  renderReadOnlyDispatchAgent,
  renderReadOnlyClaudeAgent,
  renderDiagnosticProbe,
  renderExecAgent,
  renderTicketBriefing,
  briefingTransportFilePath,
  transportExecutorBriefing,
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
