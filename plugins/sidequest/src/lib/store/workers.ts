'use strict';

function createWorkers(dependencies: any) {
  const {
    acquireLock,
    dispatchState,
    getTicket,
    path,
    projectsRoot,
    readGlobal,
    releaseLock,
    transaction,
    writeGlobal,
  } = dependencies;

const WORKER_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function workersLockPath() {
  return path.join(projectsRoot(), '.workers.lock');
}
function readWorkers() {
  const d = readGlobal('workers', null);
  return d && typeof d === 'object' && d.sessions && typeof d.sessions === 'object' ? d : { sessions: {} };
}
function writeWorkers(obj?: any) {
  writeGlobal('workers', obj);
}
function withWorkersLock(fn?: any) {
  const lock = workersLockPath();
  const locked = acquireLock(lock);
  try {
    return transaction(fn);
  } finally {
    if (locked) releaseLock(lock, locked);
  }
}

// Drop sessions with no claims left, and any whose last activity is older than
// the TTL (a session that ended without its reconcile hook ever firing). Mutates
// and returns the registry object.
function pruneWorkers(w?: any) {
  const cutoff = Date.now() - WORKER_SESSION_TTL_MS;
  for (const sid of Object.keys(w.sessions)) {
    const s = w.sessions[sid];
    const claims = s && Array.isArray(s.claims) ? s.claims : [];
    const ts = s && s.updatedAt ? Date.parse(s.updatedAt) : NaN;
    if (!claims.length || (Number.isFinite(ts) && ts < cutoff)) delete w.sessions[sid];
  }
  return w;
}

// Record that `sessionId` now holds a claim on (slug, ticketId) under worker id
// `by`. Idempotent per (slug, ticketId). No-op without a session id — the whole
// feature is dormant (and the TTL covers everything) until an id starts flowing.
function registerWorker(sessionId?: any, slug?: any, ticketId?: any, by?: any) {
  if (!sessionId || !slug || !ticketId) return;
  try {
    withWorkersLock(() => {
      const w = readWorkers();
      const now = new Date().toISOString();
      const s = w.sessions[sessionId] || (w.sessions[sessionId] = { updatedAt: now, claims: [] });
      s.updatedAt = now;
      if (!Array.isArray(s.claims)) s.claims = [];
      if (!s.claims.some((c?: any) => c.slug === slug && c.ticketId === ticketId)) {
        s.claims.push({ slug, ticketId, by: by || null, at: now });
      }
      writeWorkers(pruneWorkers(w));
    });
  } catch (_: any) {
    /* the TTL is the backstop — a registry write failure must never break a claim */
  }
}

// Forget a claim (the worker finished or dropped it). No-op without a session id.
function unregisterClaim(sessionId?: any, slug?: any, ticketId?: any) {
  if (!sessionId || !slug || !ticketId) return;
  try {
    withWorkersLock(() => {
      const w = readWorkers();
      const s = w.sessions[sessionId];
      if (!s || !Array.isArray(s.claims)) return;
      s.claims = s.claims.filter((c?: any) => !(c.slug === slug && c.ticketId === ticketId));
      s.updatedAt = new Date().toISOString();
      writeWorkers(pruneWorkers(w));
    });
  } catch (_: any) {
    /* best effort */
  }
}

// Record that the SubagentStop hook already surfaced a runaway note for this exact
// claim, keyed on the claim's OWN start time so a later re-claim of the same ticket
// counts as a fresh flaggable run. Returns true the FIRST time and false on every
// repeat. Without this, each subsequent SubagentStop in the session re-emitted the
// same note as additionalContext — which re-woke the stopping child and turned one
// long run into a nag loop. Fail-open (returns true) if the registry can't be read:
// better a rare duplicate note than a swallowed real one.
function markLongRunFlagged(sessionId?: any, slug?: any, ticketId?: any, claimAt?: any) {
  if (!sessionId || !slug || !ticketId) return true;
  let first = true;
  try {
    withWorkersLock(() => {
      const w = readWorkers();
      const s = w.sessions[sessionId];
      if (!s) return; // no registered claims here — nothing to dedupe against
      const key = `${slug}\u0000${ticketId}\u0000${claimAt || ''}`;
      if (!Array.isArray(s.flagged)) s.flagged = [];
      if (s.flagged.indexOf(key) !== -1) {
        first = false;
        return;
      }
      s.flagged.push(key);
      s.updatedAt = new Date().toISOString();
      writeWorkers(w);
    });
  } catch (_: any) {
    return true;
  }
  return first;
}

// Forget every claim registered to `sessionId`, and report the ones still held.
// This is what the SessionEnd hook calls.
//
// It used to release those claims — move each ticket to `todo` and stamp a durable
// `died` dispatch outcome — on the strength of the session id alone. A session id is
// an identifier, not a liveness authority: Claude Code's SessionEnd payload carries
// only the common fields plus `reason` (clear | resume | logout | prompt_input_exit |
// other), with no generation, nonce, sequence or owning pid, and the host exposes no
// way to ask whether an id is still live. So the assertion is replayable, and two of
// its own reasons (`clear`, `resume`) fire while the process keeps running. SQ-2859
// replayed it against a live executor claim and watched a replacement take the ticket
// while the original runtime went on writing; the false `died` record it left behind
// then reads as observed death forever. Nothing local corroborates it either — a
// stopped turn is explicitly NOT death here (an executor between turns survives the
// sweep and can still submit), so there is no second fact to pair with. A liveness
// question that cannot be answered leaves the claim held (SQ-2862): the unobserved-death
// and idle backstops recover a genuinely abandoned claim, and the ticket's own terminal
// records recover an observed one.
//
// Clearing the registry entry stays, so the assertion cannot accumulate and a second
// call finds nothing. Returns { ok, released: [], held: [ref...] }.
function reconcileSession(sessionId?: any, opts?: any) {
  opts = opts || {};
  const released: any[] = [];
  const held: any[] = [];
  if (!sessionId) return { ok: true, released, held };

  // Snapshot this session's claims and clear its registry entry in one locked
  // step, so a concurrent reconcile of the same session can't double-release.
  let claims: any[] = [];
  try {
    withWorkersLock(() => {
      const w = readWorkers();
      const s = w.sessions[sessionId];
      claims = s && Array.isArray(s.claims) ? s.claims.slice() : [];
      if (s) {
        delete w.sessions[sessionId];
        writeWorkers(w);
      }
    });
  } catch (_: any) {
    return { ok: true, released, held };
  }

  for (const c of claims) {
    let t: any;
    try {
      t = getTicket(c.slug, c.ticketId);
    } catch (_: any) {
      continue;
    }
    if (!t || t.archived || t.status === 'done') continue; // finished work is left alone
    if (!t.claim || !t.claim.by) continue; // already released
    if (c.by && t.claim.by !== c.by) continue; // re-claimed by someone else since — not ours to report
    held.push(t.ref);
  }
  return { ok: true, released, held };
}

// Read-only view of the claims the registry attributes to `sessionId`, each with
// the claim's OWN start `at` timestamp — the raw material a SubagentStop hook uses
// to spot a runaway (long-running) executor post-hoc. Unlike reconcileSession this
// mutates NOTHING: it snapshots the registry entry and resolves each claim's ticket
// ref/status for naming, skipping tickets that have since vanished. Returns [] for
// an unknown/absent session. Fail-soft: any hiccup degrades to []. Like the rest of
// the registry it is a convenience over the TTL, never a source of truth about
// whether a claim is valid. Shape: [{ slug, ticketId, ref, by, at, status, held }].
function sessionClaims(sessionId?: any, opts?: any) {
  const out: any[] = [];
  if (!sessionId) return out;
  const agentId = opts && opts.agentId ? String(opts.agentId) : null;
  const agentName = opts && opts.agentName ? String(opts.agentName) : null;
  const executor = opts && opts.executor ? String(opts.executor) : null;
  let claims: any[] = [];
  try {
    withWorkersLock(() => {
      const w = readWorkers();
      const s = w.sessions[String(sessionId)];
      claims = s && Array.isArray(s.claims) ? s.claims.slice() : [];
    });
  } catch (_: any) {
    return out;
  }
  for (const c of claims) {
    let ref = null;
    let status = null;
    let held = false;
    try {
      const t = getTicket(c.slug, c.ticketId);
      if (t) {
        const state = dispatchState(t);
        if ((agentId || agentName) && (!state ||
          (agentId && state.agentId !== agentId) ||
          (agentName && state.agentName !== agentName) ||
          (executor && state.executor !== executor))) continue;
        ref = t.ref;
        status = t.status;
        held = !!(t.claim && t.claim.by && (!c.by || t.claim.by === c.by));
      }
    } catch (_: any) {
      /* a bad ticket read just yields a bare entry — the `at` still stands */
    }
    out.push({ slug: c.slug, ticketId: c.ticketId, ref, by: c.by || null, at: c.at || null, status, held });
  }
  return out;
}

  return {
    markLongRunFlagged,
    reconcileSession,
    registerWorker,
    sessionClaims,
    unregisterClaim,
  };
}

module.exports = { createWorkers };
