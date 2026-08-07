"use strict";
function createSweeps({ addComment, claimAbandonMs, claimIdleMs, claimReleaseNote, claimReleaseVerdict, dispatchState, expiredPreparedDispatch, getTicket, listProjects, listTickets, migrateLegacyScopeRequest, preparedDispatchTtlMs, putTicket, releaseTicket, setDispatchTerminal, stampDispatchEvent, withTicketLock }) {
  function sweepStaleDispatches(opts) {
    opts = opts || {};
    const source = opts.source ? String(opts.source) : "sweep";
    const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now();
    const expired = [];
    for (const project of listProjects({ all: true })) {
      if (opts.project && project.slug !== opts.project) continue;
      for (const ticket of listTickets(project.slug)) {
        if (ticket.archived || ticket.status === "done" || !expiredPreparedDispatch(dispatchState(ticket), now)) continue;
        try {
          const res = withTicketLock(project.slug, ticket.id, () => {
            const current = getTicket(project.slug, ticket.id);
            if (!current || !expiredPreparedDispatch(dispatchState(current), now)) return { ok: false };
            setDispatchTerminal(current, "expired", source);
            current.dispatchNonce = null;
            current.dispatchExecutor = null;
            stampDispatchEvent(current, source);
            putTicket(project.slug, current);
            return { ok: true, ticket: current };
          });
          if (!res || !res.ok) continue;
          expired.push({ project: project.slug, ref: res.ticket.ref });
          addComment(project.slug, ticket.id, {
            by: "sidequest",
            kind: "comment",
            source,
            body: `Auto-expired prepared dispatch: it never launched within the ${Math.round(preparedDispatchTtlMs() / 36e5)} hour TTL.`
          });
        } catch (_) {
        }
      }
    }
    return { ok: true, ttlMs: preparedDispatchTtlMs(), expired };
  }
  function sweepStaleClaims(opts) {
    opts = opts || {};
    const source = opts.source ? String(opts.source) : "sweep";
    const released = [];
    const blocked = [];
    const migratedScopeRequests = [];
    for (const project of listProjects({ all: true })) {
      if (opts.project && project.slug !== opts.project) continue;
      for (const ticket of listTickets(project.slug)) {
        if (!ticket.scopeRequest) continue;
        try {
          const result = migrateLegacyScopeRequest(project.slug, ticket.id);
          if (result?.migrated) migratedScopeRequests.push({ project: project.slug, ref: ticket.ref });
        } catch (_) {
        }
      }
    }
    for (const project of listProjects({ all: true })) {
      if (opts.project && project.slug !== opts.project) continue;
      for (const ticket of listTickets(project.slug)) {
        if (ticket.archived || ticket.status === "done") continue;
        const verdict = claimReleaseVerdict(ticket);
        if (!verdict) continue;
        try {
          const res = releaseTicket(project.slug, ticket.id, ticket.claim.by, {
            status: "todo",
            source,
            requireReleaseVerdict: true,
            claimRelease: { kind: verdict.kind, reason: verdict.reason, idleMs: Number.isFinite(verdict.idleMs) ? verdict.idleMs : null }
          });
          if (!res.ok) {
            if (["dirty_shared_tree", "shared_tree_state_unavailable"].includes(res.reason)) {
              blocked.push({ project: project.slug, ref: ticket.ref, kind: res.reason, paths: res.paths || [] });
            }
            continue;
          }
          released.push({ project: project.slug, ref: ticket.ref, kind: verdict.kind });
          addComment(project.slug, ticket.id, {
            by: "sidequest",
            kind: "comment",
            source,
            body: claimReleaseNote(ticket, verdict)
          });
        } catch (_) {
        }
      }
    }
    const dispatches = sweepStaleDispatches(opts);
    return { ok: true, idleMs: claimIdleMs(), abandonMs: claimAbandonMs(), released, blocked, migratedScopeRequests, expiredDispatches: dispatches.expired };
  }
  return { sweepStaleDispatches, sweepStaleClaims };
}
module.exports = { createSweeps };
