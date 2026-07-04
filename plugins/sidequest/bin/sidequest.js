#!/usr/bin/env node
'use strict';
/**
 * sidequest - command-line interface
 *
 * The single entry point used by humans, the capture hook, and the ticket-filer
 * subagent. Node stdlib only; cross-platform.
 *
 *   sidequest add -t "title" [-d desc] [-p priority] [-l label]... [-i image]... [-s status]
 *   sidequest list [--status todo] [--json]
 *   sidequest update <id|SQ-n> [-t] [-d] [-p] [-s] [-l ...] [-i ...]
 *   sidequest rm <id|SQ-n>
 *   sidequest comment <id|SQ-n> -m "body" [--by who] [--kind comment|question]
 *   sidequest ask <id|SQ-n> -m "question?" [--by who]
 *   sidequest comments <id|SQ-n> [--json]
 *   sidequest await <id|SQ-n> [--timeout secs] [--poll secs]
 *   sidequest projects
 *   sidequest dashboard [--port N] [--no-open]      # ensure server + open browser
 *   sidequest serve [--port N]                       # run the server in foreground
 *   sidequest stop                                   # stop the running server
 *
 * The project defaults to $CLAUDE_PROJECT_DIR (or the current directory). Pass
 * --project <path-or-slug> to target another board.
 */

const path = require('path');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');
const store = require('../lib/store');

/* ------------------------------------------------------------------ *
 *  Arg parsing
 * ------------------------------------------------------------------ */

// Flags that may be repeated collect into arrays; everything else is a scalar.
const ARRAY_FLAGS = new Set(['image', 'label']);
const ALIASES = {
  t: 'title',
  d: 'desc',
  p: 'priority',
  l: 'label',
  i: 'image',
  s: 'status',
  b: 'by',
  m: 'body',
};

function parseArgs(argv) {
  const opts = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (a === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--') || a.startsWith('-')) {
      const isLong = a.startsWith('--');
      let key = a.replace(/^-+/, '');
      let val = null;
      const eq = key.indexOf('=');
      if (eq !== -1) {
        val = key.slice(eq + 1);
        key = key.slice(0, eq);
      }
      if (!isLong && ALIASES[key]) key = ALIASES[key];
      if (key === 'no-open') {
        opts.open = false;
        continue;
      }
      // Boolean-ish flags don't consume a value.
      const BOOL = new Set(['json', 'open', 'help', 'force', 'done', 'archived', 'all']);
      if (val === null) {
        if (BOOL.has(key)) {
          opts[key] = true;
          continue;
        }
        val = argv[i + 1];
        i++;
      }
      if (ARRAY_FLAGS.has(key)) {
        (opts[key] = opts[key] || []).push(val);
      } else {
        opts[key] = val;
      }
    } else {
      positional.push(a);
    }
  }
  return { opts, positional };
}

/* ------------------------------------------------------------------ *
 *  Project resolution
 * ------------------------------------------------------------------ */

function resolveProject(opts) {
  const arg = opts.project;
  if (arg) {
    // An exact slug of an existing board wins; otherwise treat it as a path.
    if (store.readMeta(arg)) return { slug: arg, meta: store.readMeta(arg) };
    return store.ensureProject(arg, opts.name);
  }
  const dir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  return store.ensureProject(dir, opts.name);
}

/* ------------------------------------------------------------------ *
 *  Commands
 * ------------------------------------------------------------------ */

const PRIORITY_MARK = { urgent: '!!', high: '!', normal: '', low: '·' };

function cmdAdd(opts) {
  if (!opts.title) fail('add: --title is required (e.g. sidequest add -t "Contact form does not send")');
  const { slug, meta } = resolveProject(opts);
  const warnings = [];
  const ticket = store.createTicket(slug, {
    title: opts.title,
    description: opts.desc || opts.description || '',
    priority: opts.priority,
    status: opts.status,
    labels: opts.label,
    images: opts.image || [],
    source: opts.source || 'cli',
    onAssetError: (src) => warnings.push(`could not attach image: ${src}`),
  });

  if (opts.json) {
    process.stdout.write(JSON.stringify({ ok: true, project: slug, projectName: meta.name, ticket, warnings }, null, 2) + '\n');
    return;
  }
  const pr = PRIORITY_MARK[ticket.priority] ? ` ${PRIORITY_MARK[ticket.priority]}` : '';
  const imgs = ticket.assets.length ? ` (${ticket.assets.length} image${ticket.assets.length > 1 ? 's' : ''})` : '';
  console.log(`✓ ${ticket.ref}${pr}  "${ticket.title}"  [${ticket.status}/${ticket.priority}]${imgs}  — ${meta.name}`);
  for (const w of warnings) console.log(`  ! ${w}`);
  const info = store.readServerInfo();
  if (info && info.url) console.log(`  board: ${info.url}`);
}

