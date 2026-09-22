'use strict';

// A stop only attests the claim's current runtime when nothing the claim did came after it: a stop
// before claim.at belongs to an earlier launch, and a stop at or before claim.activeAt was outlived by
// the runtime it claims to have ended. The activeAt boundary is inclusive because touchClaimActivity
// resumes a dispatch on activity at the same instant as its stop, and the retained attempt record
// keeps that stop; a rule that still accepted it would say dead over a runtime the sweep refuses to
// free (SQ-2917, SQ-2918).
function stopOutlivesClaim(terminalAt?: unknown, claim?: any): boolean {
  const stoppedMs = Date.parse(String(terminalAt ?? ''));
  if (!Number.isFinite(stoppedMs)) return false;
  const claimedMs = Date.parse(claim && claim.at);
  const activeMs = Date.parse(claim && claim.activeAt);
  if (Number.isFinite(activeMs) && activeMs >= stoppedMs) return false;
  return !Number.isFinite(claimedMs) || stoppedMs >= claimedMs;
}

function createClaims(dependencies: any) {
  const {
    completionTreeCheck,
    dispatchDelta,
    dispatchState,
    getTicket,
    putTicket,
    withTicketLock,
  } = dependencies;

  const DEFAULT_CLAIM_IDLE_MIN = 60;
  // Measured from the last board-side signal the runtime produced, not from its launch: a gateway first
  // turn, a briefing fetch, and a pre-claim skill load each move that signal forward, and the SQ-2932
  // review found five minutes from bind alone retiring executors that were about to claim.
  const DEFAULT_CLAIM_GRACE_MIN = 15;
  const DEFAULT_CLAIM_ABANDON_MIN = 24 * 60;
  const DEFAULT_PREPARED_DISPATCH_TTL_HOURS = 6;
  const VERIFY_START_COMMENT = '[sidequest:verify-start] ';
  const VERIFY_COMPLETE_COMMENT = '[sidequest:verify-complete]';
  const VERIFY_COMPLETE_STATUSES = new Set(['passed', 'failed_suite', 'toolchain_missing', 'could_not_run', 'timeout', 'manual', 'attestation', 'skipped', 'failed_check']);
  const VERIFY_COMPLETE_STATUS_ALIASES = new Map([
    ['failed', 'failed_suite'],
    ['failed-suite', 'failed_suite'],
    ['toolchain-missing', 'toolchain_missing'],
    ['could-not-run', 'could_not_run'],
    ['failed-check', 'failed_check'],
  ]);
  const NEGATIVE_CONTROL_COMMENT = '[sidequest:negative-control] ';
  const RELEASE_KINDS = new Set(['technical_blocker', 'contradiction', 'oracle', 'handback']);
  type ReleaseEvidence = { command: string; exitCode?: number; kind: string; outputTail: string };
  type ReleaseInput = { reason: string; oracle: string; releaseKind: string; command: string; outputTail: string; rawExitCode: unknown; exitCode: number };
  type ReleaseResult = { ok: true; evidence: ReleaseEvidence | null; releaseKind: string | null } | { ok: false; message: string; reason: string };

  function releaseFailure(reason: string, message: string): ReleaseResult {
    return { ok: false as const, reason, message };
  }

  function releaseText(value: unknown): string {
    return String(value ?? '').trim();
  }

  function releaseExitCode(value: unknown): number {
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value);
    return Number.NaN;
  }

  function releaseInput(args?: { releaseKind?: unknown; command?: unknown; exitCode?: unknown; oracle?: unknown; outputTail?: unknown; reason?: unknown }): ReleaseInput {
    const rawExitCode = args?.exitCode;
    return {
      reason: releaseText(args?.reason),
      oracle: releaseText(args?.oracle),
      releaseKind: releaseText(args?.releaseKind),
      command: releaseText(args?.command),
      outputTail: releaseText(args?.outputTail),
      rawExitCode,
      exitCode: releaseExitCode(rawExitCode),
    };
  }

  function releaseArgumentFailure(input: ReleaseInput): ReleaseResult | null {
    const missing = [
      !input.reason && !input.oracle ? 'reason: non-empty text' : null,
      !RELEASE_KINDS.has(input.releaseKind) ? 'kind: technical_blocker | contradiction | oracle | handback' : null,
    ].filter(Boolean);
    return missing.length ? releaseFailure('release_arguments_required', `release: ${missing.join('; ')}.`) : null;
  }

  function requiredReleaseTextPresent(...values: string[]): boolean {
    return values.every(Boolean);
  }

  function nonZeroIntegerExitCode(exitCode: number): boolean {
    return Number.isInteger(exitCode) && exitCode !== 0;
  }

  function suppliedExitCodeIsInteger(input: ReleaseInput): boolean {
    return input.rawExitCode == null || Number.isInteger(input.exitCode);
  }

  function technicalBlockerEvidence(input: ReleaseInput): ReleaseResult {
    const complete = requiredReleaseTextPresent(input.reason, input.command, input.outputTail) && nonZeroIntegerExitCode(input.exitCode);
    if (!complete) {
      return releaseFailure('technical_blocker_evidence_required', 'release: technical_blocker requires a non-empty reason and command, a non-zero integer exitCode, and a non-empty outputTail. Capture the failed command result, then release again with all four fields.');
    }
    return { ok: true as const, releaseKind: input.releaseKind, evidence: { kind: input.releaseKind, command: input.command, exitCode: input.exitCode, outputTail: input.outputTail } };
  }

  function contradictionEvidence(input: ReleaseInput): ReleaseResult {
    const complete = requiredReleaseTextPresent(input.reason, input.command, input.outputTail) && suppliedExitCodeIsInteger(input);
    if (!complete) {
      return releaseFailure('contradiction_evidence_required', 'release: contradiction requires a non-empty reason and command, a non-empty outputTail, and an integer exitCode when supplied. Capture the verbatim probe and its output, then release again with all required fields.');
    }
    return { ok: true as const, releaseKind: input.releaseKind, evidence: { kind: input.releaseKind, command: input.command, ...(Number.isInteger(input.exitCode) ? { exitCode: input.exitCode } : {}), outputTail: input.outputTail } };
  }

  function oracleRelease(input: ReleaseInput): ReleaseResult {
    return input.oracle
      ? { ok: true as const, releaseKind: input.releaseKind, evidence: null }
      : releaseFailure('oracle_ask_required', 'release: oracle requires a non-empty oracle ask that states what the human must judge. Park the ticket and exit instead of holding its claim for a verdict.');
  }

  function handbackRelease(input: ReleaseInput): ReleaseResult {
    return { ok: true as const, releaseKind: input.releaseKind, evidence: null };
  }

  const RELEASE_VALIDATORS = new Map<string, (input: ReleaseInput) => ReleaseResult>([
    ['technical_blocker', technicalBlockerEvidence],
    ['contradiction', contradictionEvidence],
    ['oracle', oracleRelease],
    ['handback', handbackRelease],
  ]);

  function technicalBlockerRelease(args?: { releaseKind?: unknown; command?: unknown; exitCode?: unknown; oracle?: unknown; outputTail?: unknown; reason?: unknown }): ReleaseResult {
    const input = releaseInput(args);
    const failure = releaseArgumentFailure(input);
    if (failure) return failure;
    const validator = RELEASE_VALIDATORS.get(input.releaseKind);
    return validator ? validator(input) : releaseFailure('release_kind_required', 'release: kind must be technical_blocker, contradiction, oracle, or handback.');
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

  function claimGraceMs() {
    return Math.min(envMinutesMs(DEFAULT_CLAIM_GRACE_MIN, 'SIDEQUEST_CLAIM_GRACE_MIN'), claimIdleMs());
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

  function claimMaySubmit(ticket?: any) {
    if (claimVerification(ticket)) return true;
    const claim = ticket?.claim;
    if (!claim?.by) return false;
    let latestEvent: any = null;
    for (const comment of Array.isArray(ticket.comments) ? ticket.comments : []) {
      if (comment?.by !== claim.by) continue;
      const event = verificationComment(comment.body);
      if (event) latestEvent = event;
    }
    return latestEvent?.kind === 'complete'
      && (latestEvent.status === 'passed' || (!latestEvent.status && !latestEvent.noOp));
  }

  function verificationComment(body?: any) {
    const text = String(body || '');
    if (text.startsWith(VERIFY_START_COMMENT)) {
      const command = text.slice(VERIFY_START_COMMENT.length).trim();
      return command ? { kind: 'start', command } : null;
    }
    if (text.startsWith(NEGATIVE_CONTROL_COMMENT)) return { kind: 'negative-control' };
    if (!text.startsWith(VERIFY_COMPLETE_COMMENT)) return null;
    const completion = text.slice(VERIFY_COMPLETE_COMMENT.length);
    const statusMatch = completion.match(/^\s*([^\s:]+)/);
    const matchedStatus = statusMatch?.[1];
    if (!matchedStatus) return { kind: 'complete', noOp: false };
    const status = VERIFY_COMPLETE_STATUS_ALIASES.get(matchedStatus) || matchedStatus;
    if (status === 'no-op') return { kind: 'complete', noOp: true };
    if (VERIFY_COMPLETE_STATUSES.has(status)) return { kind: 'complete', noOp: false, status };
    return { kind: 'complete', noOp: false };
  }

  function verificationCompletionCheck(slug?: any, ticket?: any, comment?: any) {
    const event = verificationComment(comment?.body);
    if (!event || event.kind !== 'complete') return { ok: true };
    if (ticket?.claim?.by === comment?.by && (event.status === 'failed_suite' || event.status === 'could_not_run')) return { ok: true };
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
      delete claim.noOp;
      if (dispatch) delete dispatch.verifyStopAt;
      return;
    }
    if (event.kind !== 'complete') return;
    if (event.noOp) claim.noOp = { by: claim.by, at: comment.at };
    else delete claim.noOp;
    if (claimVerification(ticket)) delete claim.verification;
    if (dispatch) delete dispatch.verifyStopAt;
  }

  function hasNoOpReleaseProof(slug?: any, ticket?: any, by?: any) {
    const claim = ticket?.claim;
    if (!claim?.by || claim.by !== by || claim.noOp?.by !== by) return false;
    const completion = completionTreeCheck(slug, ticket, { explicitNoOp: true });
    return completion.ok && completion.applicable === true && completion.noOp === true;
  }

  function observedStop(dispatch?: any, claim?: any) {
    const hostReportedFailure = dispatch?.outcome === 'failed'
      && dispatch?.terminalSource === 'subagent-stop'
      && Boolean(dispatch.failureShape);
    if (!dispatch || !['died', 'stopped_claimed'].includes(dispatch.outcome) && !hostReportedFailure || !dispatch.terminalAt) return false;
    return stopOutlivesClaim(dispatch.terminalAt, claim);
  }

  function claimReleaseBlocker(slug?: any, ticket?: any) {
    const dispatch = dispatchState(ticket);
    if (!dispatch || dispatch.sharedTree !== true) return null;
    const delta = dispatchDelta(slug, ticket);
    if (!delta.ok) {
      return {
        kind: 'shared_tree_state_unavailable',
        reason: 'the shared checkout could not be inspected for uncommitted changes',
      };
    }
    if (!delta.working.length) return null;
    return {
      kind: 'dirty_shared_tree',
      paths: delta.working,
      newlyChangedPaths: delta.working,
      preExistingPaths: delta.preExisting || [],
      baselineRecorded: delta.baselineRecorded === true,
      reason: 'the shared checkout has paths changed after this dispatch baseline',
    };
  }

  function claimReleaseVerdict(ticket?: any, now?: any) {
    const claim = ticket && ticket.claim;
    if (!claim || !claim.by) return null;
    const atMs = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    const idleMs = claimIdleAge(ticket, atMs);
    const dispatch = dispatchState(ticket);
    const verification = claimVerification(ticket);
    if (observedStop(dispatch, claim)) {
      return { kind: 'observed_stop', idleMs, at: dispatch.terminalAt, reason: 'its executor has a durable terminal record while still holding the claim' };
    }
    // A missing isolated checkout used to free the claim on the spot. It never proved the
    // executor was gone: a native agent is a loop inside its session process and holds no
    // directory, so `git worktree remove --force` succeeds under a working executor and the
    // runtime keeps writing (SQ-2859, SQ-2862). Nothing pairs with the absence either — the
    // sweep refuses to remove a checkout whose ticket is claimed, so any removal under a live
    // claim is unsanctioned by construction, and the one attestation that does prove death
    // (a durable died/stopped_claimed record) already decides above on its own. So absence
    // reports nothing here and the backstops carry the case.
    if (verification) {
      if (idleMs > claimAbandonMs()) {
        return { kind: 'abandoned_verifying', idleMs, at: verification.startedAt, reason: 'its verification marker never completed past the unobserved-death backstop' };
      }
      return null;
    }
    if (dispatch) {
      if (idleMs > claimAbandonMs()) {
        return { kind: 'abandoned', idleMs, reason: 'no board activity from the claim holder past the unobserved-death backstop' };
      }
      return null;
    }
    if (idleMs > claimIdleMs()) {
      return { kind: 'idle', idleMs, reason: 'no board activity from the claim holder and no executor dispatch exists' };
    }
    if (idleMs > claimAbandonMs()) {
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
      return `↩️ Auto-released to **todo**: no board activity from \`${by}\` for ${idle}, and this claim has no executor dispatch.`;
    }
    return `↩️ Auto-released to **todo**: no board activity from \`${by}\` for ${idle}, past the unobserved-death backstop (nothing ever reported that executor stopping).`;
  }

  function touchClaimActivity(ticket?: any, by?: any, now?: any) {
    const claim = ticket && ticket.claim;
    if (!claim || !claim.by || (by != null && claim.by !== by)) return false;
    const activeAt = now || new Date().toISOString();
    const dispatch = dispatchState(ticket);
    if (observedStop(dispatch, claim) && Date.parse(activeAt) >= Date.parse(dispatch.terminalAt)) {
      dispatch.outcome = 'claimed';
      delete dispatch.failureShape;
      delete dispatch.terminalAt;
      delete dispatch.terminalSource;
      dispatch.resumedAt = activeAt;
    }
    claim.activeAt = activeAt;
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
    DEFAULT_CLAIM_GRACE_MIN,
    DEFAULT_CLAIM_IDLE_MIN,
    DEFAULT_PREPARED_DISPATCH_TTL_HOURS,
    autoReleasedClaimMessage,
    claimAbandonMs,
    claimActivityMs,
    claimGraceMs,
    claimIdleAge,
    claimIdleMs,
    claimMaySubmit,
    claimReclaimable,
    claimReleaseBlocker,
    claimReleaseNote,
    claimReleaseVerdict,
    claimVerification,
    hasNoOpReleaseProof,
    observedStop,
    preparedDispatchTtlMs,
    recordClaimVerification,
    releaseCommentBody,
    technicalBlockerRelease,
    touchClaim,
    touchClaimActivity,
    verificationComment,
    verificationCompletionCheck,
  };
}

module.exports = { createClaims, stopOutlivesClaim };
