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
  const upstream = String(target.upstream || options.upstream || "").trim();
  if (!upstream) throw new Error("worktree sweep requires the board integration target.");
  return upstream;
}
function finalTicket(ticket) {
  return Boolean(ticket && (ticket.archived || ticket.status === "done"));
}
function liveClaimTicket(ticket) {
  return Boolean(ticket && ticket.claimLive);
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
  if (liveClaimTicket(ticket)) return skippedEntry(entry, ticket, "live_claim", false);
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
  } else if (!oldEnough) reason = "too_young";
  else if (reachable) {
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
async function orphanDirectories(repo, registered) {
  const parent = path.join(repo, ".claude", "worktrees");
  try {
    const entries = await fs.readdir(parent, { withFileTypes: true });
    const directories = entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(parent, entry.name));
    return Promise.all(directories.filter((directory) => !registered.has(normalize(directory))).map(async (directory) => {
      try {
        await fs.lstat(path.join(directory, ".git"));
        return null;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      return { worktree: directory, branch: null, orphanDirectory: true };
    })).then((entries2) => entries2.filter(Boolean));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}
async function classifyOrphanDirectory(tickets, entry, minAgeMs) {
  const ticket = ticketForWorktree(tickets, entry);
  if (ticket && !finalTicket(ticket)) return skippedEntry(entry, ticket, "active_ticket", false);
  if (liveClaimTicket(ticket)) return skippedEntry(entry, ticket, "live_claim", false);
  const [ageMs, contents] = await Promise.all([worktreeAge(entry.worktree), fs.readdir(entry.worktree)]);
  const oldEnough = ageMs != null && ageMs >= minAgeMs;
  if (!oldEnough) return skippedEntry(entry, ticket, "too_young", false);
  return {
    path: entry.worktree,
    branch: null,
    ticket: ticket ? ticket.ref : null,
    clean: contents.length === 0,
    ahead: null,
    reachable: null,
    patchEquivalent: null,
    equivalentCommits: 0,
    unmatchedCommits: null,
    ageMs,
    minAgeMs,
    oldEnough,
    locked: null,
    action: "remove",
    reason: "orphan_directory",
    current: false,
    orphanDirectory: true
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
async function backupDirtyOrphanDirectory(entry, options) {
  const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
  const destination = path.join(backupRoot(options), `orphan-${path.basename(entry.path)}-${timestamp}`);
  await fs.mkdir(destination, { recursive: true });
  await fs.cp(entry.path, path.join(destination, "contents"), { recursive: true, errorOnExist: true });
  await fs.writeFile(path.join(destination, "metadata.json"), JSON.stringify({
    worktree: entry.path,
    backedUpAt: (/* @__PURE__ */ new Date()).toISOString(),
    reason: "unregistered worktree directory without .git metadata"
  }, null, 2) + "\n", "utf8");
  return destination;
}
async function findOrphanBranches(repo, checkedOutBranches, upstream, maxCandidates) {
  const result = await git(repo, ["for-each-ref", "--format=%(refname:short)", "refs/heads/worktree-agent-*"]);
  if (!result.ok) throw new Error(result.stderr || "could not list worktree branches");
  const branches = result.stdout ? result.stdout.split(/\r?\n/).filter(Boolean) : [];
  return Promise.all(branches.filter((branch) => !checkedOutBranches.has(branch)).slice(0, maxCandidates).map(async (branch) => {
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
async function repositoryBusy(repo) {
  const states = await Promise.all(["REBASE_HEAD", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"].map((ref) => git(repo, ["rev-parse", "--verify", "--quiet", ref])));
  return states.some((state) => state.ok);
}
function shortCommit(commit) {
  return String(commit || "").slice(0, 12);
}
function quoted(value) {
  return `"${value}"`;
}
function mergeCommand(repo, commit) {
  return `git -C ${quoted(repo)} merge --ff-only ${commit}`;
}
async function resolveCommit(repo, revision) {
  const result = await git(repo, ["rev-parse", "--verify", "--quiet", `${revision}^{commit}`]);
  return result.ok && /^[0-9a-f]{40}$/.test(result.stdout) ? result.stdout : null;
}
async function checkoutState(repo) {
  const [head, status] = await Promise.all([
    git(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    git(repo, ["status", "--porcelain", "--untracked-files=no"])
  ]);
  return {
    branch: head.ok && head.stdout ? head.stdout : null,
    trackedClean: status.ok && status.stdout === ""
  };
}
function advanceOutcome(fields) {
  return Object.assign({
    attempted: true,
    advanced: false,
    mode: null,
    branch: null,
    from: null,
    to: null,
    reason: "unknown",
    message: "",
    command: null,
    candidates: []
  }, fields);
}
async function integrationCandidates(repo, options, branchHead, submissionCommit) {
  const listed = await git(repo, ["worktree", "list", "--porcelain"]);
  if (!listed.ok) throw new Error(listed.stderr || "could not list git worktrees");
  const executorWorktree = options.submissionWorktree ? normalize(options.submissionWorktree) : null;
  const heads = /* @__PURE__ */ new Map();
  for (const entry of parseWorktreeList(listed.stdout)) {
    const commit = String(entry.head || "").trim();
    if (!/^[0-9a-f]{40}$/.test(commit) || commit === branchHead) continue;
    if (isAgentWorktree(repo, entry.worktree)) continue;
    if (executorWorktree && normalize(entry.worktree) === executorWorktree) continue;
    if (!heads.has(commit)) heads.set(commit, entry.worktree);
  }
  return Promise.all([...heads].map(async ([commit, worktree]) => {
    const [fastForward, patch] = await Promise.all([
      reachableFrom(repo, branchHead, commit),
      patchEquivalence(repo, submissionCommit, commit)
    ]);
    return { commit, worktree, fastForward, carriesWork: patch.equivalent };
  }));
}
async function advanceIntegrationBranch(repo, options = {}) {
  try {
    return await advanceLocalIntegrationBranch(repo, options);
  } catch (error) {
    const branch = String((options.integrationTarget || {}).branch || "").trim() || null;
    return advanceOutcome({
      branch,
      reason: "error",
      message: `${branch || "the integration branch"} was left unadvanced: ${error && error.message || error}.`
    });
  }
}
async function advanceLocalIntegrationBranch(repo, options) {
  const target = options.integrationTarget || {};
  const mode = String(target.mode || "").trim();
  const branch = String(target.branch || "").trim();
  if (!branch) throw new Error("advancing the integration branch requires the board integration target.");
  if (mode !== "local") {
    return advanceOutcome({
      attempted: false,
      mode,
      branch,
      reason: "remote_mode",
      message: `integration mode is "${mode || "unset"}", so ${branch} advances by push and nothing is advanced locally.`
    });
  }
  const branchHead = await resolveCommit(repo, `refs/heads/${branch}`);
  if (!branchHead) {
    return advanceOutcome({
      mode,
      branch,
      reason: "branch_missing",
      message: `local integration branch ${branch} does not exist in ${repo}, so the integrated commit has nothing to fast-forward.`
    });
  }
  const submitted = String(options.submissionCommit || "").trim().toLowerCase();
  if (!submitted) {
    return advanceOutcome({
      mode,
      branch,
      from: branchHead,
      reason: "submission_commit_missing",
      message: `${branch} was left at ${shortCommit(branchHead)}: this closure carries no submitted commit, so no integrated commit can be proven and the branch is not moved.`
    });
  }
  const submissionCommit = await resolveCommit(repo, submitted);
  if (!submissionCommit) {
    return advanceOutcome({
      mode,
      branch,
      from: branchHead,
      reason: "submission_commit_unresolvable",
      message: `${branch} was left at ${shortCommit(branchHead)}: submitted commit ${shortCommit(submitted)} is not in ${repo}, so which commit integrated it cannot be proven.`,
      command: mergeCommand(repo, "<integrated-commit>")
    });
  }
  if ((await patchEquivalence(repo, submissionCommit, branchHead)).equivalent) {
    return advanceOutcome({
      mode,
      branch,
      from: branchHead,
      to: branchHead,
      reason: "already_integrated",
      message: `${branch} already carries ${shortCommit(submissionCommit)} at ${shortCommit(branchHead)}; nothing to advance.`
    });
  }
  const candidates = await integrationCandidates(repo, options, branchHead, submissionCommit);
  const carrying = candidates.filter((candidate) => candidate.carriesWork);
  const advanceable = carrying.filter((candidate) => candidate.fastForward);
  if (!carrying.length) {
    return advanceOutcome({
      mode,
      branch,
      from: branchHead,
      reason: "no_integrated_commit",
      candidates,
      message: `${branch} was left at ${shortCommit(branchHead)}: no checkout of ${repo} holds a commit carrying submitted ${shortCommit(submissionCommit)}, so the integrated commit could not be identified.`,
      command: mergeCommand(repo, "<integrated-commit>")
    });
  }
  if (!advanceable.length) {
    const blocked = carrying.map((candidate) => shortCommit(candidate.commit)).join(", ");
    return advanceOutcome({
      mode,
      branch,
      from: branchHead,
      reason: "not_fast_forward",
      candidates,
      message: `${branch} was left at ${shortCommit(branchHead)}: the integrated commit(s) ${blocked} do not descend from it, so advancing would need a merge or a rewrite. Refusing — resolve the divergence by hand.`
    });
  }
  if (advanceable.length > 1) {
    const listed = advanceable.map((candidate) => `${shortCommit(candidate.commit)} (${candidate.worktree})`).join(", ");
    return advanceOutcome({
      mode,
      branch,
      from: branchHead,
      reason: "ambiguous_integrated_commit",
      candidates,
      message: `${branch} was left at ${shortCommit(branchHead)}: ${advanceable.length} checkouts carry this work — ${listed} — so the integrated commit is ambiguous.`,
      command: mergeCommand(repo, "<integrated-commit>")
    });
  }
  const to = advanceable[0].commit;
  const common = { mode, branch, from: branchHead, to, candidates };
  if (await repositoryBusy(repo)) {
    return advanceOutcome(Object.assign({
      reason: "repository_busy",
      message: `${branch} was left at ${shortCommit(branchHead)}: ${repo} is mid merge, rebase, cherry-pick or revert, so it must not be fast-forwarded to ${shortCommit(to)} now.`,
      command: mergeCommand(repo, to)
    }, common));
  }
  const state = await checkoutState(repo);
  if (state.branch !== branch) {
    const checkedOut = state.branch ? `"${state.branch}"` : "a detached HEAD";
    return advanceOutcome(Object.assign({
      reason: "branch_not_checked_out",
      message: `${branch} was left at ${shortCommit(branchHead)}: ${repo} has ${checkedOut} checked out, not ${branch}, so it cannot be fast-forwarded to ${shortCommit(to)} here. Sidequest never checks out branches for you — advance it yourself once that checkout is free.`,
      command: `git -C ${quoted(repo)} switch ${branch} && ${mergeCommand(repo, to)}`
    }, common));
  }
  if (!state.trackedClean) {
    return advanceOutcome(Object.assign({
      reason: "checkout_dirty",
      message: `${branch} was left at ${shortCommit(branchHead)}: ${repo} has modified tracked files, so fast-forwarding it to ${shortCommit(to)} could clobber them. Commit or stash them, then advance it yourself.`,
      command: mergeCommand(repo, to)
    }, common));
  }
  const merged = await git(repo, ["merge", "--ff-only", to]);
  if (!merged.ok) {
    return advanceOutcome(Object.assign({
      reason: "merge_failed",
      message: `${branch} was left at ${shortCommit(branchHead)}: git refused to fast-forward it to ${shortCommit(to)} — ${merged.stderr || `exit ${merged.status}`}.`,
      command: mergeCommand(repo, to)
    }, common));
  }
  const landed = await resolveCommit(repo, `refs/heads/${branch}`);
  if (landed !== to) {
    return advanceOutcome(Object.assign({
      reason: "merge_incomplete",
      message: `${branch} reports ${shortCommit(landed)} after fast-forwarding to ${shortCommit(to)}; treat the branch as unadvanced and check it by hand.`,
      command: mergeCommand(repo, to)
    }, common));
  }
  return advanceOutcome(Object.assign({
    advanced: true,
    reason: "advanced",
    message: `advanced ${branch} ${shortCommit(branchHead)} → ${shortCommit(to)} (fast-forward, ${repo}).`
  }, common));
}
async function sweep(repo, tickets, options = {}) {
  const minAgeMs = Number.isFinite(Number(options.minAgeMs)) && Number(options.minAgeMs) >= 0 ? Number(options.minAgeMs) : DEFAULT_MIN_AGE_MS;
  const upstream = integrationUpstream(options);
  if (await repositoryBusy(repo)) {
    return {
      dryRun: !options.execute,
      minAgeMs,
      upstream,
      entries: [],
      orphanBranches: [],
      removed: [],
      backups: [],
      deletedBranches: [],
      prunedOrphanBranches: [],
      counts: { removedWorktrees: 0, backedUpWorktrees: 0, deletedBranches: 0, prunedOrphanBranches: 0 },
      failures: [],
      skipped: "repository_busy"
    };
  }
  const listed = await git(repo, ["worktree", "list", "--porcelain"]);
  if (!listed.ok) throw new Error(listed.stderr || "could not list git worktrees");
  const worktreeList = parseWorktreeList(listed.stdout);
  const registered = new Set(worktreeList.map((entry) => normalize(entry.worktree)));
  const candidates = worktreeList.filter((entry) => isAgentWorktree(repo, entry.worktree)).filter((entry) => !options.ticketRef || ticketForWorktree(tickets, entry)?.ref === options.ticketRef);
  const orphanCandidates = options.ticketRef ? [] : await orphanDirectories(repo, registered);
  const allCandidates = [...candidates, ...orphanCandidates];
  const maxCandidates = Number.isFinite(Number(options.maxCandidates)) && Number(options.maxCandidates) > 0 ? Math.floor(Number(options.maxCandidates)) : allCandidates.length;
  const boundedCandidates = allCandidates.slice(0, maxCandidates);
  const entries = await Promise.all(boundedCandidates.map((entry) => entry.orphanDirectory ? classifyOrphanDirectory(tickets, entry, minAgeMs) : classifyWorktree(repo, tickets, entry, options.currentPath || process.cwd(), minAgeMs, upstream)));
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
          entry.backup = entry.orphanDirectory ? await backupDirtyOrphanDirectory(entry, options) : await backupDirtyWorktree(repo, entry, upstream, options);
          backups.push(entry.backup);
        } catch (error) {
          failures.push({ path: entry.path, message: `backup failed: ${error && error.message || error}` });
          continue;
        }
      }
      const result = entry.orphanDirectory ? await fs.rm(entry.path, { recursive: true, force: false }).then(() => ({ ok: true, stderr: "" })).catch((error) => ({ ok: false, stderr: String(error && error.message || error) })) : await git(repo, entry.clean ? ["worktree", "remove", entry.path] : ["worktree", "remove", "--force", entry.path]);
      if (!result.ok) {
        failures.push({ path: entry.path, message: result.stderr || "worktree remove failed" });
        continue;
      }
      removed.push(entry.path);
      if (entry.orphanDirectory) continue;
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
  const orphanBranches = options.ticketRef ? [] : await findOrphanBranches(repo, checkedOutBranches, upstream, maxCandidates);
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
module.exports = { DEFAULT_MIN_AGE_MS, parseWorktreeList, isAgentWorktree, classifyWorktree, advanceIntegrationBranch, sweep };