function cmdList(opts) {
  const { slug, meta } = resolveProject(opts);
  let tickets = store.listTickets(slug);
  // Archived tickets are hidden from the board by default; `--archived` shows only them.
  tickets = opts.archived ? tickets.filter((t) => t.archived) : tickets.filter((t) => !t.archived);
  if (opts.status) tickets = tickets.filter((t) => t.status === String(opts.status).toLowerCase());
  if (opts.json) {
    process.stdout.write(JSON.stringify({ project: slug, projectName: meta.name, tickets }, null, 2) + '\n');
    return;
  }
  if (!tickets.length) {
    console.log(`No tickets in ${meta.name}.`);
    return;
  }
  console.log(`${meta.name} — ${tickets.length} ticket(s)`);
  const cols = { todo: 'TO DO', doing: 'DOING', done: 'DONE' };
  for (const status of store.VALID_STATUS) {
    const group = tickets.filter((t) => t.status === status);
    if (!group.length) continue;
    console.log(`\n  ${cols[status]} (${group.length})`);
    for (const t of group) {
      const pr = PRIORITY_MARK[t.priority] ? ` ${PRIORITY_MARK[t.priority]}` : '';
      const labels = t.labels.length ? `  #${t.labels.join(' #')}` : '';
      const imgs = t.assets.length ? `  \u{1F5BC}${t.assets.length}` : '';
      const clm = t.claim && t.claim.by ? `  @${t.claim.by}${store.isClaimStale(t.claim) ? ' (stale)' : ''}` : '';
      const asn = t.assignee ? `  \u{1F464}${t.assignee}` : '';
      const blockers = store.openBlockers(slug, t);
      const blk = blockers.length ? `  ⛔ blocked-by ${blockers.join(',')}` : '';
      const lnk = t.links && t.links.length ? `  ⇄${t.links.length}` : '';
      const cmt = t.comments && t.comments.length ? `  \u{1F4AC}${t.comments.length}` : '';
      const ask = store.needsResponse(t) ? '  ❓ awaiting reply' : '';
      console.log(`    ${t.ref}${pr}  ${t.title}${labels}${imgs}${cmt}${lnk}${blk}${clm}${asn}${ask}`);
    }
  }
}

function cmdUpdate(opts, positional) {
  const idOrRef = positional[0];
  if (!idOrRef) fail('update: pass a ticket id or ref, e.g. sidequest update SQ-4 --status done');
  const { slug, meta } = resolveProject(opts);
  const patch = {};
  if (opts.title != null) patch.title = opts.title;
  if (opts.desc != null || opts.description != null) patch.description = opts.desc != null ? opts.desc : opts.description;
  if (opts.status != null) patch.status = opts.status;
  if (opts.priority != null) patch.priority = opts.priority;
  if (opts.label != null) patch.labels = opts.label;
  if (opts.image != null) patch.images = opts.image;
  if (opts.assignee != null) patch.assignee = opts.assignee;
  patch.source = opts.source || 'cli'; // a CLI/subagent change (Claude), not the dashboard
  const updated = store.updateTicket(slug, idOrRef, patch);
  if (!updated) fail(`update: no ticket "${idOrRef}" in ${meta.name}`);
  if (opts.json) {
    process.stdout.write(JSON.stringify({ ok: true, ticket: updated }, null, 2) + '\n');
    return;
  }
  console.log(`✓ ${updated.ref} updated  [${updated.status}/${updated.priority}]  "${updated.title}"`);
}

function cmdRm(opts, positional) {
  const idOrRef = positional[0];
  if (!idOrRef) fail('rm: pass a ticket id or ref, e.g. sidequest rm SQ-4');
  const { slug, meta } = resolveProject(opts);
  const ok = store.deleteTicket(slug, idOrRef);
  if (!ok) fail(`rm: no ticket "${idOrRef}" in ${meta.name}`);
  console.log(`✓ removed ${idOrRef} from ${meta.name}`);
}

/* ------------------------------------------------------------------ *
 *  Claiming (safe hand-off to a worker)
 * ------------------------------------------------------------------ */

// A stable identity for the worker doing the claim, so the same worker can later
// release/complete it. Pass --by to be explicit; otherwise fall back to an env
// hint or the machine name. Distinct concurrent workers should pass distinct --by.
function workerId(opts) {
  return String(
    opts.by || process.env.SIDEQUEST_AGENT || process.env.CLAUDE_SESSION_ID || 'agent@' + os.hostname()
  );
}

