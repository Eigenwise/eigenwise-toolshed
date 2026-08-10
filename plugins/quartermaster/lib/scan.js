'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { projectsRoot, slugForProject } = require('./paths.js');

const DEFAULT_DAYS = 30;
const DEFAULT_SESSIONS = 40;

function safeReaddir(directory, options) {
  try {
    return fs.readdirSync(directory, options);
  } catch {
    return [];
  }
}

function statOrNull(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

function resolveSlug(projectPath, root) {
  const slug = slugForProject(path.resolve(projectPath));
  if (fs.existsSync(path.join(root, slug))) return slug;
  // A project reached through different path casing still has one transcript directory.
  const wanted = slug.toLowerCase();
  const match = safeReaddir(root).find((name) => name.toLowerCase() === wanted);
  return match ?? slug;
}

function subagentsFor(slugDirectory, sessionId) {
  const directory = path.join(slugDirectory, sessionId, 'subagents');
  const files = [];
  for (const name of safeReaddir(directory)) {
    if (!name.endsWith('.jsonl')) continue;
    const file = path.join(directory, name);
    const stat = statOrNull(file);
    if (!stat || !stat.isFile()) continue;
    files.push({ scope: 'subagent', file, bytes: stat.size, modifiedMs: stat.mtimeMs, sessionId });
  }
  return files;
}

function sessionsInSlug(root, slug) {
  const slugDirectory = path.join(root, slug);
  const sessions = [];
  for (const entry of safeReaddir(slugDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const file = path.join(slugDirectory, entry.name);
    const stat = statOrNull(file);
    if (!stat) continue;
    sessions.push({
      scope: 'main',
      slug,
      slugDirectory,
      file,
      bytes: stat.size,
      modifiedMs: stat.mtimeMs,
      sessionId: entry.name.slice(0, -'.jsonl'.length),
    });
  }
  return sessions;
}

/**
 * Resolves the window to scan: the tighter of a day cutoff and a session cap, so one busy month
 * does not turn into a multi-gigabyte scan, and the caller learns which limit actually bound it.
 */
function resolveWindow(options = {}) {
  const {
    projectPath = process.cwd(),
    env = process.env,
    days = DEFAULT_DAYS,
    sessions: sessionLimit = DEFAULT_SESSIONS,
    allProjects = false,
    includeSubagents = true,
    now = Date.now(),
  } = options;

  const root = options.root ?? projectsRoot(env);
  const cutoffMs = now - days * 86400000;
  const slugs = allProjects
    ? safeReaddir(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    : [options.slug ?? resolveSlug(projectPath, root)];

  const all = slugs.flatMap((slug) => sessionsInSlug(root, slug));
  const withinDays = all.filter((session) => session.modifiedMs >= cutoffMs);
  withinDays.sort((a, b) => b.modifiedMs - a.modifiedMs);

  const selected = withinDays.slice(0, sessionLimit);
  for (const session of selected) {
    session.subagents = includeSubagents ? subagentsFor(session.slugDirectory, session.sessionId) : [];
  }

  const files = selected.flatMap((session) => [session, ...session.subagents]);
  return {
    root,
    slugs,
    days,
    sessionLimit,
    allProjects,
    cutoffMs,
    boundBy: withinDays.length > sessionLimit ? 'sessions' : 'days',
    sessionsAvailable: withinDays.length,
    sessionsScanned: selected.length,
    subagentsScanned: selected.reduce((total, session) => total + session.subagents.length, 0),
    bytes: files.reduce((total, file) => total + file.bytes, 0),
    earliestMs: selected.length ? Math.min(...selected.map((session) => session.modifiedMs)) : null,
    latestMs: selected.length ? Math.max(...selected.map((session) => session.modifiedMs)) : null,
    sessions: selected,
    files,
  };
}

/** Cheap first-install probe: how many transcripts exist for this project, without opening any. */
function countRecentTranscripts(projectPath, days, env = process.env) {
  const root = projectsRoot(env);
  const cutoffMs = Date.now() - days * 86400000;
  return sessionsInSlug(root, resolveSlug(projectPath, root))
    .filter((session) => session.modifiedMs >= cutoffMs).length;
}

module.exports = {
  countRecentTranscripts,
  DEFAULT_DAYS,
  DEFAULT_SESSIONS,
  resolveSlug,
  resolveWindow,
};
