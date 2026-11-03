'use strict';

// A small receipt contract shared by command/MCP callers. This is metadata, not
// a scheduler or a claim that another agent accepted the requested work product.
// It describes the named turn; current conversation availability is still decided
// by the bridge's active-turn/ownership checks, including when a newer turn exists.
const HANDOFF_CONTRACT = 'eigenwise.agent-handoff';
const HANDOFF_VERSION = 1;
const CLAUDE_ADAPTER = 'claude-code';

function normalizeAdapter(value) {
  if (value === undefined) return CLAUDE_ADAPTER;
  if (value !== CLAUDE_ADAPTER) throw new Error(`Unsupported agent adapter: ${String(value)}. Supported adapter: ${CLAUDE_ADAPTER}; no fallback was used.`);
  return value;
}

function claudeHostStopped(job, terminal) {
  // A terminal status is not evidence a process stopped: owner recovery and an
  // exhausted termination guard both produce terminal records without that proof.
  if (job.terminationPending || job.terminationUnconfirmed || String(job.error?.code || '').startsWith('owner_stopped')) return null;
  if (Object.hasOwn(job, 'exitCode') || Object.hasOwn(job, 'signal')) return true;
  if (job.state === 'running') return false;
  if (terminal && job.finishedAt && !job.hostStarted && !job.startedAt) return true;
  return null;
}

function handoffReceipt(job, { terminal = false } = {}) {
  const hostStopped = claudeHostStopped(job, terminal);
  const observed = job.hostStarted === true;
  const terminationPending = job.terminationPending === true;
  const treeTerminationUnconfirmed = Boolean(job.termination?.treeError && job.termination?.fallbackRequested);
  const resumeBlocked = job.resumeBlocked === true || terminationPending || job.terminationUnconfirmed === true
    || treeTerminationUnconfirmed || job.error?.code === 'session_mismatch' || (terminal && hostStopped !== true);
  return {
    contract: HANDOFF_CONTRACT,
    version: HANDOFF_VERSION,
    adapter: CLAUDE_ADAPTER,
    project: job.project,
    requestId: job.requestId || null,
    conversationId: job.conversationId,
    turnId: job.id,
    receiver: { ownership: 'bridge-owned', sessionId: job.claudeSessionId, observed },
    acceptedAt: job.createdAt || null,
    startedAt: job.startedAt || null,
    updatedAt: job.updatedAt || null,
    finishedAt: job.finishedAt || null,
    state: job.state,
    terminal,
    hostStopped,
    terminationPending,
    resumeBlocked,
    safeToResume: terminal && hostStopped === true && observed && !resumeBlocked,
    workOutcome: 'unverified',
  };
}

module.exports = { HANDOFF_CONTRACT, HANDOFF_VERSION, CLAUDE_ADAPTER, normalizeAdapter, handoffReceipt };
