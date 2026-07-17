'use strict';
/**
 * sidequest - MCP tool layer
 *
 * A second entry point over the same store as the CLI, so an agent working the
 * board calls typed tools (mcp__sidequest__claim, …) instead of shelling out to
 * `node bin/sidequest.js …` on every action. What that buys:
 *   - one permission grant for the whole toolset instead of a Bash prompt per call,
 *   - structured JSON in and out (no stdout parsing, no literal-\n heredoc trap on
 *     multi-line descriptions), and
 *   - a smaller skill, because the tool schemas are self-describing.
 *
 * This file is pure logic: a tool registry plus a JSON-RPC request handler. The
 * transport (a newline-delimited stdio loop) lives in bin/sidequest-mcp.js, and
 * the tests drive handleRequest() directly. Node stdlib only — no MCP SDK, so the
 * plugin stays dependency-free; the stdio JSON-RPC surface is tiny enough to
 * implement by hand.
 *
 * Every tool resolves its target board exactly like the CLI (CLAUDE_PROJECT_DIR
 * or cwd -> nearest repo root -> ensureProject; an explicit `project` arg -> the
 * registered board it names), so the CLI, the dashboard, and these tools all act
 * on the same store.
 */

const path = require('path');
const fs = require('fs');
const store = require('./store');
const work = require('./work');
const agentsync = require('./agentsync');

const SERVER_NAME = 'sidequest';
// The latest MCP protocol revision we implement. In `initialize` we echo the
// client's requested version when it sends one (maximizes compatibility) and
// fall back to this otherwise.
const DEFAULT_PROTOCOL_VERSION = '2025-06-18';

function serverVersion() {
  try {
    return require('../.claude-plugin/plugin.json').version || '0.0.0';
  } catch (_) {
    return '0.0.0';
  }
}

/* ------------------------------------------------------------------ *
 *  Project resolution (a non-exiting mirror of the CLI's resolveProject)
 * ------------------------------------------------------------------ */

function resolveProject(projectArg) {
  const arg = projectArg == null ? '' : String(projectArg).trim();
  if (arg) {
    const res = store.findProject(arg);
    if (res.ok) return { slug: res.slug, meta: res.meta };
    if (res.reason === 'ambiguous') {
      throw new Error(`project "${arg}" matches ${res.matches.length} boards named "${arg}" — pass the absolute path to disambiguate.`);
    }
    if (path.isAbsolute(arg)) {
      let isDir = false;
      try { isDir = fs.statSync(arg).isDirectory(); } catch (_) { /* not a dir */ }
      if (isDir) return store.ensureProject(store.nearestRepoRoot(path.resolve(arg)));
    }
    const known = Array.from(new Set(res.known || []));
    throw new Error(`project "${arg}" does not match any registered board.${known.length ? ' Known: ' + known.join(', ') : ''}`);
  }
  const start = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  return store.ensureProject(store.nearestRepoRoot(start));
}

// The session a claim is taken under (so a SessionEnd hook can release it fast).
// The server process inherits CLAUDE_SESSION_ID from the runtime; an explicit
// arg overrides. Null when neither is present (registry stays dormant, TTL covers).
function sessionOf(args) {
  const v = (args && args.session) || process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || '';
  return String(v).trim() || null;
}

// A worker identity is required for claim/next/done/release — a generic shared
// value silently defeats the atomic-claim guarantee (two sessions both "claude"
// each think they own the ticket), so we don't invent a default here.
function requireBy(args, action) {
  const by = args && args.by != null ? String(args.by).trim() : '';
  if (!by) throw new Error(`${action}: "by" is required — a unique per-worker id (e.g. claude-<8 hex>). A shared value breaks the atomic-claim guarantee.`);
  return by;
}

/* ------------------------------------------------------------------ *
 *  Effort-drift guard (mirrors bin/sidequest.js effortDriftReason)
 *
 *  Kept in lockstep with the CLI's copy: an executor claiming with a baked
 *  --effort that doesn't match the ticket's derived effort means the wrong-tier
 *  agent was spawned, so the claim is refused before it mutates anything.
 * ------------------------------------------------------------------ */

function effortDrift(slug, idOrRef, claimedEffort) {
  if (claimedEffort == null) return null;
  const t = store.getTicket(slug, idOrRef);
  if (!t || !t.effort) return null;
  const claimed = String(claimedEffort).toLowerCase();
  if (claimed === t.effort) return null;
  const execName = (t.exec && t.exec.agent) || `sidequest-exec-${t.effort}`;
  return {
    reason: 'effort_mismatch',
    ref: t.ref,
    derivedModel: t.model,
    derivedEffort: t.effort,
    claimedEffort: claimed,
    message: `${t.ref} resolves to ${t.model}·${t.effort} — spawn ${execName}, not an exec-${claimed}. Claim refused.`,
  };
}

function executorDrift(slug, idOrRef, claimedEffort, executorName, token) {
  const effort = effortDrift(slug, idOrRef, claimedEffort);
  if (effort) return effort;
  const t = store.getTicket(slug, idOrRef);
  if (t && t.dispatchNonce && token === t.dispatchNonce && executorName !== t.dispatchExecutor) {
    return {
      reason: 'executor_mismatch', ref: t.ref,
      derivedModel: t.model, derivedEffort: t.effort,
      executor: executorName || null, expectedExecutor: t.dispatchExecutor,
      message: `${t.ref} has a prepared dispatch and requires ${t.dispatchExecutor} with its token. Claim refused.`,
    };
  }
  if (t && t.dispatchNonce && token === t.dispatchNonce && executorName === t.dispatchExecutor) return null;
  if (!executorName) return null;
  if (!t || !t.exec || t.exec.backend !== 'codex') return null;
  if (executorName === t.exec.agent) return null;
  return {
    reason: 'executor_mismatch', ref: t.ref,
    derivedModel: t.model, derivedEffort: t.effort, backend: t.exec.backend,
    runsLabel: t.exec.runsLabel, executor: executorName, expectedExecutor: t.exec.agent,
    message: `${t.ref} resolves to ${t.exec.runsLabel} · ${t.effort} (${t.exec.backend}), but ${executorName} is not its generated executor. Spawn ${t.exec.agent} or use Sidequest dispatch. Claim refused.`,
  };
}

