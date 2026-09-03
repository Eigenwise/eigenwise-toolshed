"use strict";
function createComments(dependencies) {
  const {
    crypto,
    getTicket,
    putTicket,
    queueEventNotification,
    recordClaimVerification,
    touchClaimActivity,
    verificationCompletionCheck,
    withTicketLock
  } = dependencies;
  const COMMENT_BODY_MAX = 16e3;
  const COMMENT_BODY_ADVISORY_BYTES = 4096;
  function commentBodyAdvisory(body) {
    const bytes = Buffer.byteLength(body, "utf8");
    if (bytes <= COMMENT_BODY_ADVISORY_BYTES) return null;
    return `body stored in full (${(bytes / 1024).toFixed(1)} KB); default reads excerpt bodies past 1200 chars - prefer a tight report and link artifacts (paths, commit hashes) over pasting content.`;
  }
  function newCommentId() {
    return "c_" + Date.now().toString(36) + "_" + crypto.randomBytes(3).toString("hex");
  }
  function stripControlChars(s) {
    return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  }
  function prepareComment(fields) {
    fields = fields || {};
    const body = stripControlChars(String(fields.body || "")).trim();
    if (!body) return { ok: false, reason: "empty" };
    if (body.length > COMMENT_BODY_MAX) {
      return { ok: false, reason: "too_long", max: COMMENT_BODY_MAX, length: body.length };
    }
    const advisory = commentBodyAdvisory(body);
    return {
      ok: true,
      by: String(fields.by || "agent"),
      kind: "comment",
      body,
      source: fields.source ? String(fields.source) : "cli",
      ...fields.sourceSession ? { sourceSession: String(fields.sourceSession) } : {},
      ...fields.actor ? { actor: String(fields.actor) } : {},
      ...fields.operation ? { operation: String(fields.operation) } : {},
      ...advisory ? { advisory } : {}
    };
  }
  function createComment(fields, at) {
    return {
      id: newCommentId(),
      by: fields.by,
      kind: fields.kind,
      body: fields.body,
      source: fields.source,
      ...fields.sourceSession ? { sourceSession: fields.sourceSession } : {},
      ...fields.actor ? { actor: fields.actor } : {},
      ...fields.operation ? { operation: fields.operation } : {},
      at: at || (/* @__PURE__ */ new Date()).toISOString()
    };
  }
  function hasNegativeControlMarker(body) {
    return String(body || "").split(/\r?\n/).some((line) => line.trim().startsWith("[sidequest:negative-control]"));
  }
  function claimedMarkerComment(fields, ticket) {
    const claimOwner = String(ticket?.claim?.by || "").trim();
    if (!claimOwner || !hasNegativeControlMarker(fields?.body)) return fields;
    return Object.assign({}, fields, { by: claimOwner });
  }
  function duplicateClaimMarker(ticket, fields) {
    if (!ticket?.claim?.by || !hasNegativeControlMarker(fields?.body)) return null;
    return Array.isArray(ticket.comments) ? ticket.comments.find((comment) => comment.by === fields.by && comment.body === fields.body) || null : null;
  }
  function addComment(slug, idOrRef, fields) {
    const prepared = prepareComment(fields);
    if (!prepared.ok) return prepared;
    const found = getTicket(slug, idOrRef);
    if (!found) return { ok: false, reason: "not_found" };
    return withTicketLock(slug, found.id, () => {
      const t = getTicket(slug, found.id);
      if (!t) return { ok: false, reason: "not_found" };
      const attributed = claimedMarkerComment(prepared, t);
      const duplicate = duplicateClaimMarker(t, attributed);
      if (duplicate) return { ok: true, ticket: t, comment: duplicate, duplicate: true };
      const verification = verificationCompletionCheck(slug, t, attributed);
      if (!verification.ok) return Object.assign({ ticket: t }, verification);
      if (!Array.isArray(t.comments)) t.comments = [];
      const comment = createComment(attributed);
      t.comments.push(comment);
      recordClaimVerification(t, comment);
      touchClaimActivity(t, comment.by, comment.at);
      t.lastEventType = "comment";
      t.lastEventSource = comment.source;
      t.updatedAt = comment.at;
      putTicket(slug, t);
      queueEventNotification(slug, t, t.lastEventType, t.lastEventSource, { commentBody: comment.body });
      return { ok: true, ticket: t, comment, ...attributed.advisory ? { advisory: attributed.advisory } : {} };
    });
  }
  function linkTypePair(verb) {
    switch (String(verb || "").toLowerCase().replace(/_/g, "-")) {
      case "blocks":
      case "blocking":
        return ["blocks", "blocked-by"];
      case "blocked-by":
      case "blockedby":
      case "depends-on":
      case "dependson":
      case "depends":
      case "needs":
      case "after":
        return ["blocked-by", "blocks"];
      case "related":
      case "related-to":
      case "relates-to":
      case "relates":
        return ["related", "related"];
      default:
        return null;
    }
  }
  function upperRef(r) {
    return String(r).toUpperCase();
  }
  function addLinkToTicket(slug, idOrRef, type, otherRef) {
    const found = getTicket(slug, idOrRef);
    if (!found) return;
    withTicketLock(slug, found.id, () => {
      const t = getTicket(slug, found.id);
      if (!t) return;
      if (!Array.isArray(t.links)) t.links = [];
      const ref = upperRef(otherRef);
      if (!t.links.some((l) => l.type === type && upperRef(l.ref) === ref)) {
        t.links.push({ type, ref });
        t.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
        putTicket(slug, t);
      }
    });
  }
  function linkTickets(slug, fromRef, verb, toRef) {
    const pair = linkTypePair(verb);
    if (!pair) return { ok: false, reason: "bad_type" };
    const from = getTicket(slug, fromRef);
    const to = getTicket(slug, toRef);
    if (!from) return { ok: false, reason: "from_not_found" };
    if (!to) return { ok: false, reason: "to_not_found" };
    if (from.id === to.id) return { ok: false, reason: "self" };
    addLinkToTicket(slug, from.id, pair[0], to.ref);
    addLinkToTicket(slug, to.id, pair[1], from.ref);
    return { ok: true, from: getTicket(slug, from.id), to: getTicket(slug, to.id), type: pair[0] };
  }
  function unlinkTickets(slug, aRef, bRef) {
    const a = getTicket(slug, aRef);
    const b = getTicket(slug, bRef);
    if (!a || !b) return { ok: false, reason: "not_found" };
    stripLinksTo(slug, a.id, b.ref);
    stripLinksTo(slug, b.id, a.ref);
    return { ok: true };
  }
  function stripLinksTo(slug, idOrRef, otherRef) {
    const found = getTicket(slug, idOrRef);
    if (!found) return;
    withTicketLock(slug, found.id, () => {
      const t = getTicket(slug, found.id);
      if (!t || !Array.isArray(t.links)) return;
      const ref = upperRef(otherRef);
      const kept = t.links.filter((l) => upperRef(l.ref) !== ref);
      if (kept.length !== t.links.length) {
        t.links = kept;
        t.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
        putTicket(slug, t);
      }
    });
  }
  function openBlockers(slug, ticket) {
    if (!ticket || !Array.isArray(ticket.links)) return [];
    const out = [];
    for (const l of ticket.links) {
      if (l.type !== "blocked-by") continue;
      const blocker = getTicket(slug, l.ref);
      if (blocker && blocker.status !== "done") out.push(blocker.ref);
    }
    return out;
  }
  function isBlocked(slug, ticket) {
    return openBlockers(slug, ticket).length > 0;
  }
  function openBlockersFromIndex(index, ticket) {
    if (!ticket || !Array.isArray(ticket.links)) return [];
    const out = [];
    for (const l of ticket.links) {
      if (l.type !== "blocked-by") continue;
      const blocker = index.get(String(l.ref).toUpperCase());
      if (blocker && blocker.status !== "done") out.push(blocker.ref);
    }
    return out;
  }
  return {
    addComment,
    createComment,
    isBlocked,
    linkTickets,
    openBlockers,
    openBlockersFromIndex,
    prepareComment,
    stripControlChars,
    stripLinksTo,
    unlinkTickets,
    upperRef
  };
}
module.exports = { createComments };
