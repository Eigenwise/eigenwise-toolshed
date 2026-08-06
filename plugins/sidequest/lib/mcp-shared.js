"use strict";
const path = require("path");
const fs = require("fs");
const store = require("./store");
const work = require("./work");
const worktrees = require("./worktrees");
const agentsync = require("./agentsync");
const commitScope = require("./commit-scope");
const publish = require("./publish");
const execNames = require("./exec-names");
const { claimRefusalMessage } = require("./refusal-guidance");
const { assertSidequestInstall, assertDispatchTransport } = require("./dispatch-preflight");
const SERVER_NAME = "sidequest";
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const CATEGORY_TAXONOMY_WARNING = "Category stamped without reading the taxonomy this session — run category_list and confirm the description matches.";
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
    if (ticket && ticket.model === value) return value;
    throw new Error(`${action}: unknown model "${value}"${routeHint} — known: ${store.getModelVocab().models.join(", ")}`);
  }
  return exec.runsModel;
}
const NO_OP_PATHS_SHOWN = 8;
function pathList(paths) {
  const all = Array.isArray(paths) ? paths : [];
  const shown = all.slice(0, NO_OP_PATHS_SHOWN).join(", ");
  return all.length > NO_OP_PATHS_SHOWN ? `${shown} (+${all.length - NO_OP_PATHS_SHOWN} more)` : shown;
}
function hasNoOpVerificationEvidence(ticket) {
  const holder = String(ticket?.claim?.by || "");
  let verificationStarted = false;
  for (const comment of Array.isArray(ticket?.comments) ? ticket.comments : []) {
    if (comment?.by !== holder) continue;
    const body = String(comment.body || "").trim();
    if (body.startsWith("[sidequest:verify-start] ") && body.slice("[sidequest:verify-start] ".length).trim()) {
      verificationStarted = true;
      continue;
    }
    if (verificationStarted && body === "[sidequest:verify-complete] no-op") return true;
  }
  return false;
}
function provenNoOpCloseout(slug, ticket) {
  const workspace = store.dispatchWorkspace(slug, ticket);
  if (!workspace) {
    return { ok: false, detail: "The board cannot locate this dispatch's worktree, so it cannot confirm the run wrote nothing." };
  }
  const scope = store.dispatchDeclaredFiles(ticket);
  const pending = commitScope.scopedWorkPending(workspace.root, scope, { base: workspace.base });
  if (!pending.ok) {
    return { ok: false, detail: `Could not inspect the declared scope in ${workspace.root}: ${pending.message || pending.reason}.` };
  }
  if (!pending.pending) {
    if (hasNoOpVerificationEvidence(ticket)) return { ok: true, root: workspace.root };
    return { ok: false, detail: "Post [sidequest:verify-start] <command>, run the declared verify command, then post [sidequest:verify-complete] no-op before closing a no-change dispatch." };
  }
  const detail = [
    pending.working.length ? `uncommitted ${pathList(pending.working)}` : null,
    pending.committed.length ? `committed but not submitted ${pathList(pending.committed)}` : null
  ].filter(Boolean).join("; ");
  return { ok: false, detail: `Declared scope in ${workspace.root} is not a no-op: ${detail}.` };
}
const PROJECT_PROP = { type: "string", description: "Board (current project)." };
const FILES_PROP = { type: "array", items: { type: "string" }, description: "Declared file scope: paths, or directory prefixes covering everything under them." };
const LABELS_PROP = { type: "array", items: { type: "string" } };
const CONTRACT_PROP = (verb) => ({ type: "array", items: { type: "string" }, description: `Named contracts or interfaces this ticket ${verb}.` });
const MODEL_FILTER_PROP = { type: "string", description: "Filter by resolved model slug." };
const TOOL_DESCRIPTION_OVERRIDES = {
  pulse: "Liveness: status, claim, activity.",
  changes: "THE polling read.",
  ready: "Ready: ref/title rows.",
  story: "Manage stories.",
  story_log: "Story log.",
  checkpoint: "Record candidate; retain claim.",
  sweepClaims: "Release dead claims; live ones stay.",
  next: "Claim the top available ticket.",
  scopeRequest: "Check scope; wait:true returns the ruling.",
  commit: "Commit declared paths from claimed worktree.",
  submit: "Submit verified work and final report.",
  integrate: "Deliver, verify.",
  comment: "Add a durable handoff comment.",
  plan: "Replace a ticket's plan document; never inlined into a briefing.",
  link: "Relate tickets; inverse automatic.",
  remove: "Delete a ticket. Claims need force:true.",
  claim: "Claim before work; pass routed executor and effort, proceed only on ok:true.",
  dispatch: "stable route.",
  done: "Finish with report; stamp actual model and effort.",
  release: "Release.",
  groomClose: "Close an integrated submission.",
  native_agent: "Return the registered native Agent spawn spec for a ticket; pass it to Agent unchanged.",
  archive: "Archive one ticket, or every done ticket.",
  archive_board: "Archive an explicitly named board.",
  assign: "Set a ticket assignee.",
  category_add: "Add category.",
  category_detach: "Pin a board category to its current policy.",
  category_edit: "Edit category.",
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
    for (const key of ["reason", "claim", "expectedExecutor", "derivedEffort", "claimedEffort", "max", "length", "message", "preserved"]) {
      if (result[key] !== void 0) out[key] = result[key];
    }
    return out;
  }
  if (result.advisory) out.advisory = result.advisory;
  return Object.assign(out, changed || {});
}
const QUIET_INTEGRATION_BRANCH_REASONS = ["remote_mode", "already_integrated"];
function integrationBranchAck(outcome) {
  if (!outcome || QUIET_INTEGRATION_BRANCH_REASONS.includes(outcome.reason)) return null;
  return {
    integrationBranch: {
      branch: outcome.branch,
      advanced: !!outcome.advanced,
      reason: outcome.reason,
      message: outcome.message,
      ...outcome.command ? { command: outcome.command } : {}
    }
  };
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
function compactComment(comment, preserveBody = false) {
  const base = {
    id: comment.id,
    at: comment.at,
    by: comment.by,
    kind: comment.kind
  };
  if (comment.bodyOmitted) return Object.assign(base, { bodyOmitted: true });
  const body = preserveBody ? { text: String(comment.body || ""), length: String(comment.body || "").length, truncated: false } : boundedExcerpt(comment.body);
  return Object.assign(base, {
    body: body.text,
    bodyLength: body.length,
    bodyTruncated: body.truncated
  });
}
function preservesFinalReport(ticket, comment) {
  if (!comment) return false;
  if (ticket?.completion?.commentId === comment.id) return true;
  if (ticket?.submission?.commentId === comment.id) return true;
  return ticket?.submission?.by === comment.by && ticket?.submission?.at === comment.at;
}
function compactListRow(ticket) {
  return Object.fromEntries(Object.entries(ticket || {}).filter(([, value]) => value != null && (!Array.isArray(value) || value.length > 0)));
}
function categoryListEntry(category, localRow, ticketCount, full) {
  if (!full) {
    const description = boundedExcerpt(String(category.description || "").replace(/\s+/g, " ").trim());
    return {
      id: category.id,
      name: category.name,
      route: category.route ? { model: category.route.model, effort: category.route.effort } : null,
      description: description.text,
      descriptionLength: description.length,
      descriptionTruncated: description.truncated
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
    ...pulse.oracle ? { oracle: pulse.oracle } : {},
    ...Array.isArray(pulse.warnings) && pulse.warnings.length ? { warnings: pulse.warnings } : {},
    dispatch: pulse.dispatch && {
      state: pulse.dispatch.state,
      executor: pulse.dispatch.executor,
      agentName: pulse.dispatch.agentName,
      outcome: pulse.dispatch.outcome
    },
    ...pulse.scope ? { scope: compactScope(pulse.scope) } : {}
  };
}
function compactScope(scope) {
  const enforced = Array.isArray(scope?.enforced) ? scope.enforced : null;
  const declared = Array.isArray(scope?.declared) ? scope.declared : [];
  const same = enforced && enforced.length === declared.length && enforced.every((file, index) => file === declared[index]);
  return {
    files: enforced || declared,
    ...enforced && !same ? { declared } : {},
    ...scope?.request ? { request: scope.request } : {},
    ...scope?.lastRuling ? { lastRuling: scope.lastRuling } : {}
  };
}
function requiredText(args, key, action) {
  const value = args && args[key] != null ? String(args[key]).trim() : "";
  if (!value) throw new Error(`${action}: "${key}" is required.`);
  return value;
}
function requiredFinalReport(args, action) {
  const body = args && args.body != null ? String(args.body) : "";
  if (!body.trim()) {
    throw new Error(`${action}: "body" is required — the completion comment carries the full final report (changed paths, verification evidence, and anything skipped).`);
  }
  return body;
}
function boundedSubmissionText(value, maxChars = 600) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 16)}… [${text.length} chars]`;
}
function preserveRejectedSubmission(options) {
  const { slug, ticket, by, root, commit, gitRef, verify, reason, message, remedy } = options;
  const quarantineRef = `refs/sidequest/${ticket.ref}-rejected`;
  const validationMessage = boundedSubmissionText(message);
  const failure = `${reason}${validationMessage ? `: ${validationMessage}` : ""}`;
  const preserved = commitScope.preserveCommitRef(root, commit, quarantineRef);
  if (!preserved.ok) {
    const preservationFailure = `${preserved.reason}${preserved.message ? `: ${boundedSubmissionText(preserved.message)}` : ""}`;
    return {
      ok: false,
      ticket,
      reason,
      message: `submit: refused ${ticket.ref}; ${failure}. Could not preserve ${commit} at ${quarantineRef}: ${preservationFailure}. The claim remains active. Remedy: ${remedy}`
    };
  }
  let checkpoint;
  try {
    checkpoint = store.checkpointTicket(slug, ticket.ref, by, {
      commit: preserved.commit,
      worktree: root,
      verify: verify.slice(0, 4e3),
      ttlMinutes: 24 * 60,
      kind: "submission_rejected",
      gitRef: quarantineRef,
      failure: { reason, message: validationMessage },
      commentBody: `Submission validation refused ${ticket.ref}: ${failure}
