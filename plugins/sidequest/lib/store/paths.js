"use strict";
function createPaths({ fs, os, path, crypto }) {
  function homeRoot() {
    const env = process.env.SIDEQUEST_HOME;
    if (env && String(env).trim()) return path.resolve(String(env).trim());
    return path.join(os.homedir(), ".claude", "sidequest");
  }
  function projectsRoot() {
    return path.join(homeRoot(), "projects");
  }
  function serverFile() {
    return path.join(homeRoot(), "server.json");
  }
  function normalizeForHash(absPath) {
    const p = path.resolve(absPath);
    return process.platform === "win32" ? p.toLowerCase() : p;
  }
  function slugify(absPath) {
    const base = path.basename(path.resolve(absPath)).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "project";
    const hash = crypto.createHash("sha1").update(normalizeForHash(absPath)).digest("hex").slice(0, 8);
    return `${base}-${hash}`;
  }
  function mainWorktreeRoot(gitEntry) {
    let stat;
    try {
      stat = fs.statSync(gitEntry);
    } catch (_) {
      return null;
    }
    if (!stat.isFile()) return null;
    let content;
    try {
      content = fs.readFileSync(gitEntry, "utf8");
    } catch (_) {
      return null;
    }
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(content);
    if (!m) return null;
    let gitdir = m[1].replace(/[/\\]+$/, "");
    if (!path.isAbsolute(gitdir)) gitdir = path.resolve(path.dirname(gitEntry), gitdir);
    const parts = gitdir.split(/[/\\]+/);
    const wtIdx = parts.lastIndexOf("worktrees");
    if (wtIdx < 1) return null;
    const gitDirPath = parts.slice(0, wtIdx).join(path.sep);
    const root = path.dirname(gitDirPath);
    try {
      if (fs.statSync(root).isDirectory()) return path.resolve(root);
    } catch (_) {
    }
    return null;
  }
  function nearestRepoRoot(startDir) {
    const start = path.resolve(startDir);
    let dir = start;
    for (; ; ) {
      try {
        const entry = path.join(dir, ".git");
        if (fs.existsSync(entry)) {
          return mainWorktreeRoot(entry) || dir;
        }
      } catch (_) {
        return start;
      }
      const parent = path.dirname(dir);
      if (parent === dir) return start;
      dir = parent;
    }
  }
  function projectDir(slug) {
    return path.join(projectsRoot(), slug);
  }
  function ticketsDir(slug) {
    return path.join(projectDir(slug), "tickets");
  }
  function assetsDir(slug, id) {
    return path.join(projectDir(slug), "assets", id);
  }
  return { homeRoot, projectsRoot, serverFile, normalizeForHash, slugify, mainWorktreeRoot, nearestRepoRoot, projectDir, ticketsDir, assetsDir };
}
module.exports = { createPaths };