/* ------------------------------------------------------------------ *
 *  Model-argument validation
 *
 *  ready.model/next.model FILTER on the derived TIER (the four built-ins). A
 *  done STAMP records provenance, which may be a tier OR the Codex model that
 *  actually backed it. Validate by hand and name valid values on a miss.
 * ------------------------------------------------------------------ */

// ready/next: a --model FILTER on a tier. Blank/any/none mean "no filter"; an
// unrecognized non-empty value is refused instead of silently matching all.
function requireKnownModelFilter(action, value) {
  if (value == null) return;
  const cls = store.classifyModelFilter(value);
  if (cls === 'unknown') {
    throw new Error(`${action}: unknown model "${value}" — known: ${store.getModelVocab().models.join(', ')}`);
  }
}

function requireKnownModel(action, value) {
  if (value == null || !String(value).trim()) return;
  if (!store.resolveExec(value, null)) {
    throw new Error(`${action}: unknown model "${value}" — known: ${store.getModelVocab().models.join(', ')}`);
  }
}

/* ------------------------------------------------------------------ *
 *  Tools
 *
 *  Each: { name, description, inputSchema (JSON Schema), handler(args)->object }.
 *  A handler returns a plain object; the caller serializes it to a JSON text
 *  content block. A thrown Error becomes an isError tool result the model reads.
 * ------------------------------------------------------------------ */

const PROJECT_PROP = { type: 'string', description: 'Board; defaults to the current project.' };

const TOOL_DESCRIPTION_OVERRIDES = {
  claim: 'Atomically claim a ticket before work. Pass the routed executor and effort; proceed only when ok:true.',
  dispatch: 'Prepare a ticket executor. Default dispatch is instant; ephemeral writes a legacy per-ticket definition.',
  done: 'Finish a claimed ticket and release its claim. Stamp the actual model and effort.',
  native_agent: 'Return the registered native Agent spawn spec for a ticket; pass it to Agent unchanged.',
};

function conciseDescription(description) {
  const firstSentence = String(description || '').match(/^.*?[.!?](?:\s|$)/);
  return firstSentence ? firstSentence[0].trim() : description;
}

