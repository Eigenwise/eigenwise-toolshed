'use strict';

const CLAIM_REFUSAL_MESSAGES = Object.freeze({
  not_found: (ref) => `${ref} does not exist on this board. Run \`sidequest list\` and claim a listed ticket.`,
  done: (ref) => `${ref} is already done. Choose another ticket with \`sidequest ready\`.`,
  claimed: (ref, claim) => `${ref} is already claimed by "${claim.by}"${claim.at ? ` since ${claim.at}` : ''}. Run \`sidequest pulse ${ref}\` and do not work it unless you deliberately use \`--force\`.`,
  not_owner: (ref, claim) => `${ref} is claimed by "${claim.by}" rather than you. Use \`sidequest release ${ref} --by <claim-owner>\`, or add \`--force\` only when you are certain.`,
  busy: (ref) => `${ref} is temporarily locked by another claim attempt. Retry \`sidequest claim ${ref}\` in a moment.`,
  empty: () => 'No tickets are available on this board. Run \`sidequest ready\` to inspect the queue.',
  submitted: (ref) => `${ref} is READY_FOR_INTEGRATION with a submitted commit. Run the orchestrator publish flow, or use \`sidequest submit ${ref} --clear\` before re-claiming.`,
  dispatch_required: (ref) => `${ref} is category-routed and has no prepared dispatch. File a spike for investigation when needed, then run \`sidequest dispatch ${ref}\` and spawn its returned executor. Inline is a justified exception: \`sidequest claim ${ref} --direct --reason "why no executor can do this"\` (MCP \`direct:true\` with \`reason\`).`,
  token: (ref) => `${ref} has a prepared dispatch whose token was missing or invalid. Re-run \`sidequest dispatch ${ref}\` and claim with its returned \`--token\` and \`--executor\`.`,
  executor_mismatch: (ref) => `${ref} has a prepared dispatch for a different executor. Re-run \`sidequest dispatch ${ref}\` and claim with its returned \`--executor\` and \`--token\`.`,
  direct_not_allowed: (ref, ticket) => `${ref} resolves to ${ticket.model} · ${ticket.effort}. Run \`sidequest dispatch ${ref}\` and spawn its returned executor instead. A direct claim needs the user-granted \`direct-ok\` label. "context already loaded", "small change", and "handoff/transfer cost" are not valid direct reasons, and a direct claim cannot retroactively legitimize prior inline investigation.`,
  direct_reason_required: (ref) => `${ref} has a user-granted \`direct-ok\` label but still needs a direct rationale. Add \`--reason "why no executor can do this"\` (at least 20 characters) to \`sidequest claim ${ref} --direct\`, or pass MCP \`reason\`.`,
  direct_conflict: (ref) => `${ref} already has a prepared dispatch. Run \`sidequest dispatch ${ref}\` and spawn its returned executor with the current token.`,
  not_claimed: (ref) => `${ref} is not claimed by anyone. Run \`sidequest claim ${ref}\` before submitting.`,
  no_submission: (ref) => `${ref} has no submission to clear. Run \`sidequest submissions\` to inspect work awaiting integration.`,
});

function claimRefusalMessage(reason, ref, claim) {
  const message = CLAIM_REFUSAL_MESSAGES[reason];
  return message ? message(ref, claim || {}) : `${ref} could not be claimed because ${reason}. Run \`sidequest pulse ${ref}\` and follow its current status.`;
}

function routingDisabledMessage(ref) {
  return `Routing is disabled on this board, so ${ref} cannot be dispatched. Run \`sidequest routing enabled\` then \`sidequest dispatch ${ref}\`; on routed work, inline is a justified exception: \`sidequest claim ${ref} --direct --reason "why no executor can do this"\`.`;
}

module.exports = { CLAIM_REFUSAL_MESSAGES, claimRefusalMessage, routingDisabledMessage };
