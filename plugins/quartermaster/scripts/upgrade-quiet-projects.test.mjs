import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { hostProjectSlug } from "./upgrade-scan.mjs";
import { backupNameFor, judgeProject, planQuietProjects, settingsWithOlderPluginsOff, switchOffNames } from "./upgrade-quiet.mjs";
import { applyToProject, listingLines, outcomeLines } from "./upgrade-quiet-projects.mjs";

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "upgrade-quiet-projects.mjs");
const scanPath = join(dirname(fileURLToPath(import.meta.url)), "upgrade-scan.mjs");
const OLDER = "eigenwise-toolshed";
const DAY = 24 * 60 * 60 * 1000;

const writeFile = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
const writeJson = (path, value) => writeFile(path, JSON.stringify(value, null, 2));
const on = (...names) => Object.fromEntries(names.map((name) => [`${name}@${OLDER}`, true]));

function writeTranscript(configFolder, project, daysAgo) {
  const path = join(configFolder, "projects", hostProjectSlug(project), "session.jsonl");
  writeFile(path, "{}\n");
  const when = new Date(Date.now() - daysAgo * DAY);
  utimesSync(path, when, when);
}

function snapshot(folder, found = new Map()) {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) snapshot(path, found);
    else found.set(path, `${statSync(path).size} ${readFileSync(path, "utf8")}`);
  }
  return found;
}

