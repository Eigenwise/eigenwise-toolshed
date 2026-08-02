"use strict";
function createPulse(dependencies) {
  const { listTickets } = dependencies;
  function boundedExcerpt(value, maxChars = 1200) {
    const text = String(value || "");
    if (text.length <= maxChars) return { text, length: text.length, truncated: false };
    const tailLength = Math.min(240, Math.floor(maxChars / 4));
    const marker = `
[… ${text.length - maxChars} more chars; use full:true …]
`;
    const headLength = maxChars - tailLength - marker.length;
    return {
      text: `${text.slice(0, headLength)}${marker}${text.slice(-tailLength)}`,
      length: text.length,
      truncated: true
    };
  }
  const COMMENT_BODY_RETENTION = 10;
  function commentHistory(comments, full = false) {
    const history = Array.isArray(comments) ? comments : [];
    const omittedBodies = full ? 0 : Math.max(0, history.length - COMMENT_BODY_RETENTION);
    if (!omittedBodies) return { comments: history, omittedBodies: 0, notice: null };
    const notice = `${omittedBodies} earlier comment bodies omitted — pass --full to see them.`;
    return {
      comments: history.map((comment, index) => {
        if (index >= omittedBodies) return comment;
        const { body: _body, ...metadata } = comment;
        return Object.assign(metadata, { bodyOmitted: true });
      }),
      omittedBodies,
      notice
    };
  }
  function lastCommentPulse(ticket) {
    const comments = Array.isArray(ticket.comments) ? ticket.comments : [];
    const comment = comments[comments.length - 1];
    if (!comment) return null;
    return {
      at: comment.at,
      by: comment.by,
      kind: comment.kind,
      body: String(comment.body || "").slice(0, 100)
    };
  }
  function latestCommentExcerpt(ticket) {
    const comments = Array.isArray(ticket.comments) ? ticket.comments : [];
    const comment = comments[comments.length - 1];
    if (!comment) return null;
    const body = boundedExcerpt(comment.body, 200);
    return {
      by: comment.by,
      kind: comment.kind,
      body: body.text,
      bodyLength: body.length,
      bodyTruncated: body.truncated
    };
  }
  function changesPayload(slug, since) {
    const serverTime = (/* @__PURE__ */ new Date()).toISOString();
    const nowMs = Date.parse(serverTime);
    const defaultSince = new Date(Date.now() - 60 * 60 * 1e3).toISOString();
    const after = since == null ? defaultSince : String(since);
    const afterMs = Date.parse(after);
    if (!Number.isFinite(afterMs)) throw new Error("changes: --since must be an ISO timestamp.");
    const changedAt = (ticket) => {
      const updatedMs = Date.parse(ticket.updatedAt);
      return updatedMs;
    };
    const tickets = listTickets(slug).filter((ticket) => changedAt(ticket) > afterMs).sort((a, b) => changedAt(a) - changedAt(b)).map((ticket) => {
      return {
        ref: ticket.ref,
        title: ticket.title,
        status: ticket.status,
        lastEventType: ticket.lastEventType || null,
        lastEventSource: ticket.lastEventSource || null,
        lastComment: latestCommentExcerpt(ticket),
        updatedAt: ticket.updatedAt
      };
    });
    return { since: after, serverTime, tickets };
  }
  return {
    boundedExcerpt,
    changesPayload,
    commentHistory
  };
}
module.exports = { createPulse };
