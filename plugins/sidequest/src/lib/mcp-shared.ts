const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const store = require('./store');
const work = require('./work');
const worktrees = require('./worktrees');
const agentsync = require('./agentsync');
const commitScope = require('./commit-scope');
const publish = require('./publish');
const execNames = require('./exec-names');
const { claimRefusalMessage } = require('./refusal-guidance');
const { assertSidequestInstall, assertDispatchTransport } = require('./dispatch-preflight');
const {
  MAX_CONTEXT_PAGE_BYTES,
  contextRevision,
  decodeContextHandle,
  contextCursor,
  decodeContextCursor,
  contextRetrieval,
  contextPageByteLimit,
  utf8Slice,
  rowsWithinByteLimit,
  utf8ByteLength,
  utf8Excerpt,
} = require('./context-packet');

type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: any;
  handler: (args: any) => any | Promise<any>;
};
type RpcId = string | number | null | undefined;
type RpcMessage = { jsonrpc?: string; id?: RpcId; method?: string; params?: any };

const SERVER_NAME = 'sidequest';
// The latest MCP protocol revision we implement. In `initialize` we echo the
// client's requested version when it sends one (maximizes compatibility) and
// fall back to this otherwise.
const DEFAULT_PROTOCOL_VERSION = '2025-06-18';
const CATEGORY_TAXONOMY_WARNING = 'Category stamped without reading the taxonomy this session — run category_list and confirm the description matches.';

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