function reportClaimFailure(action, idOrRef, res, meta) {
  process.exitCode = 1;
  const c = res.claim || {};
  const messages = {
    not_found: `${idOrRef} no longer exists on ${meta.name} — nothing to ${action}.`,
    done: `${idOrRef} is already done — skip it.`,
    claimed: `${idOrRef} is already claimed by "${c.by}" (since ${c.at}). Do NOT work it.`,
    not_owner: `${idOrRef} is claimed by "${c.by}", not you — use --force only if you are certain.`,
    busy: `${idOrRef} is locked by another claim right now — retry in a moment.`,
    empty: `no available tickets in ${meta.name}.`,
  };
  console.log(`✗ ${messages[res.reason] || action + ' failed: ' + res.reason}`);
}

function cmdClaim(opts, positional) {
  const idOrRef = positional[0];
  if (!idOrRef) fail('claim: pass a ticket id or ref, e.g. sidequest claim SQ-3 --by me');
  const { slug, meta } = resolveProject(opts);
  const by = workerId(opts);
  const res = store.claimTicket(slug, idOrRef, by, { force: !!opts.force, source: opts.source || 'cli' });
  if (opts.json) {
    process.stdout.write(JSON.stringify(Object.assign({ project: slug }, res), null, 2) + '\n');
    if (!res.ok) process.exitCode = 1;
    return;
  }
  if (res.ok) {
    console.log(`✓ claimed ${res.ticket.ref} as "${by}"  [${res.ticket.status}]  — ${meta.name}`);
    console.log(`  "${res.ticket.title}"`);
  } else {
    reportClaimFailure('claim', idOrRef, res, meta);
  }
}

function cmdRelease(opts, positional) {
  const idOrRef = positional[0];
  if (!idOrRef) fail('release: pass a ticket id or ref, e.g. sidequest release SQ-3');
  const { slug, meta } = resolveProject(opts);
  const by = workerId(opts);
  const res = store.releaseTicket(slug, idOrRef, by, { force: !!opts.force, status: opts.status, source: opts.source || 'cli' });
  if (opts.json) {
    process.stdout.write(JSON.stringify(Object.assign({ project: slug }, res), null, 2) + '\n');
    if (!res.ok) process.exitCode = 1;
    return;
  }
  if (res.ok) console.log(`✓ released ${res.ticket.ref}  [${res.ticket.status}]  — ${meta.name}`);
  else reportClaimFailure('release', idOrRef, res, meta);
}

function cmdDone(opts, positional) {
  const idOrRef = positional[0];
  if (!idOrRef) fail('done: pass a ticket id or ref, e.g. sidequest done SQ-3');
  const { slug, meta } = resolveProject(opts);
  const by = workerId(opts);
  const res = store.completeTicket(slug, idOrRef, by, { force: !!opts.force, source: opts.source || 'cli' });
  if (opts.json) {
    process.stdout.write(JSON.stringify(Object.assign({ project: slug }, res), null, 2) + '\n');
    if (!res.ok) process.exitCode = 1;
    return;
  }
  if (res.ok) console.log(`✓ ${res.ticket.ref} done  — ${meta.name}`);
  else reportClaimFailure('complete', idOrRef, res, meta);
}

function cmdNext(opts) {
  const { slug, meta } = resolveProject(opts);
  const by = workerId(opts);
  const res = store.claimNext(slug, by, { priority: opts.priority, source: opts.source || 'cli' });
  if (opts.json) {
    process.stdout.write(JSON.stringify(Object.assign({ project: slug }, res), null, 2) + '\n');
    if (!res.ok) process.exitCode = 1;
    return;
  }
  if (res.ok) {
    const t = res.ticket;
    console.log(`✓ claimed next: ${t.ref} [${t.priority}]  "${t.title}"  as "${by}" — ${meta.name}`);
    if (t.description) console.log(`  ${t.description}`);
  } else {
    process.exitCode = 1;
    console.log(`No available tickets to claim in ${meta.name}.`);
  }
}

// Assign a ticket to someone (defaults to the human "you"), or clear it with
// `unassign`. Assignment is persistent and separate from an agent claim.
function cmdAssign(opts, positional, clear) {
  const idOrRef = positional[0];
  if (!idOrRef) fail(`${clear ? 'unassign' : 'assign'}: pass a ticket id or ref, e.g. sidequest ${clear ? 'unassign SQ-3' : 'assign SQ-3 --to you'}`);
  const { slug, meta } = resolveProject(opts);
  const who = clear ? null : (opts.to != null ? opts.to : (opts.by != null ? opts.by : 'you'));
  const res = store.assignTicket(slug, idOrRef, who, { source: opts.source || 'cli' });
  if (opts.json) {
    process.stdout.write(JSON.stringify(Object.assign({ project: slug }, res), null, 2) + '\n');
    if (!res.ok) process.exitCode = 1;
    return;
  }
  if (!res.ok) fail(`${clear ? 'unassign' : 'assign'}: no ticket "${idOrRef}" in ${meta.name}`);
  if (res.ticket.assignee) console.log(`✓ ${res.ticket.ref} assigned to "${res.ticket.assignee}"  — ${meta.name}`);
  else console.log(`✓ ${res.ticket.ref} unassigned  — ${meta.name}`);
}

