'use strict';

function createPaths({ fs, os, path, crypto }: any) {
function homeRoot() {
  const env = process.env.SIDEQUEST_HOME;
  if (env && String(env).trim()) return path.resolve(String(env).trim());
  return path.join(os.homedir(), '.claude', 'sidequest');
}

function projectsRoot() {
  return path.join(homeRoot(), 'projects');
}

function serverFile() {
  return path.join(homeRoot(), 'server.json');
}

// Windows paths are case-insensitive; normalize case for a stable hash so the
// same folder always maps to the same slug regardless of how it was typed.
function normalizeForHash(absPath?: any) {
  const p = path.resolve(absPath);
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

function slugify(absPath?: any) {
  const base = path
    .basename(path.resolve(absPath))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'project';
  const hash = crypto.createHash('sha1').update(normalizeForHash(absPath)).digest('hex').slice(0, 8);
  return `${base}-${hash}`;
}

// A git worktree's `.git` is a FILE, not a directory:
//     gitdir: C:/dev/repo/.git/worktrees/<name>
// Given that file, resolve the MAIN worktree root that owns it (C:\dev\repo)
// so a worktree never mints its own board. Returns null when this isn't a
// linked worktree we can trust locally, and the caller keeps today's behavior:
//   - the entry is a `.git` DIRECTORY (a real clone root) — not our job
//   - the gitdir points at `.../modules/...` (a submodule — a separate repo)
//   - the gitdir is missing/malformed, or points off THIS machine (a remote
//     clone, a container mount, another OS) so the computed root isn't real here
// Fail-soft throughout: any error returns null.
function mainWorktreeRoot(gitEntry?: any) {
  let stat: any;
  try {
    stat = fs.statSync(gitEntry);
  } catch (_: any) {
    return null;
  }
  if (!stat.isFile()) return null; // a `.git` dir is a real repo root, leave it
  let content: any;
  try {
    content = fs.readFileSync(gitEntry, 'utf8');
  } catch (_: any) {
    return null;
  }
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(content);
  if (!m) return null;
  // gitdir is normally absolute; resolve relative forms against the worktree dir.
  let gitdir = m[1]!.replace(/[/\\]+$/, '');
  if (!path.isAbsolute(gitdir)) gitdir = path.resolve(path.dirname(gitEntry), gitdir);
  // Only linked worktrees (.git/worktrees/<name>) fold home. Submodules
  // (.git/modules/<name>) and anything else stay their own board.
  const parts = gitdir.split(/[/\\]+/);
  const wtIdx = parts.lastIndexOf('worktrees');
  if (wtIdx < 1) return null;
  // parts[0..wtIdx) is `.../.git`; the main worktree root is one level above it.
  const gitDirPath = parts.slice(0, wtIdx).join(path.sep);
  const root = path.dirname(gitDirPath);
  // Trust it only if that root actually exists on THIS filesystem — otherwise
  // the worktree points at a repo that isn't here, and we must not anchor a
  // board onto a phantom path.
  try {
    if (fs.statSync(root).isDirectory()) return path.resolve(root);
  } catch (_: any) { /* off-machine / moved — fall through to null */ }
  return null;
}

// Resolve startDir to the root of the project the agent is actually working in,
// so a board is always anchored there — never on a worktree, and never on a bare
// subfolder. Precedence, safest-first:
//
//   1. A path inside `<root>\.claude\worktrees\<name>` (the EnterWorktree
//      convention) folds straight back to <root>. Pure string match, no fs
//      trust: the worktree checkout may carry its OWN committed `.claude`, which
//      must NOT win — keying on the outermost `.claude/worktrees` guarantees the
//      real project root regardless.
//   2. Walk up to the nearest `.git`. A `.git` FILE is a linked worktree — fold
//      it to its main worktree root (works wherever the worktree sits on disk,
//      even far from the repo, because the file points home). A `.git` DIRECTORY
//      is a real clone root and wins, so a genuine nested/vendored repo keeps its
//      own board just like before.
//   3. A worktree we can't resolve locally (gitdir missing, off-machine, a
//      submodule) or a plain non-repo folder is returned unchanged — a
//      self-contained board on the dir you're actually in. Today's behavior.
//
// Fail-soft: any fs error stops the walk and falls back to the resolved startDir.
function nearestRepoRoot(startDir?: any) {
  const start = path.resolve(startDir);
  const enterWorktreeMarker = `${path.sep}.claude${path.sep}worktrees${path.sep}`;
  const enterWorktreeIndex = start.indexOf(enterWorktreeMarker);
  if (enterWorktreeIndex >= 0) return start.slice(0, enterWorktreeIndex);
  let dir = start;
  for (;;) {
    try {
      const entry = path.join(dir, '.git');
      if (fs.existsSync(entry)) {
        return mainWorktreeRoot(entry) || dir;
      }
    } catch (_: any) {
      return start;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return start; // hit the filesystem root without a repo
    dir = parent;
  }
}

function projectDir(slug?: any) {
  return path.join(projectsRoot(), slug);
}
function ticketsDir(slug?: any) {
  return path.join(projectDir(slug), 'tickets');
}
function assetsDir(slug?: any, id?: any) {
  return path.join(projectDir(slug), 'assets', id);
}


  return { homeRoot, projectsRoot, serverFile, normalizeForHash, slugify, mainWorktreeRoot, nearestRepoRoot, projectDir, ticketsDir, assetsDir };
}

module.exports = { createPaths };
