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

// src/hooks/worktree-create.ts
var import_node_fs2 = __toESM(require("node:fs"));
var import_node_path2 = __toESM(require("node:path"));
var import_node_child_process = require("node:child_process");

// src/hooks/shared/input.ts
var import_node_fs = __toESM(require("node:fs"));

// src/lib/exec-names.ts
var EFFORTS = Object.freeze(["low", "medium", "high", "xhigh", "max"]);
var CLAUDE_PREFIX = "sidequest-exec-";
var READ_ONLY_CLAUDE_PREFIX = "sidequest-exec-readonly-";
var DIAGNOSTIC_PROBE_NAME = "sidequest-diagnostic-probe";
var DISPATCH_NAME = "sidequest-exec-dispatch";
var READ_ONLY_DISPATCH_NAME = "sidequest-exec-dispatch-readonly";
function stableClaudeName(effort) {
  return `${CLAUDE_PREFIX}${effort}`;
}
function stableReadOnlyClaudeName(effort) {
  return `${READ_ONLY_CLAUDE_PREFIX}${effort}`;
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

// src/hooks/shared/paths.ts
var import_node_path = __toESM(require("node:path"));
function pluginRoot() {
  return process.env.CLAUDE_PLUGIN_ROOT || import_node_path.default.join(__dirname, "..");
}
function runtimeModule(name) {
  return import_node_path.default.join(pluginRoot(), "lib", `${name}.js`);
}

// src/lib/hook-timeouts.ts
var WORKTREE_CREATE_HOOK_TIMEOUT_SECONDS = 120;
var WORKTREE_CREATE_SETUP_HEADROOM_MS = 1e4;
function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}
function worktreeCreateHookTimeoutMs(environment = process.env) {
  const injected = positiveInteger(environment.SIDEQUEST_WORKTREE_CREATE_HOOK_TIMEOUT_MS);
  return injected || WORKTREE_CREATE_HOOK_TIMEOUT_SECONDS * 1e3;
}
function worktreeSetupDeadlineMs(environment = process.env) {
  const hookTimeoutMs = worktreeCreateHookTimeoutMs(environment);
  const headroomMs = Math.min(WORKTREE_CREATE_SETUP_HEADROOM_MS, Math.floor(hookTimeoutMs / 10));
  return Math.max(1, hookTimeoutMs - headroomMs);
}

// src/lib/prepared-dispatch.ts
function canonicalPreparedDispatchExecutor(ticket) {
  const currentExecutor = String(ticket?.dispatch?.executor || "").trim();
  if (currentExecutor) return currentExecutor;
  const legacyExecutor = String(ticket?.dispatchExecutor || "").trim();
  if (legacyExecutor) return legacyExecutor;
  const routedExecutor = String(ticket?.exec?.agent || "").trim();
  return routedExecutor || null;
}