// Same presets the dashboard's ticket editor offers, so `--in` matches what a
// human clicking "Remind me" would get.
const REMINDER_PRESETS = {
  '1h': () => new Date(Date.now() + 60 * 60 * 1000),
  '3h': () => new Date(Date.now() + 3 * 60 * 60 * 1000),
  tomorrow: () => {
    const d = new Date(Date.now() + 24 * 60 * 60 * 1000);
    d.setHours(9, 0, 0, 0);
    return d;
  },
};

// Schedule a reminder on a ticket: `--in 1h|3h|tomorrow` or `--at "<date/time>"`.
// It's just a kind:'reminder' notification with a future fireAt — see
// store.setReminder(). Setting a new one replaces whatever was pending.
function cmdRemind(opts, positional) {
  const idOrRef = positional[0];
  if (!idOrRef) fail('remind: pass a ticket id or ref and a time, e.g. sidequest remind SQ-3 --in 1h  (or --at "2026-07-05T09:00")');
  const { slug, meta } = resolveProject(opts);
  let when;
  if (opts.in) {
    const preset = REMINDER_PRESETS[String(opts.in)];
    if (!preset) fail(`remind: --in must be one of ${Object.keys(REMINDER_PRESETS).join('|')}`);
    when = preset();
  } else if (opts.at) {
    when = new Date(String(opts.at));
    if (Number.isNaN(when.getTime())) fail(`remind: couldn't parse --at "${opts.at}"`);
  } else {
    fail('remind: pass --in 1h|3h|tomorrow or --at "<date/time>"');
  }
  const res = store.setReminder(slug, idOrRef, when.toISOString());
  if (opts.json) {
    process.stdout.write(JSON.stringify(Object.assign({ project: slug }, res), null, 2) + '\n');
    if (!res.ok) process.exitCode = 1;
    return;
  }
  if (!res.ok) {
    const reasons = { not_found: `no ticket "${idOrRef}" in ${meta.name}`, bad_fireAt: 'bad --at value', in_past: 'that time is in the past' };
    fail(`remind: ${reasons[res.reason] || res.reason}`);
  }
  console.log(`✓ reminder set on ${idOrRef} for ${when.toLocaleString()}  — ${meta.name}`);
}

// Cancel whatever reminder is pending on a ticket (a no-op, not an error, if
// there wasn't one — see store.cancelReminder()).
function cmdUnremind(opts, positional) {
  const idOrRef = positional[0];
  if (!idOrRef) fail('unremind: pass a ticket id or ref, e.g. sidequest unremind SQ-3');
  const { slug, meta } = resolveProject(opts);
  const res = store.cancelReminder(slug, idOrRef);
  if (opts.json) {
    process.stdout.write(JSON.stringify(Object.assign({ project: slug }, res), null, 2) + '\n');
    if (!res.ok) process.exitCode = 1;
    return;
  }
  if (!res.ok) fail(`unremind: no ticket "${idOrRef}" in ${meta.name}`);
  console.log(res.removed ? `✓ cancelled reminder on ${idOrRef}  — ${meta.name}` : `no pending reminder on ${idOrRef}  — ${meta.name}`);
}

/* ------------------------------------------------------------------ *
 *  Comments
 * ------------------------------------------------------------------ */

function cmdComment(opts, positional) {
  const idOrRef = positional[0];
  if (!idOrRef) fail('comment: pass a ticket id or ref, e.g. sidequest comment SQ-3 -m "note" [--kind question]');
  const body = opts.body;
  if (!body || !String(body).trim()) fail('comment: -m/--body is required, e.g. sidequest comment SQ-3 -m "note"');
  const { slug, meta } = resolveProject(opts);
  const by = workerId(opts);
  const kind = opts.kind === 'question' ? 'question' : 'comment';
  const res = store.addComment(slug, idOrRef, { by, body, kind, source: opts.source || 'cli' });
  if (opts.json) {
    process.stdout.write(JSON.stringify(Object.assign({ project: slug }, res), null, 2) + '\n');
    if (!res.ok) process.exitCode = 1;
    return;
  }
  if (res.ok) {
    const tag = kind === 'question' ? '?' : '»';
    console.log(`✓ ${tag} comment added to ${res.ticket.ref} by "${by}"  — ${meta.name}`);
  } else {
    process.exitCode = 1;
    const messages = { not_found: `no ticket "${idOrRef}" in ${meta.name}.`, empty: 'comment body cannot be empty.', busy: `${idOrRef} is locked right now — retry in a moment.` };
    console.log(`✗ ${messages[res.reason] || 'comment failed: ' + res.reason}`);
  }
}

