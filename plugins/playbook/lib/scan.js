'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_DAYS = 7;
const DEFAULT_SESSIONS = 5;

function projectsRoot(env = process.env) {
  if (env.CLAUDE_CONFIG_DIR) return path.join(env.CLAUDE_CONFIG_DIR, 'projects');
  return path.join(os.homedir(), '.claude', 'projects');
}

/**
 * Claude Code names a transcript directory after the project path with every character that is not
 * alphanumeric replaced one-for-one by a dash, so `C:\dev\toolshed` becomes `C--dev-toolshed`. The
 * substitution is per character, not per run, which is why drive letters produce a double dash.
 */
function slugForProject(projectPath) {
  return String(projectPath).replace(/[^a-zA-Z0-9]/g, '-');
}

function resolveSlug(projectPath, root) {
  const slug = slugForProject(path.resolve(projectPath));
  if (fs.existsSync(path.join(root, slug))) return slug;

  // A project reached through a different casing or a substituted drive still has one transcript
  // directory; fall back to a case-insensitive match before reporting an empty window.
  const wanted = slug.toLowerCase();
  const match = safeReaddir(root).find((name) => name.toLowerCase() === wanted);
  return match ?? slug;
}

function safeReaddir(dir, options) {
  try {
    return fs.readdirSync(dir, options);
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

function readMeta(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function subagentsFor(slugDir, sessionId) {
  const dir = path.join(slugDir, sessionId, 'subagents');
  const files = [];
  for (const name of safeReaddir(dir)) {
    if (!name.endsWith('.jsonl')) continue;
    const file = path.join(dir, name);
    const stat = statOrNull(file);
    if (!stat || !stat.isFile()) continue;
    const meta = readMeta(path.join(dir, `${name.slice(0, -'.jsonl'.length)}.meta.json`));
    files.push({
      scope: 'subagent',
      file,
      bytes: stat.size,
      modifiedMs: stat.mtimeMs,
      sessionId,
      agentId: name.slice(0, -'.jsonl'.length),
      agentType: meta.agentType ?? null,
      customAgentType: meta.customAgentType ?? null,
      model: meta.model ?? null,
      description: meta.description ?? null,
      spawnDepth: Number.isInteger(meta.spawnDepth) ? meta.spawnDepth : null,
      worktreePath: meta.worktreePath ?? null,
    });
  }
  return files;
}

function sessionsInSlug(root, slug) {
  const slugDir = path.join(root, slug);
  const sessions = [];
  for (const entry of safeReaddir(slugDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const file = path.join(slugDir, entry.name);
    const stat = statOrNull(file);
    if (!stat) continue;
    sessions.push({
      scope: 'main',
      slug,
      slugDir,
      file,
      bytes: stat.size,
      modifiedMs: stat.mtimeMs,
      sessionId: entry.name.slice(0, -'.jsonl'.length),
    });
  }
  return sessions;
}

/**
 * Resolves the window to scan. The window is the tighter of a day cutoff and a session cap so a
 * single busy afternoon does not turn into a multi-gigabyte scan, and the caller always learns which
 * limit actually bound the result.
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
    ? safeReaddir(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
    : [options.slug ?? resolveSlug(projectPath, root)];

  const all = slugs.flatMap((slug) => sessionsInSlug(root, slug));
  const withinDays = all.filter((session) => session.modifiedMs >= cutoffMs);
  withinDays.sort((a, b) => b.modifiedMs - a.modifiedMs);

  const selected = withinDays.slice(0, sessionLimit);
  for (const session of selected) {
    session.subagents = includeSubagents ? subagentsFor(session.slugDir, session.sessionId) : [];
  }

  const boundBy = withinDays.length > sessionLimit ? 'sessions' : 'days';
  const files = selected.flatMap((session) => [session, ...session.subagents]);

  return {
    root,
    slugs,
    days,
    sessionLimit,
    allProjects,
    includeSubagents,
    cutoffMs,
    boundBy,
    sessionsAvailable: withinDays.length,
    sessionsScanned: selected.length,
    subagentsScanned: selected.reduce((total, session) => total + session.subagents.length, 0),
    skippedSessions: withinDays.length - selected.length,
    bytes: files.reduce((total, file) => total + file.bytes, 0),
    earliestMs: selected.length ? Math.min(...selected.map((s) => s.modifiedMs)) : null,
    latestMs: selected.length ? Math.max(...selected.map((s) => s.modifiedMs)) : null,
    sessions: selected,
    files,
  };
}

function describeWindow(window) {
  if (!window.sessionsScanned) {
    return `No transcripts found for ${window.slugs.join(', ')} in the last ${window.days} days.`;
  }
  const stamp = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
  const megabytes = (window.bytes / 1e6).toFixed(1);
  const scope = window.allProjects ? `${window.slugs.length} projects` : window.slugs[0];
  const bound = window.boundBy === 'sessions'
    ? `capped at ${window.sessionLimit} sessions (${window.skippedSessions} older ones in the ${window.days}-day range were not scanned)`
    : `all sessions within ${window.days} days`;
  return [
    `Window: ${stamp(window.earliestMs)} to ${stamp(window.latestMs)} UTC, ${bound}.`,
    `Scope: ${scope}, ${window.sessionsScanned} sessions + ${window.subagentsScanned} subagent transcripts, ${megabytes} MB streamed.`,
  ].join('\n');
}

module.exports = {
  DEFAULT_DAYS,
  DEFAULT_SESSIONS,
  describeWindow,
  projectsRoot,
  resolveSlug,
  resolveWindow,
  slugForProject,
};
