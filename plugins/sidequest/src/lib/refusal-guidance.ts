export interface ClaimIdentity {
  by?: string;
  at?: string;
}

export interface ClaimContext extends ClaimIdentity {
  dispatchExecutor?: string;
  dispatchNonce?: string;
  model?: string;
  effort?: string;
  exec?: { agent?: string };
}

type RefusalMessage = (ref: string, claim: ClaimContext, projectPath?: string) => string;

function correctedMcpClaim(ref: string, ticket: ClaimContext = {}, projectPath?: string): string {
  const executor = ticket.dispatchExecutor || ticket.exec?.agent || '<prepared executor>';
  const effort = ticket.effort || '<prepared effort>';
  const token = ticket.dispatchNonce || '<dispatch token>';
  const project = projectPath || '<current board project>';
  return `Corrected MCP claim, without \`direct\`: \`mcp__plugin_sidequest_board__claim({ ref: ${JSON.stringify(ref)}, by: "<choose a unique id>", executor: ${JSON.stringify(executor)}, effort: ${JSON.stringify(effort)}, project: ${JSON.stringify(project)}, token: ${JSON.stringify(token)} })\`.`;
}

function dispatchedClaimGuidance(ref: string, ticket: ClaimContext, projectPath?: string): string {
  const expected = ticket.dispatchExecutor || ticket.exec?.agent || '<prepared executor>';
  if (!ticket.dispatchNonce) {
    return `Expected executor: \`${expected}\`. Run \`sidequest dispatch ${ref}\` first to get the current token.`;
  }
  return `Expected executor: \`${expected}\`. ${correctedMcpClaim(ref, ticket, projectPath)}`;
}
export const CLAIM_REFUSAL_MESSAGES: Readonly<Record<string, RefusalMessage>> = Object.freeze({
  not_found: (ref) => `${ref} does not exist on this board. Run \`sidequest list\` and claim a listed ticket.`,
  done: (ref) => `${ref} is already done. Choose another ticket with \`sidequest ready\`.`,
  claimed: (ref, claim) => `${ref} is already claimed by "${claim.by}"${claim.at ? ` since ${claim.at}` : ''}. Run \`sidequest pulse ${ref}\` and do not work it unless you deliberately use \`--force\`.`,
  not_owner: (ref, claim) => `${ref} is claimed by "${claim.by}" rather than you. Ask the claim holder to release it, or add \`--force\` only when you are certain.`,
  busy: (ref) => `${ref} is temporarily locked by another claim attempt. Retry \`sidequest claim ${ref}\` in a moment.`,
  empty: () => 'No tickets are available on this board. Run `sidequest ready` to inspect the queue.',
  submitted: (ref) => `${ref} is READY_FOR_INTEGRATION with a submitted commit. Run the orchestrator publish flow, or reject it before re-claiming: \`sidequest submit ${ref} --clear --status todo\` (MCP \`submit\` with \`clear:true, status:"todo"\`). \`release\`/\`update\` alone will refuse rather than silently leaving it wedged (SQ-1010).`,
  dispatch_required: (ref) => `${ref} is category-routed and has no prepared dispatch. File a spike for investigation when needed, then run \`sidequest dispatch ${ref}\` and spawn its returned executor. Inline is limited to the inline-safe allowlist: \`sidequest claim ${ref} --direct --reason "why this is inline-safe"\` (MCP \`direct:true\` with \`reason\`).`,
  token: (ref) => `${ref} has a prepared dispatch whose token was missing or invalid. Re-run \`sidequest dispatch ${ref}\` and claim with its returned \`--token\` and \`--executor\`.`,
  unbound_dispatch: (ref) => `${ref} could not bind this executor runtime to its isolated dispatch. Claim it with the \`--token\` and exact executor from its briefing; the token binds the claiming runtime. If that tokened claim still fails, release ${ref} with the refusal reason so the orchestrator can redispatch it.`,
  executor_mismatch: (ref, ticket, projectPath) => `${ref} has a prepared dispatch for a different executor. ${dispatchedClaimGuidance(ref, ticket, projectPath)}`,
  direct_not_allowed: (ref, ticket, projectPath) => `${ref} resolves to ${ticket.model} · ${ticket.effort}. ${dispatchedClaimGuidance(ref, ticket, projectPath)} Direct claims are only for the inline-safe allowlist: a pinpointed integration mechanical fix, release bookkeeping, or the existing user-directed 1–2 named-file edit. "context already loaded", "small change", "faster myself", handoff/transfer cost, investigation or other-file reading, new behavior/API, and a failing test that does not pinpoint the location are invalid reasons.`,
  direct_reason_required: (ref) => `${ref} needs a recorded direct rationale. Add \`--reason "why this is inline-safe"\` (at least 20 characters) to \`sidequest claim ${ref} --direct\`, or pass MCP \`reason\`.`,
  direct_conflict: (ref) => `${ref} already has a prepared dispatch. Run \`sidequest dispatch ${ref}\` and spawn its returned executor with the current token.`,
  not_claimed: (ref) => `${ref} is not claimed by anyone. Run \`sidequest claim ${ref}\` before submitting.`,
  no_submission: (ref) => `${ref} has no submission to clear. Run \`sidequest submissions\` to inspect work awaiting integration.`,
});

export function scopeRequestNotOwnerMessage(ref: string, claim: ClaimContext = {}): string {
  const holder = claim.by || '<claim holder>';
  return `${ref} is claimed by "${holder}". Only that claim holder can re-run \`scopeRequest\`. Adding every requested path to declared files already approves and clears the pending request, so no re-run is needed after that update.`;
}

export function claimRefusalMessage(reason: string, ref: string, claim: ClaimContext = {}, projectPath?: string): string {
  const message = CLAIM_REFUSAL_MESSAGES[reason];
  return message ? message(ref, claim, projectPath) : `${ref} could not be claimed because ${reason}. Run \`sidequest pulse ${ref}\` and follow its current status.`;
}

export function routingDisabledMessage(ref: string): string {
  return `Routing is disabled on this board, so ${ref} cannot be dispatched. Run \`sidequest routing enabled\` then \`sidequest dispatch ${ref}\`; direct work is limited to the inline-safe allowlist: \`sidequest claim ${ref} --direct --reason "why this is inline-safe"\`.`;
}

export function negativeControlRecoveryGuidance(): string {
  return 'Revert the non-test changes, run the changed tests, and keep them importable. Only an assertion failure in the changed tests proves they catch wrong behavior; an ImportError or collection error only proves a symbol vanished. Post a line beginning [sidequest:negative-control] <command> failed=<n> with n greater than zero, then restore the change and run the declared verify. You may add context after failed=<n>. If the control cannot run, post a line beginning [sidequest:negative-control] waived <reason of at least 20 characters>.';
}
