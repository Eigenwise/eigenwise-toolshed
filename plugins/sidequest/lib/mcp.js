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
  const prefs = store.getModelPrefs();
  if (prefs.routing === false) return null;
  const t = store.getTicket(slug, idOrRef);
  if (!t || !t.complexity) return null;
  if (t.model === 'grade-1' || !t.effort) return null;
  const claimed = String(claimedEffort).toLowerCase();
  if (claimed === t.effort) return null;
  // The ticket read already resolved which agent to spawn (t.exec.agent): a
  // Claude tier -> sidequest-exec-<effort>, a Codex-backed tier ->
  // sidequest-exec-<slug>-<effort>. Name that in the refusal.
  const execName = (t.exec && t.exec.agent) || `sidequest-exec-${t.effort}`;
  return {
    reason: 'effort_mismatch',
    ref: t.ref,
    derivedModel: t.model,
    derivedEffort: t.effort,
    claimedEffort: claimed,
    message: `${t.ref} derives to ${t.model}·${t.effort} — spawn ${execName}, not an exec-${claimed}. Claim refused.`,
  };
}

function executorDrift(slug, idOrRef, claimedEffort, executorName) {
  const effort = effortDrift(slug, idOrRef, claimedEffort);
  if (effort) return effort;
  if (!executorName) return null;
  const prefs = store.getModelPrefs();
  if (prefs.routing === false) return null;
  const t = store.getTicket(slug, idOrRef);
  if (!t || !t.complexity || !t.exec || t.exec.backend !== 'codex') return null;
  if (executorName === t.exec.agent) return null;
  return {
    reason: 'executor_mismatch', ref: t.ref, profile: t.profile,
    derivedModel: t.model, derivedEffort: t.effort, backend: t.exec.backend,
    runsLabel: t.exec.runsLabel, executor: executorName, expectedExecutor: t.exec.agent,
    message: `${t.ref} resolves to ${t.profile} · ${t.exec.runsLabel} · ${t.effort} (${t.exec.backend}), but ${executorName} is not its generated executor. Spawn ${t.exec.agent} or use Sidequest dispatch. Claim refused.`,
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
function requireKnownModelFilter(action, value, prefs) {
  if (value == null) return;
  const cls = store.classifyModelFilter(value, prefs);
  if (cls === 'unknown') {
    throw new Error(`${action}: unknown model "${value}" — known: ${store.getModelVocab(prefs).models.join(', ')}`);
  }
}

// done: a provenance STAMP — blank means "no stamp". A built-in tier OR a
// discovered Codex slug (what actually ran) is valid; only genuine garbage is
// refused. makeWorkedBy re-validates on write, so this just gives a nice error.
function requireKnownModel(action, value, prefs) {
  if (value == null || !String(value).trim()) return;
  const s = String(value).trim().toLowerCase();
  const known = store.coerceModel(s) || (prefs.discovered || []).some((d) => d.slug === s);
  if (!known) {
    const slugs = (prefs.discovered || []).map((d) => d.slug);
    const aliases = ['haiku', 'sonnet', 'opus', 'fable'];
    throw new Error(`${action}: unknown model "${value}" — known: ${store.VALID_MODELS.concat(aliases, slugs).join(', ')}`);
  }
}

/* ------------------------------------------------------------------ *
 *  Tools
 *
 *  Each: { name, description, inputSchema (JSON Schema), handler(args)->object }.
 *  A handler returns a plain object; the caller serializes it to a JSON text
 *  content block. A thrown Error becomes an isError tool result the model reads.
 * ------------------------------------------------------------------ */

const PROJECT_PROP = { type: 'string', description: 'Board to target (a registered slug, display name, or absolute path). Omit for the current project.' };

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

const TOOLS = [
  {
    name: 'list',
    description: 'List tickets on a board, PAGED so a large board never overflows the tool-result cap. status filters one column; archived:true shows archived. brief:true returns the compact shape (no bodies or threads) — default to it for routine orchestration reads. Returns tickets + total + returned + nextCursor. When nextCursor is non-null there are more: call again with cursor set to it to fetch the next page; iterate until nextCursor is null to see every ticket. limit:N sets an exact page size; all:true returns the whole column in one call (may overflow on a big board).',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_PROP,
        status: { type: 'string', enum: ['todo', 'doing', 'done'] },
        archived: { type: 'boolean' },
        brief: { type: 'boolean', description: 'Compact tickets: ref/title/status/priority/complexity/model/effort/files/claim/blockedBy, plus a comments count and awaitingReply. No bodies.' },
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
      const brief = args.brief == null ? true : args.brief;
      // Bound the DEFAULT page so a few-hundred-ticket column can't overflow the
      // tool-result token ceiling. A caller that passes limit or all opts out of
      // the auto budget and takes responsibility for the page size.
      const maxChars = (args.limit == null && !args.all) ? LIST_CHAR_BUDGET : null;
      const payload = store.listPayload(slug, {
        status, archived: args.archived, brief,
        cursor: args.cursor, limit: args.limit, all: args.all, maxChars,
      });
      const out = Object.assign({ project: slug, projectName: meta.name }, payload);
      if (payload.nextCursor) {
        out.hint = `Page shows ${payload.returned} of ${payload.total} tickets. Fetch the next page with cursor:"${payload.nextCursor}"; keep following nextCursor until it is null. Or narrow with status/the ready tool, or pass all:true (may overflow on a big board).`;
      }
      return out;
    },
  },
  {
    name: 'ready',
    description: 'The workable set: unclaimed, unblocked, not-done tickets, partitioned into parallel-safe waves by declared file scope. waves is always arrays of refs; full/compact tickets ride in tickets. model filters to one derived tier. brief:true returns compact tickets — default to it for orchestration reads.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_PROP,
        model: { type: 'string', description: 'Filter to a derived grade (grade-1 through grade-4). Deprecated aliases are accepted as input.' },
        brief: { type: 'boolean', description: 'Compact tickets: ref/title/status/priority/complexity/model/effort/files/claim/blockedBy, plus a comments count and awaitingReply. No bodies.' },
      },
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const prefs = store.getModelPrefs();
      requireKnownModelFilter('ready', args.model, prefs);
      const payload = store.readyPayload(slug, { model: args.model, brief: args.brief });
      return Object.assign({ project: slug, projectName: meta.name }, payload);
    },
  },
  {
    name: 'add',
    description: 'File a new ticket. complexity (1-10) and why (a real motivation, min 20 chars) are BOTH required — routing (model+effort) is derived from the score; model/effort are never set directly. description is a developer-to-developer spec (Where / Contract / Bounds / Verify), passed as a normal string (real newlines fine — no shell escaping).',
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
      },
      required: ['title', 'complexity', 'why'],
    },
    handler(args) {
      if (!args.title || !String(args.title).trim()) throw new Error('add: title is required.');
      if (args.model != null || args.effort != null) throw new Error('add: model/effort are not set directly — score the task with complexity + why and routing is derived.');
      if (store.coerceComplexity(args.complexity) == null) throw new Error('add: complexity is required — an integer 1-10 on the task-shape scale (1-2 subagent-shaped, 3-5 daily-coding-shaped, 6-7 complex-agentic-shaped, 8-10 larger-than-a-sitting/research-grade).');
      if (!args.why || String(args.why).trim().length < 20) throw new Error('add: why is required (min 20 chars) — motivate the complexity against the real task.');
      const { slug, meta } = resolveProject(args.project);
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
        source: 'mcp',
      });
      const ticket = store.getTicket(slug, created.ref) || created;
      return { ok: true, project: slug, projectName: meta.name, ticket };
    },
  },
  {
    name: 'update',
    description: 'Edit a ticket by ref. Any omitted field is left unchanged. Re-scoring needs both complexity and a fresh why. Set story to "none" to detach. model/effort are not accepted.',
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
      if (args.why !== undefined) patch.complexityWhy = args.why;
      const t = store.updateTicket(slug, args.ref, patch);
      if (!t) throw new Error(`update: no ticket "${args.ref}" on ${meta.name}.`);
      return { ok: true, project: slug, ticket: t };
    },
  },
  {
    name: 'claim',
    description: 'Atomically claim a ticket before working it (moves it to doing). Fails if gone/done/claimed. For Codex routes, pass executor from the ticket\'s authoritative runtime so generic executors are refused. by must be a UNIQUE per-worker id. Pass effort (the executor\'s baked level) to be refused if it doesn\'t match the derived tier. Never work a ticket whose claim did not return ok:true.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        project: PROJECT_PROP,
        by: { type: 'string', description: 'Unique per-worker id (e.g. claude-<8 hex>).' },
        effort: { type: 'string', enum: store.VALID_EFFORTS },
        executor: { type: 'string', description: 'Exact executor name from the ticket runtime; proves a Codex route uses its backend-specific generated executor.' },
        force: { type: 'boolean', description: 'Steal a live claim — only when certain.' },
        session: { type: 'string' },
      },
      required: ['ref', 'by'],
    },
    handler(args) {
      const { slug } = resolveProject(args.project);
      const by = requireBy(args, 'claim');
      const drift = executorDrift(slug, args.ref, args.effort, args.executor);
      if (drift) return Object.assign({ ok: false, project: slug }, drift);
      const res = store.claimTicket(slug, args.ref, by, { force: !!args.force, source: 'mcp', sessionId: sessionOf(args) });
      return Object.assign({ project: slug }, res);
    },
  },
  {
    name: 'next',
    description: 'Atomically claim the top-priority available ticket. model filters to one derived tier. Returns ok:false reason:empty when nothing is claimable.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_PROP,
        by: { type: 'string' },
        model: { type: 'string', description: 'Filter to a derived grade (grade-1 through grade-4). Deprecated aliases are accepted as input.' },
        priority: { type: 'string', enum: store.VALID_PRIORITY },
        session: { type: 'string' },
      },
      required: ['by'],
    },
    handler(args) {
      const { slug } = resolveProject(args.project);
      const by = requireBy(args, 'next');
      const prefs = store.getModelPrefs();
      requireKnownModelFilter('next', args.model, prefs);
      const res = store.claimNext(slug, by, { priority: args.priority, model: args.model, source: 'mcp', sessionId: sessionOf(args) });
      return Object.assign({ project: slug }, res);
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
        model: { type: 'string', description: 'The grade or runtime model that actually worked this ticket (provenance).' },
        effort: { type: 'string', enum: store.VALID_EFFORTS },
        session: { type: 'string' },
      },
      required: ['ref', 'by'],
    },
    handler(args) {
      const { slug } = resolveProject(args.project);
      const by = requireBy(args, 'done');
      const prefs = store.getModelPrefs();
      requireKnownModel('done', args.model, prefs);
      const res = store.completeTicket(slug, args.ref, by, { source: 'mcp', model: args.model, effort: args.effort, sessionId: sessionOf(args) });
      return Object.assign({ project: slug }, res);
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
      const { slug } = resolveProject(args.project);
      const by = requireBy(args, 'release');
      const res = store.releaseTicket(slug, args.ref, by, { status: args.status, source: 'mcp', sessionId: sessionOf(args) });
      return Object.assign({ project: slug }, res);
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
      const { slug } = resolveProject(args.project);
      const res = store.addComment(slug, args.ref, { body: args.body, by: args.by || 'agent', kind: 'comment', source: 'mcp' });
      return Object.assign({ project: slug }, res);
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
      const { slug } = resolveProject(args.project);
      const res = store.addComment(slug, args.ref, { body: args.body, by: args.by || 'agent', kind: 'question', source: 'mcp' });
      return Object.assign({ project: slug }, res);
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
      const { slug } = resolveProject(args.project);
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
      const { slug } = resolveProject(args.project);
      const res = store.linkTickets(slug, args.from, args.verb, args.to);
      if (!res.ok) throw new Error(`link: ${res.reason}`);
      return Object.assign({ project: slug }, res);
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
      const { slug } = resolveProject(args.project);
      const res = store.unlinkTickets(slug, args.a, args.b);
      if (!res.ok) throw new Error(`unlink: ${res.reason}`);
      return Object.assign({ project: slug }, res);
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
      const { slug } = resolveProject(args.project);
      const who = args.to == null ? 'you' : (String(args.to).toLowerCase() === 'none' ? null : args.to);
      const res = store.assignTicket(slug, args.ref, who, { source: 'mcp' });
      if (!res.ok) throw new Error(`assign: no ticket "${args.ref}".`);
      return Object.assign({ project: slug }, res);
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
      },
      required: ['ref', 'prompt'],
    },
    handler(args) {
      const { slug } = resolveProject(args.project);
      const ticket = store.getTicket(slug, args.ref);
      if (!ticket) throw new Error(`native_agent: no ticket "${args.ref}".`);
      if (!ticket.model || !ticket.effort) throw new Error(`native_agent: ${ticket.ref} has no routable model and effort.`);
      const resolved = store.resolveExec(ticket.model, ticket.effort, store.getModelPrefs());
      const created = agentsync.createNativeAgent({
        ref: ticket.ref,
        agentType: resolved.agent || `sidequest-exec-${ticket.effort || 'low'}`,
        spawnModel: resolved.model,
        effort: ticket.effort,
        grade: ticket.model,
        runtime: resolved.runsModel,
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
    name: 'dispatch',
    description: 'Disabled. Routed work must use native_agent to return an already-registered executor, then the current conversation invokes it through Agent. Sidequest never starts a separate Claude process.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        project: PROJECT_PROP,
      },
      required: ['ref'],
    },
    handler(args) {
      const { slug } = resolveProject(args.project);
      const res = work.nativeDispatchRequired(slug, args.ref);
      throw new Error(`dispatch: ${res.message || res.reason}`);
    },
  },
  {
    name: 'models',
    description: 'The live routing ladder (which complexity maps to which tier·effort), the enabled tiers/efforts, the per-tier backend map (which tiers run on a Codex model vs Claude), the detected Codex models available to map, any stale-mapping warnings, the routing master switch, and the bias.',
    inputSchema: { type: 'object', properties: { project: PROJECT_PROP } },
    handler() {
      const prefs = store.getModelPrefs();
      return {
        prefs,
        ladder: store.routingLadder(prefs),
        discovered: prefs.discovered,
        tierBackend: prefs.tierBackend,
        tierBackendResolved: prefs.tierBackendResolved,
        tierBackendWarnings: prefs.tierBackendWarnings,
        enabled: store.VALID_MODELS.filter((m) => prefs[m]),
      };
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

const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

function toolDescriptors() {
  return TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
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
