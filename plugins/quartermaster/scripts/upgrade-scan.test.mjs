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
import { LARGE_OLD_MAP_LINES, boardLeftovers, classifyHome, classifyProject, environmentLeftovers, handCommittedFileToCommittedChange, homeGroups, homeLeftovers, olderBoardGroupOf, projectsStillOnOlderVersion, questionsFor, settingsLeftovers, shapeOf } from "./upgrade-findings.mjs";
import { EARLIER_NAME, OLDER as OLDER_STATE, THIS_VERSION, installStateOf, moveCommands, toolshedInstallsOf, updateCommands } from "./toolshed-installs.mjs";

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "upgrade-scan.mjs");
const TOOLSHED = "eigenwise-toolshed";
const EARLIER = "toolshed-next";
const SHARED_PLUGINS = ["sidequest", "quartermaster", "codebase-mapper", "live-rules", "observability"];
const THIS_VERSIONS_NUMBERS = { sidequest: "7.0.0", quartermaster: "2.0.0", "codebase-mapper": "3.0.0", "live-rules": "3.0.0", observability: "2.0.0" };
const OLDER_NUMBERS = { sidequest: "6.10.3", quartermaster: "1.1.3", "codebase-mapper": "2.15.10", "live-rules": "2.11.2", "quality-gate": "1.5.1", observability: "1.1.1", "model-gateway": "0.56.3" };

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

const toolshedOn = (...names) => Object.fromEntries(names.map((name) => [`${name}@${TOOLSHED}`, true]));

function buildTeamRepository(folder) {
  makeRepository(folder, ["author-one", "author-two", "author-three"]);
  commitAs(folder, "author-one", ".claude/settings.json", JSON.stringify({
    enabledPlugins: toolshedOn("sidequest", "codebase-mapper", "quality-gate"),
    extraKnownMarketplaces: { [TOOLSHED]: { source: { source: "github", repo: "example/toolshed" } } },
  }));
  commitAs(folder, "author-two", ".claude/live-rules/rules/naming.md", "---\nglobs: ['src/**']\n---\nName things.\n");
  commitAs(folder, "author-three", "CLAUDE.md", "Read .claude/.codebase-info/INDEX.md first.\n");
  // Observability updates in place, so its key is no leftover; the older board's tool permission is this person's own.
  writeJson(join(folder, ".claude", "settings.local.json"), { enabledPlugins: toolshedOn("observability"), permissions: { allow: ["mcp__plugin_sidequest_board__ticket_create"] } });
  return folder;
}

