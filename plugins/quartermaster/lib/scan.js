'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');

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

function checkoutPaths(projectPath) {
  const project = path.resolve(projectPath);
  try {
    const listing = execFileSync('git', ['-C', project, 'worktree', 'list', '--porcelain', '-z'], {
      encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
    return [...new Set([project, ...listing.split('\0')
      .filter((field) => field.startsWith('worktree ')).map((field) => field.slice(9))])];
  } catch {
    return [project];
  }
}

function* transcriptLines(file) {
  const descriptor = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(65536);
  const decoder = new StringDecoder('utf8');
  let pending = '';
  try {
    let bytes;
    while ((bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      const lines = (pending + decoder.write(buffer.subarray(0, bytes))).split('\n');
      pending = lines.pop();
      yield* lines;
    }
    yield pending + decoder.end();
  } finally {
    fs.closeSync(descriptor);
  }
}

function recordedDirectory(line) {
  try {
    const record = JSON.parse(line);
    return typeof record?.cwd === 'string' ? record.cwd : null;
  } catch {
    return null;
  }
}

function canonicalDirectory(directory) {
  try {
    return fs.realpathSync.native(directory);
  } catch {
    return path.resolve(directory);
  }
}

function directoryInCheckout(directory, checkout) {
  const relative = path.relative(checkout, canonicalDirectory(directory));
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function sessionInCheckouts(session, checkouts) {
  try {
    for (const line of transcriptLines(session.file)) {
      const directory = recordedDirectory(line);
      if (directory) return checkouts.some((checkout) => directoryInCheckout(directory, checkout));
    }
  } catch {
    return false;
  }
  return false;
}

function projectSessions(options, root, projectPath, cutoffMs) {
  if (options.slug) return { slugs: [options.slug], sessions: sessionsInSlug(root, options.slug) };
  const directories = checkoutPaths(projectPath);
  const checkouts = directories.map(canonicalDirectory);
  const slugs = [...new Set(directories.map((checkout) => resolveSlug(checkout, root)))];
  const sessions = slugs.flatMap((slug) => sessionsInSlug(root, slug))
    .filter((session) => session.modifiedMs >= cutoffMs)
    .filter((session) => sessionInCheckouts(session, checkouts));
  return { slugs, sessions };
}

function sessionSources(options, root, projectPath, cutoffMs) {
  if (!options.allProjects) return projectSessions(options, root, projectPath, cutoffMs);
  const slugs = safeReaddir(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  return { slugs, sessions: slugs.flatMap((slug) => sessionsInSlug(root, slug)) };
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
  const { slugs, sessions: all } = sessionSources(options, root, projectPath, cutoffMs);
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
function countRecentTranscripts(projectPath, days, env = process.env, now = Date.now()) {
  return countTranscriptsSince(projectPath, now - days * 86400000, env);
}

function countTranscriptsSince(projectPath, cutoffMs, env = process.env) {
  const root = projectsRoot(env);
  return sessionsInSlug(root, resolveSlug(projectPath, root))
    .filter((session) => session.modifiedMs > cutoffMs).length;
}

module.exports = {
  countRecentTranscripts,
  countTranscriptsSince,
  DEFAULT_DAYS,
  DEFAULT_SESSIONS,
  resolveSlug,
  resolveWindow,
};
