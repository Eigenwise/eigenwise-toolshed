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
  const recipe = agentsync.workflowRecipe(Object.assign({}, category, { project: slug }), resolved);
  const selected = store.projectRoutingProfile(slug);
  return Object.assign({}, recipe, {
    profile: { id: selected.profile.id, revision: selected.profile.revision },
    categorySource: { kind: category.origin || "profile", baseProfileId: category.baseProfileId || null }
  });
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
function requireKnownModel(action, value, ticket) {
  if (value == null || !String(value).trim()) return value;
  const exec = store.resolveReportedExec(value, null);
  if (!exec) {
    const expected = store.resolvedDispatchRoute(ticket);
    const routeHint = expected ? ` — expected for ${ticket.ref}: ${expected.model}` : "";
    throw new Error(`${action}: unknown model "${value}"${routeHint} — known: ${store.getModelVocab().models.join(", ")}`);
  }
  return exec.runsModel;
}
const PROJECT_PROP = { type: "string", description: "Board (current project)." };
const MODEL_FILTER_PROP = { type: "string", description: "Filter by resolved model slug." };
const TOOL_DESCRIPTION_OVERRIDES = {
  claim: "Atomically claim a ticket before work. Pass the routed executor and effort; proceed only when ok:true.",
  checkpoint: "Record a live review candidate while keeping its claim and dispatch active.",
  dispatch: "Prepare a ticket executor through its stable route.",
  done: "Finish ticket and release its claim. Stamp the actual model and effort.",
  groomClose: "Grooming closure; pass integration:true after a submission is integrated.",
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
  profile_list: "List profiles.",
  profile_get: "Read a profile.",
  profile_create: "Create a profile.",
  profile_edit: "Edit a profile.",
  profile_retire: "Retire a profile.",
  profile_use: "Assign a profile.",
  profile_repoint: "Repoint profile boards.",
  profile_promote: "Promote board routing.",
  new_board_profile: "Read or set the new-board profile.",
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
function validateStoryId(value, allowClear = false) {
  if (allowClear && String(value).toLowerCase() === "none") return;
  if (!/^US-\d+$/.test(String(value))) throw new Error("storyId must be a US-n story ref.");
}
function compactSchema(schema, propertyMap = false) {
  if (Array.isArray(schema)) return schema.map((entry) => compactSchema(entry));
  if (!schema || typeof schema !== "object") return schema;
  const compact = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key !== "description" || propertyMap) {
      compact[key] = compactSchema(value, !propertyMap && key === "properties");
    }
  }
  return compact;
}
const LIST_CHAR_BUDGET = 55e3;
function closeDispatchExecutor(ticket) {
  if (ticket && ticket.dispatchExecutor) agentsync.cleanupNativeAgents({ name: ticket.dispatchExecutor });
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
  if (result.advisory) out.advisory = result.advisory;
  return Object.assign(out, changed || {});
}
const OUT_OF_SCOPE_COMMENT_MAX = 16e3;
function outOfScopeComment(paths) {
  const prefix = "out-of-scope changes present: ";
  const complete = `${prefix}${paths.join(", ")} — widen scope + second commit, or discard`;
  if (complete.length <= OUT_OF_SCOPE_COMMENT_MAX) return complete;
  for (let shown = paths.length - 1; shown >= 0; shown -= 1) {
    const omitted = paths.length - shown;
    const suffix = `… +${omitted} more (run git status in the worktree for the full list)`;
    const body = `${prefix}${paths.slice(0, shown).join(", ")}${shown ? " " : ""}${suffix}`;
    if (body.length <= OUT_OF_SCOPE_COMMENT_MAX) return body;
  }
  return `${prefix}… +${paths.length} more (run git status in the worktree for the full list)`;
}
const COMPACT_RESULT_MAX_BYTES = 13e3;
const COMPACT_PULSE_BODY_MAX_CHARS = 280;
const PAGED_FULL_DEFAULT_LIMIT = 10;
const PAGE_LIMIT_MAX = 100;
const boundedExcerpt = store.boundedExcerpt;
function compactComment(comment) {
  const base = {
    id: comment.id,
    at: comment.at,
    by: comment.by,
    kind: comment.kind
  };
  if (comment.bodyOmitted) return Object.assign(base, { bodyOmitted: true });
  const body = boundedExcerpt(comment.body);
  return Object.assign(base, {
    body: body.text,
    bodyLength: body.length,
    bodyTruncated: body.truncated
  });
}
function categoryListEntry(category, localRow, ticketCount, full) {
  if (!full) {
    const description = boundedExcerpt(category.description);
    return {
      id: category.id,
      name: category.name,
      description: description.text,
      descriptionLength: description.length,
      descriptionTruncated: description.truncated,
      enabled: category.enabled
    };
  }
  return Object.assign({}, category, {
    origin: localRow ? localRow.kind === "ADD" ? "project" : category.linkState : "global",
    localRow: localRow ? { id: localRow.id, kind: localRow.kind } : null,
    ticketCount
  });
}
function pageArguments(args, action) {
  let cursor = 0;
  if (args.cursor != null) {
    const raw = String(args.cursor);
    if (!/^(0|[1-9]\d*)$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
      throw new Error(`${action}: cursor must be a non-negative integer string.`);
    }
    cursor = Number(raw);
  }
  let limit = null;
  if (args.limit != null) {
    limit = Number(args.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_LIMIT_MAX) {
      throw new Error(`${action}: limit must be an integer from 1 to ${PAGE_LIMIT_MAX}.`);
    }
  }
  return { cursor, limit };
}
function pageRows(rows, args, action, buildPayload, maxBytes) {
  const { cursor, limit } = pageArguments(args, action);
  if (cursor > rows.length) throw new Error(`${action}: cursor ${cursor} is past the ${rows.length}-row result.`);
  const maxEnd = Math.min(rows.length, cursor + (limit || rows.length));
  let end = cursor;
  while (end < maxEnd) {
    const candidateEnd = end + 1;
    const candidate = rows.slice(cursor, candidateEnd);
    const nextCursor = candidateEnd < rows.length ? String(candidateEnd) : null;
    const payload = buildPayload(candidate, rows.length, nextCursor);
    if (maxBytes && Buffer.byteLength(JSON.stringify(payload, null, 2), "utf8") > maxBytes) break;
    end = candidateEnd;
  }
  if (end === cursor && cursor < rows.length) {
    throw new Error(`${action}: one compact row exceeds the ${maxBytes}-byte result ceiling; use full:true.`);
  }
  const page = rows.slice(cursor, end);
  return buildPayload(page, rows.length, end < rows.length ? String(end) : null);
}
function pagedPayload(rows, args, action, buildPayload, full) {
  const explicitlyPaged = args.cursor != null || args.limit != null;
  if (full && !explicitlyPaged) return null;
  const pagingArgs = full && args.limit == null ? Object.assign({}, args, { limit: PAGED_FULL_DEFAULT_LIMIT }) : args;
  return pageRows(rows, pagingArgs, action, buildPayload, full ? null : COMPACT_RESULT_MAX_BYTES);
}
function compactPulse(pulse) {
  const lastComment = pulse.lastComment && Object.assign({}, pulse.lastComment, {
    body: boundedExcerpt(pulse.lastComment.body, COMPACT_PULSE_BODY_MAX_CHARS).text
  });
  return {
    ref: pulse.ref,
    status: pulse.status,
    claim: pulse.claim,
    working: pulse.working,
    lastActivityAt: pulse.lastActivityAt,
    lastComment,
    checkpoint: pulse.checkpoint,
    ...Array.isArray(pulse.warnings) && pulse.warnings.length ? { warnings: pulse.warnings } : {},
    dispatch: pulse.dispatch && {
      state: pulse.dispatch.state,
      executor: pulse.dispatch.executor,
      agentName: pulse.dispatch.agentName,
      outcome: pulse.dispatch.outcome
    }
  };
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
function withoutCategories(payload) {
  const { categories, ...trimmed } = payload;
  return trimmed;
}
const TOOLS = [
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
        detail: { type: "boolean", description: "Legacy alias for full." },
        full: { type: "boolean", description: "Include submission, git, and full dispatch lifecycle." }
      },
      required: ["ref"]
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const pulse = store.pulsePayload(slug, args.ref);
      if (!pulse) throw new Error(`pulse: no ticket "${args.ref}" in ${meta.name}`);
      const payload = args.full || args.detail ? withoutCategories(pulse) : compactPulse(pulse);
      return Object.assign({ project: slug }, payload);
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
    name: "story_contract",
    description: "Read or set a story execution contract. Set contract once with frozen decisions, invariants, acceptance evidence, and durable artifact links; omit it to read. Contracts are capped at 4096 UTF-8 bytes.",
    inputSchema: {
      type: "object",
      properties: {
        project: PROJECT_PROP,
        story: { type: "string", description: "Story ref or id." },
        contract: { type: "string", description: "Execution contract body. An empty string clears it." }
      },
      required: ["story"]
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const story = args.contract === void 0 ? store.getStory(slug, args.story) : store.updateStory(slug, args.story, { executionContract: args.contract });
      if (!story) throw new Error(`story_contract: no story "${args.story}" in ${meta.name}`);
      return { ok: true, project: slug, projectName: meta.name, story };
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
      const payload = store.readyPayload(slug, { model: args.model, category: args.category, brief: args.brief !== false });
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
        highStakes: { type: "boolean" },
        labels: { type: "array", items: { type: "string" } },
        files: { type: "array", items: { type: "string" }, description: "Declared file scope (paths or dir prefixes)." },
        produces: { type: "array", items: { type: "string" }, description: "Named contracts or interfaces this ticket produces." },
        changes: { type: "array", items: { type: "string" }, description: "Named contracts or interfaces this ticket changes." },
        consumes: { type: "array", items: { type: "string" }, description: "Named contracts or interfaces this ticket consumes." },
        contractWaiver: { type: "boolean", description: "Explicitly reviewed waiver for contract-edge wave sequencing." },
        readonly: { type: "boolean", description: "Set false for a read-only category when the spike must execute modified code." },
        anchors: { type: "string", maxLength: store.EXECUTOR_ANCHORS_MAX, description: "Executor anchors, verbatim in the task prompt." },
        verify: { type: "string", maxLength: store.EXECUTOR_VERIFY_MAX, description: "Exact verify command, verbatim in the task prompt." },
        storyId: { type: "string", pattern: "^US-\\d+$", description: "A story ref (US-n) to file this ticket into." },
        complexity: { type: "integer", minimum: 1, maximum: 10, description: "Legacy score. Requires why (min 20 chars)." },
        why: { type: "string", description: "Motivation for the complexity score (min 20 chars)." },
        category: { type: "string", description: "Enabled category id from category_list." }
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
      if (args.storyId !== void 0) validateStoryId(args.storyId);
      const created = store.createTicket(slug, {
        title: args.title,
        description: args.description || "",
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
        source: "mcp"
      });
      const ticket = store.getTicket(slug, created.ref) || created;
      const warnings = store.ticketReferenceWarnings(slug, ticket.title, ticket.description);
      warnings.push(...store.ticketCategoryWarnings(ticket));
      if (category && !categoryListServed) warnings.push(CATEGORY_TAXONOMY_WARNING);
      return mutationAck(slug, { ok: true, ticket }, warnings.length ? { warnings } : null);
    }
  },
  {
    name: "update",
    description: 'Edit a ticket by ref. Any omitted field is left unchanged. Re-scoring needs both complexity and a fresh why. Set storyId to "none" to detach. model/effort are not accepted. Deletion is not a status; use the permanent remove tool instead.',
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        project: PROJECT_PROP,
        title: { type: "string" },
        description: { type: "string" },
        priority: { type: "string", enum: store.VALID_PRIORITY },
        status: { type: "string", enum: store.VALID_STATUS },
        highStakes: { type: "boolean" },
        labels: { type: "array", items: { type: "string" } },
        files: { type: "array", items: { type: "string" }, description: "Declared file scope (paths or dir prefixes)." },
        produces: { type: "array", items: { type: "string" }, description: "Named contracts or interfaces this ticket produces." },
        changes: { type: "array", items: { type: "string" }, description: "Named contracts or interfaces this ticket changes." },
        consumes: { type: "array", items: { type: "string" }, description: "Named contracts or interfaces this ticket consumes." },
        contractWaiver: { type: "boolean", description: "Explicitly reviewed waiver for contract-edge wave sequencing." },
        readonly: { type: "boolean", description: "Set false for a read-only category when the spike must execute modified code." },
        anchors: { type: "string", maxLength: store.EXECUTOR_ANCHORS_MAX, description: "Executor anchors, verbatim in the task prompt." },
        verify: { type: "string", maxLength: store.EXECUTOR_VERIFY_MAX, description: "Exact verify command, verbatim in the task prompt." },
        storyId: { anyOf: [{ type: "string", pattern: "^US-\\d+$" }, { const: "none" }] },
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
      for (const k of ["title", "description", "priority", "status", "highStakes", "labels", "files", "complexity"]) {
        if (args[k] !== void 0) patch[k] = args[k];
      }
      if (args.produces !== void 0 || args.changes !== void 0 || args.consumes !== void 0) {
        const existing = store.normalizeContracts((store.getTicket(slug, args.ref) || {}).contracts);
        patch.contracts = {
          produces: args.produces === void 0 ? existing.produces : args.produces,
          changes: args.changes === void 0 ? existing.changes : args.changes,
          consumes: args.consumes === void 0 ? existing.consumes : args.consumes
        };
      }
      if (args.contractWaiver !== void 0) patch.contractWaiver = args.contractWaiver;
      if (args.readonly !== void 0) patch.readonly = args.readonly;
      if (args.anchors !== void 0) patch.executorAnchors = args.anchors;
      if (args.verify !== void 0) patch.executorVerify = args.verify;
      if (args.storyId !== void 0) {
        validateStoryId(args.storyId, true);
        patch.storyId = args.storyId;
      }
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
      const warnings = store.ticketReferenceWarnings(slug, t.title, t.description);
      if (patch.category && !categoryListServed) warnings.push(CATEGORY_TAXONOMY_WARNING);
      return mutationAck(slug, { ok: true, ticket: t }, warnings.length ? { warnings } : null);
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
        return { ok: false, reason: "claimed", ref: ticket.ref, claim: ticket.claim, message: `${ticket.ref} is live-claimed by ${ticket.claim.by}; pass force:true to permanently remove it.` };
      }
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
      if (drift) {
        const ticket = store.getTicket(slug, args.ref);
        const guidance = drift.reason === "executor_mismatch" ? { message: claimRefusalMessage(drift.reason, args.ref, ticket || {}, meta.path) } : {};
        return Object.assign({ ok: false }, drift, guidance);
      }
      const res = store.claimTicket(slug, args.ref, by, { force: !!args.force, direct: !!args.direct, reason: args.reason, token: args.token, executor: args.executor, source: "mcp", sessionId: sessionOf(args) });
      if (!res.ok) res.message = claimRefusalMessage(res.reason, args.ref, res.ticket || res.claim, meta.path);
      return mutationAck(slug, res);
    }
  },
  {
    name: "checkpoint",
    description: "Record a verified live review candidate without releasing the claim or ending the dispatch. Use the returned checkpoint id in linked review findings.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        project: PROJECT_PROP,
        by: { type: "string" },
        commit: { type: "string", pattern: "^[0-9a-fA-F]{7,64}$" },
        worktree: { type: "string", description: "Absolute path to the verified candidate worktree." },
        verify: { type: "string", minLength: 1, maxLength: 4e3, description: "Verification command and result evidence." },
        ttlMinutes: { type: "integer", minimum: 1, maximum: store.MAX_CHECKPOINT_TTL_MIN }
      },
      required: ["ref", "by", "verify"],
      anyOf: [
        { required: ["commit"] },
        { required: ["worktree"] }
      ]
    },
    handler(args) {
      const { slug } = resolveProject(args.project);
      const by = requireBy(args, "checkpoint");
      const res = store.checkpointTicket(slug, args.ref, by, {
        commit: args.commit,
        worktree: args.worktree,
        verify: args.verify,
        ttlMinutes: args.ttlMinutes,
        source: "mcp"
      });
      return mutationAck(slug, res, res.ok ? { checkpoint: res.checkpoint, commentId: res.comment.id } : null);
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
    description: "Finish claimed non-repo or active artifact work; repo work submits, released work uses control-plane grooming. Stamp actual model and effort.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        project: PROJECT_PROP,
        by: { type: "string" },
        model: { type: "string", description: "Concrete runtime model that actually worked this ticket (provenance)." },
        effort: { type: "string", enum: store.VALID_EFFORTS },
        body: { type: "string" },
        session: { type: "string" }
      },
      required: ["ref", "by"]
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const by = requireBy(args, "done");
      const ticket = store.getTicket(slug, args.ref);
      const model = requireKnownModel("done", args.model, ticket);
      const res = store.completeTicket(slug, args.ref, by, { source: "mcp", model, effort: args.effort, body: args.body, sessionId: sessionOf(args) });
      if (res.ok) closeDispatchExecutor(ticket);
      return mutationAck(slug, res);
    }
  },
  {
    name: "groomClose",
    description: "Close an inactive ticket through grooming, or close an integrated submission with integration:true. Requires an evidence reason and records control-plane provenance.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        project: PROJECT_PROP,
        by: { type: "string" },
        reason: { type: "string" },
        integration: { type: "boolean" }
      },
      required: ["ref", "by", "reason"]
    },
    handler(args) {
      const { slug } = resolveProject(args.project);
      const by = requireBy(args, "groomClose");
      const reason = String(args.reason || "").trim();
      if (!reason) throw new Error("groomClose: reason is required.");
      const ticket = store.getTicket(slug, args.ref);
      const purpose = args.integration ? "integration" : "grooming";
      const res = store.completeTicketAsControlPlane(slug, args.ref, { by, reason, purpose });
      if (res.ok) closeDispatchExecutor(ticket);
      return mutationAck(slug, res, res.ok ? { completion: res.ticket.completion } : null);
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
    name: "scopeRequest",
    description: "Request extra declared paths while keeping the executor claim active. The orchestrator approves by updating files, then the same executor continues.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        project: PROJECT_PROP,
        by: { type: "string" },
        files: { type: "array", items: { type: "string" }, minItems: 1, description: "Repository-relative paths to add to the ticket scope." }
      },
      required: ["ref", "by", "files"]
    },
    handler(args) {
      const { slug } = resolveProject(args.project);
      const by = requireBy(args, "scopeRequest");
      const res = store.requestScope(slug, args.ref, by, args.files, { source: "mcp" });
      return mutationAck(slug, res, res.ok ? { scopeRequest: res.scopeRequest, command: res.command } : null);
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
        const message2 = result.reason === "missing_scope" ? `commit: ${ticket.ref} has no declared file scope.` : result.reason === "outside_scope" ? `commit: refused ${ticket.ref}; commit contains paths outside its declared scope: ${(result.outside || []).join(", ")}. Expand scope with: ${store.scopeExpansionCommand(ticket, result.outside)}` : result.reason === "no_existing_scope" ? `commit: ${ticket.ref} has no declared paths that exist in this worktree. Missing: ${(result.missingScopes || []).join(", ")}.` : `commit: git failed: ${result.message || result.reason}`;
        return mutationAck(slug, { ok: false, ticket, reason: result.reason, message: message2 });
      }
      const warnings = [];
      if (result.unscopedPaths.length) {
        const comment = store.addComment(slug, ticket.ref, { by, body: outOfScopeComment(result.unscopedPaths), kind: "comment", source: "mcp" });
        if (!comment.ok) warnings.push(`out-of-scope paths weren't recorded: ${comment.reason}`);
      }
      return mutationAck(slug, { ok: true, ticket }, { commit: result.commit, ...warnings.length ? { warnings } : {} });
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
        base: { type: "string", description: "Optional prior submitted or integrated commit to exclude from this submission range." },
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
      const target = store.integrationTarget(slug);
      const allowedBases = store.submissionBaseCandidates(slug, ticket.ref);
      const range = commitScope.submissionRange(root, {
        commit,
        gitRef,
        upstream: target.upstream,
        integrationBranch: target.branch,
        base: args.base,
        allowedBases,
        baseCandidates: args.base ? [] : store.submissionBaseCandidates(slug, ticket.ref, { integratedOnly: true })
      });
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
        const message = scopedRange.reason === "missing_scope" ? `submit: ${ticket.ref} has no declared file scope, so its range cannot be admitted for integration.` : scopedRange.reason === "outside_scope" ? `submit: refused ${ticket.ref}; submitted range changes paths outside its declared scope: ${scopedRange.outside.join(", ")}. Expand scope with: ${store.scopeExpansionCommand(ticket, scopedRange.outside)}` : `submit: could not inspect ${commit} from this worktree: ${scopedRange.message || scopedRange.reason}`;
        return mutationAck(slug, { ok: false, ticket, reason: scopedRange.reason, message });
      }
      const unscopedPaths = commitScope.unscopedWorkingPaths(root, scope);
      const res = store.submitTicket(slug, args.ref, by, {
        commit: range.commit,
        gitRef,
        range: Object.assign({}, range, { integrationMode: target.mode }),
        verify: args.verify,
        worktree: args.worktree,
        unscopedPaths,
        source: "mcp",
        sessionId: sessionOf(args)
      });
      if (res.ok && args.body != null) {
        const comment = store.addComment(slug, args.ref, { body: String(args.body), by, kind: "comment", source: "mcp" });
        if (!comment.ok) throw new Error(`submit: recorded ${ticket.ref}, but could not add evidence comment: ${comment.reason}`);
        if (comment.advisory) res.advisory = comment.advisory;
      }
      if (res.ok) closeDispatchExecutor(ticket);
      return mutationAck(slug, res);
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
      const comments = full ? history.comments : history.comments.map(compactComment);
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
  },
  {
    name: "dispatch",
    description: "Prepare a token-gated dispatch for a ticket. It returns a stable executor spawn spec and token. Pass spawn unchanged to Agent. Stable executors are ready from session start, so no definition file is involved. A new dispatch in an adopting session rotates the token and returns a current spawn. The claim stays gated on the returned token and executor.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        project: PROJECT_PROP,
        sharedTree: { type: "boolean", description: "Use shared state or leave an explicitly marked artifact." },
        full: { type: "boolean", description: "Include token, executor, warnings, and recovery details." }
      },
      required: ["ref"]
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const descriptionError = store.dispatchDescriptionError(store.getTicket(slug, args.ref));
      if (descriptionError) throw new Error(descriptionError);
      const prepared = store.prepareDispatch(slug, args.ref, { sessionId: requireDispatchSession(), sharedTree: !!args.sharedTree });
      const isolation = agentsync.ticketIsolation(prepared.ticket, prepared.ticket.dispatch && prepared.ticket.dispatch.sharedTree);
      const prompt = agentsync.renderDispatchStub(prepared.ticket, prepared.token, meta.path);
      const resolved = store.resolveExec(prepared.ticket.model, prepared.ticket.effort);
      const agent = prepared.ticket.dispatchExecutor;
      const spawn = agentsync.agentSpawn(agent, isolation, resolved && resolved.model, agent, prompt, agentsync.spawnDescription(prepared.ticket, resolved));
      const compact = {
        ref: prepared.ticket.ref,
        effort: prepared.ticket.effort,
        runsLabel: prepared.ticket.exec && prepared.ticket.exec.runsLabel,
        spawn
      };
      const warnings = store.dispatchWarnings(prepared.ticket, slug);
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
        warnings: store.dispatchWarnings(prepared.ticket, slug),
        spawn,
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
        sharedTree: { type: "boolean", description: "Use shared state or leave an explicitly marked artifact." }
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
      const sharedTree = store.boardConfig(slug)?.worktreeIsolation === false || !!args.sharedTree;
      const created = agentsync.createNativeAgent({
        ref: ticket.ref,
        agentType: resolved.agent || `sidequest-exec-${ticket.effort || "low"}`,
        spawnModel: resolved.model,
        effort: ticket.effort,
        runtime: resolved.runsModel,
        description: agentsync.spawnDescription(ticket, resolved),
        isolation: agentsync.ticketIsolation(ticket, sharedTree),
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
    name: "profile_list",
    description: "List routing profiles.",
    inputSchema: { type: "object", properties: { retired: { type: "boolean" } } },
    handler(args) {
      return { profiles: store.listRoutingProfiles({ retired: !!args.retired }), newBoardProfile: store.routingProfileSettings().newProjectProfileId };
    }
  },
  {
    name: "profile_get",
    description: "Read one routing profile and its categories.",
    inputSchema: { type: "object", properties: { profile: { type: "string" } }, required: ["profile"] },
    handler(args) {
      const profile = store.routingProfileDetails(args.profile);
      if (!profile) throw new Error(`profile_get: no profile "${args.profile}".`);
      return { profile };
    }
  },
  {
    name: "profile_create",
    description: "Create a routing profile by cloning another profile.",
    inputSchema: { type: "object", properties: { profile: { type: "string" }, from: { type: "string" }, name: { type: "string" }, description: { type: "string" } }, required: ["profile"] },
    handler(args) {
      const result = store.createRoutingProfile(args.profile, args);
      return { ok: true, result, profile: store.routingProfileDetails(result.id) };
    }
  },
  {
    name: "profile_edit",
    description: "Edit routing profile metadata.",
    inputSchema: { type: "object", properties: { profile: { type: "string" }, name: { type: "string" }, description: { type: "string" } }, required: ["profile"] },
    handler(args) {
      if (args.name == null && args.description == null) throw new Error("profile_edit: pass name or description.");
      const result = store.editRoutingProfile(args.profile, args);
      return { ok: true, result, profile: store.routingProfileDetails(result.id) };
    }
  },
  {
    name: "profile_retire",
    description: "Retire an unused routing profile.",
    inputSchema: { type: "object", properties: { profile: { type: "string" } }, required: ["profile"] },
    handler(args) {
      return { ok: true, profile: store.retireRoutingProfile(args.profile) };
    }
  },
  {
    name: "profile_use",
    description: "Assign one routing profile to one board.",
    inputSchema: { type: "object", properties: { profile: { type: "string" }, project: PROJECT_PROP, by: { type: "string" } }, required: ["profile", "project"] },
    handler(args) {
      const { slug } = resolveProject(args.project);
      return { ok: true, assignment: store.setProjectRoutingProfile(slug, args.profile, args.by || "mcp") };
    }
  },
  {
    name: "profile_repoint",
    description: "Preview or atomically repoint every board from one profile to another.",
    inputSchema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, dryRun: { type: "boolean" }, by: { type: "string" } }, required: ["from", "to"] },
    handler(args) {
      return store.repointRoutingProfiles(args.from, args.to, { dryRun: !!args.dryRun, assignedBy: args.by || "mcp-repoint" });
    }
  },
  {
    name: "profile_promote",
    description: "Materialize one board taxonomy as a profile and atomically repoint matching boards.",
    inputSchema: {
      type: "object",
      properties: { profile: { type: "string" }, fromProject: PROJECT_PROP, projects: { type: "array", items: PROJECT_PROP, minItems: 1 }, name: { type: "string" }, description: { type: "string" }, by: { type: "string" } },
      required: ["profile", "fromProject", "projects"]
    },
    handler(args) {
      const source = resolveProject(args.fromProject).slug;
      const projects = args.projects.map((project) => resolveProject(project).slug);
      return { ok: true, promotion: store.promoteRoutingProfile(args.profile, source, projects, { name: args.name, description: args.description, assignedBy: args.by || "mcp-promote" }) };
    }
  },
  {
    name: "new_board_profile",
    description: "Read or set the routing profile assigned to new boards.",
    inputSchema: { type: "object", properties: { profile: { type: "string" } } },
    handler(args) {
      if (args.profile != null) store.setNewProjectRoutingProfile(args.profile);
      const profile = store.routingProfileDetails(store.routingProfileSettings().newProjectProfileId);
      return { ok: true, profile };
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
    description: "List project taxonomy; compact descriptions are explicit excerpts. Follow nextCursor; full:true is complete.",
    inputSchema: {
      type: "object",
      properties: {
        project: PROJECT_PROP,
        profile: { type: "string" },
        full: { type: "boolean" },
        cursor: { type: "string", pattern: "^(0|[1-9]\\d*)$" },
        limit: { type: "integer", minimum: 1, maximum: PAGE_LIMIT_MAX }
      }
    },
    handler(args) {
      if (args.project != null && args.profile != null) throw new Error("category_list: pass at most one of profile or project.");
      const full = !!args.full;
      let slug = null;
      let meta = null;
      let profile;
      let layer = { rows: [], warnings: [] };
      let source;
      if (args.profile != null) {
        profile = store.routingProfileDetails(args.profile);
        if (!profile) throw new Error(`category_list: no profile "${args.profile}".`);
        source = profile.categories.map((category) => Object.assign({}, category, { origin: "profile", profileId: profile.id, baseProfileId: profile.id, changedFields: [], warnings: [] }));
      } else {
        ({ slug, meta } = resolveProject(args.project));
        profile = store.projectRoutingProfile(slug).profile;
        layer = store.getProjectCategories(slug);
        source = store.getCategories({ project: slug, withState: true });
      }
      const usage = (id) => slug ? store.listTickets(slug).filter((ticket) => (ticket.categoryId || ticket.category && ticket.category.id) === id).length : 0;
      const categories = source.map((category) => {
        const localRow = layer.rows.find((row) => row.id === category.id) || null;
        return categoryListEntry(category, localRow, usage(category.id), full);
      });
      if (full) {
        for (const localRow of layer.rows.filter((row) => row.kind === "DISABLE")) {
          categories.push({ id: localRow.id, origin: "disabled", localRow: { id: localRow.id, kind: localRow.kind }, effective: null, ticketCount: usage(localRow.id) });
        }
      }
      categoryListServed = true;
      const identity = { id: profile.id, name: profile.name, revision: profile.revision };
      const buildPayload = (page, total, nextCursor) => full ? Object.assign(args.profile != null ? { profile: identity } : { project: slug, projectName: meta.name, profile: identity }, { localRowCount: layer.rows.length, categories: page, warnings: layer.warnings, total, returned: page.length, nextCursor }) : { profile: identity, localRowCount: layer.rows.length, categories: page, total, returned: page.length, nextCursor };
      const paged = pagedPayload(categories, args, "category_list", buildPayload, full);
      if (paged) return paged;
      const complete = buildPayload(categories, categories.length, null);
      delete complete.total;
      delete complete.returned;
      delete complete.nextCursor;
      return complete;
    }
  },
  {
    name: "category_add",
    description: "Create a global category by default, or a project-local ADD when project is provided. Classification always uses that project's effective taxonomy.",
    inputSchema: {
      type: "object",
      properties: {
        project: PROJECT_PROP,
        profile: { type: "string" },
        id: { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
        contract: { type: "string" },
        artifactRoots: { type: "array", items: { type: "string" }, description: "Shared-tree artifact roots. Empty disables." },
        routeModel: { type: "string" },
        routeEffort: { type: "string", enum: store.VALID_EFFORTS },
        fallbackModel: { type: "string" },
        fallbackEffort: { type: "string", enum: store.VALID_EFFORTS },
        enabled: { type: "boolean" }
      },
      required: ["id", "name", "routeModel", "routeEffort"]
    },
    handler(args) {
      if (args.project == null === (args.profile == null)) throw new Error("category_add: pass exactly one of profile or project.");
      const target = args.project != null ? resolveProject(args.project) : null;
      const id = String(args.id || "").trim().toLowerCase();
      const category = {
        id,
        name: args.name,
        description: args.description || "",
        contract: args.contract || "",
        artifactRoots: args.artifactRoots || [],
        route: { model: args.routeModel, effort: args.routeEffort },
        fallback: args.fallbackModel == null && args.fallbackEffort == null ? null : { model: args.fallbackModel, effort: args.fallbackEffort },
        enabled: args.enabled !== false
      };
      if (target) {
        const localRow = store.setProjectCategory(target.slug, id, "ADD", category);
        return { ok: true, project: target.slug, projectName: target.meta.name, localRow, effective: store.getCategory(id, { project: target.slug }), warnings: store.getProjectCategories(target.slug).warnings };
      }
      return { ok: true, profile: args.profile, category: store.setRoutingProfileCategory(args.profile, category) };
    }
  },
  {
    name: "category_edit",
    description: "Customize a category for one board (pass project) or edit the shared default for every board (omit project). With project, editing forks the category into that board's own independent copy that no longer follows the shared default; other boards are unaffected. enabled false disables it on that board and enabled true clears that local disable; reset with category_relink to follow the shared default again. Without project you rewrite the shared default that every board without its own copy inherits.",
    inputSchema: {
      type: "object",
      properties: {
        project: PROJECT_PROP,
        profile: { type: "string" },
        id: { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
        contract: { type: "string" },
        artifactRoots: { type: "array", items: { type: "string" }, description: "Replace shared-tree artifact roots. Empty disables." },
        routeModel: { type: "string" },
        routeEffort: { type: "string", enum: store.VALID_EFFORTS },
        fallbackModel: { type: "string" },
        fallbackEffort: { type: "string", enum: store.VALID_EFFORTS },
        enabled: { type: "boolean" }
      },
      required: ["id"]
    },
    handler(args) {
      if (args.project == null === (args.profile == null)) throw new Error("category_edit: pass exactly one of profile or project.");
      const target = args.project != null ? resolveProject(args.project) : null;
      const slug = target && target.slug;
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
      const existing = args.project != null ? store.getCategory(id, { project: slug }) : store.routingProfileCategory(args.profile, id);
      if (!existing) throw new Error(`category_edit: no effective category "${args.id}".`);
      const patch = {};
      for (const key of ["name", "description", "contract", "artifactRoots"]) if (args[key] !== void 0) patch[key] = args[key];
      if (args.routeModel !== void 0 || args.routeEffort !== void 0) patch.route = { model: args.routeModel === void 0 ? existing.route.model : args.routeModel, effort: args.routeEffort === void 0 ? existing.route.effort : args.routeEffort };
      if (args.fallbackModel !== void 0 || args.fallbackEffort !== void 0) patch.fallback = { model: args.fallbackModel === void 0 ? existing.fallback && existing.fallback.model : args.fallbackModel, effort: args.fallbackEffort === void 0 ? existing.fallback && existing.fallback.effort : args.fallbackEffort };
      if (args.project != null) {
        const prior = localRow();
        const kind = prior && prior.kind === "ADD" ? "ADD" : "DETACH";
        const row = store.setProjectCategory(slug, id, kind, Object.assign({}, existing, patch, { id }));
        return { ok: true, project: slug, id, localRow: { id: row.id, kind: row.kind } };
      }
      if (args.enabled !== void 0) patch.enabled = args.enabled;
      const category = store.setRoutingProfileCategory(args.profile, existing.id, patch);
      return { ok: true, profile: args.profile, id: category.id, changed: Object.keys(patch) };
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
    inputSchema: { type: "object", properties: { project: PROJECT_PROP, profile: { type: "string" }, id: { type: "string" } }, required: ["id"] },
    handler(args) {
      if (args.project == null === (args.profile == null)) throw new Error("category_rm: pass exactly one of profile or project.");
      const target = args.project != null ? resolveProject(args.project) : null;
      const slug = target && target.slug;
      const meta = target && target.meta;
      const id = String(args.id || "").trim().toLowerCase();
      const ticketCount = target ? store.listTickets(slug).filter((ticket) => (ticket.categoryId || ticket.category && ticket.category.id) === id).length : 0;
      if (args.project != null) {
        const row = store.getProjectCategories(slug).rows.find((entry) => entry.id === id);
        const localRow = row ? (store.removeProjectCategory(slug, id), null) : store.setProjectCategory(slug, id, "DISABLE", {});
        return { ok: true, project: slug, projectName: meta.name, id, ticketCount, localRow, effective: store.getCategory(id, { project: slug }), warnings: store.getProjectCategories(slug).warnings };
      }
      if (!store.removeRoutingProfileCategory(args.profile, id)) throw new Error(`category_rm: no category "${args.id}" in profile "${args.profile}".`);
      return { ok: true, profile: args.profile, id, ticketCount };
    }
  },
  {
    name: "board_config",
    description: "Board name, scope, integration, worktree isolation, and setup.",
    inputSchema: {
      type: "object",
      properties: {
        project: PROJECT_PROP,
        name: { type: "string", minLength: 1, description: "Display name only. The board slug, path, tickets, claims, and refs stay unchanged." },
        alwaysInScope: { type: "array", items: { type: "string" }, description: "When supplied, replaces the board paths merged into every ticket scope." },
        integrationMode: { type: "string", enum: ["auto", "local", "remote"], description: "auto is local without origin; local does not push." },
        worktreeIsolation: { type: "boolean", description: "When false, dispatched executors for this board always run in the shared checkout — no isolated worktree. Default true." },
        worktreeSetup: { type: ["string", "null"], maxLength: 1e3, pattern: "^[^\\r\\n]*$", description: "One-line isolated-worktree setup; null clears it." }
      }
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const patch = {};
      if (args.name !== void 0) patch.name = args.name;
      if (args.alwaysInScope != null) patch.alwaysInScope = args.alwaysInScope;
      if (args.integrationMode != null) patch.integrationMode = args.integrationMode;
      if (args.worktreeIsolation !== void 0) patch.worktreeIsolation = args.worktreeIsolation;
      if (args.worktreeSetup !== void 0) patch.worktreeSetup = args.worktreeSetup;
      const result = Object.keys(patch).length ? store.setBoardConfig(slug, patch) : { ok: true, config: store.boardConfig(slug) };
      if (!result.ok) throw new Error(`board_config: no board "${meta.name}".`);
      return Object.assign({ ok: true, project: slug, projectName: result.config.name }, result.config);
    }
  },
  {
    name: "models",
    description: "Available models, global fallback, and compact effective category routes. Pass full:true for configured routes, resolved executors, and warnings.",
    inputSchema: { type: "object", properties: { project: PROJECT_PROP, full: { type: "boolean", description: "Include configured/resolved category detail and warnings." } } },
    handler(args) {
      const { slug } = resolveProject(args.project);
      return store.modelsPayload({ project: slug, full: !!args.full });
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
  "groomClose",
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
  "profile_create",
  "profile_edit",
  "profile_retire",
  "profile_use",
  "profile_repoint",
  "profile_promote",
  "archive_board",
  "unarchive_board"
]);
const GLOBAL_MUTATION_TOOLS = /* @__PURE__ */ new Set(["category_add", "category_edit", "category_rm", "global_fallback", "profile_create", "profile_edit", "profile_retire", "profile_repoint", "profile_promote"]);
const mutationTails = /* @__PURE__ */ new Map();
function toolMutates(name, args) {
  if (MUTATING_TOOLS.has(String(name))) return true;
  if (name === "new_board_profile") return args.profile !== void 0;
  if (name === "global_fallback") return args.model !== void 0 || args.effort !== void 0;
  if (name === "board_config") return args.name !== void 0 || args.alwaysInScope != null || args.integrationMode != null || args.worktreeIsolation !== void 0 || args.worktreeSetup !== void 0;
  return false;
}
function mutationQueueKey(name, args) {
  if (name === "new_board_profile") return "<global>";
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
const MCP_SCHEMA_PROPERTY_DESCRIPTIONS = {
  add: ["complexity"],
  comments: ["full"],
  list: ["detail"]
};
function toolDescriptors() {
  return TOOLS.filter((tool) => !MCP_CLI_ONLY_TOOLS.has(tool.name)).map((tool) => {
    const inputSchema = compactSchema(tool.inputSchema);
    for (const property of MCP_SCHEMA_PROPERTY_DESCRIPTIONS[tool.name] || []) {
      const description = tool.inputSchema.properties?.[property]?.description;
      if (description) inputSchema.properties[property].description = description;
    }
    return {
      name: tool.name,
      description: TOOL_DESCRIPTION_OVERRIDES[tool.name] || conciseDescription(tool.description),
      inputSchema
    };
  });
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
