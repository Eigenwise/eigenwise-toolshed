"use strict";
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs/promises");
const { spawn } = require("node:child_process");
const DEFAULT_MIN_AGE_MS = 3 * 60 * 60 * 1e3;
function git(cwd, args) {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", (error) => {
      resolve({ ok: false, status: null, stdout: "", stderr: String(error.message || "").trim() });
    });
    child.once("close", (status) => {
      resolve({
        ok: status === 0,
        status,
        stdout: Buffer.concat(stdout).toString("utf8").trim(),
        stderr: Buffer.concat(stderr).toString("utf8").trim()
      });
    });
  });
}
function normalize(value) {
  const resolved = path.resolve(String(value));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
function parseWorktreeList(output) {
  return output.split(/\r?\n\r?\n/).filter(Boolean).map((block) => {
    const entry = {};
    for (const line of block.split(/\r?\n/)) {
      const match = /^(worktree|HEAD|branch|locked)\s*(.*)$/.exec(line);
      if (match?.[1] && match[2] != null) entry[match[1].toLowerCase()] = match[2];
    }
    return entry;
  }).filter((entry) => entry.worktree);
}
function isAgentWorktree(repo, worktree) {
  const parent = path.join(repo, ".claude", "worktrees");
  const relative = path.relative(parent, worktree);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) && !relative.includes(path.sep) && path.basename(relative).startsWith("agent-");
}
function ticketForWorktree(tickets, entry) {
  const worktree = normalize(entry.worktree);
  const submitted = tickets.find((ticket) => ticket.submission && ticket.submission.worktree && normalize(ticket.submission.worktree) === worktree);
  if (submitted) return submitted;
  const agentId = String(path.basename(entry.worktree)).replace(/^agent-/, "");
  const dispatched = tickets.find((ticket) => String(ticket.dispatch?.agentId || "") === agentId);
  if (dispatched) return dispatched;
  const ref = /(?:^|[^A-Z0-9])(SQ-\d+)(?:$|[^A-Z0-9])/i.exec(entry.branch || "");
  return ref?.[1] ? tickets.find((ticket) => ticket.ref.toUpperCase() === ref[1].toUpperCase()) || null : null;
}
function localBranchName(ref) {
  const match = /^refs\/heads\/(.+)$/.exec(String(ref || ""));
  return match?.[1] || null;
}
function integrationUpstream(options) {
  const target = options.integrationTarget || {};
  return String(target.upstream || options.upstream || "main");
}
function finalTicket(ticket) {
  return Boolean(ticket && (ticket.archived || ticket.status === "done"));
}
async function worktreeAge(pathname) {
  try {
    const stat = await fs.stat(pathname);
    return Math.max(0, Date.now() - stat.mtimeMs);
  } catch (_) {
    return null;
  }
}
async function patchEquivalence(repo, revision, upstream) {
  const base = await git(repo, ["merge-base", revision, upstream]);
  if (!base.ok || !base.stdout) return { equivalent: false, ahead: null, equivalentCommits: 0, unmatchedCommits: null };
  const [ahead, cherry] = await Promise.all([
    git(repo, ["rev-list", "--count", `${base.stdout}..${revision}`]),
    git(repo, ["cherry", upstream, revision, base.stdout])
  ]);
  const aheadCount = ahead.ok && /^\d+$/.test(ahead.stdout) ? Number(ahead.stdout) : null;
  if (aheadCount == null || !cherry.ok) {
    return { equivalent: false, ahead: aheadCount, equivalentCommits: 0, unmatchedCommits: null };
  }
  const marks = cherry.stdout ? cherry.stdout.split(/\r?\n/).filter(Boolean).map((line) => line[0]) : [];
  const equivalentCommits = marks.filter((mark) => mark === "-").length;
  const unmatchedCommits = marks.filter((mark) => mark !== "-").length;
  return {
    equivalent: marks.length === aheadCount && unmatchedCommits === 0,
    ahead: aheadCount,
    equivalentCommits,
    unmatchedCommits
  };
}
async function reachableFrom(repo, revision, upstream) {
  return (await git(repo, ["merge-base", "--is-ancestor", revision, upstream])).ok;
}
function skippedEntry(entry, ticket, reason, current) {
  return {
    path: entry.worktree,
    branch: entry.branch || null,
    ticket: ticket ? ticket.ref : null,
    clean: null,
    ahead: null,
    reachable: null,
    patchEquivalent: null,
    equivalentCommits: 0,
    unmatchedCommits: null,
    ageMs: null,
    minAgeMs: null,
    oldEnough: null,
    locked: entry.locked || null,
    action: "keep",
    reason,
    current
  };
}
async function classifyWorktree(repo, tickets, entry, currentPath, minAgeMs, upstream) {
  const ticket = ticketForWorktree(tickets, entry);
  const current = normalize(entry.worktree) === normalize(currentPath);
  if (current) return skippedEntry(entry, ticket, "current_worktree", true);
  if (entry.locked) return skippedEntry(entry, ticket, "locked", false);
  if (ticket && !finalTicket(ticket)) return skippedEntry(entry, ticket, "active_ticket", false);
  const [cleanResult, ageMs, patch, reachable] = await Promise.all([
    git(entry.worktree, ["status", "--porcelain"]),
    worktreeAge(entry.worktree),
    patchEquivalence(entry.worktree, "HEAD", upstream),
    reachableFrom(entry.worktree, "HEAD", upstream)
  ]);
  const clean = cleanResult.ok ? cleanResult.stdout === "" : false;
  const oldEnough = ageMs != null && ageMs >= minAgeMs;
  let action = "keep";
  let reason = "not_integrated";
  if (!cleanResult.ok) reason = "status_unknown";
  else if (ticket?.archived) {
    action = "remove";
    reason = "ticket_archived";
  } else if (ticket?.status === "done") {
    action = "remove";
    reason = "ticket_done";
  } else if (reachable) {
    action = "remove";
    reason = "branch_reachable";
  } else if (patch.equivalent) {
    action = "remove";
    reason = "patch_equivalent";
  }
  return {
    path: entry.worktree,
    branch: entry.branch || null,
    ticket: ticket ? ticket.ref : null,
    clean,
    ahead: patch.ahead,
    reachable,
    patchEquivalent: patch.equivalent,
    equivalentCommits: patch.equivalentCommits,
    unmatchedCommits: patch.unmatchedCommits,
    ageMs,
    minAgeMs,
    oldEnough,
    locked: null,
    action,
    reason,
    current: false
  };
}
function backupRoot(options) {
  return options.backupDir || path.join(process.env.SIDEQUEST_HOME || path.join(os.homedir(), ".claude", "sidequest"), "worktree-backups");
}
async function backupDirtyWorktree(repo, entry, upstream, options) {
  const agentId = path.basename(entry.path).replace(/^agent-/, "") || "unknown-agent";
  const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
  const destination = path.join(backupRoot(options), `${agentId}-${timestamp}`);
  await fs.mkdir(destination, { recursive: true });
  const staged = await git(entry.path, ["add", "-A"]);
  if (!staged.ok) throw new Error(staged.stderr || "git add -A failed");
  const diff = await git(entry.path, ["diff", "--cached", "HEAD"]);
  if (!diff.ok) throw new Error(diff.stderr || "git diff --cached HEAD failed");
  const branch = localBranchName(entry.branch);
  const commits = branch ? await git(repo, ["format-patch", "--stdout", `${upstream}..${branch}`]) : { ok: true, stdout: "", stderr: "" };
  if (!commits.ok) throw new Error(commits.stderr || "git format-patch failed");
  await Promise.all([
    fs.writeFile(path.join(destination, "working-tree.patch"), diff.stdout ? `${diff.stdout}
` : "", "utf8"),
    fs.writeFile(path.join(destination, "commits.patch"), commits.stdout ? `${commits.stdout}
` : "", "utf8"),
    fs.writeFile(path.join(destination, "metadata.json"), JSON.stringify({
      worktree: entry.path,
      branch,
      upstream,
      backedUpAt: (/* @__PURE__ */ new Date()).toISOString()
    }, null, 2) + "\n", "utf8")
  ]);
  return destination;
}
async function findOrphanBranches(repo, checkedOutBranches, upstream) {
  const result = await git(repo, ["for-each-ref", "--format=%(refname:short)", "refs/heads/worktree-agent-*"]);
  if (!result.ok) throw new Error(result.stderr || "could not list worktree branches");
  const branches = result.stdout ? result.stdout.split(/\r?\n/).filter(Boolean) : [];
  return Promise.all(branches.filter((branch) => !checkedOutBranches.has(branch)).map(async (branch) => {
    const patch = await patchEquivalence(repo, branch, upstream);
    const reachable = await reachableFrom(repo, branch, upstream);
    return {
      branch,
      ahead: patch.ahead,
      reachable,
      patchEquivalent: patch.equivalent,
      equivalentCommits: patch.equivalentCommits,
      unmatchedCommits: patch.unmatchedCommits,
      action: reachable || patch.equivalent ? "prune" : "keep",
      reason: reachable ? "reachable_orphan" : patch.equivalent ? "patch_equivalent_orphan" : "not_integrated"
    };
  }));
}
async function sweep(repo, tickets, options = {}) {
  const listed = await git(repo, ["worktree", "list", "--porcelain"]);
  if (!listed.ok) throw new Error(listed.stderr || "could not list git worktrees");
  const minAgeMs = Number.isFinite(Number(options.minAgeMs)) && Number(options.minAgeMs) >= 0 ? Number(options.minAgeMs) : DEFAULT_MIN_AGE_MS;
  const upstream = integrationUpstream(options);
  const worktreeList = parseWorktreeList(listed.stdout);
  const candidates = worktreeList.filter((entry) => isAgentWorktree(repo, entry.worktree)).filter((entry) => !options.ticketRef || ticketForWorktree(tickets, entry)?.ref === options.ticketRef);
  const entries = await Promise.all(candidates.map((entry) => classifyWorktree(repo, tickets, entry, options.currentPath || process.cwd(), minAgeMs, upstream)));
  const execute = !!options.execute;
  const removed = [];
  const backups = [];
  const deletedBranches = [];
  const prunedOrphanBranches = [];
  const failures = [];
  if (execute) {
    for (const entry of entries.filter((candidate) => candidate.action === "remove")) {
      if (!entry.clean) {
        try {
          entry.backup = await backupDirtyWorktree(repo, entry, upstream, options);
          backups.push(entry.backup);
        } catch (error) {
          failures.push({ path: entry.path, message: `backup failed: ${error && error.message || error}` });
          continue;
        }
      }
      const result = await git(repo, entry.clean ? ["worktree", "remove", entry.path] : ["worktree", "remove", "--force", entry.path]);
      if (!result.ok) {
        failures.push({ path: entry.path, message: result.stderr || "git worktree remove failed" });
        continue;
      }
      removed.push(entry.path);
      const branch = localBranchName(entry.branch);
      if (!branch) continue;
      const deleted = await git(repo, ["branch", "-D", "--", branch]);
      if (deleted.ok) deletedBranches.push(branch);
      else failures.push({ path: branch, message: deleted.stderr || "git branch delete failed" });
    }
    if (removed.length) {
      const prune = await git(repo, ["worktree", "prune"]);
      if (!prune.ok) failures.push({ path: null, message: prune.stderr || "git worktree prune failed" });
    }
  }
  const remainingList = execute ? await git(repo, ["worktree", "list", "--porcelain"]) : listed;
  if (!remainingList.ok) throw new Error(remainingList.stderr || "could not list git worktrees");
  const remainingWorktrees = parseWorktreeList(remainingList.stdout);
  const checkedOutBranches = new Set(remainingWorktrees.map((entry) => localBranchName(entry.branch)).filter((branch) => !!branch));
  const orphanBranches = options.ticketRef ? [] : await findOrphanBranches(repo, checkedOutBranches, upstream);
  if (execute) {
    for (const entry of orphanBranches.filter((candidate) => candidate.action === "prune")) {
      const deleted = await git(repo, ["branch", "-D", "--", entry.branch]);
      if (deleted.ok) prunedOrphanBranches.push(entry.branch);
      else failures.push({ path: entry.branch, message: deleted.stderr || "git branch delete failed" });
    }
  }
  return {
    dryRun: !execute,
    minAgeMs,
    upstream,
    entries,
    orphanBranches,
    removed,
    backups,
    deletedBranches,
    prunedOrphanBranches,
    counts: {
      removedWorktrees: removed.length,
      backedUpWorktrees: backups.length,
      deletedBranches: deletedBranches.length,
      prunedOrphanBranches: prunedOrphanBranches.length
    },
    failures
  };
}
module.exports = { DEFAULT_MIN_AGE_MS, parseWorktreeList, isAgentWorktree, classifyWorktree, sweep };