function resolveProject(projectArg?: any) {
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

// The MCP server inherits its Claude Code session identity. Tool callers only
// know labels, which cannot be used by the Agent lifecycle hooks.
function runtimeSessionId() {
  const v = process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || '';
  return String(v).trim() || null;
}

function sessionOf(args?: any) {
  return runtimeSessionId() || (args && String(args.session || '').trim()) || null;
}

function controlPlaneIdentity(by?: any, session?: any) {
  const explicitBy = String(by || '').trim();
  if (explicitBy) return explicitBy;
  const sessionId = String(session || runtimeSessionId() || '').trim();
  return sessionId ? `orchestrator-${sessionId.slice(0, 12)}` : 'control-plane';
}

function requireDispatchSession() {
  const sessionId = runtimeSessionId();
  if (!sessionId) {
    throw new Error('dispatch: MCP runtime session identity is unavailable. Reload Sidequest in Claude Code and retry; do not pass a session label.');
  }
  return sessionId;
}

function workflowRecipe(slug?: any, categoryId?: any, ticketRef?: any) {
  const requested = String(categoryId || '').trim();
  if (!requested) throw new Error('route_recipe: "category" is required.');
  const category = store.getCategory(requested, { project: slug });
  if (!category || !category.enabled) {
    const disabled = store.getCategory(requested, { project: slug, includeDisabled: true })
      || store.getProjectCategories(slug).rows.some((row: any) => row.kind === 'DISABLE' && row.id === requested.toLowerCase());
    throw new Error(`route_recipe: category "${requested}" is ${disabled ? 'disabled for this project' : 'unknown'}.`);
  }
  const ticket = ticketRef == null ? null : store.getTicket(slug, ticketRef);
  if (ticketRef != null && !ticket) throw new Error(`route_recipe: no ticket "${ticketRef}".`);
  const ticketCategoryId = ticket && (ticket.categoryId || (typeof ticket.category === 'object' ? ticket.category.id : ticket.category));
  if (ticket && ticketCategoryId !== category.id) {
    throw new Error(`route_recipe: ticket "${ticket.ref}" belongs to category "${ticketCategoryId || 'none'}", not "${category.id}".`);
  }
  const resolved = ticket ? store.resolveTicketRoute(ticket, category) : store.resolveCategoryRoute(category);
  if (!resolved || !resolved.exec) throw new Error(resolved?.refusal || `route_recipe: category "${category.id}" has no available route.`);
  const recipe = agentsync.workflowRecipe(Object.assign({}, category, { project: slug }), resolved);
  const selected = store.projectRoutingProfile(slug);
  return Object.assign({}, recipe, {
    profile: { id: selected.profile.id, revision: selected.profile.revision },
    categorySource: { kind: category.origin || 'profile', baseProfileId: category.baseProfileId || null },
    ...(ticket ? { ticket: { ref: ticket.ref, route: ticket.route || null } } : {}),
  });
}

// A worker identity is required for claim/next/done/release — a generic shared
// value silently defeats the atomic-claim guarantee (two sessions both "claude"
// each think they own the ticket), so we don't invent a default here.
function requireBy(args?: any, action?: any) {
  const by = args && args.by != null ? String(args.by).trim() : '';
  if (!by) throw new Error(`${action}: "by" is required — a unique per-worker id (e.g. claude-<8 hex>). A shared value breaks the atomic-claim guarantee.`);
  return by;
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
function requireKnownModelFilter(action?: any, value?: any) {
  if (value == null) return;
  const cls = store.classifyModelFilter(value);
  if (cls === 'unknown') {
    throw new Error(`${action}: unknown model "${value}" — known: ${store.getModelVocab().models.join(', ')}`);
  }
}

function requireKnownModel(action?: any, value?: any, ticket?: any) {
  if (value == null || !String(value).trim()) return value;
  const exec = store.resolveReportedExec(value, null);
  if (!exec) {
    const expected = store.resolvedDispatchRoute(ticket);
    const routeHint = expected ? ` — expected for ${ticket.ref}: ${expected.model}` : '';
    if (ticket && ticket.model === value) return value;
    throw new Error(`${action}: unknown model "${value}"${routeHint} — known: ${store.getModelVocab().models.join(', ')}`);
  }
  return exec.runsModel;
}

const NO_OP_PATHS_SHOWN = 8;

function pathList(paths?: any) {
  const all = Array.isArray(paths) ? paths : [];
  const shown = all.slice(0, NO_OP_PATHS_SHOWN).join(', ');
  return all.length > NO_OP_PATHS_SHOWN ? `${shown} (+${all.length - NO_OP_PATHS_SHOWN} more)` : shown;
}

// A write-routed dispatch that produced nothing has no submission to hand in,
// and no dispatch-time flag could have predicted that: whether a run writes is
// an OUTCOME. So when the write-path guard refuses a done, go look. The board
// already knows where this executor works, and a declared scope with nothing
// uncommitted and nothing committed past the dispatch baseline is a refusal
// with nothing behind it. Anything else stands (SQ-923).
function hasNoOpVerificationEvidence(ticket: any) {
  const holder = String(ticket?.claim?.by || '');
  let verificationStarted = false;
  for (const comment of Array.isArray(ticket?.comments) ? ticket.comments : []) {
    if (comment?.by !== holder) continue;
    const body = String(comment.body || '').trim();
    if (body.startsWith('[sidequest:verify-start] ') && body.slice('[sidequest:verify-start] '.length).trim()) {
      verificationStarted = true;
      continue;
    }
    if (verificationStarted && /^\[sidequest:verify-complete\]\s+no-op(?=$|[\s:])/.test(body)) return true;
  }
  return false;
}

function provenNoOpCloseout(slug: any, ticket: any) {
  const workspace = store.dispatchWorkspace(slug, ticket);
  if (!workspace) {
    return { ok: false as const, detail: 'The board cannot locate this dispatch\'s worktree, so it cannot confirm the run wrote nothing.' };
  }
  const scope = store.dispatchDeclaredFiles(ticket);
  const pending = commitScope.scopedWorkPending(workspace.root, scope, { base: workspace.base });
  if (!pending.ok) {
    return { ok: false as const, detail: `Could not inspect the declared scope in ${workspace.root}: ${pending.message || pending.reason}.` };
  }
  if (!pending.pending) {
    if (hasNoOpVerificationEvidence(ticket)) return { ok: true as const, root: workspace.root };
    return { ok: false as const, detail: 'Post [sidequest:verify-start] <command>, run the declared verify command, then post [sidequest:verify-complete] no-op: <evidence> before closing a no-change dispatch.' };
  }
  const detail = [
    pending.working.length ? `uncommitted ${pathList(pending.working)}` : null,
    pending.committed.length ? `committed but not submitted ${pathList(pending.committed)}` : null,
  ].filter(Boolean).join('; ');
  return { ok: false as const, detail: `Declared scope in ${workspace.root} is not a no-op: ${detail}.` };
}

/* ------------------------------------------------------------------ *
 *  Tools
 *
 *  Each: { name, description, inputSchema (JSON Schema), handler(args)->object }.
 *  A handler returns a plain object; the caller serializes it to a JSON text
 *  content block. A thrown Error becomes an isError tool result the model reads.
 * ------------------------------------------------------------------ */

const PROJECT_PROP = { type: 'string', description: 'Board (current project).' };
// No maxItems here: compactSchema strips property descriptions and tools/list sits
// exactly on its byte budget, so the bound would cost tokens no caller reads. The
// store refuses an over-limit list and names the cap instead (SQ-900).
const FILES_PROP = { type: 'array', items: { type: 'string' }, description: 'Declared file scope: paths, or directory prefixes covering everything under them.' };
const LABELS_PROP = { type: 'array', items: { type: 'string' } };
const CONTRACT_PROP = (verb: string) => ({ type: 'array', items: { type: 'string' }, description: `Named contracts or interfaces this ticket ${verb}.` });
const MODEL_FILTER_PROP = { type: 'string', description: 'Filter by resolved model slug.' };

const TOOL_DESCRIPTION_OVERRIDES: Record<string, string> = {
  context_page: 'Continue context.',
  list: 'List; poll via changes/pulse.',
  pulse: 'Read ticket liveness.',
  changes: 'Poll ticket changes.',
  ready: 'List ready ticket refs.',
  story: 'Stories.',
  story_contract: 'Read story contract pages.',
  story_log: 'Read, append, or rotate a story log.',
  checkpoint: 'Record candidate; retain claim.',
  sweepClaims: 'Release dead claims; live claims stay.',
  next: 'Claim next ticket.',
  scopeRequest: 'Request scope.',
  commit: 'Commit declared worktree paths.',
  add: 'File a ticket. review-audit binds reviewTarget to one terminal candidate.',
  update: 'Update ticket fields by scope. reviewTarget binds once and never clears.',
  rework: 'Reject an unbound candidate for repair; candidate owner only. A review-bound candidate is locked.',
  submit: 'Submit verified work; clear needs owner; force only lets owner replace candidate.',
  integrate: 'Deliver work.',
  comment: 'Add a handoff comment.',
  comments: 'Read comments before work.',
  plan: 'Set ticket plan.',
  link: 'Link tickets.',
  remove: 'Delete ticket; claims need force:true.',
  claim: 'Claim before work; proceed only on ok:true.',
  dispatch: 'Dispatch; returns a token and spawn spec.',
  done: 'Finish; stamp actual model and effort.',
  release: 'Release claim. Oracle needs an ask, then exits awaiting-oracle; oracle handoff stays until verdict.',
  groomClose: 'Close integrated submission.',
  native_agent: 'Get native Agent spawn spec.',
  archive: 'Archive ticket(s).',
  archive_board: '',
  assign: 'Set ticket assignee.',
  category_add: '',
  category_list: 'Taxonomy.',
  category_detach: '',
  category_edit: '',
  category_relink: '',
  category_rm: '',
  route_recipe: '',
  global_fallback: '',
  profile_list: '',
  profile_get: '',
  profile_create: '',
  profile_edit: '',
  profile_retire: '',
  profile_use: '',
  profile_repoint: '',
  profile_promote: '',
  new_board_profile: '',
  models: '',
  projects: '',
  unarchive: '',
  unarchive_board: '',
  unlink: 'Unlink tickets.',
};

function conciseDescription(description?: any) {
  const firstSentence = String(description || '').match(/^.*?[.!?](?:\s|$)/);
  return firstSentence ? firstSentence[0].trim() : description;
}

function validateStoryId(value: any, allowClear = false) {
  if (allowClear && String(value).toLowerCase() === 'none') return;
  if (!/^US-\d+$/.test(String(value))) throw new Error('storyId must be a US-n story ref.');
}

function compactSchema(schema?: any, propertyMap = false): any {
  if (Array.isArray(schema)) return schema.map((entry) => compactSchema(entry));
  if (!schema || typeof schema !== 'object') return schema;
  const compact: any = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key !== 'description' || propertyMap) {
      compact[key] = compactSchema(value, !propertyMap && key === 'properties');
    }
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

function closeDispatchExecutor(ticket?: any) {
  const executor = store.canonicalPreparedDispatchExecutor(ticket);
  if (executor) agentsync.cleanupNativeAgents({ name: executor });
}

function mutationAck(project?: any, result?: any, changed?: any) {
  const ticket = result.ticket;
  const out: any = { ok: !!result.ok, project };
  if (ticket) Object.assign(out, { ref: ticket.ref, status: ticket.status });
  if (!result.ok) {
    for (const key of ['reason', 'claim', 'expectedExecutor', 'derivedEffort', 'claimedEffort', 'max', 'length', 'message', 'failures', 'retryable', 'retry', 'foreignWorkingPaths', 'preserved']) {
      if (result[key] !== undefined) out[key] = result[key];
    }
    return out;
  }
  if (result.advisory) out.advisory = result.advisory;
  return Object.assign(out, changed || {});
}

// A stale integration branch is invisible until the next dispatch builds on it,
// so the closure ack carries every outcome except the two that owed nothing.
const QUIET_INTEGRATION_BRANCH_REASONS = ['remote_mode', 'already_integrated'];

function integrationBranchAck(outcome?: any) {
  if (!outcome || QUIET_INTEGRATION_BRANCH_REASONS.includes(outcome.reason)) return null;
  return {
    integrationBranch: {
      branch: outcome.branch,
      advanced: !!outcome.advanced,
      reason: outcome.reason,
      message: outcome.message,
      ...(outcome.command ? { command: outcome.command } : {}),
    },
  };
}

const OUT_OF_SCOPE_COMMENT_MAX = 16000;

function outOfScopeComment(paths: any[]) {
  const prefix = 'out-of-scope changes present: ';
  const complete = `${prefix}${paths.join(', ')} — widen scope + second commit, or discard`;
  if (complete.length <= OUT_OF_SCOPE_COMMENT_MAX) return complete;
  for (let shown = paths.length - 1; shown >= 0; shown -= 1) {
    const omitted = paths.length - shown;
    const suffix = `… +${omitted} more (run git status in the worktree for the full list)`;
    const body = `${prefix}${paths.slice(0, shown).join(', ')}${shown ? ' ' : ''}${suffix}`;
    if (body.length <= OUT_OF_SCOPE_COMMENT_MAX) return body;
  }
  return `${prefix}… +${paths.length} more (run git status in the worktree for the full list)`;
}

const COMPACT_RESULT_MAX_BYTES = 12 * 1024;
const CONTEXT_PAGE_PAYLOAD_MAX_BYTES = MAX_CONTEXT_PAGE_BYTES - 2048;
const CONTEXT_ROW_EXCERPT_BYTES = 4 * 1024;
const contextSnapshots = new Map<string, { revision: string; value: any; kind: string }>();
const COMPACT_PULSE_BODY_MAX_CHARS = 280;
const PAGED_FULL_DEFAULT_LIMIT = 10;
const PAGE_LIMIT_MAX = 100;
const boundedExcerpt = store.boundedExcerpt;

function compactComment(comment?: any, preserveBody = false) {
  const base: any = {
    id: comment.id,
    at: comment.at,
    by: comment.by,
    kind: comment.kind,
  };
  if (comment.bodyOmitted) return Object.assign(base, { bodyOmitted: true });
  const body = preserveBody
    ? { text: String(comment.body || ''), length: String(comment.body || '').length, truncated: false }
    : boundedExcerpt(comment.body);
  return Object.assign(base, {
    body: body.text,
    bodyLength: body.length,
    bodyTruncated: body.truncated,
  });
}

function preservesFinalReport(ticket?: any, comment?: any) {
  if (!comment) return false;
  if (ticket?.completion?.commentId === comment.id) return true;
  if (ticket?.submission?.commentId === comment.id) return true;
  return ticket?.submission?.by === comment.by && ticket?.submission?.at === comment.at;
}

function compactListRow(ticket?: any) {
  return Object.fromEntries(Object.entries(ticket || {}).filter(([, value]) =>
    value != null && (!Array.isArray(value) || value.length > 0)));
}

const TICKET_BODY_EXCERPT_BYTES = 4 * 1024;

function bodyContextRetrieval(options: {
  tool: string;
  project: string;
  field: string;
  position: string;
  value: unknown;
  selector: Record<string, unknown>;
  reason: 'elided' | 'truncated';
}) {
  return contextRetrieval({
    tool: options.tool,
    project: options.project,
    kind: 'body',
    field: options.field,
    position: options.position,
    revision: contextRevision(options.value),
    reason: options.reason,
    selector: options.selector,
  });
}

function ticketWithContextHandles(project: string, ticket: any) {
  const visible = Object.assign({}, ticket);
  const description = String(ticket.description || '');
  if (utf8ByteLength(description) > TICKET_BODY_EXCERPT_BYTES) {
    const excerpt = utf8Excerpt(description, TICKET_BODY_EXCERPT_BYTES);
    Object.assign(visible, {
      description: excerpt.text,
      descriptionBytes: utf8ByteLength(description),
      descriptionTruncated: true,
      descriptionRetrieval: bodyContextRetrieval({
        tool: 'list', project, field: 'description', position: 'description', value: description,
        selector: { ref: ticket.ref }, reason: 'truncated',
      }),
    });
  }
  if (Array.isArray(ticket.comments)) {
    visible.comments = ticket.comments.map((comment: any) => {
      const body = String(comment.body || '');
      if (utf8ByteLength(body) <= TICKET_BODY_EXCERPT_BYTES) return comment;
      const excerpt = utf8Excerpt(body, TICKET_BODY_EXCERPT_BYTES);
      return Object.assign({}, comment, {
        body: excerpt.text,
        bodyBytes: utf8ByteLength(body),
        bodyTruncated: true,
        retrieval: bodyContextRetrieval({
          tool: 'list', project, field: 'comments.body', position: String(comment.id), value: body,
          selector: { ref: ticket.ref, comment: comment.id }, reason: 'truncated',
        }),
      });
    });
  }
  return visible;
}

function compactCommentWithContext(project: string, ticket: any, comment: any, originalComment: any, preserveBody = false) {
  const compact = compactComment(comment, preserveBody);
  if (!compact.bodyOmitted && !compact.bodyTruncated) return compact;
  const body = String(originalComment?.body || '');
  compact.retrieval = bodyContextRetrieval({
    tool: 'comments', project, field: 'comments.body', position: String(comment.id), value: body,
    selector: { ref: ticket.ref, comment: comment.id }, reason: compact.bodyOmitted ? 'elided' : 'truncated',
  });
  return compact;
}

function listContextArguments(args: any) {
  return Object.fromEntries(['status', 'archived', 'detail', 'all']
    .filter((key) => args[key] !== undefined)
    .map((key) => [key, args[key]]));
}

function listContextRows(project: string, args: any) {
  const status = args.status == null && !args.all ? ['todo', 'doing', 'awaiting-oracle'] : args.status;
  const brief = !args.detail;
  const payload = store.listPayload(project, {
    status,
    archived: args.archived,
    brief,
    cursor: '0',
    limit: Number.MAX_SAFE_INTEGER,
    all: args.all,
  });
  return brief
    ? payload.tickets.map(compactListRow)
    : payload.tickets.map((ticket: any) => ticketWithContextHandles(project, ticket));
}

function listContextRevision(rows: any[]) {
  return contextRevision(rows.map((row: any) => {
    if (!row?.claim || typeof row.claim !== 'object' || !Object.prototype.hasOwnProperty.call(row.claim, 'stale')) return row;
    const claim = Object.fromEntries(Object.entries(row.claim).filter(([key]) => key !== 'stale'));
    return Object.assign({}, row, { claim });
  }));
}

function listRowsContextRetrieval(project: string, args: any, position: number) {
  const sourceArguments = listContextArguments(args);
  const rows = listContextRows(project, sourceArguments);
  return contextRetrieval({
    tool: 'list', project, kind: 'rows', field: 'tickets', position,
    revision: listContextRevision(rows), reason: 'budget', arguments: sourceArguments,
  }, position);
}

function snapshotRowsContextRetrieval(tool: string, project: string, field: string, rows: any[], position: number) {
  return snapshotContextRetrieval({
    tool,
    project,
    kind: 'rows',
    field,
    position,
    value: rows,
    reason: 'budget',
    cursor: position,
  });
}

function frozenSnapshotEvidence(selector: any, snapshot?: any) {
  const body = String(snapshot?.body || '');
  return {
    snapshotRevision: snapshot == null ? null : Number(snapshot.revision) || 1,
    sha256: snapshot == null ? null : crypto.createHash('sha256').update(body, 'utf8').digest('hex'),
    totalBytes: snapshot == null ? null : utf8ByteLength(body),
    expectedSnapshotRevision: Number(selector.snapshotRevision) || 1,
    expectedSha256: String(selector.sha256 || ''),
    expectedTotalBytes: Number(selector.totalBytes) || 0,
  };
}

function staleFrozenSnapshotError(selector: any, snapshot?: any) {
  return `context_page: stale dispatch snapshot handle; frozen contract changed. Evidence: ${JSON.stringify(frozenSnapshotEvidence(selector, snapshot))}. Rerun the token-gated briefing and use its returned continuation verbatim.`;
}

function frozenStoryContractBody(source: any, ticket: any) {
  const snapshot = ticket?.dispatch?.storyContract;
  if (source.selector.frozenAbsent === true) {
    if (snapshot != null) throw new Error(staleFrozenSnapshotError(source.selector, snapshot));
    return '';
  }
  if (!snapshot || typeof snapshot !== 'object') {
    throw new Error(staleFrozenSnapshotError(source.selector, null));
  }
  const body = String(snapshot.body || '');
  const revision = Number(snapshot.revision) || 1;
  const hash = crypto.createHash('sha256').update(body, 'utf8').digest('hex');
  const totalBytes = utf8ByteLength(body);
  if (
    Number(source.selector.snapshotRevision) !== revision
    || String(source.selector.sha256 || '') !== hash
    || Number(source.selector.totalBytes) !== totalBytes
  ) {
    throw new Error(staleFrozenSnapshotError(source.selector, snapshot));
  }
  return body;
}

function resolvedContextBody(source: any) {
  const ticket = store.getTicket(source.project, source.selector.ref);
  if (!ticket) throw new Error(`context_page: source ticket "${source.selector.ref}" no longer exists.`);
  if (source.tool === 'dispatch' && source.field === 'dispatch.storyContract' && source.position === 'storyContract') {
    return frozenStoryContractBody(source, ticket);
  }
  if (source.tool === 'briefing' && source.field === 'task-and-scope' && source.position === 'task-and-scope') {
    return agentsync.taskAndScopeBody(ticket, source.project);
  }
  if (source.field === 'description' && source.position === 'description') return String(ticket.description || '');
  if (source.field === 'comments.body') {
    const comment = (Array.isArray(ticket.comments) ? ticket.comments : [])
      .find((entry: any) => entry.id === source.selector.comment && entry.id === source.position);
    if (!comment) throw new Error(`context_page: source comment "${source.selector.comment}" no longer exists.`);
    return String(comment.body || '');
  }
  throw new Error(`context_page: unsupported ${source.tool} field "${source.field}".`);
}

function resolvedContextRows(source: any) {
  const ticket = store.getTicket(source.project, source.selector.ref);
  if (!ticket) throw new Error(`context_page: source ticket "${source.selector.ref}" no longer exists.`);
  if (source.tool === 'briefing' && source.field === 'rejected-submissions' && source.position === 'rejected-submissions') {
    return agentsync.rejectedSubmissionRows(ticket);
  }
  throw new Error(`context_page: unsupported ${source.tool} rows field "${source.field}".`);
}

function assertCurrentContextRevision(source: any, currentRevision: string, expectedRevision: unknown) {
  if (String(expectedRevision || '') !== source.revision) {
    throw new Error(`context_page: expectedRevision does not match the ${source.tool} handle revision.`);
  }
  if (currentRevision !== source.revision) {
    throw new Error(`context_page: stale ${source.tool} handle; rerun ${source.tool} and use its new retrieval handle.`);
  }
}

function snapshotContextRetrieval(options: {
  tool: string;
  project: string;
  kind: 'body' | 'rows';
  field: string;
  position: string | number;
  value: any;
  reason: string;
  cursor?: number;
}) {
  const revision = contextRevision(options.value);
  const key = crypto.randomUUID();
  contextSnapshots.set(key, { revision, value: options.value, kind: options.kind });
  return contextRetrieval({
    tool: options.tool,
    project: options.project,
    kind: options.kind,
    field: options.field,
    position: options.position,
    revision,
    reason: options.reason,
    selector: { contextSnapshot: key },
  }, options.cursor || 0);
}

function contextSnapshot(source: any) {
  const key = String(source.selector.contextSnapshot || '');
  const snapshot = contextSnapshots.get(key);
  if (!snapshot || snapshot.kind !== source.kind || snapshot.revision !== source.revision) {
    throw new Error(`context_page: stale ${source.tool} continuation; rerun ${source.tool} and use its new retrieval handle.`);
  }
  return snapshot.value;
}

function contextPageContinuation(source: any, handle: unknown, cursor: string | null) {
  if (cursor === null) return null;
  return {
    handle: String(handle),
    cursor,
    expectedRevision: source.revision,
  };
}

function resolveContextPage(args: any) {
  const source = decodeContextHandle(args.handle);
  if (source.selector.contextSnapshot) {
    const value = contextSnapshot(source);
    assertCurrentContextRevision(source, contextRevision(value), args.expectedRevision);
    const position = decodeContextCursor(String(args.handle), args.cursor);
    const limit = Math.min(contextPageByteLimit(args.limit), CONTEXT_PAGE_PAYLOAD_MAX_BYTES);
    if (source.kind === 'body') {
      const page = utf8Slice(value, position, limit);
      return {
        source: source.tool, field: source.field, position: source.position, reason: source.reason,
        revision: source.revision, body: page.body, cursor: args.cursor, pageBytes: page.pageBytes,
        totalBytes: page.totalBytes,
        nextCursor: page.nextPosition == null ? null : contextCursor(String(args.handle), page.nextPosition),
        continuation: contextPageContinuation(source, args.handle, page.nextPosition == null ? null : contextCursor(String(args.handle), page.nextPosition)),
        complete: page.nextPosition == null,
      };
    }
    const page = rowsWithinByteLimit(value, position, limit);
    return {
      source: source.tool, field: source.field, position: source.position, reason: source.reason,
      revision: source.revision, rows: page.rows, cursor: args.cursor, pageBytes: page.pageBytes,
      totalRows: page.totalRows, returned: page.rows.length,
      nextCursor: page.nextPosition == null ? null : contextCursor(String(args.handle), page.nextPosition),
        continuation: contextPageContinuation(source, args.handle, page.nextPosition == null ? null : contextCursor(String(args.handle), page.nextPosition)),
      complete: page.nextPosition == null,
    };
  }
  if (!['list', 'comments', 'dispatch', 'briefing'].includes(source.tool)) {
    throw new Error(`context_page: handle belongs to unsupported source tool "${source.tool}".`);
  }
  const position = decodeContextCursor(String(args.handle), args.cursor);
  const limit = Math.min(contextPageByteLimit(args.limit), CONTEXT_PAGE_PAYLOAD_MAX_BYTES);
  if (source.kind === 'body') {
    const body = resolvedContextBody(source);
    assertCurrentContextRevision(source, contextRevision(body), args.expectedRevision);
    const page = utf8Slice(body, position, limit);
    return {
      source: source.tool,
      field: source.field,
      position: source.position,
      reason: source.reason,
      revision: source.revision,
      body: page.body,
      cursor: args.cursor,
      pageBytes: page.pageBytes,
      totalBytes: page.totalBytes,
      nextCursor: page.nextPosition == null ? null : contextCursor(String(args.handle), page.nextPosition),
        continuation: contextPageContinuation(source, args.handle, page.nextPosition == null ? null : contextCursor(String(args.handle), page.nextPosition)),
      complete: page.nextPosition == null,
    };
  }
  if (source.kind === 'rows' && source.tool === 'briefing' && source.field === 'rejected-submissions') {
    const rows = resolvedContextRows(source);
    assertCurrentContextRevision(source, contextRevision(rows), args.expectedRevision);
    const page = rowsWithinByteLimit(rows, position, limit);
    return {
      source: source.tool,
      field: source.field,
      position: source.position,
      reason: source.reason,
      revision: source.revision,
      rows: page.rows,
      cursor: args.cursor,
      pageBytes: page.pageBytes,
      totalRows: page.totalRows,
      returned: page.rows.length,
      nextCursor: page.nextPosition == null ? null : contextCursor(String(args.handle), page.nextPosition),
      continuation: contextPageContinuation(source, args.handle, page.nextPosition == null ? null : contextCursor(String(args.handle), page.nextPosition)),
      complete: page.nextPosition == null,
    };
  }
  if (source.tool !== 'list' || source.field !== 'tickets') {
    throw new Error(`context_page: handle belongs to the wrong tool for ${source.kind} pages.`);
  }
  const rows = listContextRows(source.project, source.arguments);
  assertCurrentContextRevision(source, listContextRevision(rows), args.expectedRevision);
  const page = rowsWithinByteLimit(rows, position, limit);
  return {
    source: source.tool,
    field: source.field,
    position: source.position,
    reason: source.reason,
    revision: source.revision,
    rows: page.rows,
    cursor: args.cursor,
    pageBytes: page.pageBytes,
    totalRows: page.totalRows,
    returned: page.rows.length,
    nextCursor: page.nextPosition == null ? null : contextCursor(String(args.handle), page.nextPosition),
        continuation: contextPageContinuation(source, args.handle, page.nextPosition == null ? null : contextCursor(String(args.handle), page.nextPosition)),
    complete: page.nextPosition == null,
  };
}

function contextRowProjection(value: any, tool: string, project: string, field: string, position: string): unknown {
  if (typeof value === 'string') {
    if (utf8ByteLength(value) <= CONTEXT_ROW_EXCERPT_BYTES) return value;
    const excerpt = utf8Excerpt(value, CONTEXT_ROW_EXCERPT_BYTES);
    return {
      text: excerpt.text,
      totalBytes: utf8ByteLength(value),
      truncated: true,
      retrieval: snapshotContextRetrieval({ tool, project, kind: 'body', field, position, value, reason: 'truncated' }),
    };
  }
  if (Array.isArray(value)) {
    const entries: unknown[] = value.map((entry: any, index: number) => contextRowProjection(entry, tool, project, `${field}[]`, `${position}.${index}`));
    if (utf8ByteLength(JSON.stringify(entries)) <= CONTEXT_ROW_EXCERPT_BYTES) return entries;
    return {
      totalItems: value.length,
      omittedItems: value.length,
      retrieval: snapshotContextRetrieval({ tool, project, kind: 'rows', field, position, value: entries, reason: 'budget' }),
    };
  }
  if (!value || typeof value !== 'object') return value;
  const visible: any = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string' && utf8ByteLength(entry) > CONTEXT_ROW_EXCERPT_BYTES) {
      const excerpt = utf8Excerpt(entry, CONTEXT_ROW_EXCERPT_BYTES);
      visible[key] = excerpt.text;
      visible[`${key}Bytes`] = utf8ByteLength(entry);
      visible[`${key}Truncated`] = true;
      visible[`${key}Retrieval`] = snapshotContextRetrieval({
        tool, project, kind: 'body', field: `${field}.${key}`, position: `${position}.${key}`, value: entry, reason: 'truncated',
      });
    } else {
      visible[key] = entry;
    }
  }
  return visible;
}

