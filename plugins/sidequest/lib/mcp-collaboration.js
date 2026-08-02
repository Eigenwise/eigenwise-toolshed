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
  preservesFinalReport,
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
const tools = [
  {
    name: "comment",
    description: "Add a durable handoff comment (decisions, constraints, risks, evidence); not progress narration.",
    inputSchema: {
      type: "object",
      properties: { ref: { type: "string" }, project: PROJECT_PROP, body: { type: "string" }, by: { type: "string" } },
      required: ["ref", "body"]
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const res = store.addComment(slug, args.ref, { body: args.body, by: args.by || "agent", kind: "comment", source: "mcp" });
      return mutationAck(slug, res, res.ok ? { commentId: res.comment.id, at: res.comment.at } : null);
    }
  },
  {
    name: "plan",
    description: "Write (replace-whole-document) a ticket's plan document, up to 256 KB. Never inlined into a briefing at any size — a briefing carries only the absolute path, and a dependent ticket carries it on its dependency line. Read the current document with `Read` before replacing it. Writer is the claim holder or the orchestrator.",
    inputSchema: {
      type: "object",
      properties: { ref: { type: "string" }, project: PROJECT_PROP, body: { type: "string" }, by: { type: "string" } },
      required: ["ref", "body"]
    },
    handler(args) {
      const { slug } = resolveProject(args.project);
      const res = store.writeTicketPlan(slug, args.ref, args.by || "agent", args.body);
      return mutationAck(slug, res, res.ok ? { path: res.path, revision: res.plan.revision } : null);
    }
  },
  {
    name: "comments",
    description: "Read ticket comments before work; full history is chronological. Past 10 comments, oldest bodies are omitted unless full:true. Follow nextCursor when paging.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        project: PROJECT_PROP,
        full: { type: "boolean", description: "Recovery read: whole bodies, uncapped, bypasses elision. Default reads return capped excerpts (1200 chars/body) with full metadata; use defaults for closeout and status reads." },
        cursor: { type: "string", pattern: "^(0|[1-9]\\d*)$" },
        limit: { type: "integer", minimum: 1, maximum: PAGE_LIMIT_MAX }
      },
      required: ["ref"]
    },
    handler(args) {
      const { slug } = resolveProject(args.project);
      const t = store.getTicket(slug, args.ref);
      if (!t) throw new Error(`comments: no ticket "${args.ref}".`);
      const full = !!args.full;
      const history = store.commentHistory(t.comments || [], full);
      const comments = full ? history.comments : history.comments.map((comment) => compactComment(comment, preservesFinalReport(t, comment)));
      const buildPayload = (page, total, nextCursor) => {
        const payload = {
          ref: t.ref,
          comments: page,
          total,
          returned: page.length,
          nextCursor,
          order: "chronological"
        };
        if (history.omittedBodies) Object.assign(payload, { omittedBodies: history.omittedBodies, notice: history.notice });
        return payload;
      };
      const explicitlyPaged = args.cursor != null || args.limit != null;
      if (explicitlyPaged) return pageRows(comments, args, "comments", buildPayload, null);
      if (full) return { ref: t.ref, comments };
      return buildPayload(comments, comments.length, null);
    }
  },
  {
    name: "link",
    description: "Relate two tickets (the inverse is written automatically). verb: blocks | depends-on | related. A ticket blocked by an unfinished one is skipped by ready/next.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string" },
        verb: { type: "string", enum: ["blocks", "depends-on", "related"] },
        to: { type: "string" },
        project: PROJECT_PROP
      },
      required: ["from", "verb", "to"]
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const res = store.linkTickets(slug, args.from, args.verb, args.to);
      if (!res.ok) throw new Error(`link: ${res.reason}`);
      return { ok: true, project: slug, from: res.from.ref, to: res.to.ref, type: res.type };
    }
  },
  {
    name: "unlink",
    description: "Remove every link between two tickets (both directions).",
    inputSchema: {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" }, project: PROJECT_PROP },
      required: ["a", "b"]
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const res = store.unlinkTickets(slug, args.a, args.b);
      if (!res.ok) throw new Error(`unlink: ${res.reason}`);
      return { ok: true, project: slug, a: args.a, b: args.b };
    }
  },
  {
    name: "assign",
    description: `Set a ticket's persistent assignee (defaults to "you", the human) — separate from an agent claim. Pass to:"none" or use unassign to clear.`,
    inputSchema: {
      type: "object",
      properties: { ref: { type: "string" }, to: { type: "string" }, project: PROJECT_PROP },
      required: ["ref"]
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const who = args.to == null ? "you" : String(args.to).toLowerCase() === "none" ? null : args.to;
      const res = store.assignTicket(slug, args.ref, who, { source: "mcp" });
      if (!res.ok) throw new Error(`assign: no ticket "${args.ref}".`);
      return mutationAck(slug, res, { assignee: res.ticket.assignee });
    }
  }
];
module.exports = { tools };
