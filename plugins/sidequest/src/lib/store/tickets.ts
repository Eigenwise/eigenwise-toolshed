'use strict';

function createTickets(dependencies: any) {
  const {
    acquireLock, assetPath, assetsDir, coercePriority, copyAsset, createComment,
    database, deleteCachedRow, fs, getTicket, listTickets, newTicketId, nextSeq, path, putTicket,
    queryTickets, queueEventNotification, releaseLock, requireStatus, saveAssetData, stripLinksTo,
    ticketLockPath, ticketStoryId, upperRef, withTicketLock,
  } = dependencies;
  const coerceStoryId = ticketStoryId;




function createTicket(slug?: any, fields?: any) {
  fields = fields || {};
  const status = fields.status === undefined ? 'todo' : requireStatus(fields.status);
  const id = newTicketId();
  const seq = nextSeq(slug);
  const now = new Date().toISOString();

  const assets: any[] = [];
  const imgs = Array.isArray(fields.images) ? fields.images : [];
  for (const src of imgs) {
    try {
      assets.push(copyAsset(slug, id, src));
    } catch (e: any) {
      // Record which image could not be attached; the CLI surfaces this.
      if (fields.onAssetError) fields.onAssetError(src, e);
    }
  }
  for (const d of asDataImages(fields.imagesData)) {
    try {
      assets.push(saveAssetData(slug, id, d.name, d.buffer));
    } catch (_: any) {
      /* skip a bad upload */
    }
  }

  const ticket = {
    id,
    ref: `SQ-${seq}`,
    title: String(fields.title || 'Untitled').trim().slice(0, 300) || 'Untitled',
    description: String(fields.description || '').trim(),
    status,
    priority: coercePriority(fields.priority, 'normal'),
    labels: boundedLabels(fields.labels),
    highStakes: !!fields.highStakes,
    storyId: coerceStoryId(slug, fields.storyId), // the user story this ticket belongs to (null = none)
    category: fields.category == null ? null : String(fields.category).trim().toLowerCase() || null,
    files: boundedFiles(fields.files),          // declared file scope, for parallel-wave planning
    assets,
    comments: [],              // [{ id, by, body, kind: 'comment', at }]
    links: [],                 // [{ type: 'blocks'|'blocked-by'|'related', ref }]
    claim: null,               // { by, at } when an agent has claimed it to work on
    checkpoint: null,
    dispatchNonce: null,
    dispatchExecutor: null,
    directClaim: null,
    assignee: normalizeAssignee(fields.assignee), // who it's assigned to (usually the human "you"); distinct from an agent claim
    archived: false,           // hidden from the board (kept, restorable) once true
    archivedAt: null,
    source: String(fields.source || 'manual'),
    // Who/what last touched this ticket, and how. The dashboard uses these to
    // decide whether a change was made by the user (source "dashboard") or by
    // Claude/the CLI in the background, and whether it was a status change.
    lastEventType: 'created',
    lastEventSource: String(fields.source || 'manual'),
    createdAt: now,
    updatedAt: now,
    referenceUpdatedAt: now,
    order: Date.now(),
  };
  putTicket(slug, ticket);
  queueEventNotification(slug, ticket, 'created', ticket.lastEventSource);
  return ticket;
}

// Decode an optional [{ name, base64 }] list (dashboard image paste/drop) into
// [{ name, buffer }]. Data-URL prefixes are stripped. Bad entries are dropped.
function asDataImages(list?: any) {
  if (!Array.isArray(list)) return [];
  const out: any[] = [];
  for (const d of list) {
    if (!d || typeof d.base64 !== 'string') continue;
    const b64 = d.base64.replace(/^data:[^;]+;base64,/, '');
    try {
      const buffer = Buffer.from(b64, 'base64');
      if (buffer.length) out.push({ name: d.name, buffer });
    } catch (_: any) {
      /* skip */
    }
  }
  return out;
}

function normalizeLabels(labels?: any) {
  if (!labels) return [];
  const arr = Array.isArray(labels) ? labels : String(labels).split(',');
  const seen = new Set();
  const out: any[] = [];
  for (const l of arr) {
    const v = String(l).trim().slice(0, 40);
    if (v && !seen.has(v.toLowerCase())) {
      seen.add(v.toLowerCase());
      out.push(v);
    }
  }
  return out;
}

// A ticket's declared file scope drives wave planning and gates repository commits
// submitted through the Sidequest executor path. Normalizing never drops entries:
// a truncated scope silently un-approves paths the caller declared, and the commit
// gate then refuses them as out of scope (SQ-900). List bounds belong on the write
// path, where the caller can be told to re-scope.
function normalizeFiles(files?: any) {
  if (!files) return [];
  const arr = Array.isArray(files) ? files : String(files).split(',');
  const seen = new Set();
  const out: any[] = [];
  for (const f of arr) {
    const v = String(f).trim().replace(/\\/g, '/').replace(/\/+$/, '').slice(0, 200);
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

function boundedList(values?: any, max?: any, label?: any, guidance?: any) {
  if (values.length > max) {
    throw new Error(`${label} accepts at most ${max} entries; this write declared ${values.length} (${values.length - max} over). ${guidance}`);
  }
  return values;
}

function boundedFiles(files?: any) {
  return boundedList(
    normalizeFiles(files),
    DECLARED_FILES_MAX,
    'declared file scope',
    'Re-scope with directory entries: a declared directory covers every path under it (e.g. plugins/sidequest/test instead of each test file).',
  );
}

function boundedLabels(labels?: any) {
  return boundedList(normalizeLabels(labels), LABELS_MAX, 'labels', 'Labels route and filter work; drop the ones that do neither.');
}


















const CONTRACT_EDGE_KINDS = ['produces', 'changes', 'consumes'];











// An assignee is a free-form name (the human "you", or an agent). Empty/blank
// clears it back to null (unassigned).
function normalizeAssignee(v?: any) {
  if (v == null) return null;
  const s = String(v).trim().slice(0, 60);
  return s || null;
}



function sameFiles(left?: any, right?: any) {
  const normalizedLeft = normalizeFiles(left);
  const normalizedRight = normalizeFiles(right);
  const rightFiles = new Set(normalizedRight.map((file: any) => file.toLowerCase()));
  return normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((file: any) => rightFiles.has(file.toLowerCase()));
}


// Apply a partial update. Only known fields are written; unknown keys ignored.
// Locked (like every other mutator) so a concurrent comment/claim/link append
// can never be silently overwritten by an update whose read predates it.
function updateTicket(slug?: any, idOrRef?: any, patch?: any) {
  const found = getTicket(slug, idOrRef);
  if (!found) return null;
  patch = patch || {};
  const apply = (t?: any) => {
    const nextStatus = patch.status == null ? null : requireStatus(patch.status);
    const prevStatus = t.status;
    if (patch.title != null) t.title = String(patch.title).trim().slice(0, 300) || t.title;
    if (patch.description != null) t.description = String(patch.description).trim();
    if (patch.status != null) t.status = nextStatus;
    if (patch.priority != null) t.priority = coercePriority(patch.priority, t.priority);
    if (patch.labels != null) t.labels = boundedLabels(patch.labels);
    if (patch.highStakes !== undefined) t.highStakes = !!patch.highStakes;
    if (patch.storyId !== undefined) t.storyId = coerceStoryId(slug, patch.storyId);
    if (patch.category !== undefined) t.category = patch.category == null ? null : String(patch.category).trim().toLowerCase() || null;
    // Complexity can move to another valid score, never clear; a fresh motivation
    // rides along whenever one is provided (the CLI demands one on change).
    if (patch.files !== undefined) t.files = boundedFiles(patch.files);
    if (patch.assignee !== undefined) t.assignee = normalizeAssignee(patch.assignee);
    if (patch.order != null && Number.isFinite(Number(patch.order))) t.order = Number(patch.order);
    // Attach any newly supplied images (by path from the CLI, or base64 from the
    // dashboard). Also allow removing an attached asset by filename.
    const imgs = Array.isArray(patch.images) ? patch.images : [];
    for (const src of imgs) {
      try {
        t.assets.push(copyAsset(slug, t.id, src));
      } catch (e: any) {
        if (patch.onAssetError) patch.onAssetError(src, e);
      }
    }
    for (const d of asDataImages(patch.imagesData)) {
      try {
        t.assets.push(saveAssetData(slug, t.id, d.name, d.buffer));
      } catch (_: any) {
        /* skip */
      }
    }
    if (Array.isArray(patch.removeAssets) && patch.removeAssets.length) {
      const drop = new Set(patch.removeAssets.map((f?: any) => path.basename(String(f))));
      t.assets = t.assets.filter((a?: any) => {
        if (!drop.has(a)) return true;
        try {
          fs.unlinkSync(assetPath(slug, t.id, a));
        } catch (_: any) {
          /* ignore */
        }
        return false;
      });
    }
    // Record the event: a status move vs. a plain edit, and who made it. Source
    // defaults to "cli" (the CLI / a subagent), so only the dashboard tags itself.
    t.lastEventType = t.status !== prevStatus ? 'status' : 'edit';
    t.lastEventSource = patch.source ? String(patch.source) : 'cli';
    const now = new Date().toISOString();
    if (t.status !== prevStatus) t.statusTransition = { from: prevStatus, to: t.status, at: now };
    t.updatedAt = now;
    t.referenceUpdatedAt = now;
    putTicket(slug, t);
    queueEventNotification(slug, t, t.lastEventType, t.lastEventSource);
    return t;
  };
  const lock = ticketLockPath(slug, found.id);
  const locked = acquireLock(lock); // best-effort: still applies the update if contention outlasts the retries
  try {
    const t = getTicket(slug, found.id); // fresh read, under the lock when we have it
    if (!t) return null;
    return apply(t);
  } finally {
    if (locked) releaseLock(lock);
  }
}

// Locked so a delete can never yank the ticket/lock file out from under a
// concurrent addComment/claimTicket that still believes it holds the lock.
function deleteTicket(slug?: any, idOrRef?: any) {
  const found = getTicket(slug, idOrRef);
  if (!found) return false;
  const deletedRef = found.ref;
  const lock = ticketLockPath(slug, found.id);
  const locked = acquireLock(lock);
  let ok = false;
  try {
    ok = deleteCachedRow(database(), 'tickets', found.id);
    if (ok) {
      try {
        fs.rmSync(assetsDir(slug, found.id), { recursive: true, force: true });
      } catch (_: any) {
        /* best effort */
      }
    }
  } finally {
    if (locked) releaseLock(lock); // also removes the lock file itself
  }
  if (!ok) return false;
  // Drop any links other tickets had pointing at the one we just removed, so no
  // dangling "blocked-by SQ-deleted" leaves a ticket falsely blocked forever.
  try {
    for (const other of listTickets(slug)) {
      if (Array.isArray(other.links) && other.links.some((l?: any) => upperRef(l.ref) === upperRef(deletedRef))) {
        stripLinksTo(slug, other.id, deletedRef);
      }
    }
  } catch (_: any) {
    /* best effort */
  }
  return true;
}

/* ------------------------------------------------------------------ *
 *  Archiving: put finished work out of the way without deleting it
 *
 *  An archived ticket is kept (and fully restorable) but hidden from the board,
 *  the counts, and `next`. This is how "clear out the Done column" works without
 *  losing the record.
 * ------------------------------------------------------------------ */

function setArchived(slug?: any, idOrRef?: any, archived?: any, opts?: any) {
  opts = opts || {};
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: 'not_found' };
  return withTicketLock(slug, found.id, () => {
    const t = getTicket(slug, found.id);
    if (!t) return { ok: false, reason: 'not_found' };
    t.archived = !!archived;
    t.archivedAt = archived ? new Date().toISOString() : null;
    t.lastEventType = archived ? 'archived' : 'restored';
    t.lastEventSource = opts.source ? String(opts.source) : 'cli';
    t.updatedAt = new Date().toISOString();
    putTicket(slug, t);
    return { ok: true, ticket: t };
  });
}

function archiveTicket(slug?: any, idOrRef?: any, opts?: any) {
  return setArchived(slug, idOrRef, true, opts);
}
function unarchiveTicket(slug?: any, idOrRef?: any, opts?: any) {
  return setArchived(slug, idOrRef, false, opts);
}

// Archive every done, not-yet-archived ticket in a project. Returns the refs.
function archiveAllDone(slug?: any, opts?: any) {
  const refs: any[] = [];
  for (const ticket of queryTickets(String(slug || ''), { status: 'done', archived: false })) {
    const result = setArchived(slug, ticket.id, true, opts);
    if (result.ok) refs.push(result.ticket.ref);
  }
  return { ok: true, archived: refs };
}

function listArchived(slug?: any) {
  return queryTickets(String(slug || ''), { archived: true });
}
function listActive(slug?: any) {
  return queryTickets(String(slug || ''), { archived: false });
}

  return { DECLARED_FILES_MAX, LABELS_MAX, createTicket, normalizeLabels, normalizeFiles, normalizeAssignee, updateTicket, deleteTicket, archiveTicket, unarchiveTicket, archiveAllDone, listArchived, listActive };
}

module.exports = { createTickets };