const run = (home, ...extra) => execFileSync(process.execPath, [scriptPath, "--home", home, ...extra], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const scan = (home, project, ...extra) => execFileSync(process.execPath, [scanPath, "--home", home, "--project", project, ...extra], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

describe("switching off the quiet projects on a made-up machine", () => {
  let scratch;
  let home;
  let configFolder;
  let projects;

  before(() => {
    scratch = mkdtempSync(join(tmpdir(), "quartermaster-quiet-"));
    home = join(scratch, "home");
    configFolder = join(home, ".claude");
    projects = Object.fromEntries(["busy", "quiet-with-copy", "never-used", "gateway-only", "unreadable", "gone"].map((name) => [name, join(scratch, name)]));
    for (const name of Object.keys(projects).filter((name) => name !== "gone")) mkdirSync(join(projects[name], ".claude"), { recursive: true });
    writeJson(join(projects.busy, ".claude", "settings.json"), { enabledPlugins: on("sidequest") });
    writeTranscript(configFolder, projects.busy, 2);
    writeJson(join(projects["quiet-with-copy"], ".claude", "settings.json"), { enabledPlugins: on("sidequest", "quartermaster") });
    writeJson(join(projects["quiet-with-copy"], ".claude", "settings.local.json"), { enabledPlugins: { ...on("live-rules", "model-gateway") }, env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:4000" } });
    writeFile(join(projects["quiet-with-copy"], ".claude", "settings.local.json.before-upgrade"), "an earlier day's copy\n");
    writeTranscript(configFolder, projects["quiet-with-copy"], 45);
    writeJson(join(projects["never-used"], ".claude", "settings.json"), { enabledPlugins: on("codebase-mapper") });
    writeJson(join(projects["gateway-only"], ".claude", "settings.local.json"), { enabledPlugins: on("model-gateway") });
    writeFile(join(projects.unreadable, ".claude", "settings.local.json"), "{ not json");
    writeJson(join(projects.unreadable, ".claude", "settings.json"), { enabledPlugins: on("sidequest") });
    const entry = (path) => ({ scope: "project", projectPath: path, installPath: "cache", version: "1.0.0" });
    writeJson(join(configFolder, "plugins", "installed_plugins.json"), {
      version: 2,
      plugins: { [`sidequest@${OLDER}`]: Object.values(projects).map(entry) },
    });
  });

  after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  test("the plain run lists the quiet projects with what it would switch off, and writes nothing", () => {
    const before = snapshot(scratch);
    const listing = run(home);
    assert.deepEqual(snapshot(scratch), before);
    assert.match(listing, /quiet-with-copy/);
    assert.match(listing, /would switch off: sidequest, quartermaster, live-rules/);
    assert.match(listing, /left on: model-gateway/);
    assert.match(listing, /never-used.*no session or commit on record/);
    assert.doesNotMatch(listing, /would switch off:.*model-gateway/);
    assert.equal(listing.split("\n").filter((line) => line.includes(`${projects.busy}`)).length, 0);
    assert.match(listing, /1 was used in the last 30 days and is left out/);
    assert.match(listing, /Folder gone, nothing to do here \(1\):/);
    assert.doesNotMatch(listing, /abandoned|dead|stale|inactive/i);
  });

  test("--days widens or narrows what counts as quiet", () => {
    assert.match(run(home, "--days", "1"), /busy.*would switch off: sidequest/s);
    assert.doesNotMatch(run(home, "--days", "60"), /quiet-with-copy/);
  });

  test("applying writes only the local settings, keeps a copy under a dated name, and leaves the gateway and committed files alone", () => {
    const committedBefore = readFileSync(join(projects["quiet-with-copy"], ".claude", "settings.json"), "utf8");
    const busyBefore = snapshot(projects.busy);
    const printed = run(home, "--switch-off");
    const quiet = projects["quiet-with-copy"];
    assert.equal(readFileSync(join(quiet, ".claude", "settings.json"), "utf8"), committedBefore);
    assert.deepEqual(snapshot(projects.busy), busyBefore);
    const local = JSON.parse(readFileSync(join(quiet, ".claude", "settings.local.json"), "utf8"));
    assert.equal(local.enabledPlugins[`sidequest@${OLDER}`], false);
    assert.equal(local.enabledPlugins[`quartermaster@${OLDER}`], false);
    assert.equal(local.enabledPlugins[`live-rules@${OLDER}`], false);
    assert.equal(local.enabledPlugins[`model-gateway@${OLDER}`], true);
    assert.equal(local.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:4000");
    assert.equal(readFileSync(join(quiet, ".claude", "settings.local.json.before-upgrade"), "utf8"), "an earlier day's copy\n");
    const copies = readdirSync(join(quiet, ".claude")).filter((name) => /^settings\.local\.json\.before-upgrade-\d{4}-\d{2}-\d{2}$/.test(name));
    assert.equal(copies.length, 1);
    assert.equal(JSON.parse(readFileSync(join(quiet, ".claude", copies[0]), "utf8")).enabledPlugins[`live-rules@${OLDER}`], true);
    assert.match(printed, new RegExp(`copy: .*${copies[0]}`));
    assert.match(printed, /undo: copy .* back over /);
    assert.match(printed, /left on: model-gateway, the gateway plugin/);
  });

  test("a project with no local file gets one and no copy, a gateway-only project gets nothing, a folder that is gone is named", () => {
    assert.deepEqual(JSON.parse(readFileSync(join(projects["never-used"], ".claude", "settings.local.json"), "utf8")), { enabledPlugins: { [`codebase-mapper@${OLDER}`]: false } });
    assert.deepEqual(readdirSync(join(projects["never-used"], ".claude")).sort(), ["settings.json", "settings.local.json"]);
    assert.equal(existsSync(join(projects["gateway-only"], ".claude", "settings.json")), false);
    assert.equal(JSON.parse(readFileSync(join(projects["gateway-only"], ".claude", "settings.local.json"), "utf8")).enabledPlugins[`model-gateway@${OLDER}`], true);
  });

  test("a local file that is not JSON is left as it is", () => {
    assert.equal(readFileSync(join(projects.unreadable, ".claude", "settings.local.json"), "utf8"), "{ not json");
  });

  test("the scan afterwards counts fewer plugins still on", () => {
    const plan = scan(home, projects.busy, "--all-projects");
    assert.match(plan, /switched on in 4, most recently used first/);
  });

  test("a project with a session inside the window is never touched, even when its plan is handed over", () => {
    const busyBefore = snapshot(projects.busy);
    const outcome = applyToProject({ path: projects.busy }, { configDirectory: configFolder, nowMs: Date.now(), days: 30, today: "2026-11-20" });
    assert.equal(outcome.outcome, "used-recently");
    assert.deepEqual(snapshot(projects.busy), busyBefore);
  });

  test("a folder that is gone is skipped by name", () => {
    const outcome = applyToProject({ path: projects.gone }, { configDirectory: configFolder, nowMs: Date.now(), days: 30, today: "2026-11-20" });
    assert.equal(outcome.outcome, "folder-gone");
    assert.equal(existsSync(projects.gone), false);
  });
});

describe("the rules behind the listing", () => {
  const nowMs = Date.UTC(2026, 10, 20);
  const project = (overrides) => ({ path: "/work/one", isFolderPresent: true, olderPluginsOn: ["sidequest"], lastUse: undefined, ...overrides });

  test("judges a missing folder, a recent session, a gateway-only project and a quiet one", () => {
    const recent = { atMs: nowMs - 2 * DAY, source: "session" };
    assert.equal(judgeProject(project({ isFolderPresent: false }), nowMs, 30), "folder-gone");
    assert.equal(judgeProject(project({ lastUse: recent }), nowMs, 30), "used-recently");
    assert.equal(judgeProject(project({ olderPluginsOn: ["model-gateway"] }), nowMs, 30), "nothing-to-switch-off");
    assert.equal(judgeProject(project({ lastUse: { atMs: nowMs - 45 * DAY, source: "session" } }), nowMs, 30), "quiet");
  });

  test("a commit inside the window counts as use, one outside it does not", () => {
    assert.equal(planQuietProjects([project({ lastUse: { atMs: nowMs, source: "commit" } })], nowMs, 30)[0].verdict, "used-recently");
    assert.equal(planQuietProjects([project({ lastUse: { atMs: nowMs - 40 * DAY, source: "commit" } })], nowMs, 30)[0].verdict, "quiet");
  });

  test("names what would go off and keeps the gateway out of it", () => {
    assert.deepEqual(switchOffNames(["sidequest", "model-gateway", "live-rules"]), ["sidequest", "live-rules"]);
  });

  test("writes false under enabledPlugins and keeps every other key", () => {
    const written = settingsWithOlderPluginsOff({ env: { A: "1" }, enabledPlugins: { "x@other": true } }, ["sidequest"]);
    assert.deepEqual(written, { env: { A: "1" }, enabledPlugins: { "x@other": true, [`sidequest@${OLDER}`]: false } });
  });

  test("the copy keeps the upgrade's name, then a dated one, then a numbered one", () => {
    const taken = (names) => (name) => names.includes(name);
    assert.equal(backupNameFor("a.json", taken([]), "2026-11-20"), "a.json.before-upgrade");
    assert.equal(backupNameFor("a.json", taken(["a.json.before-upgrade"]), "2026-11-20"), "a.json.before-upgrade-2026-11-20");
    assert.equal(backupNameFor("a.json", taken(["a.json.before-upgrade", "a.json.before-upgrade-2026-11-20"]), "2026-11-20"), "a.json.before-upgrade-2026-11-20-2");
  });
});

describe("a mapper that holds a map git tracks is never switched off", () => {
  const nowMs = Date.UTC(2026, 10, 20);
  const project = (overrides) => ({ path: "/work/one", isFolderPresent: true, olderPluginsOn: ["codebase-mapper"], olderPluginsHeld: ["codebase-mapper"], lastUse: undefined, ...overrides });

  test("leaves the held mapper out of what goes off, and the plan row says it stays on", () => {
    assert.deepEqual(switchOffNames(["sidequest", "codebase-mapper"], ["codebase-mapper"]), ["sidequest"]);
    assert.deepEqual(switchOffNames(["sidequest", "codebase-mapper"], []), ["sidequest", "codebase-mapper"]);
    const [row] = planQuietProjects([project({ olderPluginsOn: ["sidequest", "codebase-mapper"] })], nowMs, 30);
    assert.deepEqual(row.switchOff, ["sidequest"]);
    assert.deepEqual(row.keepsHeld, ["codebase-mapper"]);
    assert.equal(row.keepsGateway, false);
  });

  test("a project with only the gateway and a held mapper on has nothing to switch off", () => {
    assert.equal(judgeProject(project(), nowMs, 30), "nothing-to-switch-off");
    assert.equal(judgeProject(project({ olderPluginsOn: ["model-gateway", "codebase-mapper"] }), nowMs, 30), "nothing-to-switch-off");
    assert.equal(judgeProject(project({ olderPluginsHeld: [] }), nowMs, 30), "quiet");
  });

  test("the listing says in the gateway's way that it stays on and why", () => {
    const plan = planQuietProjects([project({ olderPluginsOn: ["sidequest", "codebase-mapper", "model-gateway"] })], nowMs, 30);
    const lines = listingLines(plan, 30, "node quiet.mjs");
    assert.ok(lines.some((line) => line.includes("would switch off: sidequest")));
    assert.ok(lines.some((line) => line.endsWith("left on: codebase-mapper, the map git tracks loads through it")));
    assert.ok(lines.some((line) => line.includes("left on: model-gateway")));
  });

  test("the older rules plugin held by rules git tracks is left on the same way, in its own words", () => {
    const plan = planQuietProjects([project({ olderPluginsOn: ["sidequest", "live-rules"], olderPluginsHeld: ["live-rules"] })], nowMs, 30);
    assert.deepEqual(plan[0].switchOff, ["sidequest"]);
    const lines = listingLines(plan, 30, "node quiet.mjs");
    assert.ok(lines.some((line) => line.endsWith("left on: live-rules, the rules git tracks load through it")));
    const outcome = { path: "/work/one", outcome: "nothing-to-switch-off", keepsGateway: false, keepsHeld: ["live-rules"] };
    assert.match(outcomeLines(outcome).join("\n"), /nothing to switch off, the rules plugin, whose rules git tracks, left on/);
  });

  test("the listing names what is on at user scope and how to switch it off there", () => {
    const withUserScope = listingLines([], 30, "node quiet.mjs", ["sidequest", "live-rules"]);
    assert.equal(
      withUserScope.at(-1),
      "sidequest, live-rules are on for every project at user scope: claude plugin disable <name>@eigenwise-toolshed --scope user switches each off everywhere, once no project needs it.",
    );
    assert.equal(listingLines([], 30, "node quiet.mjs").some((line) => line.includes("user scope")), false);
  });

  test("applying on a repository that commits its map writes nothing for the mapper and says it stays on", () => {
    const scratch = mkdtempSync(join(tmpdir(), "quartermaster-quiet-held-"));
    try {
      const repository = join(scratch, "repository");
      mkdirSync(repository, { recursive: true });
      const git = (...args) => execFileSync("git", ["-c", "user.name=Held", "-c", "user.email=held@example.com", ...args], { cwd: repository, stdio: "ignore" });
      git("init", "-q", "-b", "main");
      writeFile(join(repository, ".claude", ".codebase-info", "INDEX.md"), "the map\n");
      git("add", "--", ".claude/.codebase-info");
      git("commit", "-q", "-m", "commit the map");
      const context = { configDirectory: join(scratch, "home", ".claude"), nowMs: Date.now() + 60 * DAY, days: 30, today: "2026-11-20" };
      writeJson(join(repository, ".claude", "settings.local.json"), { enabledPlugins: on("codebase-mapper", "sidequest") });
      const outcome = applyToProject({ path: repository }, context);
      assert.deepEqual(outcome.names, ["sidequest"]);
      assert.deepEqual(outcome.keepsHeld, ["codebase-mapper"]);
      const written = JSON.parse(readFileSync(join(repository, ".claude", "settings.local.json"), "utf8"));
      assert.equal(written.enabledPlugins[`codebase-mapper@${OLDER}`], true);
      assert.equal(written.enabledPlugins[`sidequest@${OLDER}`], false);
      assert.match(outcomeLines(outcome).join("\n"), /left on: codebase-mapper, the map git tracks loads through it/);
      writeJson(join(repository, ".claude", "settings.local.json"), { enabledPlugins: on("codebase-mapper") });
      const mapperOnly = applyToProject({ path: repository }, context);
      assert.equal(mapperOnly.outcome, "nothing-to-switch-off");
      assert.match(outcomeLines(mapperOnly).join("\n"), /nothing to switch off, the mapper, whose map git tracks, left on/);
    } finally {
      rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
