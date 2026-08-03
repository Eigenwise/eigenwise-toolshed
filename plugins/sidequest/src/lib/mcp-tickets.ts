'use strict';

const {
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
  requireDispatchSession,
  workflowRecipe,
  requireBy,
  effortDrift,
  executorDrift,
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
  state,
} = require('./mcp-shared');

type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: any;
  handler: (args: any) => any | Promise<any>;
};

const tools: ToolDefinition[] = [
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
        highStakes: { type: 'boolean' },
        labels: LABELS_PROP,
        files: FILES_PROP,
        produces: CONTRACT_PROP('produces'),
        changes: CONTRACT_PROP('changes'),
        consumes: CONTRACT_PROP('consumes'),
        contractWaiver: { type: 'boolean', description: 'Explicitly reviewed waiver for contract-edge wave sequencing.' },
        readonly: { type: 'boolean', description: 'Closeout override.' },
        anchors: { type: 'string', maxLength: store.EXECUTOR_ANCHORS_MAX, description: 'Executor anchors, verbatim in the task prompt.' },
        verify: { type: 'string', maxLength: store.EXECUTOR_VERIFY_MAX, description: 'Exact verify command, verbatim in the task prompt.' },
        storyId: { type: 'string', pattern: '^US-\\d+$', description: 'A story ref (US-n) to file this ticket into.' },
        complexity: { type: 'integer', minimum: 1, maximum: 10, description: 'Legacy score. Requires why (min 20 chars).' },
        why: { type: 'string', description: 'Motivation for the complexity score (min 20 chars).' },
        category: { type: 'string', description: 'Enabled category id from category_list.' },
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
        const valid = store.getCategories({ project: slug, includeDisabled: false }).map((entry: any) => entry.id);
        if (!valid.includes(category)) throw new Error(`add: unknown category "${args.category}" — valid: ${valid.join(', ')}`);
      }
      const complexity = store.coerceComplexity(args.complexity);
      if (!category && complexity == null && !args.unclassified) throw new Error('add: pass category, legacy complexity + why, or unclassified:true.');
      if (complexity != null && (!args.why || String(args.why).trim().length < 20)) throw new Error('add: why is required with complexity (min 20 chars).');
      if (args.storyId !== undefined) validateStoryId(args.storyId);
      const created = store.createTicket(slug, {
        title: args.title,
        description: args.description || '',
        priority: args.priority,
        status: args.status,
        highStakes: args.highStakes,
        labels: args.labels,
        files: args.files,
        contracts: { produces: args.produces, changes: args.changes, consumes: args.consumes },
        contractWaiver: args.contractWaiver,
        readonly: args.readonly,
        executorAnchors: args.anchors,
        executorVerify: args.verify,
        storyId: args.storyId,
        complexity: args.complexity,
        complexityWhy: args.why,
        category,
        source: 'mcp',
      });
      const ticket = store.getTicket(slug, created.ref) || created;
      const warnings = store.ticketReferenceWarnings(slug, ticket.title, ticket.description);
      warnings.push(...store.ticketCategoryWarnings(ticket));
      warnings.push(...store.ticketPlanningWarnings(ticket, meta.path));
      if (category && !state.categoryListServed) warnings.push(CATEGORY_TAXONOMY_WARNING);
      return mutationAck(slug, { ok: true, ticket }, warnings.length ? { warnings } : null);
    },
  },
  {
    name: 'update',
    description: 'Update: by scopes. Any omitted field is left unchanged. Re-scoring needs both complexity and a fresh why. The claiming executor must request scope instead. Set storyId to "none" to detach. model/effort are not accepted. Deletion is not a status; use the permanent remove tool instead.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        project: PROJECT_PROP,
        title: { type: 'string' },
        description: { type: 'string' },
        priority: { type: 'string', enum: store.VALID_PRIORITY },
        status: { type: 'string', enum: store.VALID_STATUS },
        highStakes: { type: 'boolean' },
        labels: LABELS_PROP,
        files: FILES_PROP,
        by: { type: 'string', description: 'Control-plane identity when approving an active claim scope request; it must differ from the claiming executor.' },
        produces: CONTRACT_PROP('produces'),
        changes: CONTRACT_PROP('changes'),
        consumes: CONTRACT_PROP('consumes'),
        contractWaiver: { type: 'boolean', description: 'Explicitly reviewed waiver for contract-edge wave sequencing.' },
        readonly: { type: 'boolean', description: 'Closeout override.' },
        anchors: { type: 'string', maxLength: store.EXECUTOR_ANCHORS_MAX, description: 'Executor anchors, verbatim in the task prompt.' },
        verify: { type: 'string', maxLength: store.EXECUTOR_VERIFY_MAX, description: 'Exact verify command, verbatim in the task prompt.' },
        storyId: { anyOf: [{ type: 'string', pattern: '^US-\\d+$' }, { const: 'none' }] },
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
      const patch: any = { source: 'mcp', sessionId: sessionOf(args) };
      if (args.by !== undefined) patch.by = args.by;
      for (const k of ['title', 'description', 'priority', 'status', 'highStakes', 'labels', 'files', 'complexity']) {
        if (args[k] !== undefined) patch[k] = args[k];
      }
      if (args.produces !== undefined || args.changes !== undefined || args.consumes !== undefined) {
        const existing = store.normalizeContracts((store.getTicket(slug, args.ref) || {}).contracts);
        patch.contracts = {
          produces: args.produces === undefined ? existing.produces : args.produces,
          changes: args.changes === undefined ? existing.changes : args.changes,
          consumes: args.consumes === undefined ? existing.consumes : args.consumes,
        };
      }
      if (args.contractWaiver !== undefined) patch.contractWaiver = args.contractWaiver;
      if (args.readonly !== undefined) patch.readonly = args.readonly;
      if (args.anchors !== undefined) patch.executorAnchors = args.anchors;
      if (args.verify !== undefined) patch.executorVerify = args.verify;
      if (args.storyId !== undefined) {
        validateStoryId(args.storyId, true);
        patch.storyId = args.storyId;
      }
      if (args.category !== undefined) {
        if (args.category === 'none' || args.category === null) patch.category = null;
        else {
          const category = String(args.category).trim().toLowerCase();
          const valid = store.getCategories({ project: slug, includeDisabled: false }).map((entry: any) => entry.id);
          if (!valid.includes(category)) throw new Error(`update: unknown category "${args.category}" — valid: ${valid.join(', ')}`);
          patch.category = category;
        }
      }
      if (args.why !== undefined) patch.complexityWhy = args.why;
      const updated = store.updateTicket(slug, args.ref, patch);
      if (!updated) throw new Error(`update: no ticket "${args.ref}" on ${meta.name}.`);
      const t = store.getTicket(slug, updated.ref) || updated;
      const warnings = store.ticketReferenceWarnings(slug, patch.title, patch.description);
      warnings.push(...store.ticketPlanningWarnings(t, meta.path));
      if (patch.files !== undefined) {
        const scopeWarning = store.pendingScopeApprovalWarning(t);
        if (scopeWarning) warnings.push(scopeWarning);
      }
      if (patch.category && !state.categoryListServed) warnings.push(CATEGORY_TAXONOMY_WARNING);
      return mutationAck(slug, { ok: true, ticket: t }, warnings.length ? { warnings } : null);
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
      if (ticket.claim && ticket.claim.by && !store.claimReclaimable(ticket) && !args.force) {
        return { ok: false, reason: 'claimed', ref: ticket.ref, claim: ticket.claim, message: `${ticket.ref} is live-claimed by ${ticket.claim.by}; pass force:true to permanently remove it.` };
      }
      const ref = ticket.ref;
      if (!store.deleteTicket(slug, ticket.id)) {
        throw new Error(`remove: could not delete "${ticket.ref}" from ${meta.name}.`);
      }
      return { ok: true, ref };
    },
  },
  {
    name: 'archive',
    description: 'Archive one ticket by ref, or every done ticket with done:true.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        project: PROJECT_PROP,
        done: { type: 'boolean', description: 'Archive every done ticket on the board.' },
      },
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      if (args.done) {
        const result = store.archiveAllDone(slug, { source: 'mcp' });
        return { ok: result.ok, archived: result.archived.length };
      }
      const ref = requiredText(args, 'ref', 'archive');
      const result = store.archiveTicket(slug, ref, { source: 'mcp' });
      if (!result.ok) throw new Error(`archive: no ticket "${ref}" on ${meta.name}.`);
      return mutationAck(slug, result);
    },
  },
  {
    name: 'unarchive',
    description: 'Restore an archived ticket by ref.',
    inputSchema: {
      type: 'object',
      properties: { ref: { type: 'string' }, project: PROJECT_PROP },
      required: ['ref'],
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const result = store.unarchiveTicket(slug, args.ref, { source: 'mcp' });
      if (!result.ok) throw new Error(`unarchive: no ticket "${args.ref}" on ${meta.name}.`);
      return mutationAck(slug, result);
    },
  },
];

module.exports = { tools };