function buildSoloProject(folder) {
  makeRepository(folder, ["solo-author"]);
  commitAs(folder, "solo-author", ".claude/settings.json", JSON.stringify({ enabledPlugins: toolshedOn("sidequest", "quartermaster") }));
  writeJson(join(folder, ".claude", "settings.local.json"), {
    enabledPlugins: { ...toolshedOn("live-rules", "retired-helper", "observability", "model-gateway") },
    env: {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:4000",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "gateway-opus",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
      OTEL_METRICS_EXPORTER: "otlp",
      SIDEQUEST_COMPACTION_POLICY: "eager",
      PYTHONIOENCODING: "utf-8",
    },
    hooks: { SessionStart: [{ matcher: "startup|resume", hooks: [{ type: "command", command: "node model-gateway.js readiness-gate" }] }] },
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

// The shape an earlier upgrade left: this version beside the older one switched off, both in the local file.
function buildHalfMovedProject(folder) {
  buildTeamRepository(folder);
  writeJson(join(folder, ".claude", "settings.local.json"), {
    enabledPlugins: { [`sidequest@${EARLIER}`]: true, [`sidequest@${TOOLSHED}`]: false },
  });
  writeFile(join(folder, ".claude", ".codebase-info", "INDEX.md"), "old map\n");
  writeFile(join(folder, ".sidequest", "board.json"), "{}");
  return folder;
}

function buildMovedProject(folder) {
  makeRepository(folder, ["moving-author"]);
  writeJson(join(folder, ".claude", "settings.local.json"), { enabledPlugins: toolshedOn("sidequest") });
  return folder;
}

const installEntry = (scope, projectPath, version = "1.0.0") => ({ scope, projectPath, installPath: "cache", version });

function writeInstallRecord(claudeFolder, projects) {
  writeJson(join(claudeFolder, "plugins", "installed_plugins.json"), {
    version: 2,
    plugins: {
      [`sidequest@${TOOLSHED}`]: [installEntry("user", undefined, "7.0.0")],
      [`codebase-mapper@${TOOLSHED}`]: [installEntry("project", projects.team, "3.0.0"), installEntry("project", projects.gone, "3.0.0")],
      [`quality-gate@${TOOLSHED}`]: [installEntry("project", projects.team, "1.5.1"), installEntry("project", projects.gone, "1.5.1")],
      [`observability@${TOOLSHED}`]: [installEntry("local", projects.solo, "2.0.0")],
      [`model-gateway@${TOOLSHED}`]: [installEntry("local", projects.solo, "0.56.3")],
      [`sidequest@${EARLIER}`]: [installEntry("local", projects.halfMoved, "0.42.4")],
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
  mkdirSync(join(claudeFolder, "plugins", "data", `sidequest-${TOOLSHED}`), { recursive: true });
  mkdirSync(join(claudeFolder, "plugins", "data", `quality-gate-${TOOLSHED}`), { recursive: true });
  mkdirSync(join(claudeFolder, "plugins", "data", `observability-${TOOLSHED}`), { recursive: true });
  mkdirSync(join(claudeFolder, "plugins", "cache", TOOLSHED, "sidequest", "7.0.0"), { recursive: true });
  writeJson(join(claudeFolder, "plugins", "known_marketplaces.json"), { [TOOLSHED]: { autoUpdate: true }, [EARLIER]: {} });
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

  test("names the projects where the older version is installed, from the install record, and never this version's", () => {
    const report = scanJson(home, projects.solo);
    const byPath = Object.fromEntries(report.installedProjects.map((installed) => [installed.path, installed]));
    assert.deepEqual(Object.keys(byPath).sort(), [projects.gone, projects.solo, projects.team].sort());
    assert.deepEqual(byPath[projects.team].olderPluginsOn.sort(), ["quality-gate"]);
    assert.deepEqual(byPath[projects.solo].olderPluginsOn.sort(), ["model-gateway"]);
    assert.equal(byPath[projects.gone].isFolderPresent, false);
    assert.equal(byPath[projects.solo].isThisProject, true);
    assert.equal(report.home.projectsStillOn, 2);
    assert.equal(report.home.isReadyForCleanup, false);
  });

  test("classifies a team repository and never lets the run change its committed file", () => {
    const report = scanJson(home, projects.team);
    assert.equal(report.project.shape, "team");
    assert.equal(report.project.authorCount, 3);
    const committedPlugins = findLeftover(report, "older-plugin");
    assert.deepEqual(committedPlugins.map((leftover) => `${leftover.verdict} ${leftover.where}`), [
      `ask .claude/settings.json enabledPlugins quality-gate@${TOOLSHED}`,
    ]);
    assert.deepEqual(findLeftover(report, "rules-folder").map((leftover) => leftover.verdict), ["keep"]);
    assert.match(findLeftover(report, "rules-folder")[0].why, /committed work/);
    assert.equal(findLeftover(report, "instruction-text")[0].verdict, "ask");
    assert.deepEqual(report.project.questions, ["deletions", "committed-change"]);
    assert.match(renderPlan(report), /draft the committed change as a local branch for the team.*recommended: keep it personal/);
  });

  test("classifies a solo project and gives each leftover its verdict", () => {
    const report = scanJson(home, projects.solo);
    assert.equal(report.project.shape, "solo");
    const verdicts = Object.fromEntries(report.project.leftovers.map((leftover) => [`${leftover.kind} ${leftover.where.split(" ").pop()}`, leftover.verdict]));
    assert.equal(verdicts[`older-plugin observability@${TOOLSHED}`], undefined, "observability updates in place");
    assert.equal(verdicts[`older-plugin model-gateway@${TOOLSHED}`], "ask");
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
    assert.deepEqual(report.project.questions, ["open-tickets", "deletions"]);
  });

  test("a key of a plugin this version has is never a leftover, whatever plugin name or file", () => {
    for (const project of [projects.team, projects.solo, projects.moved]) {
      const report = scanJson(home, project);
      const named = report.project.leftovers.filter((leftover) => SHARED_PLUGINS.some((name) => leftover.where.includes(`${name}@${TOOLSHED}`)));
      assert.deepEqual(named, []);
      assert.equal(report.project.leftovers.some((leftover) => leftover.where.includes(`retired-helper@${TOOLSHED}`)), false);
      assert.equal(report.project.leftovers.some((leftover) => leftover.where.includes(`extraKnownMarketplaces ${TOOLSHED}`)), false);
    }
  });

  test("classifies a half-moved project by its earlier name, and offers the move", () => {
    const report = scanJson(home, projects.halfMoved);
    assert.equal(report.project.shape, "half-moved");
    assert.equal(report.project.isTeam, true);
    const [localKey] = findLeftover(report, "earlier-name-key");
    assert.equal(localKey.verdict, "convert");
    assert.equal(localKey.where, `.claude/settings.local.json enabledPlugins sidequest@${EARLIER}`);
    assert.match(localKey.why, new RegExp(`becomes "sidequest@${TOOLSHED}": true in this file, replacing any key of that name`));
    assert.equal(findLeftover(report, "earlier-name-install")[0].verdict, "ask");
    assert.equal(findLeftover(report, "older-map")[0].verdict, "convert");
    assert.equal(findLeftover(report, "board-not-excluded")[0].verdict, "convert");
    assert.deepEqual(report.project.questions, ["deletions", "the-move", "committed-change"]);
  });

  test("finds nothing left in a project that finished moving", () => {
    const report = scanJson(home, projects.moved);
    assert.equal(report.project.shape, "moved");
    assert.deepEqual(report.project.questions, []);
  });

  test("lists the home folder in groups, never with this version's own data, and holds the cleanup while a project is on", () => {
    const report = scanJson(home, projects.moved);
    const groups = Object.fromEntries(report.home.groups.map((group) => [group.id, group]));
    assert.deepEqual(Object.keys(groups), ["board-database", "worktree-folders", "other-plugins"]);
    assert.deepEqual(groups["board-database"].entries, ["sidequest/sidequest.db"]);
    assert.equal(groups["worktree-folders"].count, 1);
    assert.deepEqual(groups["other-plugins"].entries, ["codebase-mapper-state", "agents/sidequest-exec-low.md", `plugins/data/quality-gate-${TOOLSHED}`]);
    const where = report.home.leftovers.map((leftover) => `${leftover.verdict} ${leftover.where}`);
    assert.deepEqual(where, ["ask model-gateway", `keep plugins/cache/${TOOLSHED}`]);
    assert.match(report.home.leftovers[1].why, /this version's own plugin cache/);
    assert.deepEqual(report.home.questions, []);
    assert.match(renderPlan(report), /Not part of this project's run/);
  });

  test("prints a plan a person can read, and the same as JSON", () => {
    const plan = runScan(home, projects.solo);
    assert.match(plan, /Other projects: 2 have the older version installed\. 1 still have a plugin of it switched on in their settings; 1 of those were used in the last 30 days\./);
    assert.match(plan, /the cleanup waits until no project has a plugin of the older version switched on or installed \(2 do, 2 of those were used in the last 30 days\)/);
    assert.match(plan, /upgrade-quiet-projects\.mjs/);
    assert.match(plan, /Shape: solo project/);
    assert.match(plan, /Old routes \(my profile\)/);
    assert.match(plan, /Questions for the person \(2\)/);
    assert.match(plan, /\/reload-plugins/);
    assert.equal(JSON.parse(runScan(home, projects.solo, "--json")).project.shape, "solo");
  });

  test("prints the move from the earlier name once, for the whole machine, with the marketplace updated since it is known", () => {
    const plan = runScan(home, projects.moved);
    assert.match(plan, /The earlier name: this version is installed as toolshed-next \(sidequest 0\.42\.4 at local scope/);
    assert.match(plan, /already on disk/);
    assert.match(plan, new RegExp(`^  claude plugin marketplace update ${TOOLSHED}$`, "m"));
    assert.doesNotMatch(plan, /claude plugin marketplace add/);
    assert.doesNotMatch(plan, /Update first/);
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

  test("outfit's exploration says in one line what is left and points at upgrade", () => {
    const lines = runScan(home, projects.halfMoved, "--line").trimEnd().split("\n");
    assert.equal(lines.length, 1);
    assert.match(lines[0], /under its earlier name toolshed-next/);
    assert.match(lines[0], /`upgrade` skill/);
    assert.match(runScan(home, projects.solo, "--line"), /leftovers of the older Toolshed, with model-gateway still on/);
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
  writeJson(join(folder, ".claude", "settings.local.json"), { enabledPlugins: toolshedOn("sidequest") });
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
      assert.equal(report.project.shape, "solo");
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
  commitAs(folder, "map-one", ".claude/settings.json", JSON.stringify({ enabledPlugins: toolshedOn("codebase-mapper") }));
  commitAs(folder, "map-two", ".claude/.codebase-info/INDEX.md", "the old map\n");
  writeJson(join(folder, ".claude", "settings.local.json"), {
    enabledPlugins: toolshedOn("codebase-mapper"),
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
    writeFile(join(team, ".claude", "rules", "codebase-map.md"), "the new map\n");
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
    enabledPlugins: toolshedOn("sidequest", "model-gateway"),
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

  test("a team repository whose only leftover is in its committed file is done for this person, and the team's part stays listed", () => {
    const project = classifyProject({
      ...emptyFacts,
      isTeam: true,
      isSettingsCommitted: true,
      committed: { enabledPlugins: { [`sidequest@${TOOLSHED}`]: true, [`quality-gate@${TOOLSHED}`]: true } },
      local: { enabledPlugins: { [`sidequest@${TOOLSHED}`]: true } },
    });
    assert.equal(project.shape, "moved");
    assert.deepEqual(project.leftovers.map((leftover) => `${leftover.verdict} ${leftover.isCommittedChange}`), ["ask true"]);
  });

  test("a gateway kept on the home answer does not hold up the move", () => {
    const local = { enabledPlugins: { [`model-gateway@${TOOLSHED}`]: true }, env: { ANTHROPIC_BASE_URL: "http://localhost:4000" } };
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

  test("custom routing reads as kept once the board has its categories, and as to do until then", () => {
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

  test("old categories that this version's defaults already route are not offered as custom ones", () => {
    const defaults = ["codebase-exploration", "coding.easy", "coding.normal", "debugging", "general", "review-audit"];
    const board = { isPresent: true, openByStatus: {}, projectCategories: [...defaults, "lookup"] };
    const project = classifyProject({ ...emptyFacts, board });
    assert.deepEqual(project.leftovers.map((leftover) => `${leftover.kind} ${leftover.verdict} ${leftover.where}`), ["custom-routing convert lookup"]);
    const onlyDefaults = classifyProject({ ...emptyFacts, board: { ...board, projectCategories: defaults } });
    assert.deepEqual(onlyDefaults.leftovers, []);
    assert.equal(onlyDefaults.shape, "moved");
  });

  test("the old rules are not converted where the rules plugin was never on, older or this version", () => {
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

  test("a project's declaration of the shared marketplace is never a leftover", () => {
    const settings = { extraKnownMarketplaces: { [TOOLSHED]: { source: { source: "github", repo: "example/toolshed" } } } };
    assert.deepEqual(settingsLeftovers(".claude/settings.json", settings), []);
  });

  test("the shape and the questions follow the leftovers", () => {
    assert.equal(shapeOf(emptyFacts, [{ verdict: "keep" }]), "moved");
    assert.deepEqual(questionsFor("solo", [{ kind: "open-tickets", verdict: "ask" }]), ["open-tickets"]);
  });
});

function buildTwoAuthorRepositoryWithTrackedOlderFolders(folder) {
  makeRepository(folder, ["pair-one", "pair-two"]);
  commitAs(folder, "pair-one", ".claude/settings.json", JSON.stringify({
    enabledPlugins: toolshedOn("sidequest", "live-rules", "codebase-mapper", "quality-gate"),
    extraKnownMarketplaces: { [TOOLSHED]: { source: { source: "github", repo: "example/older" } } },
  }));
  commitAs(folder, "pair-two", ".claude/live-rules/rules/naming.md", "Name things.\n");
  commitAs(folder, "pair-two", ".claude/.codebase-info/INDEX.md", "the old map\n");
  commitAs(folder, "pair-one", "CLAUDE.md", "Read .claude/.codebase-info/INDEX.md first.\n");
  return folder;
}

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
    assert.equal(report.project.shape, "moved");
    assert.equal(report.project.leftovers.some((leftover) => leftover.isOnDeletionList), false);
    assert.deepEqual(report.project.leftovers.filter((leftover) => leftover.isStillToDo), []);
    const committedFileLines = report.project.leftovers.filter((leftover) => leftover.where.startsWith(".claude/settings.json"));
    assert.deepEqual(committedFileLines.map((leftover) => `${leftover.verdict} ${leftover.where}`), [`ask .claude/settings.json enabledPlugins quality-gate@${TOOLSHED}`]);
    const plan = renderPlan(report);
    assert.doesNotMatch(plan, /Deletion list/);
    assert.doesNotMatch(plan, /the person commits/);
  });

  test("reads moved once the person's own plugins are switched over and nothing personal is left", () => {
    writeFile(join(pair, ".claude", "rules", "naming.md"), "converted\n");
    writeFile(join(pair, ".claude", "rules", "codebase-map.md"), "the new map\n");
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
      const plan = renderPlan(report);
      assert.match(plan, /Shape: team repository \(settings committed, 2 people committed\)/);
      assert.match(plan, /draft the committed change as a local branch for the team.*recommended: keep it personal/);
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

  test("reads as kept once the board file has worktrees false, and only then", () => {
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

  const WITHOUT_A_SUCCESSOR = ["quality-gate"];

  for (const name of WITHOUT_A_SUCCESSOR) {
    test(`${name} on in the local file is uninstalled, with nothing installed in its place`, () => {
      const [leftover] = classifyProject(emptyOlderFacts({}, { enabledPlugins: toolshedOn(name) })).leftovers;
      assert.equal(leftover.verdict, "remove");
      assert.equal(
        leftover.why,
        `not in this version, so it no longer loads: claude plugin uninstall ${name}@eigenwise-toolshed --scope local takes it out with this key. It cannot be installed again from the marketplace`,
      );
      assert.doesNotMatch(leftover.why, /toolshed-next|claude plugin install/);
    });

    test(`${name} on in the committed file is handed to the committed change`, () => {
      const facts = { ...emptyOlderFacts({ enabledPlugins: toolshedOn(name) }, {}), isSettingsCommitted: true };
      const [leftover] = classifyProject(facts).leftovers;
      assert.equal(leftover.verdict, "ask");
      assert.equal(leftover.isCommittedChange, true);
    });

    test(`${name} switched off is still uninstalled, since its install stays behind the key`, () => {
      const [leftover] = classifyProject(emptyOlderFacts({}, { enabledPlugins: { [`${name}@eigenwise-toolshed`]: false } })).leftovers;
      assert.equal(leftover.verdict, "remove");
    });

    test(`a project whose only leftover is ${name} is not moved until its key is gone`, () => {
      const on = classifyProject(emptyOlderFacts({}, { enabledPlugins: toolshedOn(name) }));
      assert.notEqual(on.shape, "moved");
      assert.equal(on.isWaitingForThePerson, true);
      assert.equal(classifyProject(emptyOlderFacts({}, {})).shape, "moved");
    });
  }

  test("says nothing about a plugin this version has", () => {
    assert.deepEqual(classifyProject(emptyOlderFacts({ enabledPlugins: toolshedOn("sidequest") }, {})).leftovers, []);
  });

  test("observability updates in place: on or off, in either file, it is never a leftover and never blocks the move", () => {
    for (const value of [true, false]) {
      const key = { [`observability@eigenwise-toolshed`]: value };
      assert.deepEqual(classifyProject(emptyOlderFacts({}, { enabledPlugins: key })).leftovers, []);
      const committed = classifyProject({ ...emptyOlderFacts({ enabledPlugins: key }, {}), isSettingsCommitted: true });
      assert.deepEqual(committed.leftovers, []);
      assert.equal(committed.shape, "moved");
    }
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
    assert.match(plan, /Other projects: 2 have the older version installed\. 1 still have a plugin of it switched on in their settings; 1 of those were used in the last 30 days\. --all-projects lists them, most recently used first\./);
    assert.match(plan, /\(2 do, 2 of those were used in the last 30 days\)/);
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
    const order = ["team", "solo", "gone"].map((name) => rows.findIndex((row) => row.includes(`${projects[name]}  `)));
    assert.equal(rows.length, 3);
    assert.equal(order[0], 0);
    assert.match(rows[order[1]], /(commit)/, "a commit today is newer than the session 40 days ago, so it is the last use");
    assert.equal(order[2], rows.length - 1);
    assert.match(rows[order[0]], /last used \d{4}-\d{2}-\d{2} \(session\)/);
    assert.match(rows[order[2]], /no session or commit on record  \(folder gone\)/);
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

  test("a tracked small map says nothing about length, and a new map beside it says the two maps drift apart", () => {
    const tracked = { rulesFolder: false, rulesPage: false, olderMap: true };
    const [small] = classifyProject(olderMapFacts(10, { tracked })).leftovers;
    assert.doesNotMatch(small.why, /lines/);
    assert.doesNotMatch(small.why, /map of this version is here/);
    assert.match(small.why, /codebase-mapper:map builds the new map from it/);
    const [beside] = classifyProject(olderMapFacts(10, { tracked, paths: { ...olderMapFacts(10).paths, currentMap: true } })).leftovers;
    assert.match(beside.why, /; a map of this version is here beside it, so this checkout has two maps that drift apart until the committed change takes the new one into the repository and removes this one$/);
    assert.doesNotMatch(beside.why, /builds the new map from it/);
    assert.equal(beside.isCommittedChange, true);
  });

  test("the scan counts the lines of every file in the old folder and prints the number in the line", () => {
    const scratch = mkdtempSync(join(tmpdir(), "quartermaster-large-map-"));
    try {
      const project = join(scratch, "project");
      writeJson(join(project, ".claude", "settings.local.json"), { enabledPlugins: { [`codebase-mapper@${TOOLSHED}`]: true } });
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
  const home = { olderBoardEntries: [], olderWorktreeFolderCount: 0, existingPaths: [], olderAgentFiles: [], olderPluginData: [], userSettings: {} };
  const installed = (path, olderPluginsOn, isGatewayKept) => ({ path, olderPluginsOn, isGatewayKept });

  test("a project whose only older plugin on is a kept gateway no longer counts", () => {
    const report = classifyHome(home, [installed("/one", ["model-gateway"], true)]);
    assert.equal(report.isReadyForCleanup, true);
    assert.equal(report.projectsStillOn, 0);
    assert.deepEqual(report.gatewayProjects, []);
  });

  test("a gateway with no keep answer still counts, and so does a kept one beside another older plugin", () => {
    const report = classifyHome(home, [installed("/one", ["model-gateway"], false), installed("/two", ["model-gateway", "quality-gate"], true)]);
    assert.equal(report.isReadyForCleanup, false);
    assert.equal(report.projectsStillOn, 2);
    assert.deepEqual(report.gatewayProjects, ["/one"]);
  });

  test("the scan reads the keep answer from each project's own record, not only the scanned one", () => {
    const scratch = mkdtempSync(join(tmpdir(), "quartermaster-kept-gateway-"));
    try {
      const keeper = join(scratch, "keeper");
      const asker = join(scratch, "asker");
      for (const project of [keeper, asker]) writeJson(join(project, ".claude", "settings.local.json"), { enabledPlugins: { [`model-gateway@${TOOLSHED}`]: true } });
      writeFile(join(keeper, KEPT_RECORD), "- gateway: kept 2026-11-20, they use other providers' models\n");
      const entry = (projectPath) => [{ scope: "local", projectPath, installPath: "cache" }];
      writeJson(join(scratch, "home", ".claude", "plugins", "installed_plugins.json"), {
        version: 2,
        plugins: { [`model-gateway@${TOOLSHED}`]: [...entry(keeper), ...entry(asker)] },
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

  test("says in one line that the uninstall shows in git status when the local file is tracked, and only then", () => {
    const local = { enabledPlugins: { [`quality-gate@${TOOLSHED}`]: true } };
    const tracked = classifyProject({ ...baseFacts, isLocalSettingsTracked: true, local });
    const notes = tracked.leftovers.filter((leftover) => leftover.kind === "tracked-local-settings");
    assert.equal(notes.length, 1);
    assert.equal(notes[0].verdict, "keep");
    assert.match(notes[0].why, /uninstall at local scope writes into it .*shows as a change in git status and nothing is committed/);
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
    assert.match(open.leftovers[0].why, /name an older tool with an equivalent in this version/);
    const kept = classifyProject({ ...facts, keptAnswers: { "memory-notes": { date: "2026-11-20", reason: "the folder names are still real paths" } } });
    assert.equal(kept.leftovers[0].verdict, "keep");
    assert.equal(kept.leftovers[0].why, "kept on 2026-11-20: the folder names are still real paths");
    assert.equal(kept.shape, "moved");
  });

  test("a kept gateway still says it was the person's answer", () => {
    const facts = { ...baseFacts, local: { enabledPlugins: { [`model-gateway@${TOOLSHED}`]: true } } };
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
    const olderInstalled = { ...baseFacts, ...mergedBranches, installs: toolshedInstallsOf({ plugins: { [`sidequest@${TOOLSHED}`]: [installEntry("user", undefined, "6.10.3")] } }) };
    assert.equal(classifyProject(olderInstalled).isWaitingForThePerson, false);
    assert.doesNotMatch(planOf(olderInstalled), /waits for the person/);
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
  const userKeyLines = (project) => project.leftovers.filter((leftover) => leftover.where.startsWith("/config/settings.json"));

  test("is on for the project, kept here with the command the home part names, never written by the run", () => {
    const project = classifyProject(factsWith({ user: { enabledPlugins: toolshedOn("quality-gate") } }));
    assert.deepEqual(project.olderPluginsOn, ["quality-gate"]);
    const [line] = userKeyLines(project);
    assert.equal(line.where, `/config/settings.json enabledPlugins quality-gate@${TOOLSHED}`);
    assert.equal(line.verdict, "keep");
    assert.match(line.why, /^on for every project at user scope: claude plugin uninstall quality-gate@eigenwise-toolshed --scope user takes it out everywhere\. .*never writes the user settings file$/);
    assert.equal(line.isOnDeletionList, false);
  });

  test("a key in either project file wins over the user settings", () => {
    const user = { enabledPlugins: toolshedOn("quality-gate") };
    const offInCommitted = classifyProject(factsWith({ user, committed: { enabledPlugins: { [`quality-gate@${TOOLSHED}`]: false } } }));
    assert.deepEqual(offInCommitted.olderPluginsOn, []);
    assert.deepEqual(userKeyLines(offInCommitted), []);
  });

  test("the gateway at user scope goes only once no project is wired to it", () => {
    const [line] = userKeyLines(classifyProject(factsWith({ user: { enabledPlugins: toolshedOn("model-gateway") } })));
    assert.equal(line.verdict, "keep");
    assert.match(line.why, /--scope user takes it out everywhere, once no project is wired to the gateway\./);
  });

  test("a key of a plugin this version has, or of a retired one, at user scope does nothing here", () => {
    const project = classifyProject(factsWith({ user: { enabledPlugins: toolshedOn("sidequest", "retired-helper") } }));
    assert.deepEqual(project.olderPluginsOn, []);
    assert.deepEqual(project.leftovers, []);
  });

  test("the scan reads the user settings, and the home wait names the way through", () => {
    const scratch = mkdtempSync(join(tmpdir(), "quartermaster-upgrade-user-scope-"));
    try {
      const home = join(scratch, "home");
      const project = makeRepository(join(scratch, "project"), ["only-author"]);
      writeJson(join(home, ".claude", "settings.json"), { enabledPlugins: toolshedOn("quality-gate") });
      writeJson(join(home, ".claude", "plugins", "installed_plugins.json"), { version: 2, plugins: { [`quality-gate@${TOOLSHED}`]: [{ scope: "user", installPath: "cache", version: "1.5.1" }] } });
      const report = scanJson(home, project);
      assert.deepEqual(report.project.olderPluginsOn, ["quality-gate"]);
      assert.equal(report.home.isReadyForCleanup, false);
      assert.deepEqual(report.home.userScopeOlderPluginsOn, ["quality-gate"]);
      const plan = renderPlan(report);
      assert.match(plan, /Older plugins on: quality-gate\n/);
      assert.match(plan, /quality-gate is on for every project at user scope: claude plugin uninstall <name>@eigenwise-toolshed --scope user takes each out everywhere, the gateway only once no project is wired to it\./);
      assert.equal(JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8")).enabledPlugins[`quality-gate@${TOOLSHED}`], true);
    } finally {
      rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});

describe("the three states, told by version under one marketplace name", () => {
  test("a plugin this version has is older below its first major and this version at or above it", () => {
    for (const name of SHARED_PLUGINS) {
      assert.equal(installStateOf(`${name}@${TOOLSHED}`, OLDER_NUMBERS[name]), OLDER_STATE, name);
      assert.equal(installStateOf(`${name}@${TOOLSHED}`, THIS_VERSIONS_NUMBERS[name]), THIS_VERSION, name);
      assert.equal(installStateOf(`${name}@${TOOLSHED}`, "12.4.1"), THIS_VERSION, name);
      assert.equal(installStateOf(`${name}@${EARLIER}`, "0.42.4"), EARLIER_NAME, name);
    }
    assert.equal(installStateOf(`sidequest@${TOOLSHED}`, "6.99.99"), OLDER_STATE);
  });

  test("the two plugins only the older version had are older at any version, and a version that does not read is not taken for this one", () => {
    for (const name of ["quality-gate", "model-gateway"]) assert.equal(installStateOf(`${name}@${TOOLSHED}`, "99.0.0"), OLDER_STATE);
    assert.equal(installStateOf(`sidequest@${TOOLSHED}`, undefined), OLDER_STATE);
    assert.equal(installStateOf(`sidequest@${TOOLSHED}`, "a1b2c3d"), OLDER_STATE);
  });

  test("anything else is none of ours", () => {
    assert.equal(installStateOf("sidequest@a-fork", "7.0.0"), undefined);
    assert.equal(installStateOf(`retired-helper@${TOOLSHED}`, "1.0.0"), undefined);
    assert.equal(installStateOf(`quality-gate@${EARLIER}`, "1.0.0"), undefined);
  });

  test("the install record reads into entries with their state", () => {
    const record = { plugins: { [`sidequest@${TOOLSHED}`]: [installEntry("user", undefined, "7.0.0")], [`live-rules@${TOOLSHED}`]: [installEntry("local", "/work/one", "2.11.2")], "other@elsewhere": [installEntry("user")] } };
    assert.deepEqual(toolshedInstallsOf(record).map((entry) => `${entry.id} ${entry.scope} ${entry.state}`), [
      `sidequest@${TOOLSHED} user ${THIS_VERSION}`,
      `live-rules@${TOOLSHED} local ${OLDER_STATE}`,
    ]);
  });
});

function writeRecordAndMarketplaces(claudeFolder, plugins, marketplaces) {
  writeJson(join(claudeFolder, "plugins", "installed_plugins.json"), { version: 2, plugins });
  writeJson(join(claudeFolder, "plugins", "known_marketplaces.json"), marketplaces);
}

const pluginsAt = (numbers, scope, projectPath) => Object.fromEntries(Object.entries(numbers).map(([name, version]) => [`${name}@${TOOLSHED}`, [installEntry(scope, projectPath, version)]]));

describe("a machine where this version arrived by a normal update", () => {
  let scratch;
  let home;
  let claudeFolder;
  let project;

  before(() => {
    scratch = mkdtempSync(join(tmpdir(), "quartermaster-upgrade-arrived-"));
    home = join(scratch, "home");
    claudeFolder = join(home, ".claude");
    project = makeRepository(join(scratch, "project"), ["arrived-one", "arrived-two"]);
    commitAs(project, "arrived-one", ".claude/settings.json", JSON.stringify({
      enabledPlugins: toolshedOn(...SHARED_PLUGINS),
      extraKnownMarketplaces: { [TOOLSHED]: { source: { source: "github", repo: "example/toolshed" } } },
    }));
    writeJson(join(project, ".claude", "settings.local.json"), { enabledPlugins: toolshedOn("sidequest", "live-rules") });
    writeJson(join(claudeFolder, "settings.json"), { enabledPlugins: toolshedOn("quartermaster") });
    writeRecordAndMarketplaces(claudeFolder, pluginsAt(THIS_VERSIONS_NUMBERS, "user"), { [TOOLSHED]: { autoUpdate: true } });
    for (const name of SHARED_PLUGINS) mkdirSync(join(claudeFolder, "plugins", "data", `${name}-${TOOLSHED}`), { recursive: true });
    mkdirSync(join(claudeFolder, "plugins", "cache", TOOLSHED, "sidequest", "7.0.0"), { recursive: true });
  });

  after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  test("lists nothing of it as older, offers nothing of it, and reads moved", () => {
    const report = scanJson(home, project);
    assert.equal(report.project.shape, "moved");
    assert.deepEqual(report.project.leftovers, []);
    assert.deepEqual(report.project.olderPluginsOn, []);
    assert.deepEqual(report.project.olderInstalls, []);
    assert.deepEqual(report.installedProjects, []);
    assert.deepEqual(report.machine.updateCommands, []);
    assert.deepEqual(report.machine.moveCommands, []);
    assert.equal(olderVersionLine(report), "");
  });

  test("its own cache, data and marketplace record are never offered for removal", () => {
    const report = scanJson(home, project);
    assert.equal(report.home.isReadyForCleanup, true);
    assert.deepEqual(report.home.groups, []);
    assert.deepEqual(report.home.leftovers.map((leftover) => `${leftover.verdict} ${leftover.where}`), [`keep plugins/cache/${TOOLSHED}`]);
    const plan = renderPlan(report);
    assert.doesNotMatch(plan, /known_marketplaces/);
    assert.doesNotMatch(plan, /plugins\/data\/(sidequest|quartermaster|codebase-mapper|live-rules)-/);
  });
});

describe("a machine where the older version is still installed under the same name", () => {
  let scratch;
  let home;
  let project;

  before(() => {
    scratch = mkdtempSync(join(tmpdir(), "quartermaster-upgrade-not-updated-"));
    home = join(scratch, "home");
    project = makeRepository(join(scratch, "project"), ["older-author"]);
    writeJson(join(project, ".claude", "settings.local.json"), { enabledPlugins: toolshedOn("sidequest", "codebase-mapper") });
    writeFile(join(project, ".claude", ".codebase-info", "INDEX.md"), "old map\n");
    writeRecordAndMarketplaces(
      join(home, ".claude"),
      {
        [`sidequest@${TOOLSHED}`]: [installEntry("user", undefined, "6.10.3")],
        [`codebase-mapper@${TOOLSHED}`]: [installEntry("local", project, "2.15.10")],
        [`quartermaster@${TOOLSHED}`]: [installEntry("user", undefined, "2.0.0")],
      },
      { [TOOLSHED]: {} },
    );
  });

  after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  test("says to update first, with the marketplace update and one plugin update per older install", () => {
    const report = scanJson(home, project);
    assert.equal(report.project.shape, "update-first");
    assert.deepEqual(report.project.questions, []);
    assert.equal(report.project.isWaitingForThePerson, false);
    assert.deepEqual(report.machine.updateCommands, [
      `claude plugin marketplace update ${TOOLSHED}`,
      `claude plugin update sidequest@${TOOLSHED} --scope user`,
      `from ${project}:`,
      `  claude plugin update codebase-mapper@${TOOLSHED} --scope local`,
    ]);
    assert.ok(report.machine.updateCommands.every((line) => !line.includes("(from")));
    assert.deepEqual(findLeftover(report, "older-install").map((leftover) => leftover.where.split(" ")[0]), [`sidequest@${TOOLSHED}`, `codebase-mapper@${TOOLSHED}`]);
    const plan = renderPlan(report);
    assert.match(plan, /Update first: the older version is still installed \(sidequest 6\.10\.3 at user scope; codebase-mapper 2\.15\.10 at local scope/);
    assert.match(plan, /Shape: update first/);
    assert.match(olderVersionLine(report), /^The older Toolshed is still installed for this project \(.*\): update it first with claude plugin marketplace update eigenwise-toolshed and claude plugin update/);
  });

  test("never offers to switch off, uninstall or remove an older plugin of a shared name", () => {
    const plan = runScan(home, project);
    for (const name of SHARED_PLUGINS) assert.doesNotMatch(plan, new RegExp(`(disable|uninstall|enable) ${name}@${TOOLSHED}`));
    assert.doesNotMatch(plan, /marketplace remove eigenwise-toolshed/);
  });

  test("holds the home cleanup while an older version is installed", () => {
    const report = scanJson(home, project);
    assert.equal(report.home.isReadyForCleanup, false);
    assert.deepEqual(report.installedProjects.map((installed) => installed.olderInstalls.length).sort(), [1, 1]);
  });

  test("the commands repeat no plugin at the same scope and folder", () => {
    const entries = [
      { name: "sidequest", scope: "user" },
      { name: "sidequest", scope: "user" },
      { name: "live-rules", scope: "project", projectPath: "/work/one" },
    ];
    assert.equal(updateCommands(entries).length, 4);
  });
});

describe("the plugins only the older version had", () => {
  const withLocal = (enabledPlugins, extra = {}) => factsWith({ local: { enabledPlugins }, ...extra });
  const keyLine = (project, name) => project.leftovers.find((leftover) => leftover.where.endsWith(`${name}@${TOOLSHED}`));

  test("quality-gate is offered for uninstall on the deletion list, on or off, and observability beside it is not", () => {
    for (const value of [true, false]) {
      const project = classifyProject(withLocal({ [`quality-gate@${TOOLSHED}`]: value, [`observability@${TOOLSHED}`]: value }));
      const line = keyLine(project, "quality-gate");
      assert.equal(line.verdict, "remove");
      assert.equal(line.isOnDeletionList, true);
      assert.match(line.why, /claude plugin uninstall quality-gate@eigenwise-toolshed --scope local takes it out with this key/);
      assert.equal(keyLine(project, "observability"), undefined);
      assert.deepEqual(project.questions, ["deletions"]);
    }
  });

  test("the gateway is offered for uninstall only once nothing is wired to it, here or anywhere", () => {
    const wiredHere = classifyProject(withLocal(toolshedOn("model-gateway"), { local: { enabledPlugins: toolshedOn("model-gateway"), env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:4000" } } }));
    const wiredLine = keyLine(wiredHere, "model-gateway");
    assert.equal(wiredLine.verdict, "ask");
    assert.equal(wiredLine.isOnDeletionList, false);
    assert.match(wiredLine.why, /Unwire every place wired to it first .*and only then claude plugin uninstall model-gateway@eigenwise-toolshed --scope local.*Still wired: this project$/);
    const hooksOnly = { enabledPlugins: toolshedOn("model-gateway"), hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "node model-gateway.js readiness-gate" }] }] } };
    assert.equal(keyLine(classifyProject(factsWith({ local: hooksOnly })), "model-gateway").verdict, "ask");
    const wiredElsewhere = classifyProject(withLocal(toolshedOn("model-gateway"), { gatewayWiredElsewhere: ["/work/other"], gatewayWiringList: "read" }));
    assert.match(keyLine(wiredElsewhere, "model-gateway").why, /Still wired: \/work\/other$/);
    const unwired = keyLine(classifyProject(withLocal(toolshedOn("model-gateway"), { gatewayWiringList: "read" })), "model-gateway");
    assert.equal(unwired.verdict, "remove");
    assert.equal(unwired.isOnDeletionList, true);
    assert.match(unwired.why, /^the gateway, wired nowhere the scan can see: claude plugin uninstall model-gateway@eigenwise-toolshed --scope local takes it out with this key\. .*a project it missed that is still wired would have every prompt blocked/);
  });

  test("with the gateway's own list missing or unreadable, nothing wired in sight is no reason to uninstall: it stays a question", () => {
    for (const gatewayWiringList of ["missing", "unreadable", undefined]) {
      const line = keyLine(classifyProject(withLocal(toolshedOn("model-gateway"), { gatewayWiringList })), "model-gateway");
      assert.equal(line.verdict, "ask", String(gatewayWiringList));
      assert.equal(line.isOnDeletionList, false);
      assert.match(line.why, /the scan cannot see every project wired to it: its own list \(model-gateway\/wired-projects\.json\) is missing or cannot be read/);
      assert.match(line.why, /a project is wired when its \.claude\/settings\.local\.json has ANTHROPIC_BASE_URL under env/);
    }
  });

  test("a gateway kept on the person's answer stays, wired or not", () => {
    const keptAnswers = { gateway: { date: "2026-11-25", reason: "they pick other providers' models" } };
    const kept = keyLine(classifyProject(withLocal(toolshedOn("model-gateway"), { keptAnswers })), "model-gateway");
    assert.equal(kept.verdict, "keep");
    assert.equal(kept.isOnDeletionList, false);
  });

  test("in the committed file each waits for the committed change", () => {
    const project = classifyProject(factsWith({ committed: { enabledPlugins: toolshedOn("quality-gate", "model-gateway") }, isSettingsCommitted: true }));
    assert.deepEqual(project.leftovers.map((leftover) => `${leftover.verdict} ${leftover.isCommittedChange}`), ["ask true", "ask true"]);
  });

  test("the scan finds wiring in another project the gateway lists and in the user settings", () => {
    const scratch = mkdtempSync(join(tmpdir(), "quartermaster-upgrade-gateway-wired-"));
    try {
      const home = join(scratch, "home");
      const claudeFolder = join(home, ".claude");
      const project = makeRepository(join(scratch, "project"), ["gateway-author"]);
      const listed = join(scratch, "listed");
      writeJson(join(project, ".claude", "settings.local.json"), { enabledPlugins: toolshedOn("model-gateway") });
      writeJson(join(listed, ".claude", "settings.local.json"), { env: { ANTHROPIC_BASE_URL: "http://localhost:4000" } });
      writeJson(join(claudeFolder, "model-gateway", "wired-projects.json"), { projects: [listed, join(scratch, "gone")] });
      writeRecordAndMarketplaces(claudeFolder, { [`model-gateway@${TOOLSHED}`]: [installEntry("local", project, "0.56.3")] }, { [TOOLSHED]: {} });
      const wiredOnlyElsewhere = keyLine(scanJson(home, project).project, "model-gateway");
      assert.equal(wiredOnlyElsewhere.verdict, "ask");
      assert.match(wiredOnlyElsewhere.why, new RegExp(`Still wired: ${listed.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}$`));
      writeJson(join(listed, ".claude", "settings.local.json"), {});
      writeJson(join(claudeFolder, "settings.json"), { env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:4000" } });
      assert.match(keyLine(scanJson(home, project).project, "model-gateway").why, /Still wired: .*settings\.json$/);
      writeJson(join(claudeFolder, "settings.json"), {});
      assert.equal(keyLine(scanJson(home, project).project, "model-gateway").verdict, "remove");
    } finally {
      rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  describe("a project wired with no gateway install of its own, beside one where the gateway is installed and unwired", () => {
    let scratch;
    let home;
    let claudeFolder;
    let unwiredWithTheGateway;
    let wiredWithoutIt;
    const wiringList = () => join(claudeFolder, "model-gateway", "wired-projects.json");
    const gatewayLine = () => keyLine(scanJson(home, unwiredWithTheGateway).project, "model-gateway");

    before(() => {
      scratch = mkdtempSync(join(tmpdir(), "quartermaster-upgrade-gateway-unseen-"));
      home = join(scratch, "home");
      claudeFolder = join(home, ".claude");
      unwiredWithTheGateway = makeRepository(join(scratch, "unwired-with-the-gateway"), ["gateway-author"]);
      wiredWithoutIt = makeRepository(join(scratch, "wired-without-it"), ["other-author"]);
      writeJson(join(unwiredWithTheGateway, ".claude", "settings.local.json"), { enabledPlugins: toolshedOn("model-gateway") });
      writeJson(join(wiredWithoutIt, ".claude", "settings.local.json"), { enabledPlugins: toolshedOn("sidequest"), env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:4000" } });
      writeRecordAndMarketplaces(
        claudeFolder,
        { [`model-gateway@${TOOLSHED}`]: [installEntry("local", unwiredWithTheGateway, "0.56.3")], [`sidequest@${TOOLSHED}`]: [installEntry("local", wiredWithoutIt, "7.0.0")] },
        { [TOOLSHED]: {} },
      );
    });

    after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

    test("with no list, it stays a question and says the scan cannot see every wired project", () => {
      rmSync(join(claudeFolder, "model-gateway"), { recursive: true, force: true });
      writeJson(join(wiredWithoutIt, ".claude", "settings.local.json"), { enabledPlugins: toolshedOn("sidequest") });
      const line = gatewayLine();
      assert.equal(line.verdict, "ask");
      assert.match(line.why, /cannot see every project wired to it/);
      writeJson(join(wiredWithoutIt, ".claude", "settings.local.json"), { enabledPlugins: toolshedOn("sidequest"), env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:4000" } });
    });

    test("with a list that does not parse, it stays a question", () => {
      writeFile(wiringList(), "{ not json");
      writeJson(join(wiredWithoutIt, ".claude", "settings.local.json"), { enabledPlugins: toolshedOn("sidequest") });
      assert.match(gatewayLine().why, /cannot see every project wired to it/);
      writeJson(wiringList(), { projects: "not a list" });
      assert.equal(gatewayLine().verdict, "ask");
      writeJson(join(wiredWithoutIt, ".claude", "settings.local.json"), { enabledPlugins: toolshedOn("sidequest"), env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:4000" } });
    });

    test("a list that does not name the wired project: the install record does, so the scan still finds it, with or without a list", () => {
      writeJson(wiringList(), { projects: [unwiredWithTheGateway] });
      const line = gatewayLine();
      assert.equal(line.verdict, "ask");
      assert.equal(line.isOnDeletionList, false);
      assert.ok(line.why.endsWith(`Still wired: ${wiredWithoutIt}`), line.why);
      rmSync(wiringList(), { force: true });
      assert.ok(gatewayLine().why.endsWith(`Still wired: ${wiredWithoutIt}`));
    });

    test("a list read whole and nothing wired anywhere: the uninstall is offered, with the warning", () => {
      writeJson(wiringList(), { projects: [unwiredWithTheGateway, wiredWithoutIt] });
      writeJson(join(wiredWithoutIt, ".claude", "settings.local.json"), { enabledPlugins: toolshedOn("sidequest") });
      const line = gatewayLine();
      assert.equal(line.verdict, "remove");
      assert.match(line.why, /would have every prompt blocked/);
    });
  });
});

describe("this version under its earlier name", () => {
  let scratch;
  let home;
  let project;

  before(() => {
    scratch = mkdtempSync(join(tmpdir(), "quartermaster-upgrade-earlier-name-"));
    home = join(scratch, "home");
    project = makeRepository(join(scratch, "project"), ["earlier-author"]);
    commitAs(project, "earlier-author", ".claude/settings.json", JSON.stringify({
      enabledPlugins: { [`quartermaster@${EARLIER}`]: true },
      extraKnownMarketplaces: { [EARLIER]: { source: { source: "github", repo: "example/toolshed", ref: "v2" } } },
    }));
    writeJson(join(project, ".claude", "settings.local.json"), { enabledPlugins: { [`sidequest@${EARLIER}`]: true } });
    writeRecordAndMarketplaces(
      join(home, ".claude"),
      { [`sidequest@${EARLIER}`]: [installEntry("local", project, "0.42.4")], [`quartermaster@${EARLIER}`]: [installEntry("project", project, "0.15.2")] },
      { [EARLIER]: {} },
    );
  });

  after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  test("offers the move in the order that works: every uninstall, the removal, the add, then every install", () => {
    const report = scanJson(home, project);
    const from = `from ${project}:`;
    assert.deepEqual(report.machine.moveCommands, [
      from,
      `  claude plugin uninstall sidequest@${EARLIER} --scope local`,
      from,
      `  claude plugin uninstall quartermaster@${EARLIER} --scope project`,
      "from the config folder, never inside a repository:",
      `  claude plugin marketplace remove ${EARLIER}`,
      "claude plugin marketplace add Eigenwise/eigenwise-toolshed",
      from,
      `  claude plugin install sidequest@${TOOLSHED} --scope local`,
      from,
      `  claude plugin install quartermaster@${TOOLSHED} --scope project`,
    ]);
    const commands = report.machine.moveCommands.filter((line) => line.trim().startsWith("claude "));
    assert.ok(commands.every((line) => /^ *claude plugin [a-z ]+ [\w@/-]+( --scope \w+)?$/.test(line)), "every command line pastes as it is");
    assert.match(renderPlan(report), /adding the marketplace before the removal fails with "already on disk"/);
  });

  test("names the project files whose ids it rewrites, the committed one for the committed change", () => {
    const report = scanJson(home, project);
    assert.equal(report.project.shape, "half-moved");
    const rewrites = report.project.leftovers.filter((leftover) => leftover.kind.startsWith("earlier-name-") && leftover.kind !== "earlier-name-install");
    assert.deepEqual(rewrites.map((leftover) => `${leftover.verdict} ${leftover.where}`), [
      `ask .claude/settings.json enabledPlugins quartermaster@${EARLIER}`,
      `ask .claude/settings.json extraKnownMarketplaces ${EARLIER}`,
      `convert .claude/settings.local.json enabledPlugins sidequest@${EARLIER}`,
    ]);
    assert.deepEqual(rewrites.map((leftover) => leftover.isCommittedChange === true), [true, true, false]);
    assert.deepEqual(report.project.questions, ["the-move", "committed-change"]);
    assert.match(olderVersionLine(report), /under its earlier name toolshed-next\. The `upgrade` skill moves it to eigenwise-toolshed/);
  });

  test("the marketplace declaration becomes the shared name with no ref, and an entry under the shared name is never touched", () => {
    const leftovers = settingsLeftovers(".claude/settings.json", { extraKnownMarketplaces: { [TOOLSHED]: {}, [EARLIER]: {} } });
    assert.deepEqual(leftovers.map((leftover) => leftover.kind), ["earlier-name-marketplace"]);
    assert.match(leftovers[0].why, /becomes "eigenwise-toolshed": \{"source":\{"source":"github","repo":"Eigenwise\/eigenwise-toolshed"\}\}, with no ref/);
  });

  test("updates the marketplace instead of adding it when the shared name is already registered", () => {
    const entries = [{ name: "sidequest", scope: "user" }];
    assert.deepEqual(moveCommands(entries, true), [
      `claude plugin uninstall sidequest@${EARLIER} --scope user`,
      "from the config folder, never inside a repository:",
      `  claude plugin marketplace remove ${EARLIER}`,
      `claude plugin marketplace update ${TOOLSHED}`,
      `claude plugin install sidequest@${TOOLSHED} --scope user`,
    ]);
  });

  test("with the move asked, everything left waits for the person", () => {
    assert.equal(scanJson(home, project).project.isWaitingForThePerson, true);
  });
});

describe("never against itself", () => {
  let scratch;
  let home;
  let projects;

  before(() => {
    scratch = mkdtempSync(join(tmpdir(), "quartermaster-upgrade-never-"));
    home = join(scratch, "home");
    projects = {
      team: buildTeamRepository(join(scratch, "team")),
      solo: buildSoloProject(join(scratch, "solo")),
      halfMoved: buildHalfMovedProject(join(scratch, "half-moved")),
      moved: buildMovedProject(join(scratch, "moved")),
      gone: join(scratch, "gone"),
    };
    buildHome(home, projects);
    writeRecordAndMarketplaces(
      join(home, ".claude"),
      {
        ...pluginsAt(THIS_VERSIONS_NUMBERS, "user"),
        ...pluginsAt({ "quality-gate": "1.5.1", observability: "1.1.1", "model-gateway": "0.56.3" }, "local", projects.solo),
        [`live-rules@${TOOLSHED}`]: [installEntry("local", projects.team, "2.11.2")],
        [`sidequest@${EARLIER}`]: [installEntry("local", projects.halfMoved, "0.42.4")],
      },
      { [TOOLSHED]: {}, [EARLIER]: {} },
    );
  });

  after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  const everything = () => runScan(home, projects.team, "--project", projects.solo, "--project", projects.halfMoved, "--project", projects.moved, "--all-projects");

  test("no line switches off, uninstalls or removes a plugin of a shared name under the shared marketplace", () => {
    const plan = everything();
    for (const name of SHARED_PLUGINS) assert.doesNotMatch(plan, new RegExp(`(disable|uninstall) ${name}@${TOOLSHED}`), name);
  });

  test("no line removes the shared marketplace, its cache, its record or a project's declaration of it", () => {
    const plan = everything();
    assert.doesNotMatch(plan, new RegExp(`marketplace remove ${TOOLSHED}`));
    assert.doesNotMatch(plan, /known_marketplaces/);
    assert.match(plan, new RegExp(`keep {4}plugins/cache/${TOOLSHED}\\n`));
    assert.doesNotMatch(plan, new RegExp(`extraKnownMarketplaces ${TOOLSHED}`));
  });

  test("the only removals under the shared name are the two plugins only the older version had, and an older shared one is only updated", () => {
    for (const project of Object.values(projects).slice(0, 4)) {
      const report = scanJson(home, project);
      const underTheSharedName = report.project.leftovers.filter((leftover) => leftover.verdict !== "keep" && leftover.where.includes(`@${TOOLSHED}`));
      for (const leftover of underTheSharedName) assert.match(leftover.where, /(quality-gate|observability|model-gateway|live-rules)@eigenwise-toolshed/);
      const sharedOnes = underTheSharedName.filter((leftover) => SHARED_PLUGINS.some((name) => leftover.where.includes(`${name}@${TOOLSHED}`)));
      assert.deepEqual(sharedOnes.map((leftover) => leftover.kind), sharedOnes.map(() => "older-install"));
    }
  });
});

describe("the home part with a kept gateway", () => {
  const home = { olderBoardEntries: [], olderWorktreeFolderCount: 0, existingPaths: [], olderAgentFiles: [], olderPluginData: [], userSettings: {} };
  const installed = (path, olderPluginsOn, extra = {}) => ({ path, olderPluginsOn, ...extra });

  test("an older version still installed holds the cleanup, even with nothing switched on", () => {
    assert.equal(projectsStillOnOlderVersion([installed("/one", [], { olderInstalls: ["sidequest 6.10.3 at user scope"] })]).length, 1);
    assert.equal(projectsStillOnOlderVersion([installed("/one", ["model-gateway"], { isGatewayKept: true, olderInstalls: ["sidequest 6.10.3 at user scope"] })]).length, 1);
  });

  test("the home counts the projects kept on purpose, and the headline names them", () => {
    const kept = [installed("/two", ["model-gateway"], { isGatewayKept: true })];
    assert.equal(classifyHome(home, kept).projectsKeptOnPurpose, 1);
    assert.equal(classifyHome(home, [installed("/three", ["quality-gate"])]).projectsKeptOnPurpose, 0);
    const ready = { ...classifyHome(home, kept), folder: "/config" };
    assert.match(readyHomeHeadline(ready), /^Home folder \/config: no project has a plugin of the older version switched on or installed, except 1 kept on purpose \(a kept gateway\), so the one home cleanup can run\.$/);
    const none = { ...classifyHome(home, [installed("/three", [])]), folder: "/config" };
    assert.equal(readyHomeHeadline(none), "Home folder /config: no project has a plugin of the older version switched on or installed, so the one home cleanup can run.");
  });

  test("other-plugins takes only the data of the plugins only the older version had", () => {
    const [group] = homeGroups({ ...home, existingPaths: ["codebase-mapper-state"], olderPluginData: [`plugins/data/quality-gate-${TOOLSHED}`] });
    assert.deepEqual(group.entries, ["codebase-mapper-state", `plugins/data/quality-gate-${TOOLSHED}`]);
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
    writeJson(join(repository, ".claude", "settings.local.json"), { enabledPlugins: toolshedOn("quality-gate") });
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

describe("this version installed under both names", () => {
  let scratch;
  let project;

  before(() => {
    scratch = mkdtempSync(join(tmpdir(), "quartermaster-upgrade-both-names-"));
    project = makeRepository(join(scratch, "project"), ["one-author"]);
  });

  after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  const copy = (marketplace, scope, version = "7.0.0") => ({ marketplace, scope, version });

  // The install record's key order is the order of installing; each layout is one the host was run against.
  const LAYOUTS = [
    { name: "both at user scope, the earlier name first", copies: [copy(EARLIER, "user"), copy(TOOLSHED, "user")], runs: EARLIER },
    { name: "both at user scope, the shared name first", copies: [copy(TOOLSHED, "user"), copy(EARLIER, "user")], runs: TOOLSHED },
    { name: "earlier name at project scope, shared name at user scope", copies: [copy(EARLIER, "project"), copy(TOOLSHED, "user")], runs: TOOLSHED },
    { name: "earlier name at user scope, shared name at project scope", copies: [copy(EARLIER, "user"), copy(TOOLSHED, "project")], runs: EARLIER },
    { name: "earlier name at local scope, shared name at project scope", copies: [copy(EARLIER, "local"), copy(TOOLSHED, "project")], runs: TOOLSHED },
    { name: "earlier name at project scope, shared name at local scope", copies: [copy(TOOLSHED, "local"), copy(EARLIER, "project")], runs: EARLIER },
    { name: "the older version of the shared name at project scope beside the earlier name at local scope", copies: [copy(EARLIER, "local", "0.15.2"), copy(TOOLSHED, "project", "1.1.3")], runs: TOOLSHED },
    { name: "the earlier name at project scope beside the older version at local scope", copies: [copy(EARLIER, "project", "0.15.2"), copy(TOOLSHED, "local", "1.1.3")], runs: EARLIER },
  ];

  let homeCount = 0;

  const recordOfCopies = (copies) =>
    Object.fromEntries(
      [...new Set(copies.map((one) => one.marketplace))].map((marketplace) => [
        `sidequest@${marketplace}`,
        copies.filter((one) => one.marketplace === marketplace).map((one) => installEntry(one.scope, one.scope === "user" ? undefined : project, one.version)),
      ]),
    );

  // The files go in the order the host reads them for a key; each is written only for the scan and removed after it.
  const scanWithSettings = (copies, settings = {}) => {
    homeCount += 1;
    const home = join(scratch, `home-${homeCount}`);
    writeRecordAndMarketplaces(join(home, ".claude"), recordOfCopies(copies), { [TOOLSHED]: {}, [EARLIER]: {} });
    const files = { local: join(project, ".claude", "settings.local.json"), committed: join(project, ".claude", "settings.json"), user: join(home, ".claude", "settings.json") };
    for (const [place, enabledPlugins] of Object.entries(settings)) writeJson(files[place], { enabledPlugins });
    try {
      return scanJson(home, project);
    } finally {
      rmSync(files.local, { force: true });
      rmSync(files.committed, { force: true });
    }
  };

  const SETTINGS_FILE_OF_SCOPE = { user: "user", project: "committed", local: "local" };

  // An install switches its own copy on in the settings file of its scope, and a copy no file names is off.
  const keysTheInstallsWrote = (copies) =>
    copies.reduce((settings, one) => {
      const place = SETTINGS_FILE_OF_SCOPE[one.scope];
      return { ...settings, [place]: { ...settings[place], [`sidequest@${one.marketplace}`]: true } };
    }, {});

  const scanOf = (copies) => scanWithSettings(copies, keysTheInstallsWrote(copies));

  for (const layout of LAYOUTS) {
    test(`names both copies and the one the host runs: ${layout.name}`, () => {
      const report = scanOf(layout.copies);
      const [words, ...others] = report.project.installedUnderBothNames;
      assert.deepEqual(others, []);
      assert.match(words, new RegExp(`sidequest@${TOOLSHED} .* scope.* and sidequest@${EARLIER} .* scope|sidequest@${EARLIER} .* scope.* and sidequest@${TOOLSHED} .* scope`));
      assert.match(words, new RegExp(`The host runs sidequest@${layout.runs} \\(user scope before project, project before local, then the first installed\\)`));
      assert.equal(report.project.runsUnderEarlierName, layout.runs === EARLIER);
    });
  }

  test("never says the project runs under the earlier name when the other copy runs", () => {
    const report = scanOf([copy(EARLIER, "project"), copy(TOOLSHED, "user")]);
    assert.equal(report.project.shape, "half-moved");
    assert.doesNotMatch(olderVersionLine(report), /runs this version under its earlier name/);
    assert.match(olderVersionLine(report), /installed under both eigenwise-toolshed and toolshed-next, and the host runs the eigenwise-toolshed copy/);
    assert.doesNotMatch(renderPlan(report), /this version runs here under its earlier name/);
  });

  test("still says the project runs under the earlier name when that copy runs", () => {
    const report = scanOf([copy(EARLIER, "user"), copy(TOOLSHED, "project")]);
    assert.match(olderVersionLine(report), /runs this version under its earlier name toolshed-next/);
    assert.match(renderPlan(report), /Installed under both names: .*The host runs sidequest@toolshed-next/);
  });

  test("the move only removes the earlier-name copy of a plugin that is installed from the shared name too", () => {
    const report = scanOf([copy(EARLIER, "project"), copy(TOOLSHED, "user")]);
    assert.ok(report.machine.moveCommands.some((line) => line.includes(`claude plugin uninstall sidequest@${EARLIER} --scope project`)));
    assert.ok(!report.machine.moveCommands.some((line) => line.includes(`claude plugin install sidequest@${TOOLSHED}`)));
  });

  test("different plugins under the two names are not installed under both", () => {
    const home = join(scratch, "home-different");
    writeRecordAndMarketplaces(
      join(home, ".claude"),
      { [`sidequest@${EARLIER}`]: [installEntry("user", undefined, "7.0.0")], [`quartermaster@${TOOLSHED}`]: [installEntry("user", undefined, "2.0.0")] },
      { [TOOLSHED]: {}, [EARLIER]: {} },
    );
    const report = scanJson(home, project);
    assert.deepEqual(report.project.installedUnderBothNames, []);
    assert.equal(report.project.runsUnderEarlierName, true);
  });

  const switchedOn = (marketplace, value) => ({ [`sidequest@${marketplace}`]: value });

  // What an earlier upgrade run wrote: this version at user scope switched off here, the earlier name at local scope switched on.
  test("a copy switched off in the local file is not the one the host runs", () => {
    const report = scanWithSettings([copy(TOOLSHED, "user"), copy(EARLIER, "local")], { local: { ...switchedOn(EARLIER, true), ...switchedOn(TOOLSHED, false) } });
    assert.equal(report.project.runsUnderEarlierName, true);
    assert.equal(report.project.isNoCopyRunning, false);
    assert.match(report.project.installedUnderBothNames[0], new RegExp(`The host runs sidequest@${EARLIER} \\(user scope before project, project before local, then the first installed\\)`));
    assert.match(report.project.installedUnderBothNames[0], new RegExp(`sidequest@${TOOLSHED} is switched off here, so left out of that choice`));
    assert.match(olderVersionLine(report), /runs this version under its earlier name toolshed-next/);
    assert.match(renderPlan(report), /this version runs here under its earlier name/);
  });

  test("the scope rule picks the shared name for a layout the earlier name wins, once the earlier name is switched off", () => {
    const report = scanWithSettings([copy(EARLIER, "user"), copy(TOOLSHED, "project")], { committed: { ...switchedOn(EARLIER, false), ...switchedOn(TOOLSHED, true) } });
    assert.equal(report.project.runsUnderEarlierName, false);
    assert.match(report.project.installedUnderBothNames[0], new RegExp(`The host runs sidequest@${TOOLSHED} `));
  });

  test("a switch in the user settings counts, and the local file beats the committed one beats the user one", () => {
    const copies = [copy(EARLIER, "user"), copy(TOOLSHED, "project")];
    assert.equal(scanWithSettings(copies, { user: switchedOn(EARLIER, false) }).project.runsUnderEarlierName, false);
    assert.equal(scanWithSettings(copies, { user: switchedOn(EARLIER, false), committed: switchedOn(EARLIER, true) }).project.runsUnderEarlierName, true);
    assert.equal(scanWithSettings(copies, { local: switchedOn(EARLIER, true), committed: switchedOn(EARLIER, false), user: switchedOn(EARLIER, false) }).project.runsUnderEarlierName, true);
  });

  test("with every copy switched off the scan says none runs, and not that the host runs one", () => {
    const report = scanWithSettings([copy(TOOLSHED, "user"), copy(EARLIER, "local")], { local: { ...switchedOn(EARLIER, false), ...switchedOn(TOOLSHED, false) } });
    assert.equal(report.project.isNoCopyRunning, true);
    assert.match(report.project.installedUnderBothNames[0], /Every copy is switched off here, so none runs/);
    assert.doesNotMatch(report.project.installedUnderBothNames[0], /The host runs/);
    assert.doesNotMatch(renderPlan(report), /runs here under its earlier name|the host runs the eigenwise-toolshed copy/);
    assert.match(olderVersionLine(report), /no copy is switched on here/);
  });

  test("a key that is true leaves the scope rule as it was", () => {
    const copies = [copy(EARLIER, "project"), copy(TOOLSHED, "user")];
    assert.equal(scanWithSettings(copies, { local: { ...switchedOn(EARLIER, true), ...switchedOn(TOOLSHED, true) } }).project.runsUnderEarlierName, false);
  });

  // The host's own plugin list shows both copies as disabled in this layout.
  test("a copy that no settings file names is off, so with no key anywhere none runs", () => {
    const copies = [copy(TOOLSHED, "user"), copy(EARLIER, "local")];
    const report = scanWithSettings(copies, { local: { "other@somewhere": false } });
    assert.equal(report.project.isNoCopyRunning, true);
    assert.doesNotMatch(report.project.installedUnderBothNames[0], /The host runs/);
    const onlyEarlierNamed = scanWithSettings(copies, { local: switchedOn(EARLIER, true) });
    assert.equal(onlyEarlierNamed.project.runsUnderEarlierName, true);
    assert.match(onlyEarlierNamed.project.installedUnderBothNames[0], new RegExp(`The host runs sidequest@${EARLIER} `));
  });

  const installLinesOf = (report, name) => report.machine.moveCommands.filter((line) => line.includes(`claude plugin install ${name}@${TOOLSHED}`));

  // A copy under the shared name reaches the projects it is installed for, so only an earlier-name copy it reaches goes without a new install.
  const COVERAGE = [
    { name: "earlier name local, shared name project", copies: [copy(EARLIER, "local"), copy(TOOLSHED, "project")], installedAt: [] },
    { name: "earlier name project, shared name local", copies: [copy(EARLIER, "project"), copy(TOOLSHED, "local")], installedAt: [] },
    { name: "earlier name project, shared name user", copies: [copy(EARLIER, "project"), copy(TOOLSHED, "user")], installedAt: [] },
    { name: "earlier name user, shared name user", copies: [copy(EARLIER, "user"), copy(TOOLSHED, "user")], installedAt: [] },
    { name: "earlier name user, shared name project", copies: [copy(EARLIER, "user"), copy(TOOLSHED, "project")], installedAt: ["user"] },
    { name: "earlier name user and project, shared name local", copies: [copy(EARLIER, "user"), copy(EARLIER, "project"), copy(TOOLSHED, "local")], installedAt: ["user"] },
  ];

  for (const layout of COVERAGE) {
    test(`the move installs the shared name only where no copy of it reaches: ${layout.name}`, () => {
      const report = scanOf(layout.copies);
      const scopes = installLinesOf(report, "sidequest").map((line) => /--scope (\w+)/.exec(line)?.[1]);
      assert.deepEqual(scopes, layout.installedAt);
    });
  }
});
