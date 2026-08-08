"use strict";
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const nativeFs = require("node:fs");
const { execFileSync, spawn } = require("node:child_process");
const commitScope = require("./commit-scope.js");
const DEFAULT_MIN_AGE_MS = 3 * 60 * 60 * 1e3;
const DEFAULT_NOT_INTEGRATED_SALVAGE_AGE_MS = 7 * 24 * 60 * 60 * 1e3;
const QUARANTINE_RETRY_INTERVAL_MS = 24 * 60 * 60 * 1e3;
function git(cwd, args) {
  return new Promise((resolve) => {
    const child = spawn("git", ["-c", "core.editor=true", ...args], {
      cwd,
      env: { ...process.env, GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true" },
      timeout: 12e4,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
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
function pathIsInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || !relative.startsWith("..") && !path.isAbsolute(relative);
}
function preferredWorktreeIntegrationTarget(repository, branch) {
  const local = `refs/heads/${branch}`;
  const remote = `refs/remotes/origin/${branch}`;
  try {
    execFileSync("git", ["rev-parse", "--verify", `${local}^{commit}`], {
      cwd: repository,
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore"]
    });
    execFileSync("git", ["rev-parse", "--verify", `${remote}^{commit}`], {
      cwd: repository,
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore"]
    });
  } catch (_) {
    return null;
  }
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", remote, local], {
      cwd: repository,
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore"]
    });
    return { mode: "local", upstream: branch, branch };
  } catch (_) {
    return { mode: "remote", upstream: `origin/${branch}`, branch };
  }
}
function dependencyCachePath(relativePath) {
  return relativePath.split(/[\\/]+/).includes("node_modules");
}
function ignoredPathsMissingFromWorktree(repository, worktree, candidatePaths) {
  if (!nativeFs.existsSync(repository) || !nativeFs.existsSync(worktree) || !candidatePaths.length) return [];
  const scopes = candidatePaths.map((candidate) => path.resolve(repository, candidate)).filter((candidate) => pathIsInside(repository, candidate));
  if (!scopes.length) return [];
  let output = "";
  try {
    output = execFileSync("git", ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory"], {
      cwd: repository,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"]
    });
  } catch (_) {
    return [];
  }
  return output.split(/\r?\n/).map((entry) => entry.trim().replace(/[\\/]+$/, "").replace(/\\/g, "/")).filter(Boolean).filter((relativePath) => !dependencyCachePath(relativePath)).filter((relativePath) => {
    const repositoryPath = path.resolve(repository, relativePath);
    if (!pathIsInside(repository, repositoryPath) || !nativeFs.existsSync(repositoryPath)) return false;
    if (nativeFs.existsSync(path.resolve(worktree, relativePath))) return false;
    return scopes.some((scope) => pathIsInside(scope, repositoryPath) || pathIsInside(repositoryPath, scope));
  }).sort();
}
function canonicalPath(value) {
  const resolved = path.resolve(String(value));
  const missingSegments = [];
  let existingAncestor = resolved;
  while (!nativeFs.existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) break;
    missingSegments.unshift(path.basename(existingAncestor));
    existingAncestor = parent;
  }
  try {
    const canonical = nativeFs.realpathSync.native(existingAncestor);
    const completed = path.join(canonical, ...missingSegments);
    return process.platform === "win32" ? completed.toLowerCase() : completed;
  } catch {
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  }
}
function sidequestHome() {
  const configured = String(process.env.SIDEQUEST_HOME || "").trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), ".claude", "sidequest");
}
function worktreeProjectSlug(repository) {
  const resolved = path.resolve(repository);
  const normalized = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const base = path.basename(resolved).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "project";
  const hash = crypto.createHash("sha1").update(normalized).digest("hex").slice(0, 8);
  return `${base}-${hash}`;
}
function worktreeRoot(repository) {
  const project = canonicalPath(repository);
  const slug = worktreeProjectSlug(project);
  const preferred = path.join(sidequestHome(), "worktrees", slug);
  if (!pathIsInside(project, preferred)) return preferred;
  const fallback = path.join(os.tmpdir(), "sidequest", "worktrees", slug);
  if (!pathIsInside(project, fallback)) return fallback;
  throw new Error(`Sidequest cannot place an isolated worktree outside project root ${project}.`);
}
function legacyWorktreeRoot(repository) {
  return path.join(repository, ".claude", "worktrees");
}
function agentWorktreePath(repository, agentId) {
  return path.join(worktreeRoot(repository), `agent-${String(agentId).trim()}`);
}
function namedWorktreePath(repository, name) {
  const segment = String(name).trim();
  if (!segment || segment === "." || segment === ".." || path.basename(segment) !== segment) {
    throw new Error(`invalid worktree name: ${name}`);
  }
  return path.join(worktreeRoot(repository), segment);
}
function agentWorktreeRoots(repository) {
  return [worktreeRoot(repository), legacyWorktreeRoot(repository)];
}
function persistentStateFile() {
  return path.join(sidequestHome(), "worktree-sweep-failures.json");
}
function readFailureState() {
  try {
    return JSON.parse(nativeFs.readFileSync(persistentStateFile(), "utf8"));
  } catch (_) {
    return {};
  }
}
function writeFailureState(state) {
  try {
    nativeFs.mkdirSync(path.dirname(persistentStateFile()), { recursive: true });
    nativeFs.writeFileSync(persistentStateFile(), JSON.stringify(state), "utf8");
  } catch (_) {
  }
}
function isFilenameTooLong(message) {
  return /filename too long|enametoolong/i.test(String(message || ""));
}
function failureFingerprint(message) {
  return isFilenameTooLong(message) ? "filename-too-long" : String(message || "").replace(/\d+/g, "#").slice(0, 500);
}
function recordFailure(pathname, message) {
  const state = readFailureState();
  const key = canonicalPath(pathname);
  const fingerprint = failureFingerprint(message);
  const existing = state[key];
  const attempts = existing?.fingerprint === fingerprint ? existing.attempts + 1 : 1;
  state[key] = { ...existing, fingerprint, attempts };
  writeFailureState(state);
  return { attempts, suppressed: attempts > 2 };
}
function clearFailure(pathname) {
  const state = readFailureState();
  const key = canonicalPath(pathname);
  if (!(key in state)) return;
  delete state[key];
  writeFailureState(state);
}
function recordQuarantine(pathname, message, destination) {
  const state = readFailureState();
  const key = canonicalPath(pathname);
  const existing = state[key];
  state[key] = {
    ...existing || { fingerprint: failureFingerprint(message), attempts: 1 },
    quarantineAttempted: true,
    quarantinedPath: destination,
    quarantinedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  writeFailureState(state);
}
function recordQuarantineFailure(pathname, message) {
  const state = readFailureState();
  const key = canonicalPath(pathname);
  const existing = state[key];
  state[key] = {
    ...existing || { fingerprint: failureFingerprint(message), attempts: 1 },
    quarantineAttempted: true,
    quarantineFailed: true,
    quarantineFailedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  writeFailureState(state);
}
function quarantineRetryDue(pathname) {
  const failure = readFailureState()[canonicalPath(pathname)];
  if (!failure?.quarantineFailed) return true;
  const failedAt = Date.parse(String(failure.quarantineFailedAt || ""));
  return !Number.isFinite(failedAt) || Date.now() - failedAt >= QUARANTINE_RETRY_INTERVAL_MS;
}
function shouldSkipKnownFailure(pathname) {
  const state = readFailureState()[canonicalPath(pathname)];
  return state?.fingerprint === "filename-too-long" && state.attempts >= 2;
}
function shouldTryExtendedPath(pathname, message) {
  if (process.platform !== "win32" || !isFilenameTooLong(message)) return false;
  const state = readFailureState();
  const key = canonicalPath(pathname);
  if (state[key]?.extendedPathAttempted) return false;
  state[key] = { ...state[key] || { fingerprint: "filename-too-long", attempts: 0 }, extendedPathAttempted: true };
  writeFailureState(state);
  return true;
}
function extendedWindowsPath(pathname) {
  return path.win32.toNamespacedPath(path.resolve(pathname));
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
  const candidate = canonicalPath(worktree);
  return agentWorktreeRoots(repo).some((root) => {
    const relative = path.relative(canonicalPath(root), candidate);
    return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative) && !relative.includes(path.sep) && path.basename(relative).startsWith("agent-");
  });
}
function ticketForWorktree(tickets, entry) {
  const worktree = canonicalPath(entry.worktree);
  const submitted = tickets.find((ticket) => ticket.submission && ticket.submission.worktree && canonicalPath(ticket.submission.worktree) === worktree);
  if (submitted) return submitted;
  const continued = tickets.find((ticket) => ticket.dispatch?.continuation?.sourceWorktree && canonicalPath(ticket.dispatch.continuation.sourceWorktree) === worktree);
  if (continued) return continued;
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
function worktreePath(entry) {
  return String(entry.path || entry.worktree);
}
function salvageRef(entry, suffix = "") {
  return `refs/salvage/${path.basename(worktreePath(entry))}${suffix}`;
}
async function createSalvageRef(repo, ref, revision) {
  const created = await git(repo, ["update-ref", ref, revision, "0000000000000000000000000000000000000000"]);
  if (!created.ok) throw new Error(created.stderr || `could not create salvage ref ${ref}`);
}
async function salvageWorktree(repo, entry) {
  const worktree = worktreePath(entry);
  const head = await git(worktree, ["rev-parse", "HEAD"]);
  if (!head.ok || !head.stdout) throw new Error(head.stderr || "could not resolve worktree HEAD");
  const ref = salvageRef(entry);
  await createSalvageRef(repo, ref, head.stdout);
  if (entry.clean) return { ref, uncommittedRef: null };
  const stash = await git(worktree, ["stash", "create"]);
  if (!stash.ok || !stash.stdout) throw new Error(stash.stderr || "could not capture uncommitted worktree changes");
  const uncommittedRef = salvageRef(entry, "-uncommitted");
  await createSalvageRef(repo, uncommittedRef, stash.stdout);
  return { ref, uncommittedRef };
}
function recoveryCommand(entry) {
  const worktree = String(entry.path || entry.worktree);
  const ref = String(entry.salvage?.ref || "");
  const uncommittedRef = entry.salvage?.uncommittedRef ? ` && git -C "${worktree}" stash apply "${entry.salvage.uncommittedRef}"` : "";
  return `git worktree add --detach "${worktree}" "${ref}"${uncommittedRef}`;
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
async function classifyWorktree(repo, tickets, entry, currentPath, minAgeMs, upstream, livePaths = [], notIntegratedSalvageAgeMs = DEFAULT_NOT_INTEGRATED_SALVAGE_AGE_MS) {
  const ticket = ticketForWorktree(tickets, entry);
  const worktreePath2 = canonicalPath(entry.worktree);
  const current = worktreePath2 === canonicalPath(currentPath);
  if (current) return skippedEntry(entry, ticket, "current_worktree", true);
  if (livePaths.some((livePath) => worktreePath2 === canonicalPath(livePath))) return skippedEntry(entry, ticket, "live_session", false);
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
  const untracked = cleanResult.ok && cleanResult.stdout.split(/\r?\n/).some((line) => line.startsWith("?? "));
  const oldEnough = ageMs != null && ageMs >= minAgeMs;
  const oldEnoughToSalvage = ageMs != null && ageMs >= notIntegratedSalvageAgeMs;
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
  } else if (oldEnoughToSalvage && untracked) {
    reason = "unrecoverable_untracked";
  } else if (oldEnoughToSalvage) {
    action = "salvage";
    reason = "not_integrated_salvage";
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
    notIntegratedSalvageAgeMs,
    oldEnoughToSalvage,
    locked: null,
    action,
    reason,
    current: false
  };
}
async function orphanDirectories(repo, registered) {
  const legacyRoot = canonicalPath(legacyWorktreeRoot(repo));
  const directories = (await Promise.all(agentWorktreeRoots(repo).map(async (parent) => {
    try {
      const entries = await fs.readdir(parent, { withFileTypes: true });
      const legacy = canonicalPath(parent) === legacyRoot;
      return entries.filter((entry) => entry.isDirectory() && (legacy || entry.name.startsWith("agent-"))).map((entry) => path.join(parent, entry.name));
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
  }))).flat();
  return Promise.all(directories.filter((directory) => quarantineRetryDue(directory)).filter((directory) => !registered.has(canonicalPath(directory))).map(async (directory) => {
    try {
      await fs.lstat(path.join(directory, ".git"));
      return null;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return { worktree: directory, branch: null, orphanDirectory: true };
  })).then((entries) => entries.filter(Boolean));
}
async function classifyOrphanDirectory(tickets, entry, livePaths, minAgeMs) {
  const ticket = ticketForWorktree(tickets, entry);
  if (livePaths.some((livePath) => canonicalPath(entry.worktree) === canonicalPath(livePath))) return skippedEntry(entry, ticket, "live_session", false);
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
  return options.backupDir || path.join(sidequestHome(), "worktree-backups");
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
    const [patch, reachable, subject] = await Promise.all([
      patchEquivalence(repo, branch, upstream),
      reachableFrom(repo, branch, upstream),
      git(repo, ["log", "-1", "--format=%s", branch])
    ]);
    return {
      branch,
      subject: subject.ok ? subject.stdout : "",
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
  const [head, modified, staged, untracked] = await Promise.all([
    git(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    git(repo, ["diff", "--name-only"]),
    git(repo, ["diff", "--cached", "--name-only"]),
    git(repo, ["ls-files", "--others", "--exclude-standard"])
  ]);
  const paths = (result) => result.ok && result.stdout ? result.stdout.split(/\r?\n/).filter(Boolean) : [];
  return {
    branch: head.ok && head.stdout ? head.stdout : null,
    dirtyPaths: Array.from(/* @__PURE__ */ new Set([...paths(modified), ...paths(staged)])),
    untrackedPaths: paths(untracked)
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
  const executorWorktree = options.submissionWorktree ? canonicalPath(options.submissionWorktree) : null;
  const heads = /* @__PURE__ */ new Map();
  for (const entry of parseWorktreeList(listed.stdout)) {
    const commit = String(entry.head || "").trim();
    if (!/^[0-9a-f]{40}$/.test(commit) || commit === branchHead) continue;
    if (isAgentWorktree(repo, entry.worktree) || !quarantineRetryDue(entry.worktree)) continue;
    if (executorWorktree && canonicalPath(entry.worktree) === executorWorktree) continue;
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
  const protectedPaths = Array.from(/* @__PURE__ */ new Set([
    ...Array.isArray(options.admittedScope) ? options.admittedScope : [],
    ...Array.isArray(options.changedPaths) ? options.changedPaths : []
  ]));
  const scopedDirtyPaths = [...state.dirtyPaths, ...state.untrackedPaths].filter((entry) => protectedPaths.length && commitScope.isInScope(entry, protectedPaths));
  const ignoredDirtyPaths = protectedPaths.length ? state.dirtyPaths.filter((entry) => !commitScope.isInScope(entry, protectedPaths)) : state.untrackedPaths;
  const blockingDirtyPaths = protectedPaths.length ? scopedDirtyPaths : state.dirtyPaths;
  if (blockingDirtyPaths.length) {
    const scopeReason = protectedPaths.length ? `uncommitted changes inside this ticket's declared scope: ${blockingDirtyPaths.join(", ")}` : "modified tracked files";
    return advanceOutcome(Object.assign({
      reason: "checkout_dirty",
      dirtyPaths: blockingDirtyPaths,
      ignoredDirtyPaths,
      message: `${branch} was left at ${shortCommit(branchHead)}: ${repo} has ${scopeReason}, so fast-forwarding it to ${shortCommit(to)} could clobber them. Commit or stash them, then advance it yourself.`,
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
    ignoredDirtyPaths,
    message: `advanced ${branch} ${shortCommit(branchHead)} → ${shortCommit(to)} (fast-forward, ${repo}).`
  }, common));
}
function quarantineRoot(options) {
  return options.quarantineDir || path.join(sidequestHome(), "worktree-quarantine");
}
async function quarantineCandidate(entry, message, options) {
  const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
  const destination = path.join(quarantineRoot(options), `${path.basename(entry.path)}-${timestamp}`);
  try {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.rename(entry.path, destination);
    recordQuarantine(entry.path, message, destination);
    return { ok: true, destination, stderr: "" };
  } catch (error) {
    const stderr = String(error && error.message || error);
    recordQuarantineFailure(entry.path, stderr);
    return { ok: false, stderr };
  }
}
async function removeCandidate(repo, entry) {
  const remove = async (pathname) => entry.orphanDirectory ? fs.rm(pathname, { recursive: true, force: false }).then(() => ({ ok: true, stderr: "" })).catch((error) => ({ ok: false, stderr: String(error && error.message || error) })) : git(repo, entry.clean ? ["worktree", "remove", pathname] : ["worktree", "remove", "--force", pathname]);
  const first = await remove(entry.path);
  if (first.ok || !shouldTryExtendedPath(entry.path, first.stderr)) return first;
  const extended = await remove(extendedWindowsPath(entry.path));
  return extended.ok ? extended : { ok: false, stderr: `${first.stderr}; extended-path retry: ${extended.stderr}` };
}
async function sweep(repo, tickets, options = {}) {
  const minAgeMs = Number.isFinite(Number(options.minAgeMs)) && Number(options.minAgeMs) >= 0 ? Number(options.minAgeMs) : DEFAULT_MIN_AGE_MS;
  const notIntegratedSalvageAgeMs = Number.isFinite(Number(options.notIntegratedSalvageAgeMs)) && Number(options.notIntegratedSalvageAgeMs) >= 0 ? Number(options.notIntegratedSalvageAgeMs) : DEFAULT_NOT_INTEGRATED_SALVAGE_AGE_MS;
  const upstream = integrationUpstream(options);
  if (await repositoryBusy(repo)) {
    return {
      dryRun: !options.execute,
      minAgeMs,
      notIntegratedSalvageAgeMs,
      upstream,
      entries: [],
      orphanBranches: [],
      removed: [],
      backups: [],
      salvaged: [],
      deletedBranches: [],
      prunedOrphanBranches: [],
      quarantined: [],
      counts: { removedWorktrees: 0, salvagedWorktrees: 0, quarantinedWorktrees: 0, backedUpWorktrees: 0, deletedBranches: 0, prunedOrphanBranches: 0 },
      failures: [],
      skipped: "repository_busy"
    };
  }
  const listed = await git(repo, ["worktree", "list", "--porcelain"]);
  if (!listed.ok) throw new Error(listed.stderr || "could not list git worktrees");
  const worktreeList = parseWorktreeList(listed.stdout);
  const registered = new Set(worktreeList.map((entry) => canonicalPath(entry.worktree)));
  const candidates = worktreeList.filter((entry) => isAgentWorktree(repo, entry.worktree)).filter((entry) => quarantineRetryDue(entry.worktree)).filter((entry) => !options.ticketRef || ticketForWorktree(tickets, entry)?.ref === options.ticketRef);
  const orphanCandidates = options.ticketRef ? [] : await orphanDirectories(repo, registered);
  const allCandidates = [...candidates, ...orphanCandidates];
  const maxCandidates = Number.isFinite(Number(options.maxCandidates)) && Number(options.maxCandidates) > 0 ? Math.floor(Number(options.maxCandidates)) : allCandidates.length;
  const boundedCandidates = allCandidates.slice(0, maxCandidates);
  const livePaths = Array.isArray(options.livePaths) ? options.livePaths.map((pathname) => String(pathname)) : [];
  const entries = await Promise.all(boundedCandidates.map((entry) => entry.orphanDirectory ? classifyOrphanDirectory(tickets, entry, livePaths, minAgeMs) : classifyWorktree(repo, tickets, entry, options.currentPath || process.cwd(), minAgeMs, upstream, livePaths, notIntegratedSalvageAgeMs)));
  const execute = !!options.execute;
  const removed = [];
  const backups = [];
  const salvaged = [];
  const deletedBranches = [];
  const prunedOrphanBranches = [];
  const quarantined = [];
  const failures = [];
  if (execute) {
    for (const entry of entries.filter((candidate) => candidate.action === "remove" || candidate.action === "salvage")) {
      if (shouldSkipKnownFailure(entry.path)) {
        entry.action = "keep";
        entry.reason = "known_permanent_failure";
        continue;
      }
      if (entry.action === "salvage") {
        try {
          entry.salvage = await salvageWorktree(repo, entry);
          salvaged.push({ path: entry.path, ...entry.salvage, recovery: recoveryCommand(entry) });
        } catch (error) {
          entry.action = "keep";
          entry.reason = "salvage_failed";
          failures.push({ path: entry.path, message: `salvage failed: ${error && error.message || error}` });
          continue;
        }
      }
      if (!entry.clean && !entry.salvage) {
        try {
          entry.backup = entry.orphanDirectory ? await backupDirtyOrphanDirectory(entry, options) : await backupDirtyWorktree(repo, entry, upstream, options);
          backups.push(entry.backup);
        } catch (error) {
          failures.push({ path: entry.path, message: `backup failed: ${error && error.message || error}` });
          continue;
        }
      }
      const result = await removeCandidate(repo, entry);
      if (!result.ok) {
        const message = result.stderr || "worktree remove failed";
        recordFailure(entry.path, message);
        const quarantine = await quarantineCandidate(entry, message, options);
        if (!quarantine.ok || !quarantine.destination) {
          entry.action = "keep";
          entry.reason = "quarantine_failed";
          failures.push({ path: entry.path, message: `${message}; quarantine failed: ${quarantine.stderr}` });
          continue;
        }
        entry.action = "quarantine";
        entry.reason = "remove_failed_quarantined";
        entry.quarantine = quarantine.destination;
        quarantined.push({ path: entry.path, destination: quarantine.destination, message });
        continue;
      }
      clearFailure(entry.path);
      removed.push(entry.path);
      if (entry.orphanDirectory) continue;
      const branch = localBranchName(entry.branch);
      if (!branch) continue;
      const deleted = await git(repo, ["branch", "-D", "--", branch]);
      if (deleted.ok) deletedBranches.push(branch);
      else failures.push({ path: branch, message: deleted.stderr || "git branch delete failed" });
    }
    if (removed.length || quarantined.length) {
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
    notIntegratedSalvageAgeMs,
    upstream,
    entries,
    orphanBranches,
    removed,
    backups,
    salvaged,
    deletedBranches,
    prunedOrphanBranches,
    quarantined,
    counts: {
      removedWorktrees: removed.length,
      salvagedWorktrees: salvaged.length,
      quarantinedWorktrees: quarantined.length,
      backedUpWorktrees: backups.length,
      deletedBranches: deletedBranches.length,
      prunedOrphanBranches: prunedOrphanBranches.length
    },
    failures
  };
}
module.exports = { DEFAULT_MIN_AGE_MS, DEFAULT_NOT_INTEGRATED_SALVAGE_AGE_MS, canonicalPath, worktreeRoot, legacyWorktreeRoot, agentWorktreePath, namedWorktreePath, agentWorktreeRoots, parseWorktreeList, isAgentWorktree, ignoredPathsMissingFromWorktree, preferredWorktreeIntegrationTarget, classifyWorktree, advanceIntegrationBranch, sweep };
