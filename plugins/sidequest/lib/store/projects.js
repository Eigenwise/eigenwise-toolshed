"use strict";
function createProjects({ assetsDir, claudeHome, homeRoot, os, claimReclaimable, cloneCached, database, db, defaultAlwaysInScope, defaultProjectName, deleteCachedRow, ensureDir, fs, invalidateStoreCaches, listStories, listTickets, normalizeForHash, path, projectDir, putProject, putStory, putTicket, residentCache, slugify, sourceRevisionAdapterForPath, ticketsDir, transaction }) {
  function canonicalize(absPath) {
    const resolved = path.resolve(absPath);
    try {
      return fs.realpathSync.native(resolved);
    } catch (_) {
      return resolved;
    }
  }
  function adoptDerivedSourceRevisionAdapter(meta, derived) {
    if (meta.sourceRevisionAdapter === "git" || meta.sourceRevisionAdapter === derived) return false;
    if (meta.sourceRevisionAdapter === "filesystem-snapshot") {
      meta.sourceRevisionAdapterSwitch = { from: "filesystem-snapshot", to: derived, at: (/* @__PURE__ */ new Date()).toISOString() };
    }
    meta.sourceRevisionAdapter = derived;
    return true;
  }
  function takeSourceRevisionAdapterSwitch(slug) {
    return withMetaLock(slug, () => {
      const meta = readMeta(slug);
      if (!meta) return null;
      adoptDerivedSourceRevisionAdapter(meta, sourceRevisionAdapterForPath(meta.path));
      const adapterSwitch = meta.sourceRevisionAdapterSwitch;
      if (!adapterSwitch) return null;
      delete meta.sourceRevisionAdapterSwitch;
      putProject(slug, meta);
      return adapterSwitch;
    });
  }
  function ensureProject(absPath, name) {
    const resolved = path.resolve(absPath);
    const slug = slugify(resolved);
    const sourceRevisionAdapter = sourceRevisionAdapterForPath(resolved);
    const dir = projectDir(slug);
    ensureDir(ticketsDir(slug));
    let meta;
    let changed = false;
    transaction(() => {
      const handle = database();
      meta = db.getRow(handle, "projects", slug);
      if (!meta || typeof meta !== "object") {
        meta = {
          path: resolved,
          name: name || defaultProjectName(resolved),
          createdAt: (/* @__PURE__ */ new Date()).toISOString(),
          seq: 0,
          storySeq: 0,
          alwaysInScope: defaultAlwaysInScope(resolved),
          sourceRevisionAdapter,
          worktreeIsolation: true
        };
        db.putRow(handle, "projects", { slug, data: meta });
        changed = true;
      } else {
        if (meta.path !== resolved) {
          meta.path = resolved;
          changed = true;
        }
        if (name && meta.name !== name) {
          meta.name = name;
          changed = true;
        }
        if (!meta.name) {
          meta.name = defaultProjectName(resolved);
          changed = true;
        }
        if (adoptDerivedSourceRevisionAdapter(meta, sourceRevisionAdapter)) changed = true;
        if (typeof meta.seq !== "number") {
          meta.seq = 0;
          changed = true;
        }
        if (typeof meta.storySeq !== "number") {
          meta.storySeq = 0;
          changed = true;
        }
        if (changed) db.putRow(handle, "projects", { slug, data: meta });
      }
      const pointer = handle.prepare("SELECT project FROM project_routing_profiles WHERE project = ?").get(slug);
      if (!pointer) {
        const settings = handle.prepare("SELECT new_project_profile_id FROM routing_profile_settings WHERE singleton = 1").get();
        if (!settings?.new_project_profile_id) throw new Error("The new-board routing profile is not configured.");
        db.putRow(handle, "project_routing_profiles", {
          project: slug,
          profile_id: settings.new_project_profile_id,
          assigned_at: (/* @__PURE__ */ new Date()).toISOString(),
          assigned_by: "ensure-project"
        });
        changed = true;
      }
    });
    if (changed) invalidateStoreCaches();
    return { slug, dir, meta };
  }
  function isInside(canonicalChild, root) {
    const relative = path.relative(canonicalize(root), canonicalChild);
    return !relative.startsWith("..") && !path.isAbsolute(relative);
  }
  function isDirectory(absPath) {
    try {
      return fs.statSync(absPath).isDirectory();
    } catch (_) {
      return false;
    }
  }
  function reservedLocation(canonicalPath) {
    if (isInside(canonicalPath, homeRoot())) return `inside the Sidequest home (${homeRoot()})`;
    if (isInside(canonicalPath, claudeHome())) return `inside the Claude config directory (${claudeHome()})`;
    return null;
  }
  function throwawayStore() {
    return isInside(canonicalize(homeRoot()), os.tmpdir());
  }
  function tempOrNonRepositoryRefusal(canonicalPath, implicit) {
    if (isInside(canonicalPath, os.tmpdir())) return throwawayStore() ? null : `inside the system temp directory (${os.tmpdir()})`;
    return implicit ? nonRepositoryRefusal(canonicalPath) : null;
  }
  function nonRepositoryRefusal(canonicalPath) {
    if (fs.existsSync(path.join(canonicalPath, ".git"))) return null;
    return "not a git repository root and was never registered as a board; register it by passing its absolute path as the project if it really is one";
  }
  function projectRootRefusal(resolved, implicit) {
    if (!isDirectory(resolved)) return `not a project root: ${resolved} is not an existing directory.`;
    const canonicalPath = canonicalize(resolved);
    const reason = reservedLocation(canonicalPath) || tempOrNonRepositoryRefusal(canonicalPath, implicit);
    return reason && `not a project root: ${resolved} is ${reason}.`;
  }
  function boardRootRefusal(absPath, options = {}) {
    const resolved = path.resolve(absPath);
    return readMeta(slugify(resolved)) ? null : projectRootRefusal(resolved, Boolean(options.implicit));
  }
  function registerProject(absPath, name, options = {}) {
    const refusal = boardRootRefusal(absPath, options);
    if (refusal) return { ok: false, reason: refusal };
    return { ok: true, ...ensureProject(path.resolve(absPath), name) };
  }
  function flagMissingPath(project) {
    return isDirectory(project.path) ? project : { ...project, missingPath: true };
  }
  function listProjectsFlaggingMissingPaths(opts) {
    return listProjects(opts).map(flagMissingPath);
  }
  function readMeta(slug) {
    const key = String(slug || "");
    const cache = residentCache();
    if (cache.metadata.has(key)) return cloneCached(cache.metadata.get(key));
    const meta = db.getRow(database(), "projects", key);
    cache.metadata.set(key, meta);
    return cloneCached(meta);
  }
  function withMetaLock(_slug, fn) {
    return transaction(fn);
  }
  function nextSeq(slug) {
    return withMetaLock(slug, () => {
      const meta = readMeta(slug) || { seq: 0 };
      meta.seq = (typeof meta.seq === "number" ? meta.seq : 0) + 1;
      putProject(slug, meta);
      return meta.seq;
    });
  }
  function nextStorySeq(slug) {
    return withMetaLock(slug, () => {
      const meta = readMeta(slug) || { storySeq: 0 };
      meta.storySeq = (typeof meta.storySeq === "number" ? meta.storySeq : 0) + 1;
      putProject(slug, meta);
      return meta.storySeq;
    });
  }
  function setProjectNotify(slug, on) {
    return withMetaLock(slug, () => {
      const meta = readMeta(slug);
      if (!meta) return { ok: false, reason: "not_found" };
      meta.notify = on !== false;
      putProject(slug, meta);
      return { ok: true, notify: meta.notify };
    });
  }
  function setProjectRouting(slug, routing) {
    if (!["enabled", "disabled"].includes(routing)) throw new Error("Routing must be enabled or disabled.");
    return withMetaLock(slug, () => {
      const meta = readMeta(slug);
      if (!meta) return { ok: false, reason: "not_found" };
      meta.routing = routing;
      putProject(slug, meta);
      return { ok: true, routing: meta.routing };
    });
  }
  function projectRoutingEnabled(slug) {
    const meta = readMeta(slug);
    return !meta || meta.routing !== "disabled";
  }
  function archiveProject(slug) {
    return withMetaLock(slug, () => {
      const meta = readMeta(slug);
      if (!meta) return { ok: false, reason: "not_found" };
      if (meta.archivedAt) return { ok: true, slug, archivedAt: meta.archivedAt, alreadyArchived: true };
      meta.archivedAt = (/* @__PURE__ */ new Date()).toISOString();
      putProject(slug, meta);
      return { ok: true, slug, archivedAt: meta.archivedAt, alreadyArchived: false };
    });
  }
  function unarchiveProject(slug) {
    return withMetaLock(slug, () => {
      const meta = readMeta(slug);
      if (!meta) return { ok: false, reason: "not_found" };
      if (!meta.archivedAt) return { ok: true, slug, wasArchived: false };
      delete meta.archivedAt;
      putProject(slug, meta);
      return { ok: true, slug, wasArchived: true };
    });
  }
  function deleteProjectExact(slug) {
    if (typeof slug !== "string" || !/^[a-z0-9][a-z0-9-]{1,80}$/.test(slug)) return { ok: false, reason: "not_found" };
    if (!readMeta(slug)) return { ok: false, reason: "not_found" };
    transaction(() => {
      for (const ticket of db.listRows(database(), "tickets", { project: slug })) deleteCachedRow(database(), "tickets", ticket.id);
      for (const story of db.listRows(database(), "stories", { project: slug })) deleteCachedRow(database(), "stories", story.id);
      deleteCachedRow(database(), "projects", slug);
    });
    fs.rmSync(projectDir(slug), { recursive: true, force: true });
    return { ok: true, slug };
  }
  function listProjects(opts) {
    opts = opts || {};
    const cache = residentCache();
    const cacheKey = `projects:${opts.all ? "all" : opts.archived ? "archived" : "active"}`;
    const cached = cache.snapshots.get(cacheKey);
    if (cached) return cloneCached(cached);
    const rows = db.selectRows(database(), `
      SELECT
        p.slug,
        p.data,
        COALESCE(t.todo, 0) AS todo,
        COALESCE(t.doing, 0) AS doing,
        COALESCE(t.done, 0) AS done,
        COALESCE(t.active, 0) AS active,
        COALESCE(t.archived, 0) AS archived,
        t.last_activity,
        COALESCE(s.stories, 0) AS stories
      FROM projects p
      LEFT JOIN (
        SELECT
          project,
          SUM(CASE WHEN archived = 0 AND status = 'todo' THEN 1 ELSE 0 END) AS todo,
          SUM(CASE WHEN archived = 0 AND status = 'doing' THEN 1 ELSE 0 END) AS doing,
          SUM(CASE WHEN archived = 0 AND status = 'done' THEN 1 ELSE 0 END) AS done,
          SUM(CASE WHEN archived = 0 THEN 1 ELSE 0 END) AS active,
          SUM(CASE WHEN archived != 0 THEN 1 ELSE 0 END) AS archived,
          MAX(json_extract(data, '$.updatedAt')) AS last_activity
        FROM tickets
        GROUP BY project
      ) t ON t.project = p.slug
      LEFT JOIN (
        SELECT project, COUNT(*) AS stories
        FROM stories
        GROUP BY project
      ) s ON s.project = p.slug
    `);
    const out = [];
    for (const row of rows) {
      let meta;
      try {
        meta = JSON.parse(row.data);
      } catch (_) {
        continue;
      }
      if (!meta || !meta.path) continue;
      const archivedAt = meta.archivedAt || null;
      if (!opts.all && (opts.archived ? !archivedAt : !!archivedAt)) continue;
      const counts = { todo: Number(row.todo) || 0, doing: Number(row.doing) || 0, done: Number(row.done) || 0 };
      out.push({
        slug: slugify(meta.path),
        name: meta.name || row.slug,
        path: meta.path || "",
        counts,
        total: Number(row.active) || 0,
        archived: Number(row.archived) || 0,
        open: counts.todo + counts.doing,
        lastActivity: row.last_activity || meta.createdAt || null,
        notify: meta.notify !== false,
        routing: meta.routing === "disabled" ? "disabled" : "enabled",
        stories: Number(row.stories) || 0,
        archivedAt
      });
    }
    out.sort((a, b) => String(b.lastActivity || "").localeCompare(String(a.lastActivity || "")));
    cache.snapshots.set(cacheKey, out);
    return cloneCached(out);
  }
  function findProject(ref) {
    const arg = String(ref == null ? "" : ref).trim();
    if (!arg) return { ok: false, reason: "not_found", known: listProjects({ all: true }).map((project) => project.name) };
    if (path.isAbsolute(arg)) {
      const slug = slugify(arg);
      const meta = readMeta(slug);
      if (meta && normalizeForHash(meta.path) === normalizeForHash(arg)) return { ok: true, slug, meta };
    } else {
      const meta = readMeta(arg);
      if (meta) return { ok: true, slug: arg, meta };
    }
    const projects = db.selectRows(database(), "SELECT slug, data FROM projects ORDER BY slug").map((row) => {
      try {
        return { slug: row.slug, meta: JSON.parse(row.data) };
      } catch (_) {
        return null;
      }
    }).filter(Boolean);
    const wantedName = arg.toLowerCase();
    const byName = projects.filter((project) => String(project.meta.name || project.slug).trim().toLowerCase() === wantedName);
    if (byName.length === 1) return { ok: true, slug: byName[0].slug, meta: byName[0].meta };
    if (byName.length > 1) {
      return {
        ok: false,
        reason: "ambiguous",
        matches: byName.map((project) => ({ slug: project.slug, name: project.meta.name || project.slug, path: project.meta.path || "" }))
      };
    }
    const wantedPath = normalizeForHash(canonicalize(arg));
    const byPath = projects.find((project) => project.meta.path && normalizeForHash(canonicalize(project.meta.path)) === wantedPath);
    if (byPath) return { ok: true, slug: byPath.slug, meta: byPath.meta };
    return { ok: false, reason: "not_found", known: projects.map((project) => project.meta.name || project.slug) };
  }
  function seqOfRef(ref) {
    const m = /(\d+)\s*$/.exec(String(ref || ""));
    return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
  }
  function mergeProject(srcSlug, destSlug, opts) {
    opts = opts || {};
    const dryRun = !!opts.dryRun;
    if (srcSlug === destSlug) throw new Error("source and destination are the same board");
    if (!readMeta(srcSlug)) throw new Error(`source board "${srcSlug}" does not exist`);
    if (!readMeta(destSlug)) throw new Error(`destination board "${destSlug}" does not exist`);
    const tickets = listTickets(srcSlug).slice().sort((a, b) => seqOfRef(a.ref) - seqOfRef(b.ref));
    const liveClaimed = tickets.filter((ticket) => ticket.claim && ticket.claim.by && !claimReclaimable(ticket));
    if (liveClaimed.length) {
      const refs = liveClaimed.map((ticket) => `${ticket.ref} (held by "${ticket.claim.by}")`).join(", ");
      throw new Error(`refusing to merge board "${srcSlug}": ${liveClaimed.length} live-claimed ticket(s): ${refs}. Release the claims first; merge cannot move a ticket its executor is still working under.`);
    }
    const stories = listStories(srcSlug);
    const refMap = {};
    const ticketPlan = [];
    for (const ticket of tickets) {
      const newRef = dryRun ? `SQ-?` : `SQ-${nextSeq(destSlug)}`;
      if (ticket.ref) refMap[String(ticket.ref).toUpperCase()] = newRef;
      ticketPlan.push({ ticket, newRef });
    }
    const storyPlan = [];
    for (const story of stories) {
      const newRef = dryRun ? `US-?` : `US-${nextStorySeq(destSlug)}`;
      storyPlan.push({ story, newRef });
    }
    const mapping = ticketPlan.map(({ ticket, newRef }) => ({ from: ticket.ref, to: newRef, title: ticket.title }));
    if (dryRun) return { tickets: ticketPlan.length, stories: storyPlan.length, mapping };
    transaction(() => {
      for (const ticket of tickets) deleteCachedRow(database(), "tickets", ticket.id);
      for (const story of stories) deleteCachedRow(database(), "stories", story.id);
      for (const { story, newRef } of storyPlan) putStory(destSlug, Object.assign({}, story, { ref: newRef }));
      for (const { ticket, newRef } of ticketPlan) {
        const links = Array.isArray(ticket.links) ? ticket.links.map((l) => Object.assign({}, l, { ref: refMap[String(l.ref).toUpperCase()] || l.ref })) : [];
        const moved = Object.assign({}, ticket, { ref: newRef, links });
        putTicket(destSlug, moved);
        const srcAssets = assetsDir(srcSlug, ticket.id);
        if (!fs.existsSync(srcAssets)) continue;
        try {
          fs.cpSync(srcAssets, assetsDir(destSlug, ticket.id), { recursive: true });
        } catch (_) {
        }
      }
      deleteCachedRow(database(), "projects", srcSlug);
    });
    try {
      fs.rmSync(projectDir(srcSlug), { recursive: true, force: true });
    } catch (_) {
    }
    return { tickets: ticketPlan.length, stories: storyPlan.length, mapping };
  }
  return { archiveProject, boardRootRefusal, deleteProjectExact, ensureProject, findProject, listProjects, listProjectsFlaggingMissingPaths, mergeProject, nextSeq, nextStorySeq, projectRoutingEnabled, readMeta, registerProject, setProjectNotify, setProjectRouting, takeSourceRevisionAdapterSwitch, unarchiveProject, withMetaLock };
}
module.exports = { createProjects };
