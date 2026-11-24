#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { configDirectoryOf } from "./config-directory.mjs";
import { RECORDS_FOLDER, keepRecordsOutOfGit, writeInto } from "./records-folder.mjs";
import { CURRENT_MARKETPLACE, PLUGINS_WITH_A_NAMESAKE } from "./upgrade-findings.mjs";
import { isSamePath, readJsonOrEmpty } from "./upgrade-scan.mjs";

const STATUSES_THAT_MEAN_INSTALLED = ["applied", "loaded", "exercised", "useful"];
const SCOPES_WITH_A_PROJECT = ["project", "local"];

export function currentInstallEntries(record) {
  return Object.entries(record.plugins ?? {})
    .filter(([id, entries]) => id.endsWith(`@${CURRENT_MARKETPLACE}`) && Array.isArray(entries))
    .flatMap(([id, entries]) => entries.map((entry) => ({ name: id.slice(0, id.lastIndexOf("@")), scope: entry.scope, projectPath: entry.projectPath })))
    .filter((entry) => PLUGINS_WITH_A_NAMESAKE.includes(entry.name));
}

export function isInstalledHere(entry, project) {
  return SCOPES_WITH_A_PROJECT.includes(entry.scope) && typeof entry.projectPath === "string" && isSamePath(entry.projectPath, project);
}

function readTextOrEmpty(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function fileNamesIn(folder) {
  try {
    return readdirSync(folder);
  } catch {
    return [];
  }
}

const frontmatterValue = (text, key) => new RegExp(`^${key}: (.*)$`, "m").exec(text)?.[1]?.trim();

export function recordedPluginTargets(project) {
  return fileNamesIn(join(project, RECORDS_FOLDER, "proposals"))
    .filter((name) => /^P-\d+\.md$/.test(name))
    .map((name) => readTextOrEmpty(join(project, RECORDS_FOLDER, "proposals", name)))
    .filter((text) => frontmatterValue(text, "kind") === "plugin" && STATUSES_THAT_MEAN_INSTALLED.includes(frontmatterValue(text, "status")))
    .map((text) => frontmatterValue(text, "target"));
}

const targetOf = (entry) => `${entry.name}@${CURRENT_MARKETPLACE}`;

export const undoCommand = (entry) => `claude plugin uninstall ${targetOf(entry)} --scope ${entry.scope}`;

export function findInstalledByHand(configDirectory, project) {
  const recorded = recordedPluginTargets(project);
  const record = readJsonOrEmpty(join(configDirectory, "plugins", "installed_plugins.json"));
  return currentInstallEntries(record).filter((entry) => isInstalledHere(entry, project) && !recorded.includes(targetOf(entry)));
}

export function findInstalledForAllProjects(configDirectory) {
  const record = readJsonOrEmpty(join(configDirectory, "plugins", "installed_plugins.json"));
  return currentInstallEntries(record).filter((entry) => entry.scope === "user");
}

export const forAllProjectsLine = (entry) => `${targetOf(entry)} is installed for all projects (user scope). No record made: its undo would remove it from every project`;

export function foundLine(entry) {
  return `${targetOf(entry)} is installed at ${entry.scope} scope with no change record. Undo: ${undoCommand(entry)}`;
}

export const recordedLine = (id, entry) => `${id} recorded: ${targetOf(entry)}, installed at ${entry.scope} scope. Undo: ${undoCommand(entry)}`;

function proposalText(entry, id, today) {
  const target = targetOf(entry);
  return [
    "---",
    `id: ${id}`,
    "kind: plugin",
    `target: ${target}`,
    "status: applied",
    "authority: quiet",
    `evidence: [found-installed:${entry.name}]`,
    `expect: claude plugin list --json shows ${target} at ${entry.scope} scope`,
    "baseline: 0",
    `created: ${today}`,
    "---",
    "",
    `${target} was found already installed at ${entry.scope} scope. Quartermaster did not install it: someone did it by hand before outfit ran.`,
    "This record changes nothing. It exists so the undo covers the plugin.",
    "",
    `Undo: \`${undoCommand(entry)}\`. Rolling this record back restores no file, so run that command too.`,
    "",
  ].join("\n");
}

const nextNumber = (project) =>
  Math.max(0, ...fileNamesIn(join(project, RECORDS_FOLDER, "proposals")).map((name) => Number(/^P-(\d+)\.md$/.exec(name)?.[1] ?? 0))) + 1;

const idWithPrefix = (prefix, number) => `${prefix}-${String(number).padStart(4, "0")}`;

function writeRecord(project, entry, number, today) {
  const proposal = idWithPrefix("P", number);
  const change = idWithPrefix("C", number);
  writeInto(join(project, RECORDS_FOLDER, "proposals", `${proposal}.md`), proposalText(entry, proposal, today));
  writeInto(
    join(project, RECORDS_FOLDER, "changes", change, "change.json"),
    JSON.stringify({ id: change, proposal, created: today, files: [], foundInstalled: true, undo: undoCommand(entry) }, null, 2),
  );
  return proposal;
}

export function recordFoundInstalls(project, entries, today) {
  if (entries.length === 0) return [];
  keepRecordsOutOfGit(project);
  const first = nextNumber(project);
  return entries.map((entry, index) => writeRecord(project, entry, first + index, today));
}

function valueAfter(commandLineArguments, flag) {
  const index = commandLineArguments.indexOf(flag);
  return index === -1 ? undefined : commandLineArguments[index + 1];
}

export function runFoundInstalled(commandLineArguments, environment, cwd, today = new Date().toISOString().slice(0, 10)) {
  const project = resolve(valueAfter(commandLineArguments, "--project") ?? cwd);
  const configDirectory = configDirectoryOf(environment, homedir());
  const found = findInstalledByHand(configDirectory, project);
  const forAllProjects = findInstalledForAllProjects(configDirectory).map(forAllProjectsLine);
  if (!commandLineArguments.includes("--record")) return [...found.map(foundLine), ...forAllProjects];
  const ids = recordFoundInstalls(project, found, today);
  return [...found.map((entry, index) => recordedLine(ids[index], entry)), ...forAllProjects];
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const lines = runFoundInstalled(process.argv.slice(2), process.env, process.cwd());
  if (lines.length > 0) console.log(lines.join("\n"));
}
