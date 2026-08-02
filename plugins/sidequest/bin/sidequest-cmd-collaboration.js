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
const { fail, resolveProject, workerId, sessionId, bodyFromOpts } = require("./sidequest-cmd-shared");
const { modelMark, PRIORITY_MARK } = require("./sidequest-cmd-tickets");
const { validateModelFilter } = require("./sidequest-cmd-execution");
async function cmdAssign(opts, positional, clear) {
  const idOrRef = positional[0];
  if (!idOrRef) fail(`${clear ? "unassign" : "assign"}: pass a ticket id or ref, e.g. sidequest ${clear ? "unassign SQ-3" : "assign SQ-3 --to you"}`);
  const { slug, meta } = await resolveProject(opts);
  const who = clear ? null : opts.to != null ? opts.to : opts.by != null ? opts.by : "you";
  const res = store.assignTicket(slug, idOrRef, who, { source: opts.source || "cli" });
  if (opts.json) {
    process.stdout.write(JSON.stringify(Object.assign({ project: slug }, res), null, 2) + "\n");
    if (!res.ok) process.exitCode = 1;
    return;
  }
  if (!res.ok) fail(`${clear ? "unassign" : "assign"}: no ticket "${idOrRef}" in ${meta.name}`);
  if (res.ticket.assignee) console.log(`✓ ${res.ticket.ref} assigned to "${res.ticket.assignee}"  — ${meta.name}`);
  else console.log(`✓ ${res.ticket.ref} unassigned  — ${meta.name}`);
}
const REMINDER_PRESETS = {
  "1h": () => new Date(Date.now() + 60 * 60 * 1e3),
  "3h": () => new Date(Date.now() + 3 * 60 * 60 * 1e3),
  tomorrow: () => {
    const d = new Date(Date.now() + 24 * 60 * 60 * 1e3);
    d.setHours(9, 0, 0, 0);
    return d;
  }
};
async function cmdRemind(opts, positional) {
  const idOrRef = positional[0];
  if (!idOrRef) fail('remind: pass a ticket id or ref and a time, e.g. sidequest remind SQ-3 --in 1h  (or --at "2026-07-05T09:00")');
  const { slug, meta } = await resolveProject(opts);
  let when;
  if (opts.in) {
    const preset = REMINDER_PRESETS[String(opts.in)];
    if (!preset) fail(`remind: --in must be one of ${Object.keys(REMINDER_PRESETS).join("|")}`);
    when = preset();
  } else if (opts.at) {
    when = new Date(String(opts.at));
    if (Number.isNaN(when.getTime())) fail(`remind: couldn't parse --at "${opts.at}"`);
  } else {
    fail('remind: pass --in 1h|3h|tomorrow or --at "<date/time>"');
  }
  const res = store.setReminder(slug, idOrRef, when.toISOString());
  if (opts.json) {
    process.stdout.write(JSON.stringify(Object.assign({ project: slug }, res), null, 2) + "\n");
    if (!res.ok) process.exitCode = 1;
    return;
  }
  if (!res.ok) {
    const reasons = { not_found: `no ticket "${idOrRef}" in ${meta.name}`, bad_fireAt: "bad --at value", in_past: "that time is in the past" };
    fail(`remind: ${reasons[res.reason] || res.reason}`);
  }
  console.log(`✓ reminder set on ${idOrRef} for ${when.toLocaleString()}  — ${meta.name}`);
}
async function cmdUnremind(opts, positional) {
  const idOrRef = positional[0];
  if (!idOrRef) fail("unremind: pass a ticket id or ref, e.g. sidequest unremind SQ-3");
  const { slug, meta } = await resolveProject(opts);
  const res = store.cancelReminder(slug, idOrRef);
  if (opts.json) {
    process.stdout.write(JSON.stringify(Object.assign({ project: slug }, res), null, 2) + "\n");
    if (!res.ok) process.exitCode = 1;
    return;
  }
  if (!res.ok) fail(`unremind: no ticket "${idOrRef}" in ${meta.name}`);
  console.log(res.removed ? `✓ cancelled reminder on ${idOrRef}  — ${meta.name}` : `no pending reminder on ${idOrRef}  — ${meta.name}`);
}
async function cmdComment(opts, positional) {
  const idOrRef = positional[0];
  if (!idOrRef) fail('comment: pass a ticket id or ref, e.g. sidequest comment SQ-3 -m "note"');
  const body = await bodyFromOpts(opts, "comment");
  if (!body || !String(body).trim()) fail('comment: -m/--body or --body-file is required, e.g. sidequest comment SQ-3 -m "note"');
  const { slug, meta } = await resolveProject(opts);
  const by = workerId(opts);
  const res = store.addComment(slug, idOrRef, { by, body, source: opts.source || "cli" });
  if (opts.json) {
    process.stdout.write(JSON.stringify(Object.assign({ project: slug }, res), null, 2) + "\n");
    if (!res.ok) process.exitCode = 1;
    return;
  }
  if (res.ok) {
    console.log(`✓ » comment added to ${res.ticket.ref} by "${by}"  — ${meta.name}`);
    if (res.advisory) console.log(`  advisory: ${res.advisory}`);
  } else {
    process.exitCode = 1;
    const messages = {
      not_found: `no ticket "${idOrRef}" in ${meta.name}.`,
      empty: "comment body cannot be empty.",
      too_long: `comment body is ${res.length} chars, over the ${res.max}-char cap — trim it, or put long-form content in the ticket's plan document (the MCP \`plan\` verb) and point to it here (nothing was stored).`,
      busy: `${idOrRef} is locked right now — retry in a moment.`
    };
    console.log(`✗ ${messages[res.reason] || "comment failed: " + res.reason}`);
  }
}
async function cmdComments(opts, positional) {
  const idOrRef = positional[0];
  if (!idOrRef) fail("comments: pass a ticket id or ref, e.g. sidequest comments SQ-3");
  const { slug, meta } = await resolveProject(opts);
  const t = store.getTicket(slug, idOrRef);
  if (!t) fail(`comments: no ticket "${idOrRef}" in ${meta.name}`);
  const allComments = Array.isArray(t.comments) ? t.comments : [];
  const history = store.commentHistory(allComments, !!opts.full);
  const comments = history.comments;
  if (opts.json) {
    const payload = { project: slug, ticket: t.ref, comments };
    if (history.omittedBodies) Object.assign(payload, { omittedBodies: history.omittedBodies, notice: history.notice });
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    return;
  }
  if (!comments.length) {
    console.log(`No comments on ${t.ref}.`);
    return;
  }
  console.log(`${t.ref} — ${comments.length} comment(s)`);
  if (history.notice) console.log(`  ${history.notice}`);
  for (const c of comments) {
    if (c.bodyOmitted) console.log(`  » [${c.at}] ${c.by} (${c.kind || "comment"}): [body omitted]`);
    else console.log(`  » [${c.at}] ${c.by}: ${c.body}`);
  }
}
async function cmdLink(opts, positional) {
  const a = positional[0];
  const verb = positional[1];
  const b = positional[2];
  if (!a || !verb || !b) fail("link: usage — sidequest link SQ-1 <blocks|depends-on|related> SQ-2");
  const { slug, meta } = await resolveProject(opts);
  const res = store.linkTickets(slug, a, verb, b);
  if (opts.json) {
    process.stdout.write(JSON.stringify(Object.assign({ project: slug }, res), null, 2) + "\n");
    if (!res.ok) process.exitCode = 1;
    return;
  }
  if (res.ok) {
    console.log(`✓ linked ${res.from.ref} ${res.type} ${res.to.ref}  — ${meta.name}`);
  } else {
    process.exitCode = 1;
    const messages = {
      bad_type: `unknown relationship "${verb}" — use blocks, depends-on, or related.`,
      from_not_found: `no ticket "${a}" in ${meta.name}.`,
      to_not_found: `no ticket "${b}" in ${meta.name}.`,
      self: "a ticket cannot link to itself."
    };
    console.log(`✗ ${messages[res.reason] || "link failed: " + res.reason}`);
  }
}
async function cmdUnlink(opts, positional) {
  const a = positional[0];
  const b = positional[1];
  if (!a || !b) fail("unlink: usage — sidequest unlink SQ-1 SQ-2");
  const { slug, meta } = await resolveProject(opts);
  const res = store.unlinkTickets(slug, a, b);
  if (opts.json) {
    process.stdout.write(JSON.stringify(Object.assign({ project: slug }, res), null, 2) + "\n");
    if (!res.ok) process.exitCode = 1;
    return;
  }
  if (res.ok) console.log(`✓ unlinked ${a} ✕ ${b}  — ${meta.name}`);
  else {
    process.exitCode = 1;
    console.log(`✗ unlink failed: ${res.reason === "not_found" ? "one of those tickets does not exist" : res.reason}`);
  }
}
async function cmdArchive(opts, positional) {
  const { slug, meta } = await resolveProject(opts);
  if (opts.done || opts.all || positional[0] === "done" || positional[0] === "all") {
    const res2 = store.archiveAllDone(slug, { source: opts.source || "cli" });
    if (opts.json) {
      process.stdout.write(JSON.stringify(Object.assign({ project: slug }, res2), null, 2) + "\n");
      return;
    }
    const n = res2.archived.length;
    console.log(`✓ archived ${n} done ticket(s)${n ? ": " + res2.archived.join(", ") : ""}  — ${meta.name}`);
    return;
  }
  const idOrRef = positional[0];
  if (!idOrRef) fail("archive: pass a ticket ref, or --done to archive all done. e.g. sidequest archive SQ-3  |  sidequest archive --done");
  const res = store.archiveTicket(slug, idOrRef, { source: opts.source || "cli" });
  if (opts.json) {
    process.stdout.write(JSON.stringify(Object.assign({ project: slug }, res), null, 2) + "\n");
    if (!res.ok) process.exitCode = 1;
    return;
  }
  if (res.ok) console.log(`✓ archived ${res.ticket.ref}  — ${meta.name}`);
  else {
    process.exitCode = 1;
    console.log(`✗ archive: no ticket "${idOrRef}" in ${meta.name}`);
  }
}
async function cmdUnarchive(opts, positional) {
  const idOrRef = positional[0];
  if (!idOrRef) fail("unarchive: pass a ticket ref, e.g. sidequest unarchive SQ-3");
  const { slug, meta } = await resolveProject(opts);
  const res = store.unarchiveTicket(slug, idOrRef, { source: opts.source || "cli" });
  if (opts.json) {
    process.stdout.write(JSON.stringify(Object.assign({ project: slug }, res), null, 2) + "\n");
    if (!res.ok) process.exitCode = 1;
    return;
  }
  if (res.ok) console.log(`✓ restored ${res.ticket.ref}  — ${meta.name}`);
  else {
    process.exitCode = 1;
    console.log(`✗ unarchive: no ticket "${idOrRef}" in ${meta.name}`);
  }
}
module.exports = { cmdAssign, cmdRemind, cmdUnremind, cmdComment, cmdComments, cmdLink, cmdUnlink, cmdArchive, cmdUnarchive };
