'use strict';

function createReads(dependencies: any) {
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
    submissionReadiness,
  } = dependencies;

// A compact projection of a ticket for orchestration reads (`--brief` on the
// CLI, `brief: true` over MCP): everything an orchestrator needs to route,
// batch, and spawn, none of the bodies. A full ticket carries its whole
// description and comment thread, which an orchestrator scanning a board pays
// for on every read without needing; the executor working the ticket reads the
// full record instead. opts.blockedBy short-circuits the blocker lookup when
// the caller already knows it (the ready set is unblocked by construction);
// opts.index resolves blockers in memory. Bare briefTicket(slug, t) still
// works but pays the per-link scan.
function briefTicket(slug?: any, t?: any, opts?: any) {
  opts = opts || {};
  let blockedBy: any;
  if (Array.isArray(opts.blockedBy)) blockedBy = opts.blockedBy;
  else if (opts.index) blockedBy = openBlockersFromIndex(opts.index, t);
  else blockedBy = openBlockers(slug, t);
  return {
    ref: t.ref,
    title: t.title,
    status: t.status,
    priority: t.priority,
    complexity: t.complexity || null,
    categoryId: t.categoryId || (t.category && t.category.id) || null,
    categoryName: t.category && t.category.name || null,
    route: routeDescriptor(t.model, t.effort),
    effort: t.effort || null,
    readonlyOverride: t.readonlyOverride === false ? false : null,
    direct: t.directClaim || null,
    ...(opts.includeScope ? {
      files: Array.isArray(t.files) ? t.files : [],
      contracts: contractMetadata(t),
    } : {}),
    claim: t.claim && t.claim.by ? { by: t.claim.by, at: t.claim.at, stale: claimReclaimable(t) } : null,
    blockedBy,
    comments: Array.isArray(t.comments) ? t.comments.length : 0,
    checkpoint: checkpointProjection(t),
    ...(oracleProjection(t) ? { oracle: oracleProjection(t) } : {}),
    submission: pendingSubmission(t)
      ? { commit: t.submission.commit, at: t.submission.at, readiness: submissionReadiness(t.submission) }
      : null,
  };
}

// A list cursor is just the next row offset, carried as an opaque decimal
// string. Kept transparent (not base64) so `--cursor 150` is usable by hand and
// a script can pipe nextCursor straight back. Garbage or a negative decodes to
// the first page rather than throwing.
function decodeListCursor(cursor?: any) {
  if (cursor == null || cursor === '') return 0;
  const n = Math.floor(Number(cursor));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Slice one page out of the filtered tickets and report where the next page
// starts. Three page modes, in precedence order:
//   - all: the whole set from the cursor, no cap (the escape hatch).
//   - limit: an exact page size (start .. start+limit).
//   - maxChars: a size-budgeted page — accumulate rows until the serialized
//     cost would cross the budget (always keep at least one, so a lone fat row
//     still advances the cursor and iteration can't stall).
//   - none of the above: the default page cap from the cursor.
// nextCursor is the next offset as a string, or null when the page reaches the
// end. Because each page is a contiguous slice and the next cursor is exactly
// where it stopped, following nextCursor to exhaustion yields every ticket once.
function pageTickets(tickets?: any, opts?: any) {
  const total = tickets.length;
  const start = Math.min(decodeListCursor(opts.cursor), total);
  const limit = opts.limit != null ? Math.max(0, Math.floor(Number(opts.limit)) || 0) : null;
  const budget = opts.maxChars != null && Number(opts.maxChars) > 0 ? Number(opts.maxChars) : null;

  let end: any;
  if (opts.all) {
    end = total;
  } else if (limit != null) {
    end = Math.min(start + limit, total);
  } else if (budget != null) {
    let size = 0;
    end = start;
    while (end < total) {
      // Size against the SAME pretty serialization the transports emit
      // (JSON.stringify(payload, null, 2)), so the budget is in real output
      // chars. +8 covers the array indent / comma-newline overhead per row.
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

// The one board-read payload both transports (CLI --json and MCP) serve, so
// their shapes cannot drift: filtering, the brief projection, the blocker
// index, and paging (limit/cursor/maxChars -> total/returned/nextCursor) all
// live here and nowhere else.
const DEFAULT_LIST_PAGE_LIMIT = 40;

function ticketReadShape(ticket?: any) {
  if (!ticket || ticket.executorVerify === undefined) return ticket;
  return Object.assign({}, ticket, { verify: ticket.executorVerify });
}

function listPayload(slug?: any, opts?: any) {
  opts = opts || {};
  const project = String(slug || '');
  const filter = {
    archived: !!opts.archived,
    status: opts.status == null && !opts.all ? ['todo', 'doing'] : opts.status,
  };
  const paging = !opts.all && opts.limit == null ? Object.assign({}, opts, { limit: DEFAULT_LIST_PAGE_LIMIT }) : opts;
  const total = countTickets(project, filter);
  let index: any;
  if (opts.brief) {
    const rows = db.selectRows(database(), 'SELECT ref, status FROM tickets WHERE project = ?', [project]);
    index = new Map(rows.map((row?: any) => [String(row.ref).toUpperCase(), row]));
  }

  if (!paging.all && paging.limit != null && paging.maxChars == null) {
    const offset = Math.min(decodeListCursor(paging.cursor), total);
    let tickets = queryTickets(project, { ...filter, limit: paging.limit, offset });
    if (opts.brief) tickets = tickets.map((ticket?: any) => briefTicket(project, ticket, { index }));
    else tickets = tickets.map(ticketReadShape);
    const returned = tickets.length;
    const nextOffset = offset + returned;
    return {
      tickets,
      total,
      returned,
      nextCursor: nextOffset < total ? String(nextOffset) : null,
      claimIdleMs: claimIdleMs(),
      categories: classifierCategories({ project }),
    };
  }

  let tickets = queryTickets(project, filter);
  if (opts.brief) tickets = tickets.map((ticket?: any) => briefTicket(project, ticket, { index }));
  else tickets = tickets.map(ticketReadShape);
  const page: any = pageTickets(tickets, paging);
  page.claimIdleMs = claimIdleMs();
  page.categories = classifierCategories({ project });
  return page;
}

// Same for the ready read. Waves are ALWAYS arrays of refs (both transports,
// brief or not) — full tickets ride only in `tickets`, so nothing is
// serialized twice and the field has one shape. Ready tickets are unblocked by
// construction, so brief projections skip the blocker lookup outright.
function readyPayload(slug?: any, opts?: any) {
  opts = opts || {};
  let tickets = readyTickets(slug, { model: opts.model, category: opts.category });
  const waves = readyWaves(slug, { model: opts.model, category: opts.category }).map((wave?: any) => wave.map((t?: any) => t.ref));
  const waveDependencies = readyWaveDependencies(slug, { model: opts.model, category: opts.category });
  if (opts.brief) tickets = tickets.map((t?: any) => briefTicket(slug, t, { blockedBy: [], includeScope: true }));
  return { tickets, waves, waveDependencies, claimIdleMs: claimIdleMs(), categories: classifierCategories({ project: slug }) };
}


  return {
    briefTicket,
    listPayload,
    readyPayload,
  };
}

module.exports = { createReads };
