import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { gatewayLines, hostProjectSlug, olderBoardSlug, olderVersionLine, openTicketLines, readLastUse, readOlderBoard, readOptions, readyHomeHeadline, renderPlan, scan } from "./upgrade-scan.mjs";
import { KEPT_RECORD, runKept } from "./upgrade-kept.mjs";
import { LARGE_OLD_MAP_LINES, boardLeftovers, classifyHome, classifyProject, environmentLeftovers, handCommittedFileToCommittedChange, isEverythingLeftWaitingForThePerson, homeGroups, homeLeftovers, olderBoardGroupOf, projectsStillOnOlderVersion, questionsFor, settingsLeftovers, shapeOf } from "./upgrade-findings.mjs";

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "upgrade-scan.mjs");
const OLDER = "eigenwise-toolshed";
const CURRENT = "toolshed-next";

function gitAs(cwd, author, ...args) {
  const email = `${author}@example.com`;
  const environment = { ...process.env, GIT_AUTHOR_NAME: author, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: author, GIT_COMMITTER_EMAIL: email };
  return execFileSync("git", args, { cwd, env: environment, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function writeFile(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

const writeJson = (path, value) => writeFile(path, JSON.stringify(value, null, 2));

function commitAs(repository, author, path, text) {
  writeFile(join(repository, path), text);
  gitAs(repository, author, "add", "--", path);
  gitAs(repository, author, "commit", "-q", "-m", `${author} adds ${path}`);
}

function makeRepository(folder, authors) {
  mkdirSync(folder, { recursive: true });
  gitAs(folder, authors[0], "init", "-q", "-b", "main");
  authors.forEach((author, index) => commitAs(folder, author, `notes/${index}.txt`, `${author}\n`));
  return folder;
}

const olderOn = (...names) => Object.fromEntries(names.map((name) => [`${name}@${OLDER}`, true]));

function buildTeamRepository(folder) {
  makeRepository(folder, ["author-one", "author-two", "author-three"]);
  commitAs(folder, "author-one", ".claude/settings.json", JSON.stringify({
    enabledPlugins: olderOn("sidequest", "codebase-mapper"),
    extraKnownMarketplaces: { [OLDER]: { source: { source: "github", repo: "example/older" } } },
  }));
  commitAs(folder, "author-two", ".claude/live-rules/rules/naming.md", "---\nglobs: ['src/**']\n---\nName things.\n");
  commitAs(folder, "author-three", "CLAUDE.md", "Read .claude/.codebase-info/INDEX.md first.\n");
  return folder;
}

function buildSoloProject(folder) {
  makeRepository(folder, ["solo-author"]);
  commitAs(folder, "solo-author", ".claude/settings.json", JSON.stringify({ enabledPlugins: olderOn("sidequest", "quartermaster") }));
  writeJson(join(folder, ".claude", "settings.local.json"), {
    enabledPlugins: { ...olderOn("live-rules", "retired-helper") },
    env: {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:4000",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "gateway-opus",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
      OTEL_METRICS_EXPORTER: "otlp",
      SIDEQUEST_COMPACTION_POLICY: "eager",
      PYTHONIOENCODING: "utf-8",
    },
    hooks: { SessionStart: [{ matcher: "startup|resume", hooks: [{ type: "command", command: "node launcher.js readiness-gate" }] }] },
    permissions: { allow: ["mcp__plugin_sidequest_board__ticket_create", "Bash(npm test)"] },
    quartermaster: { autoApprovePermissions: true },
  });
  writeFile(join(folder, ".claude", "quality-gate", "receipts", "r1.json"), "{}");
  gitAs(folder, "solo-author", "branch", "worktree-agent-old1");
  gitAs(folder, "solo-author", "branch", "worktree-agent-old2");
  gitAs(folder, "solo-author", "update-ref", "refs/sidequest/SQ-1", "HEAD");
  gitAs(folder, "solo-author", "update-ref", "refs/sidequest-archived/old/SQ-2", "HEAD");
  const unmerged = gitAs(folder, "solo-author", "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "review candidate");
  gitAs(folder, "solo-author", "update-ref", "refs/sidequest-rounds/SQ-3/r1", unmerged);
  gitAs(folder, "solo-author", "update-ref", "refs/other-tool/kept", "HEAD");
  return folder;
}

function buildHalfMovedProject(folder) {
  buildTeamRepository(folder);
  writeJson(join(folder, ".claude", "settings.local.json"), {
    enabledPlugins: { [`sidequest@${CURRENT}`]: true, [`sidequest@${OLDER}`]: false },
  });
  writeFile(join(folder, ".claude", ".codebase-info", "INDEX.md"), "old map\n");
  writeFile(join(folder, ".sidequest", "board.json"), "{}");
  return folder;
}

function buildMovedProject(folder) {
  makeRepository(folder, ["moving-author"]);
  writeJson(join(folder, ".claude", "settings.local.json"), {
    enabledPlugins: { [`sidequest@${CURRENT}`]: true, [`sidequest@${OLDER}`]: false },
  });
  return folder;
}

const installEntry = (scope, projectPath) => ({ scope, projectPath, installPath: "cache", version: "1.0.0" });

function writeInstallRecord(claudeFolder, projects) {
  writeJson(join(claudeFolder, "plugins", "installed_plugins.json"), {
    version: 2,
    plugins: {
      [`sidequest@${OLDER}`]: [installEntry("project", projects.team), installEntry("project", projects.solo), installEntry("local", projects.halfMoved), installEntry("local", projects.moved)],
      [`codebase-mapper@${OLDER}`]: [installEntry("project", projects.team), installEntry("project", projects.gone)],
      [`sidequest@${CURRENT}`]: [installEntry("local", projects.halfMoved)],
    },
  });
}

function openOlderBoard(claudeFolder) {
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
  mkdirSync(join(claudeFolder, "sidequest"), { recursive: true });
  const database = new DatabaseSync(join(claudeFolder, "sidequest", "sidequest.db"));
  database.exec(`
    CREATE TABLE IF NOT EXISTS tickets (id TEXT PRIMARY KEY, project TEXT, ref TEXT, status TEXT, archived INTEGER, ord REAL, claim_by TEXT, data TEXT);
    CREATE TABLE IF NOT EXISTS routing_profiles (id TEXT PRIMARY KEY, name TEXT, source TEXT);
    CREATE TABLE IF NOT EXISTS routing_profile_entries (profile_id TEXT, category_id TEXT, data TEXT, position REAL);
    CREATE TABLE IF NOT EXISTS project_routing_profiles (project TEXT PRIMARY KEY, profile_id TEXT);
    CREATE TABLE IF NOT EXISTS project_categories (project TEXT, id TEXT, kind TEXT, data TEXT);
    CREATE TABLE IF NOT EXISTS projects (slug TEXT PRIMARY KEY, data TEXT);
  `);
  return database;
}

function writeOlderBoard(claudeFolder, soloPath) {
  const database = openOlderBoard(claudeFolder);
  const slug = olderBoardSlug(soloPath);
  const addTicket = database.prepare("INSERT INTO tickets (id, project, ref, status, archived, ord, data) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const titled = (title) => JSON.stringify({ title });
  addTicket.run("T-1", slug, "SQ-1", "todo", 0, 1, titled("Retry failed uploads"));
  addTicket.run("T-2", slug, "SQ-2", "doing", 0, 2, titled("Fix the login form"));
  addTicket.run("T-3", slug, "SQ-3", "done", 0, 3, titled("Done already"));
  addTicket.run("T-4", slug, "SQ-4", "todo", 1, 4, titled("Archived"));
  addTicket.run("T-5", "another-project-12345678", "SQ-1", "todo", 0, 1, titled("Not this project"));
  database.prepare("INSERT INTO routing_profiles VALUES (?, ?, ?)").run("P-1", "my profile", "user");
  const addRoute = database.prepare("INSERT INTO routing_profile_entries VALUES (?, ?, ?, ?)");
  addRoute.run("P-1", "coding.hard", JSON.stringify({ route: { model: "opus", effort: "high" } }), 0);
  addRoute.run("P-1", "review-audit", JSON.stringify({ route: { model: "elsewhere-large", effort: "xhigh" }, fallback: { model: "sonnet", effort: "high" } }), 1);
  addRoute.run("P-1", "docs-writing", JSON.stringify({ route: { model: "sonnet", effort: "high" } }), 2);
  database.prepare("INSERT INTO project_routing_profiles VALUES (?, ?)").run(slug, "P-1");
  database.prepare("INSERT INTO project_categories VALUES (?, ?, ?, ?)").run(slug, "docs-writing", "worker", "{}");
  database.close();
}

function buildHome(home, projects) {
  const claudeFolder = join(home, ".claude");
  writeInstallRecord(claudeFolder, projects);
  writeOlderBoard(claudeFolder, projects.solo);
  writeFile(join(claudeFolder, "codebase-mapper-state", "abc", "state.json"), "{}");
  mkdirSync(join(claudeFolder, "model-gateway"), { recursive: true });
  writeFile(join(claudeFolder, "agents", "sidequest-exec-low.md"), "generated\n");
  mkdirSync(join(claudeFolder, "plugins", "data", `sidequest-${OLDER}`), { recursive: true });
  writeJson(join(claudeFolder, "plugins", "known_marketplaces.json"), { [OLDER]: { autoUpdate: true }, [CURRENT]: {} });
  const finishedWorktree = join(claudeFolder, "sidequest", "worktrees", olderBoardSlug(projects.solo), "agent-1");
  gitAs(projects.solo, "solo-author", "worktree", "add", "-q", "-b", "worktree-agent-finished", finishedWorktree);
  writeFile(join(claudeFolder, "projects", projects.solo.replace(/[^a-zA-Z0-9]/g, "-"), "memory", "board.md"), "Use mcp__plugin_sidequest_board__ticket_list.\n");
}

function snapshotTree(folder, found = new Map()) {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) {
      found.set(path, "folder");
      snapshotTree(path, found);
    } else {
      const stats = statSync(path);
      found.set(path, `${stats.size} ${stats.mtimeMs} ${createHash("sha1").update(readFileSync(path)).digest("hex")}`);
    }
  }
  return found;
}

function writeTranscript(claudeFolder, project, daysAgo) {
  const path = join(claudeFolder, "projects", hostProjectSlug(project), "session.jsonl");
  writeFile(path, "{}\n");
  const when = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  utimesSync(path, when, when);
}

const runScan = (home, project, ...extra) =>
  execFileSync(process.execPath, [scriptPath, "--home", home, "--project", project, ...extra], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const scanJson = (home, project) => JSON.parse(JSON.stringify(scan(readOptions(["--home", home, "--project", project], {}, project))));

const findLeftover = (report, kind) => report.project.leftovers.filter((leftover) => leftover.kind === kind);

describe("the upgrade scan on made-up trees", () => {
  let scratch;
  let home;
  let projects;

  before(() => {
    scratch = mkdtempSync(join(tmpdir(), "quartermaster-upgrade-"));
    home = join(scratch, "home");
    projects = {
      team: buildTeamRepository(join(scratch, "team")),
      solo: buildSoloProject(join(scratch, "solo")),
      halfMoved: buildHalfMovedProject(join(scratch, "half-moved")),
      moved: buildMovedProject(join(scratch, "moved")),
      gone: join(scratch, "gone"),
    };
    buildHome(home, projects);
  });

  after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  test("names the projects that still have the older version on, from the install record", () => {
    const report = scanJson(home, projects.solo);
    const byPath = Object.fromEntries(report.installedProjects.map((installed) => [installed.path, installed]));
    assert.equal(report.installedProjects.length, 5);
    assert.deepEqual(byPath[projects.team].olderPluginsOn.sort(), ["codebase-mapper", "sidequest"]);
    assert.deepEqual(byPath[projects.solo].olderPluginsOn.sort(), ["live-rules", "quartermaster", "retired-helper", "sidequest"]);
    assert.deepEqual(byPath[projects.halfMoved].olderPluginsOn, ["codebase-mapper"]);
    assert.deepEqual(byPath[projects.moved].olderPluginsOn, []);
    assert.equal(byPath[projects.gone].isFolderPresent, false);
    assert.equal(byPath[projects.solo].isThisProject, true);
    assert.equal(report.home.projectsStillOn, 3);
    assert.equal(report.home.isReadyForCleanup, false);
  });

  test("classifies a team repository and never lets the run change its committed file", () => {
    const report = scanJson(home, projects.team);
    assert.equal(report.project.shape, "team");
    assert.equal(report.project.authorCount, 3);
    const committedPlugins = findLeftover(report, "older-plugin");
    assert.deepEqual(committedPlugins.map((leftover) => leftover.verdict), ["ask", "ask"]);
    assert.equal(findLeftover(report, "older-marketplace")[0].verdict, "ask");
    assert.deepEqual(findLeftover(report, "rules-folder").map((leftover) => leftover.verdict), ["keep"]);
    assert.match(findLeftover(report, "rules-folder")[0].why, /committed work/);
    assert.equal(findLeftover(report, "instruction-text")[0].verdict, "ask");
    assert.deepEqual(report.project.questions, ["committed-change"]);
    assert.match(renderPlan(report), /draft the committed change as a local branch for the team.*recommended: keep it personal/);
  });

  test("classifies a solo project and gives each leftover its verdict", () => {
    const report = scanJson(home, projects.solo);
    assert.equal(report.project.shape, "solo");
    const verdicts = Object.fromEntries(report.project.leftovers.map((leftover) => [`${leftover.kind} ${leftover.where.split(" ").pop()}`, leftover.verdict]));
    assert.equal(verdicts[`older-plugin sidequest@${OLDER}`], "ask");
    assert.equal(verdicts[`older-plugin live-rules@${OLDER}`], "convert");
    assert.equal(verdicts[`older-plugin retired-helper@${OLDER}`], "remove");
    const verdictOf = (kind) => findLeftover(report, kind)[0]?.verdict;
    assert.equal(verdictOf("gateway-wiring"), "ask");
    assert.equal(verdictOf("gateway-hooks"), "ask");
    assert.equal(verdictOf("telemetry-export"), "remove");
    assert.equal(verdictOf("older-board-setting"), "remove");
    assert.equal(verdictOf("python-encoding"), "keep");
    assert.equal(verdictOf("older-permissions"), "remove");
    assert.equal(verdictOf("auto-approve-switch"), "remove");
    assert.equal(verdictOf("quality-gate-records"), "remove");
    assert.equal(verdictOf("agent-branches"), "convert");
    assert.equal(verdictOf("older-worktrees"), "convert");
    assert.equal(verdictOf("memory-notes"), "convert");
    assert.equal(verdictOf("custom-routing"), "convert");
    assert.equal(verdictOf("other-provider-routes"), "keep");
    assert.match(findLeftover(report, "open-tickets")[0].where, /^2 open tickets/);
    assert.deepEqual(report.project.openTickets.map((ticket) => `${ticket.ref} ${ticket.status} ${ticket.title}`), [
      "SQ-1 todo Retry failed uploads",
      "SQ-2 doing Fix the login form",
    ]);
    const reviewRefs = findLeftover(report, "older-review-refs")[0];
    assert.equal(reviewRefs.verdict, "remove");
    assert.match(reviewRefs.where, /^3 refs under .*: 2 merged/);
    assert.deepEqual(report.project.routing.lines, ["coding.hard: opus high", "review-audit: elsewhere-large xhigh, fallback sonnet high", "docs-writing: sonnet high"]);
    assert.deepEqual(findLeftover(report, "custom-routing")[0].readyLines, ['"docs-writing": { "tier": "standard", "role": "worker", "description": "Was docs-writing." }']);
    assert.deepEqual(report.project.questions, ["open-tickets", "deletions", "committed-change"]);
  });

  test("classifies a half-moved project and keeps the part that already works", () => {
    const report = scanJson(home, projects.halfMoved);
    assert.equal(report.project.shape, "half-moved");
    assert.equal(report.project.isTeam, true);
    const localKey = findLeftover(report, "older-plugin").find((leftover) => leftover.where.startsWith(".claude/settings.local.json"));
    assert.equal(localKey.verdict, "keep");
    assert.equal(findLeftover(report, "older-map")[0].verdict, "convert");
    assert.equal(findLeftover(report, "board-not-excluded")[0].verdict, "convert");
  });

  test("finds nothing left in a project that finished moving", () => {
    const report = scanJson(home, projects.moved);
    assert.equal(report.project.shape, "moved");
    assert.deepEqual(report.project.questions, []);
  });

  test("lists the home folder in groups and holds the cleanup while a project is on", () => {
    const report = scanJson(home, projects.moved);
    const groups = Object.fromEntries(report.home.groups.map((group) => [group.id, group]));
    assert.deepEqual(Object.keys(groups), ["board-database", "worktree-folders", "other-plugins"]);
    assert.deepEqual(groups["board-database"].entries, ["sidequest/sidequest.db"]);
    assert.equal(groups["worktree-folders"].count, 1);
    assert.deepEqual(groups["other-plugins"].entries, ["codebase-mapper-state", "agents/sidequest-exec-low.md", `plugins/data/sidequest-${OLDER}`]);
    const where = report.home.leftovers.map((leftover) => `${leftover.verdict} ${leftover.where}`);
    assert.deepEqual(where, ["ask model-gateway", `keep plugins/known_marketplaces.json ${OLDER}`]);
    assert.match(report.home.leftovers[1].why, /still have a plugin of it switched on/);
    assert.deepEqual(report.home.questions, []);
    assert.match(renderPlan(report), /Not part of this project's run/);
  });

  test("prints a plan a person can read, and the same as JSON", () => {
    const plan = runScan(home, projects.solo);
    assert.match(plan, /Other projects: 4 have the older version installed\. 2 still have a plugin of it switched on in their settings; 2 of those were used in the last 30 days\./);
    assert.match(plan, /the cleanup waits until no project has a plugin of the older version switched on in its settings \(3 do, 3 of those were used in the last 30 days\)/);
    assert.match(plan, /upgrade-quiet-projects\.mjs/);
    assert.match(plan, /Shape: solo project/);
    assert.match(plan, /Old routes \(my profile\)/);
    assert.match(plan, /Questions for the person \(3\)/);
    assert.match(plan, /\/reload-plugins/);
    assert.equal(JSON.parse(runScan(home, projects.solo, "--json")).project.shape, "solo");
  });

  test("says when the home folder is ready for its one cleanup", () => {
    const quietHome = join(scratch, "quiet-home");
    mkdirSync(join(quietHome, ".claude", "codebase-mapper-state"), { recursive: true });
    const report = scanJson(quietHome, projects.moved);
    assert.equal(report.home.isReadyForCleanup, true);
    assert.deepEqual(report.home.questions, ["home-deletions"]);
    assert.match(renderPlan(report), /the one home cleanup can run/);
    const notARepository = scanJson(quietHome, quietHome);
    assert.equal(notARepository.project.shape, "moved");
    assert.equal(notARepository.project.isTeam, false);
    rmSync(quietHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  test("outfit's exploration says in one line that the project is on the older version and points at upgrade", () => {
    const lines = runScan(home, projects.halfMoved, "--line").trimEnd().split("\n");
    assert.equal(lines.length, 1);
    assert.match(lines[0], /on the older Toolshed/);
    assert.match(lines[0], /`upgrade` skill/);
    assert.match(runScan(home, projects.team, "--line"), /still on/);
  });

  test("the one line stays silent for a project that finished moving", () => {
    assert.equal(runScan(home, projects.moved, "--line"), "");
  });

  test("writes nothing, anywhere in the made-up trees", () => {
    const before = snapshotTree(scratch);
    for (const project of [projects.team, projects.solo, projects.halfMoved, projects.moved, scratch]) {
      runScan(home, project);
      runScan(home, project, "--json");
      runScan(home, project, "--line");
    }
    assert.deepEqual(snapshotTree(scratch), before);
  });
});

function buildProjectWithOnlyKeptThingsLeft(folder, home) {
  makeRepository(folder, ["kept-author"]);
  writeJson(join(folder, ".claude", "settings.local.json"), { enabledPlugins: { [`sidequest@${CURRENT}`]: true, [`sidequest@${OLDER}`]: false } });
  writeJson(join(folder, ".sidequest", "board.json"), { version: 1, categories: { lookup: { tier: "light", role: "scout", description: "Bounded lookup." } } });
  writeFile(join(folder, ".git", "info", "exclude"), ".sidequest/\n");
  const unmerged = gitAs(folder, "kept-author", "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "work that is nowhere else");
  gitAs(folder, "kept-author", "update-ref", "refs/heads/worktree-agent-unmerged", unmerged);
  const olderWorktreeRoot = join(home, ".claude", "sidequest", "worktrees", olderBoardSlug(folder));
  gitAs(folder, "kept-author", "worktree", "add", "-q", "-b", "worktree-agent-kept", join(olderWorktreeRoot, "agent-kept"));
  commitAs(join(olderWorktreeRoot, "agent-kept"), "kept-author", "draft.txt", "only here\n");
  writeFile(join(olderWorktreeRoot, "stray", "notes.txt"), "a file the repository lacks\n");
  const database = openOlderBoard(join(home, ".claude"));
  const slug = olderBoardSlug(folder);
  const addTicket = database.prepare("INSERT INTO tickets (id, project, ref, status, archived, ord, data) VALUES (?, ?, ?, ?, ?, ?, ?)");
  addTicket.run(`${slug}-1`, slug, "SQ-7", "todo", 0, 1, JSON.stringify({ title: "Archive the old exports" }));
  addTicket.run(`${slug}-2`, slug, "SQ-8", "doing", 0, 2, JSON.stringify({ title: "Half-done claim" }));
  database.prepare("INSERT INTO project_categories VALUES (?, ?, ?, ?)").run(slug, "lookup", "scout", "{}");
  database.close();
  return folder;
}

describe("a project whose only leftovers are kept on purpose", () => {
  let scratch;
  let home;
  let keptOnly;

  before(() => {
    scratch = mkdtempSync(join(tmpdir(), "quartermaster-upgrade-kept-"));
    home = join(scratch, "home");
    keptOnly = buildProjectWithOnlyKeptThingsLeft(join(scratch, "kept-only"), home);
  });

  after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  test("reads as moved, with each kept thing and its reason", () => {
    const report = scanJson(home, keptOnly);
    assert.equal(report.project.shape, "moved");
    assert.deepEqual(report.project.questions, []);
    assert.deepEqual(report.project.leftovers.filter((leftover) => leftover.isStillToDo), []);
    const keptReason = (kind) => findLeftover(report, kind).map((leftover) => `${leftover.verdict} ${leftover.where} | ${leftover.why}`).join("\n");
    assert.match(keptReason("open-tickets"), /^keep 2 open tickets .*read-only archive/);
    assert.match(keptReason("agent-branches"), /^keep 1 worktree-agent-\* branches with commits .*nowhere else/);
    assert.match(keptReason("older-worktrees"), /^keep .*2 folder\(s\) tidy keeps .*agent-kept: 1 commit on no remote.*stray: not a worktree of this repository/);
    assert.match(keptReason("older-worktrees"), /this project's folder under the older worktree root/);
    assert.match(keptReason("custom-routing"), /^keep lookup \| written into \.sidequest\/board\.json/);
    const plan = renderPlan(report);
    assert.match(plan, /Shape: moved: nothing left to do here/);
    assert.match(plan, /Kept, each for the reason under it:/);
    assert.doesNotMatch(plan, /Still to do:/);
  });

  test("does not read as moved while something is still to do", () => {
    gitAs(keptOnly, "kept-author", "branch", "worktree-agent-merged");
    try {
      const report = scanJson(home, keptOnly);
      assert.equal(report.project.shape, "half-moved");
      const toDo = report.project.leftovers.filter((leftover) => leftover.isStillToDo);
      assert.deepEqual(toDo.map((leftover) => `${leftover.kind} ${leftover.verdict}`), ["agent-branches convert"]);
      assert.deepEqual(report.project.questions, ["open-tickets", "deletions"]);
      assert.match(renderPlan(report), /Still to do:\n {2}convert {1}1 worktree-agent-\* branches merged/);
    } finally {
      gitAs(keptOnly, "kept-author", "branch", "-D", "worktree-agent-merged");
    }
  });
});

function buildTeamRepositoryWithCommittedMap(folder) {
  makeRepository(folder, ["map-one", "map-two", "map-three"]);
  commitAs(folder, "map-one", ".claude/settings.json", JSON.stringify({ enabledPlugins: olderOn("codebase-mapper") }));
  commitAs(folder, "map-two", ".claude/.codebase-info/INDEX.md", "the old map\n");
  writeJson(join(folder, ".claude", "settings.local.json"), {
    enabledPlugins: { [`codebase-mapper@${CURRENT}`]: true, [`codebase-mapper@${OLDER}`]: false },
  });
  return folder;
}

describe("a team repository whose old map is committed", () => {
  let scratch;
  let home;
  let team;

  before(() => {
    scratch = mkdtempSync(join(tmpdir(), "quartermaster-upgrade-team-map-"));
    home = join(scratch, "home");
    team = buildTeamRepositoryWithCommittedMap(join(scratch, "team"));
  });

  after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  const oldMapLines = (report) => findLeftover(report, "older-map").map((leftover) => `${leftover.verdict} ${leftover.isOnDeletionList}`);

  test("reads the old map as the team's and kept before it is converted, and lists it for no deletion", () => {
    const report = scanJson(home, team);
    assert.equal(report.project.isTeam, true);
    assert.deepEqual(oldMapLines(report), ["keep false"]);
    const [teams] = findLeftover(report, "older-map");
    assert.equal(teams.isCommittedChange, true);
    assert.equal(teams.isLaterStep, undefined);
    assert.match(teams.why, /^git tracks it, so it is the repository's map: it moves for everyone with the committed change/);
    assert.equal(report.project.questions.includes("deletions"), false);
    assert.doesNotMatch(renderPlan(report), /Deletion list/);
  });

  test("still reads it as the team's and kept once the map is converted, never as a removal", () => {
    writeFile(join(team, ".claude", "rules", "codebase-map.md"), "the v2 map\n");
    const report = scanJson(home, team);
    assert.deepEqual(oldMapLines(report), ["keep false"]);
    assert.equal(report.project.leftovers.some((leftover) => leftover.isOnDeletionList), false);
    assert.equal(report.project.shape, "moved");
    const plan = renderPlan(report);
    assert.match(plan, /Kept, each for the reason under it:[\s\S]*keep {4}\.claude\/\.codebase-info\/\n {10}git tracks it, so it is the repository's map/);
    assert.doesNotMatch(plan, /Deletion list/);
  });
});

const DEFAULT_ROUTED_CATEGORIES = ["codebase-exploration", "coding.easy", "coding.normal", "debugging", "general", "review-audit"];

function buildProjectThePersonAnswered(folder, home) {
  makeRepository(folder, ["answering-author"]);
  writeJson(join(folder, ".claude", "settings.local.json"), {
    enabledPlugins: { [`sidequest@${CURRENT}`]: true, [`sidequest@${OLDER}`]: false, [`model-gateway@${OLDER}`]: true },
    env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:4000" },
  });
  writeFile(join(folder, ".claude", "live-rules", "rules", "naming.md"), "Name things.\n");
  writeFile(join(home, ".claude", "projects", hostProjectSlug(folder), "memory", "models.md"), "The model-gateway serves other providers here.\n");
  const database = openOlderBoard(join(home, ".claude"));
  const slug = olderBoardSlug(folder);
  const addTicket = database.prepare("INSERT INTO tickets (id, project, ref, status, archived, ord, data) VALUES (?, ?, ?, ?, ?, ?, ?)");
  addTicket.run(`${slug}-1`, slug, "SQ-4", "todo", 0, 1, JSON.stringify({ title: "Export the reports" }));
  addTicket.run(`${slug}-2`, slug, "SQ-5", "review", 0, 2, JSON.stringify({ title: "Check the export" }));
  const addCategory = database.prepare("INSERT INTO project_categories VALUES (?, ?, ?, ?)");
  for (const category of DEFAULT_ROUTED_CATEGORIES) addCategory.run(slug, category, "worker", "{}");
  database.close();
  return folder;
}

describe("a project where the person kept things on purpose", () => {
  let scratch;
  let home;
  let answered;

  before(() => {
    scratch = mkdtempSync(join(tmpdir(), "quartermaster-upgrade-answered-"));
    home = join(scratch, "home");
    answered = buildProjectThePersonAnswered(join(scratch, "answered"), home);
  });

  after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  const keptLines = (report) =>
    report.project.leftovers.filter((leftover) => leftover.keptOnAnswer !== undefined).map((leftover) => `${leftover.kind} ${leftover.verdict} | ${leftover.why}`);

  test("before the answers, the memory note is still to do and the tickets are asked about, while the rules and categories never were", () => {
    const report = scanJson(home, answered);
    assert.notEqual(report.project.shape, "moved");
    assert.deepEqual(report.project.leftovers.filter((leftover) => leftover.isStillToDo).map((leftover) => leftover.kind), ["memory-notes"]);
    assert.deepEqual(report.project.questions, ["open-tickets"]);
    assert.match(findLeftover(report, "rules-folder")[0].why, /live-rules was never on in this project/);
    assert.equal(findLeftover(report, "rules-folder")[0].verdict, "keep");
    assert.deepEqual(findLeftover(report, "custom-routing"), []);
  });

  test("an answer outside what can be kept writes nothing", () => {
    const answer = runKept(["--project", answered, "--keep", "rules-folder", "--reason", "no"], answered, "2026-11-20");
    assert.equal(answer.exitCode, 1);
    assert.match(answer.lines[0], /--keep takes gateway, memory-notes, open-tickets/);
    assert.equal(existsSync(join(answered, KEPT_RECORD)), false);
  });

  test("once the answers are recorded it reads as moved, and every later scan lists them as kept with when and why", () => {
    runKept(["--project", answered, "--keep", "gateway", "--reason", "they pick other providers' models in /model"], answered, "2026-11-20");
    runKept(["--project", answered, "--keep", "open-tickets", "--reason", "left in the old board as an archive"], answered, "2026-11-20");
    const keptScript = join(dirname(fileURLToPath(import.meta.url)), "upgrade-kept.mjs");
    const written = execFileSync(process.execPath, [keptScript, "--project", answered, "--keep", "memory-notes", "--reason", "the notes are still true here"], {
      encoding: "utf8",
    });
    assert.match(written, /memory-notes: kept \d{4}-\d{2}-\d{2}, the notes are still true here/);

    for (const report of [scanJson(home, answered), scanJson(home, answered)]) {
      assert.equal(report.project.shape, "moved");
      assert.deepEqual(report.project.questions, []);
      assert.deepEqual(report.project.leftovers.filter((leftover) => leftover.isStillToDo), []);
      const lines = keptLines(report);
      assert.equal(lines.length, 4);
      assert.match(lines.find((line) => line.startsWith("older-plugin")), /^older-plugin keep \| kept on 2026-11-20 on the person's answer: they pick other/);
      assert.match(lines.find((line) => line.startsWith("gateway-wiring")), /^gateway-wiring keep \| kept on 2026-11-20 on the person's answer/);
      assert.match(lines.find((line) => line.startsWith("open-tickets")), /^open-tickets keep \| kept on 2026-11-20 on the person's answer: left in the old board/);
      assert.match(lines.find((line) => line.startsWith("memory-notes")), /^memory-notes keep \| kept on \d{4}-\d{2}-\d{2}: the notes are still true here$/);
    }
    const plan = renderPlan(scanJson(home, answered));
    assert.match(plan, /Shape: moved/);
    assert.doesNotMatch(plan, /Still to do:/);
  });

  test("the record is a page a person can read, in Quartermaster's folder, which git never sees", () => {
    const record = readFileSync(join(answered, KEPT_RECORD), "utf8");
    assert.match(record, /^# Kept on purpose in the Toolshed upgrade/);
    assert.match(record, /^- gateway: kept 2026-11-20, they pick other providers' models in \/model$/m);
    assert.equal(gitAs(answered, "answering-author", "status", "--porcelain", "--", ".claude/quartermaster"), "");
  });
});

describe("the verdict rules", () => {
  const emptyFacts = {
    path: "/project",
    committed: {},
    local: {},
    isTeam: false,
    authorCount: 1,
    isSettingsCommitted: false,
    paths: { convertedRules: false, rulesFolder: false, rulesPage: false, olderMap: false, currentMap: false, qualityGateRecords: false, boardFolder: false },
    tracked: { rulesFolder: false, rulesPage: false, olderMap: false },
    isBoardKeptOutOfGit: true,
    staleExcludeLines: [],
    agentBranches: { merged: 0, unmerged: 0 },
    reviewRefs: { total: 0, merged: 0 },
    olderWorktreeFolder: { path: "", folders: [] },
    memoryNotes: [],
    instructionFiles: [],
    currentCategories: [],
    pluginsNamedInSettings: ["live-rules", "codebase-mapper"],
    keptAnswers: {},
    board: { isPresent: false },
  };

  test("a team repository hands what the run would do to its committed file to the team", () => {
    const leftover = { kind: "older-permissions", file: ".claude/settings.json", verdict: "remove", why: "" };
    assert.equal(handCommittedFileToCommittedChange(leftover, [".claude/settings.json"]).verdict, "ask");
    assert.equal(handCommittedFileToCommittedChange(leftover, []).verdict, "remove");
  });

  test("a project with nothing of the older version asks nothing", () => {
    const project = classifyProject(emptyFacts);
    assert.equal(project.shape, "moved");
    assert.deepEqual(project.questions, []);
  });

  test("an old map beside the new one is only a removal", () => {
    const project = classifyProject({ ...emptyFacts, paths: { ...emptyFacts.paths, olderMap: true, currentMap: true } });
    assert.deepEqual(project.leftovers.map((leftover) => `${leftover.verdict} ${leftover.isOnDeletionList}`), ["remove true"]);
    assert.deepEqual(project.questions, ["deletions"]);
  });

  test("an unreadable old board is said, not guessed", () => {
    const project = classifyProject({ ...emptyFacts, board: { isPresent: true, unreadable: "locked" } });
    assert.match(project.boardProblem, /locked/);
  });

  test("a team repository the person switched over is done for them, and the team's part stays listed", () => {
    const project = classifyProject({
      ...emptyFacts,
      isTeam: true,
      isSettingsCommitted: true,
      committed: { enabledPlugins: { [`sidequest@${OLDER}`]: true } },
      local: { enabledPlugins: { [`sidequest@${OLDER}`]: false, [`sidequest@${CURRENT}`]: true } },
    });
    assert.equal(project.shape, "moved");
    assert.deepEqual(project.leftovers.map((leftover) => leftover.verdict), ["ask", "keep"]);
  });

  test("a gateway kept on the home answer does not hold up the move", () => {
    const local = { enabledPlugins: { [`model-gateway@${OLDER}`]: true }, env: { ANTHROPIC_BASE_URL: "http://localhost:4000" } };
    const project = classifyProject({ ...emptyFacts, local });
    assert.equal(project.shape, "moved");
    assert.deepEqual(project.leftovers.map((leftover) => leftover.kind), ["older-plugin", "gateway-wiring"]);
  });

  test("old rules beside converted ones are only a removal", () => {
    const project = classifyProject({ ...emptyFacts, paths: { ...emptyFacts.paths, rulesFolder: true, convertedRules: true } });
    assert.deepEqual(project.leftovers.map((leftover) => `${leftover.kind} ${leftover.verdict}`), ["rules-folder remove"]);
  });

  test("review refs that all hold unmerged work are kept", () => {
    const project = classifyProject({ ...emptyFacts, reviewRefs: { total: 4, merged: 0 } });
    assert.deepEqual(project.leftovers.map((leftover) => leftover.verdict), ["keep"]);
    assert.equal(project.shape, "moved");
  });

  test("custom routing reads as kept once the v2 board has its categories, and as to do until then", () => {
    const board = { isPresent: true, openByStatus: {}, profile: { name: "own", source: "user", routes: [] }, projectCategories: ["lookup"] };
    const missing = classifyProject({ ...emptyFacts, board });
    assert.deepEqual(missing.leftovers.map((leftover) => `${leftover.kind} ${leftover.verdict} ${leftover.where}`), ["custom-routing convert lookup"]);
    assert.equal(missing.shape, "solo");
    const written = classifyProject({ ...emptyFacts, board, currentCategories: ["build", "lookup"] });
    assert.deepEqual(written.leftovers.map((leftover) => `${leftover.kind} ${leftover.verdict}`), ["custom-routing keep"]);
    assert.equal(written.shape, "moved");
  });

  test("a tracked old map is kept and off the deletion list whatever the author count", () => {
    const facts = { ...emptyFacts, paths: { ...emptyFacts.paths, olderMap: true }, tracked: { ...emptyFacts.tracked, olderMap: true } };
    for (const isTeam of [false, true]) {
      const [tracked] = classifyProject({ ...facts, isTeam }).leftovers;
      assert.equal(tracked.verdict, "keep");
      assert.equal(tracked.isOnDeletionList, false);
      assert.match(tracked.why, /git tracks it/);
      assert.doesNotMatch(tracked.why, /team/);
    }
  });

  test("old categories that v2's defaults already route are not offered as custom ones", () => {
    const defaults = ["codebase-exploration", "coding.easy", "coding.normal", "debugging", "general", "review-audit"];
    const board = { isPresent: true, openByStatus: {}, projectCategories: [...defaults, "lookup"] };
    const project = classifyProject({ ...emptyFacts, board });
    assert.deepEqual(project.leftovers.map((leftover) => `${leftover.kind} ${leftover.verdict} ${leftover.where}`), ["custom-routing convert lookup"]);
    const onlyDefaults = classifyProject({ ...emptyFacts, board: { ...board, projectCategories: defaults } });
    assert.deepEqual(onlyDefaults.leftovers, []);
    assert.equal(onlyDefaults.shape, "moved");
  });

  test("the old rules are not converted where the rules plugin was never on, older or v2", () => {
    const facts = { ...emptyFacts, pluginsNamedInSettings: [], paths: { ...emptyFacts.paths, rulesFolder: true, rulesPage: true } };
    const project = classifyProject(facts);
    assert.deepEqual(project.leftovers.map((leftover) => `${leftover.kind} ${leftover.verdict}`), ["rules-folder keep", "rules-page keep"]);
    assert.match(project.leftovers[0].why, /live-rules was never on in this project/);
    assert.equal(project.shape, "moved");
    assert.deepEqual(project.questions, []);
    const switchedOff = classifyProject({ ...facts, pluginsNamedInSettings: ["live-rules"] });
    assert.deepEqual(switchedOff.leftovers.map((leftover) => leftover.verdict), ["convert", "convert"]);
  });

  test("telemetry keys are removed only when the endpoint is on this machine, and kept anywhere else", () => {
    const settingsWith = (endpoint) => ({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: endpoint, CLAUDE_CODE_ENABLE_TELEMETRY: "1" } });
    const [local] = environmentLeftovers("settings.json", settingsWith("http://127.0.0.1:4318"));
    assert.equal(local.verdict, "remove");
    const [company] = environmentLeftovers("settings.json", settingsWith("https://otel.corp.example:4318"));
    assert.equal(company.verdict, "keep");
    assert.equal(company.why, "not the older Toolshed's: it points at https://otel.corp.example:4318, so it stays");
    const home = { existingPaths: [], olderPluginData: [], userSettings: settingsWith("https://otel.corp.example:4318") };
    assert.equal(homeLeftovers(home).find((leftover) => leftover.kind === "telemetry-export").verdict, "keep");
  });

  test("the older marketplace's leftover names where v2 comes from", () => {
    const settings = { extraKnownMarketplaces: { [OLDER]: { source: { source: "github", repo: "example/older" } } } };
    const [leftover] = settingsLeftovers(".claude/settings.json", settings, false).filter((each) => each.kind === "older-marketplace");
    assert.match(leftover.why, /declare toolshed-next from Eigenwise\/eigenwise-toolshed with ref v2/);
  });

  test("the shape and the questions follow the leftovers", () => {
    assert.equal(shapeOf(emptyFacts, [{ verdict: "keep" }]), "moved");
    assert.deepEqual(questionsFor("solo", [{ kind: "open-tickets", verdict: "ask" }]), ["open-tickets"]);
  });
});

function buildTwoAuthorRepositoryWithTrackedOlderFolders(folder) {
  makeRepository(folder, ["pair-one", "pair-two"]);
  commitAs(folder, "pair-one", ".claude/settings.json", JSON.stringify({
    enabledPlugins: olderOn("sidequest", "live-rules", "codebase-mapper"),
    extraKnownMarketplaces: { [OLDER]: { source: { source: "github", repo: "example/older" } } },
  }));
  commitAs(folder, "pair-two", ".claude/live-rules/rules/naming.md", "Name things.\n");
  commitAs(folder, "pair-two", ".claude/.codebase-info/INDEX.md", "the old map\n");
  commitAs(folder, "pair-one", "CLAUDE.md", "Read .claude/.codebase-info/INDEX.md first.\n");
  return folder;
}

const switchedOverLocally = (...names) => ({
  enabledPlugins: Object.fromEntries(names.flatMap((name) => [[`${name}@${CURRENT}`, true], [`${name}@${OLDER}`, false]])),
});

describe("a two-author repository with a committed settings file and tracked older folders", () => {
  let scratch;
  let home;
  let pair;

  before(() => {
    scratch = mkdtempSync(join(tmpdir(), "quartermaster-upgrade-pair-"));
    home = join(scratch, "home");
    pair = buildTwoAuthorRepositoryWithTrackedOlderFolders(join(scratch, "pair"));
  });

  after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  test("puts no tracked path on the deletion list and tells no one to edit the committed settings file", () => {
    const report = scanJson(home, pair);
    assert.equal(report.project.shape, "team");
    assert.equal(report.project.leftovers.some((leftover) => leftover.isOnDeletionList), false);
    assert.deepEqual(report.project.leftovers.filter((leftover) => leftover.isStillToDo), []);
    const committedFileLines = report.project.leftovers.filter((leftover) => leftover.where.startsWith(".claude/settings.json"));
    assert.equal(committedFileLines.length, 4);
    assert.deepEqual(committedFileLines.map((leftover) => leftover.verdict), ["ask", "keep", "keep", "ask"]);
    assert.deepEqual(report.project.questions, ["committed-change"]);
    const plan = renderPlan(report);
    assert.doesNotMatch(plan, /Deletion list/);
    assert.doesNotMatch(plan, /the person commits/);
    assert.match(plan, /Shape: team repository \(settings committed, 2 people committed\)/);
  });

  test("words the question for a team, with keep it personal as the recommended answer", () => {
    assert.match(renderPlan(scanJson(home, pair)), /draft the committed change as a local branch for the team.*recommended: keep it personal/);
  });

  test("reads moved once the person's own plugins are switched over and nothing personal is left", () => {
    writeJson(join(pair, ".claude", "settings.local.json"), switchedOverLocally("sidequest", "live-rules", "codebase-mapper"));
    writeFile(join(pair, ".claude", "rules", "naming.md"), "converted\n");
    writeFile(join(pair, ".claude", "rules", "codebase-map.md"), "the v2 map\n");
    const report = scanJson(home, pair);
    assert.equal(report.project.shape, "moved");
    assert.deepEqual(report.project.questions, []);
    assert.equal(report.project.leftovers.some((leftover) => leftover.isOnDeletionList), false);
  });

  test("a deletion that still waits keeps it out of moved, and still leaves the tracked paths off the list", () => {
    gitAs(pair, "pair-one", "branch", "worktree-agent-merged");
    try {
      const report = scanJson(home, pair);
      assert.notEqual(report.project.shape, "moved");
      const listed = report.project.leftovers.filter((leftover) => leftover.isOnDeletionList).map((leftover) => leftover.kind);
      assert.deepEqual(listed, ["agent-branches"]);
      assert.deepEqual(report.project.questions, ["deletions", "committed-change"]);
    } finally {
      gitAs(pair, "pair-one", "branch", "-D", "worktree-agent-merged");
    }
  });
});

describe("routing lines the run can write", () => {
  const board = (extra) => ({
    isPresent: true,
    openByStatus: {},
    projectCategories: ["docs", "lookup"],
    projectCategoryRoles: { docs: "worker", lookup: "scout" },
    profile: {
      name: "my profile",
      source: "user",
      routes: [
        { category: "docs", model: "sonnet", effort: "high" },
        { category: "lookup", model: "haiku", effort: "low" },
      ],
    },
    ...extra,
  });
  const noFiles = { path: "/project", committed: {}, local: {}, isTeam: false, authorCount: 1, isSettingsCommitted: false };

  const factsWith = (boardValue, currentCategories) => ({
    ...noFiles,
    paths: { convertedRules: false, rulesFolder: false, rulesPage: false, olderMap: false, currentMap: false, qualityGateRecords: false, boardFolder: false },
    tracked: { rulesFolder: false, rulesPage: false, olderMap: false },
    isBoardKeptOutOfGit: true,
    staleExcludeLines: [],
    agentBranches: { merged: 0, unmerged: 0 },
    reviewRefs: { total: 0, merged: 0 },
    olderWorktreeFolder: { path: "", folders: [] },
    memoryNotes: [],
    instructionFiles: [],
    currentCategories,
    pluginsNamedInSettings: [],
    keptAnswers: {},
    board: boardValue,
  });

  test("lists each category missing from the board file by name with a ready line, and reads one present by name as kept", () => {
    const project = classifyProject(factsWith(board(), ["lookup"]));
    const [routing] = project.leftovers.filter((leftover) => leftover.kind === "custom-routing");
    assert.equal(routing.verdict, "convert");
    assert.equal(routing.where, "docs");
    assert.deepEqual(routing.readyLines, ['"docs": { "tier": "standard", "role": "worker", "description": "Was docs." }']);
    const written = classifyProject(factsWith(board(), ["docs", "lookup"]));
    assert.deepEqual(written.leftovers.map((leftover) => `${leftover.kind} ${leftover.verdict}`), ["custom-routing keep"]);
  });

  test("any other category in the board file does not count as written", () => {
    const project = classifyProject(factsWith(board(), ["build", "hard"]));
    assert.equal(project.leftovers[0].readyLines.length, 2);
    assert.match(project.leftovers[0].readyLines[1], /^"lookup": \{ "tier": "light", "role": "scout"/);
  });

  test("a route on another provider's model takes its Claude fallback's tier and says so", () => {
    const withElsewhere = board({
      projectCategories: ["docs"],
      profile: { name: "my profile", source: "user", routes: [{ category: "docs", model: "elsewhere-large", effort: "high", fallback: { model: "opus", effort: "high" } }] },
    });
    const [routing] = classifyProject(factsWith(withElsewhere, [])).leftovers.filter((leftover) => leftover.kind === "custom-routing");
    assert.match(routing.readyLines[0], /"tier": "deep"/);
    assert.match(routing.readyLines[0], /Was docs, on elsewhere-large, a model from another provider; opus tier instead\./);
    const noFallback = board({
      projectCategories: ["docs"],
      profile: { name: "my profile", source: "user", routes: [{ category: "docs", model: "elsewhere-large", effort: "high" }] },
    });
    const [plain] = classifyProject(factsWith(noFallback, [])).leftovers.filter((leftover) => leftover.kind === "custom-routing");
    assert.match(plain.readyLines[0], /"tier": "standard"/);
  });

  test("the plan prints the shared checkout setting as a ready line, and not once the board file has it", () => {
    const sharedCheckoutBoard = board({ worktreeIsolation: 0 });
    const plan = (currentWorktrees) =>
      renderPlan({ installedProjects: [], project: classifyProject({ ...factsWith(sharedCheckoutBoard, ["docs", "lookup"]), currentWorktrees }), home: classifyHomeForPlan() });
    assert.match(plan(undefined), /^ +"worktrees": false$/m);
    assert.doesNotMatch(plan(false), /^ +"worktrees": false$/m);
  });

  test("the plan prints the ready lines under the leftover", () => {
    const report = { installedProjects: [], project: classifyProject(factsWith(board(), [])), home: classifyHomeForPlan() };
    assert.match(renderPlan(report), /"docs": \{ "tier": "standard", "role": "worker", "description": "Was docs\." \}/);
  });
});

describe("a project whose older board ran every agent in the main checkout", () => {
  let scratch;
  const projectPath = "/work/shared-checkout-project";

  before(() => {
    scratch = mkdtempSync(join(tmpdir(), "quartermaster-upgrade-shared-checkout-"));
  });

  after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  function boardWithProjectData(name, projectData) {
    const claudeFolder = join(scratch, name);
    const database = openOlderBoard(claudeFolder);
    if (projectData !== undefined) database.prepare("INSERT INTO projects (slug, data) VALUES (?, ?)").run(olderBoardSlug(projectPath), JSON.stringify(projectData));
    database.close();
    return readOlderBoard(join(claudeFolder, "sidequest", "sidequest.db"), olderBoardSlug(projectPath));
  }

  const sharedCheckoutLines = (board, currentWorktrees) => boardLeftovers(board, [], currentWorktrees).filter((leftover) => leftover.kind === "shared-checkout");

  test("lists the setting with one ready line to write", () => {
    const [leftover] = sharedCheckoutLines(boardWithProjectData("isolation-off", { worktreeIsolation: 0 }), undefined);
    assert.equal(leftover.verdict, "convert");
    assert.equal(leftover.where, "the older board ran every agent in the main checkout here (worktree isolation off)");
    assert.match(leftover.why, /under settings in \.sidequest\/board\.json, exactly as printed; then write under settings\.checks/);
    assert.deepEqual(leftover.readyLines, ['"worktrees": false']);
  });

  test("reads as kept once the v2 board file has worktrees false, and only then", () => {
    const board = boardWithProjectData("isolation-off-written", { worktreeIsolation: 0 });
    assert.deepEqual(sharedCheckoutLines(board, false).map((leftover) => leftover.verdict), ["keep"]);
    assert.deepEqual(sharedCheckoutLines(board, true).map((leftover) => leftover.verdict), ["convert"]);
  });

  test("lists nothing when isolation was on, never set, the row is missing or the table is missing", () => {
    assert.deepEqual(sharedCheckoutLines(boardWithProjectData("isolation-on", { worktreeIsolation: 1 }), undefined), []);
    assert.deepEqual(sharedCheckoutLines(boardWithProjectData("isolation-true", { worktreeIsolation: true }), undefined), []);
    assert.equal(sharedCheckoutLines(boardWithProjectData("isolation-false", { worktreeIsolation: false }), undefined).length, 1);
    assert.deepEqual(sharedCheckoutLines(boardWithProjectData("isolation-null", { worktreeIsolation: null }), undefined), []);
    assert.deepEqual(sharedCheckoutLines(boardWithProjectData("no-key", {}), undefined), []);
    assert.deepEqual(sharedCheckoutLines(boardWithProjectData("no-row", undefined), undefined), []);
    const claudeFolder = join(scratch, "no-table");
    mkdirSync(join(claudeFolder, "sidequest"), { recursive: true });
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
    new DatabaseSync(join(claudeFolder, "sidequest", "sidequest.db")).close();
    assert.deepEqual(sharedCheckoutLines(readOlderBoard(join(claudeFolder, "sidequest", "sidequest.db"), olderBoardSlug(projectPath)), undefined), []);
  });
});

function classifyHomeForPlan() {
  return { folder: "/home/.claude", isReadyForCleanup: false, projectsStillOn: 1, gatewayProjects: [], groups: [], leftovers: [], questions: [] };
}

describe("an older Quality Gate or Observability that is on", () => {
  const emptyOlderFacts = (committed, local) => ({
    path: "/project",
    committed,
    local,
    isTeam: false,
    authorCount: 1,
    isSettingsCommitted: false,
    paths: { convertedRules: false, rulesFolder: false, rulesPage: false, olderMap: false, currentMap: false, qualityGateRecords: false, boardFolder: false },
    tracked: { rulesFolder: false, rulesPage: false, olderMap: false },
    isBoardKeptOutOfGit: true,
    staleExcludeLines: [],
    agentBranches: { merged: 0, unmerged: 0 },
    reviewRefs: { total: 0, merged: 0 },
    olderWorktreeFolder: { path: "", folders: [] },
    memoryNotes: [],
    instructionFiles: [],
    currentCategories: [],
    pluginsNamedInSettings: [],
    keptAnswers: {},
    board: { isPresent: false },
  });

  const WITHOUT_A_SUCCESSOR = ["quality-gate", "observability"];

  for (const name of WITHOUT_A_SUCCESSOR) {
    test(`${name} on in the local file converts by switching it off, with nothing installed in its place`, () => {
      const [leftover] = classifyProject(emptyOlderFacts({}, { enabledPlugins: olderOn(name) })).leftovers;
      assert.equal(leftover.verdict, "convert");
      assert.equal(
        leftover.why,
        `v2 has no plugin of this name, so nothing replaces it: switch it off for this project with claude plugin disable ${name}@eigenwise-toolshed --scope local, and say in the report that it is gone. Undo: claude plugin enable ${name}@eigenwise-toolshed --scope local`,
      );
      assert.doesNotMatch(leftover.why, /toolshed-next/);
    });

    test(`${name} on in the committed file is handed to the committed change`, () => {
      const facts = { ...emptyOlderFacts({ enabledPlugins: olderOn(name) }, {}), isSettingsCommitted: true };
      const [leftover] = classifyProject(facts).leftovers;
      assert.equal(leftover.verdict, "ask");
      assert.equal(leftover.isCommittedChange, true);
    });

    test(`${name} switched off keeps the plain words`, () => {
      const [leftover] = classifyProject(emptyOlderFacts({}, { enabledPlugins: { [`${name}@eigenwise-toolshed`]: false } })).leftovers;
      assert.equal(leftover.verdict, "keep");
      assert.equal(leftover.why, "switched off; nothing to do");
    });

    test(`a project whose only older plugin on is ${name} is not moved until it is switched off`, () => {
      const on = classifyProject(emptyOlderFacts({}, { enabledPlugins: olderOn(name) }));
      assert.notEqual(on.shape, "moved");
      const off = classifyProject(emptyOlderFacts({}, { enabledPlugins: { [`${name}@eigenwise-toolshed`]: false } }));
      assert.equal(off.shape, "moved");
    });
  }

  test("says nothing about a missing v2 plugin for a plugin that has one", () => {
    const [leftover] = classifyProject(emptyOlderFacts({ enabledPlugins: olderOn("sidequest") }, {})).leftovers;
    assert.doesNotMatch(leftover.why, /no plugin of this name/);
  });
});

describe("the plan's output for one project and for several", () => {
  let scratch;
  let home;
  let projects;

  before(() => {
    scratch = mkdtempSync(join(tmpdir(), "quartermaster-upgrade-output-"));
    home = join(scratch, "home");
    projects = {
      team: buildTeamRepository(join(scratch, "team")),
      solo: buildSoloProject(join(scratch, "solo")),
      halfMoved: buildHalfMovedProject(join(scratch, "half-moved")),
      moved: buildMovedProject(join(scratch, "moved")),
      gone: join(scratch, "gone"),
    };
    buildHome(home, projects);
    writeTranscript(join(home, ".claude"), projects.team, 0);
    writeTranscript(join(home, ".claude"), projects.solo, 40);
  });

  after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  const occurrences = (text, part) => text.split(part).length - 1;

  test("names the other projects by count, says how many of those still on were used lately, and lists only this one's own line", () => {
    const plan = runScan(home, projects.solo);
    assert.match(plan, /Other projects: 4 have the older version installed\. 2 still have a plugin of it switched on in their settings; 2 of those were used in the last 30 days\. --all-projects lists them, most recently used first\./);
    assert.match(plan, /\(3 do, 3 of those were used in the last 30 days\)/);
    assert.doesNotMatch(plan, new RegExp(projects.team.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")));
    assert.match(plan, /^ *\* .*solo {2}on /m);
  });

  test("a flag lists every project", () => {
    const plan = runScan(home, projects.solo, "--all-projects");
    assert.match(plan, new RegExp(projects.team.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")));
    assert.doesNotMatch(plan, /Other projects:/);
  });

  test("the list runs most recently used first, each row with its date and where it came from", () => {
    const rows = runScan(home, projects.solo, "--all-projects").split("\n").filter((line) => /^ {2}[* ] .*  (on|off) /.test(line));
    const order = ["team", "halfMoved", "moved", "solo", "gone"].map((name) => rows.findIndex((row) => row.includes(`${projects[name]}  `)));
    assert.equal(order[0], 0);
    assert.match(rows[order[3]], /(commit)/, "a commit today is newer than the session 40 days ago, so it is the last use");
    assert.equal(order[4], rows.length - 1);
    assert.match(rows[order[0]], /last used \d{4}-\d{2}-\d{2} \(session\)/);
    assert.match(rows[order[1]], /last used \d{4}-\d{2}-\d{2} \(commit\)/);
    assert.match(rows[order[4]], /no session or commit on record  \(folder gone\)/);
  });

  test("prints the old routes once", () => {
    const plan = runScan(home, projects.solo);
    assert.equal(occurrences(plan, "elsewhere-large"), 1);
    assert.equal(occurrences(plan, "coding.hard: opus high"), 1);
  });

  test("several --project values give a section each and the home part once", () => {
    const plan = runScan(home, projects.team, "--project", projects.solo);
    assert.equal(occurrences(plan, "This project: "), 2);
    assert.match(plan, new RegExp(`This project: ${projects.team.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}`));
    assert.match(plan, new RegExp(`This project: ${projects.solo.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}`));
    assert.equal(occurrences(plan, "Home folder "), 1);
    assert.equal(occurrences(plan, "Nothing changes until"), 1);
  });
});

test("what old tickets left per project is a group of its own, apart from the records and the worktrees", () => {
  assert.equal(olderBoardGroupOf("projects"), "ticket-evidence");
  assert.equal(olderBoardGroupOf("briefings"), "records");
  assert.equal(olderBoardGroupOf("worktrees"), "worktree-folders");
  assert.equal(olderBoardGroupOf("worktree-quarantine"), "quarantine");
});

test("the gateway line names the projects whose settings still switch the gateway plugin on, three at most, and says nothing when there is none", () => {
  assert.deepEqual(gatewayLines([]), []);
  assert.deepEqual(gatewayLines(undefined), []);
  assert.match(gatewayLines(["/work/one"])[0], /^The gateway plugin is still switched on in 1 project: \/work\/one\. /);
  const many = gatewayLines(["/work/one", "/work/two", "/work/three", "/work/four", "/work/five"])[0];
  assert.match(many, /in 5 projects: \/work\/one, \/work\/two, \/work\/three and 2 more\. /);
  assert.match(many, /Ask the gateway question once/);
});

describe("a large old map is a later step", () => {
  const olderMapFacts = (lines, extra = {}) => ({
    path: "/project",
    committed: {},
    local: {},
    isTeam: false,
    authorCount: 1,
    isSettingsCommitted: false,
    paths: { convertedRules: false, rulesFolder: false, rulesPage: false, olderMap: true, olderMapLines: lines, currentMap: false, qualityGateRecords: false, boardFolder: false },
    tracked: { rulesFolder: false, rulesPage: false, olderMap: false },
    isBoardKeptOutOfGit: true,
    staleExcludeLines: [],
    agentBranches: { merged: 0, unmerged: 0 },
    reviewRefs: { total: 0, merged: 0 },
    olderWorktreeFolder: { path: "", folders: [] },
    memoryNotes: [],
    instructionFiles: [],
    currentCategories: [],
    pluginsNamedInSettings: ["codebase-mapper"],
    keptAnswers: {},
    board: { isPresent: false },
    ...extra,
  });

  test("a small map is converted as before, with its old folder going in the deletions yes", () => {
    const project = classifyProject(olderMapFacts(LARGE_OLD_MAP_LINES));
    const [map] = project.leftovers;
    assert.equal(map.verdict, "convert");
    assert.equal(map.isOnDeletionList, true);
    assert.equal(project.shape, "solo");
  });

  test("a larger map is listed under Kept as the later step, off the deletion list, and the project reads moved", () => {
    const project = classifyProject(olderMapFacts(LARGE_OLD_MAP_LINES + 1));
    const [map] = project.leftovers;
    assert.equal(map.verdict, "keep");
    assert.equal(map.isLaterStep, true);
    assert.equal(map.isOnDeletionList, false);
    assert.equal(map.isStillToDo, false);
    assert.equal(project.shape, "moved");
    assert.deepEqual(project.questions, []);
    assert.match(map.why, new RegExp(`${LARGE_OLD_MAP_LINES + 1} lines, more than the ${LARGE_OLD_MAP_LINES} the upgrade converts in one run`));
    assert.match(map.why, /Run codebase-mapper:map in this project when you next work here/);
    assert.match(map.why, /reads the old folder as leads; the old folder stays as it is until then/);
  });

  test("a tracked large map is one keep line for the committed change, with no personal copy and no later step", () => {
    const facts = olderMapFacts(LARGE_OLD_MAP_LINES + 1, { tracked: { rulesFolder: false, rulesPage: false, olderMap: true } });
    const project = classifyProject(facts);
    assert.deepEqual(project.leftovers.map((leftover) => `${leftover.verdict} ${leftover.isCommittedChange} ${leftover.isLaterStep === true}`), ["keep true false"]);
    assert.equal(project.leftovers.some((leftover) => leftover.isOnDeletionList), false);
    assert.match(project.leftovers[0].why, new RegExp(`; ${LARGE_OLD_MAP_LINES + 1} lines, so converting it is the long part of that change$`));
  });

  test("a tracked small map says nothing about length, and a v2 map beside it says the two maps drift apart", () => {
    const tracked = { rulesFolder: false, rulesPage: false, olderMap: true };
    const [small] = classifyProject(olderMapFacts(10, { tracked })).leftovers;
    assert.doesNotMatch(small.why, /lines/);
    assert.doesNotMatch(small.why, /v2 map is here/);
    const [beside] = classifyProject(olderMapFacts(10, { tracked, paths: { ...olderMapFacts(10).paths, currentMap: true } })).leftovers;
    assert.match(beside.why, /; a v2 map is here beside it, so this checkout has two maps that drift apart until the committed change takes the v2 one into the repository and removes this one$/);
    assert.equal(beside.isCommittedChange, true);
  });

  test("the scan counts the lines of every file in the old folder and prints the number in the line", () => {
    const scratch = mkdtempSync(join(tmpdir(), "quartermaster-large-map-"));
    try {
      const project = join(scratch, "project");
      writeJson(join(project, ".claude", "settings.local.json"), { enabledPlugins: { [`codebase-mapper@${OLDER}`]: true } });
      writeFile(join(project, ".claude", ".codebase-info", "INDEX.md"), "line\n".repeat(LARGE_OLD_MAP_LINES));
      writeFile(join(project, ".claude", ".codebase-info", "modules", "one.md"), "line\n".repeat(10));
      const report = scan(readOptions(["--home", join(scratch, "home"), "--project", project], {}, project));
      const [map] = report.project.leftovers.filter((leftover) => leftover.kind === "older-map");
      assert.equal(map.verdict, "keep");
      assert.match(renderPlan(report), new RegExp(`${LARGE_OLD_MAP_LINES + 10} lines, more than the ${LARGE_OLD_MAP_LINES}`));
    } finally {
      rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});

describe("a kept gateway does not hold the home cleanup", () => {
  const home = { olderBoardEntries: [], olderWorktreeFolderCount: 0, existingPaths: [], olderAgentFiles: [], olderPluginData: [], userSettings: {}, hasOlderMarketplaceRecord: false };
  const installed = (path, olderPluginsOn, isGatewayKept) => ({ path, olderPluginsOn, isGatewayKept });

  test("a project whose only older plugin on is a kept gateway no longer counts", () => {
    const report = classifyHome(home, [installed("/one", ["model-gateway"], true)]);
    assert.equal(report.isReadyForCleanup, true);
    assert.equal(report.projectsStillOn, 0);
    assert.deepEqual(report.gatewayProjects, []);
  });

  test("a gateway with no keep answer still counts, and so does a kept one beside another older plugin", () => {
    const report = classifyHome(home, [installed("/one", ["model-gateway"], false), installed("/two", ["model-gateway", "sidequest"], true)]);
    assert.equal(report.isReadyForCleanup, false);
    assert.equal(report.projectsStillOn, 2);
    assert.deepEqual(report.gatewayProjects, ["/one"]);
  });

  test("the scan reads the keep answer from each project's own record, not only the scanned one", () => {
    const scratch = mkdtempSync(join(tmpdir(), "quartermaster-kept-gateway-"));
    try {
      const keeper = join(scratch, "keeper");
      const asker = join(scratch, "asker");
      for (const project of [keeper, asker]) writeJson(join(project, ".claude", "settings.local.json"), { enabledPlugins: { [`model-gateway@${OLDER}`]: true } });
      writeFile(join(keeper, KEPT_RECORD), "- gateway: kept 2026-11-20, they use other providers' models\n");
      const entry = (projectPath) => [{ scope: "local", projectPath, installPath: "cache" }];
      writeJson(join(scratch, "home", ".claude", "plugins", "installed_plugins.json"), {
        version: 2,
        plugins: { [`model-gateway@${OLDER}`]: [...entry(keeper), ...entry(asker)] },
      });
      const report = scan(readOptions(["--home", join(scratch, "home"), "--project", asker], {}, asker));
      assert.equal(report.home.projectsStillOn, 1);
      assert.deepEqual(report.home.gatewayProjects, [asker]);
    } finally {
      rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});

describe("what the run can do and what waits for the person", () => {
  const baseFacts = {
    path: "/project",
    committed: {},
    local: {},
    isTeam: false,
    authorCount: 1,
    isSettingsCommitted: false,
    isLocalSettingsTracked: false,
    paths: { convertedRules: false, rulesFolder: false, rulesPage: false, olderMap: false, currentMap: false, qualityGateRecords: false, boardFolder: false },
    tracked: { rulesFolder: false, rulesPage: false, olderMap: false },
    isBoardKeptOutOfGit: true,
    staleExcludeLines: [],
    agentBranches: { merged: 0, unmerged: 0 },
    reviewRefs: { total: 0, merged: 0 },
    olderWorktreeFolder: { path: "", folders: [] },
    memoryNotes: [],
    instructionFiles: [],
    currentCategories: [],
    pluginsNamedInSettings: [],
    keptAnswers: {},
    board: { isPresent: false },
  };
  const WAITING_LINE = "Everything left here waits for the person: this run is done until they answer.";
  const planOf = (facts) => {
    const home = { folder: "home", isReadyForCleanup: true, projectsStillOn: 0, gatewayProjects: [], groups: [], leftovers: [], questions: [] };
    return renderPlan({ installedProjects: [], project: classifyProject(facts), home });
  };
  const occurrences = (text, part) => text.split(part).length - 1;
  const mergedBranches = { agentBranches: { merged: 2, unmerged: 0 } };

  test("a key in a tracked local settings file is not on the deletion list and waits for the committed change", () => {
    const facts = { ...baseFacts, isLocalSettingsTracked: true, local: { env: { SIDEQUEST_COMPACTION_POLICY: "eager" } } };
    const project = classifyProject(facts);
    const [setting] = project.leftovers.filter((leftover) => leftover.kind === "older-board-setting");
    assert.equal(setting.verdict, "ask");
    assert.equal(setting.isCommittedChange, true);
    assert.equal(setting.isOnDeletionList, false);
    assert.equal(setting.isStillToDo, false);
    assert.deepEqual(questionsFor("solo", project.leftovers), ["committed-change"]);
    assert.doesNotMatch(planOf(facts), /Deletion list/);
  });

  test("the same key in a local settings file git does not track stays on the deletion list", () => {
    const project = classifyProject({ ...baseFacts, local: { env: { SIDEQUEST_COMPACTION_POLICY: "eager" } } });
    assert.deepEqual(project.leftovers.map((leftover) => `${leftover.verdict} ${leftover.isOnDeletionList}`), ["remove true"]);
  });

  test("says in one line that the plugin switch shows in git status when the local file is tracked, and only then", () => {
    const local = { enabledPlugins: { [`sidequest@${OLDER}`]: true } };
    const tracked = classifyProject({ ...baseFacts, isLocalSettingsTracked: true, local });
    const notes = tracked.leftovers.filter((leftover) => leftover.kind === "tracked-local-settings");
    assert.equal(notes.length, 1);
    assert.equal(notes[0].verdict, "keep");
    assert.match(notes[0].why, /switch shows as a change in git status and nothing is committed/);
    const untracked = classifyProject({ ...baseFacts, local });
    assert.deepEqual(untracked.leftovers.filter((leftover) => leftover.kind === "tracked-local-settings"), []);
    const nothingToSwitch = classifyProject({ ...baseFacts, isLocalSettingsTracked: true });
    assert.deepEqual(nothingToSwitch.leftovers, []);
  });

  test("memory notes kept with a recorded reason read as kept, and the project as moved", () => {
    const facts = { ...baseFacts, memoryNotes: ["models.md"] };
    const open = classifyProject(facts);
    assert.equal(open.leftovers[0].verdict, "convert");
    assert.match(open.leftovers[0].why, /upgrade-kept\.mjs --keep memory-notes --reason/);
    assert.match(open.leftovers[0].why, /name an older tool with a v2 equivalent/);
    const kept = classifyProject({ ...facts, keptAnswers: { "memory-notes": { date: "2026-11-20", reason: "the folder names are still real paths" } } });
    assert.equal(kept.leftovers[0].verdict, "keep");
    assert.equal(kept.leftovers[0].why, "kept on 2026-11-20: the folder names are still real paths");
    assert.equal(kept.shape, "moved");
  });

  test("a kept gateway still says it was the person's answer", () => {
    const facts = { ...baseFacts, local: { enabledPlugins: { [`model-gateway@${OLDER}`]: true } } };
    const kept = classifyProject({ ...facts, keptAnswers: { gateway: { date: "2026-11-20", reason: "other providers" } } });
    assert.match(kept.leftovers[0].why, /^kept on 2026-11-20 on the person's answer: other providers$/);
  });

  test("says in one line that the run is done when everything still to do waits for the deletions yes", () => {
    const facts = { ...baseFacts, ...mergedBranches };
    const project = classifyProject(facts);
    assert.notEqual(project.shape, "moved");
    assert.equal(project.isWaitingForThePerson, true);
    assert.equal(occurrences(planOf(facts), WAITING_LINE), 1);
  });

  test("does not say it while something the run can do is left", () => {
    const withMemoryNotes = { ...baseFacts, ...mergedBranches, memoryNotes: ["models.md"] };
    assert.equal(classifyProject(withMemoryNotes).isWaitingForThePerson, false);
    assert.doesNotMatch(planOf(withMemoryNotes), /waits for the person/);
    const olderPluginOn = { ...baseFacts, ...mergedBranches, local: { enabledPlugins: { [`sidequest@${OLDER}`]: true } } };
    assert.equal(classifyProject(olderPluginOn).isWaitingForThePerson, false);
    assert.doesNotMatch(planOf(olderPluginOn), /waits for the person/);
  });

  test("does not say it where nothing is left to do", () => {
    const project = classifyProject(baseFacts);
    assert.equal(project.shape, "moved");
    assert.equal(project.isWaitingForThePerson, false);
    assert.doesNotMatch(planOf(baseFacts), /waits for the person/);
  });

  test("the plan prints the open ticket count in a moved project too, and says how to list them", () => {
    const board = { isPresent: true, openByStatus: { todo: 2, doing: 1 }, openTickets: [], projectCategories: [] };
    const plan = planOf({ ...baseFacts, board });
    assert.match(plan, /Shape: moved/);
    assert.match(plan, /3 open tickets on the old board \(2 todo, 1 doing\)/);
    assert.match(plan, /upgrade-scan\.mjs --open-tickets/);
  });

  test("lists each open ticket on its own line with id, status and title, and says when there are none", () => {
    const tickets = [{ ref: "SQ-7", status: "todo", title: "Archive the old exports" }, { ref: "SQ-8", status: "doing", title: "Half-done claim" }];
    assert.deepEqual(openTicketLines({ project: { openTickets: tickets } }), ["SQ-7  todo  Archive the old exports", "SQ-8  doing  Half-done claim"]);
    assert.deepEqual(openTicketLines({ project: { openTickets: [] } }), ["No open tickets on the old board."]);
  });
});

describe("a project whose local settings file git tracks", () => {
  let scratch;
  let home;
  let tracked;

  before(() => {
    scratch = mkdtempSync(join(tmpdir(), "quartermaster-upgrade-tracked-local-"));
    home = join(scratch, "home");
    tracked = makeRepository(join(scratch, "tracked"), ["local-author"]);
    writeJson(join(tracked, ".claude", "settings.local.json"), { env: { SIDEQUEST_COMPACTION_POLICY: "eager" } });
    gitAs(tracked, "local-author", "add", "-f", "--", ".claude/settings.local.json");
    gitAs(tracked, "local-author", "commit", "-q", "-m", "tracks the local settings file");
  });

  after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  test("reads the tracking from git and keeps the key off the deletion list", () => {
    const report = scanJson(home, tracked);
    const [setting] = findLeftover(report, "older-board-setting");
    assert.equal(setting.verdict, "ask");
    assert.equal(setting.isCommittedChange, true);
    assert.equal(report.project.leftovers.some((leftover) => leftover.isOnDeletionList), false);
    assert.deepEqual(questionsFor("solo", report.project.leftovers), ["committed-change"]);
  });
});

describe("the scan's own output", () => {
  let scratch;
  let home;
  let project;

  before(() => {
    scratch = mkdtempSync(join(tmpdir(), "quartermaster-upgrade-quiet-"));
    home = join(scratch, "home");
    project = buildProjectWithOnlyKeptThingsLeft(join(scratch, "project"), home);
  });

  after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  const runSeparately = (...extra) => spawnSync(process.execPath, [scriptPath, "--home", home, "--project", project, ...extra], { encoding: "utf8" });

  test("prints nothing on stderr while it reads the old board", () => {
    const run = runSeparately();
    assert.equal(run.status, 0);
    assert.match(run.stdout, /open tickets on the old board/);
    assert.equal(run.stderr, "");
  });

  test("--open-tickets prints one line per open ticket and nothing else", () => {
    const run = runSeparately("--open-tickets");
    assert.equal(run.status, 0);
    assert.equal(run.stdout, "SQ-7  todo  Archive the old exports\nSQ-8  doing  Half-done claim\n");
    assert.equal(run.stderr, "");
  });
});

describe("a tracked old map that is the only map holds the older mapper on", () => {
  const MAPPER_KEY = `codebase-mapper@${OLDER}`;
  const HELD_WHY =
    "stays on: git tracks the map in .claude/.codebase-info/, so it is the repository's and loads only through this plugin. The mapper moves for everyone with the committed change, never for one person; codebase-mapper@toolshed-next stays off here until then";
  const PUT_BACK_WHY =
    "put the older mapper back on here: git tracks the map in .claude/.codebase-info/, it loads only through this plugin and no v2 map exists, so sessions here load no map. Run claude plugin enable codebase-mapper@eigenwise-toolshed --scope local, and claude plugin disable codebase-mapper@toolshed-next --scope local when that one is on here. Undo: the same commands the other way round";

  const trackedMapFacts = (extra = {}) => ({
    path: "/project",
    committed: {},
    local: { enabledPlugins: olderOn("codebase-mapper") },
    isTeam: false,
    authorCount: 1,
    isSettingsCommitted: false,
    paths: { convertedRules: false, rulesFolder: false, rulesPage: false, olderMap: true, olderMapLines: 20, currentMap: false, qualityGateRecords: false, boardFolder: false },
    tracked: { rulesFolder: false, rulesPage: false, olderMap: true },
    isBoardKeptOutOfGit: true,
    staleExcludeLines: [],
    agentBranches: { merged: 0, unmerged: 0 },
    reviewRefs: { total: 0, merged: 0 },
    olderWorktreeFolder: { path: "", folders: [] },
    memoryNotes: [],
    instructionFiles: [],
    currentCategories: [],
    pluginsNamedInSettings: ["codebase-mapper"],
    keptAnswers: {},
    board: { isPresent: false },
    ...extra,
  });

  const mapperKeyLines = (project) => project.leftovers.filter((leftover) => leftover.where.endsWith(MAPPER_KEY));

  test("a key that is on in the local file stays on, is the repository's, and the project reads moved", () => {
    const project = classifyProject(trackedMapFacts());
    const [key] = mapperKeyLines(project);
    assert.equal(key.verdict, "keep");
    assert.equal(key.isHeldByTrackedSource, true);
    assert.equal(key.why, HELD_WHY);
    assert.equal(key.isStillToDo, false);
    assert.equal(key.isOnDeletionList, false);
    assert.deepEqual(project.olderPluginsOn, ["codebase-mapper"]);
    assert.deepEqual(project.olderPluginsHeld, ["codebase-mapper"]);
    assert.equal(project.shape, "moved");
    assert.deepEqual(project.questions, []);
  });

  test("a key that is on in the committed settings file stays a keep and is never handed to the committed change", () => {
    const facts = trackedMapFacts({ committed: { enabledPlugins: olderOn("codebase-mapper") }, local: {}, isSettingsCommitted: true });
    const project = classifyProject(facts);
    const [key] = mapperKeyLines(project);
    assert.equal(key.verdict, "keep");
    assert.equal(key.isHeldByTrackedSource, true);
    assert.equal(key.why, HELD_WHY);
    assert.equal(project.shape, "moved");
  });

  test("a mapper the upgrade switched off here is put back on, as this person's work and off the deletion list", () => {
    const project = classifyProject(trackedMapFacts({ local: switchedOverLocally("codebase-mapper") }));
    const [key] = mapperKeyLines(project);
    assert.equal(key.verdict, "convert");
    assert.equal(key.why, PUT_BACK_WHY);
    assert.equal(key.isStillToDo, true);
    assert.equal(key.isOnDeletionList, false);
    assert.deepEqual(project.olderPluginsHeld, []);
    assert.equal(project.shape, "half-moved");
  });

  test("a mapper switched off in the local file with no v2 key beside it is put back on too", () => {
    const project = classifyProject(trackedMapFacts({ local: { enabledPlugins: { [MAPPER_KEY]: false } } }));
    const [key] = mapperKeyLines(project);
    assert.equal(key.verdict, "convert");
    assert.equal(key.why, PUT_BACK_WHY);
    assert.equal(key.isOnDeletionList, false);
  });

  test("a v2 map, or an untracked map, keep today's lines", () => {
    const withV2Map = trackedMapFacts({ local: switchedOverLocally("codebase-mapper") });
    withV2Map.paths = { ...withV2Map.paths, currentMap: true };
    assert.equal(mapperKeyLines(classifyProject(withV2Map))[0].why, "switched off here with v2 on beside it; the half-moved part that already works");
    const untracked = classifyProject(trackedMapFacts({ tracked: { rulesFolder: false, rulesPage: false, olderMap: false } }));
    assert.equal(mapperKeyLines(untracked)[0].verdict, "convert");
    assert.deepEqual(untracked.olderPluginsHeld, []);
    assert.equal(untracked.shape, "solo");
  });

  test("another older plugin on beside the held mapper still reads as work, and holds only the mapper", () => {
    const project = classifyProject(trackedMapFacts({ local: { enabledPlugins: olderOn("codebase-mapper", "sidequest") } }));
    assert.deepEqual(project.olderPluginsOn.sort(), ["codebase-mapper", "sidequest"]);
    assert.deepEqual(project.olderPluginsHeld, ["codebase-mapper"]);
    assert.notEqual(project.shape, "moved");
  });

  test("the held mapper counts like the gateway when everything left waits for a yes", () => {
    const toDo = [{ isStillToDo: true, isOnDeletionList: true }];
    assert.equal(isEverythingLeftWaitingForThePerson(toDo, ["codebase-mapper", "model-gateway"], ["codebase-mapper"]), true);
    assert.equal(isEverythingLeftWaitingForThePerson(toDo, ["codebase-mapper"], []), false);
    assert.equal(isEverythingLeftWaitingForThePerson(toDo, ["codebase-mapper", "sidequest"], ["codebase-mapper"]), false);
  });
});

describe("a team repository that commits its old map and its settings enabling the older mapper", () => {
  let scratch;
  let home;
  let team;

  before(() => {
    scratch = mkdtempSync(join(tmpdir(), "quartermaster-upgrade-held-mapper-"));
    home = join(scratch, "home");
    team = join(scratch, "team");
    makeRepository(team, ["held-one", "held-two", "held-three"]);
    commitAs(team, "held-one", ".claude/settings.json", JSON.stringify({ enabledPlugins: olderOn("codebase-mapper", "sidequest") }));
    commitAs(team, "held-two", ".claude/.codebase-info/INDEX.md", "the old map\n");
    writeJson(join(team, ".claude", "settings.local.json"), switchedOverLocally("sidequest"));
    writeJson(join(home, ".claude", "plugins", "installed_plugins.json"), {
      version: 2,
      plugins: { [`codebase-mapper@${OLDER}`]: [installEntry("project", team)], [`sidequest@${OLDER}`]: [installEntry("project", team)] },
    });
    writeJson(join(home, ".claude", "plugins", "known_marketplaces.json"), { [OLDER]: {} });
  });

  after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  test("reads moved, lists the mapper under Kept, and asks nothing", () => {
    const report = scanJson(home, team);
    assert.equal(report.project.shape, "moved");
    assert.deepEqual(report.project.olderPluginsHeld, ["codebase-mapper"]);
    assert.deepEqual(report.project.questions, []);
    assert.equal(report.project.leftovers.some((leftover) => leftover.isStillToDo), false);
    assert.equal(report.project.leftovers.some((leftover) => leftover.isOnDeletionList), false);
    const plan = renderPlan(report);
    assert.match(plan, /Older plugins on: codebase-mapper \(stays on: the map git tracks loads through it\)\n/);
    assert.match(plan, /Kept, each for the reason under it:[\s\S]*keep {4}\.claude\/settings\.json enabledPlugins codebase-mapper@eigenwise-toolshed\n {10}stays on: git tracks the map/);
    assert.match(plan, /Questions for the person: none/);
    assert.equal(olderVersionLine(report), "");
  });

  test("names it in the install row, holds no cleanup, and keeps the older marketplace record", () => {
    const report = scanJson(home, team);
    assert.deepEqual(report.installedProjects[0].olderPluginsHeld, ["codebase-mapper"]);
    assert.equal(report.home.isReadyForCleanup, true);
    assert.equal(report.home.projectsStillOn, 0);
    const record = report.home.leftovers.find((leftover) => leftover.kind === "older-marketplace-record");
    assert.equal(record.verdict, "keep");
    assert.equal(
      record.why,
      "1 project(s) still have a plugin of it switched on, or a map or rules git tracks that load only through its plugins: removing the marketplace deletes those plugins. It goes once none does; a kept gateway, or a mapper or rules plugin that holds what git tracks, keeps it here on purpose",
    );
  });

  test("the plan marks the held mapper beside another older plugin that is on", () => {
    writeJson(join(team, ".claude", "settings.local.json"), {});
    const plan = renderPlan(scanJson(home, team));
    assert.match(plan, /Older plugins on: (sidequest, codebase-mapper \(stays on: the map git tracks loads through it\)|codebase-mapper \(stays on: the map git tracks loads through it\), sidequest)\n/);
  });

  test("a v2 map beside it ends the hold, and the older mapper is then an ordinary plugin to move", () => {
    writeFile(join(team, ".claude", "rules", "codebase-map.md"), "the v2 map\n");
    const report = scanJson(home, team);
    assert.deepEqual(report.project.olderPluginsHeld, []);
    assert.deepEqual(report.installedProjects[0].olderPluginsHeld, []);
    assert.equal(report.home.projectsStillOn, 1);
  });
});

describe("the home part with a held mapper", () => {
  const home = { olderBoardEntries: [], olderWorktreeFolderCount: 0, existingPaths: [], olderAgentFiles: [], olderPluginData: [], userSettings: {}, hasOlderMarketplaceRecord: true };
  const installed = (path, olderPluginsOn, extra = {}) => ({ path, olderPluginsOn, ...extra });

  test("a project whose only older plugin on is a held mapper no longer counts", () => {
    assert.deepEqual(projectsStillOnOlderVersion([installed("/one", ["codebase-mapper"], { olderPluginsHeld: ["codebase-mapper"] })]), []);
    assert.deepEqual(projectsStillOnOlderVersion([installed("/one", ["codebase-mapper", "model-gateway"], { olderPluginsHeld: ["codebase-mapper"], isGatewayKept: true })]), []);
  });

  test("a mapper that is not held, or a held one beside another older plugin or an unanswered gateway, still counts", () => {
    assert.equal(projectsStillOnOlderVersion([installed("/one", ["codebase-mapper"], { olderPluginsHeld: [] })]).length, 1);
    assert.equal(projectsStillOnOlderVersion([installed("/one", ["codebase-mapper", "sidequest"], { olderPluginsHeld: ["codebase-mapper"] })]).length, 1);
    assert.equal(projectsStillOnOlderVersion([installed("/one", ["codebase-mapper", "model-gateway"], { olderPluginsHeld: ["codebase-mapper"] })]).length, 1);
  });

  test("the marketplace record is a keep while a project still runs a plugin of it, and a removal once none does", () => {
    const kept = classifyHome(home, [installed("/one", ["codebase-mapper"], { olderPluginsHeld: ["codebase-mapper"] }), installed("/two", ["model-gateway"], { isGatewayKept: true })]);
    const [keptRecord] = kept.leftovers;
    assert.equal(keptRecord.verdict, "keep");
    assert.match(keptRecord.why, /^2 project\(s\) still have a plugin of it switched on/);
    const removed = classifyHome(home, [installed("/one", [])]);
    assert.equal(removed.leftovers[0].verdict, "remove");
    assert.match(removed.leftovers[0].why, /^claude plugin marketplace remove eigenwise-toolshed, last/);
  });

  test("a project whose mapper is switched off but whose tracked map needs it keeps the marketplace record", () => {
    const needsMapper = installed("/one", [], { olderPluginsNeededByTrackedSources: ["codebase-mapper"] });
    const [record] = classifyHome(home, [needsMapper, installed("/two", ["sidequest"])]).leftovers;
    assert.equal(record.verdict, "keep");
    assert.match(record.why, /^2 project\(s\) still have a plugin of it switched on, or a map or rules git tracks/);
    assert.equal(classifyHome(home, [needsMapper]).leftovers[0].verdict, "keep");
  });

  test("the home counts the projects kept on purpose, and the headline names them", () => {
    const kept = [installed("/one", ["codebase-mapper"], { olderPluginsHeld: ["codebase-mapper"] }), installed("/two", ["model-gateway"], { isGatewayKept: true })];
    assert.equal(classifyHome(home, kept).projectsKeptOnPurpose, 2);
    assert.equal(classifyHome(home, [...kept, installed("/three", [])]).projectsKeptOnPurpose, 2);
    assert.equal(classifyHome(home, [installed("/three", [])]).projectsKeptOnPurpose, 0);
    assert.equal(classifyHome(home, [installed("/three", ["sidequest"])]).projectsKeptOnPurpose, 0);
    const ready = { ...classifyHome(home, kept), folder: "/config" };
    assert.match(readyHomeHeadline(ready), /^Home folder \/config: no project has a plugin of the older version switched on in its settings, except 2 kept on purpose \(a kept gateway, or a mapper or rules plugin that holds what git tracks\), so the one home cleanup can run\.$/);
    const none = { ...classifyHome(home, [installed("/three", [])]), folder: "/config" };
    assert.equal(readyHomeHeadline(none), "Home folder /config: no project has a plugin of the older version switched on in its settings, so the one home cleanup can run.");
  });

  test("the held mapper's own state leaves the other-plugins group and gets a keep line", () => {
    const withState = {
      ...home,
      existingPaths: ["codebase-mapper-state", "live-rules-state"],
      olderPluginData: ["plugins/data/codebase-mapper-eigenwise-toolshed", "plugins/data/live-rules-eigenwise-toolshed"],
      heldProjectCounts: { "codebase-mapper": 2 },
    };
    const [group] = homeGroups(withState);
    assert.deepEqual(group.entries, ["live-rules-state", "plugins/data/live-rules-eigenwise-toolshed"]);
    assert.equal(group.count, 2);
    const line = homeLeftovers(withState).find((leftover) => leftover.kind === "older-mapper-state");
    assert.equal(line.where, "codebase-mapper-state, plugins/data/codebase-mapper-eigenwise-toolshed");
    assert.equal(line.verdict, "keep");
    assert.equal(line.why, "the older mapper still loads a map git tracks in 2 project(s), and this is its state: it stays until that map moves with the committed change");
    const free = { ...withState, heldProjectCounts: { "codebase-mapper": 0 } };
    assert.equal(homeGroups(free)[0].entries.length, 4);
    assert.equal(homeLeftovers(free).some((leftover) => leftover.kind === "older-mapper-state"), false);
    assert.equal(homeLeftovers({ ...home, heldProjectCounts: { "codebase-mapper": 1 } }).some((leftover) => leftover.kind === "older-mapper-state"), false);
  });
});

describe("a tracked old map whose mapper a person switched off in the local file", () => {
  let scratch;
  let home;
  let project;

  before(() => {
    scratch = mkdtempSync(join(tmpdir(), "quartermaster-upgrade-switched-off-mapper-"));
    home = join(scratch, "home");
    project = join(scratch, "project");
    makeRepository(project, ["solo-author"]);
    commitAs(project, "solo-author", ".claude/.codebase-info/INDEX.md", "the old map\n");
    writeJson(join(project, ".claude", "settings.local.json"), { enabledPlugins: { [`codebase-mapper@${OLDER}`]: false } });
    writeJson(join(home, ".claude", "plugins", "installed_plugins.json"), { version: 2, plugins: { [`codebase-mapper@${OLDER}`]: [installEntry("project", project)] } });
    writeJson(join(home, ".claude", "plugins", "known_marketplaces.json"), { [OLDER]: {} });
    writeFile(join(home, ".claude", "codebase-mapper-state", "state.json"), "{}");
  });

  after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  test("the install row has the fact, the project is told to put it back, and the marketplace record stays", () => {
    const report = scanJson(home, project);
    const [installed] = report.installedProjects;
    assert.deepEqual(installed.olderPluginsNeededByTrackedSources, ["codebase-mapper"]);
    assert.deepEqual(installed.olderPluginsHeld, []);
    const putBack = report.project.leftovers.find((leftover) => leftover.where.endsWith(`codebase-mapper@${OLDER}`));
    assert.equal(putBack.verdict, "convert");
    assert.match(putBack.why, /^put the older mapper back on here/);
    assert.equal(report.home.leftovers.find((leftover) => leftover.kind === "older-marketplace-record").verdict, "keep");
    assert.equal(report.home.leftovers.find((leftover) => leftover.kind === "older-mapper-state").where, "codebase-mapper-state");
    assert.equal(report.home.groups.length, 0);
  });

  test("a v2 map, or an untracked map, ends the fact", () => {
    writeFile(join(project, ".claude", "rules", "codebase-map.md"), "the v2 map\n");
    assert.deepEqual(scanJson(home, project).installedProjects[0].olderPluginsNeededByTrackedSources, []);
    rmSync(join(project, ".claude", "rules"), { recursive: true, force: true });
    gitAs(project, "solo-author", "rm", "-q", "--cached", "-r", ".claude/.codebase-info");
    assert.deepEqual(scanJson(home, project).installedProjects[0].olderPluginsNeededByTrackedSources, []);
  });
});

const factsWith = (extra = {}) => ({
  path: "/project",
  committed: {},
  local: {},
  user: {},
  userSettingsFile: "/config/settings.json",
  isTeam: false,
  authorCount: 1,
  isSettingsCommitted: false,
  paths: { convertedRules: false, rulesFolder: false, rulesPage: false, olderMap: false, currentMap: false, qualityGateRecords: false, boardFolder: false },
  tracked: { rulesFolder: false, rulesPage: false, olderMap: false },
  isBoardKeptOutOfGit: true,
  staleExcludeLines: [],
  agentBranches: { merged: 0, unmerged: 0 },
  reviewRefs: { total: 0, merged: 0 },
  olderWorktreeFolder: { path: "", folders: [] },
  memoryNotes: [],
  instructionFiles: [],
  currentCategories: [],
  pluginsNamedInSettings: [],
  keptAnswers: {},
  board: { isPresent: false },
  ...extra,
});

describe("an older plugin switched on only at user scope", () => {
  const USER_SCOPE_WHY =
    "on for every project at user scope: install sidequest@toolshed-next at local scope and switch this one off for this project with claude plugin disable sidequest@eigenwise-toolshed --scope local; the user settings file is not changed by a project's run";
  const userKeyLines = (project) => project.leftovers.filter((leftover) => leftover.where.startsWith("/config/settings.json"));

  test("is on for the project, with a convert line naming the user settings file", () => {
    const project = classifyProject(factsWith({ user: { enabledPlugins: olderOn("sidequest") } }));
    assert.deepEqual(project.olderPluginsOn, ["sidequest"]);
    const [line] = userKeyLines(project);
    assert.equal(line.where, `/config/settings.json enabledPlugins sidequest@${OLDER}`);
    assert.equal(line.verdict, "convert");
    assert.equal(line.why, USER_SCOPE_WHY);
    assert.equal(line.isStillToDo, true);
    assert.equal(line.isOnDeletionList, false);
    assert.equal(project.shape, "solo");
  });

  test("a key in either project file wins over the user settings", () => {
    const user = { enabledPlugins: olderOn("sidequest") };
    const offInCommitted = classifyProject(factsWith({ user, committed: { enabledPlugins: { [`sidequest@${OLDER}`]: false } } }));
    assert.deepEqual(offInCommitted.olderPluginsOn, []);
    assert.deepEqual(userKeyLines(offInCommitted), []);
    const switchedOver = classifyProject(factsWith({ user, local: switchedOverLocally("sidequest") }));
    assert.deepEqual(switchedOver.olderPluginsOn, []);
    assert.equal(switchedOver.shape, "moved");
  });

  test("the gateway and the held mapper rules apply to it as to any other key", () => {
    const user = { enabledPlugins: olderOn("model-gateway", "codebase-mapper") };
    const paths = { ...factsWith().paths, olderMap: true, olderMapLines: 20 };
    const project = classifyProject(factsWith({ user, paths, tracked: { rulesFolder: false, rulesPage: false, olderMap: true } }));
    const verdicts = Object.fromEntries(userKeyLines(project).map((line) => [line.where.split(" ").pop(), line.verdict]));
    assert.deepEqual(verdicts, { [`model-gateway@${OLDER}`]: "ask", [`codebase-mapper@${OLDER}`]: "keep" });
    assert.deepEqual(project.olderPluginsHeld, ["codebase-mapper"]);
    assert.equal(project.shape, "moved");
  });

  test("a retired plugin's key at user scope does nothing here", () => {
    const project = classifyProject(factsWith({ user: { enabledPlugins: olderOn("retired-helper") } }));
    assert.deepEqual(project.olderPluginsOn, []);
    assert.deepEqual(project.leftovers, []);
  });

  test("the scan reads the user settings, and the home wait names the way through", () => {
    const scratch = mkdtempSync(join(tmpdir(), "quartermaster-upgrade-user-scope-"));
    try {
      const home = join(scratch, "home");
      const project = makeRepository(join(scratch, "project"), ["only-author"]);
      writeJson(join(home, ".claude", "settings.json"), { enabledPlugins: olderOn("sidequest") });
      writeJson(join(home, ".claude", "plugins", "installed_plugins.json"), { version: 2, plugins: { [`sidequest@${OLDER}`]: [{ scope: "user", installPath: "cache" }] } });
      const report = scanJson(home, project);
      assert.deepEqual(report.project.olderPluginsOn, ["sidequest"]);
      assert.equal(report.home.isReadyForCleanup, false);
      assert.deepEqual(report.home.userScopeOlderPluginsOn, ["sidequest"]);
      const plan = renderPlan(report);
      assert.match(plan, /Older plugins on: sidequest\n/);
      assert.match(plan, /sidequest is on for every project at user scope: claude plugin disable <name>@eigenwise-toolshed --scope user switches each off everywhere, once no project needs it\./);
      assert.equal(JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8")).enabledPlugins[`sidequest@${OLDER}`], true);
    } finally {
      rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});

describe("who committed decides whether a repository is a team's", () => {
  let scratch;
  let home;

  before(() => {
    scratch = mkdtempSync(join(tmpdir(), "quartermaster-upgrade-authors-"));
    home = join(scratch, "home");
  });

  after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  const withOlderPluginOnLocally = (repository) => {
    writeJson(join(repository, ".claude", "settings.local.json"), { enabledPlugins: olderOn("sidequest") });
    return repository;
  };

  test("two authors and no committed settings file read as a team, in words that stay true", () => {
    const report = scanJson(home, withOlderPluginOnLocally(makeRepository(join(scratch, "two"), ["first-author", "second-author"])));
    assert.equal(report.project.isTeam, true);
    assert.equal(report.project.shape, "team");
    assert.match(renderPlan(report), /Shape: team repository \(2 people committed\)\n/);
  });

  test("six authors and no committed settings file read as a team", () => {
    const authors = ["one", "two", "three", "four", "five", "six"].map((name) => `${name}-author`);
    assert.equal(scanJson(home, withOlderPluginOnLocally(makeRepository(join(scratch, "six"), authors))).project.shape, "team");
  });

  test("one author with a committed settings file stays solo", () => {
    const repository = makeRepository(join(scratch, "one"), ["lone-author"]);
    commitAs(repository, "lone-author", ".claude/settings.json", "{}");
    const report = scanJson(home, withOlderPluginOnLocally(repository));
    assert.equal(report.project.isTeam, false);
    assert.equal(report.project.shape, "solo");
  });
});

describe("tracked old rules that no converted rules replace hold the older rules plugin on", () => {
  const RULES_KEY = `live-rules@${OLDER}`;
  const trackedRulesFacts = (extra = {}) =>
    factsWith({
      local: { enabledPlugins: olderOn("live-rules") },
      pluginsNamedInSettings: ["live-rules"],
      paths: { ...factsWith().paths, rulesFolder: true },
      tracked: { rulesFolder: true, rulesPage: false, olderMap: false },
      ...extra,
    });
  const rulesKeyLine = (project) => project.leftovers.find((leftover) => leftover.where.endsWith(RULES_KEY));

  test("the key stays on as the repository's, and the folder is one keep line with no personal copy", () => {
    const project = classifyProject(trackedRulesFacts());
    assert.equal(rulesKeyLine(project).verdict, "keep");
    assert.equal(rulesKeyLine(project).isHeldByTrackedSource, true);
    assert.match(rulesKeyLine(project).why, /^stays on: git tracks the old rules/);
    const folderLines = project.leftovers.filter((leftover) => leftover.kind === "rules-folder");
    assert.deepEqual(folderLines.map((leftover) => leftover.verdict), ["keep"]);
    assert.match(folderLines[0].why, /^git tracks it, so these are the repository's rules: they move for everyone with the committed change/);
    assert.deepEqual(project.olderPluginsHeld, ["live-rules"]);
    assert.equal(project.shape, "moved");
  });

  test("a tracked rules page holds it the same way", () => {
    const project = classifyProject(trackedRulesFacts({ paths: { ...factsWith().paths, rulesPage: true }, tracked: { rulesFolder: false, rulesPage: true, olderMap: false } }));
    assert.deepEqual(project.olderPluginsHeld, ["live-rules"]);
    assert.deepEqual(project.leftovers.filter((leftover) => leftover.kind === "rules-page").map((leftover) => leftover.verdict), ["keep"]);
  });

  test("an older rules plugin switched off in the local file is put back on", () => {
    const project = classifyProject(trackedRulesFacts({ local: switchedOverLocally("live-rules") }));
    assert.equal(rulesKeyLine(project).verdict, "convert");
    assert.match(rulesKeyLine(project).why, /^put the older rules plugin back on here: .*claude plugin enable live-rules@eigenwise-toolshed --scope local/);
  });

  test("converted rules, or untracked old rules, end the hold", () => {
    const converted = classifyProject(trackedRulesFacts({ paths: { ...factsWith().paths, rulesFolder: true, convertedRules: true } }));
    assert.deepEqual(converted.olderPluginsHeld, []);
    const untracked = classifyProject(trackedRulesFacts({ tracked: { rulesFolder: false, rulesPage: false, olderMap: false } }));
    assert.deepEqual(untracked.olderPluginsHeld, []);
    assert.equal(rulesKeyLine(untracked).verdict, "convert");
  });

  test("the home keeps the older rules plugin's own state while its rules are held", () => {
    const home = {
      olderBoardEntries: [],
      olderWorktreeFolderCount: 0,
      existingPaths: ["codebase-mapper-state", "live-rules-state"],
      olderAgentFiles: [],
      olderPluginData: ["plugins/data/live-rules-eigenwise-toolshed"],
      userSettings: {},
      hasOlderMarketplaceRecord: false,
      heldProjectCounts: { "live-rules": 1 },
    };
    assert.deepEqual(homeGroups(home)[0].entries, ["codebase-mapper-state"]);
    const line = homeLeftovers(home).find((leftover) => leftover.kind === "older-rules-state");
    assert.equal(line.where, "live-rules-state, plugins/data/live-rules-eigenwise-toolshed");
    assert.equal(line.why, "the older rules plugin still loads rules git tracks in 1 project(s), and this is its state: it stays until those rules move with the committed change");
  });
});

describe("a team repository that commits its old rules and its settings enabling the older rules plugin", () => {
  let scratch;
  let home;
  let team;

  before(() => {
    scratch = mkdtempSync(join(tmpdir(), "quartermaster-upgrade-held-rules-"));
    home = join(scratch, "home");
    team = join(scratch, "team");
    makeRepository(team, ["rules-one", "rules-two"]);
    commitAs(team, "rules-one", ".claude/settings.json", JSON.stringify({ enabledPlugins: olderOn("live-rules") }));
    commitAs(team, "rules-two", ".claude/live-rules/rules/naming.md", "Name things.\n");
    writeJson(join(home, ".claude", "plugins", "installed_plugins.json"), { version: 2, plugins: { [`live-rules@${OLDER}`]: [installEntry("project", team)] } });
    writeJson(join(home, ".claude", "plugins", "known_marketplaces.json"), { [OLDER]: {} });
  });

  after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  test("reads moved, lists the plugin under Kept with the note, and offers no personal copy", () => {
    const report = scanJson(home, team);
    assert.equal(report.project.shape, "moved");
    assert.deepEqual(report.project.olderPluginsHeld, ["live-rules"]);
    assert.equal(report.project.leftovers.some((leftover) => leftover.isStillToDo), false);
    assert.equal(report.project.leftovers.some((leftover) => leftover.verdict === "convert"), false);
    const plan = renderPlan(report);
    assert.match(plan, /Older plugins on: live-rules \(stays on: the rules git tracks load through it\)\n/);
    assert.match(plan, /Kept, each for the reason under it:[\s\S]*keep {4}\.claude\/settings\.json enabledPlugins live-rules@eigenwise-toolshed\n {10}stays on: git tracks the old rules/);
    assert.doesNotMatch(plan, /\.git\/info\/exclude/);
  });

  test("names it in the install row and holds no cleanup", () => {
    const report = scanJson(home, team);
    assert.deepEqual(report.installedProjects[0].olderPluginsHeld, ["live-rules"]);
    assert.equal(report.home.isReadyForCleanup, true);
    assert.equal(report.home.leftovers.find((leftover) => leftover.kind === "older-marketplace-record").verdict, "keep");
  });
});

describe("the last use of a project", () => {
  test("is the newer of its last session and its last commit", () => {
    const scratch = mkdtempSync(join(tmpdir(), "quartermaster-last-use-"));
    try {
      const project = makeRepository(join(scratch, "project"), ["only-author"]);
      const configDirectory = join(scratch, "home", ".claude");
      writeTranscript(configDirectory, project, 45);
      assert.equal(readLastUse(configDirectory, project, true).source, "commit");
      writeTranscript(configDirectory, project, -2);
      assert.equal(readLastUse(configDirectory, project, true).source, "session");
      assert.equal(readLastUse(configDirectory, project, false).source, "session");
    } finally {
      rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
