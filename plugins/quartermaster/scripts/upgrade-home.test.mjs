import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { contextOf, measureSize, readGroups, readOptions, realOperations, removeEntry, renderGroups, renderRemovals, sidequestWorktreesScript, sizeWords } from "./upgrade-home.mjs";
import { readOptions as readScanOptions, scan } from "./upgrade-scan.mjs";
import { KEPT_RECORD } from "./upgrade-kept.mjs";

const scriptsFolder = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(scriptsFolder, "upgrade-home.mjs");
const sidequestPlugin = resolve(scriptsFolder, "..", "..", "sidequest");
const TOOLSHED = "eigenwise-toolshed";
const EARLIER = "toolshed-next";

const gitEnvironment = { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" };

const git = (cwd, ...args) => execFileSync("git", args, { cwd, env: gitEnvironment, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function writeFile(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

const writeJson = (path, value) => writeFile(path, JSON.stringify(value, null, 2));

function makeRepository(folder) {
  mkdirSync(folder, { recursive: true });
  git(folder, "init", "-q", "-b", "main");
  writeFile(join(folder, "readme.txt"), "a project\n");
  git(folder, "add", "readme.txt");
  git(folder, "commit", "-q", "-m", "start");
  return folder;
}

const addWorktree = (repository, folder, branch) => {
  git(repository, "worktree", "add", "-q", "-b", branch, folder);
  return folder;
};

const forgetWorktree = (repository, name) => rmSync(join(repository, ".git", "worktrees", name), { recursive: true, force: true });

const nothingStillOn = (claudeFolder, extraPlugins = {}) =>
  writeJson(join(claudeFolder, "plugins", "installed_plugins.json"), {
    version: 2,
    plugins: { [`sidequest@${TOOLSHED}`]: [{ scope: "user", installPath: sidequestPlugin, version: "7.0.0" }], ...extraPlugins },
  });

function buildHome(scratch) {
  const claudeFolder = join(scratch, "home", ".claude");
  const board = join(claudeFolder, "sidequest");
  const project = makeRepository(join(scratch, "project"));
  const projectWorktrees = join(board, "worktrees", "project-1234abcd");
  const folders = {
    safe: addWorktree(project, join(projectWorktrees, "agent-safe"), "older-ticket-branch"),
    untracked: addWorktree(project, join(projectWorktrees, "agent-untracked"), "worktree-agent-untracked"),
    forgotten: addWorktree(project, join(projectWorktrees, "agent-forgotten"), "forgotten-with-work"),
    elsewhere: addWorktree(project, join(scratch, "a-live-session-worktree"), "worktree-agent-elsewhere"),
  };
  writeFile(join(folders.untracked, "notes.txt"), "written by an agent, never committed\n");
  writeFile(join(folders.forgotten, "draft.txt"), "exists nowhere else\n");
  forgetWorktree(project, "agent-forgotten");
  git(project, "branch", "worktree-agent-leftover");

  const gone = makeRepository(join(scratch, "gone-project"));
  folders.orphan = addWorktree(gone, join(board, "worktrees", "gone-project-5678abcd", "agent-orphan"), "worktree-agent-orphan");
  rmSync(gone, { recursive: true, force: true });

  writeFile(join(board, "sidequest.db"), "database");
  writeFile(join(board, "backups", "sidequest-1.db"), "backup");
  writeFile(join(board, "worktree-quarantine", "salvaged", "work.txt"), "salvaged\n");
  for (let index = 0; index < 300; index += 1) writeFile(join(board, "briefings", `brief-${index}.md`), "a briefing\n");
  writeFile(join(board, "dispatch", "run.json"), "{}");
  writeFile(join(claudeFolder, "codebase-mapper-state", "abc", "state.json"), "{}");
  writeFile(join(claudeFolder, "agents", "sidequest-exec-low.md"), "generated\n");
  nothingStillOn(claudeFolder);
  return { home: join(scratch, "home"), claudeFolder, board, project, folders };
}

const run = (...args) => spawnSync(process.execPath, [scriptPath, ...args], { encoding: "utf8", env: gitEnvironment });

const runJson = (...args) => {
  const result = run(...args, "--json");
  assert.equal(result.status, 0, result.stderr);
  return { report: JSON.parse(result.stdout), progress: result.stderr };
};

const groupOf = (report, id) => report.groups.find((group) => group.id === id);

const lastName = (path) => path.split(/[\\/]/).pop();

describe("the home cleanup on a made-up home folder", () => {
  let scratch;
  let tree;

  before(() => {
    scratch = mkdtempSync(join(tmpdir(), "quartermaster-home-"));
    tree = buildHome(scratch);
  });

  after(() => rmSync(scratch, { recursive: true, force: true }));

  test("the scan's home part lists the groups with a count each and what removing it loses", () => {
    const report = scan(readScanOptions(["--home", tree.home, "--project", tree.project], {}, tree.project));
    const counts = Object.fromEntries(report.home.groups.map((group) => [group.id, group.count]));
    assert.deepEqual(counts, { "board-database": 2, "worktree-folders": 4, quarantine: 1, records: 2, "other-plugins": 2 });
    assert.ok(report.home.groups.every((group) => group.loses !== ""));
    assert.equal(report.home.isReadyForCleanup, true);
    assert.deepEqual(report.home.questions, ["home-deletions"]);
  });

  test("a worktree folder goes on the list only with a safe verdict; every keep is named with its reason", () => {
    const { report, progress } = runJson("--home", tree.home, "--size-seconds", "30");
    const worktrees = groupOf(report, "worktree-folders");
    assert.deepEqual(worktrees.offered.map(lastName), ["agent-safe"]);
    const reasons = Object.fromEntries(worktrees.keeps.map((keep) => [lastName(keep.path), keep.reasons.join(", ")]));
    assert.deepEqual(Object.keys(reasons).sort(), ["agent-forgotten", "agent-orphan", "agent-untracked"]);
    assert.match(reasons["agent-untracked"], /uncommitted or untracked/);
    assert.match(reasons["agent-forgotten"], /match no commit here, for example draft\.txt/);
    assert.match(reasons["agent-orphan"], /repository is gone/);
    const allPaths = [...worktrees.offered, ...worktrees.keeps.map((keep) => keep.path)];
    assert.equal(allPaths.some((path) => lastName(path) === "a-live-session-worktree"), false);
    const branches = worktrees.repositories[0].branches.map((branch) => `${branch.branch} ${branch.verdict}`);
    assert.ok(branches.includes("worktree-agent-leftover safe"));
    assert.equal(branches.some((line) => line.startsWith("worktree-agent-elsewhere")), false);
    assert.match(progress, /checking worktree-folders: 4 folders/);
    assert.match(progress, /checked worktree-folders in \d+ s: 1 safe, 3 to keep/);
    assert.match(progress, /sizing records: 2 entries/);
    assert.match(progress, /sized records in \d+ s: \d/);
    assert.equal(groupOf(report, "records").size.isComplete, true);
  });

  test("the plain listing names each keep, the branch count and how to remove a group", () => {
    const result = run("--home", tree.home);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /worktree-folders: .*4 folders: 1 safe to remove \(.+\), 3 to keep/);
    assert.match(result.stdout, /keep .*agent-forgotten: 1 file\(s\) match no commit here/);
    assert.match(result.stdout, /agent branch(es)? with no worktree, \d+ safe to remove, \d+ to keep/);
    assert.match(result.stdout, /removes agents\/sidequest-exec-low\.md/);
    assert.doesNotMatch(result.stdout, /style-reviewer/);
    assert.match(result.stdout, /--remove board-database,worktree-folders,quarantine,records,other-plugins/);
  });

  test("the other-plugins group names eight generated agent files and counts the rest", () => {
    const entries = Array.from({ length: 10 }, (_, index) => `agents/sidequest-exec-${index}.md`);
    const group = { id: "other-plugins", name: "other plugins", count: 10, size: { bytes: 0, isComplete: true }, loses: "nothing", note: "", entries, keeps: [], repositories: [] };
    const lines = renderGroups("/config", [group]).split("\n").filter((line) => /removes agents|more generated/.test(line));
    assert.equal(lines.length, 9);
    assert.match(lines[8], /and 2 more generated agent files/);
  });

  test("with no time allowance a group reads at least what was counted, and the scan still finishes", () => {
    const { report } = runJson("--home", tree.home, "--size-seconds", "0");
    const records = groupOf(report, "records");
    assert.equal(records.size.isComplete, false);
    assert.match(sizeWords(records.size), /^at least \d+(\.\d)? [KMG]?B, still more \(\d+ files counted/);
    const text = run("--home", tree.home, "--size-seconds", "0");
    assert.equal(text.status, 0);
    assert.match(text.stdout, /records: .*at least/);
  });

  test("without Sidequest installed no worktree folder is offered, and it says why", () => {
    const options = readOptions(["--home", tree.home, "--size-seconds", "0"], {});
    const context = { ...contextOf(options, () => {}), script: undefined };
    const worktrees = readGroups(options, context).find((group) => group.id === "worktree-folders");
    assert.deepEqual(worktrees.offered, []);
    assert.equal(worktrees.keeps.length, 4);
    assert.match(worktrees.note, /sidequest of this version is not installed/);
  });

  test("a removal approved for one group removes that group only and names what was removed and kept", () => {
    const result = run("--home", tree.home, "--remove", "records");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(tree.board, "briefings")), false);
    assert.equal(existsSync(join(tree.board, "dispatch")), false);
    assert.equal(existsSync(join(tree.board, "sidequest.db")), true);
    assert.equal(existsSync(join(tree.board, "worktree-quarantine", "salvaged", "work.txt")), true);
    assert.equal(existsSync(tree.folders.safe), true);
    assert.equal(existsSync(join(tree.claudeFolder, "codebase-mapper-state")), true);
    assert.match(result.stdout, /removed records: 2 entries, got back \d/);
    assert.match(result.stdout, /kept, no yes given: board-database, worktree-folders, quarantine, other-plugins/);
    assert.match(result.stderr, /removing records: 2 entries/);
    assert.match(result.stderr, /removed records in \d+ s: 2 removed, 0 refused/);
  });

  test("a removal of the worktree folders takes only the safe ones and the safe branches, and keeps the rest named", () => {
    const result = run("--home", tree.home, "--remove", "worktree-folders");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(tree.folders.safe), false);
    assert.equal(existsSync(join(tree.folders.untracked, "notes.txt")), true);
    assert.equal(existsSync(join(tree.folders.forgotten, "draft.txt")), true);
    assert.equal(existsSync(tree.folders.orphan), true);
    assert.equal(existsSync(tree.folders.elsewhere), true);
    assert.equal(existsSync(join(tree.board, "sidequest.db")), true);
    const branches = git(tree.project, "branch", "--format=%(refname:short)").split("\n");
    assert.equal(branches.includes("worktree-agent-leftover"), false);
    assert.equal(branches.includes("worktree-agent-elsewhere"), true);
    assert.match(result.stdout, /removed worktree-folders: 1 entry, \d+ agent branch(es)? deleted/);
    assert.match(result.stdout, /kept .*agent-forgotten: 1 file\(s\) match no commit here/);
    assert.match(result.stdout, /kept .*agent-orphan: its repository is gone/);
  });

  test("nothing is removed for a group name it does not know", () => {
    const result = run("--home", tree.home, "--remove", "records,everything");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no group called everything/);
    assert.equal(existsSync(join(tree.board, "sidequest.db")), true);
  });
});

