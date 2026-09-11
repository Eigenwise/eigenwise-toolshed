"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var refusal_guidance_exports = {};
__export(refusal_guidance_exports, {
  CLAIM_REFUSAL_MESSAGES: () => CLAIM_REFUSAL_MESSAGES,
  candidateReviewRequiredGuidance: () => candidateReviewRequiredGuidance,
  claimRefusalMessage: () => claimRefusalMessage,
  filesystemSnapshotLimitGuidance: () => filesystemSnapshotLimitGuidance,
  manualCandidateDeliveryGuidance: () => manualCandidateDeliveryGuidance,
  negativeControlRecoveryGuidance: () => negativeControlRecoveryGuidance,
  routingDisabledMessage: () => routingDisabledMessage,
  worktreeCreationRefusalMessage: () => worktreeCreationRefusalMessage
});
module.exports = __toCommonJS(refusal_guidance_exports);
var import_prepared_dispatch = require("./prepared-dispatch.js");
function correctedMcpClaim(ref, ticket = {}, projectPath) {
  const executor = (0, import_prepared_dispatch.canonicalPreparedDispatchExecutor)(ticket) || "<prepared executor>";
  const effort = ticket.effort || "<prepared effort>";
  const tokenFile = ticket.dispatch?.tokenFile || "<dispatch token file>";
  const project = projectPath || "<current board project>";
  return `Corrected MCP claim, without \`direct\`: \`mcp__plugin_sidequest_board__claim({ ref: ${JSON.stringify(ref)}, by: "<choose a unique id>", executor: ${JSON.stringify(executor)}, effort: ${JSON.stringify(effort)}, project: ${JSON.stringify(project)}, tokenFile: ${JSON.stringify(tokenFile)} })\`.`;
}
function dispatchedClaimGuidance(ref, ticket, projectPath) {
  const expected = (0, import_prepared_dispatch.canonicalPreparedDispatchExecutor)(ticket) || "<prepared executor>";
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
const CLAIM_REFUSAL_MESSAGES = Object.freeze({
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
function claimRefusalMessage(reason, ref, claim = {}, projectPath) {
  const message = CLAIM_REFUSAL_MESSAGES[reason];
  return message ? message(ref, claim, projectPath) : `${ref} could not be claimed because ${reason}. Run \`sidequest pulse ${ref}\` and follow its current status.`;
}
const WORKTREE_CREATION_REFUSALS = Object.freeze({
  project_unavailable: (repository) => `${repository} is not a registered Sidequest board, so this session cannot create a dispatch worktree in it. Register the project, or dispatch with sharedTree:true.`,
  dispatch_binding_unavailable: (repository) => `This session has no launched isolated dispatch on the board for ${repository}. WorktreeCreate resolves the board from this checkout alone, so a dispatch prepared for a different project can never bind here: dispatch it with sharedTree:true, or from a session rooted in that project. Otherwise run \`sidequest pulse <ref>\` and re-dispatch with recovery evidence.`,
  dispatch_launch_unrecorded: (repository) => `The board for ${repository} holds a prepared dispatch for this session but no recorded launch, so no launched attempt exists to reserve this checkout, and a prepared attempt never supplies creation authority. Run \`sidequest pulse <ref>\`, then \`sidequest dispatch <ref> --recovery-evidence "WorktreeCreate refused: the dispatch launch was never recorded"\`.`,
  baseline_unavailable: () => "The launched dispatch recorded no base commit, so its worktree has no revision to check out. Re-dispatch the ticket for a fresh baseline."
});
function worktreeCreationRefusalMessage(reason, repository) {
  const guidance = WORKTREE_CREATION_REFUSALS[reason];
  return `worktree lease refused creation: ${reason || "dispatch binding is incomplete"}${guidance ? `. ${guidance(repository)}` : ""}`;
}
function routingDisabledMessage(ref) {
  return `Routing is disabled on this board, so ${ref} cannot be dispatched. Run \`sidequest routing enabled\` then \`sidequest dispatch ${ref}\`; direct work is limited to the inline-safe allowlist: \`sidequest claim ${ref} --direct --reason "why this is inline-safe"\`.`;
}
function manualCandidateDeliveryGuidance() {
  return 'For refs with different pinned verifier requirements, keep those requirements and candidate identities unchanged. Compose the exact accepted candidate refs in the registered target, run every pinned verifier plus the full composed gate, then groomClose each with its immutable deliveryCommit and deliveryMethod:"manual"; omit integration:true.';
}
function candidateReviewRequiredGuidance() {
  return "A bound review must terminally complete on this exact candidate, from a runtime identity that is not the one that submitted it. The two sides are held to different proof. The submitting side may identify itself by the attempt's hook-bound agent id, or by the token prefix and agent name recorded against a proven claim-token binding; an attempt older than bind-source recording proves that binding through its recorded bind time instead. The reviewing side needs the hook-bound agent id and nothing else stands in: a dispatch token and agent name authenticate a dispatch, not the runtime that ran it, and one runtime can hold several of those. Run `sidequest pulse <ref>` and read `dispatch.attempts` on both tickets to see which half is missing. If the review never ran to a terminal done attempt, dispatch it and let it close normally. If it reviewed a different candidate, that candidate needs its own bound review. If the review attempt carries no hook-bound agent id, its executor never bound a runtime: re-dispatch the review on a host whose PreToolUse hook reports agent_id, and let that attempt close normally. If the submitting attempt recorded no identity and no bind time at all, it bound nothing and nothing recovers it: re-dispatch that ticket so the replacement attempt binds, then review the resubmitted candidate. Do not assert an identity, hand-edit the attempt, or route around this with a manual delivery: the manual and groomClose routes enforce the same check.";
}
function negativeControlRecoveryGuidance() {
  return "Revert the non-test changes, run the changed tests, and keep them importable. Say which one happened: failure-kind=assertion when the changed tests failed their assertions, failure-kind=import or failure-kind=collection when the revert stopped them loading, because only an assertion failure proves they catch wrong behavior. Post [sidequest:negative-control] target=<broken file:line or behavior>; assertion=<named assertion>; <command> failed=<n> failure-kind=<assertion|import|collection> with n greater than zero. The target and assertion must be the changed behavior this ticket is about. Then restore the change and run the declared verify. You may add context after failed=<n>. For every added or modified named test, add [sidequest:negative-control-test] failed <test name>. If a named test does not cover the reverted change, add [sidequest:negative-control-test] unaffected <test name> because <reason> instead. If the control cannot run, post a line beginning [sidequest:negative-control] waived <reason of at least 20 characters>.";
}
function filesystemSnapshotLimitGuidance(projectPath, limit) {
  const unit = limit.bound === "path cap" ? "paths" : limit.bound === "byte cap" ? "bytes" : "ms";
  return `filesystem snapshot refused for ${projectPath}: ${limit.bound} reached ${limit.observed} ${unit}; cap ${limit.cap} ${unit}. Initialize a git repository at the project root so dispatch uses the cheaper git adapter, or point the board at a smaller directory.`;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CLAIM_REFUSAL_MESSAGES,
  candidateReviewRequiredGuidance,
  claimRefusalMessage,
  filesystemSnapshotLimitGuidance,
  manualCandidateDeliveryGuidance,
  negativeControlRecoveryGuidance,
  routingDisabledMessage,
  worktreeCreationRefusalMessage
});
