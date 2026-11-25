export const QUIET_DAYS = 30;

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

export function lastUseOf(newestSessionMs, lastCommitMs) {
  const session = newestSessionMs === undefined ? [] : [{ atMs: newestSessionMs, source: "session" }];
  const commit = lastCommitMs === undefined ? [] : [{ atMs: lastCommitMs, source: "commit" }];
  return [...session, ...commit].sort((first, second) => second.atMs - first.atMs)[0];
}

export function wasUsedWithin(lastUse, nowMs, days = QUIET_DAYS) {
  return lastUse !== undefined && nowMs - lastUse.atMs <= days * MILLISECONDS_PER_DAY;
}

export const orderedByLastUse = (projects) => [...projects].sort((first, second) => (second.lastUse?.atMs ?? 0) - (first.lastUse?.atMs ?? 0));

const dateOf = (atMs) => new Date(atMs).toISOString().slice(0, 10);

export function lastUseWords(lastUse) {
  if (lastUse === undefined) return "no session or commit on record";
  return `last used ${dateOf(lastUse.atMs)} (${lastUse.source})`;
}

const isSwitchedOn = (project) => project.olderPluginsOn.length > 0;

export function olderProjectCountLine(otherProjects, nowMs, days = QUIET_DAYS) {
  const switchedOn = otherProjects.filter(isSwitchedOn);
  const recent = switchedOn.filter((project) => wasUsedWithin(project.lastUse, nowMs, days));
  return `Other projects: ${otherProjects.length} have the older version installed. ${switchedOn.length} still have a plugin of it switched on in their settings; ${recent.length} of those were used in the last ${days} days. --all-projects lists them, most recently used first.`;
}

export function recentUseCount(projects, nowMs, days = QUIET_DAYS) {
  return projects.filter((project) => wasUsedWithin(project.lastUse, nowMs, days)).length;
}