function mcpPayloadBytes(value: any) {
  return utf8ByteLength(JSON.stringify(value, null, 2));
}

function payloadFieldExcerptBudget(payload: any, field: string) {
  const remaining = Object.assign({}, payload);
  delete remaining[field];
  return Math.max(256, COMPACT_RESULT_MAX_BYTES - 2048 - mcpPayloadBytes(remaining));
}

function boundedReadPayload(tool: string, payload: any) {
  if (!payload || typeof payload !== 'object' || mcpPayloadBytes(payload) <= COMPACT_RESULT_MAX_BYTES) return payload;
  const project = String(payload.project || '<global>');
  const visible: any = Object.assign({}, payload);
  const fields = Object.keys(payload).sort((left, right) => {
    const arrayDifference = Number(Array.isArray(payload[left])) - Number(Array.isArray(payload[right]));
    return arrayDifference || utf8ByteLength(JSON.stringify(payload[right])) - utf8ByteLength(JSON.stringify(payload[left]));
  });
  for (const field of fields) {
    if (mcpPayloadBytes(visible) <= COMPACT_RESULT_MAX_BYTES) break;
    const value = payload[field];
    if (Array.isArray(value)) {
      const rows = value.map((row, index) => contextRowProjection(row, tool, project, field, String(index)));
      const retained: any[] = [];
      for (const row of rows) {
        if (mcpPayloadBytes(Object.assign({}, visible, { [field]: [...retained, row] })) > COMPACT_RESULT_MAX_BYTES - 2048) break;
        retained.push(row);
      }
      visible[field] = retained;
      visible[`${field}Total`] = value.length;
      visible[`${field}Returned`] = retained.length;
      visible[`${field}Omitted`] = Math.max(0, value.length - retained.length);
      if (retained.length < rows.length) {
        visible[`${field}Retrieval`] = snapshotContextRetrieval({
          tool, project, kind: 'rows', field, position: retained.length, value: rows, reason: 'budget', cursor: retained.length,
        });
      }
      continue;
    }
    if (typeof value === 'string') {
      const excerpt = utf8Excerpt(value, payloadFieldExcerptBudget(visible, field));
      visible[field] = excerpt.text;
      visible[`${field}Bytes`] = utf8ByteLength(value);
      visible[`${field}Truncated`] = true;
      visible[`${field}Retrieval`] = snapshotContextRetrieval({ tool, project, kind: 'body', field, position: field, value, reason: 'truncated' });
      continue;
    }
    if (value && typeof value === 'object') {
      const serialized = JSON.stringify(value);
      const excerpt = utf8Excerpt(serialized, payloadFieldExcerptBudget(visible, field));
      visible[field] = { excerpt: excerpt.text, totalBytes: utf8ByteLength(serialized), truncated: true };
      visible[`${field}Retrieval`] = snapshotContextRetrieval({ tool, project, kind: 'body', field, position: field, value: serialized, reason: 'truncated' });
    }
  }
  if (mcpPayloadBytes(visible) > COMPACT_RESULT_MAX_BYTES) {
    throw new Error(`${tool}: result exceeds the ${COMPACT_RESULT_MAX_BYTES}-byte MCP ceiling after projection (${mcpPayloadBytes(visible)} bytes).`);
  }
  return visible;
}