// src/lib/refusal-guidance.ts
function abbreviatedSessionId(value) {
  const sessionId = String(value || "").trim();
  return sessionId ? `\`${sessionId.slice(0, 12)}\`` : "<not recorded>";
}
function recordedWorktree(value) {
  const worktree = String(value || "").trim();
  return worktree ? `\`${worktree}\`` : "<not recorded>";
}
function worktreeBindingComparison(failure) {
  const candidatesConsidered = failure?.candidatesConsidered ?? 0;
  const candidates = Number.isInteger(candidatesConsidered) ? candidatesConsidered : 0;
  const count = `${candidates} dispatch record${candidates === 1 ? "" : "s"}`;
  const comparison = `hook session id ${abbreviatedSessionId(failure?.suppliedSessionId)} against recorded session id ${abbreviatedSessionId(failure?.recordedSessionId)}; hook canonical worktree ${recordedWorktree(failure?.suppliedWorktree)} against recorded canonical worktree ${recordedWorktree(failure?.recordedWorktree)}`;
  if (failure?.crossProject) {
    return `Considered ${count} on this board. The nearest dispatch failed predicate \`different_project\`: ${comparison}. The matching launched isolated dispatch is recorded for a different project, so WorktreeCreate cannot bind it here: dispatch it with sharedTree:true, or from a session rooted in that project.`;
  }
  if (failure?.predicate) {
    return `Considered ${count}. The nearest dispatch failed predicate \`${failure.predicate}\`: ${comparison}. Run \`sidequest pulse <ref>\` and re-dispatch with recovery evidence.`;
  }
  return `Considered ${count}. No launched isolated dispatch exists on this board for the hook-supplied session or canonical worktree. Run \`sidequest pulse <ref>\` and re-dispatch with recovery evidence.`;
}
function correctedMcpClaim(ref, ticket = {}, projectPath) {
  const executor = canonicalPreparedDispatchExecutor(ticket) || "<prepared executor>";
  const effort = ticket.effort || "<prepared effort>";
  const tokenFile = ticket.dispatch?.tokenFile || "<dispatch token file>";
  const project = projectPath || "<current board project>";
  return `Corrected MCP claim, without \`direct\`: \`mcp__plugin_sidequest_board__claim({ ref: ${JSON.stringify(ref)}, by: "<choose a unique id>", executor: ${JSON.stringify(executor)}, effort: ${JSON.stringify(effort)}, project: ${JSON.stringify(project)}, tokenFile: ${JSON.stringify(tokenFile)} })\`.`;
}
function dispatchedClaimGuidance(ref, ticket, projectPath) {
  const expected = canonicalPreparedDispatchExecutor(ticket) || "<prepared executor>";
  if (!ticket.dispatch?.tokenFile) {
    return `Expected executor: \`${expected}\`. Run \`sidequest dispatch ${ref}\` first to get the current token file.`;
  }
  return `Expected executor: \`${expected}\`. ${correctedMcpClaim(ref, ticket, projectPath)}`;
}
function refusalOwner(context) {
  return context.by || context.claim?.by || context.submission?.by || "another executor";
}
function notOwnerRecovery(ref, context) {
  if (context.submission?.by && !context.claim?.by) {
    return `${ref} has a parked submission from "${context.submission.by}". Its producer is terminal: do not ask it to release or resume. The control plane must publish it, use \`sidequest rework ${ref}\` when an unbound candidate needs repair, or follow the bound review's oracle and repair flow.`;
  }
  return `This is a live claim. Ask the claim holder to release it with \`sidequest release ${ref}\`.`;
}
var CLAIM_REFUSAL_MESSAGES = Object.freeze({
  not_found: (ref) => `${ref} does not exist on this board. Run \`sidequest list\` and claim a listed ticket.`,
  done: (ref) => `${ref} is already done. Choose another ticket with \`sidequest ready\`.`,
  claimed: (ref, claim) => `${ref} is already claimed by "${claim.by}"${claim.at ? ` since ${claim.at}` : ""}. Run \`sidequest pulse ${ref}\`. Do not work it or force-take a live claim. Only after observed terminal evidence, salvage useful work and release that exact claim with \`sidequest release ${ref}\` before fresh dispatching.`,
  not_owner: (ref, claim) => `${ref} is owned by "${refusalOwner(claim)}" rather than you. ${notOwnerRecovery(ref, claim)}`,
  busy: (ref) => `${ref} is temporarily locked by another claim attempt. Retry \`sidequest claim ${ref}\` in a moment.`,
  empty: () => "No tickets are available on this board. Run `sidequest ready` to inspect the queue.",
  submitted: (ref) => `${ref} is READY_FOR_INTEGRATION with a submitted commit. Run the orchestrator publish flow. While it is UNBOUND, a review rejection is \`sidequest rework ${ref} --by <reviewer> --review <evidence> --reason "what needs repair"\`, then dispatch the same ticket for a normal repair claim; the old candidate remains recorded until replacement submission. Once a \`review-audit\` ticket is bound to the candidate, rework, clear, reclaim, and amendment all refuse without writing: record the failed review's evidence on the review ticket, release that review with kind \`oracle\`, and repair through a fresh ticket, dispatch, commit, review, and candidate. \`submit --clear\` intentionally drops an unbound candidate and is only for an integration bounce. \`release\`/\`update\` alone refuse rather than silently leaving it wedged (SQ-1010).`,
  dispatch_required: (ref) => `${ref} is category-routed and has no prepared dispatch. File a spike for investigation when needed, then run \`sidequest dispatch ${ref}\` and spawn its returned executor. Inline is limited to the inline-safe allowlist: \`sidequest claim ${ref} --direct --reason "why this is inline-safe"\` (MCP \`direct:true\` with \`reason\`).`,
  token: (ref) => `${ref} has a prepared dispatch whose token file was missing, unreadable, or invalid. Re-run the exact claim from this executor's briefing with its dispatched \`tokenFile\` path; do not transcribe the token, retry dispatch from this executor, or release a dispatch you did not claim. The orchestrator should run \`sidequest pulse ${ref}\`: if it reports prepared or launched with no bound runtime identity, claim, or checkpoint, or stalled because a bound runtime never claimed past the claim-idle backstop, retire it in one call with \`sidequest dispatch ${ref} --recovery-evidence "<observed failed-claim evidence>"\` (MCP \`recoveryEvidence\`), which records the evidence on the failed attempt and prepares a fresh one; otherwise wait for the active attempt to become terminal before dispatching again.`,
  prepared_compatibility_stale: (ref) => `${ref}'s prepared Sidequest runtime/version snapshot no longer matches the installed MCP and hooks configuration, so the token-file refusal already retired that dispatch attempt. Stop without claiming. The orchestrator can dispatch ${ref} again for a fresh token file.`,
  unbound_dispatch: (ref) => `${ref} could not bind this executor runtime to its isolated dispatch. Claim it with the dispatched token file and exact executor from its briefing; the token file binds the claiming runtime. If that claim still fails, comment the refusal evidence and release ${ref} with kind \`technical_blocker\` so the orchestrator can redispatch it. Do not hand a command to the user.`,
  executor_mismatch: (ref, ticket, projectPath) => `${ref} has a prepared dispatch for a different executor. A token-file-valid claim from the currently-derived executor self-heals version skew, so re-run the claim from its briefing with that token file. ${dispatchedClaimGuidance(ref, ticket, projectPath)}`,
  direct_not_allowed: (ref, ticket, projectPath) => `${ref} resolves to ${ticket.model} · ${ticket.effort}. ${dispatchedClaimGuidance(ref, ticket, projectPath)} Direct claims are only for the inline-safe allowlist: a pinpointed integration mechanical fix, release bookkeeping, or the existing user-directed 1–2 named-file edit. "context already loaded", "small change", "faster myself", handoff/transfer cost, investigation or other-file reading, new behavior/API, and a failing test that does not pinpoint the location are invalid reasons.`,
  direct_reason_required: (ref) => `${ref} needs a recorded direct rationale. Add \`--reason "why this is inline-safe"\` (at least 20 characters) to \`sidequest claim ${ref} --direct\`, or pass MCP \`reason\`.`,
  direct_conflict: (ref) => `${ref} already has a prepared dispatch. Run \`sidequest dispatch ${ref}\` and spawn its returned executor with the current token file.`,
  terminal_claim_takeover_required: (ref) => `${ref}'s terminal executor claim should already have been released. Run \`sidequest pulse ${ref}\`; if it remains held, preserve the recorded checkpoint or worktree and release that exact claim before fresh-dispatching. Do not wait for an idle timeout or force-take a live executor.`,
  candidate_review_locked: (ref) => `${ref} has a candidate bound to a review-audit ticket, so it cannot be reclaimed, amended, cleared, or rejected directly. Record the failed review's evidence on the review ticket, then \`sidequest release <review-ref> --kind oracle --oracle "<what a human must decide>"\`. If the oracle accepts that defect conclusion, the binding records the candidate rejection; repair is a fresh ticket, dispatch, claim, commit, review, and candidate, then an integrated repair can supersede the rejected submission.`,
  not_claimed: (ref) => `${ref} is not claimed by anyone. Run \`sidequest claim ${ref}\` before submitting.`,
  no_submission: (ref) => `${ref} has no submission to clear. Run \`sidequest submissions\` to inspect work awaiting integration.`
});
var WORKTREE_CREATION_REFUSALS = Object.freeze({
  project_unavailable: (repository) => `${repository} is not a registered Sidequest board, so this session cannot create a dispatch worktree in it. Register the project, or dispatch with sharedTree:true.`,
  dispatch_binding_unavailable: (_repository, failure) => worktreeBindingComparison(failure),
  dispatch_launch_unrecorded: (repository) => `The board for ${repository} holds a prepared dispatch for this session but no recorded launch, so no launched attempt exists to reserve this checkout, and a prepared attempt never supplies creation authority. Run \`sidequest pulse <ref>\`, then \`sidequest dispatch <ref> --recovery-evidence "WorktreeCreate refused: the dispatch launch was never recorded"\`.`,
  baseline_unavailable: () => "The launched dispatch recorded no base commit, so its worktree has no revision to check out. Re-dispatch the ticket for a fresh baseline."
});
function worktreeCreationRefusalMessage(reason, repository, failure) {
  const guidance = WORKTREE_CREATION_REFUSALS[reason];
  return `worktree lease refused creation: ${reason || "dispatch binding is incomplete"}${guidance ? `. ${guidance(repository, failure)}` : ""}`;
}

