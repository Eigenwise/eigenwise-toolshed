'use strict';

function createProjects({ acquireLock, assetsDir, cloneCached, database, db, defaultAlwaysInScope, defaultProjectName, deleteCachedRow, ensureDir, fs, invalidateStoreCaches, listStories, listTickets, normalizeForHash, path, projectDir, putProject, putStory, putTicket, releaseLock, residentCache, slugify, ticketsDir, transaction }: any) {
  function ensureProject(absPath?: any, name?: any) {
    // Register under the canonical spelling so a later lookup through a different name
    // for the same directory finds it — git reports the canonical path while a caller
    // may hold an 8.3 alias. An existing registration under the caller's own spelling
    // wins, so boards registered before this keep their slug instead of duplicating.
    const supplied = path.resolve(absPath);
    let canonical = supplied;
    try { canonical = fs.realpathSync.native(supplied); } catch (_) { /* may not exist yet */ }
    const resolved = canonical !== supplied && readMeta(slugify(supplied)) ? supplied : canonical;
    const slug = slugify(resolved);
    const dir = projectDir(slug);
    ensureDir(ticketsDir(slug));
    let meta: any;
    let changed = false;
    transaction(() => {
      const handle = database();
      meta = db.getRow(handle, 'projects', slug);
      if (!meta || typeof meta !== 'object') {
        meta = {
          path: resolved,
          name: name || defaultProjectName(resolved),
          createdAt: new Date().toISOString(),
          seq: 0,
          storySeq: 0,
          alwaysInScope: defaultAlwaysInScope(resolved),
          worktreeIsolation: true,
        };
        db.putRow(handle, 'projects', { slug, data: meta });
        changed = true;
      } else {
        if (meta.path !== resolved) { meta.path = resolved; changed = true; }
        if (name && meta.name !== name) { meta.name = name; changed = true; }
        if (!meta.name) { meta.name = defaultProjectName(resolved); changed = true; }
        if (typeof meta.seq !== 'number') { meta.seq = 0; changed = true; }
        if (typeof meta.storySeq !== 'number') { meta.storySeq = 0; changed = true; }
        if (changed) db.putRow(handle, 'projects', { slug, data: meta });
      }
      const pointer = handle.prepare('SELECT project FROM project_routing_profiles WHERE project = ?').get(slug);
      if (!pointer) {
        const settings = handle.prepare('SELECT new_project_profile_id FROM routing_profile_settings WHERE singleton = 1').get();
        if (!settings?.new_project_profile_id) throw new Error('The new-board routing profile is not configured.');
        db.putRow(handle, 'project_routing_profiles', {
          project: slug,
          profile_id: settings.new_project_profile_id,
          assigned_at: new Date().toISOString(),
          assigned_by: 'ensure-project',
        });
        changed = true;
      }
    });
    if (changed) invalidateStoreCaches();
    return { slug, dir, meta };
  }

  function readMeta(slug?: any) {
    const key = String(slug || '');
    const cache = residentCache();
    if (cache.metadata.has(key)) return cloneCached(cache.metadata.get(key));
    const meta = db.getRow(database(), 'projects', key);
    cache.metadata.set(key, meta);
    return cloneCached(meta);
  }

  function metaLockPath(slug?: any) {
    return path.join(projectDir(slug), '.meta.lock');
  }

  function withMetaLock(slug?: any, fn?: any) {
    const lock = metaLockPath(slug);
    const locked = acquireLock(lock);
    try {
      return transaction(fn);
    } finally {
      if (locked) releaseLock(lock);
    }
  }

  function nextSeq(slug?: any) {
    return withMetaLock(slug, () => {
      const meta = readMeta(slug) || { seq: 0 };
      meta.seq = (typeof meta.seq === 'number' ? meta.seq : 0) + 1;
      putProject(slug, meta);
      return meta.seq;
    });
  }

  function nextStorySeq(slug?: any) {
    return withMetaLock(slug, () => {
      const meta = readMeta(slug) || { storySeq: 0 };
      meta.storySeq = (typeof meta.storySeq === 'number' ? meta.storySeq : 0) + 1;
      putProject(slug, meta);
      return meta.storySeq;
    });
  }

  function setProjectNotify(slug?: any, on?: any) {
    return withMetaLock(slug, () => {
      const meta = readMeta(slug);
      if (!meta) return { ok: false, reason: 'not_found' };
      meta.notify = on !== false;
      putProject(slug, meta);
      return { ok: true, notify: meta.notify };
    });
  }

  function setProjectRouting(slug?: any, routing?: any) {
    if (!['enabled', 'disabled'].includes(routing)) throw new Error('Routing must be enabled or disabled.');
    return withMetaLock(slug, () => {
      const meta = readMeta(slug);
      if (!meta) return { ok: false, reason: 'not_found' };
      meta.routing = routing;
      putProject(slug, meta);
      return { ok: true, routing: meta.routing };
    });
  }

  function projectRoutingEnabled(slug?: any) {
    const meta = readMeta(slug);
    return !meta || meta.routing !== 'disabled';
  }

  function archiveProject(slug?: any) {
    return withMetaLock(slug, () => {
      const meta = readMeta(slug);
      if (!meta) return { ok: false, reason: 'not_found' };
      if (meta.archivedAt) return { ok: true, slug, archivedAt: meta.archivedAt, alreadyArchived: true };
      meta.archivedAt = new Date().toISOString();
      putProject(slug, meta);
      return { ok: true, slug, archivedAt: meta.archivedAt, alreadyArchived: false };
    });
  }

  function unarchiveProject(slug?: any) {
    return withMetaLock(slug, () => {
      const meta = readMeta(slug);
      if (!meta) return { ok: false, reason: 'not_found' };
      if (!meta.archivedAt) return { ok: true, slug, wasArchived: false };
      delete meta.archivedAt;
      putProject(slug, meta);
      return { ok: true, slug, wasArchived: true };
    });
  }

  function deleteProjectExact(slug?: any) {
    if (typeof slug !== 'string' || !/^[a-z0-9][a-z0-9-]{1,80}$/.test(slug)) return { ok: false, reason: 'not_found' };
    if (!readMeta(slug)) return { ok: false, reason: 'not_found' };
    transaction(() => {
      for (const ticket of db.listRows(database(), 'tickets', { project: slug })) deleteCachedRow(database(), 'tickets', ticket.id);
      for (const story of db.listRows(database(), 'stories', { project: slug })) deleteCachedRow(database(), 'stories', story.id);
      deleteCachedRow(database(), 'projects', slug);
    });
    fs.rmSync(projectDir(slug), { recursive: true, force: true });
    return { ok: true, slug };
  }

  function listProjects(opts?: any) {
    opts = opts || {};
    const cache = residentCache();
    const cacheKey = `projects:${opts.all ? 'all' : opts.archived ? 'archived' : 'active'}`;
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

    const out: any[] = [];
    for (const row of rows) {
      let meta: any;
      try { meta = JSON.parse(row.data); } catch (_: any) { continue; }
      if (!meta || !meta.path) continue;
      const archivedAt = meta.archivedAt || null;
      if (!opts.all && (opts.archived ? !archivedAt : !!archivedAt)) continue;
      const counts = { todo: Number(row.todo) || 0, doing: Number(row.doing) || 0, done: Number(row.done) || 0 };
      out.push({
        slug: slugify(meta.path),
        name: meta.name || row.slug,
        path: meta.path || '',
        counts,
        total: Number(row.active) || 0,
        archived: Number(row.archived) || 0,
        open: counts.todo + counts.doing,
        lastActivity: row.last_activity || meta.createdAt || null,
        notify: meta.notify !== false,
        routing: meta.routing === 'disabled' ? 'disabled' : 'enabled',
        stories: Number(row.stories) || 0,
        archivedAt,
      });
    }
    out.sort((a?: any, b?: any) => String(b.lastActivity || '').localeCompare(String(a.lastActivity || '')));
    cache.snapshots.set(cacheKey, out);
    return cloneCached(out);
  }

  function findProject(ref?: any) {
    const arg = String(ref == null ? '' : ref).trim();
    if (!arg) return { ok: false, reason: 'not_found', known: listProjects({ all: true }).map((project?: any) => project.name) };

    if (path.isAbsolute(arg)) {
      // The slug is derived from the path's spelling, so a project registered under one
      // spelling is invisible to a caller holding another name for the same directory —
      // an 8.3 alias, or a junction. Try the canonical spelling as well before giving up.
      const resolvedPath = path.resolve(arg);
      let canonicalPath = resolvedPath;
      try { canonicalPath = fs.realpathSync.native(resolvedPath); } catch (_) { /* may not exist yet */ }
      for (const candidate of canonicalPath === resolvedPath ? [resolvedPath] : [resolvedPath, canonicalPath]) {
        const slug = slugify(candidate);
        const meta = readMeta(slug);
        if (meta && normalizeForHash(meta.path) === normalizeForHash(candidate)) return { ok: true, slug, meta };
      }
    } else {
      const meta = readMeta(arg);
      if (meta) return { ok: true, slug: arg, meta };
    }

    const projects = db.selectRows(database(), 'SELECT slug, data FROM projects ORDER BY slug')
      .map((row?: any) => {
        try { return { slug: row.slug, meta: JSON.parse(row.data) }; } catch (_: any) { return null; }
      })
      .filter(Boolean);

    const wantedName = arg.toLowerCase();
    const byName = projects.filter((project?: any) => String(project.meta.name || project.slug).trim().toLowerCase() === wantedName);
    if (byName.length === 1) return { ok: true, slug: byName[0].slug, meta: byName[0].meta };
    if (byName.length > 1) {
      return {
        ok: false,
        reason: 'ambiguous',
        matches: byName.map((project?: any) => ({ slug: project.slug, name: project.meta.name || project.slug, path: project.meta.path || '' })),
      };
    }

    if (!path.isAbsolute(arg)) {
      const wantedPath = normalizeForHash(path.resolve(arg));
      const byPath = projects.find((project?: any) => project.meta.path && normalizeForHash(path.resolve(project.meta.path)) === wantedPath);
      if (byPath) return { ok: true, slug: byPath.slug, meta: byPath.meta };
    }

    return { ok: false, reason: 'not_found', known: projects.map((project?: any) => project.meta.name || project.slug) };
  }

  function seqOfRef(ref?: any) {
    const m = /(\d+)\s*$/.exec(String(ref || ''));
    return m ? parseInt(m[1]!, 10) : Number.MAX_SAFE_INTEGER;
  }

  function mergeProject(srcSlug?: any, destSlug?: any, opts?: any) {
    opts = opts || {};
    const dryRun = !!opts.dryRun;
    if (srcSlug === destSlug) throw new Error('source and destination are the same board');
    if (!readMeta(srcSlug)) throw new Error(`source board "${srcSlug}" does not exist`);
    if (!readMeta(destSlug)) throw new Error(`destination board "${destSlug}" does not exist`);

    const tickets = listTickets(srcSlug).slice().sort((a?: any, b?: any) => seqOfRef(a.ref) - seqOfRef(b.ref));
    const stories = listStories(srcSlug);
    const refMap: Record<string, any> = {};
    const ticketPlan: any[] = [];
    for (const ticket of tickets) {
      const newRef = dryRun ? `SQ-?` : `SQ-${nextSeq(destSlug)}`;
      if (ticket.ref) refMap[String(ticket.ref).toUpperCase()] = newRef;
      ticketPlan.push({ ticket, newRef });
    }
    const storyPlan: any[] = [];
    for (const story of stories) {
      const newRef = dryRun ? `US-?` : `US-${nextStorySeq(destSlug)}`;
      storyPlan.push({ story, newRef });
    }

    const mapping = ticketPlan.map(({ ticket, newRef }: any) => ({ from: ticket.ref, to: newRef, title: ticket.title }));
    if (dryRun) return { tickets: ticketPlan.length, stories: storyPlan.length, mapping };

    transaction(() => {
      for (const ticket of tickets) deleteCachedRow(database(), 'tickets', ticket.id);
      for (const story of stories) deleteCachedRow(database(), 'stories', story.id);
      for (const { story, newRef } of storyPlan) putStory(destSlug, Object.assign({}, story, { ref: newRef }));
      for (const { ticket, newRef } of ticketPlan) {
        const links = Array.isArray(ticket.links)
          ? ticket.links.map((l?: any) => Object.assign({}, l, { ref: refMap[String(l.ref).toUpperCase()] || l.ref }))
          : [];
        const moved = Object.assign({}, ticket, { ref: newRef, links });
        putTicket(destSlug, moved);
        const srcAssets = assetsDir(srcSlug, ticket.id);
        if (!fs.existsSync(srcAssets)) continue;
        try {
          fs.cpSync(srcAssets, assetsDir(destSlug, ticket.id), { recursive: true });
        } catch (_: any) {
          // An unreadable asset folder should not abort the whole merge.
        }
      }
      deleteCachedRow(database(), 'projects', srcSlug);
    });

    try {
      fs.rmSync(projectDir(srcSlug), { recursive: true, force: true });
    } catch (_: any) {
      // The tickets already live in dest.
    }
    return { tickets: ticketPlan.length, stories: storyPlan.length, mapping };
  }

  return { archiveProject, deleteProjectExact, ensureProject, findProject, listProjects, mergeProject, metaLockPath, nextSeq, nextStorySeq, projectRoutingEnabled, readMeta, setProjectNotify, setProjectRouting, unarchiveProject, withMetaLock };
}

module.exports = { createProjects };