function compactCategoryBody(category: any, field: string, project: string) {
  const value = String(category[field] || '');
  if (utf8ByteLength(value) <= CONTEXT_ROW_EXCERPT_BYTES) return { [field]: value };
  const excerpt = utf8Excerpt(value, CONTEXT_ROW_EXCERPT_BYTES);
  return {
    [field]: excerpt.text,
    [`${field}Bytes`]: utf8ByteLength(value),
    [`${field}Truncated`]: true,
    [`${field}Retrieval`]: snapshotContextRetrieval({
      tool: 'category_list',
      project,
      kind: 'body',
      field: `categories.${field}`,
      position: String(category.id),
      value,
      reason: 'truncated',
    }),
  };
}

function categoryListEntry(category?: any, localRow?: any, ticketCount?: any, full?: any, project = '<global>') {
  if (!full) {
    const description = boundedExcerpt(String(category.description || '').replace(/\s+/g, ' ').trim());
    return {
      id: category.id,
      name: category.name,
      route: category.route ? { model: category.route.model, effort: category.route.effort } : null,
      description: description.text,
      descriptionLength: description.length,
      descriptionTruncated: description.truncated,
    };
  }
  return Object.assign({}, category, compactCategoryBody(category, 'description', project), compactCategoryBody(category, 'contract', project), {
    origin: localRow ? (localRow.kind === 'ADD' ? 'project' : category.linkState) : 'global',
    localRow: localRow ? { id: localRow.id, kind: localRow.kind } : null,
    ticketCount,
  });
}

