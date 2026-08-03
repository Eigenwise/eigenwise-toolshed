'use strict';

function createComments(dependencies: any) {
  const {
    crypto,
    getTicket,
    putTicket,
    queueEventNotification,
    recordClaimVerification,
    touchClaimActivity,
    verificationCompletionCheck,
    withTicketLock,
  } = dependencies;

// Comments are durable cross-actor handoffs. Storage allows a useful evidence
// report; agentsync independently bounds what reaches an executor prompt.
const COMMENT_BODY_MAX = 16000;
const COMMENT_BODY_ADVISORY_BYTES = 4096;

function commentBodyAdvisory(body: string) {
  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes <= COMMENT_BODY_ADVISORY_BYTES) return null;
  return `body stored in full (${(bytes / 1024).toFixed(1)} KB); default reads excerpt bodies past 1200 chars - prefer a tight report and link artifacts (paths, commit hashes) over pasting content.`;
}

function newCommentId() {
  return 'c_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex');
}

// Comment bodies are stored verbatim except for control bytes that have no place
// in prose. A raw NUL is the offender behind SQ-174: an author describing a
// NUL-separated key (e.g. `source + '\0' + slug`) can smuggle a literal 0x00
// into the body, and a NUL is a C-string terminator that silently truncates or
// corrupts anything downstream that treats the body as a C string. Read back,
// that lone NUL among hundreds of intact spaces looked like "a space turned into
// \x00" (it never was: spaces are 0x20 and are left untouched). Strip the C0
// control range and DEL, keeping only the whitespace that legitimately appears
// in prose (tab, newline, carriage return). This runs at the one shared write
// path, so every comment surface gets the same normalization.
function stripControlChars(s?: any) {
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

function prepareComment(fields?: any) {
  fields = fields || {};
  const body = stripControlChars(String(fields.body || '')).trim();
  if (!body) return { ok: false, reason: 'empty' };
  if (body.length > COMMENT_BODY_MAX) {
    return { ok: false, reason: 'too_long', max: COMMENT_BODY_MAX, length: body.length };
  }
  const advisory = commentBodyAdvisory(body);
  return {
    ok: true,
    by: String(fields.by || 'agent'),
    kind: 'comment',
    body,
    source: fields.source ? String(fields.source) : 'cli',
    ...(advisory ? { advisory } : {}),
  };
}

function createComment(fields?: any, at?: any) {
  return {
    id: newCommentId(),
    by: fields.by,
    kind: fields.kind,
    body: fields.body,
    source: fields.source,
    at: at || new Date().toISOString(),
  };
}

function addComment(slug?: any, idOrRef?: any, fields?: any) {
  const prepared = prepareComment(fields);
  if (!prepared.ok) return prepared;
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: 'not_found' };
  return withTicketLock(slug, found.id, () => {
    const t = getTicket(slug, found.id);
    if (!t) return { ok: false, reason: 'not_found' };
    const verification = verificationCompletionCheck(slug, t, prepared);
    if (!verification.ok) return Object.assign({ ticket: t }, verification);
    if (!Array.isArray(t.comments)) t.comments = [];
    const comment = createComment(prepared);
    t.comments.push(comment);
    recordClaimVerification(t, comment);
    touchClaimActivity(t, comment.by, comment.at);
    t.lastEventType = 'comment';
    t.lastEventSource = comment.source;
    t.updatedAt = comment.at;
    putTicket(slug, t);
    queueEventNotification(slug, t, t.lastEventType, t.lastEventSource, { commentBody: comment.body });
    return { ok: true, ticket: t, comment, ...((prepared as any).advisory ? { advisory: (prepared as any).advisory } : {}) };
  });
}

/* ------------------------------------------------------------------ *
 *  Links / dependencies
 *
 *  A link is stored on both tickets with the correct direction, so either side
 *  can see the relationship. User-facing verbs map onto three stored types:
 *  blocks / blocked-by / related. "A depends-on B" == "A blocked-by B" (B must
 *  finish first) == "B blocks A".
 * ------------------------------------------------------------------ */

// Map a user verb to [typeStoredOnFrom, typeStoredOnTo].
function linkTypePair(verb?: any) {
  switch (String(verb || '').toLowerCase().replace(/_/g, '-')) {
    case 'blocks':
    case 'blocking':
      return ['blocks', 'blocked-by'];
    case 'blocked-by':
    case 'blockedby':
    case 'depends-on':
    case 'dependson':
    case 'depends':
    case 'needs':
    case 'after':
      return ['blocked-by', 'blocks'];
    case 'related':
    case 'related-to':
    case 'relates-to':
    case 'relates':
      return ['related', 'related'];
    default:
      return null;
  }
}

