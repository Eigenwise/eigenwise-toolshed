'use strict';

function createClaims(dependencies: any) {
  const {
    completionTreeCheck,
    dispatchState,
    fs,
    getTicket,
    putTicket,
    withTicketLock,
  } = dependencies;

  const DEFAULT_CLAIM_IDLE_MIN = 60;
  const DEFAULT_CLAIM_ABANDON_MIN = 24 * 60;
  const DEFAULT_PREPARED_DISPATCH_TTL_HOURS = 6;
  const VERIFY_START_COMMENT = '[sidequest:verify-start] ';
  const VERIFY_COMPLETE_COMMENT = '[sidequest:verify-complete]';
  const VERIFY_COMPLETE_NO_OP_COMMENT = `${VERIFY_COMPLETE_COMMENT} no-op`;
  const NEGATIVE_CONTROL_COMMENT = '[sidequest:negative-control] ';
  const RELEASE_KINDS = new Set(['scope_pause', 'handback']);

  function technicalBlockerRelease(args?: { releaseKind?: unknown; command?: unknown; exitCode?: unknown; oracle?: unknown; outputTail?: unknown; reason?: unknown }): { ok: true; evidence: { command: string; exitCode?: number; kind: string; outputTail: string } | null; releaseKind: string | null } | { ok: false; message: string; reason: string } {
    const reason = String(args?.reason || '').trim();
    const oracle = String(args?.oracle || '').trim();
    const releaseKind = String(args?.releaseKind || '').trim();
    const command = String(args?.command || '').trim();
    const outputTail = String(args?.outputTail || '').trim();
    const exitCode = typeof args?.exitCode === 'number'
      ? args.exitCode
      : typeof args?.exitCode === 'string' && /^-?\d+$/.test(args.exitCode.trim())
        ? Number(args.exitCode)
        : Number.NaN;
    if (releaseKind === 'technical_blocker') {
      if (!reason || !command || !Number.isInteger(exitCode) || exitCode === 0 || !outputTail) {
        return {
          ok: false,
          reason: 'technical_blocker_evidence_required',
          message: 'release: technical_blocker requires a non-empty reason and command, a non-zero integer exitCode, and a non-empty outputTail. Capture the failed command result, then release again with all four fields.',
        };
      }
      return { ok: true, releaseKind, evidence: { kind: releaseKind, command, exitCode, outputTail } };
    }
    if (releaseKind === 'contradiction') {
      if (!reason || !command || !outputTail || (args?.exitCode != null && !Number.isInteger(exitCode))) {
        return {
          ok: false,
          reason: 'contradiction_evidence_required',
          message: 'release: contradiction requires a non-empty reason and command, a non-empty outputTail, and an integer exitCode when supplied. Capture the verbatim probe and its output, then release again with all required fields.',
        };
      }
      return { ok: true, releaseKind, evidence: { kind: releaseKind, command, ...(Number.isInteger(exitCode) ? { exitCode } : {}), outputTail } };
    }
    if (!reason && !oracle && !releaseKind) return { ok: true, releaseKind: null, evidence: null };
    if (!releaseKind && oracle) return { ok: true, releaseKind: null, evidence: null };
    if (RELEASE_KINDS.has(releaseKind)) return { ok: true, releaseKind, evidence: null };
    return {
      ok: false,
      reason: 'release_kind_required',
      message: 'release: choose kind "technical_blocker" for a failed command, "contradiction" for an absent target with probe evidence, or "scope_pause" or "handback" for another non-technical release. Technical blockers need command, exitCode, and outputTail; contradictions need command and outputTail.',
    };
  }

  function releaseCommentBody(reason?: unknown, evidence?: { command: string; exitCode?: number; kind: string; outputTail: string } | null) {
    const releaseReason = String(reason || '').trim();
    if (!evidence) return `Released: ${releaseReason}`;
    const exitCode = evidence.exitCode == null ? '' : `\nExit code: ${evidence.exitCode}`;
    const evidenceLabel = evidence.kind === 'contradiction' ? 'Contradiction evidence' : 'Technical blocker evidence';
    return `Released: ${releaseReason}\n${evidenceLabel}:\nCommand: ${evidence.command}${exitCode}\nOutput tail:\n${evidence.outputTail}`;
  }

  function preparedDispatchTtlMs() {
    const hours = Number(process.env.SIDEQUEST_PREPARED_DISPATCH_TTL_HOURS);
    return (Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_PREPARED_DISPATCH_TTL_HOURS) * 60 * 60 * 1000;
  }

  function envMinutesMs(fallbackMinutes?: any, ...names: string[]) {
    for (const name of names) {
      const raw = process.env[name];
      if (raw == null || String(raw).trim() === '') continue;
      const minutes = Number(raw);
      if (Number.isFinite(minutes) && minutes > 0) return minutes * 60 * 1000;
    }
    return fallbackMinutes * 60 * 1000;
  }

  function claimIdleMs() {
    return envMinutesMs(DEFAULT_CLAIM_IDLE_MIN, 'SIDEQUEST_CLAIM_IDLE_MIN', 'SIDEQUEST_CLAIM_TTL_MIN');
  }

  function claimAbandonMs() {
    return envMinutesMs(DEFAULT_CLAIM_ABANDON_MIN, 'SIDEQUEST_CLAIM_ABANDON_MIN');
  }

  function claimActivityMs(ticket?: any) {
    const claim = ticket && ticket.claim;
    if (!claim || !claim.by) return Number.NaN;
    let latest = Number.NaN;
    const consider = (value?: any) => {
      const ms = Date.parse(value);
      if (Number.isFinite(ms) && (!Number.isFinite(latest) || ms > latest)) latest = ms;
    };
    consider(claim.at);
    consider(claim.activeAt);
    consider(claimVerification(ticket)?.startedAt);
    for (const comment of Array.isArray(ticket.comments) ? ticket.comments : []) {
      if (comment && comment.by === claim.by) consider(comment.at);
    }
    return latest;
  }

  function claimIdleAge(ticket?: any, now?: any) {
    const latest = claimActivityMs(ticket);
    return Number.isFinite(latest) ? Math.max(0, now - latest) : Number.POSITIVE_INFINITY;
  }

  function claimVerification(ticket?: any) {
    const claim = ticket?.claim;
    const verification = claim?.verification;
    if (!claim?.by || !verification || verification.by !== claim.by) return null;
    const startedAt = String(verification.startedAt || '');
    const command = String(verification.command || '').trim();
    if (!Number.isFinite(Date.parse(startedAt)) || !command) return null;
    return { startedAt, command };
  }

  function verificationComment(body?: any) {
    const text = String(body || '');
    if (text.startsWith(VERIFY_START_COMMENT)) {
      const command = text.slice(VERIFY_START_COMMENT.length).trim();
      return command ? { kind: 'start', command } : null;
    }
    if (text === VERIFY_COMPLETE_COMMENT) return { kind: 'complete', noOp: false };
    if (text === VERIFY_COMPLETE_NO_OP_COMMENT) return { kind: 'complete', noOp: true };
    if (text.startsWith(NEGATIVE_CONTROL_COMMENT)) return { kind: 'negative-control' };
    return null;
  }

  function verificationCompletionCheck(slug?: any, ticket?: any, comment?: any) {
    const event = verificationComment(comment?.body);
    if (!event || event.kind !== 'complete') return { ok: true };
    return completionTreeCheck(slug, ticket, { explicitNoOp: event.noOp });
  }

  function recordClaimVerification(ticket?: any, comment?: any) {
    const claim = ticket?.claim;
    if (!claim?.by || comment?.by !== claim.by) return;
    const event = verificationComment(comment.body);
    if (!event) return;
    const dispatch = dispatchState(ticket);
    if (event.kind === 'start') {
      claim.verification = { by: claim.by, startedAt: comment.at, command: event.command };
      if (dispatch) delete dispatch.verifyStopAt;
      return;
    }
    if (event.kind !== 'complete') return;
    if (claimVerification(ticket)) delete claim.verification;
    if (dispatch) delete dispatch.verifyStopAt;
  }

  function resumableScopePause(ticket?: any) {
    const dispatch = dispatchState(ticket);
    return Boolean(
      dispatch && dispatch.terminalAt && ticket?.claim?.by && ticket?.scopeRequest
        && ['scope_paused', 'stopped_claimed'].includes(dispatch.outcome),
    );
  }

  function observedStop(dispatch?: any, claim?: any) {
    if (!dispatch || !['died', 'stopped_claimed'].includes(dispatch.outcome) || !dispatch.terminalAt) return false;
    const stoppedMs = Date.parse(dispatch.terminalAt);
    const claimedMs = Date.parse(claim && claim.at);
    if (!Number.isFinite(stoppedMs)) return false;
    return !Number.isFinite(claimedMs) || stoppedMs >= claimedMs;
  }

  function missingStoppedWorktree(dispatch?: any) {
    if (!dispatch || dispatch.sharedTree !== false || !dispatch.terminalAt || !dispatch.worktree) return false;
    try { return !fs.existsSync(dispatch.worktree); } catch (_) { return false; }
  }

  function claimReleaseVerdict(ticket?: any, now?: any) {
    const claim = ticket && ticket.claim;
    if (!claim || !claim.by) return null;
    const atMs = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    const idleMs = claimIdleAge(ticket, atMs);
    const dispatch = dispatchState(ticket);
    const verification = claimVerification(ticket);
    if (observedStop(dispatch, claim)) {
      return { kind: 'observed_stop', idleMs, at: dispatch.terminalAt, reason: 'its executor has a durable died outcome while still holding the claim' };
    }
    if (verification) {
      if (idleMs > claimAbandonMs()) {
        return { kind: 'abandoned_verifying', idleMs, at: verification.startedAt, reason: 'its verification marker never completed past the unobserved-death backstop' };
      }
      return null;
    }
    if (resumableScopePause(ticket)) {
      if (missingStoppedWorktree(dispatch)) {
        return { kind: 'missing_worktree', idleMs, at: dispatch.terminalAt, reason: 'its stopped executor worktree no longer exists' };
      }
      return null;
    }
    const liveAgent = Boolean(dispatch && !dispatch.terminalAt);
    if (!liveAgent && idleMs > claimIdleMs()) {
      return { kind: 'idle', idleMs, reason: 'no board activity from the claim holder and no live executor associated' };
    }
    if (!liveAgent && idleMs > claimAbandonMs()) {
      return { kind: 'abandoned', idleMs, reason: 'no board activity from the claim holder past the unobserved-death backstop' };
    }
    return null;
  }

  function claimReclaimable(ticket?: any, now?: any) {
    return Boolean(claimReleaseVerdict(ticket, now));
  }

  function autoReleasedClaimMessage(ref?: any, release?: any) {
    const when = release && release.at ? ` at ${release.at}` : '';
    const why = (release && (release.reason || release.kind)) || 'the claim sweep released it';
    return `${ref}'s claim was auto-released${when}: ${why}. Its dispatch token went with it, so this closeout cannot be recorded. Your commits are safe — do NOT discard, reset, or redo the work. Recovery: have the orchestrator run \`sidequest dispatch ${ref}\`, claim with that fresh token and executor, then hand in the SAME commit.`;
  }

  function claimIdleLabel(idleMs?: any) {
    return Number.isFinite(idleMs) ? `${Math.round(Number(idleMs) / 60000)}m` : 'an unknown time';
  }

  function claimReleaseNote(ticket?: any, verdict?: any) {
    const by = ticket && ticket.claim && ticket.claim.by;
    const idle = claimIdleLabel(verdict && verdict.idleMs);
    if (verdict.kind === 'observed_stop') {
      return `↩️ Auto-released to **todo**: its executor had a recorded terminal Agent failure while holding the claim (at ${verdict.at}, was claimed by \`${by}\`). It is back in the ready pool; re-dispatch to continue the work.`;
    }
    if (verdict.kind === 'abandoned_verifying') {
      return `↩️ Auto-released to **todo**: verification from \`${by}\` never completed for ${idle}, past the unobserved-death backstop.`;
    }
    if (verdict.kind === 'idle') {
      return `↩️ Auto-released to **todo**: no board activity from \`${by}\` for ${idle} and no live executor is associated with this ticket.`;
    }
    return `↩️ Auto-released to **todo**: no board activity from \`${by}\` for ${idle}, past the unobserved-death backstop (nothing ever reported that executor stopping).`;
  }

  function touchClaimActivity(ticket?: any, by?: any, now?: any) {
    const claim = ticket && ticket.claim;
    if (!claim || !claim.by || (by != null && claim.by !== by)) return false;
    claim.activeAt = now || new Date().toISOString();
    return true;
  }

  function touchClaim(slug?: any, idOrRef?: any, by?: any) {
    const found = getTicket(slug, idOrRef);
    if (!found) return { ok: false, reason: 'not_found' };
    return withTicketLock(slug, found.id, () => {
      const t = getTicket(slug, found.id);
      if (!t) return { ok: false, reason: 'not_found' };
      if (!touchClaimActivity(t, by)) return { ok: false, reason: 'not_owner', ticket: t };
      putTicket(slug, t);
      return { ok: true, ticket: t };
    });
  }

  return {
    DEFAULT_CLAIM_ABANDON_MIN,
    DEFAULT_CLAIM_IDLE_MIN,
    DEFAULT_PREPARED_DISPATCH_TTL_HOURS,
    autoReleasedClaimMessage,
    claimAbandonMs,
    claimActivityMs,
    claimIdleAge,
    claimIdleMs,
    claimReclaimable,
    claimReleaseNote,
    claimReleaseVerdict,
    claimVerification,
    missingStoppedWorktree,
    observedStop,
    preparedDispatchTtlMs,
    recordClaimVerification,
    releaseCommentBody,
    resumableScopePause,
    technicalBlockerRelease,
    touchClaim,
    touchClaimActivity,
    verificationComment,
    verificationCompletionCheck,
  };
}

module.exports = { createClaims };
