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
    name: "add",
    description: "File a ticket on the board. description is a developer-to-developer note, passed as a normal string (real newlines fine — no shell escaping). Use this to capture work the user mentions in passing so it outlives the session.",
    inputSchema: {
      type: "object",
      properties: {
        project: PROJECT_PROP,
        title: { type: "string" },
        description: { type: "string" },
        priority: { type: "string", enum: store.VALID_PRIORITY },
        labels: LABELS_PROP,
        files: FILES_PROP,
        storyId: { type: "string", pattern: String.raw`^US-\d+$`, description: "A story ref (US-n) to file this ticket into." }
      },
      required: ["title"]
    },
    handler(args) {
      if (!args.title || !String(args.title).trim()) throw new Error("add: title is required.");
      const { slug } = resolveProject(args.project);
      if (args.storyId !== void 0) validateStoryId(args.storyId);
      const created = store.createTicket(slug, {
        title: args.title,
        description: args.description || "",
        priority: args.priority,
        status: args.status,
        labels: args.labels,
        files: args.files,
        storyId: args.storyId,
        source: "mcp"
      });
      const ticket = store.getTicket(slug, created.ref) || created;
      return mutationAck(slug, { ok: true, ticket });
    }
  },
  {
    name: "update",
    description: "Edit a ticket in place: title, description, priority, status, labels, declared files, or the story it belongs to.",
    inputSchema: {
      type: "object",
      properties: {
        project: PROJECT_PROP,
        ref: { type: "string" },
        by: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        priority: { type: "string", enum: store.VALID_PRIORITY },
        status: { type: "string", enum: store.VALID_STATUS },
        labels: LABELS_PROP,
        files: FILES_PROP,
        storyId: { type: "string", description: 'A story ref (US-n), or "none" to unfile.' }
      },
      required: ["ref"]
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const patch = { source: "mcp", sessionId: sessionOf(args) };
      if (args.by !== void 0) patch.by = args.by;
      for (const k of ["title", "description", "priority", "status", "labels", "files"]) {
        if (args[k] !== void 0) patch[k] = args[k];
      }
      if (args.storyId !== void 0) {
        validateStoryId(args.storyId, true);
        patch.storyId = args.storyId;
      }
      const updated = store.updateTicket(slug, args.ref, patch);
      if (!updated) throw new Error(`update: no ticket "${args.ref}" on ${meta.name}.`);
      const t = store.getTicket(slug, updated.ref) || updated;
      return mutationAck(slug, { ok: true, ticket: t });
    }
  },
  {
    name: "remove",
    description: "Permanently and irreversibly delete a ticket by ref. Refuses a live claim unless force:true is passed.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        project: PROJECT_PROP,
        force: { type: "boolean", description: "Permanently remove a ticket with a live claim. Use only when certain." }
      },
      required: ["ref"]
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const ticket = store.getTicket(slug, args.ref);
      if (!ticket) throw new Error(`remove: no ticket "${args.ref}" on ${meta.name}.`);
      const ref = ticket.ref;
      if (!store.deleteTicket(slug, ticket.id)) {
        throw new Error(`remove: could not delete "${ticket.ref}" from ${meta.name}.`);
      }
      return { ok: true, ref };
    }
  },
  {
    name: "archive",
    description: "Archive one ticket by ref, or every done ticket with done:true.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        project: PROJECT_PROP,
        done: { type: "boolean", description: "Archive every done ticket on the board." }
      }
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      if (args.done) {
        const result2 = store.archiveAllDone(slug, { source: "mcp" });
        return { ok: result2.ok, archived: result2.archived.length };
      }
      const ref = requiredText(args, "ref", "archive");
      const result = store.archiveTicket(slug, ref, { source: "mcp" });
      if (!result.ok) throw new Error(`archive: no ticket "${ref}" on ${meta.name}.`);
      return mutationAck(slug, result);
    }
  },
  {
    name: "unarchive",
    description: "Restore an archived ticket by ref.",
    inputSchema: {
      type: "object",
      properties: { ref: { type: "string" }, project: PROJECT_PROP },
      required: ["ref"]
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const result = store.unarchiveTicket(slug, args.ref, { source: "mcp" });
      if (!result.ok) throw new Error(`unarchive: no ticket "${args.ref}" on ${meta.name}.`);
      return mutationAck(slug, result);
    }
  }
];
module.exports = { tools };
