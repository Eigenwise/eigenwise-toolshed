import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";

import { findInstalledByHand, findInstalledForAllProjects, foundLine, recordFoundInstalls, runFoundInstalled, undoCommand } from "./found-installed.mjs";

const TOOLSHED = "eigenwise-toolshed";
const TODAY = "2026-11-19";

function writeFile(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

const installEntry = (scope, projectPath, version) => ({ scope, projectPath, installPath: "cache", version });

describe("a plugin of this version found already installed by hand", () => {
  let scratch;
  let configDirectory;
  let project;
  let environment;

  before(() => {
    scratch = mkdtempSync(join(tmpdir(), "quartermaster-found-"));
    project = join(scratch, "a project");
    configDirectory = join(scratch, "home", ".claude");
    environment = { CLAUDE_CONFIG_DIR: configDirectory };
    mkdirSync(project, { recursive: true });
    writeFile(
      join(configDirectory, "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          [`sidequest@${TOOLSHED}`]: [installEntry("local", project, "7.0.0"), installEntry("local", join(scratch, "elsewhere"), "7.0.0")],
          [`live-rules@${TOOLSHED}`]: [installEntry("project", project, "3.0.0")],
          [`codebase-mapper@${TOOLSHED}`]: [installEntry("user", undefined, "3.0.0")],
          [`quality-gate@${TOOLSHED}`]: [installEntry("local", project, "1.5.1")],
          [`observability@${TOOLSHED}`]: [installEntry("user", undefined, "1.1.1")],
          [`quartermaster@${TOOLSHED}`]: [installEntry("local", project, "1.1.3")],
          "sidequest@toolshed-next": [installEntry("local", project, "0.42.4")],
        },
      }),
    );
    writeFile(
      join(project, ".claude", "quartermaster", "proposals", "P-0004.md"),
      "---\nid: P-0004\nkind: plugin\ntarget: live-rules@eigenwise-toolshed\nstatus: applied\nauthority: ask\nevidence: [x]\nexpect: y\nbaseline: 0\ncreated: 2026-11-01\n---\n\nbody\n",
    );
  });

  after(() => rmSync(scratch, { recursive: true, force: true }));

  test("names the installs of this version for this project that no record covers, and leaves the older version, the earlier name and the rest", () => {
    const found = findInstalledByHand(configDirectory, project).map((entry) => `${entry.name} ${entry.scope}`);
    assert.deepEqual(found.sort(), ["sidequest local"]);
  });

  test("says how to undo each one", () => {
    const [sidequest] = findInstalledByHand(configDirectory, project).filter((entry) => entry.name === "sidequest");
    assert.equal(undoCommand(sidequest), `claude plugin uninstall sidequest@${TOOLSHED} --scope local`);
    assert.match(foundLine(sidequest), /no change record\. Undo: claude plugin uninstall/);
  });

  test("lists without writing unless asked to record", () => {
    const lines = runFoundInstalled(["--project", project], environment, project, TODAY);
    assert.equal(lines.length, 2);
    assert.match(lines[1], /^codebase-mapper@eigenwise-toolshed is installed for all projects \(user scope\)\. No record made: its undo would remove it from every project$/);
    assert.throws(() => readFileSync(join(project, ".claude", "quartermaster", "proposals", "P-0005.md")));
  });

  test("writes a proposal and a change record that say it was found installed and give the undo", () => {
    const lines = runFoundInstalled(["--project", project, "--record"], environment, project, TODAY);
    assert.equal(lines.length, 2);
    assert.match(lines[1], /^codebase-mapper@eigenwise-toolshed is installed for all projects/);
    assert.deepEqual([lines[0].replace(/^P-\d+ /, "")], [
      `recorded: sidequest@${TOOLSHED}, installed at local scope. Undo: claude plugin uninstall sidequest@${TOOLSHED} --scope local`,
    ]);
    for (const line of lines) assert.doesNotMatch(line, /no change record/);
    const proposal = readFileSync(join(project, ".claude", "quartermaster", "proposals", "P-0005.md"), "utf8");
    assert.match(proposal, /^kind: plugin$/m);
    assert.match(proposal, /found already installed/);
    assert.match(proposal, /Undo: `claude plugin uninstall \w[\w-]*@eigenwise-toolshed --scope local`/);
    const change = JSON.parse(readFileSync(join(project, ".claude", "quartermaster", "changes", "C-0005", "change.json"), "utf8"));
    assert.deepEqual(change.files, []);
    assert.equal(change.proposal, "P-0005");
    assert.match(change.undo, /^claude plugin uninstall /);
    assert.match(readFileSync(join(project, ".claude", "quartermaster", ".gitignore"), "utf8"), /^\*$/m);
  });

  test("a plugin installed for all projects is listed and never recorded", () => {
    assert.deepEqual(findInstalledForAllProjects(configDirectory).map((entry) => entry.name), ["codebase-mapper"]);
    assert.deepEqual(readdirSync(join(project, ".claude", "quartermaster", "proposals")).sort(), ["P-0004.md", "P-0005.md"]);
  });

  test("once recorded, the same installs are no longer found", () => {
    assert.deepEqual(findInstalledByHand(configDirectory, project), []);
    assert.deepEqual(recordFoundInstalls(project, [], TODAY), []);
  });
});
