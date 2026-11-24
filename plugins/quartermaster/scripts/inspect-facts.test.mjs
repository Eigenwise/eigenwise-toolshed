import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { hostProjectSlug } from "./upgrade-scan.mjs";
import { pluginLines, pluginReport, runInspectFacts } from "./inspect-facts.mjs";

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "inspect-facts.mjs");

const row = (id, scope, projectPath) => ({ id, version: "1.0.0", scope, enabled: true, projectPath });

const record = (attachment) => JSON.stringify({ type: "attachment", attachment });

describe("inspect keeps to this project and names what it counts", () => {
  let scratch;
  let project;
  let environment;

  before(() => {
    scratch = mkdtempSync(join(tmpdir(), "quartermaster-inspect-"));
    project = join(scratch, "a project");
    mkdirSync(project, { recursive: true });
    environment = { ...process.env, CLAUDE_CONFIG_DIR: join(scratch, "config") };
    const folder = join(scratch, "config", "projects", hostProjectSlug(project));
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      join(folder, "newest.jsonl"),
      [
        record({ type: "hook_success", hookName: "SessionStart:startup" }),
        record({ type: "hook_cancelled", hookName: "PreToolUse:Bash", timedOut: true }),
        record({ type: "hook_cancelled", hookName: "PreToolUse:Bash" }),
        record({ type: "hook_cancelled", hookName: "Stop" }),
        "not json but says hook_cancelled",
      ].join("\n"),
    );
  });

  after(() => rmSync(scratch, { recursive: true, force: true }));

  test("lists only the rows that apply to this project, and counts what it left out", () => {
    const rows = [
      row("sidequest@toolshed-next", "local", project),
      row("sidequest@toolshed-next", "local", join(scratch, "other")),
      row("quartermaster@toolshed-next", "user"),
      row("unrelated@elsewhere", "project", join(scratch, "other")),
    ];
    const [header, ...kept] = pluginLines(rows, project);
    assert.match(header, /^2 of 4 plugin rows apply/);
    assert.deepEqual(kept.map((line) => line.split(" ")[0]), ["sidequest@toolshed-next", "quartermaster@toolshed-next"]);
  });

  test("says the list could not be read when the listing gives nothing", () => {
    assert.match(pluginReport("", project)[0], /could not read `claude plugin list --json` for/);
  });

  test("asks for the listing in the named folder, so enabled is that folder's", async () => {
    const listedIn = [];
    const listPlugins = (folder) => {
      listedIn.push(folder);
      const enabled = folder === project;
      return JSON.stringify([{ ...row("sidequest@toolshed-next", "local", project), enabled }]);
    };
    const lines = await runInspectFacts(["plugins", "--project", project], process.env, join(scratch, "elsewhere"), listPlugins);
    assert.deepEqual(listedIn, [project]);
    assert.match(lines[1], /sidequest@toolshed-next 1\.0\.0 local enabled$/);
  });

  test("names each cancelled hook with its count, newest transcript only", () => {
    const output = execFileSync(process.execPath, [scriptPath, "hooks", "--project", project], { env: environment, encoding: "utf8" });
    assert.match(output, /3 cancelled or timed-out hooks/);
    assert.match(output, /^2 PreToolUse:Bash$/m);
    assert.match(output, /^1 Stop$/m);
    assert.doesNotMatch(output, /SessionStart/);
  });

  test("says so when there is no transcript", () => {
    const output = execFileSync(process.execPath, [scriptPath, "hooks", "--project", join(scratch, "empty")], { env: environment, encoding: "utf8" });
    assert.match(output, /no transcript found/);
  });
});
