#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, rmdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { configDirectoryOf } from "./config-directory.mjs";
import { HOME_GROUP_IDS, WORKTREE_GROUP, homeGroups, projectsStillOnOlderVersion } from "./upgrade-findings.mjs";
import { EARLIER_NAME, THIS_VERSION, toolshedInstallsOf } from "./toolshed-installs.mjs";
import { isSamePath, olderWorktreeFolders, olderWorktreeRootOf, readHomeFacts, readInstalledProjects, readJsonOrEmpty } from "./upgrade-scan.mjs";

const SAFE = "safe";
const KEEP = "keep";
const DEFAULT_ALLOWANCE_SECONDS = 5;
const SIDEQUEST_MISSING = "sidequest of this version is not installed, so no worktree verdict ran and no worktree folder is offered";

const keepFolder = (path, reason) => ({ path, verdict: KEEP, reasons: [reason] });

const secondsSince = (startedAt) => Math.round((Date.now() - startedAt) / 1000);

const elapsedWords = (startedAt) => `${secondsSince(startedAt)} s`;

const counted = (count, singular, plural) => (count === 1 ? `1 ${singular}` : `${count.toLocaleString("en-US")} ${plural}`);

const entriesWords = (count) => counted(count, "entry", "entries");

const hasInstallPath = (entry) => typeof entry?.installPath === "string" && entry.installPath !== "";

const isThisVersionsSidequest = (entry) => entry.name === "sidequest" && [THIS_VERSION, EARLIER_NAME].includes(entry.state);

export function sidequestWorktreesScript(configDirectory) {
  return toolshedInstallsOf(readJsonOrEmpty(join(configDirectory, "plugins", "installed_plugins.json")))
    .filter(isThisVersionsSidequest)
    .filter(hasInstallPath)
    .map((entry) => join(entry.installPath, "scripts", "worktrees.mjs"))
    .find((path) => existsSync(path));
}

function gitdirPointerOf(folder) {
  try {
    const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(join(folder, ".git"), "utf8"));
    return pointer === null ? undefined : resolve(folder, pointer[1].trim());
  } catch {
    return undefined;
  }
}

// A worktree's .git file points at <repository>/.git/worktrees/<name>, which outlives the folder's registration.
export function repositoryOf(folder) {
  const pointer = gitdirPointerOf(folder);
  if (pointer === undefined) return { reason: "it has no .git file that names its repository" };
  const gitFolder = dirname(dirname(pointer));
  if (!existsSync(join(gitFolder, "HEAD"))) return { reason: `its repository is gone (${gitFolder})` };
  return { repository: basename(gitFolder) === ".git" ? dirname(gitFolder) : gitFolder };
}

const TOO_OLD = "the installed Sidequest is too old to judge this folder: update it and run this again";

const failedWords = (detail) => `the installed Sidequest's worktree script failed here (${detail}), so this folder was not judged: update Sidequest and run this again`;

function parsedOrUndefined(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// An older copy answers without folders and ignores --only-under-root, so with --remove-safe it would remove safe
// worktrees anywhere in the repository. Only an answer that says it narrowed to the root is used at all.
const isCurrentAnswer = (report) =>
  Array.isArray(report?.worktrees) && Array.isArray(report?.folders) && Array.isArray(report?.branches) && report?.isOnlyUnderRoot === true;

function exitWords(result) {
  const firstLine = String(result.stderr ?? "").trim().split(/\r?\n/)[0];
  return `exit ${result.status ?? "none"}${firstLine === "" ? "" : `: ${firstLine}`}`;
}

export function runVerdicts(script, repository, worktreeRoot, extraArguments) {
  const result = spawnSync(process.execPath, [script, worktreeRoot, "--only-under-root", "--json", ...extraArguments], {
    cwd: repository,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 512,
  });
  if (result.status !== 0) return { failure: failedWords(exitWords(result)) };
  const report = parsedOrUndefined(result.stdout);
  if (report === undefined) return { failure: failedWords("its answer was not JSON") };
  return isCurrentAnswer(report) ? { report, failure: "" } : { failure: TOO_OLD };
}

function verdictOfFolder(folder, report) {
  const judged = [...report.worktrees, ...report.folders].find((verdict) => isSamePath(verdict.path, folder));
  if (judged === undefined) return keepFolder(folder, "the worktree verdicts did not judge it: it is not a worktree of the repository it names");
  return { path: folder, verdict: judged.verdict, reasons: judged.reasons };
}

const repositoryKeyOf = (path) => (process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path));