function compactSchema(schema) {
  if (Array.isArray(schema)) return schema.map(compactSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const compact = {};
  for (const [key, value] of Object.entries(schema)) {
    compact[key] = key === 'description' ? conciseDescription(value) : compactSchema(value);
  }
  return compact;
}

/* ------------------------------------------------------------------ *
 *  List paging
 *
 *  The MCP tool-result token ceiling means an unbounded board read can overflow
 *  even in the compact brief shape once a single column holds a few hundred
 *  tickets. SQ-220 made each ROW compact, not the row COUNT, so a large board
 *  still tripped the cap (98k chars observed live). The fix is real pagination:
 *  store.listPayload returns a bounded page plus total/returned/nextCursor, and
 *  the caller follows nextCursor to walk the whole board one safe page at a time.
 *
 *  The paging mechanics (offset/limit/size-budget slice, cursor encode/decode)
 *  live in store.listPayload so the CLI (--limit/--cursor) and MCP serve the
 *  exact same shape — that's the parity. What differs is only the DEFAULT: over
 *  MCP we pass a char budget so the first page is auto-bounded to fit the
 *  tool-result cap; the CLI, writing to a terminal or file with no such ceiling,
 *  keeps returning everything in one call unless --limit/--cursor is given
 *  (backward compatible). --brief row shape is untouched — this is row COUNT.
 * ------------------------------------------------------------------ */

// The per-page char budget for the DEFAULT (un-limited) MCP list. The store
// sizes a page against the same pretty JSON.stringify the transports emit, so
// this is in real output chars: ~55k leaves a comfortable margin under the
// tool-result ceiling (the live overflow was ~98k / 100k) once the response
// envelope and array indentation are added.
const LIST_CHAR_BUDGET = 55000;

function closeDispatchExecutor(ticket) {
  if (ticket && ticket.dispatchExecutor) agentsync.cleanupNativeAgents({ name: ticket.dispatchExecutor });
}

function mutationAck(project, result, changed) {
  const ticket = result.ticket;
  const out = { ok: !!result.ok, project };
  if (ticket) Object.assign(out, { ref: ticket.ref, status: ticket.status });
  if (!result.ok) {
    for (const key of ['reason', 'claim', 'expectedExecutor', 'derivedEffort', 'claimedEffort', 'max', 'length', 'message']) {
      if (result[key] !== undefined) out[key] = result[key];
    }
    return out;
  }
  return Object.assign(out, changed || {});
}

function changedTicketFields(ticket, args) {
  const fields = {};
  for (const key of ['title', 'description', 'priority', 'labels', 'files', 'complexity']) {
    if (args[key] !== undefined) fields[key] = ticket[key];
  }
  if (args.anchors !== undefined) fields.anchors = ticket.executorAnchors;
  if (args.verify !== undefined) fields.verify = ticket.executorVerify;
  if (args.story !== undefined) fields.storyId = ticket.storyId;
  if (args.category !== undefined) fields.categoryId = ticket.categoryId;
  if (args.why !== undefined) fields.why = ticket.complexityWhy;
  return fields;
}

function withoutCategories(payload) {
  const { categories, ...trimmed } = payload;
  return trimmed;
}

const TOOLS = [
  {
    name: 'list',
    description: 'List tickets on a board, PAGED so a large board never overflows the tool-result cap. Default rows are compact (no bodies or threads). Pass detail:true for full tickets. Returns tickets + total + returned + nextCursor. When nextCursor is non-null, call again with cursor set to it; limit:N sets an exact page size; all:true returns the whole column (may overflow on a big board).',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_PROP,
        status: { type: 'string', enum: ['todo', 'doing', 'done'] },
        archived: { type: 'boolean' },
        detail: { type: 'boolean', description: 'Return full ticket bodies and comment threads. Omit for the compact default.' },
        cursor: { type: 'string', description: 'Page cursor from a previous response\'s nextCursor. Omit for the first page.' },
        limit: { type: 'integer', minimum: 0, description: 'Exact page size (max tickets per page). Omit for the automatic token-safe page.' },
        all: { type: 'boolean', description: 'Return every matching ticket in one call, bypassing paging. Use only when you truly need the whole column — a big board can overflow the tool-result limit.' },
      },
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      // MCP board reads are routine orchestration reads, so omit completed work
      // and ticket bodies unless the caller explicitly asks for either.
      const status = args.status == null ? ['todo', 'doing'] : args.status;
      const brief = !args.detail;
      // Bound the DEFAULT page so a few-hundred-ticket column can't overflow the
      // tool-result token ceiling. A caller that passes limit or all opts out of
      // the auto budget and takes responsibility for the page size.
      const maxChars = (args.limit == null && !args.all) ? LIST_CHAR_BUDGET : null;
      const payload = store.listPayload(slug, {
        status, archived: args.archived, brief,
        cursor: args.cursor, limit: args.limit, all: args.all, maxChars,
      });
      const out = Object.assign({ project: slug, projectName: meta.name }, withoutCategories(payload));
      if (payload.nextCursor) {
        out.hint = `Page shows ${payload.returned} of ${payload.total} tickets. Fetch the next page with cursor:"${payload.nextCursor}"; keep following nextCursor until it is null. Or narrow with status/the ready tool, or pass all:true (may overflow on a big board).`;
      }
      return out;
    },
  },
  {
    name: 'pulse',
    description: 'One compact liveness read for a ticket: status, claim age, latest comment, dispatch state, and fail-soft scoped git activity.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_PROP,
        ref: { type: 'string', description: 'Ticket ref or id.' },
      },
      required: ['ref'],
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const pulse = store.pulsePayload(slug, args.ref);
      if (!pulse) throw new Error(`pulse: no ticket "${args.ref}" in ${meta.name}`);
      return Object.assign({ project: slug, projectName: meta.name }, withoutCategories(pulse));
    },
  },
  {
    name: 'changes',
    description: 'Compact ticket delta since an ISO timestamp. Omit since for the last 60 minutes. Returns serverTime to use as the next since value.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_PROP,
        since: { type: 'string', description: 'Exclusive ISO timestamp from a prior serverTime.' },
      },
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      return Object.assign({ project: slug, projectName: meta.name }, withoutCategories(store.changesPayload(slug, args.since)));
    },
  },
  {
    name: 'ready',
    description: 'The workable set: unclaimed, unblocked, not-done tickets, partitioned into parallel-safe waves by declared file scope. Filter by resolved model or category ID. brief:true returns compact tickets — default to it for orchestration reads.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_PROP,
        model: { type: 'string', description: 'Filter to a resolved Claude runtime or discovered Codex model slug.' },
        category: { type: 'string', description: 'Filter to a category ID.' },
        brief: { type: 'boolean', description: 'Compact tickets: ref/title/status/priority/complexity/categoryId/categoryName/model/effort/files/claim/blockedBy/submission, plus a comments count and awaitingReply. No bodies. Unclassified tickets have null category fields: read category_list, then update before dispatch.' },
      },
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      requireKnownModelFilter('ready', args.model);
      const payload = store.readyPayload(slug, { model: args.model, category: args.category, brief: args.brief });
      return Object.assign({ project: slug, projectName: meta.name }, withoutCategories(payload));
    },
  },
  {
    name: 'add',
    description: 'File a new ticket. Choose category from the returned taxonomy and pass it here, or use legacy complexity + why. Set unclassified:true only when deliberately leaving classification for a later update before dispatch. model/effort are never set directly. description is a developer-to-developer spec (Where / Contract / Bounds / Verify), passed as a normal string (real newlines fine — no shell escaping).',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_PROP,
        title: { type: 'string' },
        description: { type: 'string' },
        priority: { type: 'string', enum: store.VALID_PRIORITY },
        status: { type: 'string', enum: store.VALID_STATUS },
        labels: { type: 'array', items: { type: 'string' } },
        files: { type: 'array', items: { type: 'string' }, description: 'Declared file scope (paths or dir prefixes) for parallel-wave planning.' },
        anchors: { type: 'string', maxLength: store.EXECUTOR_ANCHORS_MAX, description: 'Optional pre-scouted executor anchors, carried verbatim into the native task prompt.' },
        verify: { type: 'string', maxLength: store.EXECUTOR_VERIFY_MAX, description: 'Optional exact verification command, carried verbatim into the native task prompt.' },
        story: { type: 'string', description: 'A story ref (US-n) to file this ticket into.' },
        complexity: { type: 'integer', minimum: 1, maximum: 10 },
        why: { type: 'string', description: 'Motivation for the complexity score, against the actual task (min 20 chars).' },
        category: { type: 'string', description: 'Enabled category id from category_list.' },
        unclassified: { type: 'boolean', description: 'Explicitly allow no category or legacy complexity. Classify with update before dispatch.' },
      },
      required: ['title'],
    },
    handler(args) {
      if (!args.title || !String(args.title).trim()) throw new Error('add: title is required.');
      if (args.model != null || args.effort != null) throw new Error('add: model/effort are not set directly — use category or complexity + why.');
      const { slug, meta } = resolveProject(args.project);
      let category = null;
      if (args.category != null) {
        category = String(args.category).trim().toLowerCase();
        const valid = store.getCategories({ project: slug, includeDisabled: false }).map((entry) => entry.id);
        if (!valid.includes(category)) throw new Error(`add: unknown category "${args.category}" — valid: ${valid.join(', ')}`);
      }
      const complexity = store.coerceComplexity(args.complexity);
      if (!category && complexity == null && !args.unclassified) throw new Error('add: pass category, legacy complexity + why, or unclassified:true.');
      if (complexity != null && (!args.why || String(args.why).trim().length < 20)) throw new Error('add: why is required with complexity (min 20 chars).');
      const created = store.createTicket(slug, {
        title: args.title,
        description: args.description || '',
        priority: args.priority,
        status: args.status,
        labels: args.labels,
        files: args.files,
        executorAnchors: args.anchors,
        executorVerify: args.verify,
        storyId: args.story,
        complexity: args.complexity,
        complexityWhy: args.why,
        category,
        source: 'mcp',
      });
      const ticket = store.getTicket(slug, created.ref) || created;
      const changed = { title: ticket.title };
      const warnings = store.ticketReferenceWarnings(slug, ticket.title, ticket.description);
      if (warnings.length) changed.warnings = warnings;
      return mutationAck(slug, { ok: true, ticket }, changed);
    },
  },
  {
    name: 'update',
    description: 'Edit a ticket by ref. Any omitted field is left unchanged. Re-scoring needs both complexity and a fresh why. Set story to "none" to detach. model/effort are not accepted. Deletion is not a status; use the permanent remove tool instead.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        project: PROJECT_PROP,
        title: { type: 'string' },
        description: { type: 'string' },
        priority: { type: 'string', enum: store.VALID_PRIORITY },
        status: { type: 'string', enum: store.VALID_STATUS },
        labels: { type: 'array', items: { type: 'string' } },
        files: { type: 'array', items: { type: 'string' }, description: 'Declared file scope (paths or dir prefixes) for parallel-wave planning.' },
        anchors: { type: 'string', maxLength: store.EXECUTOR_ANCHORS_MAX, description: 'Optional pre-scouted executor anchors, carried verbatim into the native task prompt.' },
        verify: { type: 'string', maxLength: store.EXECUTOR_VERIFY_MAX, description: 'Optional exact verification command, carried verbatim into the native task prompt.' },
        story: { type: 'string' },
        complexity: { type: 'integer', minimum: 1, maximum: 10 },
        why: { type: 'string' },
        category: { type: 'string', description: 'Enabled category id from category_list. Use "none" to clear.' },
      },
      required: ['ref'],
    },
    handler(args) {
      if (args.model != null || args.effort != null) throw new Error('update: model/effort are not accepted — routing is derived from complexity.');
      if (args.complexity != null && (!args.why || String(args.why).trim().length < 20)) {
        throw new Error('update: re-scoring complexity needs a fresh why (min 20 chars).');
      }
      const { slug, meta } = resolveProject(args.project);
      const patch = { source: 'mcp' };
      for (const k of ['title', 'description', 'priority', 'status', 'labels', 'files', 'complexity']) {
        if (args[k] !== undefined) patch[k] = args[k];
      }
      if (args.anchors !== undefined) patch.executorAnchors = args.anchors;
      if (args.verify !== undefined) patch.executorVerify = args.verify;
      if (args.story !== undefined) patch.storyId = args.story;
      if (args.category !== undefined) {
        if (args.category === 'none' || args.category === null) patch.category = null;
        else {
          const category = String(args.category).trim().toLowerCase();
          const valid = store.getCategories({ project: slug, includeDisabled: false }).map((entry) => entry.id);
          if (!valid.includes(category)) throw new Error(`update: unknown category "${args.category}" — valid: ${valid.join(', ')}`);
          patch.category = category;
        }
      }
      if (args.why !== undefined) patch.complexityWhy = args.why;
      const updated = store.updateTicket(slug, args.ref, patch);
      if (!updated) throw new Error(`update: no ticket "${args.ref}" on ${meta.name}.`);
      const t = store.getTicket(slug, updated.ref) || updated;
      const changed = changedTicketFields(t, args);
      const warnings = store.ticketReferenceWarnings(slug, t.title, t.description);
      if (warnings.length) changed.warnings = warnings;
      return mutationAck(slug, { ok: true, ticket: t }, changed);
    },
  },
  {
    name: 'remove',
    description: 'Permanently and irreversibly delete a ticket by ref. Refuses a live claim unless force:true is passed.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        project: PROJECT_PROP,
        force: { type: 'boolean', description: 'Permanently remove a ticket with a live claim. Use only when certain.' },
      },
      required: ['ref'],
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const ticket = store.getTicket(slug, args.ref);
      if (!ticket) throw new Error(`remove: no ticket "${args.ref}" on ${meta.name}.`);
      if (ticket.claim && ticket.claim.by && !store.isClaimStale(ticket.claim) && !args.force) {
        return { ok: false, project: slug, reason: 'claimed', ref: ticket.ref, claim: ticket.claim, message: `${ticket.ref} is live-claimed by ${ticket.claim.by}; pass force:true to permanently remove it.` };
      }
      const removed = { ref: ticket.ref, title: ticket.title };
      if (!store.deleteTicket(slug, ticket.id)) {
        throw new Error(`remove: could not delete "${ticket.ref}" from ${meta.name}.`);
      }
      return { ok: true, project: slug, removed, ref: removed.ref, title: removed.title };
    },
  },
  {
    name: 'claim',
    description: 'Atomically claim a ticket before working it (moves it to doing). Fails if gone/done/claimed. For Codex routes, pass executor from the ticket\'s authoritative runtime so generic executors are refused. by must be a UNIQUE per-worker id. Pass effort (the executor\'s baked level) to be refused if it doesn\'t match the resolved route. Never work a ticket whose claim did not return ok:true.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        project: PROJECT_PROP,
        by: { type: 'string', description: 'Unique per-worker id (e.g. claude-<8 hex>).' },
        effort: { type: 'string', enum: store.VALID_EFFORTS },
        executor: { type: 'string', description: 'Exact executor name from the ticket runtime; proves a Codex route uses its backend-specific generated executor.' },
        token: { type: 'string', description: 'Dispatch nonce required by tickets prepared for an ephemeral executor.' },
        force: { type: 'boolean', description: 'Steal a live claim — only when certain.' },
        session: { type: 'string' },
      },
      required: ['ref', 'by'],
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const by = requireBy(args, 'claim');
      const drift = executorDrift(slug, args.ref, args.effort, args.executor, args.token);
      if (drift) return Object.assign({ ok: false, project: slug }, drift);
      const res = store.claimTicket(slug, args.ref, by, { force: !!args.force, token: args.token, executor: args.executor, source: 'mcp', sessionId: sessionOf(args) });
      return mutationAck(slug, res, res.ok ? { claim: res.ticket.claim } : null);
    },
  },
  {
    name: 'sweepClaims',
    description: 'Release every claim older than the configured staleness TTL, add an audit comment, and leave fresh claims untouched.',
    inputSchema: {
      type: 'object',
      properties: { project: PROJECT_PROP },
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      return store.sweepStaleClaims({ project: slug, source: 'mcp' });
    },
  },
  {
    name: 'next',
    description: 'Atomically claim the top-priority available ticket. Filter by resolved model and/or category ID. Returns ok:false reason:empty when nothing is claimable.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_PROP,
        by: { type: 'string' },
        model: { type: 'string', description: 'Filter to a resolved Claude runtime or discovered Codex model slug.' },
        category: { type: 'string', description: 'Filter to a category ID.' },
        priority: { type: 'string', enum: store.VALID_PRIORITY },
        session: { type: 'string' },
      },
      required: ['by'],
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const by = requireBy(args, 'next');
      requireKnownModelFilter('next', args.model);
      const res = store.claimNext(slug, by, { priority: args.priority, model: args.model, category: args.category, source: 'mcp', sessionId: sessionOf(args) });
      return mutationAck(slug, res, res.ok ? { claim: res.ticket.claim } : null);
    },
  },
  {
    name: 'done',
    description: 'Mark a claimed ticket done and release the claim. Stamp model + effort you actually ran as (provenance). by should match the claim.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        project: PROJECT_PROP,
        by: { type: 'string' },
        model: { type: 'string', description: 'Concrete runtime model that actually worked this ticket (provenance).' },
        effort: { type: 'string', enum: store.VALID_EFFORTS },
        session: { type: 'string' },
      },
      required: ['ref', 'by'],
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const by = requireBy(args, 'done');
      requireKnownModel('done', args.model);
      const ticket = store.getTicket(slug, args.ref);
      const res = store.completeTicket(slug, args.ref, by, { source: 'mcp', model: args.model, effort: args.effort, sessionId: sessionOf(args) });
      if (res.ok) closeDispatchExecutor(ticket);
      return mutationAck(slug, res, res.ok ? { workedBy: res.ticket.workedBy } : null);
    },
  },
  {
    name: 'release',
    description: 'Drop a claim without finishing (optionally set status, e.g. back to todo). by should match the claim.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        project: PROJECT_PROP,
        by: { type: 'string' },
        status: { type: 'string', enum: store.VALID_STATUS },
        session: { type: 'string' },
      },
      required: ['ref', 'by'],
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const by = requireBy(args, 'release');
      const ticket = store.getTicket(slug, args.ref);
      const res = store.releaseTicket(slug, args.ref, by, { status: args.status, source: 'mcp', sessionId: sessionOf(args) });
      if (res.ok) closeDispatchExecutor(ticket);
      return mutationAck(slug, res);
    },
  },
  {
    name: 'comment',
    description: 'Add a note-to-self comment to a ticket (a progress note, decision, or spike finding). Does NOT pause — use ask for a question that needs the human.',
    inputSchema: {
      type: 'object',
      properties: { ref: { type: 'string' }, project: PROJECT_PROP, body: { type: 'string' }, by: { type: 'string' } },
      required: ['ref', 'body'],
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const res = store.addComment(slug, args.ref, { body: args.body, by: args.by || 'agent', kind: 'comment', source: 'mcp' });
      return mutationAck(slug, res, res.ok ? { comment: res.comment } : null);
    },
  },
  {
    name: 'ask',
    description: 'Post a QUESTION to the human on a ticket — this means pause and wait for their dashboard reply, do not guess and continue. Poll comments for a source:"dashboard" reply.',
    inputSchema: {
      type: 'object',
      properties: { ref: { type: 'string' }, project: PROJECT_PROP, body: { type: 'string' }, by: { type: 'string' } },
      required: ['ref', 'body'],
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const res = store.addComment(slug, args.ref, { body: args.body, by: args.by || 'agent', kind: 'question', source: 'mcp' });
      return mutationAck(slug, res, res.ok ? { comment: res.comment } : null);
    },
  },
  {
    name: 'comments',
    description: 'Read a ticket\'s full comment thread (read it BEFORE working the ticket — a prior agent may have left the context you need).',
    inputSchema: {
      type: 'object',
      properties: { ref: { type: 'string' }, project: PROJECT_PROP },
      required: ['ref'],
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const t = store.getTicket(slug, args.ref);
      if (!t) throw new Error(`comments: no ticket "${args.ref}".`);
      return { project: slug, ref: t.ref, comments: t.comments || [], needsResponse: store.needsResponse(t) };
    },
  },
  {
    name: 'link',
    description: 'Relate two tickets (the inverse is written automatically). verb: blocks | depends-on | related. A ticket blocked by an unfinished one is skipped by ready/next.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string' },
        verb: { type: 'string', enum: ['blocks', 'depends-on', 'related'] },
        to: { type: 'string' },
        project: PROJECT_PROP,
      },
      required: ['from', 'verb', 'to'],
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const res = store.linkTickets(slug, args.from, args.verb, args.to);
      if (!res.ok) throw new Error(`link: ${res.reason}`);
      return { ok: true, project: slug, from: res.from.ref, to: res.to.ref, type: res.type };
    },
  },
  {
    name: 'unlink',
    description: 'Remove every link between two tickets (both directions).',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'string' }, project: PROJECT_PROP },
      required: ['a', 'b'],
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const res = store.unlinkTickets(slug, args.a, args.b);
      if (!res.ok) throw new Error(`unlink: ${res.reason}`);
      return { ok: true, project: slug, a: args.a, b: args.b };
    },
  },
  {
    name: 'assign',
    description: 'Set a ticket\'s persistent assignee (defaults to "you", the human) — separate from an agent claim. Pass to:"none" or use unassign to clear.',
    inputSchema: {
      type: 'object',
      properties: { ref: { type: 'string' }, to: { type: 'string' }, project: PROJECT_PROP },
      required: ['ref'],
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const who = args.to == null ? 'you' : (String(args.to).toLowerCase() === 'none' ? null : args.to);
      const res = store.assignTicket(slug, args.ref, who, { source: 'mcp' });
      if (!res.ok) throw new Error(`assign: no ticket "${args.ref}".`);
      return mutationAck(slug, res, { assignee: res.ticket.assignee });
    },
  },
  {
    name: 'dispatch',
    description: 'Prepare a token-gated dispatch for a ticket. Default (instant): returns the full rendered briefing text plus the token — spawn the ticket\'s STABLE executor (the returned agent) with that briefing as its prompt; it is registered from session start, so there is no registration wait and no def file. ephemeral:true instead writes a unique per-ticket definition with the token embedded (self-contained so any session may adopt it) and returns its name to spawn once registered. Either way the claim stays gated on the token and executor.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        project: PROJECT_PROP,
        session: { type: 'string' },
        ephemeral: { type: 'boolean', description: 'Write a unique per-ticket executor definition (legacy path) instead of instant dispatch. Use for cross-session adoption; costs the watcher-registration wait.' },
        sharedTree: { type: 'boolean', description: 'Escape hatch for a ticket that depends on uncommitted local state. Declared-file tickets otherwise run in isolated worktrees.' },
      },
      required: ['ref'],
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const ephemeral = !!args.ephemeral;
      const prepared = store.prepareDispatch(slug, args.ref, { ephemeral });
      const isolation = agentsync.ticketIsolation(prepared.ticket, !!args.sharedTree);
      if (ephemeral) {
        const created = agentsync.createTicketExecutor(prepared.ticket, { nonce: prepared.token, sessionId: sessionOf(args), isolation });
        return {
          project: slug,
          ref: prepared.ticket.ref,
          mode: 'ephemeral',
          agent: created.name,
          tokenPrefix: prepared.token.slice(0, 12),
          token: prepared.token,
          spawn: created.spawn,
          guidance: `Ephemeral def written. ${agentsync.RESTART_NOTICE} Then spawn ${created.name} and claim ${prepared.ticket.ref} with executor ${created.name} and the returned token.`,
        };
      }
      const agent = prepared.ticket.dispatchExecutor;
      return {
        project: slug,
        ref: prepared.ticket.ref,
        mode: 'instant',
        agent,
        tokenPrefix: prepared.token.slice(0, 12),
        token: prepared.token,
        spawn: Object.assign({ subagent_type: agent, name: agent, mode: 'bypassPermissions' }, isolation ? { isolation } : {}),
        briefing: agentsync.renderTicketBriefing(prepared.ticket, prepared.token),
        guidance: `Instant: spawn ${agent} (already registered) with the returned briefing as its prompt; it claims ${prepared.ticket.ref} with executor ${agent} and the token. No registration wait.`,
      };
    },
  },
  {
    name: 'native_agent',
    description: 'Return a stable native Agent spawn spec for a ticket. Claude Code snapshots agent definitions at session start, so temporary definitions written mid-session cannot be safely spawned. The returned executor is already registered, uses the ticket runtime, and must be passed to Agent unchanged.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        project: PROJECT_PROP,
        prompt: { type: 'string', description: 'The bounded ticket-execution prompt augmented with stored anchors and verify command.' },
        session: { type: 'string' },
        sharedTree: { type: 'boolean', description: 'Escape hatch for a ticket that depends on uncommitted local state. Declared-file tickets otherwise run in isolated worktrees.' },
      },
      required: ['ref', 'prompt'],
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const ticket = store.getTicket(slug, args.ref);
      if (!ticket) throw new Error(`native_agent: no ticket "${args.ref}".`);
      if (!ticket.model || !ticket.effort) throw new Error(`native_agent: ${ticket.ref} has no routable model and effort.`);
      const resolved = store.resolveExec(ticket.model, ticket.effort);
      const created = agentsync.createNativeAgent({
        ref: ticket.ref,
        agentType: resolved.agent || `sidequest-exec-${ticket.effort || 'low'}`,
        spawnModel: resolved.model,
        effort: ticket.effort,
        runtime: resolved.runsModel,
        isolation: agentsync.ticketIsolation(ticket, !!args.sharedTree),
        sessionId: sessionOf(args),
      });
      return Object.assign({
        project: slug,
        ref: ticket.ref,
        prompt: work.executorPrompt(ticket, args.prompt),
      }, created);
    },
  },
  {
    name: 'native_agent_cleanup',
    description: 'Remove a legacy temporary Sidequest native Agent definition after a failed older run. Stable native_agent dispatch does not create files.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, session: { type: 'string' } },
    },
    handler(args) {
      if (!args.name && !sessionOf(args)) throw new Error('native_agent_cleanup: pass name or session.');
      return agentsync.cleanupNativeAgents({ name: args.name, sessionId: sessionOf(args) });
    },
  },
  {
    name: 'category_list',
    description: 'List the categories a project uses to classify tickets, each marked as following the shared default, customized for this board, pinned, added here, or disabled here. Omitted project means the current project; pass global:true for the shared-default policy only.',
    inputSchema: { type: 'object', properties: { project: PROJECT_PROP, global: { type: 'boolean', description: 'Show global-only policy instead of the resolved project taxonomy.' } } },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const projectScope = !args.global;
      const usage = (id) => store.listTickets(slug).filter((ticket) => (ticket.categoryId || (ticket.category && ticket.category.id)) === id).length;
      const layer = projectScope ? store.getProjectCategories(slug) : { rows: [], warnings: [] };
      const categories = store.getCategories(projectScope ? { project: slug, withState: true } : undefined).map((category) => {
        const localRow = layer.rows.find((row) => row.id === category.id) || null;
        return Object.assign({}, category, { origin: localRow ? (localRow.kind === 'ADD' ? 'project' : category.linkState) : 'global', localRow, ticketCount: usage(category.id) });
      });
      for (const localRow of layer.rows.filter((row) => row.kind === 'DISABLE')) categories.push({ id: localRow.id, origin: 'disabled', localRow, effective: null, ticketCount: usage(localRow.id) });
      return { project: slug, projectName: meta.name, categories, warnings: layer.warnings };
    },
  },
  {
    name: 'category_add',
    description: 'Create a global category by default, or a project-local ADD when project is provided. Classification always uses that project\'s effective taxonomy.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_PROP,
        id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, contract: { type: 'string' },
        routeModel: { type: 'string' }, routeEffort: { type: 'string', enum: store.VALID_EFFORTS },
        fallbackModel: { type: 'string' }, fallbackEffort: { type: 'string', enum: store.VALID_EFFORTS }, enabled: { type: 'boolean' },
      },
      required: ['id', 'name', 'routeModel', 'routeEffort'],
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const id = String(args.id || '').trim().toLowerCase();
      const category = {
        id, name: args.name, description: args.description || '', contract: args.contract || '',
        route: { model: args.routeModel, effort: args.routeEffort },
        fallback: args.fallbackModel == null && args.fallbackEffort == null ? null : { model: args.fallbackModel, effort: args.fallbackEffort },
        enabled: args.enabled !== false,
      };
      if (args.project != null) {
        const localRow = store.setProjectCategory(slug, id, 'ADD', category);
        return { ok: true, project: slug, projectName: meta.name, localRow, effective: store.getCategory(id, { project: slug }), warnings: store.getProjectCategories(slug).warnings };
      }
      return { ok: true, project: slug, projectName: meta.name, category: store.setCategory(category) };
    },
  },
  {
    name: 'category_edit',
    description: 'Customize a category for one board (pass project) or edit the shared default for every board (omit project). With project, editing forks the category into that board\'s own independent copy that no longer follows the shared default; other boards are unaffected. enabled false disables it on that board and enabled true clears that local disable; reset with category_relink to follow the shared default again. Without project you rewrite the shared default that every board without its own copy inherits.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_PROP, id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, contract: { type: 'string' },
        routeModel: { type: 'string' }, routeEffort: { type: 'string', enum: store.VALID_EFFORTS },
        fallbackModel: { type: 'string' }, fallbackEffort: { type: 'string', enum: store.VALID_EFFORTS }, enabled: { type: 'boolean' },
      },
      required: ['id'],
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const id = String(args.id || '').trim().toLowerCase();
      const layer = () => store.getProjectCategories(slug);
      const localRow = () => layer().rows.find((row) => row.id === id) || null;
      if (args.project != null && args.enabled === false) {
        const row = store.setProjectCategory(slug, id, 'DISABLE', {});
        return { ok: true, project: slug, id, localRow: { id: row.id, kind: row.kind } };
      }
      if (args.project != null && args.enabled === true && localRow() && localRow().kind === 'DISABLE') {
        store.removeProjectCategory(slug, id);
        return { ok: true, project: slug, id, localRow: null };
      }
      const existing = store.getCategory(id, args.project != null ? { project: slug } : undefined);
      if (!existing) throw new Error(`category_edit: no effective category "${args.id}".`);
      const patch = {};
      for (const key of ['name', 'description', 'contract']) if (args[key] !== undefined) patch[key] = args[key];
      if (args.routeModel !== undefined || args.routeEffort !== undefined) patch.route = { model: args.routeModel === undefined ? existing.route.model : args.routeModel, effort: args.routeEffort === undefined ? existing.route.effort : args.routeEffort };
      if (args.fallbackModel !== undefined || args.fallbackEffort !== undefined) patch.fallback = { model: args.fallbackModel === undefined ? existing.fallback && existing.fallback.model : args.fallbackModel, effort: args.fallbackEffort === undefined ? existing.fallback && existing.fallback.effort : args.fallbackEffort };
      if (args.project != null) {
        const prior = localRow();
        // Editing a board category forks it into a full, independent copy that no
        // longer follows the shared default (DETACH); a board-only category stays ADD.
        const kind = prior && prior.kind === 'ADD' ? 'ADD' : 'DETACH';
        const row = store.setProjectCategory(slug, id, kind, Object.assign({}, existing, patch, { id }));
        return { ok: true, project: slug, id, localRow: { id: row.id, kind: row.kind } };
      }
      if (args.enabled !== undefined) patch.enabled = args.enabled;
      const category = store.setCategory(existing.id, patch);
      return { ok: true, project: slug, id: category.id, changed: Object.keys(patch) };
    },
  },
  {
    name: 'category_detach',
    description: 'Fork a board\'s category into an independent copy without other edits, so it stops following the shared default. Usually unnecessary: category_edit already forks a board category on any change; use this only to fork one as-is.',
    inputSchema: {
      type: 'object',
      properties: { project: PROJECT_PROP, id: { type: 'string' } },
      required: ['project', 'id'],
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const id = String(args.id || '').trim().toLowerCase();
      const localRow = store.detachCategory(slug, id);
      const layer = store.getProjectCategories(slug);
      return { ok: true, project: slug, id, localRow: { id: localRow.id, kind: localRow.kind } };
    },
  },
  {
    name: 'category_relink',
    description: 'Reset a board\'s category to the shared default, dropping its local customization or pin so it follows the shared default again.',
    inputSchema: {
      type: 'object',
      properties: { project: PROJECT_PROP, id: { type: 'string' } },
      required: ['project', 'id'],
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const id = String(args.id || '').trim().toLowerCase();
      const localRow = store.getProjectCategories(slug).rows.find((row) => row.id === id) || null;
      if (!localRow || !['OVERRIDE', 'DETACH'].includes(localRow.kind)) throw new Error(`category_relink: "${args.id}" has no local override or detach.`);
      store.removeProjectCategory(slug, id);
      const layer = store.getProjectCategories(slug);
      return { ok: true, project: slug, id, localRow: null };
    },
  },
  {
    name: 'global_fallback',
    description: 'Read or set the required global routing fallback. Omit model and effort to read it; provide both to set it.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_PROP,
        model: { type: 'string', description: 'Claude runtime or discovered Codex model slug.' },
        effort: { type: 'string', enum: store.VALID_EFFORTS },
      },
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      if (args.model === undefined && args.effort === undefined) {
        return { project: slug, projectName: meta.name, fallback: store.getRoutingFallback() };
      }
      return { ok: true, project: slug, projectName: meta.name, fallback: store.setRoutingFallback({ model: args.model, effort: args.effort }) };
    },
  },
  {
    name: 'category_rm',
    description: 'Remove global policy by default. With project, removes that local row or disables an effective global category locally. general cannot be removed or disabled.',
    inputSchema: { type: 'object', properties: { project: PROJECT_PROP, id: { type: 'string' } }, required: ['id'] },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const id = String(args.id || '').trim().toLowerCase();
      const ticketCount = store.listTickets(slug).filter((ticket) => (ticket.categoryId || (ticket.category && ticket.category.id)) === id).length;
      if (args.project != null) {
        const row = store.getProjectCategories(slug).rows.find((entry) => entry.id === id);
        const localRow = row ? (store.removeProjectCategory(slug, id), null) : store.setProjectCategory(slug, id, 'DISABLE', {});
        return { ok: true, project: slug, projectName: meta.name, id, ticketCount, localRow, effective: store.getCategory(id, { project: slug }), warnings: store.getProjectCategories(slug).warnings };
      }
      if (!store.removeCategory(id)) throw new Error(`category_rm: no category "${args.id}".`);
      return { ok: true, project: slug, projectName: meta.name, id, ticketCount };
    },
  },
  {
    name: 'models',
    description: 'Available models, global fallback, and the effective category taxonomy for project, including project-layer warnings.',
    inputSchema: { type: 'object', properties: { project: PROJECT_PROP } },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      return store.modelsPayload({ project: slug });
    },
  },
  {
    name: 'projects',
    description: 'Every registered board with open/doing/done counts — the switcher across all projects. Pass archived:true to list archived boards only.',
    inputSchema: { type: 'object', properties: { archived: { type: 'boolean', description: 'List archived boards only.' } } },
    handler(args) {
      return { projects: store.listProjects({ archived: !!args.archived }) };
    },
  },
  {
    name: 'archive_board',
    description: 'Archive a board without deleting its tickets. The board reference is required so this cannot target the caller\'s default board by accident.',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string', description: 'Required registered board slug, display name, or path.' } },
      required: ['project'],
    },
    handler(args) {
      if (!args.project || !String(args.project).trim()) throw new Error('archive_board: project is required.');
      const { slug, meta } = resolveProject(args.project);
      const result = store.archiveProject(slug);
      if (!result.ok) throw new Error(`archive_board: no board "${args.project}".`);
      return Object.assign({ project: slug, projectName: meta.name }, result);
    },
  },
  {
    name: 'unarchive_board',
    description: 'Restore an archived board. The board reference is required so this cannot target the caller\'s default board by accident.',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string', description: 'Required registered board slug, display name, or path.' } },
      required: ['project'],
    },
    handler(args) {
      if (!args.project || !String(args.project).trim()) throw new Error('unarchive_board: project is required.');
      const { slug, meta } = resolveProject(args.project);
      const result = store.unarchiveProject(slug);
      if (!result.ok) throw new Error(`unarchive_board: no board "${args.project}".`);
      return Object.assign({ project: slug, projectName: meta.name }, result);
    },
  },
];

