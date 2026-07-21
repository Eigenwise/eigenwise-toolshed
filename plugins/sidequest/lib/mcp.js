"use strict";
const path = require("path");
const fs = require("fs");
const store = require("./store");
const work = require("./work");
const agentsync = require("./agentsync");
const commitScope = require("./commit-scope");
const { claimRefusalMessage } = require("./refusal-guidance");
const SERVER_NAME = "sidequest";
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const CATEGORY_TAXONOMY_WARNING = "Category stamped without reading the taxonomy this session — run category_list and confirm the description matches.";
let categoryListServed = false;
function serverVersion() {
  try {
    return require("../.claude-plugin/plugin.json").version || "0.0.0";
  } catch (_) {
    return "0.0.0";
  }
}
function resolveProject(projectArg) {
  const arg = projectArg == null ? "" : String(projectArg).trim();
  if (arg) {
    const res = store.findProject(arg);
    if (res.ok) return { slug: res.slug, meta: res.meta };
    if (res.reason === "ambiguous") {
      throw new Error(`project "${arg}" matches ${res.matches.length} boards named "${arg}" — pass the absolute path to disambiguate.`);
    }
    if (path.isAbsolute(arg)) {
      let isDir = false;
      try {
        isDir = fs.statSync(arg).isDirectory();
      } catch (_) {
      }
      if (isDir) return store.ensureProject(store.nearestRepoRoot(path.resolve(arg)));
    }
    const known = Array.from(new Set(res.known || []));
    throw new Error(`project "${arg}" does not match any registered board.${known.length ? " Known: " + known.join(", ") : ""}`);
  }
  const start = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  return store.ensureProject(store.nearestRepoRoot(start));
}
function runtimeSessionId() {
  const v = process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || "";
  return String(v).trim() || null;
}
function sessionOf(args) {
  return runtimeSessionId() || args && String(args.session || "").trim() || null;
}
function requireDispatchSession() {
  const sessionId = runtimeSessionId();
  if (!sessionId) {
    throw new Error("dispatch: MCP runtime session identity is unavailable. Reload Sidequest in Claude Code and retry; do not pass a session label.");
  }
  return sessionId;
}
function workflowRecipe(slug, categoryId) {
  const requested = String(categoryId || "").trim();
  if (!requested) throw new Error('route_recipe: "category" is required.');
  const category = store.getCategory(requested, { project: slug });
  if (!category || !category.enabled) {
    const disabled = store.getCategory(requested, { project: slug, includeDisabled: true }) || store.getProjectCategories(slug).rows.some((row) => row.kind === "DISABLE" && row.id === requested.toLowerCase());
    throw new Error(`route_recipe: category "${requested}" is ${disabled ? "disabled for this project" : "unknown"}.`);
  }
  const resolved = store.resolveCategoryRoute(category);
  if (!resolved || !resolved.exec) throw new Error(`route_recipe: category "${category.id}" has no available route.`);
  return agentsync.workflowRecipe(Object.assign({}, category, { project: slug }), resolved);
}
function requireBy(args, action) {
  const by = args && args.by != null ? String(args.by).trim() : "";
  if (!by) throw new Error(`${action}: "by" is required — a unique per-worker id (e.g. claude-<8 hex>). A shared value breaks the atomic-claim guarantee.`);
  return by;
}
function effortDrift(slug, idOrRef, claimedEffort) {
  if (claimedEffort == null) return null;
  const t = store.getTicket(slug, idOrRef);
  if (!t) return null;
  const derivedEffort = t.effort || (store.CLAUDE_RUNTIMES.includes(t.model) ? "low" : null);
  if (!derivedEffort) return null;
  const claimed = String(claimedEffort).toLowerCase();
  if (claimed === derivedEffort) return null;
  const resolved = store.resolveExec(t.model, derivedEffort);
  const execName = t.exec && t.exec.agent || resolved && resolved.agent || `sidequest-exec-${derivedEffort}`;
  return {
    reason: "effort_mismatch",
    ref: t.ref,
    derivedModel: t.model,
    derivedEffort,
    claimedEffort: claimed,
    message: `${t.ref} resolves to ${t.model}·${derivedEffort}, but ${claimed} was requested. Run sidequest dispatch ${t.ref}, then spawn ${execName}.`
  };
}
function executorDrift(slug, idOrRef, claimedEffort, executorName, token, direct) {
  if (direct) return null;
  const effort = effortDrift(slug, idOrRef, claimedEffort);
  if (effort) return effort;
  const t = store.getTicket(slug, idOrRef);
  if (t && t.dispatchNonce && token === t.dispatchNonce && executorName !== t.dispatchExecutor) {
    return {
      reason: "executor_mismatch",
      ref: t.ref,
      derivedModel: t.model,
      derivedEffort: t.effort,
      executor: executorName || null,
      expectedExecutor: t.dispatchExecutor,
      message: `${t.ref} has a prepared dispatch for ${t.dispatchExecutor}, not ${executorName || "this executor"}. Re-run sidequest dispatch ${t.ref} and claim with its returned executor and token.`
    };
  }
  if (t && t.dispatchNonce && token === t.dispatchNonce && executorName === t.dispatchExecutor) return null;
  if (!executorName) return null;
  if (!t || !t.exec || t.exec.backend !== "codex") return null;
  if (executorName === t.exec.agent) return null;
  return {
    reason: "executor_mismatch",
    ref: t.ref,
    derivedModel: t.model,
    derivedEffort: t.effort,
    backend: t.exec.backend,
    runsLabel: t.exec.runsLabel,
    executor: executorName,
    expectedExecutor: t.exec.agent,
    message: `${t.ref} resolves to ${t.exec.runsLabel} · ${t.effort} (${t.exec.backend}), but ${executorName} is not its generated executor. Run sidequest dispatch ${t.ref}, then spawn ${t.exec.agent}.`
  };
}
function requireKnownModelFilter(action, value) {
  if (value == null) return;
  const cls = store.classifyModelFilter(value);
  if (cls === "unknown") {
    throw new Error(`${action}: unknown model "${value}" — known: ${store.getModelVocab().models.join(", ")}`);
  }
}
function requireKnownModel(action, value) {
  if (value == null || !String(value).trim()) return;
  if (!store.resolveExec(value, null)) {
    throw new Error(`${action}: unknown model "${value}" — known: ${store.getModelVocab().models.join(", ")}`);
  }
}
const PROJECT_PROP = { type: "string", description: "Board (default: current project)." };
const MODEL_FILTER_PROP = { type: "string", description: "Filter by resolved model slug." };
const TOOL_DESCRIPTION_OVERRIDES = {
  claim: "Atomically claim a ticket before work. Pass the routed executor and effort; proceed only when ok:true.",
  dispatch: "Prepare a ticket executor through its stable route.",
  done: "Finish a claimed ticket and release its claim. Stamp the actual model and effort.",
  native_agent: "Return the registered native Agent spawn spec for a ticket; pass it to Agent unchanged.",
  archive: "Archive one ticket, or every done ticket.",
  archive_board: "Archive an explicitly named board.",
  assign: "Set a ticket assignee.",
  category_add: "Add a global or project category.",
  category_detach: "Pin a board category to its current policy.",
  category_edit: "Edit a global category or project policy.",
  category_relink: "Reset a board category to the shared policy.",
  category_rm: "Remove a global or project category policy.",
  global_fallback: "Read or set the global routing fallback.",
  models: "Read models and category routes.",
  projects: "List registered boards.",
  remove: "Permanently delete a ticket. Live claims require force:true.",
  unarchive: "Restore an archived ticket.",
  unarchive_board: "Restore an explicitly named board.",
  unlink: "Remove links between two tickets."
};
function conciseDescription(description) {
  const firstSentence = String(description || "").match(/^.*?[.!?](?:\s|$)/);
  return firstSentence ? firstSentence[0].trim() : description;
}
function compactSchema(schema) {
  if (Array.isArray(schema)) return schema.map(compactSchema);
  if (!schema || typeof schema !== "object") return schema;
  const compact = {};
  for (const [key, value] of Object.entries(schema)) {
    compact[key] = key === "description" ? conciseDescription(value) : compactSchema(value);
  }
  return compact;
}
const LIST_CHAR_BUDGET = 55e3;
function closeDispatchExecutor(ticket) {
  if (ticket && ticket.dispatchExecutor) agentsync.cleanupNativeAgents({ name: ticket.dispatchExecutor });
}
function categoryEcho(ticket) {
  if (!ticket || !ticket.category) return null;
  return {
    id: ticket.category.id,
    name: ticket.category.name,
    description: ticket.category.description,
    route: { model: ticket.model, effort: ticket.effort, executor: ticket.exec && ticket.exec.agent }
  };
}
function mutationAck(project, result, changed) {
  const ticket = result.ticket;
  const out = { ok: !!result.ok, project };
  if (ticket) Object.assign(out, { ref: ticket.ref, status: ticket.status });
  if (!result.ok) {
    for (const key of ["reason", "claim", "expectedExecutor", "derivedEffort", "claimedEffort", "max", "length", "message"]) {
      if (result[key] !== void 0) out[key] = result[key];
    }
    return out;
  }
  return Object.assign(out, changed || {});
}
function requiredText(args, key, action) {
  const value = args && args[key] != null ? String(args[key]).trim() : "";
  if (!value) throw new Error(`${action}: "${key}" is required.`);
  return value;
}
function worktreeRoot(worktree, action) {
  const supplied = requiredText({ worktree }, "worktree", action);
  if (!path.isAbsolute(supplied)) throw new Error(`${action}: "worktree" must be an absolute path.`);
  let stat;
  try {
    stat = fs.statSync(supplied);
  } catch (_) {
    throw new Error(`${action}: worktree does not exist: ${supplied}`);
  }
  if (!stat.isDirectory()) throw new Error(`${action}: worktree must be a directory: ${supplied}`);
  let root;
  try {
    root = commitScope.repoRoot(supplied);
  } catch (_) {
    throw new Error(`${action}: worktree is not inside a git work tree: ${supplied}`);
  }
  if (path.resolve(supplied) !== path.resolve(root)) throw new Error(`${action}: worktree must name the git worktree root: ${supplied}`);
  return root;
}
function verifyEmbedsWorktreeRoot(verify, root) {
  if (typeof verify !== "string" || !verify || !root) return false;
  const normalize = (value) => String(value).replace(/[\\/]+/g, "/").replace(/\/+$/, "");
  const worktree = normalize(path.resolve(root));
  const command = normalize(verify);
  const caseInsensitive = /^[a-z]:\//i.test(worktree);
  const comparableRoot = caseInsensitive ? worktree.toLowerCase() : worktree;
  const comparableCommand = caseInsensitive ? command.toLowerCase() : command;
  let offset = comparableCommand.indexOf(comparableRoot);
  while (offset !== -1) {
    const next = comparableCommand.charAt(offset + comparableRoot.length);
    if (!next || next === "/" || !/[a-z0-9._-]/i.test(next)) return true;
    offset = comparableCommand.indexOf(comparableRoot, offset + comparableRoot.length);
  }
  return false;
}
function changedTicketFields(ticket, args) {
  const fields = {};
  for (const key of ["title", "description", "priority", "labels", "files", "complexity"]) {
    if (args[key] !== void 0) fields[key] = ticket[key];
  }
  if (args.anchors !== void 0) fields.anchors = ticket.executorAnchors;
  if (args.verify !== void 0) fields.verify = ticket.executorVerify;
  if (args.story !== void 0) fields.storyId = ticket.storyId;
  if (args.category !== void 0) fields.categoryId = ticket.categoryId;
  if (args.why !== void 0) fields.why = ticket.complexityWhy;
  return fields;
}
function withoutCategories(payload) {
  const { categories, ...trimmed } = payload;
  return trimmed;
}
const TOOLS = [
  {
    name: "list",
    description: "List tickets, paged; compact rows by default. Follow nextCursor until null; detail:true adds bodies + threads.",
    inputSchema: {
      type: "object",
      properties: {
        project: PROJECT_PROP,
        status: { type: "string", enum: ["todo", "doing", "done"] },
        archived: { type: "boolean" },
        detail: { type: "boolean", description: "Full bodies and comment threads." },
        cursor: { type: "string", description: "nextCursor from the prior page." },
        limit: { type: "integer", minimum: 0, description: "Exact page size." },
        all: { type: "boolean", description: "Whole column in one call (can overflow)." }
      }
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const status = args.status == null ? ["todo", "doing"] : args.status;
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
      const out = Object.assign({ project: slug, projectName: meta.name }, withoutCategories(payload));
      if (payload.nextCursor) {
        out.hint = `Page ${payload.returned}/${payload.total}; continue with cursor:"${payload.nextCursor}" until nextCursor is null.`;
      }
      return out;
    }
  },
  {
    name: "pulse",
    description: "Compact liveness read: status, claim, latest comment, dispatch state, git activity.",
    inputSchema: {
      type: "object",
      properties: {
        project: PROJECT_PROP,
        ref: { type: "string", description: "Ticket ref or id." },
        detail: { type: "boolean", description: "Include full dispatch lifecycle (timestamps, attempts, session)." }
      },
      required: ["ref"]
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const pulse = store.pulsePayload(slug, args.ref);
      if (!pulse) throw new Error(`pulse: no ticket "${args.ref}" in ${meta.name}`);
      const out = Object.assign({ project: slug, projectName: meta.name }, withoutCategories(pulse));
      if (!args.detail && out.dispatch) {
        const d = out.dispatch;
        out.dispatch = { state: d.state, executor: d.executor, agentName: d.agentName, tokenPrefix: d.tokenPrefix, route: d.route, outcome: d.outcome };
        if (d.recovery) out.dispatch.recovery = d.recovery;
        if (Array.isArray(d.attempts) && d.attempts.length) out.dispatch.attempts = d.attempts.length;
      }
      return out;
    }
  },
  {
    name: "changes",
    description: "Compact ticket delta since an ISO timestamp. Omit since for the last 60 minutes. Returns serverTime to use as the next since value.",
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
    name: "ready",
    description: "Unclaimed, unblocked, not-done tickets in parallel-safe waves by file scope. Default to brief:true for orchestration reads.",
    inputSchema: {
      type: "object",
      properties: {
        project: PROJECT_PROP,
        model: MODEL_FILTER_PROP,
        category: { type: "string", description: "Filter to a category ID." },
        brief: { type: "boolean", description: "Compact rows without bodies; null category fields mean classify before dispatch." }
      }
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      requireKnownModelFilter("ready", args.model);
      const payload = store.readyPayload(slug, { model: args.model, category: args.category, brief: args.brief });
      return Object.assign({ project: slug, projectName: meta.name }, withoutCategories(payload));
    }
  },
  {
    name: "add",
    description: "File a new ticket. Choose category from the returned taxonomy and pass it here, or use legacy complexity + why. Set unclassified:true only when deliberately leaving classification for a later update before dispatch. model/effort are never set directly. description is a developer-to-developer spec (Where / Contract / Bounds / Verify), passed as a normal string (real newlines fine — no shell escaping).",
    inputSchema: {
      type: "object",
      properties: {
        project: PROJECT_PROP,
        title: { type: "string" },
        description: { type: "string" },
        priority: { type: "string", enum: store.VALID_PRIORITY },
        status: { type: "string", enum: store.VALID_STATUS },
        labels: { type: "array", items: { type: "string" } },
        files: { type: "array", items: { type: "string" }, description: "Declared file scope (paths or dir prefixes)." },
        anchors: { type: "string", maxLength: store.EXECUTOR_ANCHORS_MAX, description: "Executor anchors, verbatim in the task prompt." },
        verify: { type: "string", maxLength: store.EXECUTOR_VERIFY_MAX, description: "Exact verify command, verbatim in the task prompt." },
        story: { type: "string", description: "A story ref (US-n) to file this ticket into." },
        complexity: { type: "integer", minimum: 1, maximum: 10 },
        why: { type: "string", description: "Motivation for the complexity score (min 20 chars)." },
        category: { type: "string", description: "Enabled category id from category_list." },
        unclassified: { type: "boolean", description: "Allow filing without category or complexity." }
      },
      required: ["title"]
    },
    handler(args) {
      if (!args.title || !String(args.title).trim()) throw new Error("add: title is required.");
      if (args.model != null || args.effort != null) throw new Error("add: model/effort are not set directly — use category or complexity + why.");
      const { slug, meta } = resolveProject(args.project);
      let category = null;
      if (args.category != null) {
        category = String(args.category).trim().toLowerCase();
        const valid = store.getCategories({ project: slug, includeDisabled: false }).map((entry) => entry.id);
        if (!valid.includes(category)) throw new Error(`add: unknown category "${args.category}" — valid: ${valid.join(", ")}`);
      }
      const complexity = store.coerceComplexity(args.complexity);
      if (!category && complexity == null && !args.unclassified) throw new Error("add: pass category, legacy complexity + why, or unclassified:true.");
      if (complexity != null && (!args.why || String(args.why).trim().length < 20)) throw new Error("add: why is required with complexity (min 20 chars).");
      const created = store.createTicket(slug, {
        title: args.title,
        description: args.description || "",
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
        source: "mcp"
      });
      const ticket = store.getTicket(slug, created.ref) || created;
      const changed = { title: ticket.title, category: categoryEcho(ticket) };
      const warnings = store.ticketReferenceWarnings(slug, ticket.title, ticket.description);
      if (category && !categoryListServed) warnings.push(CATEGORY_TAXONOMY_WARNING);
      if (warnings.length) changed.warnings = warnings;
      return mutationAck(slug, { ok: true, ticket }, changed);
    }
  },
  {
    name: "update",
    description: 'Edit a ticket by ref. Any omitted field is left unchanged. Re-scoring needs both complexity and a fresh why. Set story to "none" to detach. model/effort are not accepted. Deletion is not a status; use the permanent remove tool instead.',
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        project: PROJECT_PROP,
        title: { type: "string" },
        description: { type: "string" },
        priority: { type: "string", enum: store.VALID_PRIORITY },
        status: { type: "string", enum: store.VALID_STATUS },
        labels: { type: "array", items: { type: "string" } },
        files: { type: "array", items: { type: "string" }, description: "Declared file scope (paths or dir prefixes)." },
        anchors: { type: "string", maxLength: store.EXECUTOR_ANCHORS_MAX, description: "Executor anchors, verbatim in the task prompt." },
        verify: { type: "string", maxLength: store.EXECUTOR_VERIFY_MAX, description: "Exact verify command, verbatim in the task prompt." },
        story: { type: "string" },
        complexity: { type: "integer", minimum: 1, maximum: 10 },
        why: { type: "string" },
        category: { type: "string", description: 'Enabled category id from category_list. Use "none" to clear.' }
      },
      required: ["ref"]
    },
    handler(args) {
      if (args.model != null || args.effort != null) throw new Error("update: model/effort are not accepted — routing is derived from complexity.");
      if (args.complexity != null && (!args.why || String(args.why).trim().length < 20)) {
        throw new Error("update: re-scoring complexity needs a fresh why (min 20 chars).");
      }
      const { slug, meta } = resolveProject(args.project);
      const patch = { source: "mcp" };
      for (const k of ["title", "description", "priority", "status", "labels", "files", "complexity"]) {
        if (args[k] !== void 0) patch[k] = args[k];
      }
      if (args.anchors !== void 0) patch.executorAnchors = args.anchors;
      if (args.verify !== void 0) patch.executorVerify = args.verify;
      if (args.story !== void 0) patch.storyId = args.story;
      if (args.category !== void 0) {
        if (args.category === "none" || args.category === null) patch.category = null;
        else {
          const category = String(args.category).trim().toLowerCase();
          const valid = store.getCategories({ project: slug, includeDisabled: false }).map((entry) => entry.id);
          if (!valid.includes(category)) throw new Error(`update: unknown category "${args.category}" — valid: ${valid.join(", ")}`);
          patch.category = category;
        }
      }
      if (args.why !== void 0) patch.complexityWhy = args.why;
      const updated = store.updateTicket(slug, args.ref, patch);
      if (!updated) throw new Error(`update: no ticket "${args.ref}" on ${meta.name}.`);
      const t = store.getTicket(slug, updated.ref) || updated;
      const changed = changedTicketFields(t, args);
      if (args.category !== void 0) changed.category = categoryEcho(t);
      const warnings = store.ticketReferenceWarnings(slug, t.title, t.description);
      if (patch.category && !categoryListServed) warnings.push(CATEGORY_TAXONOMY_WARNING);
      if (warnings.length) changed.warnings = warnings;
      return mutationAck(slug, { ok: true, ticket: t }, changed);
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
      if (ticket.claim && ticket.claim.by && !store.isClaimStale(ticket.claim) && !args.force) {
        return { ok: false, project: slug, reason: "claimed", ref: ticket.ref, claim: ticket.claim, message: `${ticket.ref} is live-claimed by ${ticket.claim.by}; pass force:true to permanently remove it.` };
      }
      const removed = { ref: ticket.ref, title: ticket.title };
      if (!store.deleteTicket(slug, ticket.id)) {
        throw new Error(`remove: could not delete "${ticket.ref}" from ${meta.name}.`);
      }
      return { ok: true, project: slug, removed, ref: removed.ref, title: removed.title };
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
      if (args.done) return Object.assign({ project: slug }, store.archiveAllDone(slug, { source: "mcp" }));
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
  },
  {
    name: "claim",
    description: "Claim a ticket; routed work needs a dispatch token and executor. direct:true is only available on a user-labeled direct-ok ticket and needs a reason.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        project: PROJECT_PROP,
        by: { type: "string", description: "Unique per-worker id (e.g. claude-<8 hex>)." },
        effort: { type: "string", enum: store.VALID_EFFORTS },
        executor: { type: "string", description: "Exact executor name from the dispatch." },
        token: { type: "string", description: "Dispatch token (required for routed claims)." },
        direct: { type: "boolean", description: "User-granted direct-ok exception; requires reason." },
        reason: { type: "string", description: "Direct rationale (20+ chars, required with direct:true)." },
        force: { type: "boolean", description: "Steal a live claim only when certain." },
        session: { type: "string" }
      },
      required: ["ref", "by"]
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const by = requireBy(args, "claim");
      const drift = executorDrift(slug, args.ref, args.effort, args.executor, args.token, !!args.direct);
      if (drift) return Object.assign({ ok: false, project: slug }, drift);
      const res = store.claimTicket(slug, args.ref, by, { force: !!args.force, direct: !!args.direct, reason: args.reason, token: args.token, executor: args.executor, source: "mcp", sessionId: sessionOf(args) });
      if (!res.ok) res.message = claimRefusalMessage(res.reason, args.ref, res.ticket || res.claim);
      return mutationAck(slug, res, res.ok ? { claim: res.ticket.claim } : null);
    }
  },
  {
    name: "sweepClaims",
    description: "Release claims older than the staleness TTL (audited); fresh claims untouched.",
    inputSchema: {
      type: "object",
      properties: { project: PROJECT_PROP }
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      return store.sweepStaleClaims({ project: slug, source: "mcp" });
    }
  },
  {
    name: "next",
    description: "Atomically claim the top-priority available ticket. Filter by resolved model and/or category ID. Returns ok:false reason:empty when nothing is claimable.",
    inputSchema: {
      type: "object",
      properties: {
        project: PROJECT_PROP,
        by: { type: "string" },
        model: { type: "string", description: "Filter to a resolved Claude runtime or discovered Codex model slug." },
        category: { type: "string", description: "Filter to a category ID." },
        priority: { type: "string", enum: store.VALID_PRIORITY },
        direct: { type: "boolean", description: "User-granted direct-ok exception; requires reason." },
        reason: { type: "string", description: "Direct rationale (20+ chars, required with direct:true)." },
        session: { type: "string" }
      },
      required: ["by"]
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const by = requireBy(args, "next");
      requireKnownModelFilter("next", args.model);
      const res = store.claimNext(slug, by, { priority: args.priority, model: args.model, category: args.category, direct: !!args.direct, reason: args.reason, source: "mcp", sessionId: sessionOf(args) });
      if (!res.ok) res.message = claimRefusalMessage(res.reason, res.ticket && res.ticket.ref || "next ticket", res.ticket || res.claim);
      return mutationAck(slug, res, res.ok ? { claim: res.ticket.claim } : null);
    }
  },
  {
    name: "done",
    description: "Mark a claimed ticket done and release the claim. Stamp model + effort you actually ran as (provenance). by should match the claim.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        project: PROJECT_PROP,
        by: { type: "string" },
        model: { type: "string", description: "Concrete runtime model that actually worked this ticket (provenance)." },
        effort: { type: "string", enum: store.VALID_EFFORTS },
        session: { type: "string" }
      },
      required: ["ref", "by"]
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const by = requireBy(args, "done");
      requireKnownModel("done", args.model);
      const ticket = store.getTicket(slug, args.ref);
      const res = store.completeTicket(slug, args.ref, by, { source: "mcp", model: args.model, effort: args.effort, sessionId: sessionOf(args) });
      if (res.ok) closeDispatchExecutor(ticket);
      return mutationAck(slug, res, res.ok ? { workedBy: res.ticket.workedBy } : null);
    }
  },
  {
    name: "release",
    description: "Drop a claim without finishing (optionally set status, e.g. back to todo). by should match the claim.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        project: PROJECT_PROP,
        by: { type: "string" },
        status: { type: "string", enum: store.VALID_STATUS },
        session: { type: "string" }
      },
      required: ["ref", "by"]
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const by = requireBy(args, "release");
      const ticket = store.getTicket(slug, args.ref);
      const res = store.releaseTicket(slug, args.ref, by, { status: args.status, source: "mcp", sessionId: sessionOf(args) });
      if (res.ok) closeDispatchExecutor(ticket);
      return mutationAck(slug, res);
    }
  },
  {
    name: "commit",
    description: "Commit only a claimed ticket’s declared paths in an explicit local git worktree. Returns the commit hash; foreign staged paths stay staged.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        project: PROJECT_PROP,
        by: { type: "string" },
        message: { type: "string" },
        worktree: { type: "string", description: "Absolute path to this executor’s git worktree root." }
      },
      required: ["ref", "by", "message", "worktree"]
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const by = requireBy(args, "commit");
      const message = requiredText(args, "message", "commit");
      const ticket = store.getTicket(slug, args.ref);
      if (!ticket) throw new Error(`commit: no ticket "${args.ref}" in ${meta.name}.`);
      if (!ticket.claim || ticket.claim.by !== by) {
        return mutationAck(slug, { ok: false, ticket, reason: "not_owner", message: `commit: ${ticket.ref} must be claimed by "${by}" before committing.` });
      }
      const root = worktreeRoot(args.worktree, "commit");
      const scope = store.effectiveScope(slug, ticket.files);
      const result = commitScope.commitScoped(root, message, scope);
      if (!result.ok) {
        const message2 = result.reason === "missing_scope" ? `commit: ${ticket.ref} has no declared file scope.` : result.reason === "outside_scope" ? `commit: refused ${ticket.ref}; commit contains paths outside its declared scope: ${(result.outside || []).join(", ")}.` : result.reason === "no_existing_scope" ? `commit: ${ticket.ref} has no declared paths that exist in this worktree. Missing: ${(result.missingScopes || []).join(", ")}.` : `commit: git failed: ${result.message || result.reason}`;
        return mutationAck(slug, { ok: false, ticket, reason: result.reason, message: message2 });
      }
      if (result.unscopedPaths.length) {
        const body = `out-of-scope changes present: ${result.unscopedPaths.join(", ")} — widen scope + second commit, or discard`;
        const comment = store.addComment(slug, ticket.ref, { by, body, kind: "comment", source: "mcp" });
        if (!comment.ok) throw new Error(`commit: committed ${ticket.ref}, but couldn't record out-of-scope paths: ${comment.reason}`);
      }
      return mutationAck(slug, { ok: true, ticket }, {
        commit: result.commit,
        paths: result.paths,
        missingScopes: result.missingScopes,
        unscopedPaths: result.unscopedPaths
      });
    }
  },
  {
    name: "submit",
    description: "Submit a verified scoped commit range for integration and release the claim.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        project: PROJECT_PROP,
        by: { type: "string" },
        commit: { type: "string" },
        verify: { type: "string" },
        gitRef: { type: "string" },
        worktree: { type: "string", description: "Absolute path to this executor’s git worktree root. Required for isolated worktrees." },
        body: { type: "string", description: "Optional durable verification evidence." },
        session: { type: "string" }
      },
      required: ["ref", "by", "commit"]
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const by = requireBy(args, "submit");
      const commit = requiredText(args, "commit", "submit");
      if (!/^[0-9a-f]{7,64}$/i.test(commit)) {
        throw new Error(`invalid commit "${commit}" — pass the verified commit's hex hash (7-64 chars)`);
      }
      const ticket = store.getTicket(slug, args.ref);
      if (!ticket) throw new Error(`submit: no ticket "${args.ref}" in ${meta.name}.`);
      const root = args.worktree == null ? process.cwd() : worktreeRoot(args.worktree, "submit");
      if (verifyEmbedsWorktreeRoot(args.verify, root)) {
        throw new Error(`submit: refused ${ticket.ref}; verify embeds this worktree path. Run verification from the repo root and use repo-relative paths.`);
      }
      const gitRef = args.gitRef || `refs/sidequest/${ticket.ref}`;
      const range = commitScope.submissionRange(root, { commit, gitRef, upstream: "origin/main" });
      if (!range.ok) {
        return mutationAck(slug, { ok: false, ticket, reason: range.reason, message: range.message });
      }
      const duplicate = store.submissionsPayload(slug).tickets.filter((entry) => entry.ref !== ticket.ref).find((entry) => {
        const commits = Array.isArray(entry.submission.commits) && entry.submission.commits.length ? entry.submission.commits : [entry.submission.commit];
        return commits.some((entryCommit) => range.commits.includes(entryCommit));
      });
      if (duplicate) {
        return mutationAck(slug, { ok: false, ticket, reason: "duplicate_submission", message: `submit: refused ${ticket.ref}; its range includes commit(s) already submitted by ${duplicate.ref}.` });
      }
      const scope = store.effectiveScope(slug, ticket.files);
      const scopedRange = commitScope.validateCommitRangeScope(root, range.commits, scope);
      if (!scopedRange.ok) {
        const message = scopedRange.reason === "missing_scope" ? `submit: ${ticket.ref} has no declared file scope, so its range cannot be admitted for integration.` : scopedRange.reason === "outside_scope" ? `submit: refused ${ticket.ref}; submitted range changes paths outside its declared scope: ${scopedRange.outside.join(", ")}.` : `submit: could not inspect ${commit} from this worktree: ${scopedRange.message || scopedRange.reason}`;
        return mutationAck(slug, { ok: false, ticket, reason: scopedRange.reason, message });
      }
      const unscopedPaths = commitScope.unscopedWorkingPaths(root, scope);
      const res = store.submitTicket(slug, args.ref, by, {
        commit: range.commit,
        gitRef,
        range,
        verify: args.verify,
        worktree: args.worktree,
        unscopedPaths,
        source: "mcp",
        sessionId: sessionOf(args)
      });
      if (res.ok && args.body != null) {
        const comment = store.addComment(slug, args.ref, { body: String(args.body), by, kind: "comment", source: "mcp" });
        if (!comment.ok) throw new Error(`submit: recorded ${ticket.ref}, but could not add evidence comment: ${comment.reason}`);
      }
      if (res.ok) closeDispatchExecutor(ticket);
      return mutationAck(slug, res, res.ok ? { submission: res.ticket.submission } : null);
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
      const { slug, meta } = resolveProject(args.project);
      const res = store.addComment(slug, args.ref, { body: args.body, by: args.by || "agent", kind: "comment", source: "mcp" });
      return mutationAck(slug, res, res.ok ? { commentId: res.comment.id, at: res.comment.at } : null);
    }
  },
  {
    name: "comments",
    description: "Read a ticket's full comment thread BEFORE working it.",
    inputSchema: {
      type: "object",
      properties: { ref: { type: "string" }, project: PROJECT_PROP },
      required: ["ref"]
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const t = store.getTicket(slug, args.ref);
      if (!t) throw new Error(`comments: no ticket "${args.ref}".`);
      return { project: slug, ref: t.ref, comments: t.comments || [] };
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
  },
  {
    name: "dispatch",
    description: "Prepare a token-gated dispatch for a ticket. It returns a stable executor spawn spec and token. Pass spawn unchanged to Agent. Stable executors are ready from session start, so no definition file is involved. A new dispatch in an adopting session rotates the token and returns a current spawn. The claim stays gated on the returned token and executor.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        project: PROJECT_PROP,
        sharedTree: { type: "boolean", description: "Run in the shared tree instead of an isolated worktree." }
      },
      required: ["ref"]
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const descriptionError = store.dispatchDescriptionError(store.getTicket(slug, args.ref));
      if (descriptionError) throw new Error(descriptionError);
      const prepared = store.prepareDispatch(slug, args.ref, { sessionId: requireDispatchSession() });
      const isolation = agentsync.ticketIsolation(prepared.ticket, !!args.sharedTree);
      const prompt = agentsync.renderDispatchStub(prepared.ticket, prepared.token, meta.path);
      const resolved = store.resolveExec(prepared.ticket.model, prepared.ticket.effort);
      const agent = prepared.ticket.dispatchExecutor;
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
        warnings: store.dispatchWarnings(prepared.ticket),
        spawn: agentsync.agentSpawn(agent, isolation, resolved && resolved.model, agent, prompt, agentsync.spawnDescription(prepared.ticket, resolved)),
        guidance: prepared.recovery ? `Claude quota fallback prepared from ${prepared.recovery.failedModel} to ${prepared.recovery.model}·${prepared.recovery.effort}. Pass spawn unchanged; category policy is unchanged.` : `Instant: pass spawn unchanged to Agent; it claims ${prepared.ticket.ref} with executor ${agent} and the token.`
      };
    }
  },
  {
    name: "native_agent",
    description: "Return a stable native Agent spawn spec for a ticket. Claude Code snapshots agent definitions at session start, so temporary definitions written mid-session cannot be safely spawned. The returned executor is already registered, uses the ticket runtime, and must be passed to Agent unchanged.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        project: PROJECT_PROP,
        prompt: { type: "string", description: "The bounded ticket-execution prompt augmented with stored anchors and verify command." },
        session: { type: "string" },
        sharedTree: { type: "boolean", description: "Run in the shared tree instead of an isolated worktree." }
      },
      required: ["ref", "prompt"]
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const ticket = store.getTicket(slug, args.ref);
      if (!ticket) throw new Error(`native_agent: no ticket "${args.ref}".`);
      if (!ticket.model || !ticket.effort) throw new Error(`native_agent: ${ticket.ref} has no routable model and effort.`);
      const resolved = store.resolveExec(ticket.model, ticket.effort);
      const prompt = agentsync.withProjectIdentity(work.executorPrompt(ticket, args.prompt), meta.path);
      const created = agentsync.createNativeAgent({
        ref: ticket.ref,
        agentType: resolved.agent || `sidequest-exec-${ticket.effort || "low"}`,
        spawnModel: resolved.model,
        effort: ticket.effort,
        runtime: resolved.runsModel,
        description: agentsync.spawnDescription(ticket, resolved),
        isolation: agentsync.ticketIsolation(ticket, !!args.sharedTree),
        sessionId: sessionOf(args),
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
  },
  {
    name: "route_recipe",
    description: "Resolve a category into a live Workflow agent recipe. Fetch it when starting work so route edits and warnings stay current.",
    inputSchema: {
      type: "object",
      properties: { category: { type: "string" }, project: PROJECT_PROP },
      required: ["category"]
    },
    handler(args) {
      const { slug } = resolveProject(args.project);
      return workflowRecipe(slug, args.category);
    }
  },
  {
    name: "category_list",
    description: "List the project's ticket categories with their shared/forked/pinned/disabled provenance.",
    inputSchema: { type: "object", properties: { project: PROJECT_PROP, global: { type: "boolean", description: "Show global-only policy instead of the resolved project taxonomy." } } },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const projectScope = !args.global;
      const usage = (id) => store.listTickets(slug).filter((ticket) => (ticket.categoryId || ticket.category && ticket.category.id) === id).length;
      const layer = projectScope ? store.getProjectCategories(slug) : { rows: [], warnings: [] };
      const categories = store.getCategories(projectScope ? { project: slug, withState: true } : void 0).map((category) => {
        const localRow = layer.rows.find((row) => row.id === category.id) || null;
        return Object.assign({}, category, { origin: localRow ? localRow.kind === "ADD" ? "project" : category.linkState : "global", localRow, ticketCount: usage(category.id) });
      });
      for (const localRow of layer.rows.filter((row) => row.kind === "DISABLE")) categories.push({ id: localRow.id, origin: "disabled", localRow, effective: null, ticketCount: usage(localRow.id) });
      categoryListServed = true;
      return { project: slug, projectName: meta.name, categories, warnings: layer.warnings };
    }
  },
  {
    name: "category_add",
    description: "Create a global category by default, or a project-local ADD when project is provided. Classification always uses that project's effective taxonomy.",
    inputSchema: {
      type: "object",
      properties: {
        project: PROJECT_PROP,
        id: { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
        contract: { type: "string" },
        routeModel: { type: "string" },
        routeEffort: { type: "string", enum: store.VALID_EFFORTS },
        fallbackModel: { type: "string" },
        fallbackEffort: { type: "string", enum: store.VALID_EFFORTS },
        enabled: { type: "boolean" }
      },
      required: ["id", "name", "routeModel", "routeEffort"]
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const id = String(args.id || "").trim().toLowerCase();
      const category = {
        id,
        name: args.name,
        description: args.description || "",
        contract: args.contract || "",
        route: { model: args.routeModel, effort: args.routeEffort },
        fallback: args.fallbackModel == null && args.fallbackEffort == null ? null : { model: args.fallbackModel, effort: args.fallbackEffort },
        enabled: args.enabled !== false
      };
      if (args.project != null) {
        const localRow = store.setProjectCategory(slug, id, "ADD", category);
        return { ok: true, project: slug, projectName: meta.name, localRow, effective: store.getCategory(id, { project: slug }), warnings: store.getProjectCategories(slug).warnings };
      }
      return { ok: true, project: slug, projectName: meta.name, category: store.setCategory(category) };
    }
  },
  {
    name: "category_edit",
    description: "Customize a category for one board (pass project) or edit the shared default for every board (omit project). With project, editing forks the category into that board's own independent copy that no longer follows the shared default; other boards are unaffected. enabled false disables it on that board and enabled true clears that local disable; reset with category_relink to follow the shared default again. Without project you rewrite the shared default that every board without its own copy inherits.",
    inputSchema: {
      type: "object",
      properties: {
        project: PROJECT_PROP,
        id: { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
        contract: { type: "string" },
        routeModel: { type: "string" },
        routeEffort: { type: "string", enum: store.VALID_EFFORTS },
        fallbackModel: { type: "string" },
        fallbackEffort: { type: "string", enum: store.VALID_EFFORTS },
        enabled: { type: "boolean" }
      },
      required: ["id"]
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const id = String(args.id || "").trim().toLowerCase();
      const layer = () => store.getProjectCategories(slug);
      const localRow = () => layer().rows.find((row) => row.id === id) || null;
      if (args.project != null && args.enabled === false) {
        const row = store.setProjectCategory(slug, id, "DISABLE", {});
        return { ok: true, project: slug, id, localRow: { id: row.id, kind: row.kind } };
      }
      if (args.project != null && args.enabled === true && localRow() && localRow().kind === "DISABLE") {
        store.removeProjectCategory(slug, id);
        return { ok: true, project: slug, id, localRow: null };
      }
      const existing = store.getCategory(id, args.project != null ? { project: slug } : void 0);
      if (!existing) throw new Error(`category_edit: no effective category "${args.id}".`);
      const patch = {};
      for (const key of ["name", "description", "contract"]) if (args[key] !== void 0) patch[key] = args[key];
      if (args.routeModel !== void 0 || args.routeEffort !== void 0) patch.route = { model: args.routeModel === void 0 ? existing.route.model : args.routeModel, effort: args.routeEffort === void 0 ? existing.route.effort : args.routeEffort };
      if (args.fallbackModel !== void 0 || args.fallbackEffort !== void 0) patch.fallback = { model: args.fallbackModel === void 0 ? existing.fallback && existing.fallback.model : args.fallbackModel, effort: args.fallbackEffort === void 0 ? existing.fallback && existing.fallback.effort : args.fallbackEffort };
      if (args.project != null) {
        const prior = localRow();
        const kind = prior && prior.kind === "ADD" ? "ADD" : "DETACH";
        const row = store.setProjectCategory(slug, id, kind, Object.assign({}, existing, patch, { id }));
        return { ok: true, project: slug, id, localRow: { id: row.id, kind: row.kind } };
      }
      if (args.enabled !== void 0) patch.enabled = args.enabled;
      const category = store.setCategory(existing.id, patch);
      return { ok: true, project: slug, id: category.id, changed: Object.keys(patch) };
    }
  },
  {
    name: "category_detach",
    description: "Fork a board's category into an independent copy without other edits, so it stops following the shared default. Usually unnecessary: category_edit already forks a board category on any change; use this only to fork one as-is.",
    inputSchema: {
      type: "object",
      properties: { project: PROJECT_PROP, id: { type: "string" } },
      required: ["project", "id"]
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const id = String(args.id || "").trim().toLowerCase();
      const localRow = store.detachCategory(slug, id);
      const layer = store.getProjectCategories(slug);
      return { ok: true, project: slug, id, localRow: { id: localRow.id, kind: localRow.kind } };
    }
  },
  {
    name: "category_relink",
    description: "Reset a board's category to the shared default, dropping its local customization or pin so it follows the shared default again.",
    inputSchema: {
      type: "object",
      properties: { project: PROJECT_PROP, id: { type: "string" } },
      required: ["project", "id"]
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const id = String(args.id || "").trim().toLowerCase();
      const localRow = store.getProjectCategories(slug).rows.find((row) => row.id === id) || null;
      if (!localRow || !["OVERRIDE", "DETACH"].includes(localRow.kind)) throw new Error(`category_relink: "${args.id}" has no local override or detach.`);
      store.removeProjectCategory(slug, id);
      const layer = store.getProjectCategories(slug);
      return { ok: true, project: slug, id, localRow: null };
    }
  },
  {
    name: "global_fallback",
    description: "Read or set the required global routing fallback. Omit model and effort to read it; provide both to set it.",
    inputSchema: {
      type: "object",
      properties: {
        project: PROJECT_PROP,
        model: { type: "string", description: "Claude runtime or discovered Codex model slug." },
        effort: { type: "string", enum: store.VALID_EFFORTS }
      }
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      if (args.model === void 0 && args.effort === void 0) {
        return { project: slug, projectName: meta.name, fallback: store.getRoutingFallback() };
      }
      return { ok: true, project: slug, projectName: meta.name, fallback: store.setRoutingFallback({ model: args.model, effort: args.effort }) };
    }
  },
  {
    name: "category_rm",
    description: "Remove global policy by default. With project, removes that local row or disables an effective global category locally. general cannot be removed or disabled.",
    inputSchema: { type: "object", properties: { project: PROJECT_PROP, id: { type: "string" } }, required: ["id"] },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const id = String(args.id || "").trim().toLowerCase();
      const ticketCount = store.listTickets(slug).filter((ticket) => (ticket.categoryId || ticket.category && ticket.category.id) === id).length;
      if (args.project != null) {
        const row = store.getProjectCategories(slug).rows.find((entry) => entry.id === id);
        const localRow = row ? (store.removeProjectCategory(slug, id), null) : store.setProjectCategory(slug, id, "DISABLE", {});
        return { ok: true, project: slug, projectName: meta.name, id, ticketCount, localRow, effective: store.getCategory(id, { project: slug }), warnings: store.getProjectCategories(slug).warnings };
      }
      if (!store.removeCategory(id)) throw new Error(`category_rm: no category "${args.id}".`);
      return { ok: true, project: slug, projectName: meta.name, id, ticketCount };
    }
  },
  {
    name: "board_config",
    description: "View or replace board-level always-in-scope paths. docs is included by default when the board repo has a docs directory.",
    inputSchema: {
      type: "object",
      properties: {
        project: PROJECT_PROP,
        alwaysInScope: { type: "array", items: { type: "string" }, description: "When supplied, replaces the board paths merged into every ticket scope." }
      }
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const result = args.alwaysInScope == null ? { ok: true, config: store.boardConfig(slug) } : store.setBoardConfig(slug, { alwaysInScope: args.alwaysInScope });
      if (!result.ok) throw new Error(`board_config: no board "${meta.name}".`);
      return { ok: true, project: slug, projectName: meta.name, alwaysInScope: result.config.alwaysInScope };
    }
  },
  {
    name: "models",
    description: "Available models, global fallback, and the effective category taxonomy for project, including project-layer warnings.",
    inputSchema: { type: "object", properties: { project: PROJECT_PROP } },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      return store.modelsPayload({ project: slug });
    }
  },
  {
    name: "projects",
    description: "Every registered board with open/doing/done counts — the switcher across all projects. Pass archived:true to list archived boards only.",
    inputSchema: { type: "object", properties: { archived: { type: "boolean", description: "List archived boards only." } } },
    handler(args) {
      return { projects: store.listProjects({ archived: !!args.archived }) };
    }
  },
  {
    name: "archive_board",
    description: "Archive a board without deleting its tickets. The board reference is required so this cannot target the caller's default board by accident.",
    inputSchema: {
      type: "object",
      properties: { project: { type: "string", description: "Required registered board slug, display name, or path." } },
      required: ["project"]
    },
    handler(args) {
      if (!args.project || !String(args.project).trim()) throw new Error("archive_board: project is required.");
      const { slug, meta } = resolveProject(args.project);
      const result = store.archiveProject(slug);
      if (!result.ok) throw new Error(`archive_board: no board "${args.project}".`);
      return Object.assign({ project: slug, projectName: meta.name }, result);
    }
  },
  {
    name: "unarchive_board",
    description: "Restore an archived board. The board reference is required so this cannot target the caller's default board by accident.",
    inputSchema: {
      type: "object",
      properties: { project: { type: "string", description: "Required registered board slug, display name, or path." } },
      required: ["project"]
    },
    handler(args) {
      if (!args.project || !String(args.project).trim()) throw new Error("unarchive_board: project is required.");
      const { slug, meta } = resolveProject(args.project);
      const result = store.unarchiveProject(slug);
      if (!result.ok) throw new Error(`unarchive_board: no board "${args.project}".`);
      return Object.assign({ project: slug, projectName: meta.name }, result);
    }
  }
];
const MCP_CLI_ONLY_TOOLS = /* @__PURE__ */ new Set([
  "native_agent",
  "native_agent_cleanup"
]);
const TOOL_BY_NAME = new Map(TOOLS.filter((tool) => !MCP_CLI_ONLY_TOOLS.has(tool.name)).map((tool) => [tool.name, tool]));
const MUTATING_TOOLS = /* @__PURE__ */ new Set([
  "add",
  "update",
  "remove",
  "archive",
  "unarchive",
  "claim",
  "sweepClaims",
  "next",
  "done",
  "release",
  "commit",
  "submit",
  "comment",
  "link",
  "unlink",
  "assign",
  "dispatch",
  "category_add",
  "category_edit",
  "category_detach",
  "category_relink",
  "category_rm",
  "archive_board",
  "unarchive_board"
]);
const GLOBAL_MUTATION_TOOLS = /* @__PURE__ */ new Set(["category_add", "category_edit", "category_rm", "global_fallback"]);
const mutationTails = /* @__PURE__ */ new Map();
function toolMutates(name, args) {
  if (MUTATING_TOOLS.has(String(name))) return true;
  if (name === "global_fallback") return args.model !== void 0 || args.effort !== void 0;
  if (name === "board_config") return args.alwaysInScope != null;
  return false;
}
function mutationQueueKey(name, args) {
  if (GLOBAL_MUTATION_TOOLS.has(String(name)) && args.project == null) return "<global>";
  return resolveProject(args.project).slug;
}
async function enqueueMutation(board, operation) {
  const previous = mutationTails.get(board) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  mutationTails.set(board, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (mutationTails.get(board) === tail) mutationTails.delete(board);
  }
}
async function runTool(tool, args) {
  if (!toolMutates(tool.name, args)) return await tool.handler(args);
  const board = mutationQueueKey(tool.name, args);
  return enqueueMutation(board, () => tool.handler(args));
}
function toolDescriptors() {
  return TOOLS.filter((tool) => !MCP_CLI_ONLY_TOOLS.has(tool.name)).map((tool) => ({
    name: tool.name,
    description: TOOL_DESCRIPTION_OVERRIDES[tool.name] || conciseDescription(tool.description),
    inputSchema: compactSchema(tool.inputSchema)
  }));
}
function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}
function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
async function handleRequest(msg) {
  if (!msg || msg.jsonrpc !== "2.0") return null;
  const { id, method, params } = msg;
  const isNotification = id === void 0 || id === null;
  if (method === "initialize") {
    const requested = params && params.protocolVersion;
    return rpcResult(id, {
      protocolVersion: requested || DEFAULT_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: serverVersion() }
    });
  }
  if (method === "notifications/initialized" || method && method.indexOf("notifications/") === 0) {
    return null;
  }
  if (method === "ping") return rpcResult(id, {});
  if (method === "tools/list") {
    return rpcResult(id, { tools: toolDescriptors() });
  }
  if (method === "tools/call") {
    const name = params && params.name;
    const args = params && params.arguments || {};
    const tool = TOOL_BY_NAME.get(name);
    if (!tool) {
      return rpcResult(id, { content: [{ type: "text", text: `Unknown tool "${name}".` }], isError: true });
    }
    try {
      const out = await runTool(tool, args);
      return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] });
    } catch (e) {
      const error = e;
      return rpcResult(id, { content: [{ type: "text", text: `${error && error.message || error}` }], isError: true });
    }
  }
  if (isNotification) return null;
  return rpcError(id, -32601, `Method not found: ${method}`);
}
module.exports = {
  SERVER_NAME,
  DEFAULT_PROTOCOL_VERSION,
  TOOLS,
  toolDescriptors,
  resolveProject,
  handleRequest,
  serverVersion
};
