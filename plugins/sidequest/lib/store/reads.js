"use strict";
function createReads(dependencies) {
  const {
    countTickets,
    database,
    db,
    openBlockers,
    openBlockersFromIndex,
    queryTickets
  } = dependencies;
  function briefTicket(slug, t, opts) {
    opts = opts || {};
    let blockedBy;
    if (Array.isArray(opts.blockedBy)) blockedBy = opts.blockedBy;
    else if (opts.index) blockedBy = openBlockersFromIndex(opts.index, t);
    else blockedBy = openBlockers(slug, t);
    return {
      ref: t.ref,
      title: t.title,
      status: t.status,
      priority: t.priority,
      ...opts.includeScope ? { files: Array.isArray(t.files) ? t.files : [] } : {},
      blockedBy,
      comments: Array.isArray(t.comments) ? t.comments.length : 0
    };
  }
  function decodeListCursor(cursor) {
    if (cursor == null || cursor === "") return 0;
    const n = Math.floor(Number(cursor));
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
  function pageTickets(tickets, opts) {
    const total = tickets.length;
    const start = Math.min(decodeListCursor(opts.cursor), total);
    const limit = opts.limit != null ? Math.max(0, Math.floor(Number(opts.limit)) || 0) : null;
    const budget = opts.maxChars != null && Number(opts.maxChars) > 0 ? Number(opts.maxChars) : null;
    let end;
    if (opts.all) {
      end = total;
    } else if (limit != null) {
      end = Math.min(start + limit, total);
    } else if (budget != null) {
      let size = 0;
      end = start;
      while (end < total) {
        const cost = JSON.stringify(tickets[end], null, 2).length + 8;
        if (end > start && size + cost > budget) break;
        size += cost;
        end++;
      }
    } else {
      end = total;
    }
    const page = tickets.slice(start, end);
    const nextCursor = end < total ? String(end) : null;
    return { tickets: page, total, returned: page.length, nextCursor };
  }
  const DEFAULT_LIST_PAGE_LIMIT = 40;
  function listPayload(slug, opts) {
    opts = opts || {};
    const project = String(slug || "");
    const filter = {
      archived: !!opts.archived,
      status: opts.status == null && !opts.all ? ["todo", "doing"] : opts.status
    };
    const paging = !opts.all && opts.limit == null ? Object.assign({}, opts, { limit: DEFAULT_LIST_PAGE_LIMIT }) : opts;
    const total = countTickets(project, filter);
    let index;
    if (opts.brief) {
      const rows = db.selectRows(database(), "SELECT ref, status FROM tickets WHERE project = ?", [project]);
      index = new Map(rows.map((row) => [String(row.ref).toUpperCase(), row]));
    }
    if (!paging.all && paging.limit != null && paging.maxChars == null) {
      const offset = Math.min(decodeListCursor(paging.cursor), total);
      let tickets2 = queryTickets(project, { ...filter, limit: paging.limit, offset });
      if (opts.brief) tickets2 = tickets2.map((ticket) => briefTicket(project, ticket, { index }));
      const returned = tickets2.length;
      const nextOffset = offset + returned;
      return {
        tickets: tickets2,
        total,
        returned,
        nextCursor: nextOffset < total ? String(nextOffset) : null
      };
    }
    let tickets = queryTickets(project, filter);
    if (opts.brief) tickets = tickets.map((ticket) => briefTicket(project, ticket, { index }));
    const page = pageTickets(tickets, paging);
    return page;
  }
  return {
    briefTicket,
    listPayload
  };
}
module.exports = { createReads };
