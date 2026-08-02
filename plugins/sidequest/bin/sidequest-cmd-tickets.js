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
function validatedAddInput(opts) {
  if (!opts.title) fail('add: --title is required (e.g. sidequest add -t "Contact form does not send")');
  if (opts.status != null && !store.VALID_STATUS.includes(String(opts.status).toLowerCase())) {
    fail(`add: invalid status "${opts.status}". Valid statuses: ${store.VALID_STATUS.join(", ")}.`);
  }
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
function addPreview(opts) {
  const priority = store.VALID_PRIORITY.includes(String(opts.priority || "").toLowerCase()) ? String(opts.priority).toLowerCase() : "normal";
  return {
    title: String(opts.title).trim().slice(0, 300) || "Untitled",
    description: String(opts.desc || opts.description || "").trim(),
    status: String(opts.status || "todo").toLowerCase(),
    priority,
    labels: opts.label || [],
    images: opts.image || [],
    files: opts.file ?? opts.files ?? [],
    storyId: opts.story || null,
    source: opts.source || "cli"
  };
}
async function cmdAdd(opts) {
  validatedAddInput(opts);
  if (opts["dry-run"]) {
    const ticket2 = addPreview(opts);
    if (opts.json) {
      process.stdout.write(JSON.stringify({ ok: true, dryRun: true, ticket: ticket2 }, null, 2) + "\n");
      return;
    }
    console.log(`Dry run: would create "${ticket2.title}" [${ticket2.status}/${ticket2.priority}]`);
    console.log(JSON.stringify(ticket2, null, 2));
    return;
  }
  const { slug, meta } = await resolveProject(opts);
  const warnings = [];
  const created = store.createTicket(slug, {
    title: opts.title,
    description: opts.desc || opts.description || "",
    priority: opts.priority,
    status: opts.status,
    labels: opts.label,
    images: opts.image || [],
    files: opts.file ?? opts.files,
    storyId: opts.story,
    source: opts.source || "cli",
    onAssetError: (src) => warnings.push(`could not attach image: ${src}`)
  });
  const ticket = store.getTicket(slug, created.ref) || created;
  if (opts.json) {
    process.stdout.write(JSON.stringify({ ok: true, project: slug, projectName: meta.name, ticket, warnings }, null, 2) + "\n");
    return;
  }
  const pr = PRIORITY_MARK[ticket.priority] ? ` ${PRIORITY_MARK[ticket.priority]}` : "";
  const imgs = ticket.assets.length ? ` (${ticket.assets.length} image${ticket.assets.length > 1 ? "s" : ""})` : "";
  const story = ticket.storyId ? store.getStory(slug, ticket.storyId) : null;
  const st = story ? `  ↳${story.ref}` : "";
  console.log(`✓ ${ticket.ref}${pr}  "${ticket.title}"  [${ticket.status}/${ticket.priority}]${imgs}${st}  — ${meta.name}`);
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
      const asn = t.assignee ? `  👤${t.assignee}` : "";
      const blockers = store.openBlockers(slug, t);
      const blk = blockers.length ? `  ⛔ blocked-by ${blockers.join(",")}` : "";
      const lnk = t.links && t.links.length ? `  ⇄${t.links.length}` : "";
      const cmt = t.comments && t.comments.length ? `  💬${t.comments.length}` : "";
      const files = t.files && t.files.length ? `  📁${t.files.length}` : "";
      console.log(`    ${t.ref}${pr}  ${t.title}${labels}${imgs}${files}${cmt}${lnk}${blk}${asn}`);
    }
  }
}
async function cmdChanges(opts) {
  const { slug, meta } = await resolveProject(opts);
  const changes = store.changesPayload(slug, opts.since);
  process.stdout.write(JSON.stringify(Object.assign({ project: slug, projectName: meta.name }, changes), null, 2) + "\n");
}
async function cmdUpdate(opts, positional) {
  const idOrRef = positional[0];
  if (!idOrRef) fail("update: pass a ticket id or ref, e.g. sidequest update SQ-4 --status done");
  const { slug, meta } = await resolveProject(opts);
  const patch = {};
  if (opts.title != null) patch.title = opts.title;
  if (opts.desc != null || opts.description != null) patch.description = opts.desc != null ? opts.desc : opts.description;
  if (opts.status != null) patch.status = opts.status;
  if (opts.priority != null) patch.priority = opts.priority;
  if (opts.label != null) patch.labels = opts.label;
  if (opts.image != null) patch.images = opts.image;
  if (opts.file != null || opts.files != null) {
    const files = opts.file != null ? opts.file : opts.files;
    patch.files = Array.isArray(files) && files.length === 1 && String(files[0]).toLowerCase() === "none" || String(files).toLowerCase() === "none" ? [] : files;
  }
  if (opts.assignee != null) patch.assignee = opts.assignee;
  if (opts.story != null) patch.storyId = opts.story;
  if (opts.by != null) patch.by = opts.by;
  patch.source = opts.source || "cli";
  const saved = store.updateTicket(slug, idOrRef, patch);
  if (!saved) fail(`update: no ticket "${idOrRef}" in ${meta.name}`);
  const updated = store.getTicket(slug, saved.ref) || saved;
  const warnings = [];
  if (opts.json) {
    process.stdout.write(JSON.stringify({ ok: true, ticket: updated, warnings }, null, 2) + "\n");
    return;
  }
  const story = updated.storyId ? store.getStory(slug, updated.storyId) : null;
  const st = story ? `  ↳${story.ref}` : "";
  console.log(`✓ ${updated.ref} updated  [${updated.status}/${updated.priority}]${st}  "${updated.title}"`);
  for (const warning of warnings) console.log(`  ! ${warning}`);
}
async function cmdRm(opts, positional) {
  const idOrRef = positional[0];
  if (!idOrRef) fail("rm: pass a ticket id or ref, e.g. sidequest rm SQ-4");
  const { slug, meta } = await resolveProject(opts);
  const ticket = store.getTicket(slug, idOrRef);
  if (!ticket) fail(`rm: no ticket "${idOrRef}" in ${meta.name}`);
  if (!store.deleteTicket(slug, ticket.id)) fail(`rm: could not delete "${ticket.ref}" from ${meta.name}`);
  console.log(`✓ removed ${ticket.ref} from ${meta.name}`);
}
module.exports = { cmdAdd, cmdList, cmdChanges, cmdUpdate, cmdRm };
