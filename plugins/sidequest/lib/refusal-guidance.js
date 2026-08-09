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
  claimRefusalMessage: () => claimRefusalMessage,
  negativeControlRecoveryGuidance: () => negativeControlRecoveryGuidance,
  routingDisabledMessage: () => routingDisabledMessage
});
module.exports = __toCommonJS(refusal_guidance_exports);
function correctedMcpClaim(ref, ticket = {}, projectPath) {
  const executor = ticket.dispatchExecutor || ticket.exec?.agent || "<prepared executor>";
  const effort = ticket.effort || "<prepared effort>";
  const token = ticket.dispatchNonce || "<dispatch token>";
  const project = projectPath || "<current board project>";
  return `Corrected MCP claim, without \`direct\`: \`mcp__plugin_sidequest_board__claim({ ref: ${JSON.stringify(ref)}, by: "<choose a unique id>", executor: ${JSON.stringify(executor)}, effort: ${JSON.stringify(effort)}, project: ${JSON.stringify(project)}, token: ${JSON.stringify(token)} })\`.`;
}
function dispatchedClaimGuidance(ref, ticket, projectPath) {
  const expected = ticket.dispatchExecutor || ticket.exec?.agent || "<prepared executor>";
  if (!ticket.dispatchNonce) {
    return `Expected executor: \`${expected}\`. Run \`sidequest dispatch ${ref}\` first to get the current token.`;
  }
  return `Expected executor: \`${expected}\`. ${correctedMcpClaim(ref, ticket, projectPath)}`;
}
const CLAIM_REFUSAL_MESSAGES = Object.freeze({
  not_found: (ref) => `${ref} does not exist on this board. Run \`sidequest list\` and claim a listed ticket.`,
  done: (ref) => `${ref} is already done. Choose another ticket with \`sidequest ready\`.`,
  claimed: (ref, claim) => `${ref} is already claimed by "${claim.by}"${claim.at ? ` since ${claim.at}` : ""}. Run \`sidequest pulse ${ref}\` and do not work it unless you deliberately use \`--force\`.`,
  not_owner: (ref, claim) => `${ref} is claimed by "${claim.by}" rather than you. Ask the claim holder to release it, or add \`--force\` only when you are certain.`,
  busy: (ref) => `${ref} is temporarily locked by another claim attempt. Retry \`sidequest claim ${ref}\` in a moment.`,
  empty: () => "No tickets are available on this board. Run `sidequest ready` to inspect the queue.",
  submitted: (ref) => `${ref} is READY_FOR_INTEGRATION with a submitted commit. Run the orchestrator publish flow, or reject it before re-claiming: \`sidequest submit ${ref} --clear --status todo\` (MCP \`submit\` with \`clear:true, status:"todo"\`). \`release\`/\`update\` alone will refuse rather than silently leaving it wedged (SQ-1010).`,
  dispatch_required: (ref) => `${ref} is category-routed and has no prepared dispatch. File a spike for investigation when needed, then run \`sidequest dispatch ${ref}\` and spawn its returned executor. Inline is limited to the inline-safe allowlist: \`sidequest claim ${ref} --direct --reason "why this is inline-safe"\` (MCP \`direct:true\` with \`reason\`).`,
  token: (ref) => `${ref} has a prepared dispatch whose token was missing or invalid. Do not retry dispatch from this executor or release a dispatch you did not claim. The orchestrator should run \`sidequest pulse ${ref}\`, wait for any launched or bound attempt to become terminal, then run \`sidequest dispatch ${ref}\` once and spawn that returned executor with its token and executor.`,
  unbound_dispatch: (ref) => `${ref} could not bind this executor runtime to its isolated dispatch. Claim it with the \`--token\` and exact executor from its briefing; the token binds the claiming runtime. If that tokened claim still fails, release ${ref} with the refusal reason so the orchestrator can redispatch it.`,
  executor_mismatch: (ref, ticket, projectPath) => `${ref} has a prepared dispatch for a different executor. ${dispatchedClaimGuidance(ref, ticket, projectPath)}`,
  direct_not_allowed: (ref, ticket, projectPath) => `${ref} resolves to ${ticket.model} · ${ticket.effort}. ${dispatchedClaimGuidance(ref, ticket, projectPath)} Direct claims are only for the inline-safe allowlist: a pinpointed integration mechanical fix, release bookkeeping, or the existing user-directed 1–2 named-file edit. "context already loaded", "small change", "faster myself", handoff/transfer cost, investigation or other-file reading, new behavior/API, and a failing test that does not pinpoint the location are invalid reasons.`,
  direct_reason_required: (ref) => `${ref} needs a recorded direct rationale. Add \`--reason "why this is inline-safe"\` (at least 20 characters) to \`sidequest claim ${ref} --direct\`, or pass MCP \`reason\`.`,
  direct_conflict: (ref) => `${ref} already has a prepared dispatch. Run \`sidequest dispatch ${ref}\` and spawn its returned executor with the current token.`,
  terminal_claim_takeover_required: (ref) => `${ref}'s prepared executor has a recorded terminal outcome while still holding its claim. The orchestrator can take over without redispatching: run \`sidequest claim ${ref} --direct --force --reason "terminal executor recovery"\`, or call MCP \`claim\` with \`direct:true\`, \`force:true\`, and a recorded recovery reason, then submit the existing verified commit.`,
  not_claimed: (ref) => `${ref} is not claimed by anyone. Run \`sidequest claim ${ref}\` before submitting.`,
  no_submission: (ref) => `${ref} has no submission to clear. Run \`sidequest submissions\` to inspect work awaiting integration.`
});
function claimRefusalMessage(reason, ref, claim = {}, projectPath) {
  const message = CLAIM_REFUSAL_MESSAGES[reason];
  return message ? message(ref, claim, projectPath) : `${ref} could not be claimed because ${reason}. Run \`sidequest pulse ${ref}\` and follow its current status.`;
}
function routingDisabledMessage(ref) {
  return `Routing is disabled on this board, so ${ref} cannot be dispatched. Run \`sidequest routing enabled\` then \`sidequest dispatch ${ref}\`; direct work is limited to the inline-safe allowlist: \`sidequest claim ${ref} --direct --reason "why this is inline-safe"\`.`;
}
function negativeControlRecoveryGuidance() {
  return "Revert the non-test changes, run the changed tests, and keep them importable. Only an assertion failure in the changed tests proves they catch wrong behavior; an ImportError or collection error only proves a symbol vanished. Post a line beginning [sidequest:negative-control] <command> failed=<n> with n greater than zero, then restore the change and run the declared verify. You may add context after failed=<n>. For every added or modified named test, add [sidequest:negative-control-test] failed <test name>. If a named test does not cover the reverted change, add [sidequest:negative-control-test] unaffected <test name> because <reason> instead. If the control cannot run, post a line beginning [sidequest:negative-control] waived <reason of at least 20 characters>.";
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CLAIM_REFUSAL_MESSAGES,
  claimRefusalMessage,
  negativeControlRecoveryGuidance,
  routingDisabledMessage
});
