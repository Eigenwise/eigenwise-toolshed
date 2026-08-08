"use strict";
const store = require("./store");
const NATIVE_PROMPT_MAX = 7600;
const EXECUTOR_RUN_GUIDANCE = "Run verify and gate commands in the foreground with a bounded timeout. Never sleep on a monitor for your own work. If a run must be backgrounded, confirm it started, then use a bounded poll that fails loud when the process is gone. A parked executor holds its claim while the board looks healthy, so fail loud and release instead.";
const EXECUTOR_VERIFY_GUIDANCE = "Submission verify must be exactly one of: a runnable cmd.exe command, for example `cd plugins/sidequest && npm run test:full`; or a manual check, for example `manual: checked the rendered page`. Windows runs commands through cmd.exe, so chain dependent commands with `&&`, never `;`. Put acceptance prose in the final report, not after a command.";
function executorPrompt(ticket, taskPrompt) {
  const base = String(taskPrompt || "").trim();
  if (!base) throw new Error("native_agent: prompt is required.");
  const contract = [
    "Authoritative ticket contract (the task prompt may add logistics only; do not narrow this scope):",
    `Title: ${ticket.title}`,
    ticket.description || "(No additional description was recorded.)"
  ].join("\n");
  const parts = [base, EXECUTOR_RUN_GUIDANCE, EXECUTOR_VERIFY_GUIDANCE, contract];
  if (ticket.executorAnchors) parts.push(`Anchors:
${ticket.executorAnchors}`);
  if (ticket.executorVerifyKind === "attestation") {
    parts.push(`Verify oracle: attestation
Observed artifact: ${ticket.executorAttestationArtifact}
Record evidence as \`attestation: ${ticket.executorAttestationArtifact} | <evidence produced> | <what it showed>\`.`);
  } else if (ticket.executorVerify) parts.push(`Verify command:
${ticket.executorVerify}`);
  const prompt = parts.join("\n\n");
  if (prompt.length > NATIVE_PROMPT_MAX) {
    throw new Error(`native_agent: task prompt plus ticket context exceeds the ${NATIVE_PROMPT_MAX}-character Windows-safe limit.`);
  }
  return prompt;
}
function nativeDispatchRequired(slug, idOrRef) {
  const ticket = store.getTicket(slug, idOrRef);
  if (!ticket) return { ok: false, reason: "missing", message: `no ticket "${idOrRef}".` };
  if (ticket.status === "done") return { ok: false, reason: "done", message: `${ticket.ref} is already done.` };
  if (ticket.status !== "todo") return { ok: false, reason: "not_todo", message: `${ticket.ref} is ${ticket.status}; release it to todo before dispatch.` };
  if (ticket.claim) return { ok: false, reason: "claimed", message: `${ticket.ref} is already claimed by ${ticket.claim.by}.` };
  const blockedBy = store.openBlockers(slug, ticket);
  if (blockedBy.length) {
    return { ok: false, reason: "blocked", message: `${ticket.ref} is blocked by ${blockedBy.join(", ")}.` };
  }
  return {
    ok: false,
    reason: "native_agent_required",
    message: `${ticket.ref} must be launched through native_agent and the current conversation's Agent tool; Sidequest no longer starts separate Claude processes.`
  };
}
module.exports = { nativeDispatchRequired, executorPrompt, NATIVE_PROMPT_MAX };