function upperRef(r?: any) {
  return String(r).toUpperCase();
}

// Add one directed link to a single ticket (idempotent), under its lock.
function addLinkToTicket(slug?: any, idOrRef?: any, type?: any, otherRef?: any) {
  const found = getTicket(slug, idOrRef);
  if (!found) return;
  withTicketLock(slug, found.id, () => {
    const t = getTicket(slug, found.id);
    if (!t) return;
    if (!Array.isArray(t.links)) t.links = [];
    const ref = upperRef(otherRef);
    if (!t.links.some((l?: any) => l.type === type && upperRef(l.ref) === ref)) {
      t.links.push({ type, ref });
      t.updatedAt = new Date().toISOString();
      putTicket(slug, t);
    }
  });
}

// Link two tickets by a verb, writing the correct direction on each side.
function linkTickets(slug?: any, fromRef?: any, verb?: any, toRef?: any) {
  const pair = linkTypePair(verb);
  if (!pair) return { ok: false, reason: 'bad_type' };
  const from = getTicket(slug, fromRef);
  const to = getTicket(slug, toRef);
  if (!from) return { ok: false, reason: 'from_not_found' };
  if (!to) return { ok: false, reason: 'to_not_found' };
  if (from.id === to.id) return { ok: false, reason: 'self' };
  addLinkToTicket(slug, from.id, pair[0], to.ref);
  addLinkToTicket(slug, to.id, pair[1], from.ref);
  return { ok: true, from: getTicket(slug, from.id), to: getTicket(slug, to.id), type: pair[0] };
}

// Remove every link between two tickets (both directions).
function unlinkTickets(slug?: any, aRef?: any, bRef?: any) {
  const a = getTicket(slug, aRef);
  const b = getTicket(slug, bRef);
  if (!a || !b) return { ok: false, reason: 'not_found' };
  stripLinksTo(slug, a.id, b.ref);
  stripLinksTo(slug, b.id, a.ref);
  return { ok: true };
}

function stripLinksTo(slug?: any, idOrRef?: any, otherRef?: any) {
  const found = getTicket(slug, idOrRef);
  if (!found) return;
  withTicketLock(slug, found.id, () => {
    const t = getTicket(slug, found.id);
    if (!t || !Array.isArray(t.links)) return;
    const ref = upperRef(otherRef);
    const kept = t.links.filter((l?: any) => upperRef(l.ref) !== ref);
    if (kept.length !== t.links.length) {
      t.links = kept;
      t.updatedAt = new Date().toISOString();
      putTicket(slug, t);
    }
  });
}

// The refs a ticket is blocked-by that are not yet done (i.e. genuinely blocking).
function openBlockers(slug?: any, ticket?: any) {
  if (!ticket || !Array.isArray(ticket.links)) return [];
  const out: any[] = [];
  for (const l of ticket.links) {
    if (l.type !== 'blocked-by') continue;
    const blocker = getTicket(slug, l.ref);
    if (blocker && blocker.status !== 'done') out.push(blocker.ref);
  }
  return out;
}

function isBlocked(slug?: any, ticket?: any) {
  return openBlockers(slug, ticket).length > 0;
}

// Resolve a ticket's open blockers against an in-memory ref->ticket index
// (uppercased refs), instead of openBlockers()'s per-link getTicket fallback:
// links store "SQ-n" refs while ticket files are named by id, so the per-link
// path degenerates into a full-board rescan per link.
function openBlockersFromIndex(index?: any, ticket?: any) {
  if (!ticket || !Array.isArray(ticket.links)) return [];
  const out: any[] = [];
  for (const l of ticket.links) {
    if (l.type !== 'blocked-by') continue;
    const blocker = index.get(String(l.ref).toUpperCase());
    if (blocker && blocker.status !== 'done') out.push(blocker.ref);
  }
  return out;
}

  return {
    addComment,
    createComment,
    isBlocked,
    linkTickets,
    openBlockers,
    openBlockersFromIndex,
    prepareComment,
    stripControlChars,
    stripLinksTo,
    unlinkTickets,
    upperRef,
  };
}

module.exports = { createComments };