Preserved: ${preserved.commit} at ${quarantineRef}
Claim retained with a recovery checkpoint.
Remedy: ${remedy}`,
      source: "mcp"
    });
  } catch (error) {
    checkpoint = { ok: false, reason: "checkpoint_error", message: error && error.message || String(error) };
  }
  if (checkpoint && checkpoint.ok) {
    return {
      ok: false,
      ticket: checkpoint.ticket,
      reason,
      message: `submit: refused ${ticket.ref}; ${failure}. Preserved ${preserved.commit} at ${quarantineRef}; the claim and recovery checkpoint remain active. Remedy: ${remedy}`,
      preserved: { commit: preserved.commit, gitRef: quarantineRef, checkpoint: checkpoint.checkpoint }
    };
  }
  const checkpointFailure = `${checkpoint?.reason || "checkpoint_failed"}${checkpoint?.message ? `: ${boundedSubmissionText(checkpoint.message)}` : ""}`;
  return {
    ok: false,
    ticket: store.getTicket(slug, ticket.ref) || ticket,
    reason,
    message: `submit: refused ${ticket.ref}; ${failure}. Preserved ${preserved.commit} at ${quarantineRef}, but the recovery checkpoint failed: ${checkpointFailure}. The claim remains active. Remedy: ${remedy}`,
    preserved: { commit: preserved.commit, gitRef: quarantineRef }
  };
}
function requiredReleaseReason(args) {
  const reason = args && args.reason != null ? String(args.reason).trim() : "";
  if (reason) return reason;
  const oracle = args && args.oracle != null ? String(args.oracle).trim() : "";
  if (oracle) return oracle;
  throw new Error('release: "reason" is required — explain why the claim is being released. An oracle ask may stand in as the reason.');
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
  if (worktrees.canonicalPath(supplied) !== worktrees.canonicalPath(root)) {
    throw new Error(`${action}: worktree must name the git worktree root: ${supplied}`);
  }
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
  CATEGORY_TAXONOMY_WARNING
};
