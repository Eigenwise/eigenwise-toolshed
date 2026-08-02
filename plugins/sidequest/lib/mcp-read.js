"use strict";
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
  state
} = require("./mcp-shared");
function readySummary(payload) {
  const tickets = payload.tickets.map((ticket) => ({ ref: ticket.ref, title: ticket.title }));
  return {
    count: tickets.length,
    tickets,
    waves: payload.waves,
    waveDependencies: payload.waveDependencies
  };
}
const tools = [
  {
    name: "list",
    description: 'For liveness/progress polling use changes/pulse, not this. List active tickets (todo + doing) by default, paged with compact rows. Pass status:"done" for completed tickets or all:true for every non-archived status. Follow nextCursor until null. detail:true is audit-only.',
    inputSchema: {
      type: "object",
      properties: {
        project: PROJECT_PROP,
        status: { type: "string", enum: ["todo", "doing", "done"] },
        archived: { type: "boolean" },
        detail: { type: "boolean", description: "Audit only: full bodies and comment threads. Orchestration uses default brief rows; liveness uses changes/pulse." },
        cursor: { type: "string", description: "nextCursor from the prior page." },
        limit: { type: "integer", minimum: 0, description: "Exact page size." },
        all: { type: "boolean", description: "Include every non-archived status, including done." }
      }
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const status = args.status == null && !args.all ? ["todo", "doing"] : args.status;
      const brief = !args.detail;
      const maxChars = args.limit == null && !args.all ? LIST_CHAR_BUDGET : null;
      const payload = store.listPayload(slug, {
        status,
        archived: args.archived,
        brief,
        cursor: args.cursor,
        limit: args.limit,
        all: args.all,
        maxChars
      });
      const shapedPayload = brief ? Object.assign({}, payload, { tickets: payload.tickets.map(compactListRow) }) : payload;
      const out = Object.assign({ project: slug, projectName: meta.name }, withoutCategories(shapedPayload));
      if (payload.nextCursor) {
        out.hint = `Page ${payload.returned}/${payload.total}; continue with cursor:"${payload.nextCursor}" until nextCursor is null.`;
      }
      return out;
    }
  },
  {
    name: "changes",
    description: "THE polling read for liveness/progress: compact ticket delta since an ISO timestamp. Omit since for the last 60 minutes. Returns serverTime to use as the next since value.",
    inputSchema: {
      type: "object",
      properties: {
        project: PROJECT_PROP,
        since: { type: "string", description: "Exclusive ISO timestamp from a prior serverTime." }
      }
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      return Object.assign({ project: slug, projectName: meta.name }, withoutCategories(store.changesPayload(slug, args.since)));
    }
  },
  {
    name: "story",
    description: "Manage user stories: add, list, show, update, or rm.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "list", "show", "update", "rm"] },
        project: PROJECT_PROP,
        story: { type: "string", description: "Story ref or id for show, update, or rm." },
        title: { type: "string", description: "Required for add." },
        description: { type: "string" },
        color: { type: "string" }
      },
      required: ["action"]
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const action = String(args.action || "").toLowerCase();
      if (!["add", "list", "show", "update", "rm"].includes(action)) {
        throw new Error(`story: unknown action "${args.action || ""}". Use add | list | show | update | rm. Run "sidequest help".`);
      }
      if (action === "add") {
        if (!args.title) throw new Error('story add: --title/-t is required, e.g. sidequest story add -t "Auth revamp" [--color teal]');
        const story = store.createStory(slug, { title: args.title, description: args.description, color: args.color });
        return { ok: true, project: slug, projectName: meta.name, story };
      }
      if (action === "list") {
        const stories = store.listStories(slug).map((story) => Object.assign({}, story, {
          ticketCount: store.listTickets(slug).filter((ticket) => !ticket.archived && ticket.storyId === story.id).length
        }));
        return { project: slug, projectName: meta.name, stories };
      }
      if (!args.story) {
        throw new Error(`story ${action}: pass a story ref, e.g. sidequest story ${action} US-1`);
      }
      if (action === "show") {
        const story = store.getStory(slug, args.story);
        if (!story) throw new Error(`story show: no story "${args.story}" in ${meta.name}`);
        const tickets = store.listTickets(slug).filter((ticket) => !ticket.archived && ticket.storyId === story.id);
        return { project: slug, projectName: meta.name, story: store.storyReadPayload(story), tickets };
      }
      if (action === "update") {
        const patch = {};
        for (const key of ["title", "description", "color"]) {
          if (args[key] !== void 0) patch[key] = args[key];
        }
        const story = store.updateStory(slug, args.story, patch);
        if (!story) throw new Error(`story update: no story "${args.story}" in ${meta.name}`);
        return { ok: true, project: slug, story };
      }
      if (action === "rm") {
        const story = store.getStory(slug, args.story);
        return { ok: store.deleteStory(slug, args.story), project: slug, story: story || null };
      }
      throw new Error(`story: unknown action "${args.action || ""}". Use add | list | show | update | rm. Run "sidequest help".`);
    }
  }
];
module.exports = { tools };
