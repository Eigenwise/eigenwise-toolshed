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
  routingDisabledMessage: () => routingDisabledMessage,
  scopeRequestNotOwnerMessage: () => scopeRequestNotOwnerMessage
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
  token: (ref) => `${ref} has a prepared dispatch whose token was missing or invalid. Re-run \`sidequest dispatch ${ref}\` and claim with its returned \`--token\` and \`--executor\`.`,
  unbound_dispatch: (ref) => `${ref} is an isolated dispatch without a bound harness agent identity. Do not claim its token manually. Run \`sidequest dispatch ${ref}\` and pass the returned spawn unchanged to Agent.`,
  executor_mismatch: (ref, ticket, projectPath) => `${ref} has a prepared dispatch for a different executor. ${dispatchedClaimGuidance(ref, ticket, projectPath)}`,
  direct_not_allowed: (ref, ticket, projectPath) => `${ref} resolves to ${ticket.model} · ${ticket.effort}. ${dispatchedClaimGuidance(ref, ticket, projectPath)} Direct claims are only for the inline-safe allowlist: a pinpointed integration mechanical fix, release bookkeeping, or the existing user-directed 1–2 named-file edit. "context already loaded", "small change", "faster myself", handoff/transfer cost, investigation or other-file reading, new behavior/API, and a failing test that does not pinpoint the location are invalid reasons.`,
  direct_reason_required: (ref) => `${ref} needs a recorded direct rationale. Add \`--reason "why this is inline-safe"\` (at least 20 characters) to \`sidequest claim ${ref} --direct\`, or pass MCP \`reason\`.`,
  direct_conflict: (ref) => `${ref} already has a prepared dispatch. Run \`sidequest dispatch ${ref}\` and spawn its returned executor with the current token.`,
  not_claimed: (ref) => `${ref} is not claimed by anyone. Run \`sidequest claim ${ref}\` before submitting.`,
  no_submission: (ref) => `${ref} has no submission to clear. Run \`sidequest submissions\` to inspect work awaiting integration.`
});
function scopeRequestNotOwnerMessage(ref, claim = {}) {
  const holder = claim.by || "<claim holder>";
  return `${ref} is claimed by "${holder}". Only that claim holder can re-run \`scopeRequest\`. Adding every requested path to declared files already approves and clears the pending request, so no re-run is needed after that update.`;
}
function claimRefusalMessage(reason, ref, claim = {}, projectPath) {
  const message = CLAIM_REFUSAL_MESSAGES[reason];
  return message ? message(ref, claim, projectPath) : `${ref} could not be claimed because ${reason}. Run \`sidequest pulse ${ref}\` and follow its current status.`;
}
function routingDisabledMessage(ref) {
  return `Routing is disabled on this board, so ${ref} cannot be dispatched. Run \`sidequest routing enabled\` then \`sidequest dispatch ${ref}\`; direct work is limited to the inline-safe allowlist: \`sidequest claim ${ref} --direct --reason "why this is inline-safe"\`.`;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CLAIM_REFUSAL_MESSAGES,
  claimRefusalMessage,
  routingDisabledMessage,
  scopeRequestNotOwnerMessage
});