describe("an installed Sidequest whose worktree script is older or broken", () => {
  let scratch;
  let tree;
  let standIns;

  // Each stand-in writes down the arguments it got, so a test can see that --remove-safe never reached it.
  const standInScript = (callLog, body) =>
    `require("node:fs").appendFileSync(${JSON.stringify(callLog)}, process.argv.slice(2).join(" ") + "\\n");\n${body}\n`;

  before(() => {
    scratch = mkdtempSync(join(tmpdir(), "quartermaster-home-older-"));
    tree = buildHome(scratch);
    const callLog = join(scratch, "stand-in-calls.txt");
    standIns = {
      callLog,
      older: join(scratch, "older-worktrees.cjs"),
      broken: join(scratch, "broken-worktrees.cjs"),
      current: join(sidequestPlugin, "scripts", "worktrees.mjs"),
    };
    const olderAnswer = JSON.stringify({ worktrees: [], branches: [], removals: [] });
    writeFile(standIns.older, standInScript(callLog, `console.log(${JSON.stringify(olderAnswer)});`));
    writeFile(standIns.broken, standInScript(callLog, `console.error("unknown argument --only-under-root"); process.exit(2);`));
  });

  after(() => rmSync(scratch, { recursive: true, force: true }));

  const worktreeKeeps = (report) => groupOf(report, "worktree-folders").keeps.map((keep) => keep.reasons.join(", "));

  test("an answer without a folders list keeps every worktree folder, says why once, and the other groups still list", () => {
    const { report, progress } = runJson("--home", tree.home, "--size-seconds", "0", "--worktrees-script", standIns.older);
    const worktrees = groupOf(report, "worktree-folders");
    assert.deepEqual(worktrees.offered, []);
    assert.equal(worktrees.keeps.length, 4);
    assert.equal(worktreeKeeps(report).filter((reason) => /too old to judge this folder: update it and run this again/.test(reason)).length, 3);
    assert.match(worktrees.note, /^worktree folders of 1 repository were not judged and are all kept: the installed Sidequest is too old/);
    assert.equal(progress.match(/were not judged/g).length, 1);
    assert.equal(groupOf(report, "records").count, 2);
    const text = run("--home", tree.home, "--size-seconds", "0", "--worktrees-script", standIns.older);
    assert.equal(text.status, 0);
    assert.equal(text.stdout.match(/were not judged and are all kept/g).length, 1);
  });

  test("a script that exits non-zero keeps every worktree folder with the exit and its first line, and the listing stands", () => {
    const { report } = runJson("--home", tree.home, "--size-seconds", "0", "--worktrees-script", standIns.broken);
    assert.deepEqual(groupOf(report, "worktree-folders").offered, []);
    const failed = worktreeKeeps(report).filter((reason) => reason.includes("failed here (exit 2: unknown argument --only-under-root)"));
    assert.equal(failed.length, 3);
    assert.equal(groupOf(report, "board-database").count, 2);
  });

  test("a removal with an older script never sends it --remove-safe and removes no worktree folder", () => {
    rmSync(standIns.callLog, { force: true });
    const result = run("--home", tree.home, "--size-seconds", "0", "--worktrees-script", standIns.older, "--remove", "worktree-folders");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(tree.folders.safe), true);
    assert.equal(existsSync(tree.folders.elsewhere), true);
    assert.doesNotMatch(readFileSync(standIns.callLog, "utf8"), /--remove-safe/);
    assert.match(result.stdout, /nothing removed from worktree-folders: it is all still there/);
    assert.match(result.stdout, /kept .*agent-safe: the installed Sidequest is too old/);
  });

  test("--worktrees-script points the listing at a checkout's own script", () => {
    const { report } = runJson("--home", tree.home, "--size-seconds", "0", "--worktrees-script", standIns.current);
    assert.deepEqual(groupOf(report, "worktree-folders").offered.map(lastName), ["agent-safe"]);
  });
});

