'use strict';
/**
 * Routed Sidequest work runs only through Claude Code's in-session Agent tool.
 *
 * The old headless drainer started independent `claude` processes. That lost the
 * current conversation, could not pin executor effort, and bypassed the native
 * Agent lifecycle. CLI and MCP callers must now create a temporary definition
 * through `native_agent`, then the current conversation invokes it with Agent.
 */

const store = require('./store');

// Native Agent prompts travel through Claude Code's Windows command surface.
// Leave room below the 8191-character argv ceiling for the Agent wrapper and
// preserve every supplied anchor/verify character rather than truncating it.
const NATIVE_PROMPT_MAX = 7600;

function executorPrompt(ticket, taskPrompt) {
  const base = String(taskPrompt || '').trim();
  if (!base) throw new Error('native_agent: prompt is required.');
  const contract = [
    'Authoritative ticket contract (the task prompt may add logistics only; do not narrow this scope):',
    `Title: ${ticket.title}`,
    ticket.description || '(No additional description was recorded.)',
  ].join('\n');
  const parts = [base, contract];
  if (ticket.executorAnchors) parts.push(`Anchors:\n${ticket.executorAnchors}`);
  if (ticket.executorVerify) parts.push(`Verify command:\n${ticket.executorVerify}`);
  const prompt = parts.join('\n\n');
  if (prompt.length > NATIVE_PROMPT_MAX) {
    throw new Error(`native_agent: task prompt plus ticket context exceeds the ${NATIVE_PROMPT_MAX}-character Windows-safe limit.`);
  }
  return prompt;
}

function nativeDispatchRequired(slug, idOrRef) {
  const ticket = store.getTicket(slug, idOrRef);
  if (!ticket) return { ok: false, reason: 'missing', message: `no ticket "${idOrRef}".` };
  if (ticket.status === 'done') return { ok: false, reason: 'done', message: `${ticket.ref} is already done.` };
  if (ticket.status !== 'todo') return { ok: false, reason: 'not_todo', message: `${ticket.ref} is ${ticket.status}; release it to todo before dispatch.` };
  if (ticket.claim) return { ok: false, reason: 'claimed', message: `${ticket.ref} is already claimed by ${ticket.claim.by}.` };
  const blockedBy = store.openBlockers(slug, ticket);
  if (blockedBy.length) {
    return { ok: false, reason: 'blocked', message: `${ticket.ref} is blocked by ${blockedBy.join(', ')}.` };
  }
  return {
    ok: false,
    reason: 'native_agent_required',
    message: `${ticket.ref} must be launched through native_agent and the current conversation's Agent tool; Sidequest no longer starts separate Claude processes.`,
  };
}

module.exports = { nativeDispatchRequired, executorPrompt, NATIVE_PROMPT_MAX };
