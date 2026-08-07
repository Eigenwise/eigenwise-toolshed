'use strict';

function createSweeps({ addComment, claimAbandonMs, claimIdleMs, claimReleaseNote, claimReleaseVerdict, dispatchState, expiredPreparedDispatch, getTicket, listProjects, listTickets, migrateLegacyScopeRequest, preparedDispatchTtlMs, putTicket, releaseTicket, setDispatchTerminal, stampDispatchEvent, withTicketLock }: any) {
// Expire only dispatches that remained prepared. Launched and bound dispatches are stateful work, not wall-clock leases.
function sweepStaleDispatches(opts?: any) {
  opts = opts || {};
  const source = opts.source ? String(opts.source) : 'sweep';
  const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now();
  const expired: any[] = [];
  for (const project of listProjects({ all: true })) {
    if (opts.project && project.slug !== opts.project) continue;
    for (const ticket of listTickets(project.slug)) {
      if (ticket.archived || ticket.status === 'done' || !expiredPreparedDispatch(dispatchState(ticket), now)) continue;
      try {
        const res = withTicketLock(project.slug, ticket.id, () => {
          const current = getTicket(project.slug, ticket.id);
          if (!current || !expiredPreparedDispatch(dispatchState(current), now)) return { ok: false };
          setDispatchTerminal(current, 'expired', source);
          current.dispatchNonce = null;
          current.dispatchExecutor = null;
          stampDispatchEvent(current, source);
          putTicket(project.slug, current);
          return { ok: true, ticket: current };
        });
        if (!res || !res.ok) continue;
        expired.push({ project: project.slug, ref: res.ticket.ref });
        addComment(project.slug, ticket.id, {
          by: 'sidequest', kind: 'comment', source,
          body: `Auto-expired prepared dispatch: it never launched within the ${Math.round(preparedDispatchTtlMs() / 3600000)} hour TTL.`,
        });
      } catch (_: any) {
        // One inaccessible board must not prevent other stale dispatches from recovering.
      }
    }
  }
  return { ok: true, ttlMs: preparedDispatchTtlMs(), expired };
}

// Garbage-collect claims with concrete death evidence. Quiet routed executors stay
// claimed because board silence is not process liveness. Each release re-checks
// the verdict and shared-checkout safety under the ticket lock.
function sweepStaleClaims(opts?: any) {
  opts = opts || {};
  const source = opts.source ? String(opts.source) : 'sweep';
  const released: any[] = [];
  const blocked: any[] = [];
  const migratedScopeRequests: any[] = [];
  for (const project of listProjects({ all: true })) {
    if (opts.project && project.slug !== opts.project) continue;
    for (const ticket of listTickets(project.slug)) {
      if (!ticket.scopeRequest) continue;
      try {
        const result = migrateLegacyScopeRequest(project.slug, ticket.id);
        if (result?.migrated) migratedScopeRequests.push({ project: project.slug, ref: ticket.ref });
      } catch (_) {}
    }
  }
  for (const project of listProjects({ all: true })) {
    if (opts.project && project.slug !== opts.project) continue;
    for (const ticket of listTickets(project.slug)) {
      if (ticket.archived || ticket.status === 'done') continue;
      const verdict = claimReleaseVerdict(ticket);
      if (!verdict) continue;
      try {
        const res = releaseTicket(project.slug, ticket.id, ticket.claim.by, {
          status: 'todo',
          source,
          requireReleaseVerdict: true,
          claimRelease: { kind: verdict.kind, reason: verdict.reason, idleMs: Number.isFinite(verdict.idleMs) ? verdict.idleMs : null },
        });
        if (!res.ok) {
          if (['dirty_shared_tree', 'shared_tree_state_unavailable'].includes(res.reason)) {
            blocked.push({ project: project.slug, ref: ticket.ref, kind: res.reason, paths: res.paths || [] });
          }
          continue;
        }
        released.push({ project: project.slug, ref: ticket.ref, kind: verdict.kind });
        addComment(project.slug, ticket.id, {
          by: 'sidequest', kind: 'comment', source,
          body: claimReleaseNote(ticket, verdict),
        });
      } catch (_: any) {
        // One inaccessible board must not prevent other dead claims from recovering.
      }
    }
  }
  const dispatches = sweepStaleDispatches(opts);
  return { ok: true, idleMs: claimIdleMs(), abandonMs: claimAbandonMs(), released, blocked, migratedScopeRequests, expiredDispatches: dispatches.expired };
}


  return { sweepStaleDispatches, sweepStaleClaims };
}

module.exports = { createSweeps };