describe("the home cleanup while a project still has the older version on", () => {
  let scratch;

  before(() => {
    scratch = mkdtempSync(join(tmpdir(), "quartermaster-home-busy-"));
    const claudeFolder = join(scratch, "home", ".claude");
    const project = join(scratch, "still-on");
    writeJson(join(project, ".claude", "settings.json"), { enabledPlugins: { [`sidequest@${TOOLSHED}`]: true } });
    nothingStillOn(claudeFolder, { [`sidequest@${TOOLSHED}`]: [{ scope: "project", projectPath: project, installPath: "cache", version: "6.10.3" }] });
    writeFile(join(claudeFolder, "sidequest", "dispatch", "run.json"), "{}");
  });

  after(() => rmSync(scratch, { recursive: true, force: true }));

  test("removes nothing while an older version is installed, even with nothing of the older version switched off, and says why", () => {
    const result = run("--home", join(scratch, "home"), "--remove", "records");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /1 project\(s\) still have the older version on or installed/);
    assert.equal(existsSync(join(scratch, "home", ".claude", "sidequest", "dispatch", "run.json")), true);
  });
});

describe("the home cleanup with only a gateway left on", () => {
  let scratch;
  const projectNamed = (name) => join(scratch, name);
  const entry = (projectPath) => ({ scope: "local", projectPath, installPath: "cache" });
  const gatewayInstalledIn = (...projects) => ({ [`model-gateway@${TOOLSHED}`]: projects.map(entry) });

  before(() => {
    scratch = mkdtempSync(join(tmpdir(), "quartermaster-home-gateway-"));
    const claudeFolder = join(scratch, "home", ".claude");
    for (const name of ["answered", "unanswered"]) writeJson(join(projectNamed(name), ".claude", "settings.local.json"), { enabledPlugins: { [`model-gateway@${TOOLSHED}`]: true } });
    writeFile(join(projectNamed("answered"), KEPT_RECORD), "- gateway: kept 2026-11-20, they use other providers' models\n");
    nothingStillOn(claudeFolder, gatewayInstalledIn(projectNamed("answered"), projectNamed("unanswered")));
    writeFile(join(claudeFolder, "sidequest", "dispatch", "run.json"), "{}");
  });

  after(() => rmSync(scratch, { recursive: true, force: true }));

  test("a project that kept it no longer holds the cleanup, and one that was never asked still does", () => {
    const refused = run("--home", join(scratch, "home"), "--remove", "records");
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /1 project\(s\) still have the older version on/);
    nothingStillOn(join(scratch, "home", ".claude"), gatewayInstalledIn(projectNamed("answered")));
    const allowed = run("--home", join(scratch, "home"), "--remove", "records");
    assert.equal(allowed.status, 0, allowed.stderr);
  });
});

