// The board fields only the main thread may set. This imports nothing, so the guards hooks module refuses
// them from a subagent before any engine call that could fail, and the admission decision reads the same table.
const CLOSEOUT_UPDATE_FIELDS = new Set([
  'files', 'addFiles', 'removeFiles', 'status', 'readonly', 'readonlyOverride', 'workingTreeDelivery',
  'externalDeliverable', 'verify', 'verifyKind', 'attestationArtifact', 'verifyCwd', 'admitComposition',
  'executorVerify', 'executorVerifyKind', 'executorAttestationArtifact', 'executorVerifyCwd',
]);

export const MAIN_THREAD_MUTATIONS: Record<string, { matches: (input: Record<string, unknown>) => boolean; denial: string }> = {
  mcp__plugin_sidequest_board__dispatch: {
    matches: (input) => Object.hasOwn(input, 'workProvenance'),
    denial: 'sidequest: subagents cannot declare work provenance. Ask the main thread to freeze source-bound factual provenance before dispatch; actor labels and shared session ids grant nothing.',
  },
  mcp__plugin_sidequest_board__update: {
    matches: (input) => Array.from(CLOSEOUT_UPDATE_FIELDS).some((field) => Object.hasOwn(input, field)),
    denial: 'sidequest: subagents cannot update closeout fields or admit a composition through MCP. Use scopeRequest for files, or ask the orchestrator to set closeout fields or use update.admitComposition from the main thread.',
  },
  mcp__plugin_sidequest_board__scopeRequest: {
    // scopeRequest with grant:true widens declaredFiles for a refusal the ticket
    // already recorded, which is a live-claim mutation just like the update fields
    // above. Without this, a subagent could pass by:'orchestrator' to mint the
    // grant itself; the store's by-mismatch check only catches the claim holder's
    // own by, not an impersonated one.
    matches: (input) => input.grant === true,
    denial: 'sidequest: subagents cannot grant a refused scope request through MCP. Ask the orchestrator to grant it from the main thread.',
  },
  mcp__plugin_sidequest_board__remove: {
    // force:true is the only path that deletes a live-claimed ticket, so it is the
    // executor's escape hatch (delete the ticket to shed the claim). The store
    // refuses ungranted live-claim deletion, but deny it here too so a subagent
    // can never mint the main-thread grant by riding the MCP remove handler.
    matches: (input) => input.force === true,
    denial: 'sidequest: subagents cannot force-remove a ticket. Release your claim, or ask the orchestrator to remove it from the main thread.',
  },
  mcp__plugin_sidequest_board__verdict: {
    matches: (input) => ['correct', 'finalize'].some(field => Object.hasOwn(input, field)),
    denial: 'sidequest: subagents cannot finalize or correct completed review verdicts. Ask the orchestrator to use verdict with finalize or correct from the main thread.',
  },
};

export function mainThreadMutationDenial(toolName: string, toolInput: Record<string, unknown>): string | null {
  const rule = MAIN_THREAD_MUTATIONS[toolName];
  return rule?.matches(toolInput) ? rule.denial : null;
}