const MCP_CLI_ONLY_TOOLS = new Set([
  'archive_board', 'unarchive_board', 'category_add', 'category_rm',
  'global_fallback', 'unlink', 'assign', 'remove',
  // Rare admin/config/switcher reads and the deprecated native_agent path. Kept
  // off the always-on MCP descriptor list (they cost ~530 tokens of schema every
  // request for ops fired ~never); still reachable via the CLI, documented in the
  // skill's "CLI is the fallback" section.
  'native_agent', 'native_agent_cleanup', 'category_detach', 'category_relink',
  'models', 'projects',
]);

const TOOL_BY_NAME = new Map(TOOLS
  .filter((tool) => !MCP_CLI_ONLY_TOOLS.has(tool.name))
  .map((tool) => [tool.name, tool]));

function toolDescriptors() {
  return TOOLS
    .filter((tool) => !MCP_CLI_ONLY_TOOLS.has(tool.name))
    .map((tool) => ({
    name: tool.name,
    description: TOOL_DESCRIPTION_OVERRIDES[tool.name] || conciseDescription(tool.description),
    inputSchema: compactSchema(tool.inputSchema),
  }));
}

/* ------------------------------------------------------------------ *
 *  JSON-RPC request handling
 *
 *  handleRequest(msg) -> a response object to write back, or null for a
 *  notification (no id) that takes no reply. Never throws: a tool error is
 *  returned as an isError tool result the model can read; a protocol error is a
 *  JSON-RPC error object.
 * ------------------------------------------------------------------ */

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}
function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function handleRequest(msg) {
  if (!msg || msg.jsonrpc !== '2.0') return null;
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  if (method === 'initialize') {
    const requested = params && params.protocolVersion;
    return rpcResult(id, {
      protocolVersion: requested || DEFAULT_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: serverVersion() },
    });
  }

  // Notifications carry no id and expect no response.
  if (method === 'notifications/initialized' || (method && method.indexOf('notifications/') === 0)) {
    return null;
  }
  if (method === 'ping') return rpcResult(id, {});

  if (method === 'tools/list') {
    return rpcResult(id, { tools: toolDescriptors() });
  }

  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    const tool = TOOL_BY_NAME.get(name);
    if (!tool) {
      return rpcResult(id, { content: [{ type: 'text', text: `Unknown tool "${name}".` }], isError: true });
    }
    try {
      const out = tool.handler(args);
      return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] });
    } catch (e) {
      return rpcResult(id, { content: [{ type: 'text', text: `${(e && e.message) || e}` }], isError: true });
    }
  }

  if (isNotification) return null; // unknown notification: ignore
  return rpcError(id, -32601, `Method not found: ${method}`);
}

module.exports = {
  SERVER_NAME,
  DEFAULT_PROTOCOL_VERSION,
  TOOLS,
  toolDescriptors,
  resolveProject,
  handleRequest,
  serverVersion,
};
