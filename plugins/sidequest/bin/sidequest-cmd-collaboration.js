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
const { fail, resolveProject, workerId, controlPlaneIdentity, sessionId, bodyFromOpts } = require("./sidequest-cmd-shared");
const { modelMark, PRIORITY_MARK } = require("./sidequest-cmd-tickets");
const { validateModelFilter } = require("./sidequest-cmd-execution");
async function cmdSweepClaims(opts) {
  const { slug, meta } = await resolveProject(opts);
  const res = store.sweepStaleClaims({ project: slug, source: opts.source || "cli" });
  if (opts.json) {
    process.stdout.write(JSON.stringify(Object.assign({ project: slug }, res), null, 2) + "\n");
    return;
  }
  const kinds = res.released.map((entry) => entry.kind).filter(Boolean);
  const detail = kinds.length ? `: ${kinds.join(", ")}` : "";
  console.log(`✓ swept ${res.released.length} dead claim(s) from ${meta.name}${detail} (idle backstop ${Math.round(res.idleMs / 6e4)}m, abandoned ${Math.round(res.abandonMs / 6e4)}m)`);
}
async function cmdWorktrees(opts, positional) {
  const action = String(positional[0] || "").toLowerCase();
  if (action && action !== "sweep" || !action && !opts.sweep) {
    fail("worktrees: use `sidequest worktrees sweep` to inspect stale agent worktrees.");
  }
  const minAgeHours = opts["min-age-hours"] == null ? 3 : Number(opts["min-age-hours"]);
  if (!Number.isFinite(minAgeHours) || minAgeHours < 0) fail("worktrees sweep: --min-age-hours must be a non-negative number.");
  const { slug, meta } = await resolveProject(opts);
  let result;
  try {
    result = await worktrees.sweep(meta.path, store.worktreeGcTickets(), {
      execute: !!opts.yes && !opts["dry-run"],
      currentPath: store.nearestRepoRoot(process.cwd()),
      integrationTarget: store.integrationTarget(slug),
      minAgeMs: minAgeHours * 60 * 60 * 1e3
    });
  } catch (error) {
    fail(`worktrees: ${error && error.message || error}`);
  }
  if (opts.json) {
    process.stdout.write(JSON.stringify(Object.assign({ project: slug }, result), null, 2) + "\n");
    if (result.failures.length) process.exitCode = 1;
    return;
  }
  console.log(`worktrees sweep: ${result.dryRun ? "dry run" : "executed"} for ${meta.name} (minimum age ${minAgeHours}h)`);
  for (const entry of result.entries) {
    const ticket = entry.ticket ? ` ${entry.ticket}` : "";
    const ahead = entry.ahead == null ? "?" : entry.ahead;
    console.log(`  ${entry.action.toUpperCase()} ${entry.path}${ticket} [${entry.reason}; ${entry.clean ? "clean" : "dirty"}; ahead ${ahead}; patch-equivalent ${entry.patchEquivalent}; age ${entry.ageMs == null ? "?" : Math.round(entry.ageMs / 6e4) + "m"}]`);
  }
  if (result.dryRun) console.log("  pass --yes to remove the planned worktrees.");
  if (result.removed.length) console.log(`  removed ${result.counts.removedWorktrees} worktree(s) and deleted ${result.counts.deletedBranches} branch(es).`);
  for (const entry of result.salvaged || []) console.log(`  SALVAGED ${entry.path} at ${entry.ref}; recover with ${entry.recovery}`);
  if (result.prunedOrphanBranches.length) console.log(`  pruned ${result.counts.prunedOrphanBranches} orphan worktree branch(es).`);
  for (const failure of result.failures) console.log(`  ERROR ${failure.path || "prune"}: ${failure.message}`);
  if (result.failures.length) process.exitCode = 1;
}
async function cmdRecoverShared(opts) {
  const { meta } = await resolveProject(opts);
  const repo = path.resolve(meta.path);
  const stash = String(opts.stash || "").trim();
  const action = "git reset --hard && git clean -fd";
  if (!stash) fail(`recover-shared: refusing recovery action "${action}"; pass --stash <stash@{n}> with the named stash that preserves this checkout.`);
  if (!opts.yes) fail(`recover-shared: refusing recovery action "${action}"; re-run \`sidequest recover-shared --project "${repo}" --stash ${stash} --yes\` after checking the stash evidence.`);
  let shared = false;
  try {
    shared = (await fs.stat(path.join(repo, ".git"))).isDirectory();
  } catch (_) {
  }
  if (!shared) fail(`recover-shared: refusing recovery action "${action}"; "${repo}" is not a shared checkout.`);
  const git = (args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
  const statusEntries = git(["status", "--porcelain=v1", "-z"]).split("\0").filter(Boolean);
  const dirty = [];
  for (let index = 0; index < statusEntries.length; index += 1) {
    const entry = statusEntries[index];
    dirty.push(entry.slice(3));
    if (/^[RC]/.test(entry.slice(0, 2)) && statusEntries[index + 1]) dirty.push(statusEntries[++index]);
  }
  if (!dirty.length) fail(`recover-shared: refusing recovery action "${action}"; the shared checkout is already clean.`);
  const namedStashes = git(["stash", "list", "--format=%gd"]).split(/\r?\n/).filter(Boolean);
  if (!namedStashes.includes(stash)) fail(`recover-shared: refusing recovery action "${action}"; "${stash}" is not a named stash in "${repo}".`);
  const object = git(["rev-parse", "--verify", `${stash}^{commit}`]);
  const preserved = new Set(git(["stash", "show", "--name-only", "--format=", "--include-untracked", "-z", stash]).split("\0").filter(Boolean));
  const missing = dirty.filter((file) => !preserved.has(file));
  if (missing.length) fail(`recover-shared: refusing recovery action "${action}"; stash ${stash} (${object}) does not preserve: ${missing.join(", ")}.`);
  execFileSync("git", ["reset", "--hard"], { cwd: repo, windowsHide: true, stdio: "ignore" });
  execFileSync("git", ["clean", "-fd"], { cwd: repo, windowsHide: true, stdio: "ignore" });
  const remaining = git(["status", "--porcelain"]);
  if (remaining) fail(`recover-shared: ${action} completed, but the checkout remains dirty:
${remaining}`);
  console.log(`✓ recovered shared checkout with ${action}`);
  console.log(`  preserved evidence: stash ${stash} (${object}) covering ${dirty.join(", ")}`);
}
async function cmdNext(opts) {
  const { slug, meta } = await resolveProject(opts);
  if (!validateModelFilter("next", opts)) return;
  const by = workerId(opts);
  const res = store.claimNext(slug, by, { priority: opts.priority, model: opts.model, category: opts.category, direct: !!opts.direct, reason: opts.reason, source: opts.source || "cli", sessionId: sessionId(opts) });
  if (!res.ok && res.reason) res.message = claimRefusalMessage(res.reason, res.ticket && res.ticket.ref || "next ticket", res.ticket || res.claim);
  if (opts.json) {
    process.stdout.write(JSON.stringify(Object.assign({ project: slug }, res), null, 2) + "\n");
    if (!res.ok) process.exitCode = 1;
    return;
  }
  if (res.ok) {
    const t = res.ticket;
    console.log(`✓ claimed next: ${t.ref} [${t.priority}]  "${t.title}"  as "${by}" — ${meta.name}`);
    if (t.description) console.log(`  ${t.description}`);
  } else {
    process.exitCode = 1;
    console.log(res.message || `No available tickets to claim in ${meta.name}.`);
  }
}
async function cmdWork(opts) {
  const { slug } = await resolveProject(opts);
  const work2 = require("../lib/work");
  const ref = opts.ref ? ` for ${opts.ref}` : "";
  const check = opts.ref ? work2.nativeDispatchRequired(slug, opts.ref) : null;
  const detail = check && check.reason !== "native_agent_required" ? ` ${check.message}` : "";
  fail(`work${ref} is disabled: routed work must use \`native-agent\` followed by the current conversation's Agent tool.${detail}`);
}
async function cmdReconcile(opts) {
  const sid = sessionId(opts);
  const reason = opts.reason || "worker session ended";
  const res = store.reconcileSession(sid, { reason, source: opts.source || "cli" });
  if (opts.json) {
    process.stdout.write(JSON.stringify(Object.assign({ session: sid }, res), null, 2) + "\n");
    return;
  }
  if (!sid) {
    console.log("reconcile: no session id (pass --session or set CLAUDE_SESSION_ID) — nothing to do.");
    return;
  }
  if (res.released.length) console.log(`✓ reconciled ${sid}: released ${res.released.join(", ")} back to todo.`);
  else console.log(`✓ reconciled ${sid}: no outstanding claims to release.`);
}
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
  const acceptedMessage = opts.body == null && opts.message != null;
  const body = await bodyFromOpts(acceptedMessage ? Object.assign({}, opts, { body: opts.message }) : opts, "comment");
  if (!body || !String(body).trim()) fail('comment: -m/--body or --body-file is required, e.g. sidequest comment SQ-3 -m "note"');
  const { slug, meta } = await resolveProject(opts);
  const by = controlPlaneIdentity(opts);
  const res = store.addComment(slug, idOrRef, { by, body, source: opts.source || "cli" });
  if (opts.json) {
    process.stdout.write(JSON.stringify(Object.assign({ project: slug }, res, acceptedMessage ? { acceptedAliases: ["accepted message as body"] } : {}), null, 2) + "\n");
    if (!res.ok) process.exitCode = 1;
    return;
  }
  if (res.ok) {
    console.log(`✓ » comment added to ${res.ticket.ref} by "${by}"  — ${meta.name}`);
    if (acceptedMessage) console.log("  accepted message as body");
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
  const a = positional[0] || opts.ref;
  const verb = positional[1] || opts.type;
  const b = positional[2] || opts.target;
  const acceptedAliases = [
    ...positional[0] == null && opts.ref != null ? ["accepted ref as from"] : [],
    ...positional[1] == null && opts.type != null ? ["accepted type as verb"] : [],
    ...positional[2] == null && opts.target != null ? ["accepted target as to"] : []
  ];
  if (!a || !verb || !b) fail("link: usage — sidequest link SQ-1 <blocks|depends-on|related> SQ-2");
  const { slug, meta } = await resolveProject(opts);
  const res = store.linkTickets(slug, a, verb, b);
  if (opts.json) {
    process.stdout.write(JSON.stringify(Object.assign({ project: slug }, res, acceptedAliases.length ? { acceptedAliases } : {}), null, 2) + "\n");
    if (!res.ok) process.exitCode = 1;
    return;
  }
  if (res.ok) {
    console.log(`✓ linked ${res.from.ref} ${res.type} ${res.to.ref}  — ${meta.name}`);
    for (const acceptedAlias of acceptedAliases) console.log(`  ${acceptedAlias}`);
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
async function cmdReady(opts) {
  const { slug, meta } = await resolveProject(opts);
  if (!validateModelFilter("ready", opts)) return;
  if (opts.json || opts.brief) {
    const payload = store.readyPayload(slug, { model: opts.model, category: opts.category, brief: opts.brief });
    process.stdout.write(JSON.stringify(Object.assign({ project: slug, projectName: meta.name }, payload), null, 2) + "\n");
    return;
  }
  const tickets = store.readyTickets(slug, { model: opts.model, category: opts.category });
  const waves = store.readyWaves(slug, { model: opts.model, category: opts.category });
  const waveDependencies = store.readyWaveDependencies(slug, { model: opts.model, category: opts.category });
  if (!tickets.length) {
    console.log(`Nothing ready to work in ${meta.name}.`);
    return;
  }
  console.log(`${meta.name} — ${tickets.length} ready to work (unclaimed, unblocked):`);
  const printTicket = (t) => {
    const pr = PRIORITY_MARK[t.priority] ? ` ${PRIORITY_MARK[t.priority]}` : "";
    const md = modelMark(t);
    const files = t.files && t.files.length ? `  📁${t.files.length}` : "";
    console.log(`    ${t.ref}${pr}  ${t.title}${files}${md}`);
  };
  if (waves.length > 1) {
    waves.forEach((wave, i) => {
      console.log(i === 0 ? "\n  Wave 1 — safe to run in parallel:" : `
  Wave ${i + 1} — after wave ${i}:`);
      for (const t of wave) printTicket(t);
      for (const dependency of waveDependencies.filter((entry) => wave.some((ticket) => ticket.ref === entry.after))) {
        console.log(`      contract edge: ${dependency.reason}`);
      }
    });
  } else {
    for (const t of tickets) printTicket(t);
  }
  if (tickets.length > 1) {
    if (waves.length > 1) {
      console.log("\nFan out within a wave: one subagent per ticket — each claim --by <id> → do → done. Wait for a wave to clear before starting the next.");
    } else {
      console.log("\nIf these are independent (no shared files), fan out: one subagent per ticket — each claim --by <id> → do → done.");
    }
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
module.exports = { cmdSweepClaims, cmdWorktrees, cmdRecoverShared, cmdNext, cmdWork, cmdReconcile, cmdAssign, cmdRemind, cmdUnremind, cmdComment, cmdComments, cmdLink, cmdUnlink, cmdReady, cmdArchive, cmdUnarchive };
