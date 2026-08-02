"use strict";
function createTickets(dependencies) {
  const {
    acquireLock,
    assetPath,
    assetsDir,
    coercePriority,
    copyAsset,
    createComment,
    database,
    deleteCachedRow,
    fs,
    getTicket,
    listTickets,
    newTicketId,
    nextSeq,
    path,
    putTicket,
    queryTickets,
    queueEventNotification,
    releaseLock,
    requireStatus,
    saveAssetData,
    stripLinksTo,
    ticketLockPath,
    ticketStoryId,
    upperRef,
    withTicketLock
  } = dependencies;
  const coerceStoryId = ticketStoryId;
  function createTicket(slug, fields) {
    fields = fields || {};
    const status = fields.status === void 0 ? "todo" : requireStatus(fields.status);
    const id = newTicketId();
    const seq = nextSeq(slug);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const assets = [];
    const imgs = Array.isArray(fields.images) ? fields.images : [];
    for (const src of imgs) {
      try {
        assets.push(copyAsset(slug, id, src));
      } catch (e) {
        if (fields.onAssetError) fields.onAssetError(src, e);
      }
    }
    for (const d of asDataImages(fields.imagesData)) {
      try {
        assets.push(saveAssetData(slug, id, d.name, d.buffer));
      } catch (_) {
      }
    }
    const ticket = {
      id,
      ref: `SQ-${seq}`,
      title: String(fields.title || "Untitled").trim().slice(0, 300) || "Untitled",
      description: String(fields.description || "").trim(),
      status,
      priority: coercePriority(fields.priority, "normal"),
      labels: boundedLabels(fields.labels),
      highStakes: !!fields.highStakes,
      storyId: coerceStoryId(slug, fields.storyId),
      // the user story this ticket belongs to (null = none)
      category: fields.category == null ? null : String(fields.category).trim().toLowerCase() || null,
      files: boundedFiles(fields.files),
      // declared file scope, for parallel-wave planning
      assets,
      comments: [],
      // [{ id, by, body, kind: 'comment', at }]
      links: [],
      // [{ type: 'blocks'|'blocked-by'|'related', ref }]
      claim: null,
      // { by, at } when an agent has claimed it to work on
      checkpoint: null,
      dispatchNonce: null,
      dispatchExecutor: null,
      directClaim: null,
      assignee: normalizeAssignee(fields.assignee),
      // who it's assigned to (usually the human "you"); distinct from an agent claim
      archived: false,
      // hidden from the board (kept, restorable) once true
      archivedAt: null,
      source: String(fields.source || "manual"),
      // Who/what last touched this ticket, and how. The dashboard uses these to
      // decide whether a change was made by the user (source "dashboard") or by
      // Claude/the CLI in the background, and whether it was a status change.
      lastEventType: "created",
      lastEventSource: String(fields.source || "manual"),
      createdAt: now,
      updatedAt: now,
      referenceUpdatedAt: now,
      order: Date.now()
    };
    putTicket(slug, ticket);
    queueEventNotification(slug, ticket, "created", ticket.lastEventSource);
    return ticket;
  }
  function asDataImages(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const d of list) {
      if (!d || typeof d.base64 !== "string") continue;
      const b64 = d.base64.replace(/^data:[^;]+;base64,/, "");
      try {
        const buffer = Buffer.from(b64, "base64");
        if (buffer.length) out.push({ name: d.name, buffer });
      } catch (_) {
      }
    }
    return out;
  }
  function normalizeLabels(labels) {
    if (!labels) return [];
    const arr = Array.isArray(labels) ? labels : String(labels).split(",");
    const seen = /* @__PURE__ */ new Set();
    const out = [];
    for (const l of arr) {
      const v = String(l).trim().slice(0, 40);
      if (v && !seen.has(v.toLowerCase())) {
        seen.add(v.toLowerCase());
        out.push(v);
      }
    }
    return out;
  }
  function normalizeFiles(files) {
    if (!files) return [];
    const arr = Array.isArray(files) ? files : String(files).split(",");
    const seen = /* @__PURE__ */ new Set();
    const out = [];
    for (const f of arr) {
      const v = String(f).trim().replace(/\\/g, "/").replace(/\/+$/, "").slice(0, 200);
      if (v && !seen.has(v.toLowerCase())) {
        seen.add(v.toLowerCase());
        out.push(v);
      }
    }
    return out;
  }
  const DECLARED_FILES_MAX = 100;
  const CONTRACT_NAMES_MAX = 40;
  const LABELS_MAX = 24;
  function boundedList(values, max, label, guidance) {
    if (values.length > max) {
      throw new Error(`${label} accepts at most ${max} entries; this write declared ${values.length} (${values.length - max} over). ${guidance}`);
    }
    return values;
  }
  function boundedFiles(files) {
    return boundedList(
      normalizeFiles(files),
      DECLARED_FILES_MAX,
      "declared file scope",
      "Re-scope with directory entries: a declared directory covers every path under it (e.g. plugins/sidequest/test instead of each test file)."
    );
  }
  function boundedLabels(labels) {
    return boundedList(normalizeLabels(labels), LABELS_MAX, "labels", "Labels route and filter work; drop the ones that do neither.");
  }
  const CONTRACT_EDGE_KINDS = ["produces", "changes", "consumes"];
  function normalizeAssignee(v) {
    if (v == null) return null;
    const s = String(v).trim().slice(0, 60);
    return s || null;
  }
  function sameFiles(left, right) {
    const normalizedLeft = normalizeFiles(left);
    const normalizedRight = normalizeFiles(right);
    const rightFiles = new Set(normalizedRight.map((file) => file.toLowerCase()));
    return normalizedLeft.length === normalizedRight.length && normalizedLeft.every((file) => rightFiles.has(file.toLowerCase()));
  }
  function updateTicket(slug, idOrRef, patch) {
    const found = getTicket(slug, idOrRef);
    if (!found) return null;
    patch = patch || {};
    const apply = (t) => {
      const nextStatus = patch.status == null ? null : requireStatus(patch.status);
      const prevStatus = t.status;
      if (patch.title != null) t.title = String(patch.title).trim().slice(0, 300) || t.title;
      if (patch.description != null) t.description = String(patch.description).trim();
      if (patch.status != null) t.status = nextStatus;
      if (patch.priority != null) t.priority = coercePriority(patch.priority, t.priority);
      if (patch.labels != null) t.labels = boundedLabels(patch.labels);
      if (patch.highStakes !== void 0) t.highStakes = !!patch.highStakes;
      if (patch.storyId !== void 0) t.storyId = coerceStoryId(slug, patch.storyId);
      if (patch.category !== void 0) t.category = patch.category == null ? null : String(patch.category).trim().toLowerCase() || null;
      if (patch.files !== void 0) t.files = boundedFiles(patch.files);
      if (patch.assignee !== void 0) t.assignee = normalizeAssignee(patch.assignee);
      if (patch.order != null && Number.isFinite(Number(patch.order))) t.order = Number(patch.order);
      const imgs = Array.isArray(patch.images) ? patch.images : [];
      for (const src of imgs) {
        try {
          t.assets.push(copyAsset(slug, t.id, src));
        } catch (e) {
          if (patch.onAssetError) patch.onAssetError(src, e);
        }
      }
      for (const d of asDataImages(patch.imagesData)) {
        try {
          t.assets.push(saveAssetData(slug, t.id, d.name, d.buffer));
        } catch (_) {
        }
      }
      if (Array.isArray(patch.removeAssets) && patch.removeAssets.length) {
        const drop = new Set(patch.removeAssets.map((f) => path.basename(String(f))));
        t.assets = t.assets.filter((a) => {
          if (!drop.has(a)) return true;
          try {
            fs.unlinkSync(assetPath(slug, t.id, a));
          } catch (_) {
          }
          return false;
        });
      }
      t.lastEventType = t.status !== prevStatus ? "status" : "edit";
      t.lastEventSource = patch.source ? String(patch.source) : "cli";
      const now = (/* @__PURE__ */ new Date()).toISOString();
      if (t.status !== prevStatus) t.statusTransition = { from: prevStatus, to: t.status, at: now };
      t.updatedAt = now;
      t.referenceUpdatedAt = now;
      putTicket(slug, t);
      queueEventNotification(slug, t, t.lastEventType, t.lastEventSource);
      return t;
    };
    const lock = ticketLockPath(slug, found.id);
    const locked = acquireLock(lock);
    try {
      const t = getTicket(slug, found.id);
      if (!t) return null;
      return apply(t);
    } finally {
      if (locked) releaseLock(lock);
    }
  }
  function deleteTicket(slug, idOrRef) {
    const found = getTicket(slug, idOrRef);
    if (!found) return false;
    const deletedRef = found.ref;
    const lock = ticketLockPath(slug, found.id);
    const locked = acquireLock(lock);
    let ok = false;
    try {
      ok = deleteCachedRow(database(), "tickets", found.id);
      if (ok) {
        try {
          fs.rmSync(assetsDir(slug, found.id), { recursive: true, force: true });
        } catch (_) {
        }
      }
    } finally {
      if (locked) releaseLock(lock);
    }
    if (!ok) return false;
    try {
      for (const other of listTickets(slug)) {
        if (Array.isArray(other.links) && other.links.some((l) => upperRef(l.ref) === upperRef(deletedRef))) {
          stripLinksTo(slug, other.id, deletedRef);
        }
      }
    } catch (_) {
    }
    return true;
  }
  function setArchived(slug, idOrRef, archived, opts) {
    opts = opts || {};
    const found = getTicket(slug, idOrRef);
    if (!found) return { ok: false, reason: "not_found" };
    return withTicketLock(slug, found.id, () => {
      const t = getTicket(slug, found.id);
      if (!t) return { ok: false, reason: "not_found" };
      t.archived = !!archived;
      t.archivedAt = archived ? (/* @__PURE__ */ new Date()).toISOString() : null;
      t.lastEventType = archived ? "archived" : "restored";
      t.lastEventSource = opts.source ? String(opts.source) : "cli";
      t.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
      putTicket(slug, t);
      return { ok: true, ticket: t };
    });
  }
  function archiveTicket(slug, idOrRef, opts) {
    return setArchived(slug, idOrRef, true, opts);
  }
  function unarchiveTicket(slug, idOrRef, opts) {
    return setArchived(slug, idOrRef, false, opts);
  }
  function archiveAllDone(slug, opts) {
    const refs = [];
    for (const ticket of queryTickets(String(slug || ""), { status: "done", archived: false })) {
      const result = setArchived(slug, ticket.id, true, opts);
      if (result.ok) refs.push(result.ticket.ref);
    }
    return { ok: true, archived: refs };
  }
  function listArchived(slug) {
    return queryTickets(String(slug || ""), { archived: true });
  }
  function listActive(slug) {
    return queryTickets(String(slug || ""), { archived: false });
  }
  return { DECLARED_FILES_MAX, LABELS_MAX, createTicket, normalizeLabels, normalizeFiles, normalizeAssignee, updateTicket, deleteTicket, archiveTicket, unarchiveTicket, archiveAllDone, listArchived, listActive };
}
module.exports = { createTickets };