// src/hooks/worktree-create.ts
var leaseKernel = require(runtimeModule("kernel/worktree"));
function git(repository, args) {
  return (0, import_node_child_process.execFileSync)("git", args, {
    cwd: repository,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}
function gitSucceeds(repository, args) {
  try {
    git(repository, args);
    return true;
  } catch (_) {
    return false;
  }
}
function repositoryFor(cwd) {
  return import_node_path2.default.resolve(git(cwd, ["rev-parse", "--show-toplevel"]));
}
function samePath(left, right) {
  return leaseKernel.canonicalPath(left) === leaseKernel.canonicalPath(right);
}
function linkedCheckoutIdentity(target) {
  try {
    const hostWorktreePath = git(target, ["rev-parse", "--show-toplevel"]);
    const worktree = import_node_path2.default.resolve(hostWorktreePath);
    const gitPath = (value) => import_node_path2.default.isAbsolute(value) ? value : import_node_path2.default.resolve(worktree, value);
    const gitDirectory = gitPath(git(worktree, ["rev-parse", "--git-dir"]));
    return {
      hostWorktreePath,
      worktree,
      gitDirectory,
      commonGitDirectory: gitPath(git(worktree, ["rev-parse", "--git-common-dir"])),
      checkoutInstance: leaseKernel.checkoutInstanceIdentity(gitDirectory),
      revision: git(worktree, ["rev-parse", "--verify", "HEAD^{commit}"])
    };
  } catch (_) {
    return null;
  }
}
function completedTargetMatches(binding) {
  const identity = linkedCheckoutIdentity(String(binding.worktree));
  return Boolean(identity && binding.expectedGitDirectory && binding.expectedCommonGitDirectory && binding.expectedCheckoutInstance && binding.expectedRevision && samePath(identity.worktree, String(binding.worktree)) && samePath(identity.gitDirectory, binding.expectedGitDirectory) && samePath(identity.commonGitDirectory, binding.expectedCommonGitDirectory) && identity.checkoutInstance === binding.expectedCheckoutInstance && identity.revision === binding.expectedRevision);
}
function createWorktree(binding, name) {
  const repository = String(binding.repository);
  const target = String(binding.worktree);
  const baseline = String(binding.baseline);
  import_node_fs2.default.mkdirSync(import_node_path2.default.dirname(target), { recursive: true });
  if (import_node_fs2.default.existsSync(target)) {
    if (binding.creationCompleted && completedTargetMatches(binding)) return false;
    throw new Error(`worktree destination existed before this dispatch completed its creation: ${target}`);
  }
  if (binding.creationCompleted) throw new Error(`completed worktree creation is missing its bound checkout: ${target}`);
  const branch = `worktree-${name}`;
  git(repository, ["check-ref-format", "--branch", branch]);
  if (gitSucceeds(repository, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])) {
    git(repository, ["worktree", "add", target, branch]);
    return true;
  }
  git(repository, ["worktree", "add", "-b", branch, target, baseline]);
  return true;
}
function registeredProject(store, repository) {
  return store.findProject(store.nearestRepoRoot(repository));
}
function bindCreation(repository, sessionId, worktree) {
  const store = require(runtimeModule("store"));
  const project = registeredProject(store, repository);
  if (!project.ok || !project.slug) return { ok: false, reason: "project_unavailable" };
  return store.bindDispatchWorktreeCreation(project.slug, sessionId, worktree);
}
function completeCreation(repository, sessionId, worktree) {
  const store = require(runtimeModule("store"));
  const project = registeredProject(store, repository);
  if (!project.ok || !project.slug) return { ok: false, reason: "project_unavailable" };
  return store.completeDispatchWorktreeCreation(project.slug, sessionId, worktree);
}
function recordProvisioningFailure(repository, sessionId, worktree, failure) {
  const store = require(runtimeModule("store"));
  const project = registeredProject(store, repository);
  if (!project.ok || !project.slug) return { ok: false, reason: "project_unavailable" };
  return store.recordDispatchWorktreeProvisioningFailure(project.slug, sessionId, worktree, failure);
}
function recordDependencyLink(repository, sessionId, worktree, link) {
  const store = require(runtimeModule("store"));
  const project = registeredProject(store, repository);
  if (!project.ok || !project.slug) return { ok: false, reason: "project_unavailable" };
  return store.recordDispatchWorktreeDependencyLink(project.slug, sessionId, worktree, link);
}
function plannedRevision(repository, name, baseline) {
  const branch = `worktree-${name}`;
  git(repository, ["check-ref-format", "--branch", branch]);
  return gitSucceeds(repository, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]) ? git(repository, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]) : git(repository, ["rev-parse", "--verify", `${baseline}^{commit}`]);
}
function preparedWorktreeLease(binding, name) {
  const gitDirectory = git(binding.repository, ["rev-parse", "--git-dir"]);
  const commonGitDirectory = git(binding.repository, ["rev-parse", "--git-common-dir"]);
  const gitPath = (value) => import_node_path2.default.isAbsolute(value) ? value : import_node_path2.default.resolve(binding.repository, value);
  return leaseKernel.createWorktreeLease({
    repository: binding.repository,
    gitDirectory: gitPath(gitDirectory),
    commonGitDirectory: gitPath(commonGitDirectory),
    dispatchRef: binding.ref,
    dispatchBaseline: binding.baseline,
    observedRevision: plannedRevision(binding.repository, name, binding.baseline),
    observedWorktree: binding.worktree,
    boundWorktree: binding.worktree,
    identity: { status: "bound", dispatchRef: binding.ref },
    phase: "prepared",
    locked: false,
    liveness: { status: "live", evidence: `dispatch ${binding.ref} reserved this creation` },
    provisioning: "host"
  });
}
function provisioningConfig(repository) {
  const store = require(runtimeModule("store"));
  const project = registeredProject(store, repository);
  return project.ok && project.slug ? store.boardConfig(project.slug) || {} : {};
}
function recoverCreatedWorktree(repository, sessionId, target, error) {
  const store = require(runtimeModule("store"));
  const project = registeredProject(store, repository);
  if (!project.ok || !project.slug) return "worktree recovery preserved the checkout because its project binding is unavailable";
  const recovery = store.recoverDispatchWorktreeCreation(project.slug, sessionId, target, error);
  if (!recovery.ok) return `worktree recovery preserved the checkout because ${recovery.reason || "its dispatch binding is unavailable"}`;
  if (recovery.cleanup?.reclaimed) return null;
  return `worktree recovery preserved the checkout because ${recovery.cleanup?.message || recovery.cleanup?.reason || "cleanup authority is incomplete"}`;
}
function main() {
  return createWorktreeMain();
}
async function createWorktreeMain() {
  const input = readStdin();
  if (!input || stringField(input, "hook_event_name") !== "WorktreeCreate") return;
  const name = stringField(input, "name");
  const sessionId = stringField(input, "session_id", "sessionId");
  const cwd = stringField(input, "cwd") || process.cwd();
  if (!name) throw new Error("WorktreeCreate requires a worktree name.");
  if (!sessionId) throw new Error("WorktreeCreate requires a dispatch session binding.");
  const repository = repositoryFor(cwd);
  const worktrees = require(runtimeModule("worktrees"));
  const target = worktrees.namedWorktreePath(repository, name);
  const binding = bindCreation(repository, sessionId, target);
  if (!binding.ok || !binding.ref || !binding.baseline || !binding.repository || !binding.worktree) {
    throw new Error(worktreeCreationRefusalMessage(String(binding.reason || ""), repository, binding.binding));
  }
  const boundCreation = {
    ...binding,
    ref: binding.ref,
    baseline: binding.baseline,
    repository: binding.repository,
    worktree: binding.worktree
  };
  const decision = leaseKernel.worktreeCreateDecision(preparedWorktreeLease(boundCreation, name));
  if (!decision.allowed) throw new Error(`worktree lease refused creation: ${decision.reason}`);
  const created = createWorktree(boundCreation, name);
  if (created) {
    try {
      const identity2 = linkedCheckoutIdentity(boundCreation.worktree);
      if (!identity2) throw new Error("new worktree identity is unavailable");
      leaseKernel.createCheckoutInstanceMarker(identity2.gitDirectory);
      const completed = completeCreation(boundCreation.repository, sessionId, boundCreation.worktree);
      if (!completed.ok) throw new Error(`worktree lease could not record completed creation: ${completed.reason || "completion binding is incomplete"}`);
      const provisioningFailure = await worktrees.provisionWorktree(
        boundCreation.repository,
        boundCreation.worktree,
        provisioningConfig(boundCreation.repository),
        {
          setupTimeoutMs: worktreeSetupDeadlineMs(),
          onDependencyLink: (link) => {
            const recorded = recordDependencyLink(boundCreation.repository, sessionId, boundCreation.worktree, link);
            if (!recorded.ok) throw new Error(`worktree lease could not record dependency link: ${recorded.reason || "dispatch binding is incomplete"}`);
          }
        }
      );
      if (provisioningFailure) {
        const recorded = recordProvisioningFailure(boundCreation.repository, sessionId, boundCreation.worktree, provisioningFailure);
        if (!recorded.ok) throw new Error(`worktree lease could not record setup failure: ${recorded.reason || "dispatch binding is incomplete"}`);
      }
    } catch (error) {
      const preservation = recoverCreatedWorktree(boundCreation.repository, sessionId, boundCreation.worktree, error);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(preservation ? `${message}; ${preservation}` : message);
    }
  }
  const identity = linkedCheckoutIdentity(boundCreation.worktree);
  if (!identity) throw new Error("created worktree identity is unavailable");
  process.stdout.write(`${identity.hostWorktreePath}
`);
}
main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`sidequest: could not create external worktree: ${message}
`);
  process.exit(1);
});