function pageArguments(args: any, action: string) {
  let cursor = 0;
  if (args.cursor != null) {
    const raw = String(args.cursor);
    if (!/^(0|[1-9]\d*)$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
      throw new Error(`${action}: cursor must be a non-negative integer string.`);
    }
    cursor = Number(raw);
  }
  let limit: number | null = null;
  if (args.limit != null) {
    limit = Number(args.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_LIMIT_MAX) {
      throw new Error(`${action}: limit must be an integer from 1 to ${PAGE_LIMIT_MAX}.`);
    }
  }
  return { cursor, limit };
}

function pageRows(rows: any[], args: any, action: string, buildPayload: any, maxBytes: number | null) {
  const { cursor, limit } = pageArguments(args, action);
  if (cursor > rows.length) throw new Error(`${action}: cursor ${cursor} is past the ${rows.length}-row result.`);
  const maxEnd = Math.min(rows.length, cursor + (limit || rows.length));
  let end = cursor;
  while (end < maxEnd) {
    const candidateEnd = end + 1;
    const candidate = rows.slice(cursor, candidateEnd);
    const nextCursor = candidateEnd < rows.length ? String(candidateEnd) : null;
    const payload = buildPayload(candidate, rows.length, nextCursor);
    if (maxBytes && Buffer.byteLength(JSON.stringify(payload, null, 2), 'utf8') > maxBytes) break;
    end = candidateEnd;
  }
  if (end === cursor && cursor < rows.length) {
    throw new Error(`${action}: one compact row exceeds the ${maxBytes}-byte result ceiling; use full:true.`);
  }
  const page = rows.slice(cursor, end);
  return buildPayload(page, rows.length, end < rows.length ? String(end) : null);
}