function cmdComments(opts, positional) {
  const idOrRef = positional[0];
  if (!idOrRef) fail('comments: pass a ticket id or ref, e.g. sidequest comments SQ-3');
  const { slug, meta } = resolveProject(opts);
  const t = store.getTicket(slug, idOrRef);
  if (!t) fail(`comments: no ticket "${idOrRef}" in ${meta.name}`);
  const comments = Array.isArray(t.comments) ? t.comments : [];
  if (opts.json) {
    process.stdout.write(JSON.stringify({ project: slug, ticket: t.ref, comments }, null, 2) + '\n');
    return;
  }
  if (!comments.length) {
    console.log(`No comments on ${t.ref}.`);
    return;
  }
  console.log(`${t.ref} — ${comments.length} comment(s)`);
  for (const c of comments) {
    const tag = c.kind === 'question' ? '?' : '»';
    console.log(`  ${tag} [${c.at}] ${c.by}: ${c.body}`);
  }
}

// Bounded poll for a reply to a pending question. A plain comment (note-to-
// self) never blocks anything; only `ask`/`--kind question` sets needsResponse,
// and only a reply posted through the dashboard (the human) clears it — see
// store.needsResponse. Defaults are sized to fit inside a typical Bash-tool
// call (2 min) with no flags; pass --timeout for a longer wait.
async function cmdAwait(opts, positional) {
  const idOrRef = positional[0];
  if (!idOrRef) fail('await: pass a ticket id or ref, e.g. sidequest await SQ-3 [--timeout 120] [--poll 5]');
  const { slug, meta } = resolveProject(opts);
  const timeoutMs = (Number(opts.timeout) > 0 ? Number(opts.timeout) : 120) * 1000;
  const pollMs = (Number(opts.poll) > 0 ? Number(opts.poll) : 5) * 1000;
  const since = new Date().toISOString();

  // Reports "gone" the same way regardless of --json, matching the other three
  // terminal states (not_awaiting/answered/timeout) instead of a bare stderr exit.
  const gone = () => {
    if (opts.json) {
      process.stdout.write(JSON.stringify({ ok: false, waited: false, reason: 'not_found' }, null, 2) + '\n');
      process.exitCode = 1;
      return;
    }
    fail(`await: no ticket "${idOrRef}" in ${meta.name}`);
  };

  let t = store.getTicket(slug, idOrRef);
  if (!t) return gone();
  if (!store.needsResponse(t)) {
    if (opts.json) {
      process.stdout.write(JSON.stringify({ ok: true, waited: false, reason: 'not_awaiting', ticket: t }, null, 2) + '\n');
      return;
    }
    console.log(`${t.ref} is not currently awaiting a reply.`);
    return;
  }

  if (!opts.json) console.log(`Waiting for a reply on ${t.ref} (poll every ${pollMs / 1000}s, timeout ${timeoutMs / 1000}s)…`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await delay(Math.max(0, Math.min(pollMs, deadline - Date.now())));
    t = store.getTicket(slug, idOrRef);
    if (!t) return gone();
    if (!store.needsResponse(t)) {
      const replies = (t.comments || []).filter((c) => c.at > since);
      if (opts.json) {
        process.stdout.write(JSON.stringify({ ok: true, waited: true, reason: 'answered', ticket: t, replies }, null, 2) + '\n');
        return;
      }
      console.log(`✓ ${t.ref} got a reply:`);
      for (const c of replies) console.log(`  » [${c.at}] ${c.by}: ${c.body}`);
      return;
    }
  }
  process.exitCode = 1;
  if (opts.json) {
    process.stdout.write(JSON.stringify({ ok: false, waited: false, reason: 'timeout', ticket: t }, null, 2) + '\n');
    return;
  }
  console.log(`✗ timed out waiting for a reply on ${t.ref} — still awaiting.`);
}

