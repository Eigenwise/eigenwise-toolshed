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
  controlPlaneIdentity,
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
  closeDispatchExecutor,
  mutationAck,
  integrationBranchAck,
  outOfScopeComment,
  COMPACT_RESULT_MAX_BYTES,
  COMPACT_PULSE_BODY_MAX_CHARS,
  PAGED_FULL_DEFAULT_LIMIT,
  PAGE_LIMIT_MAX,
  boundedExcerpt,
  compactCommentWithContext,
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
const { sidequestMutationFreshness } = require("./plugin-freshness");
const tools = [
  {
    name: "supersede_submission",
    description: "Close a pending submission with an integrated repair and reviewed retirements.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Pending submission to close." },
        project: PROJECT_PROP,
        by: { type: "string", description: "Control-plane identity recording the closure." },
        supersededBy: { type: "string", description: "Later ticket ref with an integrated repair delivery." },
        reason: { type: "string", description: "Concise delivery evidence retained on the closed submission." },
        reviewedReplacements: {
          type: "array",
          description: "Required for intentionally changed or retired submitted paths.",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              reviewedBy: { type: "string", description: "Reviewer or review ticket that approved the replacement." },
              reason: { type: "string", description: "Why this replacement preserves the intended delivery." }
            },
            required: ["path", "reviewedBy", "reason"]
          }
        }
      },
      required: ["ref", "by", "supersededBy", "reason"]
    },
    handler(args) {
      const { slug } = resolveProject(args.project);
      const by = requireBy(args, "supersede_submission");
      const result = store.closeSubmissionAsSuperseded(slug, args.ref, {
        by,
        supersededBy: args.supersededBy,
        reason: args.reason,
        reviewedReplacements: args.reviewedReplacements,
        source: "mcp"
      });
      return mutationAck(slug, result, result.ok ? { supersededBy: result.supersededBy, idempotent: result.idempotent === true } : null);
    }
  },
  {
    name: "comment",
    description: "Add a durable handoff comment (decisions, constraints, risks, evidence); not progress narration.",
    inputSchema: {
      type: "object",
      properties: { ref: { type: "string" }, project: PROJECT_PROP, body: { type: "string" }, by: { type: "string" } },
      required: ["ref", "body"]
    },
    handler(args) {
      const { slug } = resolveProject(args.project);
      const ticket = store.getTicket(slug, args.ref);
      const sessionId = sessionOf(args);
      const claimSessionId = ticket?.claim?.runtime?.sessionId;
      const by = args.by || (sessionId && claimSessionId === sessionId ? ticket.claim.by : controlPlaneIdentity(null, sessionId));
      const res = store.addComment(slug, args.ref, {
        body: args.body,
        by,
        kind: "comment",
        source: "mcp",
        sourceSession: sessionId || null,
        actor: by,
        operation: "comment"
      });
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
    description: "Read comments before work; history is chronological. Pass since with a prior comment id or exclusive ISO timestamp to read only new comments. Past 10 comments, oldest bodies are omitted unless full:true. Follow nextCursor when paging.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        project: PROJECT_PROP,
        full: { type: "boolean", description: "Recovery read: whole bodies, uncapped, bypasses elision. Default reads return capped excerpts (1200 chars/body) with full metadata; use defaults for closeout and status reads." },
        since: { type: "string", description: "Exclusive comment id from a prior read, or ISO timestamp. Incremental reads retain total for the whole thread." },
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
      const allComments = Array.isArray(t.comments) ? t.comments : [];
      const since = args.since == null ? null : String(args.since);
      const sinceIndex = since == null ? -1 : allComments.findIndex((comment) => comment.id === since);
      const sinceMs = sinceIndex >= 0 || since == null ? null : Date.parse(since);
      if (since != null && sinceIndex < 0 && !Number.isFinite(sinceMs)) {
        throw new Error("comments: since must be an ISO timestamp or a comment id from this thread.");
      }
      const unreadComments = since == null ? allComments : sinceIndex >= 0 ? allComments.slice(sinceIndex + 1) : allComments.filter((comment) => Date.parse(comment.at) > sinceMs);
      const history = store.commentHistory(unreadComments, full);
      const commentsById = new Map(unreadComments.map((comment) => [comment.id, comment]));
      const comments = full ? history.comments : history.comments.map((comment) => compactCommentWithContext(
        slug,
        t,
        comment,
        commentsById.get(comment.id),
        preservesFinalReport(t, comment)
      ));
      const buildPayload = (page, visibleTotal, nextCursor) => {
        const payload = {
          ref: t.ref,
          comments: page,
          total: since == null ? visibleTotal : allComments.length,
          returned: page.length,
          nextCursor,
          order: "chronological"
        };
        if (history.omittedBodies) Object.assign(payload, { omittedBodies: history.omittedBodies, notice: history.notice });
        return payload;
      };
      const explicitlyPaged = args.cursor != null || args.limit != null;
      if (explicitlyPaged) return pageRows(comments, args, "comments", buildPayload, null);
      if (full && since == null) return { ref: t.ref, comments };
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
      if (!res.ok) {
        if (res.reason === "bad_type") {
          throw new Error(`link: invalid verb "${args.verb}". Valid verbs: blocks, depends-on, related. Use from/verb/to.`);
        }
        throw new Error(`link: ${res.reason}`);
      }
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
  },
  {
    name: "dispatch",
    description: "Prepare a token-gated dispatch. It returns a stable executor spawn spec and token. Shared-tree dispatch requires the spawning runtime to already be rooted in the declared checkout. Executors with a live claim cannot dispatch child tickets; record the follow-up and let the orchestration session dispatch it.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        project: PROJECT_PROP,
        sharedTree: { type: "boolean", description: "Use the declared shared checkout only when the spawning runtime is already rooted there. Executors with a live claim cannot use this to dispatch child work." },
        allowRepeatFailure: { type: "boolean" },
        allowUnscoped: { type: "boolean", description: "Explicitly allow a write ticket with no declared file scope." },
        integrationBranch: { type: "string" },
        recoveryEvidence: { type: "string", description: "Retire an attempt no runtime will finish: never bound or claimed, or bound and unclaimed past the idle backstop. Prepares one fresh attempt. Pass the observed evidence." },
        full: { type: "boolean", description: "Include token, executor, warnings, and recovery details." }
      },
      required: ["ref"]
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const freshness = sidequestMutationFreshness(meta.path, { pluginRoot: path.join(__dirname, "..") });
      if (freshness.refusal) throw new Error(freshness.refusal);
      const descriptionError = store.dispatchDescriptionError(store.getTicket(slug, args.ref));
      if (descriptionError) throw new Error(descriptionError);
      const sessionId = requireDispatchSession();
      const prepared = store.prepareDispatch(slug, args.ref, {
        sessionId,
        runtimeCwd: process.cwd(),
        ...Object.hasOwn(args, "sharedTree") ? { sharedTree: args.sharedTree === true } : {},
        allowRepeatFailure: args.allowRepeatFailure === true,
        allowUnscoped: args.allowUnscoped === true,
        integrationBranch: args.integrationBranch,
        recoveryEvidence: args.recoveryEvidence,
        ...freshness.skew ? { dispatchSkew: freshness.skew } : {},
        // Reaching this handler is itself proof the board MCP is connected
        // in this session (SQ-1017); CLI transport carries no such proof.
        source: "mcp",
        transport: "mcp"
      });
      const isolation = agentsync.ticketIsolation(prepared.ticket, prepared.ticket.dispatch && prepared.ticket.dispatch.sharedTree);
      const prompt = agentsync.renderDispatchStub(prepared.ticket, prepared.token, meta.path);
      const resolved = store.resolveExec(prepared.ticket.model, prepared.ticket.effort);
      const agent = store.canonicalPreparedDispatchExecutor(prepared.ticket);
      const dispatchState = prepared.ticket.dispatch || {};
      const description = dispatchState.description || agentsync.spawnDescription(prepared.ticket, resolved);
      const spawn = agentsync.agentSpawn(dispatchState.launchName, isolation, resolved && resolved.model, agent, prompt, description);
      const compact = {
        ref: prepared.ticket.ref,
        effort: prepared.ticket.effort,
        runsLabel: prepared.ticket.exec && prepared.ticket.exec.runsLabel,
        ...prepared.ticket.dispatch?.fallbackReason ? { fallbackReason: prepared.ticket.dispatch.fallbackReason } : {},
        spawn
      };
      const warnings = store.presentWarnings(prepared.ticket, store.dispatchWarnings(prepared.ticket, slug), sessionId);
      if (!args.full) {
        const withWarnings = warnings.length ? Object.assign({}, compact, { warnings }) : compact;
        return Buffer.byteLength(JSON.stringify(withWarnings, null, 2)) <= 1200 ? withWarnings : compact;
      }
      return {
        project: slug,
        projectPath: meta.path,
        ref: prepared.ticket.ref,
        effort: prepared.ticket.effort,
        exec: prepared.ticket.exec,
        mode: "instant",
        agent,
        tokenPrefix: prepared.token.slice(0, 12),
        token: prepared.token,
        recovery: prepared.recovery || null,
        ...dispatchState.fallbackReason ? { fallbackReason: dispatchState.fallbackReason } : {},
        warnings,
        spawn,
        guidance: prepared.recovery ? `Claude quota fallback prepared from ${prepared.recovery.failedModel} to ${prepared.recovery.model}·${prepared.recovery.effort}. Pass spawn unchanged; category policy is unchanged.` : `Instant: pass spawn unchanged to Agent; it claims ${prepared.ticket.ref} with executor ${agent} and the token.`,
        // The agent list's own model label always reads claude-codex-auto for gateway
        // routes and cannot be changed (SQ-1350), so a paraphrased description is the
        // only thing standing between the reader and an unidentifiable running agent.
        spawnDescriptionNote: `Copy spawn.description byte-for-byte into the Agent call. It leads with "${description.split(" · ")[0]}" for notifications, while the stable spawn.name ends with the resolved route token and effort.`
      };
    }
  },
  {
    name: "native_agent",
    description: "Return a stable native Agent spawn spec for a ticket. Executors holding an active claim cannot create a spawn. Claude Code snapshots agent definitions at session start, so temporary definitions written mid-session cannot be safely spawned. The returned executor is already registered, uses the ticket runtime, and must be passed to Agent unchanged.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        project: PROJECT_PROP,
        prompt: { type: "string", description: "The bounded ticket-execution prompt augmented with stored anchors and verify command." },
        session: { type: "string" },
        sharedTree: { type: "boolean", description: "Use the declared shared checkout only when the spawning runtime is already rooted there. Executors with a live claim cannot use this to dispatch child work." }
      },
      required: ["ref", "prompt"]
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const freshness = sidequestMutationFreshness(meta.path, { pluginRoot: path.join(__dirname, "..") });
      if (freshness.refusal) throw new Error(freshness.refusal);
      if (meta.path) {
        assertSidequestInstall(meta.path);
        assertDispatchTransport("mcp");
      }
      const ticket = store.getTicket(slug, args.ref);
      if (!ticket) throw new Error(`native_agent: no ticket "${args.ref}".`);
      if (ticket.reviewTarget) throw new Error(`native_agent: ${ticket.ref} reviews a bound candidate; use dispatch so the store pins its exact immutable checkout.`);
      const sessionId = sessionOf(args);
      const executorClaimRefusal = store.executorClaimDispatchRefusal(slug, sessionId);
      if (executorClaimRefusal) throw new Error(executorClaimRefusal);
      const route = store.resolveTicketRoute(ticket, ticket.category);
      if (!route || !route.exec) throw new Error(`native_agent: ${route?.refusal || `${ticket.ref} has no routable model and effort.`}`);
      const resolved = route.exec;
      const prompt = agentsync.withProjectIdentity(work.executorPrompt(ticket, args.prompt), meta.path);
      const sharedTree = store.boardConfig(slug)?.worktreeIsolation === false || args.sharedTree === true;
      const runtimeRefusal = sharedTree ? store.sharedTreeRuntimeRefusal(ticket, meta.path, process.cwd()) : null;
      if (runtimeRefusal) throw new Error(runtimeRefusal);
      const created = agentsync.createNativeAgent({
        ref: ticket.ref,
        agentType: resolved.agent || `sidequest-exec-${route.effort || "low"}`,
        spawnModel: resolved.model,
        effort: route.effort,
        runtime: resolved.runsModel,
        launchName: execNames.dispatchLaunchName(ticket.ref, ticket.title, resolved, route.effort),
        description: agentsync.spawnDescription(ticket, resolved),
        isolation: agentsync.ticketIsolation(ticket, sharedTree),
        sessionId,
        prompt
      });
      return Object.assign({
        project: slug,
        projectPath: meta.path,
        ref: ticket.ref,
        effort: ticket.effort,
        exec: ticket.exec,
        prompt
      }, created);
    }
  },
  {
    name: "native_agent_cleanup",
    description: "Remove a legacy temporary Sidequest native Agent definition after a failed older run. Stable native_agent dispatch does not create files.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" }, session: { type: "string" } }
    },
    handler(args) {
      if (!args.name && !sessionOf(args)) throw new Error("native_agent_cleanup: pass name or session.");
      return agentsync.cleanupNativeAgents({ name: args.name, sessionId: sessionOf(args) });
    }
  }
];
module.exports = { tools };
