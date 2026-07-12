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

function nativeDispatchRequired(slug, idOrRef) {
  const ticket = store.getTicket(slug, idOrRef);
  if (!ticket) return { ok: false, reason: 'missing', message: `no ticket "${idOrRef}".` };
  if (ticket.status === 'done') return { ok: false, reason: 'done', message: `${ticket.ref} is already done.` };
  if (ticket.status !== 'todo') return { ok: false, reason: 'not_todo', message: `${ticket.ref} is ${ticket.status}; release it to todo before dispatch.` };
  if (ticket.claim) return { ok: false, reason: 'claimed', message: `${ticket.ref} is already claimed by ${ticket.claim.by}.` };
  if (Array.isArray(ticket.blockedBy) && ticket.blockedBy.length) {
    return { ok: false, reason: 'blocked', message: `${ticket.ref} is blocked by ${ticket.blockedBy.join(', ')}.` };
  }
  return {
    ok: false,
    reason: 'native_agent_required',
    message: `${ticket.ref} must be launched through native_agent and the current conversation's Agent tool; Sidequest no longer starts separate Claude processes.`,
  };
}

module.exports = { nativeDispatchRequired };