function foldersByRepository(located) {
  const byRepository = new Map();
  for (const folder of located) {
    const key = repositoryKeyOf(folder.repository);
    const entry = byRepository.get(key) ?? { repository: folder.repository, folders: [] };
    entry.folders.push(folder.path);
    byRepository.set(key, entry);
  }
  return [...byRepository.values()];
}

const countOf = (folders, verdict) => folders.filter((folder) => folder.verdict === verdict).length;

function judgeRepository(group, context) {
  const answer = runVerdicts(context.script, group.repository, context.worktreeRoot, []);
  const folders =
    answer.report === undefined
      ? group.folders.map((path) => keepFolder(path, answer.failure))
      : group.folders.map((path) => verdictOfFolder(path, answer.report));
  context.tell(`  ${group.repository}: ${counted(folders.length, "folder", "folders")}, ${countOf(folders, SAFE)} safe, ${countOf(folders, KEEP)} to keep`);
  return { repository: group.repository, folders, branches: answer.report?.branches ?? [], failure: answer.failure };
}

function unjudgedNote(repositories) {
  const failures = [...new Set(repositories.map((repository) => repository.failure).filter((failure) => failure !== ""))];
  if (failures.length === 0) return "";
  const count = repositories.filter((repository) => repository.failure !== "").length;
  return `worktree folders of ${counted(count, "repository", "repositories")} were not judged and are all kept: ${failures.join("; ")}`;
}

function judgeWithSidequest(folders, context) {
  const located = folders.map((path) => ({ path, ...repositoryOf(path) }));
  const unlocated = located.filter((folder) => folder.repository === undefined).map((folder) => keepFolder(folder.path, folder.reason));
  const repositories = foldersByRepository(located.filter((folder) => folder.repository !== undefined)).map((group) => judgeRepository(group, context));
  const note = unjudgedNote(repositories);
  if (note !== "") context.tell(note);
  return { folders: [...repositories.flatMap((repository) => repository.folders), ...unlocated], repositories, note };
}

export function judgeWorktreeFolders(context) {
  const folders = olderWorktreeFolders(context.configDirectory);
  const startedAt = Date.now();
  context.tell(`checking ${WORKTREE_GROUP}: ${counted(folders.length, "folder", "folders")} against their repositories`);
  const judged =
    context.script === undefined
      ? { folders: folders.map((path) => keepFolder(path, SIDEQUEST_MISSING)), repositories: [], note: SIDEQUEST_MISSING }
      : judgeWithSidequest(folders, context);
  context.tell(`checked ${WORKTREE_GROUP} in ${elapsedWords(startedAt)}: ${countOf(judged.folders, SAFE)} safe, ${countOf(judged.folders, KEEP)} to keep`);
  return judged;
}

function worktreeGroup(group, context) {
  const judged = judgeWorktreeFolders(context);
  const offered = judged.folders.filter((folder) => folder.verdict === SAFE).map((folder) => folder.path);
  return { ...group, offered, keeps: judged.folders.filter((folder) => folder.verdict === KEEP), repositories: judged.repositories, note: judged.note };
}

// Removal goes entry by entry inside a group: the parent folder holds the worktree root, which only the verdicts may touch.
const plainGroup = (group, configDirectory) => ({ ...group, offered: group.entries.map((entry) => join(configDirectory, entry)), keeps: [], repositories: [], note: "" });

export function contextOf(options, tell) {
  return {
    configDirectory: options.configDirectory,
    worktreeRoot: olderWorktreeRootOf(options.configDirectory),
    script: options.worktreesScript ?? sidequestWorktreesScript(options.configDirectory),
    operations: options.operations ?? realOperations,
    tell,
  };
}

