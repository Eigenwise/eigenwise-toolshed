import { GATEWAY_PLUGIN, OLDER_MARKETPLACE } from "./upgrade-findings.mjs";
import { wasUsedWithin } from "./upgrade-last-use.mjs";

export const switchOffNames = (olderPluginsOn, olderPluginsHeld = []) =>
  olderPluginsOn.filter((name) => name !== GATEWAY_PLUGIN && !olderPluginsHeld.includes(name));

export function judgeProject(project, nowMs, days) {
  if (!project.isFolderPresent) return "folder-gone";
  if (wasUsedWithin(project.lastUse, nowMs, days)) return "used-recently";
  return switchOffNames(project.olderPluginsOn, project.olderPluginsHeld).length === 0 ? "nothing-to-switch-off" : "quiet";
}

const isWorthJudging = (project) => !project.isFolderPresent || project.olderPluginsOn.length > 0;

export function planQuietProjects(installedProjects, nowMs, days) {
  return installedProjects.filter(isWorthJudging).map((project) => ({
    path: project.path,
    verdict: judgeProject(project, nowMs, days),
    lastUse: project.lastUse,
    switchOff: switchOffNames(project.olderPluginsOn, project.olderPluginsHeld),
    keepsGateway: project.olderPluginsOn.includes(GATEWAY_PLUGIN),
    keepsHeld: project.olderPluginsHeld ?? [],
  }));
}

const recordOf = (value) => (value !== null && typeof value === "object" && !Array.isArray(value) ? value : {});

export function settingsWithOlderPluginsOff(settings, names) {
  const switchedOff = Object.fromEntries(names.map((name) => [`${name}@${OLDER_MARKETPLACE}`, false]));
  return { ...settings, enabledPlugins: { ...recordOf(settings.enabledPlugins), ...switchedOff } };
}

// A copy under the upgrade's usual name is from an earlier day, so it is never overwritten or used as this run's undo.
export function backupNameFor(fileName, isTaken, today) {
  const usual = `${fileName}.before-upgrade`;
  if (!isTaken(usual)) return usual;
  const dated = `${usual}-${today}`;
  let candidate = dated;
  for (let number = 2; isTaken(candidate); number += 1) candidate = `${dated}-${number}`;
  return candidate;
}