function cmdLink(opts, positional) {
  // sidequest link SQ-1 <blocks|depends-on|related> SQ-2
  const a = positional[0];
  const verb = positional[1];
  const b = positional[2];
  if (!a || !verb || !b) fail('link: usage — sidequest link SQ-1 <blocks|depends-on|related> SQ-2');
  const { slug, meta } = resolveProject(opts);
  const res = store.linkTickets(slug, a, verb, b);
  if (opts.json) {
    process.stdout.write(JSON.stringify(Object.assign({ project: slug }, res), null, 2) + '\n');
    if (!res.ok) process.exitCode = 1;
    return;
  }
  if (res.ok) {
    console.log(`✓ linked ${res.from.ref} ${res.type} ${res.to.ref}  — ${meta.name}`);
  } else {
    process.exitCode = 1;
    const messages = {
      bad_type: `unknown relationship "${verb}" — use blocks, depends-on, or related.`,
      from_not_found: `no ticket "${a}" in ${meta.name}.`,
      to_not_found: `no ticket "${b}" in ${meta.name}.`,
      self: 'a ticket cannot link to itself.',
    };
    console.log(`✗ ${messages[res.reason] || 'link failed: ' + res.reason}`);
  }
}

function cmdUnlink(opts, positional) {
  const a = positional[0];
  const b = positional[1];
  if (!a || !b) fail('unlink: usage — sidequest unlink SQ-1 SQ-2');
  const { slug, meta } = resolveProject(opts);
  const res = store.unlinkTickets(slug, a, b);
  if (opts.json) {
    process.stdout.write(JSON.stringify(Object.assign({ project: slug }, res), null, 2) + '\n');
    if (!res.ok) process.exitCode = 1;
    return;
  }
  if (res.ok) console.log(`✓ unlinked ${a} ✕ ${b}  — ${meta.name}`);
  else {
    process.exitCode = 1;
    console.log(`✗ unlink failed: ${res.reason === 'not_found' ? 'one of those tickets does not exist' : res.reason}`);
  }
}

// The set to fan subagents out over: unclaimed, unblocked, not-done, not-archived.
function cmdReady(opts) {
  const { slug, meta } = resolveProject(opts);
  const tickets = store.readyTickets(slug);
  if (opts.json) {
    process.stdout.write(JSON.stringify({ project: slug, projectName: meta.name, tickets }, null, 2) + '\n');
    return;
  }
  if (!tickets.length) {
    console.log(`Nothing ready to work in ${meta.name}.`);
    return;
  }
  console.log(`${meta.name} — ${tickets.length} ready to work (unclaimed, unblocked):`);
  for (const t of tickets) {
    const pr = PRIORITY_MARK[t.priority] ? ` ${PRIORITY_MARK[t.priority]}` : '';
    console.log(`    ${t.ref}${pr}  ${t.title}`);
  }
  if (tickets.length > 1) {
    console.log('\nIf these are independent (no shared files), fan out: one subagent per ticket — each claim --by <id> → do → done.');
  }
}

function cmdArchive(opts, positional) {
  const { slug, meta } = resolveProject(opts);
  // Bulk: archive every done ticket.
  if (opts.done || opts.all || positional[0] === 'done' || positional[0] === 'all') {
    const res = store.archiveAllDone(slug, { source: opts.source || 'cli' });
    if (opts.json) {
      process.stdout.write(JSON.stringify(Object.assign({ project: slug }, res), null, 2) + '\n');
      return;
    }
    const n = res.archived.length;
    console.log(`✓ archived ${n} done ticket(s)${n ? ': ' + res.archived.join(', ') : ''}  — ${meta.name}`);
    return;
  }
  const idOrRef = positional[0];
  if (!idOrRef) fail('archive: pass a ticket ref, or --done to archive all done. e.g. sidequest archive SQ-3  |  sidequest archive --done');
  const res = store.archiveTicket(slug, idOrRef, { source: opts.source || 'cli' });
  if (opts.json) {
    process.stdout.write(JSON.stringify(Object.assign({ project: slug }, res), null, 2) + '\n');
    if (!res.ok) process.exitCode = 1;
    return;
  }
  if (res.ok) console.log(`✓ archived ${res.ticket.ref}  — ${meta.name}`);
  else {
    process.exitCode = 1;
    console.log(`✗ archive: no ticket "${idOrRef}" in ${meta.name}`);
  }
}

function cmdUnarchive(opts, positional) {
  const idOrRef = positional[0];
  if (!idOrRef) fail('unarchive: pass a ticket ref, e.g. sidequest unarchive SQ-3');
  const { slug, meta } = resolveProject(opts);
  const res = store.unarchiveTicket(slug, idOrRef, { source: opts.source || 'cli' });
  if (opts.json) {
    process.stdout.write(JSON.stringify(Object.assign({ project: slug }, res), null, 2) + '\n');
    if (!res.ok) process.exitCode = 1;
    return;
  }
  if (res.ok) console.log(`✓ restored ${res.ticket.ref}  — ${meta.name}`);
  else {
    process.exitCode = 1;
    console.log(`✗ unarchive: no ticket "${idOrRef}" in ${meta.name}`);
  }
}

