"use strict";
const path = require("path");
const fs = require("fs");
const store = require("./store");
const agentsync = require("./agentsync");
const publish = require("./publish");
const SERVER_NAME = "sidequest";
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const CATEGORY_TAXONOMY_WARNING = "Category stamped without reading the taxonomy this session — run category_list and confirm the description matches.";
const state = { categoryListServed: false };
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
function requireBy(args, action) {
  const by = args && args.by != null ? String(args.by).trim() : "";
  if (!by) throw new Error(`${action}: "by" is required — a unique per-worker id (e.g. claude-<8 hex>). A shared value breaks the atomic-claim guarantee.`);
  return by;
}
const NO_OP_PATHS_SHOWN = 8;
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
  scopeRequest: "Check scope; auto-approve eligible plugin tests.",
  commit: "Commit declared paths from claimed worktree.",
  submit: "Submit verified work and final report.",
  integrate: "Deliver, verify.",
  comment: "Add a durable handoff comment.",
  plan: "Replace a ticket's plan document; never inlined into a briefing.",
  link: "Relate tickets; inverse automatic.",
  remove: "Delete a ticket. Claims need force:true.",
  claim: "Atomically claim a ticket before work. Pass the routed executor and effort; proceed only when ok:true.",
  dispatch: "Prepare through the ticket's stable route.",
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
    }
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
function requiredReleaseReason(args) {
  const reason = args && args.reason != null ? String(args.reason).trim() : "";
  if (reason) return reason;
  const oracle = args && args.oracle != null ? String(args.oracle).trim() : "";
  if (oracle) return oracle;
  throw new Error('release: "reason" is required — explain why the claim is being released. An oracle ask may stand in as the reason.');
}
function withoutCategories(payload) {
  const { categories, ...trimmed } = payload;
  return trimmed;
}
module.exports = {
  path,
  fs,
  store,
  agentsync,
  publish,
  resolveProject,
  runtimeSessionId,
  sessionOf,
  requireBy,
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
  requiredReleaseReason,
  withoutCategories,
  CATEGORY_TAXONOMY_WARNING,
  state
};
