#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { configDirectoryOf } from "./config-directory.mjs";
import { loadWithoutDatabaseModuleWarning } from "./database-module-warning.mjs";
import {
  COMMITTED_SETTINGS,
  CURRENT_MARKETPLACE,
  LOCAL_SETTINGS,
  OLDER_BOARD_FOLDER,
  OLDER_MARKETPLACE,
  OLDER_PLUGINS_HELD_BY_TRACKED_SOURCES,
  OLDER_REVIEW_REF_NAMESPACES,
  USER_SCOPE,
  classifyHome,
  classifyProject,
  heldSourceOf,
  isTrackedSourceTheOnlySource,
  olderNamesIn,
  olderPluginsStillOn,
  pluginNamesInSettings,
  projectsStillOnOlderVersion,
  userScopeWaitLine,
} from "./upgrade-findings.mjs";
import { QUIET_DAYS, lastUseOf, lastUseWords, olderProjectCountLine, orderedByLastUse, recentUseCount } from "./upgrade-last-use.mjs";
import { readKeptAnswers } from "./upgrade-kept.mjs";
import { canonicalPath, comparablePath, gitLines, judgeOlderWorktreeFolders, readAgentBranches, readLinkedWorktrees, runGit } from "./upgrade-worktrees.mjs";

export { USER_SCOPE, runGit };