describe("the home cleanup on a machine where this version arrived by update", () => {
  let scratch;
  let claudeFolder;
  let project;

  before(() => {
    scratch = mkdtempSync(join(tmpdir(), "quartermaster-home-arrived-"));
    claudeFolder = join(scratch, "home", ".claude");
    project = makeRepository(join(scratch, "project"));
    writeFile(join(project, ".claude", ".codebase-info", "INDEX.md"), "the map\n");
    git(project, "add", "--", ".claude/.codebase-info");
    git(project, "commit", "-q", "-m", "commit the map");
    writeJson(join(project, ".claude", "settings.local.json"), { enabledPlugins: { [`codebase-mapper@${TOOLSHED}`]: true } });
    nothingStillOn(claudeFolder, { [`codebase-mapper@${TOOLSHED}`]: [{ scope: "local", projectPath: project, installPath: "cache", version: "3.0.0" }] });
    writeJson(join(claudeFolder, "plugins", "known_marketplaces.json"), { [TOOLSHED]: {} });
    writeFile(join(claudeFolder, "plugins", "cache", TOOLSHED, "codebase-mapper", "3.0.0", "plugin.json"), "{}");
    writeFile(join(claudeFolder, "sidequest", "dispatch", "run.json"), "{}");
  });

  after(() => rmSync(scratch, { recursive: true, force: true }));

  test("a tracked old map no longer holds anything: the folder groups go and the mapper key stays as it is", () => {
    const allowed = run("--home", join(scratch, "home"), "--remove", "records");
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.equal(existsSync(join(claudeFolder, "sidequest", "dispatch", "run.json")), false);
    assert.equal(JSON.parse(readFileSync(join(project, ".claude", "settings.local.json"), "utf8")).enabledPlugins[`codebase-mapper@${TOOLSHED}`], true);
  });

  test("other-plugins takes the older state and the data of the plugins only the older version had, never this version's data, cache or marketplace record", () => {
    const thisVersionsData = ["codebase-mapper", "live-rules", "sidequest", "quartermaster"].map((name) => join(claudeFolder, "plugins", "data", `${name}-${TOOLSHED}`));
    const olderOnlyData = join(claudeFolder, "plugins", "data", `quality-gate-${TOOLSHED}`);
    for (const path of [join(claudeFolder, "codebase-mapper-state"), join(claudeFolder, "live-rules-state"), olderOnlyData, ...thisVersionsData]) writeFile(join(path, "state.json"), "{}");
    const removed = run("--home", join(scratch, "home"), "--remove", "other-plugins");
    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(existsSync(join(claudeFolder, "codebase-mapper-state")), false);
    assert.equal(existsSync(join(claudeFolder, "live-rules-state")), false);
    assert.equal(existsSync(olderOnlyData), false);
    for (const path of thisVersionsData) assert.equal(existsSync(path), true, path);
    assert.equal(existsSync(join(claudeFolder, "plugins", "cache", TOOLSHED, "codebase-mapper", "3.0.0", "plugin.json")), true);
    assert.deepEqual(JSON.parse(readFileSync(join(claudeFolder, "plugins", "known_marketplaces.json"), "utf8")), { [TOOLSHED]: {} });
  });

  test("an older mapper still installed holds it", () => {
    nothingStillOn(claudeFolder, { [`codebase-mapper@${TOOLSHED}`]: [{ scope: "local", projectPath: project, installPath: "cache", version: "2.15.10" }] });
    writeFile(join(claudeFolder, "sidequest", "dispatch", "run.json"), "{}");
    const refused = run("--home", join(scratch, "home"), "--remove", "records");
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /1 project\(s\) still have the older version on or installed/);
  });
});