function cmdProjects(opts) {
  const projects = store.listProjects();
  if (opts.json) {
    process.stdout.write(JSON.stringify({ projects }, null, 2) + '\n');
    return;
  }
  if (!projects.length) {
    console.log('No sidequest boards yet. Create a ticket to start one.');
    return;
  }
  console.log(`${projects.length} board(s):`);
  for (const p of projects) {
    console.log(`  ${p.name}  —  ${p.open} open (${p.counts.todo} todo, ${p.counts.doing} doing, ${p.counts.done} done)`);
    console.log(`    ${p.path}`);
  }
}

/* ------------------------------------------------------------------ *
 *  Server lifecycle
 * ------------------------------------------------------------------ */

function checkHealth(port, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: timeoutMs || 800 }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        try {
          const info = JSON.parse(raw);
          resolve(info && info.name === 'sidequest' ? info : null);
        } catch (_) {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Return the URL of a running dashboard, starting a detached one if needed.
async function ensureServer(requestedPort) {
  const existing = store.readServerInfo();
  if (existing && existing.port) {
    const health = await checkHealth(existing.port);
    if (health) return existing.url || `http://127.0.0.1:${existing.port}`;
  }
  // Spawn the server detached so it outlives this short-lived CLI process.
  const args = [path.join(__dirname, 'sidequest.js'), 'serve'];
  if (requestedPort) args.push('--port', String(requestedPort));
  const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();

  // Wait for it to record itself and answer health.
  for (let i = 0; i < 60; i++) {
    await delay(150);
    const info = store.readServerInfo();
    if (info && info.port) {
      const health = await checkHealth(info.port);
      if (health) return info.url || `http://127.0.0.1:${info.port}`;
    }
  }
  throw new Error('the dashboard server did not start in time');
}

function openBrowser(targetUrl) {
  try {
    let cmd;
    let args;
    if (process.platform === 'win32') {
      cmd = 'cmd';
      args = ['/c', 'start', '', targetUrl];
    } else if (process.platform === 'darwin') {
      cmd = 'open';
      args = [targetUrl];
    } else {
      cmd = 'xdg-open';
      args = [targetUrl];
    }
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  } catch (_) {
    /* opening the browser is best-effort */
  }
}

async function cmdDashboard(opts) {
  // Register the current project so it shows up even before its first ticket.
  try {
    resolveProject(opts);
  } catch (_) {
    /* fine if we cannot */
  }
  const targetUrl = await ensureServer(opts.port);
  if (opts.open !== false) openBrowser(targetUrl);
  console.log(`sidequest dashboard: ${targetUrl}`);
  if (opts.open === false) console.log('(browser auto-open skipped; open the URL above)');
}

async function cmdServe(opts) {
  const server = require('../lib/server');
  const { url } = await server.start(opts.port);
  console.log(`sidequest dashboard running at ${url}`);
  // Do not exit: the HTTP server keeps the process alive.
}

function cmdStop() {
  const info = store.readServerInfo();
  if (!info || !info.pid) {
    console.log('No running sidequest server recorded.');
    return;
  }
  try {
    process.kill(info.pid);
    console.log(`Stopped sidequest server (pid ${info.pid}).`);
  } catch (e) {
    console.log(`Could not stop pid ${info.pid}: ${e.message}`);
  }
  store.clearServerInfo();
}

/* ------------------------------------------------------------------ *
 *  Help + dispatch
 * ------------------------------------------------------------------ */

function help() {
  console.log(
    `sidequest — a Trello-light quest log for Claude Code

Usage:
  sidequest add -t "title" [-d desc] [-p low|normal|high|urgent] [-l label]... [-i image]... [-s todo|doing|done]
  sidequest list [--status todo|doing|done] [--json]
  sidequest update <id|SQ-n> [-t title] [-d desc] [-p priority] [-s status] [-l label]... [-i image]...
  sidequest rm <id|SQ-n>
  sidequest projects [--json]
  sidequest dashboard [--port N] [--no-open]     open the live board in the browser
  sidequest serve [--port N]                     run the board server in the foreground
  sidequest stop                                 stop the running board server

Working the board safely (multi-agent):
  sidequest ready [--json]                         the ready set (unclaimed, unblocked) — fan subagents over it
  sidequest claim <id|SQ-n> [--by who] [--force]   atomically take a ticket (fails if gone/done/claimed)
  sidequest next [--by who] [-p priority]          claim the best available ticket (highest priority first)
  sidequest done <id|SQ-n> [--by who]              mark it done and release the claim
  sidequest release <id|SQ-n> [--by who] [-s todo] drop the claim without finishing
  A claim guarantees no other worker is on the ticket. Never work a ticket whose claim did not succeed.
  When 2+ ready tickets are independent (no shared files), fan out one subagent per ticket in parallel.

Assigning (persistent owner, e.g. handing a ticket to the human — separate from a claim):
  sidequest assign <id|SQ-n> [--to who=you]        assign a ticket (defaults to "you", the human)
  sidequest unassign <id|SQ-n>                      clear the assignee

Reminders (fires into the notification queue/bell inbox when the dashboard server is running):
  sidequest remind <id|SQ-n> --in 1h|3h|tomorrow   schedule a reminder from a preset
  sidequest remind <id|SQ-n> --at "<date/time>"    or a specific date/time
  sidequest unremind <id|SQ-n>                      cancel a pending reminder

Comments:
  sidequest comment <id|SQ-n> -m "body" [--by who] [--kind comment|question]   a note-to-self; keep going
  sidequest ask <id|SQ-n> -m "question?" [--by who]   post a question — then AWAIT it, don't just continue
  sidequest comments <id|SQ-n> [--json]            list a ticket's comment thread
  sidequest await <id|SQ-n> [--timeout secs=120] [--poll secs=5]   block until the human replies (or times out)

Links / dependencies:
  sidequest link <id|SQ-n> <blocks|depends-on|related> <id|SQ-n>   relate two tickets (inverse auto-set)
  sidequest unlink <id|SQ-n> <id|SQ-n>             remove the link between two tickets
  A ticket blocked by an unfinished ticket is skipped by 'next'/'ready' and shown as blocked.

Archive (put finished work out of the way, restorable):
  sidequest archive <id|SQ-n>                      archive one ticket    ·    --done archives ALL done
  sidequest unarchive <id|SQ-n>                    restore an archived ticket
  sidequest list --archived                        list archived tickets

Project selection:
  Defaults to $CLAUDE_PROJECT_DIR or the current directory.
  --project <path-or-slug>   target another board  ·  --name <name>   set its display name

Tickets and their images are stored centrally (default ~/.claude/sidequest), so
one dashboard shows every project's board at once.`
  );
}

function fail(msg) {
  console.error(`sidequest: ${msg}`);
  process.exit(1);
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const { opts, positional } = parseArgs(argv.slice(1));

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || opts.help) {
    help();
    return;
  }

  switch (cmd) {
    case 'add':
    case 'new':
    case 'ticket':
      cmdAdd(opts);
      break;
    case 'list':
    case 'ls':
      cmdList(opts);
      break;
    case 'update':
    case 'edit':
    case 'set':
      cmdUpdate(opts, positional);
      break;
    case 'rm':
    case 'remove':
    case 'delete':
      cmdRm(opts, positional);
      break;
    case 'claim':
    case 'take':
      cmdClaim(opts, positional);
      break;
    case 'next':
    case 'grab':
      cmdNext(opts);
      break;
    case 'done':
    case 'complete':
    case 'finish':
      cmdDone(opts, positional);
      break;
    case 'release':
    case 'unclaim':
      cmdRelease(opts, positional);
      break;
    case 'assign':
      cmdAssign(opts, positional, false);
      break;
    case 'unassign':
      cmdAssign(opts, positional, true);
      break;
    case 'remind':
      cmdRemind(opts, positional);
      break;
    case 'unremind':
      cmdUnremind(opts, positional);
      break;
    case 'ask':
      opts.kind = 'question'; // `ask` always posts a question — never overridable by --kind
      cmdComment(opts, positional);
      break;
    case 'comment':
      cmdComment(opts, positional);
      break;
    case 'comments':
      cmdComments(opts, positional);
      break;
    case 'await':
    case 'wait':
      await cmdAwait(opts, positional);
      break;
    case 'link':
      cmdLink(opts, positional);
      break;
    case 'unlink':
      cmdUnlink(opts, positional);
      break;
    case 'ready':
      cmdReady(opts);
      break;
    case 'archive':
      cmdArchive(opts, positional);
      break;
    case 'unarchive':
    case 'restore':
      cmdUnarchive(opts, positional);
      break;
    case 'projects':
    case 'boards':
      cmdProjects(opts);
      break;
    case 'dashboard':
    case 'open':
    case 'board':
      await cmdDashboard(opts);
      break;
    case 'serve':
      await cmdServe(opts);
      break;
    case 'stop':
      cmdStop();
      break;
    default:
      fail(`unknown command "${cmd}". Run "sidequest help".`);
  }
}

main().catch((err) => {
  console.error(`sidequest: ${(err && err.message) || err}`);
  process.exit(1);
});