export function readJsonOrEmpty(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed !== null && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function readTextOrEmpty(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function entriesOf(folder) {
  try {
    return readdirSync(folder, { withFileTypes: true });
  } catch {
    return [];
  }
}

export const isSamePath = (first, second) => comparablePath(canonicalPath(first)) === comparablePath(canonicalPath(second));

// The older board keyed every project by this slug, in its database and under its worktree root.
export function olderBoardSlug(projectPath) {
  const base =
    basename(resolve(projectPath)).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "project";
  return `${base}-${createHash("sha1").update(comparablePath(projectPath)).digest("hex").slice(0, 8)}`;
}

export const hostProjectSlug = (projectPath) => resolve(projectPath).replace(/[^a-zA-Z0-9]/g, "-");

const isTracked = (project, path) => gitLines(project, ["ls-files", "--", path]).length > 0;

const isIgnored = (project, path) => runGit(project, ["check-ignore", "-q", "--", path]).exitCode === 0;

function excludeFileOf(project) {
  const common = gitLines(project, ["rev-parse", "--git-common-dir"])[0];
  return common === undefined ? undefined : join(resolve(project, common), "info", "exclude");
}

const OLDER_EXCLUDE_LINES = [".claude/live-rules/", ".claude/live-rules.md", ".claude/quality-gate/"];

function staleExcludeLines(project) {
  const excludeFile = excludeFileOf(project);
  const lines = excludeFile === undefined ? [] : readTextOrEmpty(excludeFile).split(/\r?\n/).map((line) => line.trim());
  return OLDER_EXCLUDE_LINES.filter((line) => lines.includes(line) && !existsSync(join(project, line)));
}

function readReviewRefs(project) {
  const listOf = (extra) => gitLines(project, ["for-each-ref", "--format=%(refname)", ...extra, ...OLDER_REVIEW_REF_NAMESPACES]);
  return { total: listOf([]).length, merged: listOf(["--merged", "HEAD"]).length };
}

const NO_REPOSITORY = {
  isRepository: false,
  isSettingsCommitted: false,
  isLocalSettingsTracked: false,
  authorCount: 0,
  linkedWorktrees: [],
  agentBranches: { merged: 0, unmerged: 0 },
  reviewRefs: { total: 0, merged: 0 },
  isBoardKeptOutOfGit: true,
  staleExcludeLines: [],
};

function readGitFacts(project) {
  if (runGit(project, ["rev-parse", "--git-dir"]).exitCode !== 0) return NO_REPOSITORY;
  const linkedWorktrees = readLinkedWorktrees(project);
  return {
    isRepository: true,
    isSettingsCommitted: isTracked(project, COMMITTED_SETTINGS),
    isLocalSettingsTracked: isTracked(project, LOCAL_SETTINGS),
    authorCount: new Set(gitLines(project, ["log", "--format=%ae"])).size,
    linkedWorktrees,
    agentBranches: readAgentBranches(project, linkedWorktrees),
    reviewRefs: readReviewRefs(project),
    isBoardKeptOutOfGit: isTracked(project, ".sidequest") || isIgnored(project, ".sidequest/board.json"),
    staleExcludeLines: staleExcludeLines(project),
  };
}

const isConvertedRule = (entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "codebase-map.md";

const linesOfText = (path) => readTextOrEmpty(path).split("\n").length - 1;

function linesUnder(folder) {
  return entriesOf(folder).reduce((total, entry) => {
    const path = join(folder, entry.name);
    return total + (entry.isDirectory() ? linesUnder(path) : linesOfText(path));
  }, 0);
}

// Only file checks, so it stays cheap across every installed project.
function readSourcePaths(project) {
  const has = (path) => existsSync(join(project, path));
  return {
    convertedRules: entriesOf(join(project, ".claude", "rules")).some(isConvertedRule),
    rulesFolder: has(".claude/live-rules"),
    rulesPage: has(".claude/live-rules.md"),
    olderMap: has(".claude/.codebase-info"),
    currentMap: has(".claude/rules/codebase-map.md"),
  };
}

function readPathFacts(project) {
  const has = (path) => existsSync(join(project, path));
  return {
    ...readSourcePaths(project),
    olderMapLines: linesUnder(join(project, ".claude", ".codebase-info")),
    qualityGateRecords: has(".claude/quality-gate/receipts") || has(".claude/quality-gate/crap.json"),
    boardFolder: has(".sidequest"),
  };
}

function readTrackedFacts(project, isRepository) {
  if (!isRepository) return { rulesFolder: false, rulesPage: false, olderMap: false, qualityGateRecords: false };
  return {
    rulesFolder: isTracked(project, ".claude/live-rules"),
    rulesPage: isTracked(project, ".claude/live-rules.md"),
    olderMap: isTracked(project, ".claude/.codebase-info"),
    qualityGateRecords: isTracked(project, ".claude/quality-gate"),
  };
}

const INSTRUCTION_FILES = ["CLAUDE.md", "AGENTS.md", ".claude/CLAUDE.md"];

function readInstructionFiles(project, isRepository) {
  return INSTRUCTION_FILES.map((path) => ({ path, names: olderNamesIn(readTextOrEmpty(join(project, path))) }))
    .filter((file) => file.names.length > 0)
    .map((file) => ({ ...file, isTracked: isRepository && isTracked(project, file.path) }));
}

function readMemoryNotes(configDirectory, project) {
  const folder = join(configDirectory, "projects", hostProjectSlug(project), "memory");
  return entriesOf(folder)
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => join(folder, entry.name))
    .filter((path) => olderNamesIn(readTextOrEmpty(path)).length > 0);
}

function readOlderWorktreeFolder(configDirectory, project, linkedWorktrees) {
  const path = join(configDirectory, "sidequest", "worktrees", olderBoardSlug(project));
  return { path, folders: judgeOlderWorktreeFolders(project, path, linkedWorktrees) };
}

const recordOrEmpty = (value) => (value !== null && typeof value === "object" ? value : {});

const currentBoardCategories = (project) => Object.keys(recordOrEmpty(readJsonOrEmpty(join(project, ".sidequest", "board.json")).categories));

const currentBoardWorktrees = (project) => recordOrEmpty(readJsonOrEmpty(join(project, ".sidequest", "board.json")).settings).worktrees;

function queryOrEmpty(database, sql, ...parameters) {
  try {
    return database.prepare(sql).all(...parameters);
  } catch {
    return [];
  }
}

function parseJsonOrEmpty(text) {
  try {
    return JSON.parse(String(text)) ?? {};
  } catch {
    return {};
  }
}

const fallbackOf = (fallback) => (fallback?.model === undefined ? undefined : { model: fallback.model, effort: fallback.effort });

function routeOf(row) {
  const data = parseJsonOrEmpty(row.data);
  const route = data.route ?? {};
  return { category: row.category_id, model: route.model ?? "?", effort: route.effort ?? "?", fallback: fallbackOf(data.fallback) };
}

function readProfile(database, slug) {
  const assigned = queryOrEmpty(
    database,
    "SELECT p.id, p.name, p.source FROM project_routing_profiles a JOIN routing_profiles p ON p.id = a.profile_id WHERE a.project = ?",
    slug,
  )[0];
  if (assigned === undefined) return undefined;
  const rows = queryOrEmpty(database, "SELECT category_id, data FROM routing_profile_entries WHERE profile_id = ? ORDER BY position, category_id", assigned.id);
  return { name: assigned.name, source: assigned.source, routes: rows.map(routeOf) };
}

function readOpenTickets(database, slug) {
  const rows = queryOrEmpty(
    database,
    "SELECT status, COUNT(*) AS count FROM tickets WHERE project = ? AND status != 'done' AND COALESCE(archived, 0) = 0 GROUP BY status",
    slug,
  );
  return Object.fromEntries(rows.map((row) => [String(row.status), Number(row.count)]));
}

function listOpenTickets(database, slug) {
  const rows = queryOrEmpty(
    database,
    "SELECT ref, status, data FROM tickets WHERE project = ? AND status != 'done' AND COALESCE(archived, 0) = 0 ORDER BY ord, ref",
    slug,
  );
  return rows.map((row) => ({ ref: String(row.ref ?? ""), status: String(row.status), title: String(parseJsonOrEmpty(row.data).title ?? "") }));
}

function readWorktreeIsolation(database, slug) {
  const row = queryOrEmpty(database, "SELECT data FROM projects WHERE slug = ?", slug)[0];
  return row === undefined ? undefined : parseJsonOrEmpty(row.data).worktreeIsolation;
}

const sqliteModule =() => loadWithoutDatabaseModuleWarning(() => createRequire(import.meta.url)("node:sqlite"));

export function readOlderBoard(databasePath, slug) {
  if (!existsSync(databasePath)) return { isPresent: false };
  try {
    const database = new (sqliteModule().DatabaseSync)(databasePath, { readOnly: true });
    try {
      const categoryRows = queryOrEmpty(database, "SELECT id, kind FROM project_categories WHERE project = ?", slug);
      return {
        isPresent: true,
        openByStatus: readOpenTickets(database, slug),
        openTickets: listOpenTickets(database, slug),
        profile: readProfile(database, slug),
        worktreeIsolation: readWorktreeIsolation(database, slug),
        projectCategories: categoryRows.map((row) => String(row.id)),
        projectCategoryRoles: Object.fromEntries(categoryRows.map((row) => [String(row.id), String(row.kind)])),
      };
    } finally {
      database.close();
    }
  } catch (error) {
    return { isPresent: true, unreadable: error.message };
  }
}

export function readProjectFacts(project, configDirectory) {
  const git = readGitFacts(project);
  const committed = readJsonOrEmpty(join(project, ".claude", "settings.json"));
  const local = readJsonOrEmpty(join(project, ".claude", "settings.local.json"));
  const userSettingsFile = join(configDirectory, "settings.json");
  const user = readJsonOrEmpty(userSettingsFile);
  return {
    path: resolve(project),
    committed,
    local,
    user,
    userSettingsFile,
    pluginsNamedInSettings: pluginNamesInSettings(committed, local, user),
    keptAnswers: readKeptAnswers(project),
    ...git,
    isTeam: git.authorCount > 1,
    paths: readPathFacts(project),
    tracked: readTrackedFacts(project, git.isRepository),
    instructionFiles: readInstructionFiles(project, git.isRepository),
    memoryNotes: readMemoryNotes(configDirectory, project),
    olderWorktreeFolder: readOlderWorktreeFolder(configDirectory, project, git.linkedWorktrees),
    currentCategories: currentBoardCategories(project),
    currentWorktrees: currentBoardWorktrees(project),
    board: readOlderBoard(join(configDirectory, "sidequest", "sidequest.db"), olderBoardSlug(project)),
  };
}

function modifiedMsOrUndefined(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

function newestSessionMs(configDirectory, projectPath) {
  const folder = join(configDirectory, "projects", hostProjectSlug(projectPath));
  const times = entriesOf(folder)
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => modifiedMsOrUndefined(join(folder, entry.name)))
    .filter((time) => time !== undefined);
  return times.length === 0 ? undefined : Math.max(...times);
}

function lastCommitMs(projectPath) {
  const seconds = Number(gitLines(projectPath, ["log", "-1", "--format=%ct"])[0]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

// The host keeps a project's transcripts for about 30 days, and work done without a session is still use, so the newer of the last session and the last commit counts.
export function readLastUse(configDirectory, projectPath, isFolderPresent) {
  const session = newestSessionMs(configDirectory, projectPath);
  return lastUseOf(session, isFolderPresent ? lastCommitMs(projectPath) : undefined);
}

function olderInstallEntries(record) {
  return Object.entries(record.plugins ?? {})
    .filter(([id, entries]) => id.endsWith(`@${OLDER_MARKETPLACE}`) && Array.isArray(entries))
    .flatMap(([id, entries]) => entries.map((entry) => ({ name: id.slice(0, id.lastIndexOf("@")), scope: entry.scope, projectPath: entry.projectPath })));
}

const installedPathOf = (entry) => (entry.scope === "user" || !entry.projectPath ? USER_SCOPE : entry.projectPath);

const projectKeyOf = (path) => (path === USER_SCOPE ? path : comparablePath(path));

function groupByProject(entries) {
  const projects = new Map();
  for (const entry of entries) {
    const path = installedPathOf(entry);
    const key = projectKeyOf(path);
    const project = projects.get(key) ?? { path, scopes: new Set(), plugins: new Set() };
    project.scopes.add(entry.scope);
    project.plugins.add(entry.name);
    projects.set(key, project);
  }
  return [...projects.values()];
}

function settingsFor(projectPath, configDirectory) {
  if (projectPath === USER_SCOPE) return { committed: readJsonOrEmpty(join(configDirectory, "settings.json")), local: {} };
  return {
    committed: readJsonOrEmpty(join(projectPath, ".claude", "settings.json")),
    local: readJsonOrEmpty(join(projectPath, ".claude", "settings.local.json")),
  };
}

function trackedFactsOf(projectPath, held, paths) {
  const presentSources = held.sources.filter((source) => paths[source.fact] === true);
  return Object.fromEntries(presentSources.map((source) => [source.fact, isTracked(projectPath, source.path)]));
}

// The file checks come first: git runs only for a project that has an older source and nothing converted, and there can be forty projects.
export function olderPluginsNeededByTrackedSources(projectPath) {
  if (projectPath === USER_SCOPE) return [];
  const paths = readSourcePaths(projectPath);
  return OLDER_PLUGINS_HELD_BY_TRACKED_SOURCES.filter((held) => !held.isConverted(paths))
    .filter((held) => isTrackedSourceTheOnlySource(held, paths, trackedFactsOf(projectPath, held, paths)))
    .map((held) => held.plugin);
}

export const olderPluginsHeldByTrackedSources = (projectPath, olderPluginsOn) =>
  olderPluginsOn.length === 0 ? [] : olderPluginsNeededByTrackedSources(projectPath).filter((name) => olderPluginsOn.includes(name));

export function readInstalledProjects(configDirectory) {
  const record = readJsonOrEmpty(join(configDirectory, "plugins", "installed_plugins.json"));
  return groupByProject(olderInstallEntries(record)).map((project) => {
    const settings = settingsFor(project.path, configDirectory);
    const isFolderPresent = project.path === USER_SCOPE || existsSync(project.path);
    const olderPluginsOn = olderPluginsStillOn(settings.committed, settings.local);
    const neededByTrackedSources = olderPluginsNeededByTrackedSources(project.path);
    return {
      path: project.path,
      scopes: [...project.scopes],
      installed: [...project.plugins],
      olderPluginsOn,
      isGatewayKept: project.path !== USER_SCOPE && readKeptAnswers(project.path).gateway !== undefined,
      olderPluginsNeededByTrackedSources: neededByTrackedSources,
      olderPluginsHeld: neededByTrackedSources.filter((name) => olderPluginsOn.includes(name)),
      isFolderPresent,
      lastUse: project.path === USER_SCOPE ? undefined : readLastUse(configDirectory, project.path, isFolderPresent),
    };
  });
}

const HOME_FOLDERS = [
  "sidequest",
  "codebase-mapper-state",
  "live-rules-state",
  "quartermaster-state",
  OLDER_MARKETPLACE,
  "toolshed/registry",
  "codex-gateway",
  "model-gateway",
  `plugins/cache/${OLDER_MARKETPLACE}`,
];

function olderAgentFiles(configDirectory) {
  const generated = entriesOf(join(configDirectory, "agents"))
    .filter((entry) => /^\.?sidequest-exec/.test(entry.name))
    .map((entry) => `agents/${entry.name}`);
  const backups = entriesOf(configDirectory).filter((entry) => entry.name.startsWith("agents-backup-sidequest")).map((entry) => entry.name);
  return [...generated, ...backups];
}

const subfoldersOf = (folder) => entriesOf(folder).filter((entry) => entry.isDirectory()).map((entry) => join(folder, entry.name));

export const olderWorktreeRootOf = (configDirectory) => join(configDirectory, OLDER_BOARD_FOLDER, "worktrees");

// The older board kept one folder per project under its worktree root, each holding that project's worktrees.
export const olderWorktreeFolders = (configDirectory) => subfoldersOf(olderWorktreeRootOf(configDirectory)).flatMap(subfoldersOf);

const heldProjectCounts = (installedProjects) =>
  Object.fromEntries(
    OLDER_PLUGINS_HELD_BY_TRACKED_SOURCES.map((held) => [held.plugin, installedProjects.filter((project) => project.olderPluginsNeededByTrackedSources.includes(held.plugin)).length]),
  );

export function readHomeFacts(configDirectory, installedProjects = readInstalledProjects(configDirectory)) {
  const knownMarketplaces = readJsonOrEmpty(join(configDirectory, "plugins", "known_marketplaces.json"));
  return {
    olderBoardEntries: entriesOf(join(configDirectory, OLDER_BOARD_FOLDER)).map((entry) => entry.name),
    olderWorktreeFolderCount: olderWorktreeFolders(configDirectory).length,
    existingPaths: HOME_FOLDERS.filter((path) => existsSync(join(configDirectory, path))),
    olderAgentFiles: olderAgentFiles(configDirectory),
    olderPluginData: entriesOf(join(configDirectory, "plugins", "data"))
      .filter((entry) => entry.name.endsWith(`-${OLDER_MARKETPLACE}`))
      .map((entry) => `plugins/data/${entry.name}`),
    userSettings: readJsonOrEmpty(join(configDirectory, "settings.json")),
    hasOlderMarketplaceRecord: OLDER_MARKETPLACE in knownMarketplaces,
    heldProjectCounts: heldProjectCounts(installedProjects),
  };
}

const isThisProject = (installed, project) => installed.path !== USER_SCOPE && isSamePath(installed.path, project);

export function scan(options) {
  const installedProjects = readInstalledProjects(options.configDirectory);
  return {
    marketplaces: { older: OLDER_MARKETPLACE, current: CURRENT_MARKETPLACE },
    installedProjects: installedProjects.map((installed) => ({ ...installed, isThisProject: isThisProject(installed, options.project) })),
    project: classifyProject(readProjectFacts(options.project, options.configDirectory)),
    home: { folder: options.configDirectory, ...classifyHome(readHomeFacts(options.configDirectory, installedProjects), installedProjects) },
  };
}

const SHAPE_WORDS = {
  team: (project) => `team repository (${project.isSettingsCommitted ? "settings committed, " : ""}${project.authorCount} people committed)`,
  solo: () => "solo project",
  "half-moved": () => "half-moved: v2 on beside an older plugin switched off locally, with traces left",
  moved: () => "moved: nothing left to do here. What is listed under Kept stays on purpose, for the reason under it",
};

const COMMITTED_CHANGE_WORDS = {
  team: "draft the committed change as a local branch for the team, or keep it personal (recommended: keep it personal)",
  solo: "apply the committed change in the working tree and show git diff for you to commit, or keep it personal (recommended: apply)",
};

const QUESTION_WORDS = {
  "open-tickets": "what to do with the open tickets on the old board",
  deletions: "one yes for the list of what gets deleted",
  "committed-change": (project) => COMMITTED_CHANGE_WORDS[project.isTeam ? "team" : "solo"],
  "home-deletions": "one yes or no per home group, in the home cleanup's own run (never on a project's yes), the board database offered as an archive to keep",
};

const questionWords = (id, project) => (typeof QUESTION_WORDS[id] === "function" ? QUESTION_WORDS[id](project) : QUESTION_WORDS[id]);

const leftoverLines = (leftovers) =>
  leftovers.flatMap((leftover) => [
    `  ${leftover.verdict.padEnd(8)}${leftover.where}`,
    `          ${leftover.why}`,
    ...(leftover.readyLines ?? []).map((line) => `            ${line}`),
  ]);

const installedRow = (installed) => {
  const state = installed.olderPluginsOn.length > 0 ? `on   ${installed.olderPluginsOn.join(", ")}` : "off";
  const lastUse = installed.path === USER_SCOPE ? "" : `  ${lastUseWords(installed.lastUse)}`;
  return `  ${installed.isThisProject ? "*" : " "} ${installed.path}  ${state}${lastUse}${installed.isFolderPresent ? "" : "  (folder gone)"}`;
};

const isOlderStillOn = (installed) => installed.olderPluginsOn.length > 0;

function installedLines(installedProjects, isAllListed, nowMs) {
  if (isAllListed) {
    const stillOn = installedProjects.filter(isOlderStillOn).length;
    return [
      `${OLDER_MARKETPLACE} is installed for ${installedProjects.length} project(s), a plugin of it switched on in ${stillOn}, most recently used first:`,
      ...orderedByLastUse(installedProjects).map(installedRow),
    ];
  }
  const others = installedProjects.filter((installed) => !installed.isThisProject);
  return [olderProjectCountLine(others, nowMs), ...installedProjects.filter((installed) => installed.isThisProject).map(installedRow)];
}

const questionLine = (questions, project = {}) =>
  questions.length === 0
    ? "Questions for the person: none"
    : `Questions for the person (${questions.length}): ${questions.map((id) => questionWords(id, project)).join("; ")}`;

const titledLeftoverLines = (title, leftovers) => (leftovers.length === 0 ? [] : [title, ...leftoverLines(leftovers)]);

function deletionListLines(leftovers) {
  const listed = leftovers.filter((leftover) => leftover.isOnDeletionList);
  if (listed.length === 0) return [];
  return ["Deletion list, the whole of what the one deletions yes covers:", ...listed.map((leftover) => `  ${leftover.where}`)];
}

export const EVERYTHING_WAITS_LINE = "Everything left here waits for the person: this run is done until they answer.";

const olderPluginOnWords = (name, held) => (held.includes(name) ? `${name} ${heldSourceOf(name).onNote}` : name);

function olderPluginsOnWords(project) {
  const held = project.olderPluginsHeld ?? [];
  return project.olderPluginsOn.length === 0 ? "none" : project.olderPluginsOn.map((name) => olderPluginOnWords(name, held)).join(", ");
}

function projectLines(project) {
  const olderOn = olderPluginsOnWords(project);
  const routing = project.routing.lines.length === 0 ? [] : [`Old routes (${project.routing.profile}):`, ...project.routing.lines.map((line) => `  ${line}`)];
  return [
    `This project: ${project.path}`,
    `Shape: ${SHAPE_WORDS[project.shape](project)}`,
    `Older plugins on: ${olderOn}`,
    ...titledLeftoverLines("Still to do:", project.leftovers.filter((leftover) => leftover.isStillToDo)),
    ...titledLeftoverLines("Kept, each for the reason under it:", project.leftovers.filter((leftover) => !leftover.isStillToDo)),
    ...deletionListLines(project.leftovers),
    ...routing,
    ...(project.boardProblem === "" ? [] : [project.boardProblem]),
    questionLine(project.questions, project),
    ...(project.isWaitingForThePerson ? [EVERYTHING_WAITS_LINE] : []),
  ];
}

const MOST_GATEWAY_PROJECTS_NAMED = 3;

const projectCount = (count) => `${count} project${count === 1 ? "" : "s"}`;

// The line said "on somewhere" and left the person to find where: on a real machine the wiring was gone everywhere and
// the plugin's key was still on in three projects, which is all this reads.
export function gatewayLines(projects = []) {
  if (projects.length === 0) return [];
  const beyond = projects.length - MOST_GATEWAY_PROJECTS_NAMED;
  const named = `${projects.slice(0, MOST_GATEWAY_PROJECTS_NAMED).join(", ")}${beyond > 0 ? ` and ${beyond} more` : ""}`;
  return [`The gateway plugin is still switched on in ${projectCount(projects.length)}: ${named}. That is its settings key, whatever is wired or running. Ask the gateway question once, before the first project moves.`];
}

const groupLines = (groups) => groups.flatMap((group) => [`  ${group.id}: ${group.name}, ${group.count} entries`, `          loses ${group.loses}`]);

const HOME_CLEANUP_LINE =
  "Not part of this project's run. The home cleanup is its own run with a yes or no per group: upgrade-home.mjs gives sizes and the worktree verdicts first.";

const QUIET_STEP_LINE = `Projects not used in the last ${QUIET_DAYS} days can be switched off together in one step with one yes: upgrade-quiet-projects.mjs lists them first and writes nothing.`;

export function readyHomeHeadline(home) {
  const except = home.projectsKeptOnPurpose > 0 ? `, except ${home.projectsKeptOnPurpose} kept on purpose (a kept gateway, or a mapper or rules plugin that holds what git tracks)` : "";
  return `Home folder ${home.folder}: no project has a plugin of the older version switched on in its settings${except}, so the one home cleanup can run.`;
}

const userScopeSentence = (home) => {
  const line = userScopeWaitLine(home.userScopeOlderPluginsOn ?? []);
  return line === "" ? [] : [`${line}.`];
};

function homeLines(home, recentUses) {
  const headline = home.isReadyForCleanup
    ? readyHomeHeadline(home)
    : [
        `Home folder ${home.folder}: the cleanup waits until no project has a plugin of the older version switched on in its settings (${home.projectsStillOn} do, ${recentUses} of those were used in the last ${QUIET_DAYS} days).`,
        QUIET_STEP_LINE,
        ...userScopeSentence(home),
      ].join(" ");
  const gateway = gatewayLines(home.gatewayProjects);
  const groups = home.groups.length === 0 ? [] : [HOME_CLEANUP_LINE, ...groupLines(home.groups)];
  return [headline, ...gateway, ...groups, ...leftoverLines(home.leftovers), ...(home.isReadyForCleanup ? [questionLine(home.questions)] : [])];
}

const markScannedProjects = (reports) => {
  const scannedPaths = new Set(reports.flatMap((report) => report.installedProjects.filter((installed) => installed.isThisProject).map((installed) => installed.path)));
  return reports[0].installedProjects.map((installed) => ({ ...installed, isThisProject: scannedPaths.has(installed.path) }));
};

// The install list and the home part are the same for every project, so they print once.
export function renderPlans(reports, isAllListed = false, nowMs = Date.now()) {
  const installedProjects = markScannedProjects(reports);
  return [
    ...installedLines(installedProjects, isAllListed, nowMs),
    ...reports.flatMap((report) => ["", ...projectLines(report.project)]),
    "",
    ...homeLines(reports[0].home, recentUseCount(projectsStillOnOlderVersion(installedProjects), nowMs)),
    "",
    "Nothing changes until /reload-plugins or a new session: a running session keeps the older hooks until then.",
  ].join("\n");
}

export const renderPlan = (report, isAllListed = false) => renderPlans([report], isAllListed);

export function olderVersionLine(report) {
  if (report.project.shape === "moved") return "";
  const plugins = report.project.olderPluginsOn;
  const named = plugins.length === 0 ? "with traces of it left" : `with ${plugins.join(", ")} still on`;
  return `This project is on the older Toolshed (${OLDER_MARKETPLACE}), ${named}. The \`upgrade\` skill moves it; nothing changes until you ask.`;
}

const openTicketLine = (ticket) => `${ticket.ref}  ${ticket.status}  ${ticket.title}`;

export function openTicketLines(report) {
  const tickets = report.project.openTickets;
  return tickets.length === 0 ? ["No open tickets on the old board."] : tickets.map(openTicketLine);
}

function valueAfter(commandLineArguments, flag) {
  const index = commandLineArguments.indexOf(flag);
  return index === -1 ? undefined : commandLineArguments[index + 1];
}

function valuesAfter(commandLineArguments, flag) {
  return commandLineArguments.flatMap((argument, index) => (argument === flag && index + 1 < commandLineArguments.length ? [commandLineArguments[index + 1]] : []));
}

export function readOptions(commandLineArguments, environment, cwd) {
  const home = valueAfter(commandLineArguments, "--home");
  const projects = valuesAfter(commandLineArguments, "--project").map((project) => resolve(project));
  return {
    configDirectory: home === undefined ? configDirectoryOf(environment, homedir()) : join(resolve(home), ".claude"),
    project: projects[0] ?? resolve(cwd),
    projects: projects.length === 0 ? [resolve(cwd)] : projects,
    isJson: commandLineArguments.includes("--json"),
    isOneLine: commandLineArguments.includes("--line"),
    isOpenTicketsListed: commandLineArguments.includes("--open-tickets"),
    isAllListed: commandLineArguments.includes("--all-projects"),
  };
}

export function runScan(commandLineArguments, environment, cwd) {
  const options = readOptions(commandLineArguments, environment, cwd);
  const reports = options.projects.map((project) => scan({ ...options, project }));
  if (options.isOneLine) {
    for (const line of reports.map(olderVersionLine).filter((line) => line !== "")) console.log(line);
    return 0;
  }
  if (options.isOpenTicketsListed) {
    for (const line of reports.flatMap(openTicketLines)) console.log(line);
    return 0;
  }
  const printed = options.isJson ? JSON.stringify(reports.length === 1 ? reports[0] : reports, null, 2) : renderPlans(reports, options.isAllListed);
  console.log(printed);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = runScan(process.argv.slice(2), process.env, process.cwd());
}
