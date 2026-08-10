"use strict";
function createWorkers(dependencies) {
  const {
    acquireLock,
    addComment,
    dispatchState,
    getTicket,
    path,
    projectsRoot,
    readGlobal,
    releaseLock,
    releaseTicket,
    transaction,
    writeGlobal
  } = dependencies;
  const WORKER_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1e3;
  function workersLockPath() {
    return path.join(projectsRoot(), ".workers.lock");
  }
  function readWorkers() {
    const d = readGlobal("workers", null);
    return d && typeof d === "object" && d.sessions && typeof d.sessions === "object" ? d : { sessions: {} };
  }
  function writeWorkers(obj) {
    writeGlobal("workers", obj);
  }
  function withWorkersLock(fn) {
    const lock = workersLockPath();
    const locked = acquireLock(lock);
    try {
      return transaction(fn);
    } finally {
      if (locked) releaseLock(lock, locked);
    }
  }
  function pruneWorkers(w) {
    const cutoff = Date.now() - WORKER_SESSION_TTL_MS;
    for (const sid of Object.keys(w.sessions)) {
      const s = w.sessions[sid];
      const claims = s && Array.isArray(s.claims) ? s.claims : [];
      const ts = s && s.updatedAt ? Date.parse(s.updatedAt) : NaN;
      if (!claims.length || Number.isFinite(ts) && ts < cutoff) delete w.sessions[sid];
    }
    return w;
  }
  function registerWorker(sessionId, slug, ticketId, by) {
    if (!sessionId || !slug || !ticketId) return;
    try {
      withWorkersLock(() => {
        const w = readWorkers();
        const now = (/* @__PURE__ */ new Date()).toISOString();
        const s = w.sessions[sessionId] || (w.sessions[sessionId] = { updatedAt: now, claims: [] });
        s.updatedAt = now;
        if (!Array.isArray(s.claims)) s.claims = [];
        if (!s.claims.some((c) => c.slug === slug && c.ticketId === ticketId)) {
          s.claims.push({ slug, ticketId, by: by || null, at: now });
        }
        writeWorkers(pruneWorkers(w));
      });
    } catch (_) {
    }
  }
  function unregisterClaim(sessionId, slug, ticketId) {
    if (!sessionId || !slug || !ticketId) return;
    try {
      withWorkersLock(() => {
        const w = readWorkers();
        const s = w.sessions[sessionId];
        if (!s || !Array.isArray(s.claims)) return;
        s.claims = s.claims.filter((c) => !(c.slug === slug && c.ticketId === ticketId));
        s.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
        writeWorkers(pruneWorkers(w));
      });
    } catch (_) {
    }
  }
  function markLongRunFlagged(sessionId, slug, ticketId, claimAt) {
    if (!sessionId || !slug || !ticketId) return true;
    let first = true;
    try {
      withWorkersLock(() => {
        const w = readWorkers();
        const s = w.sessions[sessionId];
        if (!s) return;
        const key = `${slug}\0${ticketId}\0${claimAt || ""}`;
        if (!Array.isArray(s.flagged)) s.flagged = [];
        if (s.flagged.indexOf(key) !== -1) {
          first = false;
          return;
        }
        s.flagged.push(key);
        s.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
        writeWorkers(w);
      });
    } catch (_) {
      return true;
    }
    return first;
  }
  function reconcileSession(sessionId, opts) {
    opts = opts || {};
    const reason = opts.reason ? String(opts.reason) : "worker session ended";
    const source = opts.source ? String(opts.source) : "cli";
    const released = [];
    if (!sessionId) return { ok: true, released };
    let claims = [];
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
    } catch (_) {
      return { ok: true, released };
    }
    for (const c of claims) {
      let t;
      try {
        t = getTicket(c.slug, c.ticketId);
      } catch (_) {
        continue;
      }
      if (!t || t.archived || t.status === "done") continue;
      if (!t.claim || !t.claim.by) continue;
      if (c.by && t.claim.by !== c.by) continue;
      try {
        const res = releaseTicket(c.slug, c.ticketId, t.claim.by, {
          status: "todo",
          source,
          claimRelease: { kind: "session_ended", reason }
        });
        if (res && res.ok) {
          released.push(t.ref);
          try {
            addComment(c.slug, c.ticketId, {
              by: "sidequest",
              kind: "comment",
              source,
              body: `↩️ Auto-released to **todo**: ${reason} (was claimed by \`${t.claim.by}\`). It's back in the ready pool for another worker.`
            });
          } catch (_) {
          }
        }
      } catch (_) {
      }
    }
    return { ok: true, released };
  }
  function sessionClaims(sessionId, opts) {
    const out = [];
    if (!sessionId) return out;
    const agentId = opts && opts.agentId ? String(opts.agentId) : null;
    const agentName = opts && opts.agentName ? String(opts.agentName) : null;
    const executor = opts && opts.executor ? String(opts.executor) : null;
    let claims = [];
    try {
      withWorkersLock(() => {
        const w = readWorkers();
        const s = w.sessions[String(sessionId)];
        claims = s && Array.isArray(s.claims) ? s.claims.slice() : [];
      });
    } catch (_) {
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
          if ((agentId || agentName) && (!state || agentId && state.agentId !== agentId || agentName && state.agentName !== agentName || executor && state.executor !== executor)) continue;
          ref = t.ref;
          status = t.status;
          held = !!(t.claim && t.claim.by && (!c.by || t.claim.by === c.by));
        }
      } catch (_) {
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
    unregisterClaim
  };
}
module.exports = { createWorkers };
