"use strict";
function createReads(dependencies) {
  const {
    checkpointProjection,
    claimIdleMs,
    claimReclaimable,
    classifierCategories,
    contractMetadata,
    countTickets,
    database,
    db,
    openBlockers,
    openBlockersFromIndex,
    oracleProjection,
    pendingSubmission,
    queryTickets,
    readyTickets,
    readyWaveDependencies,
    readyWaves,
    routeDescriptor,
    submissionReadiness
  } = dependencies;
  function briefTicket(slug, t, opts) {
    opts = opts || {};
    let blockedBy;
    if (Array.isArray(opts.blockedBy)) blockedBy = opts.blockedBy;
    else if (opts.index) blockedBy = openBlockersFromIndex(opts.index, t);
    else blockedBy = openBlockers(slug, t);
    const rework = Array.isArray(t.rejectedSubmissions) ? t.rejectedSubmissions.filter((entry) => entry) : [];
    return {
      ref: t.ref,
      title: t.title,
      status: t.status,
      priority: t.priority,
      complexity: t.complexity || null,
      categoryId: t.categoryId || t.category && t.category.id || null,
      categoryName: t.category && t.category.name || null,
      route: routeDescriptor(t.model, t.effort),
      effort: t.effort || null,
      readonlyOverride: t.readonlyOverride === false ? false : null,
      direct: t.directClaim || null,
      ...opts.includeScope ? {
        files: Array.isArray(t.files) ? t.files : [],
        contracts: contractMetadata(t)
      } : {},
      claim: t.claim && t.claim.by ? { by: t.claim.by, at: t.claim.at, stale: claimReclaimable(t) } : null,
      blockedBy,
      comments: Array.isArray(t.comments) ? t.comments.length : 0,
      checkpoint: checkpointProjection(t),
      ...oracleProjection(t) ? { oracle: oracleProjection(t) } : {},
      submission: pendingSubmission(t) ? { commit: t.submission.commit, at: t.submission.at, readiness: submissionReadiness(t.submission) } : null,
      ...rework.length ? { rework } : {}
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
    const budget = opts.maxBytes != null && Number(opts.maxBytes) > 0 ? Number(opts.maxBytes) : null;
    let end;
    if (opts.all) {
      end = total;
    } else if (limit != null) {
      end = Math.min(start + limit, total);
    } else if (budget != null) {
      let size = 0;
      end = start;
      while (end < total) {
        const cost = Buffer.byteLength(JSON.stringify(tickets[end], null, 2), "utf8") + 8;
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
  function ticketReadShape(ticket) {
    if (!ticket || ticket.executorVerify === void 0) return ticket;
    return Object.assign({}, ticket, { verify: ticket.executorVerify });
  }
  function listPayload(slug, opts) {
    opts = opts || {};
    const project = String(slug || "");
    const filter = {
      archived: !!opts.archived,
      status: opts.status == null && !opts.all ? ["todo", "doing", "awaiting-oracle"] : opts.status
    };
    const paging = !opts.all && opts.limit == null && opts.maxBytes == null ? Object.assign({}, opts, { limit: DEFAULT_LIST_PAGE_LIMIT }) : opts;
    const total = countTickets(project, filter);
    let index;
    if (opts.brief) {
      const rows = db.selectRows(database(), "SELECT ref, status FROM tickets WHERE project = ?", [project]);
      index = new Map(rows.map((row) => [String(row.ref).toUpperCase(), row]));
    }
    if (!paging.all && paging.limit != null && paging.maxBytes == null) {
      const offset = Math.min(decodeListCursor(paging.cursor), total);
      let tickets2 = queryTickets(project, { ...filter, limit: paging.limit, offset });
      if (opts.brief) tickets2 = tickets2.map((ticket) => briefTicket(project, ticket, { index }));
      else tickets2 = tickets2.map(ticketReadShape);
      const returned = tickets2.length;
      const nextOffset = offset + returned;
      return {
        tickets: tickets2,
        total,
        returned,
        nextCursor: nextOffset < total ? String(nextOffset) : null,
        claimIdleMs: claimIdleMs(),
        categories: classifierCategories({ project })
      };
    }
    let tickets = queryTickets(project, filter);
    if (opts.brief) tickets = tickets.map((ticket) => briefTicket(project, ticket, { index }));
    else tickets = tickets.map(ticketReadShape);
    const page = pageTickets(tickets, paging);
    page.claimIdleMs = claimIdleMs();
    page.categories = classifierCategories({ project });
    return page;
  }
  function readyPayload(slug, opts) {
    opts = opts || {};
    let tickets = readyTickets(slug, { model: opts.model, category: opts.category });
    const waves = readyWaves(slug, { model: opts.model, category: opts.category }).map((wave) => wave.map((t) => t.ref));
    const waveDependencies = readyWaveDependencies(slug, { model: opts.model, category: opts.category });
    if (opts.brief) tickets = tickets.map((t) => briefTicket(slug, t, { blockedBy: [], includeScope: true }));
    return { tickets, waves, waveDependencies, claimIdleMs: claimIdleMs(), categories: classifierCategories({ project: slug }) };
  }
  return {
    briefTicket,
    listPayload,
    readyPayload
  };
}
module.exports = { createReads };
