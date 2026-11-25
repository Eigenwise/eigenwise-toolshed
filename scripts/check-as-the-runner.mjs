#!/usr/bin/env node
// Runs the check the way the Windows runner meets it: the temp folder reached through another spelling than the one
// git answers with, and git converting line endings. Both broke the worktree scripts for a day while every local run
// was green, and both happen on a real person's machine.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { repositoryRoot } from "./repository.mjs";

const LONG_FOLDER_NAME = "toolshed-check-as-the-runner";

function shortSpellingOf(folder) {
  if (process.platform !== "win32") return undefined;
  const answer = spawnSync("cmd", ["/d", "/s", "/c", `for %I in ("${folder}") do @echo %~sI`], { encoding: "utf8", windowsVerbatimArguments: true });
  const short = (answer.stdout ?? "").trim();
  return short !== "" && short.toLowerCase() !== folder.toLowerCase() ? short : undefined;
}

// Where the volume keeps no short names, and on other systems, a link gives the same folder a second spelling.
function linkedSpellingOf(folder) {
  const link = `${folder}-linked`;
  if (!existsSync(link)) symlinkSync(folder, link, "junction");
  return link;
}

const longNamedFolder = () => join(tmpdir(), LONG_FOLDER_NAME);

// Whatever the check's tests left under the folder goes with it, and so does the link beside it.
export function removeTheTempFolder() {
  rmSync(`${longNamedFolder()}-linked`, { recursive: true, force: true });
  rmSync(longNamedFolder(), { recursive: true, force: true });
}

export function otherSpellingOfTheTempFolder() {
  const folder = longNamedFolder();
  mkdirSync(folder, { recursive: true });
  return shortSpellingOf(folder) ?? linkedSpellingOf(folder);
}

export function runnerEnvironment(tempFolder) {
  return {
    ...process.env,
    TEMP: tempFolder,
    TMP: tempFolder,
    TMPDIR: tempFolder,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.autocrlf",
    GIT_CONFIG_VALUE_0: "true",
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const tempFolder = otherSpellingOfTheTempFolder();
  console.log(`check as the runner: temp folder spelled ${tempFolder}, line ending conversion on`);
  const run = spawnSync(process.execPath, [join(repositoryRoot, "scripts", "check.mjs"), ...process.argv.slice(2)], { stdio: "inherit", env: runnerEnvironment(tempFolder) });
  removeTheTempFolder();
  process.exitCode = run.status ?? 1;
}
