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
const { fail, resolveProject, workerId, sessionId, bodyFromOpts, addBodyComment } = require("./sidequest-cmd-shared");
function reportClaimFailure(action, idOrRef, res, meta) {
  process.exitCode = 1;
  console.log(`✗ ${res.message || claimRefusalMessage(res.reason, idOrRef, res.ticket || res.claim, meta.path)}`);
}
function validateModelFilter(action, opts) {
  if (opts.model == null) return true;
  const cls = store.classifyModelFilter(opts.model);
  if (cls !== "unknown") return true;
  const message = `unknown model "${opts.model}" — known: ${store.getModelVocab().models.join(", ")}`;
  process.exitCode = 1;
  if (opts.json) {
    process.stdout.write(JSON.stringify({ ok: false, reason: "unknown_model", message }, null, 2) + "\n");
  } else {
    console.log(`✗ ${action}: ${message}`);
  }
  return false;
}
function claimPlanningWarnings(ticket, projectPath) {
  const warnings = store.ticketPlanningWarnings(ticket, projectPath);
  if (!warnings.length) return [];
  return warnings.map((warning) => `Dispatch context warning: ${warning.replace("Planning-depth warning: ", "")}`);
}
function closeDispatchExecutor(ticket) {
  if (ticket && ticket.dispatchExecutor) agentsync.cleanupNativeAgents({ name: ticket.dispatchExecutor });
}
async function cmdDone(opts, positional) {
  const idOrRef = positional[0];
  if (!idOrRef) fail("done: pass a ticket id or ref, e.g. sidequest done SQ-3");
  const { slug, meta } = await resolveProject(opts);
  const by = workerId(opts);
  const body = await bodyFromOpts(opts, "done");
  const ticket = store.getTicket(slug, idOrRef);
  let res;
  try {
    res = store.completeTicket(slug, idOrRef, by, {
      force: !!opts.force,
      source: opts.source || "cli",
      model: opts.model,
      effort: opts.effort,
      body,
      sessionId: sessionId(opts)
    });
  } catch (e) {
    fail(`done: ${e && e.message || e}`);
  }
  if (res.ok && !res.idempotent) {
    closeDispatchExecutor(ticket);
  }
  if (opts.json) {
    process.stdout.write(JSON.stringify(Object.assign({ project: slug }, res), null, 2) + "\n");
    if (!res.ok) process.exitCode = 1;
    return;
  }
  if (res.ok) {
    console.log(`✓ ${res.ticket.ref} done  — ${meta.name}`);
    if (res.advisory) console.log(`  advisory: ${res.advisory}`);
  } else reportClaimFailure("complete", idOrRef, res, meta);
}
const QUIET_INTEGRATION_BRANCH_REASONS = ["remote_mode", "already_integrated"];
function reportIntegrationBranch(outcome) {
  if (!outcome || QUIET_INTEGRATION_BRANCH_REASONS.includes(outcome.reason)) return;
  console.log(outcome.advanced ? `  ${outcome.message}` : `  ! ${outcome.message}`);
  if (outcome.command) console.log(`    run: ${outcome.command}`);
}
async function cmdGroomClose(opts, positional) {
  const idOrRef = positional[0];
  if (!idOrRef) fail('groom-close: pass a ticket id or ref, e.g. sidequest groom-close SQ-3 --reason "Already shipped in abc1234."');
  const reason = String(opts.reason || "").trim();
  if (!reason) fail("groom-close: pass --reason with the evidence for this administrative closure.");
  const { slug, meta } = await resolveProject(opts);
  const by = workerId(opts);
  const ticket = store.getTicket(slug, idOrRef);
  const purpose = opts.integration ? "integration" : "grooming";
  const res = store.completeTicketAsControlPlane(slug, idOrRef, {
    by,
    reason,
    purpose,
    overrideLegacyScope: !!(opts["override-legacy-scope"] || opts.overrideLegacyScope)
  });
  if (res.ok && !res.idempotent) closeDispatchExecutor(ticket);
  if (res.ok && opts.integration) {
    try {
      const integrationTarget = store.integrationTarget(slug);
      res.integrationBranch = await worktrees.advanceIntegrationBranch(meta.path, {
        integrationTarget,
        submissionCommit: res.ticket.submission ? res.ticket.submission.commit : null,
        submissionWorktree: res.ticket.submission ? res.ticket.submission.worktree : null
      });
      res.worktreeSweep = await worktrees.sweep(meta.path, store.worktreeGcTickets(), {
        execute: true,
        currentPath: store.nearestRepoRoot(process.cwd()),
        integrationTarget,
        ticketRef: res.ticket.ref
      });
    } catch (error) {
      res.worktreeSweep = { failures: [{ path: null, message: error && error.message || String(error) }] };
    }
  }
  if (opts.json) {
    process.stdout.write(JSON.stringify(Object.assign({ project: slug }, res), null, 2) + "\n");
    if (!res.ok) process.exitCode = 1;
    return;
  }
  if (res.ok) {
    console.log(`✓ ${res.ticket.ref} closed after ${purpose}  — ${meta.name}`);
    if (res.advisory) console.log(`  advisory: ${res.advisory}`);
    reportIntegrationBranch(res.integrationBranch);
  } else reportClaimFailure("groom-close", idOrRef, res, meta);
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
function scopeRemedy(ticket, paths) {
  return store.scopeExpansionCommand(ticket, paths);
}
function pendingScopeCommitRefusal(ticket) {
  const request = ticket.scopeRequest;
  if (!request) return null;
  const pending = store.normalizeFiles(request.files);
  const covered = store.normalizeFiles(request.covered);
  const requested = store.normalizeFiles(request.requested || pending);
  const approval = store.scopeExpansionCommand(ticket, requested);
  return `commit: refused ${ticket.ref}; scope approval remains pending for ${pending.join(", ")}.${covered.length ? ` Already effective: ${covered.join(", ")}.` : ""} Approve the request with \`${approval}\` before committing.`;
}
function verifyEmbedsWorktreeRoot(verify, worktreeRoot) {
  if (typeof verify !== "string" || !verify || !worktreeRoot) return false;
  const normalize = (value) => String(value).replace(/[\\/]+/g, "/").replace(/\/+$/, "");
  const root = normalize(path.resolve(worktreeRoot));
  const command = normalize(verify);
  const caseInsensitive = /^[a-z]:\//i.test(root);
  const comparableRoot = caseInsensitive ? root.toLowerCase() : root;
  const comparableCommand = caseInsensitive ? command.toLowerCase() : command;
  let offset = comparableCommand.indexOf(comparableRoot);
  while (offset !== -1) {
    const next = comparableCommand.charAt(offset + comparableRoot.length);
    if (!next || next === "/" || !/[a-z0-9._-]/i.test(next)) return true;
    offset = comparableCommand.indexOf(comparableRoot, offset + comparableRoot.length);
  }
  return false;
}
async function cmdPublish(opts, positional) {
  const publish = require("../lib/publish");
  const sub = positional[0];
  const emit = (payload, failed) => {
    if (opts.json) {
      process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
      if (failed) process.exitCode = 1;
      return true;
    }
    return false;
  };
  if (sub === "queue") {
    const { slug, meta } = await resolveProject(opts);
    const payload = store.submissionsPayload(slug);
    const releaseWindow = await publish.releaseWindow(meta.path, store.boardConfig(slug).integrationBranch);
    for (const ticket of payload.tickets) {
      const readiness = null;
      const admittedScope = Array.isArray(ticket.submission.admittedScope) ? ticket.submission.admittedScope : [];
      ticket.rangeValidation = !readiness.ok ? readiness : !admittedScope.length ? {
        ok: false,
        reason: "missing_scope_snapshot",
        message: "submission has no admitted scope snapshot; re-submit it, or close with the explicit legacy-scope override and a recorded reason."
      } : ticket.submission.base ? commitScope.validateStoredSubmissionRange(meta.path, ticket.submission) : { ok: false, reason: "legacy_submission" };
    }
    const queuePayload = releaseWindow ? Object.assign({ project: slug, releaseWindow }, payload) : Object.assign({ project: slug }, payload);
    if (emit(queuePayload, false)) return;
    if (releaseWindow) {
      const release = releaseWindow.latestRelease ? `${releaseWindow.latestRelease.tag} (${releaseWindow.latestRelease.at})` : "none yet";
      console.log(`release window: ${releaseWindow.fragmentCount} fragment(s), ${releaseWindow.heldCount} held; latest ${release}; ${releaseWindow.integrationBranch} → ${releaseWindow.publishedBranch}; next cut ${releaseWindow.nextScheduledCut}`);
    }
    if (!payload.count) {
      console.log(`no submissions awaiting integration in ${meta.name}.`);
      return;
    }
    console.log(`${payload.count} submission(s) awaiting integration — ${meta.name}:`);
    console.log(`  default delivery: ${payload.delivery || "merge"}`);
    for (const t of payload.tickets) {
      const commits = Array.isArray(t.submission.commits) && t.submission.commits.length ? t.submission.commits : [t.submission.commit];
      const paths = Array.isArray(t.submission.changedPaths) ? t.submission.changedPaths : [];
      console.log(`  ${t.ref}  ${commits.length} commit(s), tip ${t.submission.commit.slice(0, 12)} @ ${t.submission.gitRef}  (by ${t.submission.by}, ${t.submission.at})`);
      console.log(`      commits: ${commits.map((commit) => commit.slice(0, 12)).join(", ")}`);
      console.log(`      paths: ${paths.join(", ") || "(legacy submission: unavailable)"}`);
      if (!t.rangeValidation.ok) {
        const rejectedPaths = Array.isArray(t.rangeValidation.unscopedPaths) && t.rangeValidation.unscopedPaths.length ? t.rangeValidation.unscopedPaths : Array.isArray(t.rangeValidation.outside) ? t.rangeValidation.outside : [];
        const pathSuffix = rejectedPaths.length ? `: ${rejectedPaths.join(", ")}` : "";
        console.log(`      REJECTED: ${t.rangeValidation.reason}${pathSuffix}`);
      }
      if (t.submission.verify) console.log(`      verify: ${t.submission.verify}`);
    }
    return;
  }
  const repo = opts.repo ? path.resolve(String(opts.repo)) : (await resolveProject(opts)).meta.path;
  if (sub === "lock") {
    const res = await publish.acquirePublishLock(repo, {
      by: workerId(opts),
      sessionId: sessionId(opts),
      steal: !!opts.steal,
      transient: true
      // the CLI process exits now; its session holds the lock
    });
    if (emit(res, !res.ok)) return;
    if (res.ok) {
      console.log(`✓ publish lock ${res.reacquired ? "re-acquired" : "acquired"}: ${res.file}`);
    } else {
      process.exitCode = 1;
      const h = res.holder || {};
      console.log(`✗ publish lock held by "${h.by || h.sessionId || "unknown"}" (pid ${h.pid}, since ${h.at}) — retry after it releases, or --steal a dead holder.`);
    }
    return;
  }
  if (sub === "unlock") {
    const res = await publish.releasePublishLock(repo, { by: workerId(opts), sessionId: sessionId(opts), force: !!opts.force });
    if (emit(res, !res.ok)) return;
    if (res.ok) console.log(res.released ? `✓ publish lock released: ${res.file}` : "publish lock was not held.");
    else {
      process.exitCode = 1;
      const h = res.holder || {};
      console.log(`✗ publish lock belongs to "${h.by || h.sessionId || "unknown"}" (pid ${h.pid}, since ${h.at}) — not yours to release without --force.`);
    }
    return;
  }
  if (sub === "status") {
    const res = await publish.publishLockStatus(repo);
    if (emit(res, false)) return;
    if (!res.locked) {
      console.log(`publish lock free: ${res.file}`);
    } else {
      const h = res.holder || {};
      console.log(`publish lock HELD${res.stale ? " (STALE — reclaimable)" : ""}: ${res.file}`);
      console.log(`  by "${h.by || "unknown"}"  session ${h.sessionId || "-"}  pid ${h.pid}  host ${h.host}  since ${h.at}`);
    }
    return;
  }
  fail("publish: expected `sidequest publish lock|unlock|status|queue`");
}
module.exports = { cmdDone, cmdGroomClose, cmdPublish };
