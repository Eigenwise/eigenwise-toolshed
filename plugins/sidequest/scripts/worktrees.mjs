#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const SAFE = "safe";
const KEEP = "keep";

export function runGit(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { exitCode: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const firstLineOf = (text) => text.trim().split(/\r?\n/)[0];

const FIELD_READERS = {
  worktree: (entry, value) => ({ ...entry, path: resolve(value) }),
  HEAD: (entry, value) => ({ ...entry, head: value }),
  branch: (entry, value) => ({ ...entry, branch: value.replace(/^refs\/heads\//, "") }),
  locked: (entry) => ({ ...entry, isLocked: true }),
  prunable: (entry) => ({ ...entry, isPrunable: true }),
  bare: (entry) => ({ ...entry, isBare: true }),
};

const EMPTY_ENTRY = { path: "", head: "", branch: "", isLocked: false, isPrunable: false, isBare: false };

function readWorktreeLine(entry, line) {
  const [key, ...value] = line.split(" ");
  const reader = FIELD_READERS[key];
  return reader ? reader(entry, value.join(" ")) : entry;
}

export function parseWorktreeList(porcelain) {
  return porcelain
    .replace(/\r\n/g, "\n")
    .split(/\n\n+/)
    .filter((block) => block.trim() !== "")
    .map((block) => block.split("\n").reduce(readWorktreeLine, EMPTY_ENTRY));
}

// One folder can be spelled two ways on Windows, a short name and the long one, and git answers with the long one.
// So paths are compared by what they resolve to on disk. A part that does not exist yet is kept as it was given.
export function canonicalPath(path) {
  const absolute = resolve(path);
  try {
    return realpathSync.native(absolute);
  } catch {
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(canonicalPath(parent), basename(absolute));
  }
}

export function isInside(path, folder) {
  const relativePath = relative(canonicalPath(folder), canonicalPath(path));
  return relativePath === "" || (relativePath.split(sep)[0] !== ".." && !isAbsolute(relativePath));
}

const commitsWord = (count) => (count === 1 ? "1 commit" : `${count} commits`);

const listedUpToThree = (paths) => [...paths.slice(0, 3), ...(paths.length > 3 ? [`and ${paths.length - 3} more`] : [])].join(", ");

const KEEP_RULES = [
  { applies: (facts) => facts.isFolderMissing, reason: () => "its folder is gone (git worktree prune forgets it)" },
  { applies: (facts) => facts.isWhereThisRuns, reason: () => "this command runs inside it" },
  { applies: (facts) => facts.isOperationInProgress, reason: () => "an operation is in progress there (rebase, merge, cherry-pick, revert or bisect)" },
  { applies: (facts) => facts.hasUnreadableStatus, reason: () => "git could not read its files" },
  { applies: (facts) => facts.hasUncommittedFiles, reason: () => "it has uncommitted or untracked files" },
  { applies: (facts) => facts.ignoredOnlyHere.length > 0, reason: (facts) => `ignored files that are only here: ${listedUpToThree(facts.ignoredOnlyHere)}` },
  { applies: (facts) => facts.commitsOnlyHere === null, reason: () => "git could not count its commits" },
  {
    applies: (facts) => facts.commitsOnlyHere > 0,
    reason: (facts, mainBranch) => `${commitsWord(facts.commitsOnlyHere)} on no remote and not merged into ${mainBranch}`,
  },
  { applies: (facts) => facts.isLocked, reason: () => "it is locked" },
];

export function keepReasonsOf(facts, mainBranch) {
  return KEEP_RULES.filter((rule) => rule.applies(facts)).map((rule) => rule.reason(facts, mainBranch));
}

export function verdictOf(facts, mainBranch) {
  const reasons = keepReasonsOf(facts, mainBranch);
  return { ...facts, verdict: reasons.length === 0 ? SAFE : KEEP, reasons };
}

function hasSameContent(firstPath, secondPath) {
  try {
    return statSync(firstPath).size === statSync(secondPath).size && readFileSync(firstPath).equals(readFileSync(secondPath));
  } catch {
    return false;
  }
}

function isFolder(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isLink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

// What the project makes again is in the main checkout too: an installed or built folder sits at the same path there,
// and a file copied over has the same bytes. A link into the main checkout holds nothing of its own.
function mainCheckoutHoldsTheSame(worktreePath, mainCheckout, ignoredPath) {
  const here = join(worktreePath, ignoredPath);
  const there = join(mainCheckout, ignoredPath);
  if (isLink(here)) return leadsInto(here, mainCheckout);
  return ignoredPath.endsWith("/") ? isFolder(there) : hasSameContent(here, there);
}

function ignoredPathsOnlyIn(worktreePath, ignoredPaths, mainCheckout) {
  if (mainCheckout === undefined) return ignoredPaths;
  return ignoredPaths.filter((ignoredPath) => !mainCheckoutHoldsTheSame(worktreePath, mainCheckout, ignoredPath));
}

const OPERATION_MARKERS = ["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG"];

function isOperationInProgress(entry, isFolderMissing) {
  if (isFolderMissing) return false;
  const gitFolder = runGit(entry.path, ["rev-parse", "--absolute-git-dir"]);
  if (gitFolder.exitCode !== 0) return false;
  return OPERATION_MARKERS.some((marker) => existsSync(join(gitFolder.stdout.trim(), marker)));
}

const IGNORED_MARK = "!! ";

// --ignored lists a wholly ignored folder as one entry ending in /, so nothing inside node_modules or a build
// folder is walked or read.
function readStatus(entry, isFolderMissing, mainCheckout) {
  const unread = { hasUncommittedFiles: false, ignoredOnlyHere: [] };
  if (isFolderMissing) return { ...unread, hasUnreadableStatus: false };
  const status = runGit(entry.path, ["status", "--porcelain", "--ignored", "-z"]);
  if (status.exitCode !== 0) return { ...unread, hasUnreadableStatus: true };
  const entries = status.stdout.split("\0").filter((line) => line !== "");
  const ignoredPaths = entries.filter((line) => line.startsWith(IGNORED_MARK)).map((line) => line.slice(IGNORED_MARK.length));
  return {
    hasUncommittedFiles: ignoredPaths.length < entries.length,
    hasUnreadableStatus: false,
    ignoredOnlyHere: ignoredPathsOnlyIn(entry.path, ignoredPaths, mainCheckout),
  };
}

// Named for removal, a worktree on a branch holds no commits of its own because the branch stays, and a detached one
// loses only what no local branch and no remote holds.
const refsHoldingCommitsElsewhere = (repository) => (repository.isNarrowed ? ["--branches"] : repository.mainRefs);

function countCommitsOnlyHere(entry, repository) {
  if (repository.isNarrowed && entry.branch !== "") return 0;
  const counted = runGit(repository.cwd, ["rev-list", "--count", entry.head, "--not", "--remotes", ...refsHoldingCommitsElsewhere(repository)]);
  return counted.exitCode === 0 ? Number(counted.stdout.trim()) : null;
}

function lastCommitDateOf(entry, repository) {
  return runGit(repository.cwd, ["log", "-1", "--format=%cs", entry.head]).stdout.trim();
}

const AGENT_FOLDER_NAME = /^agent-/;
const AGENT_BRANCH_NAME = /^worktree-agent-/;

// An agent's worktree is named for it: a folder agent-<id> on the branch worktree-agent-<id>, or detached.
// Any other folder or branch name was chosen by a person, who may not expect it to go with the agents' ones.
export function isNamedByAPerson(entry) {
  const isAgentBranch = entry.branch === "" || AGENT_BRANCH_NAME.test(entry.branch);
  return !AGENT_FOLDER_NAME.test(basename(entry.path)) || !isAgentBranch;
}

function factsOf(entry, repository) {
  const isFolderMissing = entry.isPrunable || !existsSync(entry.path);
  return {
    path: entry.path,
    branch: entry.branch,
    isNamedByAPerson: isNamedByAPerson(entry),
    ...readStatus(entry, isFolderMissing, repository.mainCheckout),
    commitsOnlyHere: countCommitsOnlyHere(entry, repository),
    isLocked: entry.isLocked,
    isOperationInProgress: isOperationInProgress(entry, isFolderMissing),
    lastCommit: lastCommitDateOf(entry, repository),
    isFolderMissing,
    isWhereThisRuns: isInside(repository.cwd, entry.path),
  };
}

function mainRefsOf(mainEntry) {
  if (mainEntry.isBare) return [];
  return [mainEntry.branch === "" ? mainEntry.head : `refs/heads/${mainEntry.branch}`];
}

export function readRepository(cwd) {
  const listed = runGit(cwd, ["worktree", "list", "--porcelain"]);
  if (listed.exitCode !== 0) return undefined;
  const [mainEntry, ...linked] = parseWorktreeList(listed.stdout);
  return {
    cwd: resolve(cwd),
    mainCheckout: mainEntry.isBare ? undefined : mainEntry.path,
    mainBranch: mainEntry.branch === "" ? "the main checkout" : mainEntry.branch,
    mainRefs: mainRefsOf(mainEntry),
    linked,
  };
}

export function worktreeVerdicts(repository) {
  return repository.linked.map((entry) => verdictOf(factsOf(entry, repository), repository.mainBranch));
}

const AGENT_BRANCH_PATTERN = "refs/heads/worktree-agent-*";

export function agentBranchesWithoutWorktree(repository) {
  const patterns = repository.branchPatterns ?? [AGENT_BRANCH_PATTERN];
  if (patterns.length === 0) return [];
  const listed = runGit(repository.cwd, ["for-each-ref", "--format=%(refname:short)", ...patterns]);
  if (listed.exitCode !== 0) return [];
  const checkedOut = new Set([repository.mainBranch, ...repository.linked.map((entry) => entry.branch)]);
  return listed.stdout.split(/\r?\n/).filter((name) => name !== "" && !checkedOut.has(name));
}

function countBranchOnlyCommits(branch, repository) {
  const counted = runGit(repository.cwd, ["rev-list", "--count", `refs/heads/${branch}`, "--not", ...repository.mainRefs]);
  return counted.exitCode === 0 ? Number(counted.stdout.trim()) : null;
}

export function branchKeepReasons(commitsOnlyHere, mainBranch) {
  if (commitsOnlyHere === null) return ["git could not count its commits"];
  return commitsOnlyHere > 0 ? [`${commitsWord(commitsOnlyHere)} not merged into ${mainBranch}`] : [];
}

export function branchVerdicts(repository) {
  return agentBranchesWithoutWorktree(repository).map((branch) => {
    const commitsOnlyHere = countBranchOnlyCommits(branch, repository);
    const reasons = branchKeepReasons(commitsOnlyHere, repository.mainBranch);
    return { branch, commitsOnlyHere, verdict: reasons.length === 0 ? SAFE : KEEP, reasons };
  });
}

function subfolders(folder) {
  try {
    return readdirSync(folder, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => join(folder, entry.name));
  } catch {
    return [];
  }
}

function gitdirPointerOf(folder) {
  try {
    const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(join(folder, ".git"), "utf8"));
    return pointer === null ? undefined : resolve(folder, pointer[1].trim());
  } catch {
    return undefined;
  }
}

function worktreeAdminFolderOf(repository) {
  const common = runGit(repository.cwd, ["rev-parse", "--git-common-dir"]);
  return common.exitCode === 0 ? join(resolve(repository.cwd, common.stdout.trim()), "worktrees") : undefined;
}

const isSamePath = (first, second) => isInside(first, second) && isInside(second, first);

export function unregisteredWorktreeFolders(repository, root) {
  const adminFolder = worktreeAdminFolderOf(repository);
  if (adminFolder === undefined) return [];
  const registered = repository.linked.map((entry) => entry.path);
  return subfolders(root)
    .flatMap((folder) => [folder, ...subfolders(folder)])
    .filter((folder) => !registered.some((path) => isSamePath(path, folder)))
    .filter((folder) => {
      const pointer = gitdirPointerOf(folder);
      return pointer !== undefined && isInside(pointer, adminFolder);
    });
}

function walkFolder(folder, found) {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isSymbolicLink()) found.links.push(path);
    else if (entry.isDirectory()) walkFolder(path, found);
    else found.files.push(path);
  }
  return found;
}

function runGitWithInput(cwd, args, input) {
  const result = spawnSync("git", args, { cwd, input, encoding: "utf8", maxBuffer: 1024 * 1024 * 512 });
  return { exitCode: result.status ?? 1, stdout: result.stdout ?? "" };
}

function indexesTheRepositoryLacks(files, repository, hashArguments) {
  const hashed = runGitWithInput(repository.cwd, ["hash-object", ...hashArguments, "--stdin-paths"], `${files.join("\n")}\n`);
  if (hashed.exitCode !== 0) return null;
  const checked = runGitWithInput(repository.cwd, ["cat-file", "--batch-check"], hashed.stdout);
  if (checked.exitCode !== 0) return null;
  const answers = checked.stdout.split(/\r?\n/);
  return new Set(files.flatMap((_, index) => (answers[index]?.endsWith(" missing") ? [index] : [])));
}

// Files whose content the repository holds neither as it is on disk nor as git would store it. With line ending
// conversion on, a checked out file differs byte for byte from its own commit, so hashing it raw alone called every
// text file unknown and no folder was ever safe.
function filesUnknownToRepository(files, repository) {
  if (files.length === 0) return [];
  const lackedAsOnDisk = indexesTheRepositoryLacks(files, repository, ["--no-filters"]);
  const lackedAsStored = indexesTheRepositoryLacks(files, repository, []);
  if (lackedAsOnDisk === null || lackedAsStored === null) return null;
  return files.filter((_, index) => lackedAsOnDisk.has(index) && lackedAsStored.has(index));
}

function folderFacts(folder, repository) {
  try {
    const found = walkFolder(folder, { files: [], links: [] });
    const ownFiles = found.files.filter((path) => path !== join(folder, ".git"));
    return { links: found.links, unknownFiles: filesUnknownToRepository(ownFiles, repository), isWhereThisRuns: isInside(repository.cwd, folder) };
  } catch {
    return { links: [], unknownFiles: null, isWhereThisRuns: false };
  }
}

const FOLDER_KEEP_RULES = [
  { applies: (facts) => facts.isWhereThisRuns, reason: () => "this command runs inside it" },
  { applies: (facts) => facts.unknownFiles === null, reason: () => "git could not read its files" },
  {
    applies: (facts) => facts.unknownFiles !== null && facts.unknownFiles.length > 0,
    reason: (facts, folder) => `${facts.unknownFiles.length} file(s) match no commit here, for example ${relative(folder, facts.unknownFiles[0])}`,
  },
  { applies: (facts) => facts.links.length > 0, reason: (facts) => `it holds ${facts.links.length} link(s), which are not followed` },
];

export function folderVerdicts(repository, root) {
  return unregisteredWorktreeFolders(repository, root).map((path) => {
    const facts = folderFacts(path, repository);
    const reasons = FOLDER_KEEP_RULES.filter((rule) => rule.applies(facts)).map((rule) => rule.reason(facts, path));
    return { path, verdict: reasons.length === 0 ? SAFE : KEEP, reasons };
  });
}

function realpathOrUndefined(path) {
  try {
    return realpathSync.native(path);
  } catch {
    return undefined;
  }
}

function leadsInto(linkPath, folder) {
  const target = realpathOrUndefined(linkPath);
  return target !== undefined && isInside(target, folder);
}

// git worktree remove follows a directory junction on Windows and deletes the files behind it, so a link into the
// main checkout is unlinked first. unlinkSync takes away the link itself, junction or symbolic link, never its target.
export function takeAwayLinksIntoMainCheckout(worktreePath, mainCheckout) {
  const mainFolder = mainCheckout === undefined ? undefined : realpathOrUndefined(mainCheckout);
  if (mainFolder === undefined) return [];
  const links = readdirSync(worktreePath)
    .map((name) => join(worktreePath, name))
    .filter((path) => lstatSync(path).isSymbolicLink() && leadsInto(path, mainFolder));
  for (const link of links) unlinkSync(link);
  return links;
}

// A checkout detached at the branch's tip is not a branch: once it moves on, the commits would be on none.
function isHeldByAnotherRef(branch, repository) {
  const holders = runGit(repository.cwd, ["for-each-ref", "--contains", `refs/heads/${branch}`, "--format=%(refname)", "refs/heads", "refs/remotes"]);
  return holders.exitCode === 0 && holders.stdout.split(/\r?\n/).some((name) => name !== "" && name !== `refs/heads/${branch}`);
}

function deleteBranchSafely(branch, repository) {
  if (branch === "") return { isDeleted: false, reason: "it had no branch" };
  if (!isHeldByAnotherRef(branch, repository)) return { isDeleted: false, reason: "no other branch or remote holds its commits" };
  const deletion = runGit(repository.cwd, ["branch", "-d", branch]);
  return deletion.exitCode === 0 ? { isDeleted: true } : { isDeleted: false, reason: firstLineOf(deletion.stderr) };
}

const AGENT_FOLDER_ID = /^agent-(.+)$/;

// When the worker made its own branch, the host's worktree-agent-<id> is left behind once the worktree goes.
function leftoverHostBranchOf(verdict) {
  const id = AGENT_FOLDER_ID.exec(basename(verdict.path))?.[1];
  const hostBranch = id === undefined ? "" : `worktree-agent-${id}`;
  return hostBranch === verdict.branch ? "" : hostBranch;
}

function deleteLeftoverHostBranch(verdict, repository) {
  const hostBranch = leftoverHostBranchOf(verdict);
  if (hostBranch === "" || runGit(repository.cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${hostBranch}`]).exitCode !== 0) return {};
  return { leftoverBranch: hostBranch, leftoverBranchDeletion: deleteBranchSafely(hostBranch, repository) };
}

export function removeSafeWorktree(verdict, repository) {
  const linksTakenAway = takeAwayLinksIntoMainCheckout(verdict.path, repository.mainCheckout);
  const removal = runGit(repository.cwd, ["worktree", "remove", verdict.path]);
  if (removal.exitCode !== 0) return { path: verdict.path, isRemoved: false, reason: firstLineOf(removal.stderr), linksTakenAway };
  return {
    path: verdict.path,
    isRemoved: true,
    branch: verdict.branch,
    branchDeletion: deleteBranchSafely(verdict.branch, repository),
    ...deleteLeftoverHostBranch(verdict, repository),
    linksTakenAway,
  };
}

const yesOrNo = (flag) => (flag ? "yes" : "no");

const verdictText = (verdict) => (verdict.verdict === SAFE ? SAFE : `keep: ${verdict.reasons.join(", ")}`);

const verdictCells = (verdict) => [
  verdict.path,
  verdict.branch === "" ? "(detached)" : verdict.branch,
  yesOrNo(verdict.hasUncommittedFiles),
  String(verdict.commitsOnlyHere ?? "?"),
  yesOrNo(verdict.isLocked),
  verdict.lastCommit,
  verdictText(verdict),
];

export function renderTable(verdicts) {
  const header = ["path", "branch", "uncommitted", "unpushed", "locked", "last commit", "verdict"];
  const rows = [header, ...verdicts.map(verdictCells)];
  const widths = header.map((_, column) => Math.max(...rows.map((cells) => cells[column].length)));
  return rows.map((cells) => cells.map((cell, column) => cell.padEnd(widths[column])).join("  ").trimEnd()).join("\n");
}

export function summaryLine(verdicts) {
  const safeCount = verdicts.filter((verdict) => verdict.verdict === SAFE).length;
  return `${verdicts.length} linked worktrees: ${safeCount} safe to remove, ${verdicts.length - safeCount} to keep.`;
}

const namedWorktree = (verdict) => (verdict.branch === "" ? verdict.path : `${verdict.path} (branch ${verdict.branch})`);

function personNamedOutcome(options) {
  if (!options.removesSafe) return "so show this before removing (--remove-safe leaves them, --remove-safe --named removes them)";
  return leavesPersonNamed(options) ? "so they were not removed (--remove-safe --named removes them)" : "";
}

export function personNamedSafeLine(verdicts, options) {
  const named = verdicts.filter((verdict) => verdict.verdict === SAFE && verdict.isNamedByAPerson);
  const outcome = personNamedOutcome(options);
  if (named.length === 0 || outcome === "") return "";
  return `Safe, and named by a person rather than an agent, ${outcome}: ${named.map(namedWorktree).join("; ")}`;
}

const branchOutcome = (removal) =>
  removal.branchDeletion.isDeleted ? `, deleted branch ${removal.branch}` : `, kept its branch: ${removal.branchDeletion.reason}`;

const leftoverOutcome = (removal) => {
  if (removal.leftoverBranch === undefined) return "";
  const { isDeleted, reason } = removal.leftoverBranchDeletion;
  return isDeleted ? `, deleted leftover branch ${removal.leftoverBranch}` : `, kept leftover branch ${removal.leftoverBranch}: ${reason}`;
};

const linksOutcome = (removal) =>
  removal.linksTakenAway.length === 0 ? "" : `, first took away ${removal.linksTakenAway.length} link(s) into the main checkout`;

const removalLine = (removal) =>
  removal.isRemoved
    ? `removed ${removal.path}${branchOutcome(removal)}${leftoverOutcome(removal)}${linksOutcome(removal)}`
    : `kept ${removal.path}: git refused, ${removal.reason}${linksOutcome(removal)}`;

export function renderRemovals(verdicts, removals) {
  const kept = verdicts.filter((verdict) => verdict.verdict === KEEP).map((verdict) => `kept ${verdict.path}: ${verdict.reasons.join(", ")}`);
  return [...removals.map(removalLine), ...kept].join("\n");
}

const isSafe = (verdict) => verdict.verdict === SAFE;

const countWord = (count, singular, plural) => (count === 1 ? `1 ${singular}` : `${count} ${plural}`);

const keepLine = (name, verdict) => `keep ${name}: ${verdict.reasons.join(", ")}`;

export function renderBranches(branches) {
  if (branches.length === 0) return "";
  const keeps = branches.filter((branch) => !isSafe(branch));
  const headline = `${branches.length} agent branches with no worktree: ${branches.length - keeps.length} safe to remove, ${keeps.length} to keep.`;
  return [headline, ...keeps.map((branch) => keepLine(branch.branch, branch))].join("\n");
}

export function renderFolders(folders) {
  if (folders.length === 0) return "";
  const safeCount = folders.filter(isSafe).length;
  const headline = `${folders.length} worktree folders git does not know: ${safeCount} safe to remove, ${folders.length - safeCount} to keep.`;
  return [headline, ...folders.map((folder) => (isSafe(folder) ? `safe ${folder.path}` : keepLine(folder.path, folder)))].join("\n");
}

function branchesDeletedWithWorktrees(worktreeRemovals) {
  return worktreeRemovals.flatMap((removal) => [
    ...(removal.branchDeletion?.isDeleted ? [removal.branch] : []),
    ...(removal.leftoverBranchDeletion?.isDeleted ? [removal.leftoverBranch] : []),
  ]);
}

const withoutBranches = (verdicts, deleted) => verdicts.filter((verdict) => !deleted.includes(verdict.branch));

function removeSafeBranches(branches, repository) {
  return branches.filter(isSafe).map((verdict) => ({ branch: verdict.branch, ...deleteBranchSafely(verdict.branch, repository) }));
}

function removeFolder(path) {
  try {
    rmSync(path, { recursive: true });
    return { path, isRemoved: true };
  } catch (error) {
    return { path, isRemoved: false, reason: error.message };
  }
}

export function renderBranchRemovals(removals) {
  const refused = removals.filter((removal) => !removal.isDeleted).map((removal) => `kept branch ${removal.branch}: ${removal.reason}`);
  const deletedCount = removals.length - refused.length;
  return [...(deletedCount > 0 ? [`deleted ${countWord(deletedCount, "branch", "branches")}`] : []), ...refused];
}

const folderRemovalLine = (removal) => (removal.isRemoved ? `removed ${removal.path}` : `kept ${removal.path}: ${removal.reason}`);

function removalsText(report, removals) {
  const lines = [renderRemovals(report.worktrees, removals.worktrees), ...renderBranchRemovals(removals.branches), ...removals.folders.map(folderRemovalLine)];
  return lines.filter((line) => line !== "").join("\n");
}

function printReport(report, removals, options) {
  if (options.isJson) {
    console.log(JSON.stringify({ ...report, removals: removals.worktrees, branchRemovals: removals.branches, folderRemovals: removals.folders }, null, 2));
    return;
  }
  const worktreeSection = [renderTable(report.worktrees), "", summaryLine(report.worktrees), personNamedSafeLine(report.worktrees, options)].join("\n").trimEnd();
  const sections = [worktreeSection, renderBranches(report.branches), renderFolders(report.folders)];
  console.log(sections.filter((section) => section !== "").join("\n\n"));
  if (options.removesSafe) console.log(["", removalsText(report, removals)].join("\n"));
}

const valuesOf = (commandLineArguments, option) =>
  commandLineArguments.filter((argument) => argument.startsWith(option)).map((argument) => argument.slice(option.length));

function readOptions(commandLineArguments) {
  const root = commandLineArguments.find((argument) => !argument.startsWith("--"));
  return {
    removesSafe: commandLineArguments.includes("--remove-safe"),
    removesPersonNamed: commandLineArguments.includes("--named"),
    isJson: commandLineArguments.includes("--json"),
    branches: valuesOf(commandLineArguments, "--branch="),
    worktreePaths: valuesOf(commandLineArguments, "--worktree=").map((path) => resolve(path)),
    root: root === undefined ? undefined : resolve(root),
    isOnlyUnderRoot: commandLineArguments.includes("--only-under-root"),
  };
}

export const isNarrowed = (options) => options.branches.length > 0 || options.worktreePaths.length > 0;

// The board's drop of one ticket and land's cleanup of what it landed: only the worktrees on those branches or at
// those paths, and those branches, are judged or removed.
export function narrowedTo(repository, options) {
  if (!isNarrowed(options)) return repository;
  const isNamed = (entry) => options.branches.includes(entry.branch) || options.worktreePaths.some((path) => isSamePath(path, entry.path));
  return { ...repository, isNarrowed: true, linked: repository.linked.filter(isNamed), branchPatterns: options.branches.map((branch) => `refs/heads/${branch}`) };
}

// The upgrade's home cleanup: a session's own worktrees elsewhere are never judged or removed. The branch verdicts
// still read every linked worktree, so a branch checked out somewhere else never counts as having none.
export function linkedWorktreesToJudge(repository, options) {
  if (!options.isOnlyUnderRoot || options.root === undefined) return repository;
  return { ...repository, linked: repository.linked.filter((entry) => isInside(entry.path, options.root)) };
}

// isOnlyUnderRoot is in the answer so a caller can tell this script from an older copy that ignored the flag and
// would remove safe worktrees anywhere in the repository.
function readReport(repository, options) {
  return {
    isOnlyUnderRoot: options.isOnlyUnderRoot && options.root !== undefined,
    worktrees: worktreeVerdicts(linkedWorktreesToJudge(repository, options)),
    branches: branchVerdicts(repository),
    folders: options.root === undefined ? [] : folderVerdicts(repository, options.root),
  };
}

// Naming a worktree by branch or path is asking for it. Otherwise one a person named goes only after it was shown.
export const leavesPersonNamed = (options) => !options.removesPersonNamed && !isNarrowed(options);

function removableWorktrees(worktrees, options) {
  const isLeft = (verdict) => verdict.isNamedByAPerson && leavesPersonNamed(options);
  return worktrees.filter((verdict) => isSafe(verdict) && !isLeft(verdict));
}

function removeSafe(report, repository, options) {
  const worktrees = removableWorktrees(report.worktrees, options).map((verdict) => removeSafeWorktree(verdict, repository));
  const remainingBranches = withoutBranches(report.branches, branchesDeletedWithWorktrees(worktrees));
  return {
    worktrees,
    branches: removeSafeBranches(remainingBranches, repository),
    folders: report.folders.filter(isSafe).map((verdict) => removeFolder(verdict.path)),
  };
}

export function tidyWorktrees(commandLineArguments, cwd) {
  const options = readOptions(commandLineArguments);
  const wholeRepository = readRepository(cwd);
  if (wholeRepository === undefined) {
    console.error("not inside a git repository");
    return 1;
  }
  const repository = narrowedTo(wholeRepository, options);
  const report = readReport(repository, options);
  const removals = options.removesSafe ? removeSafe(report, repository, options) : { worktrees: [], branches: [], folders: [] };
  const branches = withoutBranches(report.branches, branchesDeletedWithWorktrees(removals.worktrees));
  printReport({ ...report, branches }, removals, options);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = tidyWorktrees(process.argv.slice(2), process.cwd());
}
