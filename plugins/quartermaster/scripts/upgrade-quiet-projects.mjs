#!/usr/bin/env node
import { copyFileSync, constants, existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { COMMITTED_SETTINGS, GATEWAY_PLUGIN, LOCAL_SETTINGS, olderPluginsOnAtUserScope, olderPluginsStillOn, userScopeWaitLine } from "./upgrade-findings.mjs";
import { QUIET_DAYS, lastUseWords, orderedByLastUse } from "./upgrade-last-use.mjs";
import { backupNameFor, judgeProject, planQuietProjects, settingsWithOlderPluginsOff, switchOffNames } from "./upgrade-quiet.mjs";
import { USER_SCOPE, readInstalledProjects, readJsonOrEmpty, readLastUse, readOptions } from "./upgrade-scan.mjs";

const GATEWAY_LEFT_ON = "left on: model-gateway, the gateway plugin. Uninstalling it while a project is wired to it blocks every prompt there, and switching it off sends prompts to a port nobody listens on once the running gateway stops; the gateway question covers it";

function readLocalSettings(projectPath) {
  const path = join(projectPath, LOCAL_SETTINGS);
  if (!existsSync(path)) return { state: "missing", settings: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const isRecord = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
    return isRecord ? { state: "read", settings: parsed } : { state: "unreadable", settings: {} };
  } catch {
    return { state: "unreadable", settings: {} };
  }
}

function readFreshProject(projectPath, configDirectory, localSettings) {
  const isFolderPresent = existsSync(projectPath);
  const committed = readJsonOrEmpty(join(projectPath, COMMITTED_SETTINGS));
  return {
    path: projectPath,
    isFolderPresent,
    olderPluginsOn: olderPluginsStillOn(committed, localSettings.settings),
    lastUse: readLastUse(configDirectory, projectPath, isFolderPresent),
  };
}

function copyBesideSettings(settingsPath, today) {
  const folder = dirname(settingsPath);
  const copyPath = join(folder, backupNameFor(basename(settingsPath), (name) => existsSync(join(folder, name)), today));
  copyFileSync(settingsPath, copyPath, constants.COPYFILE_EXCL);
  return copyPath;
}

function switchOff(project, localSettings, today) {
  const settingsPath = join(project.path, LOCAL_SETTINGS);
  const names = switchOffNames(project.olderPluginsOn);
  const copyPath = localSettings.state === "read" ? copyBesideSettings(settingsPath, today) : undefined;
  writeFileSync(settingsPath, `${JSON.stringify(settingsWithOlderPluginsOff(localSettings.settings, names), null, 2)}\n`);
  return { path: project.path, outcome: "switched-off", names, settingsPath, copyPath, keepsGateway: project.olderPluginsOn.includes(GATEWAY_PLUGIN) };
}

// The listing may be hours old, so the last use and the settings are read again before anything is written.
export function applyToProject(entry, context) {
  const localSettings = readLocalSettings(entry.path);
  const project = readFreshProject(entry.path, context.configDirectory, localSettings);
  const verdict = judgeProject(project, context.nowMs, context.days);
  if (verdict !== "quiet") return { path: entry.path, outcome: verdict, lastUse: project.lastUse, keepsGateway: project.olderPluginsOn.includes(GATEWAY_PLUGIN) };
  if (localSettings.state === "unreadable") return { path: entry.path, outcome: "settings-unreadable" };
  return switchOff(project, localSettings, context.today);
}

const gatewayLeftOnWords = (outcome) => (outcome.keepsGateway ? ", the gateway plugin left on" : "");

const SKIPPED_WORDS = {
  "folder-gone": () => "skipped, the folder is gone",
  "used-recently": (outcome) => `skipped, ${lastUseWords(outcome.lastUse)}, which is inside the window`,
  "nothing-to-switch-off": (outcome) => `nothing to switch off${gatewayLeftOnWords(outcome)}`,
  "settings-unreadable": () => `skipped, ${LOCAL_SETTINGS} is not valid JSON and is left alone`,
};

function appliedLines(outcome) {
  const copyLines =
    outcome.copyPath === undefined
      ? [`  copy: none, ${LOCAL_SETTINGS} did not exist. Undo: delete ${outcome.settingsPath}`]
      : [`  copy: ${outcome.copyPath}`, `  undo: copy ${outcome.copyPath} back over ${outcome.settingsPath}`];
  return [
    outcome.path,
    `  switched off: ${outcome.names.join(", ")}, written to ${outcome.settingsPath}`,
    ...copyLines,
    ...(outcome.keepsGateway ? [`  ${GATEWAY_LEFT_ON}`] : []),
  ];
}

export const outcomeLines = (outcome) => (outcome.outcome === "switched-off" ? appliedLines(outcome) : [`${outcome.path}`, `  ${SKIPPED_WORDS[outcome.outcome](outcome)}`]);

function listedLines(entry) {
  const gateway = entry.keepsGateway ? [`      ${GATEWAY_LEFT_ON}`] : [];
  const action = entry.switchOff.length === 0 ? "nothing to switch off here" : `would switch off: ${entry.switchOff.join(", ")}`;
  return [`  ${entry.path}  ${lastUseWords(entry.lastUse)}`, `      ${action}`, ...gateway];
}

const isListed = (entry) => entry.verdict === "quiet" || entry.verdict === "nothing-to-switch-off";

const countOf = (plan, verdict) => plan.filter((entry) => entry.verdict === verdict).length;

function usedRecentlyLines(plan, days) {
  const used = countOf(plan, "used-recently");
  return used === 0 ? [] : [`${used} ${used === 1 ? "was" : "were"} used in the last ${days} days and ${used === 1 ? "is" : "are"} left out.`];
}

export function listingLines(plan, days, switchOffCommand, userScopeOlderPluginsOn = []) {
  const listed = orderedByLastUse(plan.filter(isListed));
  const userScope = userScopeWaitLine(userScopeOlderPluginsOn);
  const gone = plan.filter((entry) => entry.verdict === "folder-gone");
  return [
    `Projects with a plugin of the older version switched on and not used in the last ${days} days (${listed.length}). This listing wrote nothing:`,
    ...listed.flatMap(listedLines),
    ...usedRecentlyLines(plan, days),
    ...(gone.length === 0 ? [] : [`Folder gone, nothing to do here (${gone.length}):`, ...gone.map((entry) => `  ${entry.path}`)]),
    ...(listed.some((entry) => entry.switchOff.length > 0) ? [`After one yes to this list: ${switchOffCommand} --switch-off`] : []),
    ...(userScope === "" ? [] : [`${userScope}.`]),
  ];
}

function valueAfter(commandLineArguments, flag) {
  const index = commandLineArguments.indexOf(flag);
  return index === -1 ? undefined : commandLineArguments[index + 1];
}

const todayOf = (nowMs) => new Date(nowMs).toISOString().slice(0, 10);

function readDays(commandLineArguments) {
  const given = valueAfter(commandLineArguments, "--days");
  return given === undefined ? QUIET_DAYS : Number(given);
}

export function runQuietProjects(commandLineArguments, environment, nowMs = Date.now()) {
  const days = readDays(commandLineArguments);
  if (!Number.isFinite(days) || days <= 0) {
    console.error("--days takes a number of days above zero.");
    return 1;
  }
  const { configDirectory } = readOptions(commandLineArguments, environment, process.cwd());
  const everyInstall = readInstalledProjects(configDirectory);
  const installed = everyInstall.filter((project) => project.path !== USER_SCOPE);
  const plan = planQuietProjects(installed, nowMs, days);
  const context = { configDirectory, nowMs, days, today: todayOf(nowMs) };
  const lines = commandLineArguments.includes("--switch-off")
    ? plan.flatMap((entry) => outcomeLines(applyToProject(entry, context)))
    : listingLines(plan, days, `node "${resolve(process.argv[1] ?? "upgrade-quiet-projects.mjs")}"`, olderPluginsOnAtUserScope(everyInstall));
  console.log(lines.join("\n"));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = runQuietProjects(process.argv.slice(2), process.env);
}
