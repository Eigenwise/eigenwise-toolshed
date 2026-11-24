import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

// The upgrade's done check needs the scan to keep exactly what sidequest:tidy keeps, so these rules follow sidequest's
// worktrees script. Plugins stay standalone, so they are written here again rather than imported from it.

export const comparablePath = (path) => (process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path));

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

const isSameFolder = (first, second) => comparablePath(canonicalPath(first)) === comparablePath(canonicalPath(second));

function isInside(path, folder) {
  const relativePath = relative(canonicalPath(folder), canonicalPath(path));
  return relativePath === "" || (relativePath.split(sep)[0] !== ".." && !isAbsolute(relativePath));
}

export function runGit(cwd, args, input) {
  const result = spawnSync("git", args, { cwd, input, encoding: "utf8", maxBuffer: 1024 * 1024 * 512, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
  return { exitCode: result.status ?? 1, stdout: result.stdout ?? "" };
}

export function gitLines(cwd, args) {
  const result = runGit(cwd, args);
  return result.exitCode === 0 ? result.stdout.split(/\r?\n/).filter((line) => line !== "") : [];
}

const WORKTREE_FIELD_READERS = {
  worktree: (entry, value) => ({ ...entry, path: resolve(value) }),
  HEAD: (entry, value) => ({ ...entry, head: value }),
  branch: (entry, value) => ({ ...entry, branch: value.replace(/^refs\/heads\//, "") }),
  locked: (entry) => ({ ...entry, isLocked: true }),
};

const EMPTY_WORKTREE = { path: "", head: "", branch: "", isLocked: false };

function readWorktreeLine(entry, line) {
  const [key, ...value] = line.split(" ");
  const reader = WORKTREE_FIELD_READERS[key];
  return reader ? reader(entry, value.join(" ")) : entry;
}

export function parseWorktreeList(porcelain) {
  return porcelain
    .replace(/\r\n/g, "\n")
    .split(/\n\n+/)
    .filter((block) => block.trim() !== "")
    .map((block) => block.split("\n").reduce(readWorktreeLine, EMPTY_WORKTREE));
}

export function readLinkedWorktrees(project) {
  const [, ...linked] = parseWorktreeList(runGit(project, ["worktree", "list", "--porcelain"]).stdout);
  return linked;
}

const AGENT_BRANCHES = "refs/heads/worktree-agent-*";

// A branch checked out in a worktree is judged with that worktree, and a live v2 agent's branch is no leftover at all.
export function readAgentBranches(project, linked) {
  const checkedOut = new Set(linked.map((entry) => entry.branch));
  const countFree = (mergeFilter) =>
    gitLines(project, ["for-each-ref", "--format=%(refname:short)", mergeFilter, "HEAD", AGENT_BRANCHES]).filter((name) => !checkedOut.has(name)).length;
  return { merged: countFree("--merged"), unmerged: countFree("--no-merged") };
}

const commitsWord = (count) => (count === 1 ? "1 commit" : `${count} commits`);

const REGISTERED_KEEP_RULES = [
  { applies: (facts) => facts.status.exitCode !== 0, reason: () => "git could not read its files" },
  { applies: (facts) => facts.status.exitCode === 0 && facts.status.stdout.trim() !== "", reason: () => "it has uncommitted or untracked files" },
  { applies: (facts) => facts.commitsOnlyHere === null, reason: () => "git could not count its commits" },
  { applies: (facts) => facts.commitsOnlyHere > 0, reason: (facts) => `${commitsWord(facts.commitsOnlyHere)} on no remote and not merged into the checked-out branch` },
  { applies: (facts) => facts.isLocked, reason: () => "it is locked" },
];

const reasonsFrom = (rules, facts) => rules.filter((rule) => rule.applies(facts)).map((rule) => rule.reason(facts));

function countCommitsOnlyIn(project, head) {
  const counted = runGit(project, ["rev-list", "--count", head, "--not", "--remotes", "HEAD"]);
  return counted.exitCode === 0 ? Number(counted.stdout.trim()) : null;
}

function registeredWorktreeKeepReasons(entry, project) {
  const facts = { status: runGit(entry.path, ["status", "--porcelain"]), commitsOnlyHere: countCommitsOnlyIn(project, entry.head), isLocked: entry.isLocked };
  return reasonsFrom(REGISTERED_KEEP_RULES, facts);
}

function gitdirPointerOf(folder) {
  try {
    const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(join(folder, ".git"), "utf8"));
    return pointer === null ? undefined : resolve(folder, pointer[1].trim());
  } catch {
    return undefined;
  }
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

function indexesTheRepositoryLacks(files, project, hashArguments) {
  const hashed = runGit(project, ["hash-object", ...hashArguments, "--stdin-paths"], `${files.join("\n")}\n`);
  if (hashed.exitCode !== 0) return null;
  const checked = runGit(project, ["cat-file", "--batch-check"], hashed.stdout);
  if (checked.exitCode !== 0) return null;
  const answers = checked.stdout.split(/\r?\n/);
  return new Set(files.flatMap((_, index) => (answers[index]?.endsWith(" missing") ? [index] : [])));
}

// Files whose content the repository holds neither as it is on disk nor as git would store it. With line ending
// conversion on, a checked out file differs byte for byte from its own commit, so hashing it raw alone called every
// text file unknown and no folder was ever safe.
function filesUnknownToRepository(files, project) {
  if (files.length === 0) return [];
  const lackedAsOnDisk = indexesTheRepositoryLacks(files, project, ["--no-filters"]);
  const lackedAsStored = indexesTheRepositoryLacks(files, project, []);
  if (lackedAsOnDisk === null || lackedAsStored === null) return null;
  return files.filter((_, index) => lackedAsOnDisk.has(index) && lackedAsStored.has(index));
}

function strayFolderFacts(folder, project) {
  try {
    const found = walkFolder(folder, { files: [], links: [] });
    const ownFiles = found.files.filter((path) => path !== join(folder, ".git"));
    return { folder, links: found.links, unknownFiles: filesUnknownToRepository(ownFiles, project) };
  } catch {
    return { folder, links: [], unknownFiles: null };
  }
}

const STRAY_FOLDER_KEEP_RULES = [
  { applies: (facts) => facts.unknownFiles === null, reason: () => "git could not read its files" },
  {
    applies: (facts) => facts.unknownFiles?.length > 0,
    reason: (facts) => `${facts.unknownFiles.length} file(s) match no commit here, for example ${relative(facts.folder, facts.unknownFiles[0])}`,
  },
  { applies: (facts) => facts.links.length > 0, reason: (facts) => `it holds ${facts.links.length} link(s), which are not followed` },
];

const NOT_THIS_REPOSITORY = "not a worktree of this repository, so tidy leaves it; look inside before anyone removes it by hand";

function unregisteredFolderKeepReasons(folder, context) {
  const pointer = gitdirPointerOf(folder);
  const isOurs = pointer !== undefined && context.adminFolder !== undefined && isInside(pointer, context.adminFolder);
  return isOurs ? reasonsFrom(STRAY_FOLDER_KEEP_RULES, strayFolderFacts(folder, context.project)) : [NOT_THIS_REPOSITORY];
}

function folderKeepReasons(folder, context) {
  const registered = context.linked.find((entry) => isSameFolder(entry.path, folder));
  return registered === undefined ? unregisteredFolderKeepReasons(folder, context) : registeredWorktreeKeepReasons(registered, context.project);
}

function subfolders(folder) {
  try {
    return readdirSync(folder, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => join(folder, entry.name));
  } catch {
    return [];
  }
}

function worktreeAdminFolderOf(project) {
  const common = gitLines(project, ["rev-parse", "--git-common-dir"])[0];
  return common === undefined ? undefined : join(resolve(project, common), "worktrees");
}

export function judgeOlderWorktreeFolders(project, root, linked) {
  const folders = subfolders(root);
  if (folders.length === 0) return [];
  const context = { project, linked, adminFolder: worktreeAdminFolderOf(project) };
  return folders.map((folder) => ({ name: basename(folder), keepReasons: folderKeepReasons(folder, context) }));
}