export function readGroups(options, context) {
  return homeGroups(readHomeFacts(options.configDirectory))
    .filter((group) => options.groupIds.includes(group.id))
    .map((group) => (group.id === WORKTREE_GROUP ? worktreeGroup(group, context) : plainGroup(group, options.configDirectory)));
}

function statsOrUndefined(path) {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

function childrenOf(folder) {
  try {
    return readdirSync(folder).map((name) => join(folder, name));
  } catch {
    return [];
  }
}

// Links are counted as themselves and never followed, so a junction into a project is not sized as part of the home folder.
function sizeOf(path) {
  const stats = statsOrUndefined(path);
  if (stats === undefined) return { bytes: 0, files: 0, children: [] };
  if (stats.isDirectory()) return { bytes: 0, files: 0, children: childrenOf(path) };
  return { bytes: stats.size, files: 1, children: [] };
}

export function measureSize(paths, allowanceSeconds) {
  const deadline = allowanceSeconds === undefined ? Infinity : Date.now() + allowanceSeconds * 1000;
  const pending = [...paths];
  let bytes = 0;
  let files = 0;
  while (pending.length > 0) {
    if (Date.now() >= deadline) return { bytes, files, isComplete: false };
    const counted = sizeOf(pending.pop());
    bytes += counted.bytes;
    files += counted.files;
    pending.push(...counted.children);
  }
  return { bytes, files, isComplete: true };
}

const UNITS = ["B", "KB", "MB", "GB", "TB"];

export function bytesWords(bytes) {
  const exponent = Math.min(UNITS.length - 1, bytes < 1 ? 0 : Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** exponent;
  return `${value < 10 && exponent > 0 ? value.toFixed(1) : Math.round(value)} ${UNITS[exponent]}`;
}

const filesWords = (files) => `${files.toLocaleString("en-US")} files`;

export function sizeWords(size) {
  if (size.isComplete) return bytesWords(size.bytes);
  return `at least ${bytesWords(size.bytes)}, still more (${filesWords(size.files)} counted before the time allowance ran out)`;
}

function sizeGroup(group, allowanceSeconds, tell) {
  const startedAt = Date.now();
  tell(`sizing ${group.id}: ${entriesWords(group.offered.length)}`);
  const size = measureSize(group.offered, allowanceSeconds);
  tell(`sized ${group.id} in ${elapsedWords(startedAt)}: ${sizeWords(size)}`);
  return { ...group, size };
}

const keepLine = (keep) => `      keep ${keep.path}: ${keep.reasons.join(", ")}`;

const MOST_KEEPS_NAMED = 8;

// A real home folder had 99 folders and 239 branches to keep, and naming each made a listing of 408 lines.
function namedUpToALimit(lines, indent, namesAllKeeps) {
  if (namesAllKeeps || lines.length <= MOST_KEEPS_NAMED) return lines;
  return [...lines.slice(0, MOST_KEEPS_NAMED), `${indent}and ${lines.length - MOST_KEEPS_NAMED} more to keep, each for a reason like these: --all-keeps names them`];
}

function branchLines(repository, namesAllKeeps) {
  const keeps = repository.branches.filter((branch) => branch.verdict === KEEP);
  if (repository.branches.length === 0) return [];
  const total = counted(repository.branches.length, "agent branch", "agent branches");
  const headline = `      ${repository.repository}: ${total} with no worktree, ${repository.branches.length - keeps.length} safe to remove, ${keeps.length} to keep`;
  const named = keeps.map((branch) => `        keep ${branch.branch}: ${branch.reasons.join(", ")}`);
  return [headline, ...namedUpToALimit(named, "        ", namesAllKeeps)];
}

const AGENT_FILE_PREFIX = "agents/";

function agentFileLines(group, namesAllKeeps) {
  const named = group.entries.filter((entry) => entry.startsWith(AGENT_FILE_PREFIX)).map((entry) => `      removes ${entry}`);
  if (namesAllKeeps || named.length <= MOST_KEEPS_NAMED) return named;
  return [...named.slice(0, MOST_KEEPS_NAMED), `      and ${named.length - MOST_KEEPS_NAMED} more generated agent files: --all-keeps names them`];
}

function groupCountWords(group) {
  if (group.id !== WORKTREE_GROUP) return `${entriesWords(group.count)}, ${sizeWords(group.size)}`;
  return `${counted(group.count, "folder", "folders")}: ${group.offered.length} safe to remove (${sizeWords(group.size)}), ${group.keeps.length} to keep`;
}

function groupLines(group, namesAllKeeps) {
  return [
    `  ${group.id}: ${group.name}, ${groupCountWords(group)}`,
    `      loses ${group.loses}`,
    ...(group.note === "" ? [] : [`      ${group.note}`]),
    ...agentFileLines(group, namesAllKeeps),
    ...namedUpToALimit(group.keeps.map(keepLine), "      ", namesAllKeeps),
    ...group.repositories.flatMap((repository) => branchLines(repository, namesAllKeeps)),
  ];
}

export function renderGroups(configDirectory, groups, namesAllKeeps = false) {
  if (groups.length === 0) return `Home folder ${configDirectory}: nothing of the older version's state is left.`;
  return [
    `Home folder ${configDirectory}: the older version's state, in groups. Each group needs its own yes; a yes for a project's things is not one.`,
    ...groups.flatMap((group) => groupLines(group, namesAllKeeps)),
    `Remove only the groups the person said yes to: --remove ${groups.map((group) => group.id).join(",")} names them all.`,
  ].join("\n");
}

function removeWholly(path) {
  try {
    rmSync(path, { recursive: true });
    return { isRemoved: true };
  } catch (error) {
    return { isRemoved: false, reason: error.message };
  }
}

// A link is never a folder here: reading through one would list what it points at, which is not ours to remove.
function listFolderChildren(path) {
  try {
    if (!lstatSync(path).isDirectory()) return undefined;
    return readdirSync(path).map((name) => join(path, name));
  } catch {
    return undefined;
  }
}

export const realOperations = { remove: removeWholly, listChildren: listFolderChildren };

const stayedOf = (path, reason) => [{ path, reason }];

// The whole path is tried first, so a healthy folder costs one call. Only a failure walks in, child by child.
function removeAsFarAsPossible(path, operations) {
  const whole = operations.remove(path);
  if (whole.isRemoved) return { isRemoved: true, stayed: [], stillThereCount: 0 };
  const children = operations.listChildren(path);
  if (children === undefined) return { isRemoved: false, stayed: stayedOf(path, whole.reason), stillThereCount: undefined };
  const walked = children.map((child) => removeAsFarAsPossible(child, operations));
  const stayedBelow = walked.flatMap((outcome) => outcome.stayed);
  const stillThereCount = walked.filter((outcome) => !outcome.isRemoved).length;
  if (stayedBelow.length > 0) return { isRemoved: false, stayed: stayedBelow, stillThereCount };
  const last = operations.remove(path);
  return { isRemoved: last.isRemoved, stayed: last.isRemoved ? [] : stayedOf(path, last.reason), stillThereCount };
}

const countOfChildren = (path, operations) => operations.listChildren(path)?.length ?? 0;

// Parts are the entry's own children, counted before the attempt: a failed removal can already have taken some of them.
export function removeEntry(path, operations = realOperations) {
  const partsBefore = countOfChildren(path, operations);
  const outcome = removeAsFarAsPossible(path, operations);
  if (outcome.isRemoved) return { path, isRemoved: true, stayed: [], partCount: 1, removedPartCount: 1 };
  const partCount = Math.max(partsBefore, 1);
  const stayedParts = Math.max(outcome.stillThereCount ?? partCount, 1);
  return { path, isRemoved: false, stayed: outcome.stayed, partCount, removedPartCount: Math.max(partCount - stayedParts, 0) };
}

function removeEmptyFolder(path) {
  try {
    rmdirSync(path);
  } catch {
    // A folder that still holds a kept worktree stays, which is the point.
  }
}

const folderRemovalOf = (removal) => ({
  path: removal.path,
  isRemoved: removal.isRemoved,
  stayed: removal.isRemoved ? [] : stayedOf(removal.path, removal.reason),
  partCount: 1,
  removedPartCount: removal.isRemoved ? 1 : 0,
});

// The script judges every folder again before it removes one, so a folder that changed since the listing is kept.
// --named because the person already saw these folders listed and said yes, whoever named them.
function removeWorktreeFoldersOf(repository, context) {
  const answer = runVerdicts(context.script, repository.repository, context.worktreeRoot, ["--remove-safe", "--named"]);
  if (answer.report === undefined) {
    return { removals: [], branchRemovals: [], keeps: repository.folders.map((folder) => keepFolder(folder.path, answer.failure)) };
  }
  const folders = repository.folders.map((folder) => verdictOfFolder(folder.path, answer.report));
  const removals = [...(answer.report.removals ?? []), ...(answer.report.folderRemovals ?? [])].map(folderRemovalOf);
  return { removals, branchRemovals: answer.report.branchRemovals ?? [], keeps: folders.filter((folder) => folder.verdict === KEEP) };
}

// A repository whose listing the installed script could not answer in the current shape never gets --remove-safe.
function removeWorktreeGroup(group, context) {
  const projectFolders = new Set(group.offered.map(dirname));
  const judged = group.repositories.filter((repository) => repository.failure === "");
  const results = judged.map((repository) => removeWorktreeFoldersOf(repository, context));
  for (const folder of projectFolders) removeEmptyFolder(folder);
  const keptHere = group.keeps.filter((keep) => !judged.some((repository) => repository.folders.includes(keep)));
  return {
    removals: results.flatMap((result) => result.removals),
    branchRemovals: results.flatMap((result) => result.branchRemovals),
    keeps: [...results.flatMap((result) => result.keeps), ...keptHere],
  };
}

function removeGroup(group, context) {
  const startedAt = Date.now();
  context.tell(`removing ${group.id}: ${entriesWords(group.offered.length)}`);
  const outcome =
    group.id === WORKTREE_GROUP
      ? removeWorktreeGroup(group, context)
      : { removals: group.offered.map((path) => removeEntry(path, context.operations)), branchRemovals: [], keeps: [] };
  const counts = partCountsOf(outcome.removals);
  context.tell(`removed ${group.id} in ${elapsedWords(startedAt)}: ${counts.removed} removed, ${counts.total - counts.removed} refused`);
  return { id: group.id, size: group.size, ...outcome };
}

const sumOf = (removals, field) => removals.reduce((sum, removal) => sum + removal[field], 0);

const partCountsOf = (removals) => ({ total: sumOf(removals, "partCount"), removed: sumOf(removals, "removedPartCount") });

const stayedLine = (stayed) => `    kept ${stayed.path}: ${stayed.reason}`;

function namedStayed(removals) {
  const lines = removals.flatMap((removal) => removal.stayed).map(stayedLine);
  if (lines.length <= MOST_KEEPS_NAMED) return lines;
  return [...lines.slice(0, MOST_KEEPS_NAMED), `    and ${lines.length - MOST_KEEPS_NAMED} more stayed, each for a reason like these`];
}

function branchRemovalWords(branchRemovals) {
  const deleted = branchRemovals.filter((removal) => removal.isDeleted).length;
  return branchRemovals.length === 0 ? "" : `, ${counted(deleted, "agent branch", "agent branches")} deleted`;
}

// Only a group that went whole may state the space: the size was measured before the removal, so it is not what a partial removal freed.
function removalHeadline(result) {
  const counts = partCountsOf(result.removals);
  const branches = branchRemovalWords(result.branchRemovals);
  if (counts.removed === 0) return `  nothing removed from ${result.id}: it is all still there${branches}`;
  if (result.removals.every((removal) => removal.isRemoved)) return `  removed ${result.id}: ${entriesWords(counts.removed)}${branches}, got back ${sizeWords(result.size)}`;
  return `  removed part of ${result.id}: ${counts.removed} of ${counts.total} items${branches}; how much space that freed was not measured`;
}

function removalLines(result) {
  return [
    removalHeadline(result),
    ...namedStayed(result.removals),
    ...result.keeps.map((keep) => `    kept ${keep.path}: ${keep.reasons.join(", ")}`),
    ...result.branchRemovals.filter((removal) => !removal.isDeleted).map((removal) => `    kept branch ${removal.branch}: ${removal.reason}`),
  ];
}

export function renderRemovals(results, notApproved) {
  const untouched = notApproved.length === 0 ? [] : [`  kept, no yes given: ${notApproved.join(", ")}`];
  return ["Home cleanup:", ...results.flatMap(removalLines), ...untouched].join("\n");
}

export function removeApprovedGroups(options, tell) {
  const context = contextOf(options, tell);
  const groups = readGroups(options, context).map((group) => sizeGroup(group, options.allowanceSeconds, tell));
  const present = homeGroups(readHomeFacts(options.configDirectory)).map((group) => group.id);
  return { results: groups.map((group) => removeGroup(group, context)), notApproved: present.filter((id) => !options.groupIds.includes(id)) };
}

function valueAfter(commandLineArguments, flag) {
  const index = commandLineArguments.indexOf(flag);
  return index === -1 ? undefined : commandLineArguments[index + 1];
}

function allowanceOf(commandLineArguments) {
  if (commandLineArguments.includes("--exact-sizes")) return undefined;
  const given = Number(valueAfter(commandLineArguments, "--size-seconds"));
  return Number.isFinite(given) && given >= 0 ? given : DEFAULT_ALLOWANCE_SECONDS;
}

export function readOptions(commandLineArguments, environment) {
  const home = valueAfter(commandLineArguments, "--home");
  const removal = valueAfter(commandLineArguments, "--remove");
  const worktreesScript = valueAfter(commandLineArguments, "--worktrees-script");
  return {
    configDirectory: home === undefined ? configDirectoryOf(environment, homedir()) : join(resolve(home), ".claude"),
    worktreesScript: worktreesScript === undefined ? undefined : resolve(worktreesScript),
    isJson: commandLineArguments.includes("--json"),
    allowanceSeconds: allowanceOf(commandLineArguments),
    isRemoval: removal !== undefined,
    groupIds: removal === undefined ? HOME_GROUP_IDS : removal.split(",").map((id) => id.trim()).filter((id) => id !== ""),
  };
}

function groupNamesRefusal(groupIds) {
  const unknown = groupIds.filter((id) => !HOME_GROUP_IDS.includes(id));
  if (unknown.length > 0) return `Nothing removed: no group called ${unknown.join(", ")}. The groups are ${HOME_GROUP_IDS.join(", ")}.`;
  return groupIds.length === 0 ? `Nothing removed: --remove names no group. The groups are ${HOME_GROUP_IDS.join(", ")}.` : "";
}

// The older plugins still on somewhere read this state, so removing it would break their projects.
function stillInUseRefusal(configDirectory) {
  const stillOn = projectsStillOnOlderVersion(readInstalledProjects(configDirectory)).length;
  if (stillOn === 0) return "";
  return `Nothing removed: ${stillOn} project(s) still have the older version on or installed and use this state. The home cleanup waits until none does.`;
}

function refusalOf(options) {
  if (!options.isRemoval) return "";
  return groupNamesRefusal(options.groupIds) || stillInUseRefusal(options.configDirectory);
}

function printListing(options, tell) {
  const groups = readGroups(options, contextOf(options, tell)).map((group) => sizeGroup(group, options.allowanceSeconds, tell));
  console.log(options.isJson ? JSON.stringify({ folder: options.configDirectory, groups }, null, 2) : renderGroups(options.configDirectory, groups, process.argv.includes("--all-keeps")));
}

function printRemovals(options, tell) {
  const outcome = removeApprovedGroups(options, tell);
  console.log(options.isJson ? JSON.stringify(outcome, null, 2) : renderRemovals(outcome.results, outcome.notApproved));
}

export function runHomeCleanup(commandLineArguments, environment) {
  const options = readOptions(commandLineArguments, environment);
  const tell = (line) => process.stderr.write(`${line}\n`);
  const refusal = refusalOf(options);
  if (refusal !== "") {
    console.error(refusal);
    return 1;
  }
  if (options.isRemoval) printRemovals(options, tell);
  else printListing(options, tell);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = runHomeCleanup(process.argv.slice(2), process.env);
}
