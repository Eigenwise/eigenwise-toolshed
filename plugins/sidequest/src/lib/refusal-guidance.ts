export interface ClaimIdentity {
  by?: string;
  at?: string;
}

type RefusalMessage = (ref: string, claim: ClaimIdentity) => string;

export const CLAIM_REFUSAL_MESSAGES: Readonly<Record<string, RefusalMessage>> = Object.freeze({
  not_found: (ref) => `${ref} does not exist on this board. Run \`sidequest list\` and claim a listed ticket.`,
  done: (ref) => `${ref} is already done. Choose another ticket with \`sidequest ready\`.`,
  claimed: (ref, claim) => `${ref} is already claimed by "${claim.by}"${claim.at ? ` since ${claim.at}` : ''}. Run \`sidequest pulse ${ref}\` and do not work it unless you deliberately use \`--force\`.`,
  not_owner: (ref, claim) => `${ref} is claimed by "${claim.by}" rather than you. Use \`sidequest release ${ref} --by <claim-owner>\`, or add \`--force\` only when you are certain.`,
  busy: (ref) => `${ref} is temporarily locked by another claim attempt. Retry \`sidequest claim ${ref}\` in a moment.`,
  empty: () => 'No tickets are available on this board. Run `sidequest ready` to inspect the queue.',
  submitted: (ref) => `${ref} is READY_FOR_INTEGRATION with a submitted commit. Run the orchestrator publish flow, or use \`sidequest submit ${ref} --clear\` before re-claiming.`,
  dispatch_required: (ref) => `${ref} is category-routed and has no prepared dispatch. Run \`sidequest dispatch ${ref}\` and spawn its returned executor, or for deliberate inline work use \`sidequest claim ${ref} --direct\` (MCP \`direct:true\`).`,
  token: (ref) => `${ref} has a prepared dispatch whose token was missing or invalid. Re-run \`sidequest dispatch ${ref}\` and claim with its returned \`--token\` and \`--executor\`.`,
  executor_mismatch: (ref) => `${ref} has a prepared dispatch for a different executor. Re-run \`sidequest dispatch ${ref}\` and claim with its returned \`--executor\` and \`--token\`.`,
  direct_conflict: (ref) => `${ref} already has a prepared dispatch. Run \`sidequest dispatch ${ref}\` and spawn its returned executor with the current token.`,
  not_claimed: (ref) => `${ref} is not claimed by anyone. Run \`sidequest claim ${ref}\` before submitting.`,
  no_submission: (ref) => `${ref} has no submission to clear. Run \`sidequest submissions\` to inspect work awaiting integration.`,
});

export function claimRefusalMessage(reason: string, ref: string, claim: ClaimIdentity = {}): string {
  const message = CLAIM_REFUSAL_MESSAGES[reason];
  return message ? message(ref, claim) : `${ref} could not be claimed because ${reason}. Run \`sidequest pulse ${ref}\` and follow its current status.`;
}

export function routingDisabledMessage(ref: string): string {
  return `Routing is disabled on this board, so ${ref} cannot be dispatched. Run \`sidequest routing enabled\` then \`sidequest dispatch ${ref}\`, or use \`sidequest claim ${ref} --direct\` for deliberate inline work.`;
}
