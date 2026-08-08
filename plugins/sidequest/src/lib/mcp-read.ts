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
  compactListRow,
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

function readySummary(payload?: any) {
  const tickets = payload.tickets.map((ticket: any) => ({ ref: ticket.ref, title: ticket.title }));
  return {
    count: tickets.length,
    tickets,
    waves: payload.waves,
    waveDependencies: payload.waveDependencies,
  };
}

const tools: ToolDefinition[] = [
  {
    name: 'list',
    description: 'For liveness/progress polling use changes/pulse, not this. List active tickets (todo + doing) by default, paged with compact rows. Pass status:"done" for completed tickets or all:true for every non-archived status. Follow nextCursor until null. detail:true is audit-only.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_PROP,
        ref: { type: 'string', description: 'Return this one ticket in full.' },
        status: { type: 'string', enum: ['todo', 'doing', 'done'] },
        archived: { type: 'boolean' },
        detail: { type: 'boolean', description: 'Audit only: full bodies and comment threads. Orchestration uses default brief rows; liveness uses changes/pulse.' },
        cursor: { type: 'string', description: 'nextCursor from the prior page.' },
        limit: { type: 'integer', minimum: 0, description: 'Exact page size.' },
        all: { type: 'boolean', description: 'Include every non-archived status, including done.' },
      },
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      if (args.ref !== undefined) {
        const ticket = store.getTicket(slug, args.ref);
        if (!ticket) throw new Error(`list: no ticket "${args.ref}" in ${meta.name}`);
        return { project: slug, projectName: meta.name, ticket };
      }
      // MCP board reads are routine orchestration reads, so omit completed work
      // and ticket bodies unless the caller explicitly asks for either.
      const status = args.status == null && !args.all ? ['todo', 'doing'] : args.status;
      const brief = !args.detail;
      // Bound the DEFAULT page so a few-hundred-ticket column can't overflow the
      // tool-result token ceiling. A caller that passes limit or all opts out of
      // the auto budget and takes responsibility for the page size.
      const maxChars = (args.limit == null && !args.all) ? LIST_CHAR_BUDGET : null;
      const payload = store.listPayload(slug, {
        status, archived: args.archived, brief,
        cursor: args.cursor, limit: args.limit, all: args.all, maxChars,
      });
      const shapedPayload = brief ? Object.assign({}, payload, { tickets: payload.tickets.map(compactListRow) }) : payload;
      const out = Object.assign({ project: slug, projectName: meta.name }, withoutCategories(shapedPayload));
      if (payload.nextCursor) {
        out.hint = `Page ${payload.returned}/${payload.total}; continue with cursor:"${payload.nextCursor}" until nextCursor is null.`;
      }
      return out;
    },
  },
  {
    name: 'pulse',
    description: 'Compact liveness read: status, claim, latest comment, dispatch state, git activity.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_PROP,
        ref: { type: 'string', description: 'Ticket ref or id.' },
        detail: { type: 'boolean', description: 'Legacy alias for full.' },
        full: { type: 'boolean', description: 'Include submission, git, and full dispatch lifecycle.' },
      },
      required: ['ref'],
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const pulse = store.pulsePayload(slug, args.ref);
      if (!pulse) throw new Error(`pulse: no ticket "${args.ref}" in ${meta.name}`);
      const payload = (args.full || args.detail) ? withoutCategories(pulse) : compactPulse(pulse);
      return Object.assign({ project: slug }, payload);
    },
  },
  {
    name: 'changes',
    description: 'THE polling read for liveness/progress: compact ticket delta since an ISO timestamp. Omit since for the last 60 minutes. Returns serverTime to use as the next since value.',
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
    name: 'story',
    description: 'Manage user stories: add, list, show, update, or rm.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'list', 'show', 'update', 'rm'] },
        project: PROJECT_PROP,
        story: { type: 'string', description: 'Story ref or id for show, update, or rm.' },
        title: { type: 'string', description: 'Required for add.' },
        description: { type: 'string' },
        color: { type: 'string' },
      },
      required: ['action'],
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const action = String(args.action || '').toLowerCase();
      if (!['add', 'list', 'show', 'update', 'rm'].includes(action)) {
        throw new Error(`story: unknown action "${args.action || ''}". Use add | list | show | update | rm. Run "sidequest help".`);
      }
      if (action === 'add') {
        if (!args.title) throw new Error('story add: --title/-t is required, e.g. sidequest story add -t "Auth revamp" [--color teal]');
        const story = store.createStory(slug, { title: args.title, description: args.description, color: args.color });
        return { ok: true, project: slug, projectName: meta.name, story };
      }
      if (action === 'list') {
        const stories = store.listStories(slug).map((story: any) => Object.assign({}, story, {
          ticketCount: store.listTickets(slug).filter((ticket: any) => !ticket.archived && ticket.storyId === story.id).length,
        }));
        return { project: slug, projectName: meta.name, stories };
      }
      if (!args.story) {
        throw new Error(`story ${action}: pass a story ref, e.g. sidequest story ${action} US-1`);
      }
      if (action === 'show') {
        const story = store.getStory(slug, args.story);
        if (!story) throw new Error(`story show: no story "${args.story}" in ${meta.name}`);
        const tickets = store.listTickets(slug).filter((ticket: any) => !ticket.archived && ticket.storyId === story.id);
        return { project: slug, projectName: meta.name, story: store.storyReadPayload(story), tickets };
      }
      if (action === 'update') {
        const patch: any = {};
        for (const key of ['title', 'description', 'color']) {
          if (args[key] !== undefined) patch[key] = args[key];
        }
        const story = store.updateStory(slug, args.story, patch);
        if (!story) throw new Error(`story update: no story "${args.story}" in ${meta.name}`);
        return { ok: true, project: slug, story };
      }
      if (action === 'rm') {
        const story = store.getStory(slug, args.story);
        return { ok: store.deleteStory(slug, args.story), project: slug, story: story || null };
      }
      throw new Error(`story: unknown action "${args.action || ''}". Use add | list | show | update | rm. Run "sidequest help".`);
    },
  },
  {
    name: 'story_contract',
    description: 'Read or set a story execution contract. Durable storage holds 256 KiB UTF-8. Reads return UTF-8-safe pages up to 16 KiB with revision, SHA-256, total bytes, cursor, and completion.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_PROP,
        story: { type: 'string', description: 'Story ref or id.' },
        contract: { type: 'string', description: 'Execution contract; empty clears. Durable capacity: 256 KiB UTF-8.' },
        cursor: { type: 'integer', minimum: 0, description: 'Byte cursor from nextCursor; pages do not split UTF-8 characters.' },
        limit: { type: 'integer', minimum: 4, maximum: 16384, description: 'Page byte limit, 4 bytes through 16 KiB.' },
        full: { type: 'boolean', description: 'Retains fidelity through pages; never bypasses the 16 KiB ceiling.' },
      },
      required: ['story'],
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const story = args.contract === undefined
        ? store.getStory(slug, args.story)
        : store.updateStory(slug, args.story, { executionContract: args.contract });
      if (!story) throw new Error(`story_contract: no story "${args.story}" in ${meta.name}`);
      const contract = store.storyExecutionContractPage(story, args);
      const visibleStory = Object.assign({}, story, { executionContract: contract.body });
      return { ok: true, project: slug, projectName: meta.name, story: visibleStory, contract };
    },
  },
  {
    name: 'story_log',
    description: 'Read, append, or rotate a story decision log.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_PROP,
        story: { type: 'string', description: 'Story ref or id.' },
        entry: { type: 'string', pattern: '^(DECISION|CONSTRAINT|DISCOVERY)\\s*:', description: 'Must begin DECISION:, CONSTRAINT:, or DISCOVERY:. Text after the prefix is at most 16,000 UTF-8 bytes.' },
        ref: { type: 'string', description: 'Claimed member ticket ref for an append.' },
        by: { type: 'string', description: 'Claim owner for an append, or orchestrator to clear.' },
        rotate: { type: 'boolean', description: 'Archive current entries before starting a new log.' },
      },
      required: ['story'],
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      if (args.rotate && args.entry !== undefined) throw new Error('story_log: pass an entry or rotate:true, not both.');
      let story;
      let advisory = null;
      if (args.rotate) {
        if (args.by !== 'orchestrator') throw new Error('story_log: rotate:true requires by:"orchestrator".');
        story = store.rotateStoryLog(slug, args.story);
      } else if (args.entry === undefined) {
        story = store.getStory(slug, args.story);
      } else {
        story = store.appendStoryLogEntry(slug, args.story, { entry: args.entry, ref: args.ref, by: args.by });
        advisory = store.storyLogEntryAdvisory(args.entry);
      }
      if (!story) throw new Error(`story_log: no story "${args.story}" in ${meta.name}`);
      const log = store.storyDecisionLog(story);
      return {
        ok: true,
        project: slug,
        projectName: meta.name,
        story: {
          ref: story.ref,
          logBytes: log.bytes,
          logCapacity: log.capacity,
          logRevision: log.revision,
          entries: log.entries,
          totalEntries: log.totalEntries,
          omittedEntries: log.omittedEntries,
          archivedEntries: log.archivedEntries,
        },
        ...(advisory ? { advisory } : {}),
      };
    },
  },
  {
    name: 'ready',
    description: 'Ready tickets in safe waves. Default: count plus ref/title rows; full:true returns ticket records.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_PROP,
        model: MODEL_FILTER_PROP,
        category: { type: 'string', description: 'Filter to a category ID.' },
        brief: { type: 'boolean' },
        full: { type: 'boolean' },
      },
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      requireKnownModelFilter('ready', args.model);
      const full = args.full === true || args.brief === false;
      const payload = store.readyPayload(slug, { model: args.model, category: args.category, brief: !full });
      return Object.assign({ project: slug, projectName: meta.name }, withoutCategories(full ? payload : readySummary(payload)));
    },
  },
];

module.exports = { tools };
