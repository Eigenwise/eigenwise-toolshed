#!/usr/bin/env node
'use strict';
/**
 * sidequest - PreToolUse hook: keep executors reporting UP, not sideways.
 *
 * A sidequest executor's only channels are its final message (to whoever spawned
 * it) and comments on its OWN ticket. When an executor instead SendMessage's a
 * peer, that peer gets a nudge it never asked for — and if the peer re-nudges
 * back, or a SubagentStop re-injects the same context, you get the Contractify
 * loop: a reviewer scoped to one file re-woken ~6x by an unrelated executor's
 * SQ-70 message. This hook denies that at the tool boundary.
 *
 * PreToolUse stdin carries `agent_type` ONLY when the caller is a subagent (it's
 * absent on main-thread calls — docs: agent-sdk/hooks). So the guard is precise:
 *   - No agent_type (main thread / orchestrator) -> allow. The orchestrator may
 *     message anyone; it owns routing.
 *   - agent_type is a `sidequest-` executor AND the target isn't `main` -> deny.
 *     Report up (final message + ticket comments), never sideways to a peer.
 *   - Anything else -> allow.
 *
 * Fail-soft by construction: a missing/garbage payload, or an absent agent_type,
 * yields NO output (allow). The guard can only ever fire on a genuine executor
 * peer-message, so a wrong assumption degrades to a no-op, never a false block.
 *
 * Design constraints (shared with the rest of the toolshed):
 *   - Node stdlib only, cross-platform.
 *   - Fail-soft: any error -> exit 0 with no output.
 */

const fs = require('fs');

function main() {
  const raw = fs.readFileSync(0, 'utf8');
  if (!raw) return;
  const input = JSON.parse(raw);
  if (!input || typeof input !== 'object') return;
  if (String(input.tool_name || '') !== 'SendMessage') return;

  const agentType = String(input.agent_type || input.agentType || '');
  if (!agentType.startsWith('sidequest-')) return; // main thread / non-executor -> allow

  const toRaw = input.tool_input && input.tool_input.to;
  const to = String(toRaw == null ? '' : toRaw).trim();
  if (to.toLowerCase() === 'main') return; // reporting up to the main conversation is allowed

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        `sidequest: an executor (${agentType}) may not message another agent` +
        (to ? ` ("${to}")` : '') +
        '. Executors report UP — put it in your final message to the orchestrator, or a comment on your own ticket, and let the orchestrator route anything another ticket\'s owner needs. Do not nudge peers.',
    },
  }));
}

try {
  main();
} catch (_) {
  // Fail soft. A hook bug must never block unrelated SendMessage calls.
  process.exit(0);
}