function pagedPayload(rows: any[], args: any, action: string, buildPayload: any, full: boolean) {
  return pageRows(rows, args, action, buildPayload, COMPACT_RESULT_MAX_BYTES - 1024);
}

function compactPulse(pulse?: any) {
  const lastComment = pulse.lastComment && Object.assign({}, pulse.lastComment, {
    body: boundedExcerpt(pulse.lastComment.body, COMPACT_PULSE_BODY_MAX_CHARS).text,
  });
  return {
    ref: pulse.ref,
    status: pulse.status,
    claim: pulse.claim,
    working: pulse.working,
    lastActivityAt: pulse.lastActivityAt,
    lastComment,
    checkpoint: pulse.checkpoint,
    ...(pulse.oracle ? { oracle: pulse.oracle } : {}),
    ...(Array.isArray(pulse.warnings) && pulse.warnings.length ? { warnings: pulse.warnings } : {}),
    dispatch: pulse.dispatch && {
      state: pulse.dispatch.state,
      executor: pulse.dispatch.executor,
      agentName: pulse.dispatch.agentName,
      outcome: pulse.dispatch.outcome,
    },
    ...(pulse.scope ? { scope: compactScope(pulse.scope) } : {}),
  };
}

// "Did my approval land" is the question asked right after every ruling, so the
// scope in force belongs in the default read. Only the enforced set is carried
// when it already matches the declared one, which is the ordinary case.
function compactScope(scope?: any) {
  const enforced = Array.isArray(scope?.enforced) ? scope.enforced : null;
  const declared = Array.isArray(scope?.declared) ? scope.declared : [];
  const same = enforced && enforced.length === declared.length
    && enforced.every((file: any, index: number) => file === declared[index]);
  return {
    files: enforced || declared,
    ...(enforced && !same ? { declared } : {}),
    ...(scope?.request ? { request: scope.request } : {}),
    ...(scope?.lastRuling ? { lastRuling: scope.lastRuling } : {}),
  };
}

