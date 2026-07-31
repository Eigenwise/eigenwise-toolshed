#!/usr/bin/env node
"use strict";
const path = require("path");
const os = require("os");
const fs = require("node:fs/promises");
const http = require("http");
const { spawn, execFileSync } = require("child_process");
const store = require("../lib/store");
const agentsync = require("../lib/agentsync");
const work = require("../lib/work");
const commitScope = require("../lib/commit-scope");
const worktrees = require("../lib/worktrees");
const tempCleanup = require("../lib/temp-cleanup");
const execNames = require("../lib/exec-names");
const { claimRefusalMessage } = require("../lib/refusal-guidance");
const { assertSidequestInstall, assertDispatchTransport } = require("../lib/dispatch-preflight");
const { fail, resolveProject } = require("./sidequest-cmd-shared");
const PRIORITY_MARK = { urgent: "!!", high: "!", normal: "", low: "·" };
function modelMark(t) {
  if (!t.model && !t.effort) return "";
  const ex = t.exec || {};
  const runtime = ex.runsLabel || ex.runsModel || t.model || "any";
  const backend = ex.backend || "claude";
  const effort = t.effort ? ` · ${t.effort}` : "";
  return `  ⚙${runtime} · ${backend}${effort}`;
}
const WHY_MIN = 20;
function failDirectRouting() {
  fail("--model/--effort are no longer set directly — score the task with --complexity (+ --why) and routing is derived from it (see sidequest models for the current ladder)");
}
function failComplexity() {
  fail("--complexity is required on every ticket — an integer 1-10 on the TASK-SHAPE scale: 1-2 subagent-shaped (spec says everything), 3-5 daily-coding-shaped (one area, known pattern), 6-7 complex-agentic-shaped (multi-file, shared contract), 8-10 larger-than-a-sitting (unknown root cause, architecture, research-grade). Normal coding lands ~1-7; 9-10 should fire rarely. Routing (model+effort) is derived from it.");
}
function failWhy() {
  fail("--why is required — motivate the complexity score against the actual task (min 20 chars). This is what makes the score honest.");
}
function guardDirectRouting(opts) {
  if (opts.model != null || opts.effort != null) failDirectRouting();
}
function categoryIdOrFail(slug, category) {
  const id = String(category || "").trim().toLowerCase();
  const valid = store.getCategories({ project: slug, includeDisabled: false }).map((entry) => entry.id);
  if (!valid.includes(id)) fail(`unknown category "${category}" — valid: ${valid.join(", ")}`);
  return id;
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
function categoryEchoLine(ticket) {
  const category = categoryEcho(ticket);
  return category ? `  category: ${category.name} — ${category.description}  [${category.route.model} · ${category.route.effort}]` : "";
}
function validatedAddInput(opts) {
  if (!opts.title) fail('add: --title is required (e.g. sidequest add -t "Contact form does not send")');
  guardDirectRouting(opts);
  const complexity = store.coerceComplexity(opts.complexity);
  const category = opts.category == null ? null : String(opts.category).trim().toLowerCase();
  if (opts.category != null && !category) fail("add: --category needs an id.");
  if (!category && !opts.unclassified && complexity == null) fail("add: pass --category, legacy --complexity + --why, or --unclassified for a deliberately unclassified ticket");
  if (complexity != null && (!opts.why || String(opts.why).trim().length < WHY_MIN)) failWhy();
  if (!category && complexity == null && !opts.unclassified) failComplexity();
  if (opts.status != null && !store.VALID_STATUS.includes(String(opts.status).toLowerCase())) {
    fail(`add: invalid status "${opts.status}". Valid statuses: ${store.VALID_STATUS.join(", ")}.`);
  }
  return { category, complexity };
}
function contractsFromOpts(opts, current) {
  const existing = store.normalizeContracts(current);
  return {
    produces: opts.produces === void 0 ? existing.produces : opts.produces,
    changes: opts.changes === void 0 ? existing.changes : opts.changes,
    consumes: opts.consumes === void 0 ? existing.consumes : opts.consumes
  };
}
function contractWaiverFromOpts(opts) {
  if (opts["contract-waiver"] === void 0) return void 0;
  return opts["contract-waiver"] !== false && String(opts["contract-waiver"]).toLowerCase() !== "false";
}
function readonlyFromOpts(opts) {
  if (opts.readonly === void 0) return void 0;
  const value = String(opts.readonly).toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  fail("--readonly accepts true or false.");
}
function highStakesFromOpts(opts) {
  if (opts["high-stakes"] === void 0) return void 0;
  return String(opts["high-stakes"]).toLowerCase() !== "false";
}
function addPreview(opts, category, complexity) {
  const priority = store.VALID_PRIORITY.includes(String(opts.priority || "").toLowerCase()) ? String(opts.priority).toLowerCase() : "normal";
  return {
    title: String(opts.title).trim().slice(0, 300) || "Untitled",
    description: String(opts.desc || opts.description || "").trim(),
    status: String(opts.status || "todo").toLowerCase(),
    priority,
    highStakes: highStakesFromOpts(opts) || false,
    labels: opts.label || [],
    images: opts.image || [],
    files: opts.file ?? opts.files ?? [],
    contracts: contractsFromOpts(opts),
    contractWaiver: contractWaiverFromOpts(opts) || false,
    readonly: readonlyFromOpts(opts),
    executorAnchors: opts.anchors || "",
    executorVerify: opts.verify || "",
    storyId: opts.story || null,
    category,
    complexity,
    complexityWhy: opts.why || "",
    source: opts.source || "cli"
  };
}
async function cmdAdd(opts) {
  const input = validatedAddInput(opts);
  if (opts["dry-run"]) {
    const ticket2 = addPreview(opts, input.category, input.complexity);
    if (opts.json) {
      process.stdout.write(JSON.stringify({ ok: true, dryRun: true, ticket: ticket2 }, null, 2) + "\n");
      return;
    }
    console.log(`Dry run: would create "${ticket2.title}" [${ticket2.status}/${ticket2.priority}]`);
    console.log(JSON.stringify(ticket2, null, 2));
    return;
  }
  const { slug, meta } = await resolveProject(opts);
  const category = input.category == null ? null : categoryIdOrFail(slug, input.category);
  const warnings = [];
  const created = store.createTicket(slug, {
    title: opts.title,
    description: opts.desc || opts.description || "",
    priority: opts.priority,
    status: opts.status,
    highStakes: highStakesFromOpts(opts),
    labels: opts.label,
    images: opts.image || [],
    files: opts.file ?? opts.files,
    contracts: contractsFromOpts(opts),
    contractWaiver: contractWaiverFromOpts(opts),
    readonly: readonlyFromOpts(opts),
    executorAnchors: opts.anchors,
    executorVerify: opts.verify,
    storyId: opts.story,
    complexity: opts.complexity,
    complexityWhy: opts.why,
    category,
    source: opts.source || "cli",
    onAssetError: (src) => warnings.push(`could not attach image: ${src}`)
  });
  const ticket = store.getTicket(slug, created.ref) || created;
  warnings.push(...store.ticketReferenceWarnings(slug, ticket.title, ticket.description));
  warnings.push(...store.ticketCategoryWarnings(ticket));
  warnings.push(...store.ticketPlanningWarnings(ticket, meta.path));
  if (opts.json) {
    process.stdout.write(JSON.stringify({ ok: true, project: slug, projectName: meta.name, ticket, category: categoryEcho(ticket), warnings }, null, 2) + "\n");
    return;
  }
  const pr = PRIORITY_MARK[ticket.priority] ? ` ${PRIORITY_MARK[ticket.priority]}` : "";
  const imgs = ticket.assets.length ? ` (${ticket.assets.length} image${ticket.assets.length > 1 ? "s" : ""})` : "";
  const story = ticket.storyId ? store.getStory(slug, ticket.storyId) : null;
  const st = story ? `  ↳${story.ref}` : "";
  console.log(`✓ ${ticket.ref}${pr}  "${ticket.title}"  [${ticket.status}/${ticket.priority}]${imgs}${st}${modelMark(ticket)}  — ${meta.name}`);
  const categoryLine = categoryEchoLine(ticket);
  if (categoryLine) console.log(categoryLine);
  for (const w of warnings) console.log(`  ! ${w}`);
  const info = store.readServerInfo();
  if (info && info.url) console.log(`  board: ${info.url}`);
}
async function cmdList(opts) {
  const { slug, meta } = await resolveProject(opts);
  if (opts.json || opts.brief) {
    const payload = store.listPayload(slug, {
      status: opts.status,
      archived: opts.archived,
      brief: opts.brief,
      cursor: opts.cursor,
      limit: opts.limit,
      all: opts.all
    });
    process.stdout.write(JSON.stringify(Object.assign({ project: slug, projectName: meta.name }, payload), null, 2) + "\n");
    return;
  }
  let tickets = store.listTickets(slug);
  tickets = opts.archived ? tickets.filter((t) => t.archived) : tickets.filter((t) => !t.archived);
  if (opts.status) tickets = tickets.filter((t) => t.status === String(opts.status).toLowerCase());
  else if (!opts.all) tickets = tickets.filter((t) => t.status === "todo" || t.status === "doing");
  if (!tickets.length) {
    console.log(`No tickets in ${meta.name}.`);
    return;
  }
  console.log(`${meta.name} — ${tickets.length} ticket(s)`);
  const cols = { todo: "TO DO", doing: "DOING", done: "DONE" };
  for (const status of store.VALID_STATUS) {
    const group = tickets.filter((t) => t.status === status);
    if (!group.length) continue;
    console.log(`
  ${cols[status]} (${group.length})`);
    for (const t of group) {
      const pr = PRIORITY_MARK[t.priority] ? ` ${PRIORITY_MARK[t.priority]}` : "";
      const labels = t.labels.length ? `  #${t.labels.join(" #")}` : "";
      const imgs = t.assets.length ? `  🖼${t.assets.length}` : "";
      const clm = t.claim && t.claim.by ? `  @${t.claim.by}${store.claimReclaimable(t) ? " (reclaimable)" : ""}` : "";
      const asn = t.assignee ? `  👤${t.assignee}` : "";
      const blockers = store.openBlockers(slug, t);
      const blk = blockers.length ? `  ⛔ blocked-by ${blockers.join(",")}` : "";
      const lnk = t.links && t.links.length ? `  ⇄${t.links.length}` : "";
      const cmt = t.comments && t.comments.length ? `  💬${t.comments.length}` : "";
      const files = t.files && t.files.length ? `  📁${t.files.length}` : "";
      const readonly = t.readonlyOverride === false ? "  readonly:false" : "";
      const oracle = store.oracleProjection(t);
      const awaitingOracle = oracle ? `  ${oracle.summary}` : "";
      console.log(`    ${t.ref}${pr}  ${t.title}${labels}${imgs}${files}${readonly}${cmt}${lnk}${blk}${clm}${asn}${modelMark(t)}${awaitingOracle}`);
    }
  }
}
async function cmdPulse(opts, positional) {
  const idOrRef = positional[0];
  if (!idOrRef) fail("pulse: pass a ticket id or ref, e.g. sidequest pulse SQ-3");
  const { slug, meta } = await resolveProject(opts);
  const pulse = store.pulsePayload(slug, idOrRef);
  if (!pulse) fail(`pulse: no ticket "${idOrRef}" in ${meta.name}`);
  process.stdout.write(JSON.stringify(Object.assign({ project: slug, projectName: meta.name }, pulse), null, 2) + "\n");
}
async function cmdChanges(opts) {
  const { slug, meta } = await resolveProject(opts);
  const changes = store.changesPayload(slug, opts.since);
  process.stdout.write(JSON.stringify(Object.assign({ project: slug, projectName: meta.name }, changes), null, 2) + "\n");
}
async function cmdUpdate(opts, positional) {
  const idOrRef = positional[0];
  if (!idOrRef) fail("update: pass a ticket id or ref, e.g. sidequest update SQ-4 --status done");
  guardDirectRouting(opts);
  const { slug, meta } = await resolveProject(opts);
  const current = store.getTicket(slug, idOrRef);
  const patch = {};
  if (opts.title != null) patch.title = opts.title;
  if (opts.desc != null || opts.description != null) patch.description = opts.desc != null ? opts.desc : opts.description;
  if (opts.status != null) patch.status = opts.status;
  if (opts.priority != null) patch.priority = opts.priority;
  if (opts["high-stakes"] !== void 0) patch.highStakes = highStakesFromOpts(opts);
  if (opts.label != null) patch.labels = opts.label;
  if (opts.image != null) patch.images = opts.image;
  if (opts.file != null || opts.files != null) {
    const files = opts.file != null ? opts.file : opts.files;
    patch.files = Array.isArray(files) && files.length === 1 && String(files[0]).toLowerCase() === "none" || String(files).toLowerCase() === "none" ? [] : files;
  }
  if (opts.produces !== void 0 || opts.changes !== void 0 || opts.consumes !== void 0) patch.contracts = contractsFromOpts(opts, current && current.contracts);
  if (opts["contract-waiver"] !== void 0) patch.contractWaiver = contractWaiverFromOpts(opts);
  if (opts.readonly !== void 0) patch.readonly = readonlyFromOpts(opts);
  if (opts.anchors != null) patch.executorAnchors = opts.anchors;
  if (opts.verify != null) patch.executorVerify = opts.verify;
  if (opts.assignee != null) patch.assignee = opts.assignee;
  if (opts.complexity != null) {
    if (!opts.why || String(opts.why).trim().length < WHY_MIN) fail('a changed score needs a fresh motivation — pass --why "<motivation>" (min 20 chars) alongside --complexity');
    patch.complexity = opts.complexity;
    patch.complexityWhy = opts.why;
  }
  if (opts.story != null) patch.storyId = opts.story;
  if (opts.category != null) patch.category = opts.category === "none" ? null : categoryIdOrFail(slug, opts.category);
  if (opts.by != null) patch.by = opts.by;
  patch.source = opts.source || "cli";
  const saved = store.updateTicket(slug, idOrRef, patch);
  if (!saved) fail(`update: no ticket "${idOrRef}" in ${meta.name}`);
  const updated = store.getTicket(slug, saved.ref) || saved;
  const warnings = [
    ...store.ticketReferenceWarnings(slug, patch.title, patch.description),
    ...store.ticketPlanningWarnings(updated, meta.path)
  ];
  if (patch.files !== void 0) {
    const scopeWarning = store.pendingScopeApprovalWarning(updated);
    if (scopeWarning) warnings.push(scopeWarning);
  }
  if (opts.json) {
    process.stdout.write(JSON.stringify({ ok: true, ticket: updated, category: opts.category != null ? categoryEcho(updated) : void 0, warnings }, null, 2) + "\n");
    return;
  }
  const story = updated.storyId ? store.getStory(slug, updated.storyId) : null;
  const st = story ? `  ↳${story.ref}` : "";
  console.log(`✓ ${updated.ref} updated  [${updated.status}/${updated.priority}]${st}${modelMark(updated)}  "${updated.title}"`);
  if (opts.category != null) {
    const categoryLine = categoryEchoLine(updated);
    if (categoryLine) console.log(categoryLine);
  }
  for (const warning of warnings) console.log(`  ! ${warning}`);
}
async function cmdRm(opts, positional) {
  const idOrRef = positional[0];
  if (!idOrRef) fail("rm: pass a ticket id or ref, e.g. sidequest rm SQ-4");
  const { slug, meta } = await resolveProject(opts);
  const ticket = store.getTicket(slug, idOrRef);
  if (!ticket) fail(`rm: no ticket "${idOrRef}" in ${meta.name}`);
  if (ticket.claim && ticket.claim.by && !store.claimReclaimable(ticket) && !opts.force) {
    fail(`rm: ${ticket.ref} is live-claimed by "${ticket.claim.by}"; pass --force to permanently remove it.`);
  }
  if (!store.deleteTicket(slug, ticket.id)) fail(`rm: could not delete "${ticket.ref}" from ${meta.name}`);
  console.log(`✓ removed ${ticket.ref} from ${meta.name}`);
}
module.exports = { cmdAdd, cmdList, cmdPulse, cmdChanges, cmdUpdate, cmdRm, PRIORITY_MARK, modelMark, categoryIdOrFail, categoryEcho, categoryEchoLine, contractsFromOpts, contractWaiverFromOpts, readonlyFromOpts, highStakesFromOpts };