test("the worktree verdicts come from this version's Sidequest, under either name, never the older one", () => {
  const scratch = mkdtempSync(join(tmpdir(), "quartermaster-home-script-"));
  try {
    const claudeFolder = join(scratch, "home", ".claude");
    const olderCopy = join(scratch, "older-sidequest");
    writeFile(join(olderCopy, "scripts", "worktrees.mjs"), "older\n");
    const record = (plugins) => writeJson(join(claudeFolder, "plugins", "installed_plugins.json"), { version: 2, plugins });
    record({ [`sidequest@${TOOLSHED}`]: [{ scope: "user", installPath: olderCopy, version: "6.10.3" }] });
    assert.equal(sidequestWorktreesScript(claudeFolder), undefined);
    record({ [`sidequest@${EARLIER}`]: [{ scope: "user", installPath: sidequestPlugin, version: "0.42.4" }] });
    assert.equal(sidequestWorktreesScript(claudeFolder), join(sidequestPlugin, "scripts", "worktrees.mjs"));
    record({ [`sidequest@${TOOLSHED}`]: [{ scope: "user", installPath: sidequestPlugin, version: "7.0.0" }] });
    assert.equal(sidequestWorktreesScript(claudeFolder), join(sidequestPlugin, "scripts", "worktrees.mjs"));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("measureSize counts every file when it has the time, and stops at once with none", () => {
  const scratch = mkdtempSync(join(tmpdir(), "quartermaster-size-"));
  writeFile(join(scratch, "a", "one.txt"), "12345");
  writeFile(join(scratch, "a", "b", "two.txt"), "123");
  assert.deepEqual(measureSize([join(scratch, "a")], undefined), { bytes: 8, files: 2, isComplete: true });
  assert.deepEqual(measureSize([join(scratch, "a")], 0), { bytes: 0, files: 0, isComplete: false });
  rmSync(scratch, { recursive: true, force: true });
});

const refusal = (reason) => ({ isRemoved: false, reason });

function operationsHolding(heldPath) {
  const isHeldOrAbove = (path) => path === heldPath || heldPath.startsWith(path + sep);
  const remove = (path) => {
    if (!isHeldOrAbove(path)) return realOperations.remove(path);
    if (path !== heldPath) for (const name of readdirSync(path)) remove(join(path, name));
    return refusal("EBUSY: resource busy or locked");
  };
  return { ...realOperations, remove };
}

describe("removing an entry that cannot be removed whole", () => {
  let scratch;

  before(() => {
    scratch = mkdtempSync(join(tmpdir(), "quartermaster-entry-"));
  });

  after(() => rmSync(scratch, { recursive: true, force: true }));

  test("everything beside the held folder goes, the held folder is named with its reason, and the count is what left the disk", () => {
    const entry = join(scratch, "evidence");
    const held = join(entry, "project-b", "run", "held");
    writeFile(join(entry, "project-a", "one.txt"), "1");
    writeFile(join(entry, "project-b", "other.txt"), "2");
    writeFile(join(held, "stuck.txt"), "3");
    writeFile(join(entry, "project-c", "deep", "three.txt"), "4");
    const outcome = removeEntry(entry, operationsHolding(held));
    assert.equal(outcome.isRemoved, false);
    assert.deepEqual(outcome.stayed, [{ path: held, reason: "EBUSY: resource busy or locked" }]);
    assert.deepEqual([outcome.removedPartCount, outcome.partCount], [2, 3]);
    assert.deepEqual(readdirSync(entry), ["project-b"]);
    assert.equal(existsSync(join(entry, "project-b", "other.txt")), false);
    assert.equal(existsSync(held), true);
  });

  test("a link inside the entry goes as a link and what it points at is untouched, even when the removal walks through its folder", () => {
    const outside = join(scratch, "outside");
    writeFile(join(outside, "marker.txt"), "keep me");
    const entry = join(scratch, "evidence-with-link");
    const held = join(entry, "project", "held");
    writeFile(join(held, "stuck.txt"), "x");
    symlinkSync(outside, join(entry, "project", "link"), "junction");
    const outcome = removeEntry(entry, operationsHolding(held));
    assert.deepEqual(outcome.stayed.map((stayed) => stayed.path), [held]);
    assert.equal(existsSync(join(entry, "project", "link")), false);
    assert.equal(readFileSync(join(outside, "marker.txt"), "utf8"), "keep me");
  });

  test("a link whose own removal fails is never walked into", () => {
    const outside = join(scratch, "outside-two");
    writeFile(join(outside, "marker.txt"), "keep me");
    const entry = join(scratch, "evidence-stuck-link");
    mkdirSync(entry, { recursive: true });
    const link = join(entry, "link");
    symlinkSync(outside, link, "junction");
    const outcome = removeEntry(entry, operationsHolding(link));
    assert.deepEqual(outcome.stayed.map((stayed) => stayed.path), [link]);
    assert.equal(readFileSync(join(outside, "marker.txt"), "utf8"), "keep me");
  });

  test("a whole entry that goes is one part and stays out of the walk", () => {
    const entry = join(scratch, "healthy");
    writeFile(join(entry, "a", "one.txt"), "1");
    const outcome = removeEntry(entry, realOperations);
    assert.deepEqual(outcome, { path: entry, isRemoved: true, stayed: [], partCount: 1, removedPartCount: 1 });
    assert.equal(existsSync(entry), false);
  });
});

describe("what the home cleanup says it removed", () => {
  const size = { bytes: 5 * 1024 ** 3, files: 10, isComplete: true };
  const result = (removals) => ({ id: "ticket-evidence", size, removals, branchRemovals: [], keeps: [] });
  const stay = (path) => ({ path, reason: "EBUSY: resource busy or locked" });
  const whole = (path) => ({ path, isRemoved: true, stayed: [], partCount: 1, removedPartCount: 1 });
  const part = (stayed, partCount, removedPartCount) => ({ path: "projects", isRemoved: false, stayed, partCount, removedPartCount });

  test("nothing removed claims no space and says the group is still there", () => {
    const text = renderRemovals([result([part([stay("a")], 1, 0)])], []);
    assert.match(text, /nothing removed from ticket-evidence: it is all still there/);
    assert.match(text, /kept a: EBUSY/);
    assert.doesNotMatch(text, /got back|GB/);
  });

  test("part removed says how many, never the estimate taken before the removal", () => {
    const text = renderRemovals([result([part([stay("a")], 35, 34)])], []);
    assert.match(text, /removed part of ticket-evidence: 34 of 35 items/);
    assert.doesNotMatch(text, /got back|5 GB|5\.0 GB/);
  });

  test("everything removed reports the space", () => {
    const text = renderRemovals([result([whole("a"), whole("b")])], []);
    assert.match(text, /removed ticket-evidence: 2 entries, got back 5\.0 GB/);
  });

  test("the paths that stayed are named up to a limit and the rest counted", () => {
    const stayed = Array.from({ length: 12 }, (_, index) => stay(`path-${index}`));
    const lines = renderRemovals([result([part(stayed, 20, 8)])], []).split("\n");
    assert.equal(lines.filter((line) => /^ {4}kept path-/.test(line)).length, 8);
    assert.ok(lines.some((line) => /and 4 more stayed/.test(line)));
  });
});