function requiredText(args?: any, key?: any, action?: any) {
  const value = args && args[key] != null ? String(args[key]).trim() : '';
  if (!value) throw new Error(`${action}: "${key}" is required.`);
  return value;
}

function requiredFinalReport(args?: any, action?: any) {
  const body = args && args.body != null ? String(args.body) : '';
  if (!body.trim()) {
    throw new Error(`${action}: "body" is required — the completion comment carries the full final report (changed paths, verification evidence, and anything skipped).`);
  }
  return body;
}

function boundedSubmissionText(value?: any, maxChars = 600) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 16)}… [${text.length} chars]`;
}

function preserveRejectedSubmission(options?: any) {
  const { slug, ticket, by, root, commit, gitRef, verify, reason, message, remedy, source = 'mcp' } = options;
  const validationMessage = boundedSubmissionText(message);
  const failure = `${reason}${validationMessage ? `: ${validationMessage}` : ''}`;
  const archived = store.recordSubmissionRejection(slug, ticket.ref, {
    by,
    review: validationMessage || failure,
    reason,
    commit,
    root,
    source,
  });
  if (!archived.ok) {
    const preservationFailure = `${archived.reason}${archived.message ? `: ${boundedSubmissionText(archived.message)}` : ''}`;
    return {
      ok: false,
      ticket: archived.ticket || ticket,
      reason,
      message: `submit: refused ${ticket.ref}; ${failure}. Could not preserve ${commit}: ${preservationFailure}. The claim remains active. Remedy: ${remedy}`,
    };
  }
  const preserved = { commit: archived.rejected.commit, gitRef: archived.rejected.quarantineRef };

  let checkpoint: any;
  try {
    checkpoint = store.checkpointTicket(slug, ticket.ref, by, {
      commit: preserved.commit,
      worktree: root,
      verify: verify.slice(0, 4000),
      ttlMinutes: 24 * 60,
      kind: 'submission_rejected',
      gitRef: preserved.gitRef,
      failure: { reason, message: validationMessage },
      commentBody: `Submission validation refused ${ticket.ref}: ${failure}\nPreserved: ${preserved.commit} at ${preserved.gitRef}\nClaim retained with a recovery checkpoint.\nRemedy: ${remedy}`,
      source,
    });
  } catch (error: any) {
    checkpoint = { ok: false, reason: 'checkpoint_error', message: (error && error.message) || String(error) };
  }
  if (checkpoint && checkpoint.ok) {
    return {
      ok: false,
      ticket: checkpoint.ticket,
      reason,
      message: `submit: refused ${ticket.ref}; ${failure}. Preserved ${preserved.commit} at ${preserved.gitRef}; the claim and recovery checkpoint remain active. Remedy: ${remedy}`,
      preserved: { commit: preserved.commit, gitRef: preserved.gitRef, checkpoint: checkpoint.checkpoint },
    };
  }

  const checkpointFailure = `${checkpoint?.reason || 'checkpoint_failed'}${checkpoint?.message ? `: ${boundedSubmissionText(checkpoint.message)}` : ''}`;
  return {
    ok: false,
    ticket: store.getTicket(slug, ticket.ref) || ticket,
    reason,
    message: `submit: refused ${ticket.ref}; ${failure}. Preserved ${preserved.commit} at ${preserved.gitRef}, but the recovery checkpoint failed: ${checkpointFailure}. The claim remains active. Remedy: ${remedy}`,
    preserved: { commit: preserved.commit, gitRef: preserved.gitRef },
  };
}

function requiredReleaseReason(args?: any) {
  const reason = args && args.reason != null ? String(args.reason).trim() : '';
  if (reason) return reason;
  const oracle = args && args.oracle != null ? String(args.oracle).trim() : '';
  if (oracle) return oracle;
  throw new Error('release: "reason" is required — explain why the claim is being released. An oracle ask may stand in as the reason.');
}

function worktreeRoot(worktree?: any, action?: any) {
  const supplied = requiredText({ worktree }, 'worktree', action);
  if (!path.isAbsolute(supplied)) throw new Error(`${action}: "worktree" must be an absolute path.`);
  let stat;
  try { stat = fs.statSync(supplied); } catch (_) { throw new Error(`${action}: worktree does not exist: ${supplied}`); }
  if (!stat.isDirectory()) throw new Error(`${action}: worktree must be a directory: ${supplied}`);
  let root;
  try { root = commitScope.repoRoot(supplied); } catch (_) { throw new Error(`${action}: worktree is not inside a git work tree: ${supplied}`); }
  // git answers with the canonical spelling while a caller may hold an 8.3 alias of
  // the same directory (C:\Users\RUNNER~1\... on the hosted Windows runner), so both
  // sides have to be canonicalized or the two names for one directory disagree.
  if (worktrees.canonicalPath(supplied) !== worktrees.canonicalPath(root)) {
    throw new Error(`${action}: worktree must name the git worktree root: ${supplied}`);
  }
  return root;
}

function verifyEmbedsWorktreeRoot(verify?: any, root?: any) {
  if (typeof verify !== 'string' || !verify || !root) return false;
  const normalize = (value: any) => String(value).replace(/[\\/]+/g, '/').replace(/\/+$/, '');
  const worktree = normalize(path.resolve(root));
  const command = normalize(verify);
  const caseInsensitive = /^[a-z]:\//i.test(worktree);
  const comparableRoot = caseInsensitive ? worktree.toLowerCase() : worktree;
  const comparableCommand = caseInsensitive ? command.toLowerCase() : command;
  let offset = comparableCommand.indexOf(comparableRoot);
  while (offset !== -1) {
    const next = comparableCommand.charAt(offset + comparableRoot.length);
    if (!next || next === '/' || !/[a-z0-9._-]/i.test(next)) return true;
    offset = comparableCommand.indexOf(comparableRoot, offset + comparableRoot.length);
  }
  return false;
}

function withoutCategories(payload?: any) {
  const { categories, ...trimmed } = payload;
  return trimmed;
}

module.exports = {
  path,
  fs,
  store,
  work,
  worktrees,
  agentsync,
  commitScope,
  publish,
  execNames,
  claimRefusalMessage,
  assertSidequestInstall,
  assertDispatchTransport,
  resolveProject,
  runtimeSessionId,
  sessionOf,
  controlPlaneIdentity,
  requireDispatchSession,
  workflowRecipe,
  requireBy,
  requireKnownModelFilter,
  requireKnownModel,
  pathList,
  provenNoOpCloseout,
  PROJECT_PROP,
  FILES_PROP,
  LABELS_PROP,
  CONTRACT_PROP,
  MODEL_FILTER_PROP,
  TOOL_DESCRIPTION_OVERRIDES,
  conciseDescription,
  validateStoryId,
  compactSchema,
  LIST_CHAR_BUDGET,
  closeDispatchExecutor,
  mutationAck,
  integrationBranchAck,
  outOfScopeComment,
  COMPACT_RESULT_MAX_BYTES,
  COMPACT_PULSE_BODY_MAX_CHARS,
  PAGED_FULL_DEFAULT_LIMIT,
  PAGE_LIMIT_MAX,
  boundedExcerpt,
  compactComment,
  compactCommentWithContext,
  preservesFinalReport,
  compactListRow,
  ticketWithContextHandles,
  listRowsContextRetrieval,
  snapshotRowsContextRetrieval,
  snapshotContextRetrieval,
  resolveContextPage,
  boundedReadPayload,
  MAX_CONTEXT_PAGE_BYTES,
  categoryListEntry,
  pageArguments,
  pageRows,
  pagedPayload,
  compactPulse,
  requiredText,
  requiredFinalReport,
  boundedSubmissionText,
  preserveRejectedSubmission,
  requiredReleaseReason,
  worktreeRoot,
  verifyEmbedsWorktreeRoot,
  withoutCategories,
  CATEGORY_TAXONOMY_WARNING,
};
