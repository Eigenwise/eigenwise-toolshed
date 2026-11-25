#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createReadStream, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { configDirectoryOf } from "./config-directory.mjs";
import { EARLIER_NAME, OLDER, OLDER_ONLY_PLUGINS, THIS_VERSION, installStateOf, splitPluginId } from "./toolshed-installs.mjs";
import { hostProjectSlug, isSamePath } from "./upgrade-scan.mjs";

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const textOrEmpty = (value) => (typeof value === "string" ? value : "");

export function rowsOf(parsed) {
  if (Array.isArray(parsed)) return parsed.filter(isRecord);
  const wrapped = isRecord(parsed) ? (parsed.plugins ?? parsed.installed) : undefined;
  return Array.isArray(wrapped) ? wrapped.filter(isRecord) : [];
}

// A row for another project's local or project scope is noise here. A row that names no project is kept.
export function appliesToProject(row, project) {
  const projectPath = textOrEmpty(row.projectPath);
  return row.scope === "user" || projectPath === "" || isSamePath(projectPath, project);
}

const OLDER_ONLY = "older-only";

// One marketplace name carries both versions, so only the version says which one a row is. The plugins this version
// does not have are never updated, only taken out.
const TOOLSHED_STATE_WORDS = {
  [OLDER]: " (the older Toolshed: /quartermaster:upgrade says how to update it)",
  [OLDER_ONLY]: " (the older Toolshed, not in this version: /quartermaster:upgrade offers to uninstall it, the gateway only once nothing is wired to it)",
  [THIS_VERSION]: " (this version)",
  [EARLIER_NAME]: " (this version under its earlier name: /quartermaster:upgrade moves it)",
};

const isOlderOnly = (id) => OLDER_ONLY_PLUGINS.includes(splitPluginId(id).name);

function toolshedStateOf(id, version) {
  const state = installStateOf(id, version);
  return state === OLDER && isOlderOnly(id) ? OLDER_ONLY : state;
}

const toolshedStateWords = (id, version) => TOOLSHED_STATE_WORDS[toolshedStateOf(id, version)] ?? "";

function describeRow(row) {
  const id = textOrEmpty(row.id) || `${textOrEmpty(row.name)}@${textOrEmpty(row.marketplace)}`;
  const state = row.enabled === false ? "disabled" : "enabled";
  const version = textOrEmpty(row.version);
  return `${id} ${version || "no version"} ${textOrEmpty(row.scope) || "no scope"} ${state}${toolshedStateWords(id, version)}`;
}

export function pluginLines(parsed, project) {
  const rows = rowsOf(parsed);
  const kept = rows.filter((row) => appliesToProject(row, project));
  const header = `${kept.length} of ${rows.length} plugin rows apply to ${project} (${rows.length - kept.length} left out: other projects' scopes)`;
  return [header, ...kept.map(describeRow)];
}

export function hookNameOf(record) {
  const attachment = isRecord(record.attachment) ? record.attachment : record;
  return textOrEmpty(attachment.hookName) || textOrEmpty(attachment.hookEvent) || "unknown hook";
}

export function isHookFailure(record) {
  const attachment = isRecord(record.attachment) ? record.attachment : record;
  return attachment.type === "hook_cancelled" || attachment.timedOut === true;
}

function parseOrUndefined(line) {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

const mentionsHookFailure = (line) => line.includes("hook_cancelled") || line.includes('"timedOut":true');

export function addHookFailure(counts, line) {
  const record = mentionsHookFailure(line) ? parseOrUndefined(line) : undefined;
  if (!isRecord(record) || !isHookFailure(record)) return counts;
  const name = hookNameOf(record);
  counts.set(name, (counts.get(name) ?? 0) + 1);
  return counts;
}

export function hookLines(counts, transcriptName) {
  if (counts.size === 0) return [`no cancelled or timed-out hooks in ${transcriptName}`];
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  const rows = [...counts].sort((first, second) => second[1] - first[1]).map(([name, count]) => `${count} ${name}`);
  return [`${total} cancelled or timed-out hooks in ${transcriptName}, by hook name:`, ...rows];
}

export function newestTranscript(folder) {
  try {
    const transcripts = readdirSync(folder).filter((name) => name.endsWith(".jsonl"));
    const newest = transcripts.map((name) => ({ name, modified: statSync(join(folder, name)).mtimeMs })).sort((first, second) => second.modified - first.modified)[0];
    return newest === undefined ? undefined : join(folder, newest.name);
  } catch {
    return undefined;
  }
}

async function countHookFailures(transcriptPath) {
  const counts = new Map();
  const lines = createInterface({ input: createReadStream(transcriptPath, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) addHookFailure(counts, line);
  return counts;
}

export async function hookReport(configDirectory, project) {
  const folder = join(configDirectory, "projects", hostProjectSlug(project));
  const transcript = newestTranscript(folder);
  if (transcript === undefined) return [`no transcript found for this project in ${folder}`];
  return hookLines(await countHookFailures(transcript), transcript);
}

// The listing marks a plugin enabled for the folder it runs in, so it has to run in the project's own folder.
function listPluginsIn(project) {
  try {
    return execFileSync("claude", ["plugin", "list", "--json"], { cwd: project, encoding: "utf8", shell: process.platform === "win32", maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return "";
  }
}

export function pluginReport(listing, project) {
  const parsed = parseOrUndefined(listing);
  return parsed === undefined ? [`could not read \`claude plugin list --json\` for ${project}: run it in that folder and check it prints JSON`] : pluginLines(parsed, project);
}

function valueAfter(commandLineArguments, flag) {
  const index = commandLineArguments.indexOf(flag);
  return index === -1 ? undefined : commandLineArguments[index + 1];
}

export async function runInspectFacts(commandLineArguments, environment, cwd, listPlugins = listPluginsIn) {
  const project = resolve(valueAfter(commandLineArguments, "--project") ?? cwd);
  const topic = commandLineArguments[0];
  if (topic === "plugins") return pluginReport(listPlugins(project), project);
  if (topic === "hooks") return hookReport(configDirectoryOf(environment, homedir()), project);
  return ["usage: inspect-facts.mjs plugins|hooks [--project <path>]"];
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const lines = await runInspectFacts(process.argv.slice(2), process.env, process.cwd());
  console.log(lines.join("\n"));
}
