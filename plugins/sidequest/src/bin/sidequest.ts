'use strict';
/**
 * sidequest - command-line interface
 *
 * The single entry point for board actions. Node stdlib only; cross-platform.
 *
 *   sidequest add -t "title" [-d desc] [-p priority] [-l label]... [-i image]... [-s status]
 *   sidequest list [--status todo] [--json]
 *   sidequest update <id|SQ-n> [-t] [-d] [-p] [-s] [-l ...] [-i ...]
 *   sidequest rm <id|SQ-n> [--force]
 *   sidequest comment <id|SQ-n> -m "body" [--by who]
 *   sidequest comments <id|SQ-n> [--json] [--full]
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
const fs = require('node:fs/promises');
const http = require('http');
const { spawn } = require('child_process');
const store = require('../lib/store');
const agentsync = require('../lib/agentsync');
const work = require('../lib/work');
const commitScope = require('../lib/commit-scope');
const worktrees = require('../lib/worktrees');
const { claimRefusalMessage } = require('../lib/refusal-guidance');

/* ------------------------------------------------------------------ *
 *  Arg parsing
 * ------------------------------------------------------------------ */

// Flags that may be repeated collect into arrays; everything else is a scalar.
const ARRAY_FLAGS = new Set(['image', 'label', 'file', 'always-in-scope', 'produces', 'changes', 'consumes']);
const ALIASES: any = {
  t: 'title',
  d: 'desc',
  p: 'priority',
  l: 'label',
  i: 'image',
  s: 'status',
  b: 'by',
  m: 'body',
};

function parseArgs(argv: any) {
  const opts: any = {};
  const positional: any = [];
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (a === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--') || a.startsWith('-')) {
      const isLong = a.startsWith('--');
      let key = a.replace(/^-+/, '');
      let val: any = null;
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
      if (key === 'no-worktree-isolation') {
        opts['worktree-isolation'] = false;
        continue;
      }
      // Boolean-ish flags don't consume a value.
      const BOOL = new Set(['json', 'brief', 'open', 'help', 'force', 'done', 'archived', 'all', 'dry-run', 'yolo', 'wave', 'unclassified', 'enabled', 'disabled', 'no-fallback', 'global', 'clear', 'steal', 'shared-tree', 'direct', 'sweep', 'yes', 'integration', 'contract-waiver', 'full', 'worktree-isolation']);
      if (val === null) {
        if (BOOL.has(key)) {
          opts[key] = true;
          continue;
        }
        val = argv[i + 1];
        i++;
      }
      if (key === 'project' && opts.project !== undefined) {
        opts.project = Array.isArray(opts.project) ? opts.project.concat(val) : [opts.project, val];
      } else if (ARRAY_FLAGS.has(key)) {
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

// --project resolves against already-registered boards (exact slug, a
// case-insensitive display NAME, or a registered path). A NAME or relative ref
// that matches nothing is an error, never a create — that's the SQ-86 hole: a
// bare name used to miss the slug check, fall into ensureProject(), and get
// silently registered as a fresh path-relative-to-cwd board.
//
// The ONE thing that may create is an ABSOLUTE path to a real directory (SQ-102):
// slugify() is a pure function of the normalized absolute path, so anchoring it
// through nearestRepoRoot + ensureProject is idempotent — it can only ever hit
// the canonical board for that repo, never mint a duplicate. This is what lets an
// agent working in project A file a ticket into project B (whose board may not
// exist yet) by passing B's absolute path. A name still can't create, because a
// name is ambiguous and is exactly what resolved against cwd before.
async function resolveProject(opts: any) {
  const arg = opts.project;
  if (arg) {
    const res = store.findProject(arg);
    if (res.ok) return { slug: res.slug, meta: res.meta };
    if (res.reason === 'ambiguous') {
      const lines = res.matches.map((p: any) => `    "${p.name}" -> ${p.path}`).join('\n');
      fail(`--project "${arg}" matches ${res.matches.length} boards named "${arg}" — pass the path to disambiguate:\n${lines}`);
    }
    // An absolute path to a real directory: create (or reuse) its board. The dir
    // must exist so a typo'd path fails loudly here instead of minting junk;
    // idempotent keying means this can never produce a duplicate of an existing
    // board. Anything non-absolute (a name, a relative ref) falls through to the
    // registered-only error below.
    if (path.isAbsolute(arg)) {
      let isDir = false;
      try { isDir = (await fs.stat(arg)).isDirectory(); } catch (_: any) { /* missing/unreadable -> not a dir */ }
      if (isDir) return store.ensureProject(store.nearestRepoRoot(path.resolve(arg)), opts.name);
    }
    const known = Array.from(new Set(res.known || []));
    fail(
      `--project "${arg}" does not match any registered board.` +
      (known.length ? ` Known projects: ${known.join(', ')}` : ' No projects are registered yet.')
    );
  }
  // Anchor to the git repo the agent is working in, not the raw cwd. The Bash
  // env here has no CLAUDE_PROJECT_DIR, so this used to fall straight to
  // process.cwd() — meaning a `cd` into any subfolder (e.g. bin/docai_refactored)
  // minted a brand-new board on that subfolder path, splitting one repo into
  // several duplicate boards. nearestRepoRoot() collapses any subfolder back to
  // its repo root; a non-repo folder is returned unchanged, so plain notes dirs
  // behave as before. --project (above) still targets any board explicitly.
  const start = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const dir = store.nearestRepoRoot(start);
  return store.ensureProject(dir, opts.name);
}

/* ------------------------------------------------------------------ *
 *  Commands
 * ------------------------------------------------------------------ */

const PRIORITY_MARK: any = { urgent: '!!', high: '!', normal: '', low: '·' };

// The human CLI mark names the task's neutral profile and the exact runtime
// Sidequest resolved for it. Claude Code may append its own native model suffix;
// that suffix is external metadata. The Sidequest route line and its generated
// backend-specific executor name are the authoritative runtime contract.
function modelMark(t: any) {
  if (!t.model && !t.effort) return '';
  const ex = t.exec || {};
  const runtime = ex.runsLabel || ex.runsModel || t.model || 'any';
  const backend = ex.backend || 'claude';
  const effort = t.effort ? ` · ${t.effort}` : '';
  return `  ⚙${runtime} · ${backend}${effort}`;
}

// Routing is derived from a task-complexity score (1..10) plus a written
// justification — the filing agent never tags a model/effort directly. `--model`
// and `--effort` are no longer accepted on either add or update. `requireScore`
// = add (a valid `--complexity` and a substantive `--why` are both mandatory).
const WHY_MIN = 20;
function failDirectRouting() {
  fail('--model/--effort are no longer set directly — score the task with --complexity (+ --why) and routing is derived from it (see sidequest models for the current ladder)');
}
function failComplexity() {
  fail('--complexity is required on every ticket — an integer 1-10 on the TASK-SHAPE scale: 1-2 subagent-shaped (spec says everything), 3-5 daily-coding-shaped (one area, known pattern), 6-7 complex-agentic-shaped (multi-file, shared contract), 8-10 larger-than-a-sitting (unknown root cause, architecture, research-grade). Normal coding lands ~1-7; 9-10 should fire rarely. Routing (model+effort) is derived from it.');
}
function failWhy() {
  fail('--why is required — motivate the complexity score against the actual task (min 20 chars). This is what makes the score honest.');
}
// Reject any explicit --model/--effort on add or update; the routing vocabulary
// is complexity-based now.
function guardDirectRouting(opts: any) {
  if (opts.model != null || opts.effort != null) failDirectRouting();
}

function categoryIdOrFail(slug: any, category: any) {
  const id = String(category || '').trim().toLowerCase();
  const valid = store.getCategories({ project: slug, includeDisabled: false }).map((entry: any) => entry.id);
  if (!valid.includes(id)) fail(`unknown category "${category}" — valid: ${valid.join(', ')}`);
  return id;
}

function categoryEcho(ticket: any) {
  if (!ticket || !ticket.category) return null;
  return {
    id: ticket.category.id,
    name: ticket.category.name,
    description: ticket.category.description,
    route: { model: ticket.model, effort: ticket.effort, executor: ticket.exec && ticket.exec.agent },
  };
}

function categoryEchoLine(ticket: any) {
  const category = categoryEcho(ticket);
  return category ? `  category: ${category.name} — ${category.description}  [${category.route.model} · ${category.route.effort}]` : '';
}

function validatedAddInput(opts: any) {
  if (!opts.title) fail('add: --title is required (e.g. sidequest add -t "Contact form does not send")');
  guardDirectRouting(opts);
  const complexity = store.coerceComplexity(opts.complexity);
  const category = opts.category == null ? null : String(opts.category).trim().toLowerCase();
  if (opts.category != null && !category) fail('add: --category needs an id.');
  if (!category && !opts.unclassified && complexity == null) fail('add: pass --category, legacy --complexity + --why, or --unclassified for a deliberately unclassified ticket');
  if (complexity != null && (!opts.why || String(opts.why).trim().length < WHY_MIN)) failWhy();
  if (!category && complexity == null && !opts.unclassified) failComplexity();
  if (opts.status != null && !store.VALID_STATUS.includes(String(opts.status).toLowerCase())) {
    fail(`add: invalid status "${opts.status}". Valid statuses: ${store.VALID_STATUS.join(', ')}.`);
  }
  return { category, complexity };
}

function contractsFromOpts(opts: any, current?: any) {
  const existing = store.normalizeContracts(current);
  return {
    produces: opts.produces === undefined ? existing.produces : opts.produces,
    changes: opts.changes === undefined ? existing.changes : opts.changes,
    consumes: opts.consumes === undefined ? existing.consumes : opts.consumes,
  };
}

function contractWaiverFromOpts(opts: any) {
  if (opts['contract-waiver'] === undefined) return undefined;
  return opts['contract-waiver'] !== false && String(opts['contract-waiver']).toLowerCase() !== 'false';
}

function readonlyFromOpts(opts: any) {
  if (opts.readonly === undefined) return undefined;
  if (String(opts.readonly).toLowerCase() !== 'false') fail('--readonly only accepts false; omit it to use the category default.');
  return false;
}

function addPreview(opts: any, category: any, complexity: any) {
  const priority = store.VALID_PRIORITY.includes(String(opts.priority || '').toLowerCase())
    ? String(opts.priority).toLowerCase()
    : 'normal';
  return {
    title: String(opts.title).trim().slice(0, 300) || 'Untitled',
    description: String(opts.desc || opts.description || '').trim(),
    status: String(opts.status || 'todo').toLowerCase(),
    priority,
    labels: opts.label || [],
    images: opts.image || [],
    files: opts.file || [],
    contracts: contractsFromOpts(opts),
    contractWaiver: contractWaiverFromOpts(opts) || false,
    readonly: readonlyFromOpts(opts),
    executorAnchors: opts.anchors || '',
    executorVerify: opts.verify || '',
    storyId: opts.story || null,
    category,
    complexity,
    complexityWhy: opts.why || '',
    source: opts.source || 'cli',
  };
}

async function cmdAdd(opts: any) {
  const input = validatedAddInput(opts);
  if (opts['dry-run']) {
    const ticket = addPreview(opts, input.category, input.complexity);
    if (opts.json) {
      process.stdout.write(JSON.stringify({ ok: true, dryRun: true, ticket }, null, 2) + '\n');
      return;
    }
    console.log(`Dry run: would create "${ticket.title}" [${ticket.status}/${ticket.priority}]`);
    console.log(JSON.stringify(ticket, null, 2));
    return;
  }
  const { slug, meta } = await resolveProject(opts);
  const category = input.category == null ? null : categoryIdOrFail(slug, input.category);
  const warnings: any = [];
  const created = store.createTicket(slug, {
    title: opts.title,
    description: opts.desc || opts.description || '',
    priority: opts.priority,
    status: opts.status,
    labels: opts.label,
    images: opts.image || [],
    files: opts.file,
    contracts: contractsFromOpts(opts),
    contractWaiver: contractWaiverFromOpts(opts),
    readonly: readonlyFromOpts(opts),
    executorAnchors: opts.anchors,
    executorVerify: opts.verify,
    storyId: opts.story,
    complexity: opts.complexity,
    complexityWhy: opts.why,
    category,
    source: opts.source || 'cli',
    onAssetError: (src: any) => warnings.push(`could not attach image: ${src}`),
  });
  // Re-read through getTicket so the returned ticket carries its derived
  // model/effort (stamped from complexity at read time) for display/JSON.
  const ticket = store.getTicket(slug, created.ref) || created;
  warnings.push(...store.ticketReferenceWarnings(slug, ticket.title, ticket.description));
  warnings.push(...store.ticketPlanningWarnings(ticket, meta.path));

  if (opts.json) {
    process.stdout.write(JSON.stringify({ ok: true, project: slug, projectName: meta.name, ticket, category: categoryEcho(ticket), warnings }, null, 2) + '\n');
    return;
  }
  const pr = PRIORITY_MARK[ticket.priority] ? ` ${PRIORITY_MARK[ticket.priority]}` : '';
  const imgs = ticket.assets.length ? ` (${ticket.assets.length} image${ticket.assets.length > 1 ? 's' : ''})` : '';
  const story = ticket.storyId ? store.getStory(slug, ticket.storyId) : null;
  const st = story ? `  ↳${story.ref}` : '';
  console.log(`✓ ${ticket.ref}${pr}  "${ticket.title}"  [${ticket.status}/${ticket.priority}]${imgs}${st}${modelMark(ticket)}  — ${meta.name}`);
  const categoryLine = categoryEchoLine(ticket);
  if (categoryLine) console.log(categoryLine);
  for (const w of warnings) console.log(`  ! ${w}`);
  const info = store.readServerInfo();
  if (info && info.url) console.log(`  board: ${info.url}`);
}

async function cmdList(opts: any) {
  const { slug, meta } = await resolveProject(opts);
  // --brief is a JSON shape, so it implies --json rather than silently no-oping.
  // Paging (--limit/--cursor/--all) rides the same store.listPayload as MCP, so
  // the shape can't drift. No paging flag = the whole set in one call (unchanged
  // full dump); --limit N + --cursor <nextCursor> walks a big board page by page.
  if (opts.json || opts.brief) {
    const payload = store.listPayload(slug, {
      status: opts.status, archived: opts.archived, brief: opts.brief,
      cursor: opts.cursor, limit: opts.limit, all: opts.all,
    });
    process.stdout.write(JSON.stringify(Object.assign({ project: slug, projectName: meta.name }, payload), null, 2) + '\n');
    return;
  }
  let tickets = store.listTickets(slug);
  // Archived tickets are hidden from the board by default; `--archived` shows only them.
  tickets = opts.archived ? tickets.filter((t: any) => t.archived) : tickets.filter((t: any) => !t.archived);
  if (opts.status) tickets = tickets.filter((t: any) => t.status === String(opts.status).toLowerCase());
  if (!tickets.length) {
    console.log(`No tickets in ${meta.name}.`);
    return;
  }
  console.log(`${meta.name} — ${tickets.length} ticket(s)`);
  const cols: any = { todo: 'TO DO', doing: 'DOING', done: 'DONE' };
  for (const status of store.VALID_STATUS) {
    const group = tickets.filter((t: any) => t.status === status);
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
      const files = t.files && t.files.length ? `  \u{1F4C1}${t.files.length}` : '';
      const readonly = t.readonlyOverride === false ? '  readonly:false' : '';
      console.log(`    ${t.ref}${pr}  ${t.title}${labels}${imgs}${files}${readonly}${cmt}${lnk}${blk}${clm}${asn}${modelMark(t)}`);
    }
  }
}

async function cmdPulse(opts: any, positional: any) {
  const idOrRef = positional[0];
  if (!idOrRef) fail('pulse: pass a ticket id or ref, e.g. sidequest pulse SQ-3');
  const { slug, meta } = await resolveProject(opts);
  const pulse = store.pulsePayload(slug, idOrRef);
  if (!pulse) fail(`pulse: no ticket "${idOrRef}" in ${meta.name}`);
  process.stdout.write(JSON.stringify(Object.assign({ project: slug, projectName: meta.name }, pulse), null, 2) + '\n');
}

async function cmdChanges(opts: any) {
  const { slug, meta } = await resolveProject(opts);
  const changes = store.changesPayload(slug, opts.since);
  process.stdout.write(JSON.stringify(Object.assign({ project: slug, projectName: meta.name }, changes), null, 2) + '\n');
}

async function cmdUpdate(opts: any, positional: any) {
  const idOrRef = positional[0];
  if (!idOrRef) fail('update: pass a ticket id or ref, e.g. sidequest update SQ-4 --status done');
  guardDirectRouting(opts); // --model/--effort are no longer accepted; route via --complexity
  const { slug, meta } = await resolveProject(opts);
  const current = store.getTicket(slug, idOrRef);
  const patch: any = {};
  if (opts.title != null) patch.title = opts.title;
  if (opts.desc != null || opts.description != null) patch.description = opts.desc != null ? opts.desc : opts.description;
  if (opts.status != null) patch.status = opts.status;
  if (opts.priority != null) patch.priority = opts.priority;
  if (opts.label != null) patch.labels = opts.label;
  if (opts.image != null) patch.images = opts.image;
  if (opts.file != null || opts.files != null) {
    const files = opts.file != null ? opts.file : opts.files;
    patch.files = (Array.isArray(files) && files.length === 1 && String(files[0]).toLowerCase() === 'none') || String(files).toLowerCase() === 'none' ? [] : files;
  }
  if (opts.produces !== undefined || opts.changes !== undefined || opts.consumes !== undefined) patch.contracts = contractsFromOpts(opts, current && current.contracts);
  if (opts['contract-waiver'] !== undefined) patch.contractWaiver = contractWaiverFromOpts(opts);
  if (opts.readonly !== undefined) patch.readonly = readonlyFromOpts(opts);
  if (opts.anchors != null) patch.executorAnchors = opts.anchors;
  if (opts.verify != null) patch.executorVerify = opts.verify;
  if (opts.assignee != null) patch.assignee = opts.assignee;
  if (opts.complexity != null) {
    // A changed score must arrive with a fresh justification — routing derives
    // from it, so an unmotivated re-score is rejected.
    if (!opts.why || String(opts.why).trim().length < WHY_MIN) fail('a changed score needs a fresh motivation — pass --why "<motivation>" (min 20 chars) alongside --complexity');
    patch.complexity = opts.complexity; // coerced/validated in store; invalid score is ignored there
    patch.complexityWhy = opts.why;
  }
  if (opts.story != null) patch.storyId = opts.story; // link (US-n / raw id) or clear ("none"/null)
  if (opts.category != null) patch.category = opts.category === 'none' ? null : categoryIdOrFail(slug, opts.category);
  patch.source = opts.source || 'cli'; // a CLI/subagent change (Claude), not the dashboard
  const saved = store.updateTicket(slug, idOrRef, patch);
  if (!saved) fail(`update: no ticket "${idOrRef}" in ${meta.name}`);
  // Re-read so derived model/effort (stamped from complexity at read time) show.
  const updated = store.getTicket(slug, saved.ref) || saved;
  const warnings: any = [
    ...store.ticketReferenceWarnings(slug, updated.title, updated.description),
    ...store.ticketPlanningWarnings(updated, meta.path),
  ];
  if (opts.json) {
    process.stdout.write(JSON.stringify({ ok: true, ticket: updated, category: opts.category != null ? categoryEcho(updated) : undefined, warnings }, null, 2) + '\n');
    return;
  }
  const story = updated.storyId ? store.getStory(slug, updated.storyId) : null;
  const st = story ? `  ↳${story.ref}` : '';
  console.log(`✓ ${updated.ref} updated  [${updated.status}/${updated.priority}]${st}${modelMark(updated)}  "${updated.title}"`);
  if (opts.category != null) {
    const categoryLine = categoryEchoLine(updated);
    if (categoryLine) console.log(categoryLine);
  }
  for (const warning of warnings) console.log(`  ! ${warning}`);
}

async function cmdProfile(opts: any, positional: any) {
  const action = String(positional[0] || '').toLowerCase();
  const id = positional[1];
  const print = (value: any) => process.stdout.write(JSON.stringify(value, null, 2) + '\n');
  const resolveBoard = async (value: any) => (await resolveProject({ project: value })).slug;

  if (action === 'hygiene') {
    const result = store.routingProfileHygiene();
    if (opts.json) return print(result);
    if (!result.proposals.length) {
      console.log('No routing profile hygiene proposals.');
      return;
    }
    for (const proposal of result.promotions) console.log(`promote  ${proposal.projects.join(', ')}  (${proposal.localRowCount} identical local rows)`);
    for (const proposal of result.drift) {
      const target = proposal.targetProfileId ? `repoint to ${proposal.targetProfileId}` : 'fork or promote';
      console.log(`${target}  ${proposal.project}  (${proposal.localRowCount}/${proposal.effectiveCategoryCount} local rows, ${proposal.foreignBaseCount} foreign-base)`);
    }
    for (const proposal of result.retirements) console.log(`retire  ${proposal.profileId}  (no board pointers)`);
    return;
  }

  if (action === 'list' || action === 'ls') {
    const profiles = store.listRoutingProfiles({ retired: !!opts.retired });
    if (opts.json) return print({ profiles });
    for (const profile of profiles) console.log(`${profile.id}  ${profile.name}  r${profile.revision}  (${profile.entryCount} categories)${profile.retiredAt ? '  retired' : ''}`);
    return;
  }
  if (action === 'show') {
    if (!id) fail('profile show: pass a profile id.');
    const profile = store.routingProfileDetails(id);
    if (!profile) fail(`profile show: no profile "${id}".`);
    if (opts.json) return print({ profile });
    console.log(`${profile.id}  ${profile.name}  r${profile.revision}`);
    if (profile.description) console.log(profile.description);
    for (const category of profile.categories) console.log(`  ${category.id}  ${category.name}  → ${category.route.model}·${category.route.effort}`);
    return;
  }
  if (action === 'create') {
    if (!id) fail('profile create: pass a profile id.');
    const result = store.createRoutingProfile(id, { from: opts.from, name: opts.name, description: opts.description || opts.desc });
    if (opts.json) return print({ ok: true, profile: store.routingProfileDetails(result.id) });
    console.log(`✓ created profile ${result.id} from ${result.from}`);
    return;
  }
  if (action === 'edit') {
    if (!id) fail('profile edit: pass a profile id.');
    if (opts.name == null && opts.description == null && opts.desc == null) fail('profile edit: pass --name or --description.');
    const result = store.editRoutingProfile(id, { name: opts.name, description: opts.description == null ? opts.desc : opts.description });
    if (opts.json) return print({ ok: true, profile: store.routingProfileDetails(result.id) });
    console.log(`✓ updated profile ${result.id}`);
    return;
  }
  if (action === 'retire') {
    if (!id) fail('profile retire: pass a profile id.');
    const result = store.retireRoutingProfile(id);
    if (opts.json) return print({ ok: true, profile: result });
    console.log(`✓ retired profile ${result.id}`);
    return;
  }
  if (action === 'use') {
    if (!id || opts.project == null || Array.isArray(opts.project)) fail('profile use: pass one profile and exactly one --project.');
    const project = await resolveBoard(opts.project);
    const result = store.setProjectRoutingProfile(project, id, opts.by || 'cli');
    if (opts.json) return print({ ok: true, assignment: result, config: store.boardConfig(project) });
    console.log(`✓ ${project} now uses profile ${id}`);
    return;
  }
  if (action === 'repoint') {
    const to = positional[2];
    if (!id || !to) fail('profile repoint: pass <from> <to>.');
    const result = store.repointRoutingProfiles(id, to, { dryRun: !!opts['dry-run'], assignedBy: opts.by || 'cli-repoint' });
    if (opts.json) return print(result);
    console.log(`${result.dryRun ? 'Preview' : 'Repointed'} ${result.boards.length} board${result.boards.length === 1 ? '' : 's'} from ${id} to ${to}`);
    for (const board of result.boards) console.log(`  ${board.project}  ${board.drift.hasDrift ? `drift: ${board.drift.changed.length} changed, ${board.drift.added.length} added, ${board.drift.missing.length} missing` : 'no drift'}`);
    return;
  }
  if (action === 'promote') {
    if (!id || !opts['from-project']) fail('profile promote: pass <new> --from-project <board> --project <board>...');
    const requested = opts.project == null ? [] : Array.isArray(opts.project) ? opts.project : [opts.project];
    if (!requested.length) fail('profile promote: pass at least one --project target.');
    const sourceProject = await resolveBoard(opts['from-project']);
    const projects = [];
    for (const project of requested) projects.push(await resolveBoard(project));
    const result = store.promoteRoutingProfile(id, sourceProject, projects, { name: opts.name, description: opts.description || opts.desc, assignedBy: opts.by || 'cli-promote' });
    if (opts.json) return print({ ok: true, promotion: result, profile: store.routingProfileDetails(id) });
    console.log(`✓ promoted ${sourceProject} to profile ${id} and repointed ${projects.length} board${projects.length === 1 ? '' : 's'}`);
    return;
  }
  if (action === 'new-board' || action === 'new_board') {
    if (id) store.setNewProjectRoutingProfile(id);
    const settings = store.routingProfileSettings();
    const profile = store.routingProfileDetails(settings.newProjectProfileId);
    if (opts.json) return print({ ok: true, newBoardProfile: profile });
    console.log(`New boards use ${profile.id}  ${profile.name}`);
    return;
  }
  fail(`profile: unknown action "${action}". Use hygiene | list | show | create | edit | retire | use | repoint | promote | new-board.`);
}

async function cmdCategory(opts: any, positional: any) {
  const action = String(positional[0] || '').toLowerCase();
  const id = positional[1];
  const projectScope = opts.project != null;
  const profileScope = opts.profile != null;
  if (projectScope && profileScope) fail(`category ${action || '<action>'}: pass exactly one of --profile or --project.`);
  const { slug, meta } = profileScope ? { slug: null, meta: null } : await resolveProject(Object.assign({}, opts, { name: undefined }));
  const scopeName = profileScope ? `profile ${opts.profile}` : meta.name;
  const usage = (categoryId: any) => profileScope ? 0 : store.listTickets(slug).filter((ticket: any) => (ticket.categoryId || (ticket.category && ticket.category.id)) === categoryId).length;
  const projectLayer = () => store.getProjectCategories(slug);
  const localRow = (categoryId: any) => projectLayer().rows.find((row: any) => row.id === String(categoryId).trim().toLowerCase()) || null;
  const details = (categoryId: any) => ({
    localRow: projectScope ? localRow(categoryId) : null,
    effective: profileScope
      ? store.routingProfileCategory(opts.profile, categoryId)
      : projectScope
        ? store.getCategory(categoryId, { project: slug })
        : store.getCategory(categoryId),
    warnings: projectScope ? projectLayer().warnings : [],
  });
  const output = (result: any) => {
    if (opts.json) process.stdout.write(JSON.stringify(Object.assign(profileScope ? { profile: String(opts.profile).toLowerCase() } : { project: slug, projectName: meta.name }, result), null, 2) + '\n');
  };
  const artifactRootsOption = () => {
    if (opts['artifact-roots'] == null || opts['artifact-roots'] === 'none') return [];
    return String(opts['artifact-roots']).split(',').map((entry) => entry.trim()).filter(Boolean);
  };
  const categoryInput = () => ({
    id,
    name: opts.name || opts.title || id,
    description: opts.desc != null ? opts.desc : opts.description || '',
    route: { model: opts['route-model'] || opts.model, effort: opts['route-effort'] || opts.effort },
    fallback: opts['no-fallback'] || opts['fallback-model'] === 'none'
      ? null
      : opts['fallback-model'] != null || opts['fallback-effort'] != null
        ? { model: opts['fallback-model'], effort: opts['fallback-effort'] }
        : null,
    contract: opts.contract || '',
    artifactRoots: artifactRootsOption(),
    enabled: !opts.disabled,
  });
  const patchFor = (existing: any) => {
    const route = Object.assign({}, existing.route);
    if (opts['route-model'] != null) route.model = opts['route-model'];
    if (opts['route-effort'] != null) route.effort = opts['route-effort'];
    const patch: any = { route };
    if (opts['no-fallback'] || opts['fallback-model'] === 'none') {
      patch.fallback = null;
    } else if (opts['fallback-model'] != null || opts['fallback-effort'] != null) {
      const fallback = Object.assign({}, existing.fallback || {});
      if (opts['fallback-model'] != null) fallback.model = opts['fallback-model'];
      if (opts['fallback-effort'] != null) fallback.effort = opts['fallback-effort'];
      patch.fallback = fallback;
    }
    if (opts.name != null || opts.title != null) patch.name = opts.name != null ? opts.name : opts.title;
    if (opts.desc != null || opts.description != null) patch.description = opts.desc != null ? opts.desc : opts.description;
    if (opts.contract != null) patch.contract = opts.contract;
    if (opts['artifact-roots'] != null) patch.artifactRoots = artifactRootsOption();
    return patch;
  };

  if (action === 'list' || action === 'ls') {
    const layer = profileScope ? { rows: [], warnings: [] } : projectLayer();
    const rows = layer.rows;
    const source = profileScope
      ? store.routingProfileEntries(opts.profile).map((entry: any) => Object.assign({}, entry.data, { origin: 'profile', profileId: String(opts.profile).toLowerCase(), baseProfileId: String(opts.profile).toLowerCase(), changedFields: [] }))
      : store.getCategories({ project: slug, withState: true });
    const categories = source.map((category: any) => {
      const row = rows.find((entry: any) => entry.id === category.id);
      const resolved = store.resolveCategoryRoute(category);
      return Object.assign({}, category, {
        localRow: row || null,
        ticketCount: usage(category.id),
        resolved: { model: resolved.model, effort: resolved.effort, exec: resolved.exec },
        warnings: [...(category.warnings || []), ...resolved.warnings],
      });
    });
    for (const row of rows.filter((entry: any) => entry.kind === 'DISABLE')) {
      categories.push({ id: row.id, origin: 'disabled', localRow: row, effective: null, ticketCount: usage(row.id), warnings: [] });
    }
    if (opts.json) {
      const profile = profileScope ? store.routingProfileDetails(opts.profile) : store.projectRoutingProfile(slug).profile;
      return output({ profile: { id: profile.id, name: profile.name, revision: profile.revision }, localRowCount: rows.length, categories, warnings: layer.warnings });
    }
    for (const category of categories) {
      if (category.origin === 'disabled') {
        console.log(`${category.id}  disabled here  (${category.ticketCount} ticket${category.ticketCount === 1 ? '' : 's'})`);
        continue;
      }
      const state = (category.linkState === 'overridden' || category.linkState === 'detached') ? '  customized' : '';
      console.log(`${category.id}  ${category.name}  → ${category.resolved.model}·${category.resolved.effort}  (${category.ticketCount} ticket${category.ticketCount === 1 ? '' : 's'})${state}`);
      for (const warning of category.warnings) console.log(`  ! ${warning}`);
    }
    for (const warning of layer.warnings) {
      if (warning.kind === 'dangling-override') console.log(`  ! ${warning.id} customization in ${warning.project} has no shared default`);
      else console.log(`  ! ${String(warning)}`);
    }
    return;
  }
  if (!id) fail(`category ${action || '<action>'}: pass a category id`);
  if (action === 'add' || action === 'new' || action === 'create') {
    try {
      const category = categoryInput();
      if (projectScope) store.setProjectCategory(slug, id, 'ADD', category);
      else if (profileScope) store.setRoutingProfileCategory(opts.profile, category);
      else store.setCategory(category);
    } catch (error: any) { fail(`category add: ${error.message}`); }
    const saved = details(id);
    if (opts.json) return output(projectScope ? Object.assign({ ok: true }, saved) : { ok: true, category: saved.effective });
    console.log(`✓ added category ${id}  — ${scopeName}`);
    return;
  }
  if (action === 'disable') {
    if (!projectScope) fail('category disable: pass --project to disable a category only for that project.');
    try { store.setProjectCategory(slug, id, 'DISABLE', {}); } catch (error: any) { fail(`category disable: ${error.message}`); }
    if (opts.json) return output(Object.assign({ ok: true }, details(id)));
    console.log(`✓ disabled category ${id} for ${meta.name}`);
    return;
  }
  if (action === 'enable') {
    if (!projectScope) fail('category enable: pass --project to remove a project-local disable.');
    const row = localRow(id);
    if (!row || row.kind !== 'DISABLE') fail(`category enable: "${id}" is not disabled for ${meta.name}`);
    try { store.removeProjectCategory(slug, id); } catch (error: any) { fail(`category enable: ${error.message}`); }
    if (opts.json) return output(Object.assign({ ok: true }, details(id)));
    console.log(`✓ enabled category ${id} for ${meta.name}`);
    return;
  }
  if (action === 'detach' || action === 'pin') {
    if (!projectScope) fail('category pin: pass --project to pin a category to this board.');
    let localRow;
    try { localRow = store.detachCategory(slug, id); } catch (error: any) { fail(`category pin: ${error.message}`); }
    if (opts.json) return output(Object.assign({ ok: true, localRow }, details(id)));
    console.log(`✓ pinned category ${id} for ${meta.name} (stops following the shared default)`);
    return;
  }
  if (action === 'relink' || action === 'reset') {
    if (!projectScope) fail('category reset: pass --project to reset a category to the shared default.');
    const row = localRow(id);
    if (!row || !['OVERRIDE', 'DETACH'].includes(row.kind)) fail(`category reset: "${id}" is not customized or pinned in ${meta.name}`);
    try { store.removeProjectCategory(slug, id); } catch (error: any) { fail(`category reset: ${error.message}`); }
    if (opts.json) return output(Object.assign({ ok: true, id: String(id).toLowerCase(), localRow: null }, details(id)));
    console.log(`✓ reset category ${id} to the shared default for ${meta.name}`);
    return;
  }
  if (action === 'edit' || action === 'update' || action === 'set') {
    if (projectScope && opts.disabled) {
      try { store.setProjectCategory(slug, id, 'DISABLE', {}); } catch (error: any) { fail(`category edit: ${error.message}`); }
    } else if (projectScope && opts.enabled && localRow(id) && localRow(id).kind === 'DISABLE') {
      try { store.removeProjectCategory(slug, id); } catch (error: any) { fail(`category edit: ${error.message}`); }
    } else if (projectScope) {
      const row = localRow(id);
      const existing = store.getCategory(id, { project: slug });
      if (!existing) fail(`category edit: no effective category "${id}" in ${meta.name}`);
      const patch = patchFor(existing);
      // Editing a board category forks it into a full, independent copy that no
      // longer follows the shared default (DETACH); a board-only category stays ADD.
      const kind = row && row.kind === 'ADD' ? 'ADD' : 'DETACH';
      try {
        store.setProjectCategory(slug, id, kind, Object.assign({}, existing, patch, { id }));
      } catch (error: any) { fail(`category edit: ${error.message}`); }
    } else if (profileScope) {
      const existing = store.routingProfileCategory(opts.profile, id);
      if (!existing) fail(`category edit: no category "${id}" in profile "${opts.profile}"`);
      const patch = patchFor(existing);
      if (opts.enabled || opts.disabled) patch.enabled = !!opts.enabled;
      try { store.setRoutingProfileCategory(opts.profile, id, patch); } catch (error: any) { fail(`category edit: ${error.message}`); }
    } else {
      const existing = store.getCategory(id);
      if (!existing) fail(`category edit: no shared category "${id}"`);
      const patch = patchFor(existing);
      if (opts.enabled || opts.disabled) patch.enabled = !!opts.enabled;
      try { store.setCategory(id, patch); } catch (error: any) { fail(`category edit: ${error.message}`); }
    }
    const saved = details(id);
    if (opts.json) return output(projectScope ? Object.assign({ ok: true }, saved) : { ok: true, category: saved.effective });
    console.log(`✓ updated category ${id}  — ${scopeName}`);
    return;
  }
  if (action === 'rm' || action === 'remove' || action === 'delete') {
    const ticketCount = usage(String(id).toLowerCase());
    try {
      if (projectScope) {
        if (localRow(id)) store.removeProjectCategory(slug, id);
        else store.setProjectCategory(slug, id, 'DISABLE', {});
      } else if (profileScope) {
        if (!store.removeRoutingProfileCategory(opts.profile, id)) fail(`category rm: no category "${id}" in profile "${opts.profile}"`);
      } else if (!store.removeCategory(id)) {
        fail(`category rm: no shared category "${id}"`);
      }
    } catch (error: any) { fail(`category rm: ${error.message}`); }
    if (opts.json) return output(Object.assign({ ok: true, id: String(id).toLowerCase(), ticketCount }, projectScope ? details(id) : {}));
    console.log(`✓ removed category ${id}  — ${scopeName}`);
    return;
  }
  fail(`category: unknown action "${action}". Use list | add | edit | rm | disable | enable | pin | reset.`);
}

async function cmdGlobalFallback(opts: any) {
  const { slug, meta } = await resolveProject(opts);
  if (opts.model == null && opts.effort == null) {
    const fallback = store.getRoutingFallback();
    if (opts.json) {
      process.stdout.write(JSON.stringify({ project: slug, projectName: meta.name, fallback }, null, 2) + '\n');
      return;
    }
    console.log(`Availability fallback: ${fallback ? `${fallback.model}·${fallback.effort}` : 'missing or invalid'}`);
    return;
  }
  try {
    const fallback = store.setRoutingFallback({ model: opts.model, effort: opts.effort });
    if (opts.json) {
      process.stdout.write(JSON.stringify({ ok: true, project: slug, projectName: meta.name, fallback }, null, 2) + '\n');
      return;
    }
    console.log(`✓ global fallback set to ${fallback.model}·${fallback.effort}  — ${meta.name}`);
  } catch (error: any) {
    fail(`global-fallback: ${error.message}`);
  }
}

async function cmdRm(opts: any, positional: any) {
  const idOrRef = positional[0];
  if (!idOrRef) fail('rm: pass a ticket id or ref, e.g. sidequest rm SQ-4');
  const { slug, meta } = await resolveProject(opts);
  const ticket = store.getTicket(slug, idOrRef);
  if (!ticket) fail(`rm: no ticket "${idOrRef}" in ${meta.name}`);
  if (ticket.claim && ticket.claim.by && !store.isClaimStale(ticket.claim) && !opts.force) {
    fail(`rm: ${ticket.ref} is live-claimed by "${ticket.claim.by}"; pass --force to permanently remove it.`);
  }
  if (!store.deleteTicket(slug, ticket.id)) fail(`rm: could not delete "${ticket.ref}" from ${meta.name}`);
  console.log(`✓ removed ${ticket.ref} from ${meta.name}`);
}

/* ------------------------------------------------------------------ *
 *  Claiming (safe hand-off to a worker)
 * ------------------------------------------------------------------ */

// A stable identity for the worker doing the claim, so the same worker can later
// release/complete it. Pass --by to be explicit; otherwise fall back to an env
// hint or the machine name. Distinct concurrent workers should pass distinct --by.
function workerId(opts: any) {
  return String(
    opts.by || process.env.SIDEQUEST_AGENT || process.env.CLAUDE_SESSION_ID || 'agent@' + os.hostname()
  );
}

// The session a claim is taken under, so a SessionEnd / SubagentStop hook can
// release exactly that session's claims immediately instead of waiting out the
// TTL (see store.reconcileSession). An explicit --session wins; otherwise fall
// back to the CLAUDE_SESSION_ID the Claude Code runtime exports to tool/hook
// subprocesses. Null when neither is present — the whole registry stays dormant
// and the TTL remains the (unchanged) backstop, so nothing regresses.
function sessionId(opts: any) {
  const v =
    (opts && opts.session) ||
    process.env.CLAUDE_CODE_SESSION_ID || // the id the runtime actually exports to tool subprocesses
    process.env.CLAUDE_SESSION_ID ||      // tolerated legacy/alt spelling
    process.env.SIDEQUEST_SESSION ||
    '';
  return String(v).trim() || null;
}

function reportClaimFailure(action: any, idOrRef: any, res: any, meta: any) {
  process.exitCode = 1;
  console.log(`✗ ${res.message || claimRefusalMessage(res.reason, idOrRef, res.ticket || res.claim, meta.path)}`);
}

// An executor is spawned as `sidequest-exec-<effort>`, its effort baked into the
// agent file. When it claims, it passes that baked `--effort`, and it must equal
// the ticket's currently-derived effort — otherwise the wrong-tier agent was
// spawned (the real bug: `sidequest-exec-medium` claiming a `sonnet·high` ticket
// because the orchestrator hand-picked an effort off the ladder, medium being
// disabled). Capping never trips this: a cap lowers the MODEL and leaves effort
// untouched (opus·max on a sonnet main loop still spawns exec-max), so a matching
// effort is exactly the invariant a cap preserves. Returns a drift descriptor to
// block the claim, or null when there's nothing to enforce: no `--effort` given,
// routing off, or no derived route.
function effortDriftReason(slug: any, idOrRef: any, claimedEffort: any) {
  if (claimedEffort == null) return null;
  const t = store.getTicket(slug, idOrRef);
  if (!t) return null;
  const derivedEffort = t.effort || (store.CLAUDE_RUNTIMES.includes(t.model) ? 'low' : null);
  if (!derivedEffort) return null;
  const claimed = String(claimedEffort).toLowerCase();
  if (claimed === derivedEffort) return null;
  const resolved = store.resolveExec(t.model, derivedEffort);
  const execName = (t.exec && t.exec.agent) || (resolved && resolved.agent) || `sidequest-exec-${derivedEffort}`;
  const modelHint = t.exec && t.exec.model ? ` (model ${t.exec.model})` : '';
  return {
    ref: t.ref,
    derivedModel: t.model,
    derivedEffort,
    claimedEffort: claimed,
    message:
      `${t.ref} resolves to ${t.model}·${derivedEffort}, but you claimed as ${claimed} effort. ` +
      `Run sidequest dispatch ${t.ref}, then spawn ${execName}${modelHint}. The ticket remains free for that executor.`,
  };
}

// `ready --model`/`next --model` used to coerce an unrecognized value straight
// to "no filter" (coerceModel returns null for garbage the same as it does for
// blank/any/none) — a silent footgun: a typo'd tier quietly returned the WHOLE
// board instead of erroring. classifyModelFilter (SQ-156/157) can tell the two
// apart; refuse the unrecognized case here instead of letting it fall through.
// Returns false (and has already reported the error) when the caller should
// bail without touching the store; true when opts.model is fine to pass on.
function validateModelFilter(action: any, opts: any) {
  if (opts.model == null) return true;
  const cls = store.classifyModelFilter(opts.model);
  if (cls !== 'unknown') return true;
  const message = `unknown model "${opts.model}" — known: ${store.getModelVocab().models.join(', ')}`;
  process.exitCode = 1;
  if (opts.json) {
    process.stdout.write(JSON.stringify({ ok: false, reason: 'unknown_model', message }, null, 2) + '\n');
  } else {
    console.log(`✗ ${action}: ${message}`);
  }
  return false;
}

function executorDriftReason(slug: any, idOrRef: any, claimedEffort: any, executorName: any, token: any, direct: any) {
  if (direct) return null;
  const effortDrift = effortDriftReason(slug, idOrRef, claimedEffort);
  if (effortDrift) return effortDrift;
  const t = store.getTicket(slug, idOrRef);
  if (t && store.isSupersededDispatchToken(t, token)) {
    return {
      reason: 'token',
      ref: t.ref,
      message: `${t.ref}'s dispatch was superseded by a newer preparation. Re-run sidequest dispatch ${t.ref} and use its returned token.`,
    };
  }
  if (t && t.dispatchNonce && token === t.dispatchNonce && executorName !== t.dispatchExecutor) {
    return {
      reason: 'executor_mismatch',
      ref: t.ref,
      derivedModel: t.model,
      derivedEffort: t.effort,
      executor: executorName || null,
      expectedExecutor: t.dispatchExecutor,
      message: `${t.ref} has a prepared dispatch for ${t.dispatchExecutor}, not ${executorName || 'this executor'}. Re-run sidequest dispatch ${t.ref} and claim with its returned executor and token.`,
    };
  }
  if (t && t.dispatchNonce && token === t.dispatchNonce && executorName === t.dispatchExecutor) return null;
  if (!executorName) return null;
  if (!t || !t.exec || t.exec.backend !== 'codex') return null;
  const expected = t.exec.agent;
  if (executorName === expected) return null;
  return {
    ref: t.ref,
    derivedModel: t.model,
    derivedEffort: t.effort,
    backend: t.exec.backend,
    runsLabel: t.exec.runsLabel,
    executor: executorName,
    expectedExecutor: expected,
    message:
      `${t.ref} resolves to ${t.exec.runsLabel} · ${t.effort} (${t.exec.backend}), but ${executorName} is not its generated executor. ` +
      `Run sidequest dispatch ${t.ref}, then spawn ${expected}. The ticket remains free for the authoritative runtime.`,
  };
}

function claimPlanningWarnings(ticket: any, projectPath: any) {
  const warnings = store.ticketPlanningWarnings(ticket, projectPath);
  if (!warnings.length) return [];
  return warnings.map((warning: any) => `Dispatch context warning: ${warning.replace('Planning-depth warning: ', '')}`);
}

async function cmdClaim(opts: any, positional: any) {
  const idOrRef = positional[0];
  if (!idOrRef) fail('claim: pass a ticket id or ref, e.g. sidequest claim SQ-3 --by me');
  const { slug, meta } = await resolveProject(opts);
  const by = workerId(opts);
  // Guard before claiming so a wrong-tier claim leaves the ticket untouched.
  const drift = executorDriftReason(slug, idOrRef, opts.effort, opts.executor, opts.token, !!opts.direct);
  if (drift) {
    if ((drift as any).reason === 'executor_mismatch') {
      drift.message = claimRefusalMessage('executor_mismatch', idOrRef, store.getTicket(slug, idOrRef) || {}, meta.path);
    }
    process.exitCode = 1;
    if (opts.json) {
      process.stdout.write(JSON.stringify(Object.assign({ ok: false, reason: (drift as any).reason || 'effort_mismatch', project: slug }, drift), null, 2) + '\n');
    } else {
      console.log(`✗ ${drift.message}`);
    }
    return;
  }
  const res = store.claimTicket(slug, idOrRef, by, { force: !!opts.force, direct: !!opts.direct, reason: opts.reason, token: opts.token, executor: opts.executor, source: opts.source || 'cli', sessionId: sessionId(opts) });
  const warnings = res.ok ? claimPlanningWarnings(res.ticket, meta.path) : [];
  if (opts.json) {
    const payload = Object.assign({ project: slug }, res, { warnings });
    if (!res.ok) payload.message = claimRefusalMessage(res.reason, idOrRef, res.ticket || res.claim, meta.path);
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    if (!res.ok) process.exitCode = 1;
    return;
  }
  if (res.ok) {
    console.log(`✓ claimed ${res.ticket.ref} as "${by}"  [${res.ticket.status}]  — ${meta.name}`);
    console.log(`  "${res.ticket.title}"`);
    for (const warning of warnings) console.log(`  ! ${warning}`);
  } else {
    reportClaimFailure('claim', idOrRef, res, meta);
  }
}

async function cmdCheckpoint(opts: any, positional: any) {
  const idOrRef = positional[0];
  if (!idOrRef) fail('checkpoint: pass a ticket ref, e.g. sidequest checkpoint SQ-3 --by me --commit <hash> --verify "command: passed"');
  const { slug, meta } = await resolveProject(opts);
  const by = workerId(opts);
  let res;
  try {
    res = store.checkpointTicket(slug, idOrRef, by, {
      commit: opts.commit,
      worktree: opts.worktree,
      verify: opts.verify,
      ttlMinutes: opts['ttl-minutes'],
      source: opts.source || 'cli',
    });
  } catch (e: any) {
    fail(`checkpoint: ${(e && e.message) || e}`);
  }
  if (opts.json) {
    process.stdout.write(JSON.stringify(Object.assign({ project: slug }, res), null, 2) + '\n');
    if (!res.ok) process.exitCode = 1;
    return;
  }
  if (res.ok) {
    console.log(`✓ ${res.ticket.ref} live review checkpoint ${res.checkpoint.id} [${res.checkpoint.state}] until ${res.checkpoint.expiresAt}: ${meta.name}`);
    console.log(`  claim remains held by "${by}"; dispatch remains active`);
  } else {
    reportClaimFailure('checkpoint', idOrRef, res, meta);
  }
}

function closeDispatchExecutor(ticket: any) {
  if (ticket && ticket.dispatchExecutor) agentsync.cleanupNativeAgents({ name: ticket.dispatchExecutor });
}

async function cmdRelease(opts: any, positional: any) {
  const idOrRef = positional[0];
  if (!idOrRef) fail('release: pass a ticket id or ref, e.g. sidequest release SQ-3');
  const { slug, meta } = await resolveProject(opts);
  const by = workerId(opts);
  const ticket = store.getTicket(slug, idOrRef);
  const res = store.releaseTicket(slug, idOrRef, by, { force: !!opts.force, status: opts.status, source: opts.source || 'cli', sessionId: sessionId(opts) });
  if (res.ok) closeDispatchExecutor(ticket);
  if (opts.json) {
    process.stdout.write(JSON.stringify(Object.assign({ project: slug }, res), null, 2) + '\n');
    if (!res.ok) process.exitCode = 1;
    return;
  }
  if (res.ok) console.log(`✓ released ${res.ticket.ref}  [${res.ticket.status}]  — ${meta.name}`);
  else reportClaimFailure('release', idOrRef, res, meta);
}

async function bodyFromOpts(opts: any, command: any) {
  if (opts.body != null && opts['body-file'] != null) fail(`${command}: pass either -m/--body or --body-file, not both`);
  if (opts['body-file'] == null) return opts.body;
  try {
    return await fs.readFile(String(opts['body-file']), 'utf8');
  } catch (e: any) {
    fail(`${command}: couldn't read --body-file "${opts['body-file']}": ${(e && e.message) || e}`);
  }
}

function addBodyComment(slug: any, idOrRef: any, by: any, body: any, source: any) {
  if (!body || !String(body).trim()) return null;
  return store.addComment(slug, idOrRef, { by, body, kind: 'comment', source });
}

async function cmdDone(opts: any, positional: any) {
  const idOrRef = positional[0];
  if (!idOrRef) fail('done: pass a ticket id or ref, e.g. sidequest done SQ-3');
  const { slug, meta } = await resolveProject(opts);
  const by = workerId(opts);
  const body = await bodyFromOpts(opts, 'done');
  // Optional self-reported provenance: which tier/effort actually worked this
  // ticket. Invalid values throw from the store; surface them as a clean error.
  const ticket = store.getTicket(slug, idOrRef);
  let res;
  try {
    res = store.completeTicket(slug, idOrRef, by, {
      force: !!opts.force,
      source: opts.source || 'cli',
      model: opts.model,
      effort: opts.effort,
      body,
      sessionId: sessionId(opts),
    });
  } catch (e: any) {
    fail(`done: ${(e && e.message) || e}`);
  }
  if (res.ok && !res.idempotent) {
    closeDispatchExecutor(ticket);
  }
  if (opts.json) {
    process.stdout.write(JSON.stringify(Object.assign({ project: slug }, res), null, 2) + '\n');
    if (!res.ok) process.exitCode = 1;
    return;
  }
  if (res.ok) {
    console.log(`✓ ${res.ticket.ref} done  — ${meta.name}`);
    if (res.advisory) console.log(`  advisory: ${res.advisory}`);
  }
  else reportClaimFailure('complete', idOrRef, res, meta);
}

async function cmdGroomClose(opts: any, positional: any) {
  const idOrRef = positional[0];
  if (!idOrRef) fail('groom-close: pass a ticket id or ref, e.g. sidequest groom-close SQ-3 --reason "Already shipped in abc1234."');
  const reason = String(opts.reason || '').trim();
  if (!reason) fail('groom-close: pass --reason with the evidence for this administrative closure.');
  const { slug, meta } = await resolveProject(opts);
  const by = workerId(opts);
  const ticket = store.getTicket(slug, idOrRef);
  const purpose = opts.integration ? 'integration' : 'grooming';
  const res = store.completeTicketAsControlPlane(slug, idOrRef, { by, reason, purpose });
  if (res.ok && !res.idempotent) closeDispatchExecutor(ticket);
  if (opts.json) {
    process.stdout.write(JSON.stringify(Object.assign({ project: slug }, res), null, 2) + '\n');
    if (!res.ok) process.exitCode = 1;
    return;
  }
  if (res.ok) console.log(`✓ ${res.ticket.ref} closed after ${purpose}  — ${meta.name}`);
  else reportClaimFailure('groom-close', idOrRef, res, meta);
}

const OUT_OF_SCOPE_COMMENT_MAX = 16000;

function outOfScopeComment(paths: any[]) {
  const prefix = 'out-of-scope changes present: ';
  const complete = `${prefix}${paths.join(', ')} — widen scope + second commit, or discard`;
  if (complete.length <= OUT_OF_SCOPE_COMMENT_MAX) return complete;
  for (let shown = paths.length - 1; shown >= 0; shown -= 1) {
    const omitted = paths.length - shown;
    const suffix = `… +${omitted} more (run git status in the worktree for the full list)`;
    const body = `${prefix}${paths.slice(0, shown).join(', ')}${shown ? ' ' : ''}${suffix}`;
    if (body.length <= OUT_OF_SCOPE_COMMENT_MAX) return body;
  }
  return `${prefix}… +${paths.length} more (run git status in the worktree for the full list)`;
}

function scopeRemedy(ticket: any, paths: any[]) {
  return store.scopeExpansionCommand(ticket, paths);
}

async function cmdScopeRequest(opts: any, positional: any) {
  const idOrRef = positional[0];
  if (!idOrRef) fail('scope-request: pass a ticket ref, e.g. sidequest scope-request SQ-3 --file path/to/new-file.');
  const files = opts.file != null ? opts.file : opts.files;
  if (files == null) fail('scope-request: pass one or more requested paths with --file or --files.');
  const { slug, meta } = await resolveProject(opts);
  const by = workerId(opts);
  const res = store.requestScope(slug, idOrRef, by, files, { source: opts.source || 'cli', force: !!opts.force });
  if (opts.json) {
    process.stdout.write(JSON.stringify(Object.assign({ project: slug }, res), null, 2) + '\n');
    if (!res.ok) process.exitCode = 1;
    return;
  }
  if (res.ok) {
    console.log(`✓ ${res.ticket.ref} scope expansion requested; claim remains held — ${meta.name}`);
    console.log(`  pause for approval: ${res.command}`);
  } else {
    reportClaimFailure('scope-request', idOrRef, res, meta);
  }
}

async function cmdCommit(opts: any, positional: any) {
  const idOrRef = positional[0];
  if (!idOrRef) fail('commit: pass a ticket ref, e.g. sidequest commit SQ-3 --by me --message "fix the thing".');
  if (!opts.message) fail('commit: pass --message for the scoped commit.');
  const { slug, meta } = await resolveProject(opts);
  const ticket = store.getTicket(slug, idOrRef);
  const by = workerId(opts);
  if (!ticket) fail(`commit: no ticket "${idOrRef}" in ${meta.name}.`);
  if (!ticket.claim || ticket.claim.by !== by) fail(`commit: ${ticket.ref} must be claimed by "${by}" before committing.`);
  const scope = store.effectiveScope(slug, ticket.files);
  const result = commitScope.commitScoped(process.cwd(), opts.message, scope);
  if (!result.ok) {
    if (result.reason === 'missing_scope') fail(`commit: ${ticket.ref} has no declared file scope; use the explicit shared-tree escape hatch only for uncommitted-state work, not commits.`);
    if (result.reason === 'outside_scope') {
      fail(`commit: refused ${ticket.ref}; commit contains paths outside its declared scope: ${result.outside.join(', ')}. Expand scope with: ${scopeRemedy(ticket, result.outside)}`);
    }
    if (result.reason === 'no_existing_scope') fail(`commit: ${ticket.ref} has no declared paths that exist in this worktree. Missing: ${(result.missingScopes || []).join(', ')}.`);
    fail(`commit: git failed: ${result.message || result.reason}`);
  }
  const warnings: string[] = [];
  if (result.unscopedPaths.length) {
    const comment = store.addComment(slug, ticket.ref, { by, body: outOfScopeComment(result.unscopedPaths), kind: 'comment', source: 'cli' });
    if (!comment.ok) warnings.push(`out-of-scope paths weren't recorded: ${comment.reason}`);
  }
  if (opts.json) {
    process.stdout.write(JSON.stringify({
      project: slug,
      ref: ticket.ref,
      commit: result.commit,
      paths: result.paths,
      missingScopes: result.missingScopes,
      unscopedPaths: result.unscopedPaths,
      ...(warnings.length ? { warnings } : {}),
    }, null, 2) + '\n');
    return;
  }
  warnings.push(
    result.missingScopes.length ? `missing declared paths: ${result.missingScopes.join(', ')}` : '',
    result.unscopedPaths.length ? `out-of-scope changes: ${result.unscopedPaths.join(', ')}` : '',
  );
  const visibleWarnings = warnings.filter(Boolean);
  console.log(`✓ ${ticket.ref} committed ${result.commit.slice(0, 12)} (${result.paths.join(', ')})${visibleWarnings.length ? `\n  ${visibleWarnings.join('\n  ')}` : ''}`);
}

// Executor terminal for repo-changing tickets: park verified, committed work as
// READY_FOR_INTEGRATION instead of publishing it. The orchestrator's publish
// transaction (references/publishing.md) integrates, versions, reverifies,
// pushes, and marks done. --clear is the orchestrator's reset for a bounced
// integration (drops the submission, optionally with -s todo).
function verifyEmbedsWorktreeRoot(verify: any, worktreeRoot: any) {
  if (typeof verify !== 'string' || !verify || !worktreeRoot) return false;
  const normalize = (value: any) => String(value).replace(/[\\/]+/g, '/').replace(/\/+$/, '');
  const root = normalize(path.resolve(worktreeRoot));
  const command = normalize(verify);
  const caseInsensitive = /^[a-z]:\//i.test(root);
  const comparableRoot = caseInsensitive ? root.toLowerCase() : root;
  const comparableCommand = caseInsensitive ? command.toLowerCase() : command;
  let offset = comparableCommand.indexOf(comparableRoot);
  while (offset !== -1) {
    const next = comparableCommand.charAt(offset + comparableRoot.length);
    if (!next || next === '/' || !/[a-z0-9._-]/i.test(next)) return true;
    offset = comparableCommand.indexOf(comparableRoot, offset + comparableRoot.length);
  }
  return false;
}

async function cmdSubmit(opts: any, positional: any) {
  const idOrRef = positional[0];
  if (!idOrRef) fail('submit: pass a ticket id or ref, e.g. sidequest submit SQ-3 --by me --commit <hash>');
  const { slug, meta } = await resolveProject(opts);
  const by = workerId(opts);
  if (opts.clear) {
    const res = store.clearSubmission(slug, idOrRef, { status: opts.status, source: opts.source || 'cli' });
    if (opts.json) {
      process.stdout.write(JSON.stringify(Object.assign({ project: slug }, res), null, 2) + '\n');
      if (!res.ok) process.exitCode = 1;
      return;
    }
    if (res.ok) console.log(`✓ cleared submission on ${res.ticket.ref}  [${res.ticket.status}]  — ${meta.name}`);
    else reportClaimFailure('clear submission', idOrRef, res, meta);
    return;
  }
  const body = await bodyFromOpts(opts, 'submit');
  const ticket = store.getTicket(slug, idOrRef);
  if (!ticket) fail(`submit: no ticket "${idOrRef}" in ${meta.name}.`);
  if (verifyEmbedsWorktreeRoot(opts.verify, store.nearestRepoRoot(process.cwd()))) {
    fail(`submit: refused ${ticket.ref}; --verify embeds this worktree path. Run verification from the repo root and use repo-relative paths.`);
  }
  const gitRef = opts.gitref || opts['git-ref'] || `refs/sidequest/${ticket.ref}`;
  const target = store.integrationTarget(slug);
  const allowedBases = store.submissionBaseCandidates(slug, ticket.ref);
  const range = commitScope.submissionRange(process.cwd(), {
    commit: opts.commit,
    gitRef,
    upstream: target.upstream,
    integrationBranch: target.branch,
    base: opts.base,
    allowedBases,
    baseCandidates: opts.base ? [] : store.submissionBaseCandidates(slug, ticket.ref, { integratedOnly: true }),
  });
  if (!range.ok) {
    fail(`submit: refused ${ticket.ref}; ${range.reason}${range.message ? `: ${range.message}` : ''}.`);
  }
  const duplicate = store.submissionsPayload(slug).tickets
    .filter((entry: any) => entry.ref !== ticket.ref)
    .find((entry: any) => {
      const commits = Array.isArray(entry.submission.commits) && entry.submission.commits.length
        ? entry.submission.commits
        : [entry.submission.commit];
      return commits.some((commit: any) => range.commits.includes(commit));
    });
  if (duplicate) fail(`submit: refused ${ticket.ref}; its range includes commit(s) already submitted by ${duplicate.ref}.`);
  const scope = store.effectiveScope(slug, ticket.files);
  const scopedRange = commitScope.validateCommitRangeScope(process.cwd(), range.commits, scope);
  if (!scopedRange.ok) {
    if (scopedRange.reason === 'missing_scope') fail(`submit: ${ticket.ref} has no declared file scope, so its range cannot be admitted for integration.`);
    if (scopedRange.reason === 'outside_scope') {
      fail(`submit: refused ${ticket.ref}; submitted range changes paths outside its declared scope: ${scopedRange.outside.join(', ')}. Expand scope with: ${scopeRemedy(ticket, scopedRange.outside)}`);
    }
    fail(`submit: could not inspect ${opts.commit} from this worktree: ${scopedRange.message || scopedRange.reason}`);
  }
  const unscopedPaths = commitScope.unscopedWorkingPaths(process.cwd(), scope);
  let res;
  try {
    res = store.submitTicket(slug, idOrRef, by, {
      commit: range.commit,
      gitRef,
      range: Object.assign({}, range, { integrationMode: target.mode }),
      verify: opts.verify,
      worktree: opts.worktree,
      unscopedPaths,
      force: !!opts.force,
      source: opts.source || 'cli',
      sessionId: sessionId(opts),
    });
  } catch (e: any) {
    fail(`submit: ${(e && e.message) || e}`);
  }
  if (res.ok) {
    const comment = addBodyComment(slug, idOrRef, by, body, opts.source || 'cli');
    if (comment && !comment.ok) fail(`submit: recorded ${idOrRef}, but couldn't add evidence comment: ${comment.reason}`);
    if (comment && comment.advisory) res.advisory = comment.advisory;
  }
  if (opts.json) {
    process.stdout.write(JSON.stringify(Object.assign({ project: slug }, res), null, 2) + '\n');
    if (!res.ok) process.exitCode = 1;
    return;
  }
  if (res.ok) {
    const s = res.ticket.submission;
    console.log(`✓ ${res.ticket.ref} READY_FOR_INTEGRATION (${s.commit.slice(0, 12)} @ ${s.gitRef})  — ${meta.name}`);
    console.log(s.integrationMode === 'local'
      ? '  claim released; the orchestrator integrates and reverifies against local main, then marks done without pushing.'
      : '  claim released; the orchestrator publish transaction integrates, reverifies, pushes, and marks done.');
    if (res.advisory) console.log(`  advisory: ${res.advisory}`);
  } else {
    reportClaimFailure('submit', idOrRef, res, meta);
  }
}

// Orchestrator control-plane surface: the cross-process publish lock plus the
// integration queue. The lock file lives in the repo's common git dir so every
// worktree/session/process serializes on the same publish transaction.
async function cmdPublish(opts: any, positional: any) {
  const publish = require('../lib/publish');
  const sub = positional[0];
  const emit = (payload: any, failed: any) => {
    if (opts.json) {
      process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
      if (failed) process.exitCode = 1;
      return true;
    }
    return false;
  };
  if (sub === 'queue') {
    const { slug, meta } = await resolveProject(opts);
    const payload = store.submissionsPayload(slug);
    for (const ticket of payload.tickets) {
      ticket.rangeValidation = ticket.submission.base
        ? commitScope.validateStoredSubmissionRange(meta.path, ticket.submission)
        : { ok: false, reason: 'legacy_submission' };
    }
    if (emit(Object.assign({ project: slug }, payload), false)) return;
    if (!payload.count) {
      console.log(`no submissions awaiting integration in ${meta.name}.`);
      return;
    }
    console.log(`${payload.count} submission(s) awaiting integration — ${meta.name}:`);
    for (const t of payload.tickets) {
      const commits = Array.isArray(t.submission.commits) && t.submission.commits.length ? t.submission.commits : [t.submission.commit];
      const paths = Array.isArray(t.submission.changedPaths) ? t.submission.changedPaths : [];
      console.log(`  ${t.ref}  ${commits.length} commit(s), tip ${t.submission.commit.slice(0, 12)} @ ${t.submission.gitRef}  (by ${t.submission.by}, ${t.submission.at})`);
      console.log(`      commits: ${commits.map((commit: any) => commit.slice(0, 12)).join(', ')}`);
      console.log(`      paths: ${paths.join(', ') || '(legacy submission: unavailable)'}`);
      if (!t.rangeValidation.ok) console.log(`      REJECTED: ${t.rangeValidation.reason}`);
      if (t.submission.verify) console.log(`      verify: ${t.submission.verify}`);
    }
    return;
  }
  const repo = opts.repo ? path.resolve(String(opts.repo)) : (await resolveProject(opts)).meta.path;
  if (sub === 'lock') {
    const res = await publish.acquirePublishLock(repo, {
      by: workerId(opts),
      sessionId: sessionId(opts),
      steal: !!opts.steal,
      transient: true, // the CLI process exits now; its session holds the lock
    });
    if (emit(res, !res.ok)) return;
    if (res.ok) {
      console.log(`✓ publish lock ${res.reacquired ? 're-acquired' : 'acquired'}: ${res.file}`);
    } else {
      process.exitCode = 1;
      const h = res.holder || {};
      console.log(`✗ publish lock held by "${h.by || h.sessionId || 'unknown'}" (pid ${h.pid}, since ${h.at}) — retry after it releases, or --steal a dead holder.`);
    }
    return;
  }
  if (sub === 'unlock') {
    const res = await publish.releasePublishLock(repo, { by: workerId(opts), sessionId: sessionId(opts), force: !!opts.force });
    if (emit(res, !res.ok)) return;
    if (res.ok) console.log(res.released ? `✓ publish lock released: ${res.file}` : 'publish lock was not held.');
    else {
      process.exitCode = 1;
      const h = res.holder || {};
      console.log(`✗ publish lock belongs to "${h.by || h.sessionId || 'unknown'}" (pid ${h.pid}, since ${h.at}) — not yours to release without --force.`);
    }
    return;
  }
  if (sub === 'status') {
    const res = await publish.publishLockStatus(repo);
    if (emit(res, false)) return;
    if (!res.locked) {
      console.log(`publish lock free: ${res.file}`);
    } else {
      const h = res.holder || {};
      console.log(`publish lock HELD${res.stale ? ' (STALE — reclaimable)' : ''}: ${res.file}`);
      console.log(`  by "${h.by || 'unknown'}"  session ${h.sessionId || '-'}  pid ${h.pid}  host ${h.host}  since ${h.at}`);
    }
    return;
  }
  fail('publish: expected `sidequest publish lock|unlock|status|queue`');
}

async function cmdSweepClaims(opts: any) {
  const { slug, meta } = await resolveProject(opts);
  const res = store.sweepStaleClaims({ project: slug, source: opts.source || 'cli' });
  if (opts.json) {
    process.stdout.write(JSON.stringify(Object.assign({ project: slug }, res), null, 2) + '\n');
    return;
  }
  console.log(`✓ swept ${res.released.length} stale claim(s) from ${meta.name} (TTL ${Math.round(res.ttlMs / 60000)}m)`);
}

async function cmdWorktrees(opts: any, positional: any) {
  const action = String(positional[0] || '').toLowerCase();
  if ((action && action !== 'sweep') || (!action && !opts.sweep)) {
    fail('worktrees: use `sidequest worktrees sweep` to inspect stale agent worktrees.');
  }
  const minAgeHours = opts['min-age-hours'] == null ? 3 : Number(opts['min-age-hours']);
  if (!Number.isFinite(minAgeHours) || minAgeHours < 0) fail('worktrees sweep: --min-age-hours must be a non-negative number.');
  const { slug, meta } = await resolveProject(opts);
  let result;
  try {
    result = await worktrees.sweep(meta.path, store.listTickets(slug), {
      execute: !!opts.yes && !opts['dry-run'],
      currentPath: store.nearestRepoRoot(process.cwd()),
      integrationTarget: store.integrationTarget(slug),
      minAgeMs: minAgeHours * 60 * 60 * 1000,
    });
  } catch (error: any) {
    fail(`worktrees: ${(error && error.message) || error}`);
  }
  if (opts.json) {
    process.stdout.write(JSON.stringify(Object.assign({ project: slug }, result), null, 2) + '\n');
    if (result.failures.length) process.exitCode = 1;
    return;
  }
  console.log(`worktrees sweep: ${result.dryRun ? 'dry run' : 'executed'} for ${meta.name} (minimum age ${minAgeHours}h)`);
  for (const entry of result.entries) {
    const ticket = entry.ticket ? ` ${entry.ticket}` : '';
    const ahead = entry.ahead == null ? '?' : entry.ahead;
    console.log(`  ${entry.action.toUpperCase()} ${entry.path}${ticket} [${entry.reason}; ${entry.clean ? 'clean' : 'dirty'}; ahead ${ahead}; patch-equivalent ${entry.patchEquivalent}; age ${entry.ageMs == null ? '?' : Math.round(entry.ageMs / 60000) + 'm'}]`);
  }
  if (result.dryRun) console.log('  pass --yes to remove the planned worktrees.');
  if (result.removed.length) console.log(`  removed ${result.counts.removedWorktrees} worktree(s) and deleted ${result.counts.deletedBranches} branch(es).`);
  if (result.prunedOrphanBranches.length) console.log(`  pruned ${result.counts.prunedOrphanBranches} orphan worktree branch(es).`);
  for (const failure of result.failures) console.log(`  ERROR ${failure.path || 'prune'}: ${failure.message}`);
  if (result.failures.length) process.exitCode = 1;
}

async function cmdNext(opts: any) {
  const { slug, meta } = await resolveProject(opts);
  if (!validateModelFilter('next', opts)) return;
  const by = workerId(opts);
  const res = store.claimNext(slug, by, { priority: opts.priority, model: opts.model, category: opts.category, direct: !!opts.direct, reason: opts.reason, source: opts.source || 'cli', sessionId: sessionId(opts) });
  if (!res.ok && res.reason) res.message = claimRefusalMessage(res.reason, res.ticket && res.ticket.ref || 'next ticket', res.ticket || res.claim);
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
    console.log(res.message || `No available tickets to claim in ${meta.name}.`);
  }
}

// Routed work must stay inside the current conversation. Use `native-agent` to
// create the temporary definition, then invoke it through the native Agent tool.
// A CLI process cannot invoke that tool, so the former `work` drain is disabled.
async function cmdWork(opts: any) {
  const { slug } = await resolveProject(opts);
  const work = require('../lib/work');
  const ref = opts.ref ? ` for ${opts.ref}` : '';
  const check = opts.ref ? work.nativeDispatchRequired(slug, opts.ref) : null;
  const detail = check && check.reason !== 'native_agent_required' ? ` ${check.message}` : '';
  fail(`work${ref} is disabled: routed work must use \`native-agent\` followed by the current conversation's Agent tool.${detail}`);
}

// Release every claim a session left behind (moving each ticket back to todo),
// immediately instead of waiting out the claim TTL. Called by the SessionEnd
// hook with the ending session's id; safe to run by hand too.
// Session-scoped by construction (see store.reconcileSession) — it only touches
// claims the registry attributes to THIS session. No session id -> a clean no-op.
async function cmdReconcile(opts: any) {
  const sid = sessionId(opts);
  const reason = opts.reason || 'worker session ended';
  const res = store.reconcileSession(sid, { reason, source: opts.source || 'cli' });
  if (opts.json) {
    process.stdout.write(JSON.stringify(Object.assign({ session: sid }, res), null, 2) + '\n');
    return;
  }
  if (!sid) {
    console.log('reconcile: no session id (pass --session or set CLAUDE_SESSION_ID) — nothing to do.');
    return;
  }
  if (res.released.length) console.log(`✓ reconciled ${sid}: released ${res.released.join(', ')} back to todo.`);
  else console.log(`✓ reconciled ${sid}: no outstanding claims to release.`);
}

// Assign a ticket to someone (defaults to the human "you"), or clear it with
// `unassign`. Assignment is persistent and separate from an agent claim.
async function cmdAssign(opts: any, positional: any, clear: any) {
  const idOrRef = positional[0];
  if (!idOrRef) fail(`${clear ? 'unassign' : 'assign'}: pass a ticket id or ref, e.g. sidequest ${clear ? 'unassign SQ-3' : 'assign SQ-3 --to you'}`);
  const { slug, meta } = await resolveProject(opts);
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
const REMINDER_PRESETS: any = {
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
async function cmdRemind(opts: any, positional: any) {
  const idOrRef = positional[0];
  if (!idOrRef) fail('remind: pass a ticket id or ref and a time, e.g. sidequest remind SQ-3 --in 1h  (or --at "2026-07-05T09:00")');
  const { slug, meta } = await resolveProject(opts);
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
    const reasons: any = { not_found: `no ticket "${idOrRef}" in ${meta.name}`, bad_fireAt: 'bad --at value', in_past: 'that time is in the past' };
    fail(`remind: ${reasons[res.reason] || res.reason}`);
  }
  console.log(`✓ reminder set on ${idOrRef} for ${when.toLocaleString()}  — ${meta.name}`);
}

// Cancel whatever reminder is pending on a ticket (a no-op, not an error, if
// there wasn't one — see store.cancelReminder()).
async function cmdUnremind(opts: any, positional: any) {
  const idOrRef = positional[0];
  if (!idOrRef) fail('unremind: pass a ticket id or ref, e.g. sidequest unremind SQ-3');
  const { slug, meta } = await resolveProject(opts);
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

async function cmdComment(opts: any, positional: any) {
  const idOrRef = positional[0];
  if (!idOrRef) fail('comment: pass a ticket id or ref, e.g. sidequest comment SQ-3 -m "note"');
  const body = await bodyFromOpts(opts, 'comment');
  if (!body || !String(body).trim()) fail('comment: -m/--body or --body-file is required, e.g. sidequest comment SQ-3 -m "note"');
  const { slug, meta } = await resolveProject(opts);
  const by = workerId(opts);
  const res = store.addComment(slug, idOrRef, { by, body, source: opts.source || 'cli' });
  if (opts.json) {
    process.stdout.write(JSON.stringify(Object.assign({ project: slug }, res), null, 2) + '\n');
    if (!res.ok) process.exitCode = 1;
    return;
  }
  if (res.ok) {
    console.log(`✓ » comment added to ${res.ticket.ref} by "${by}"  — ${meta.name}`);
    if (res.advisory) console.log(`  advisory: ${res.advisory}`);
  } else {
    process.exitCode = 1;
    const messages: any = {
      not_found: `no ticket "${idOrRef}" in ${meta.name}.`,
      empty: 'comment body cannot be empty.',
      too_long: `comment body is ${res.length} chars, over the ${res.max}-char cap — trim it or split into multiple comments (nothing was stored).`,
      busy: `${idOrRef} is locked right now — retry in a moment.`,
    };
    console.log(`✗ ${messages[res.reason] || 'comment failed: ' + res.reason}`);
  }
}

async function cmdComments(opts: any, positional: any) {
  const idOrRef = positional[0];
  if (!idOrRef) fail('comments: pass a ticket id or ref, e.g. sidequest comments SQ-3');
  const { slug, meta } = await resolveProject(opts);
  const t = store.getTicket(slug, idOrRef);
  if (!t) fail(`comments: no ticket "${idOrRef}" in ${meta.name}`);
  const allComments = Array.isArray(t.comments) ? t.comments : [];
  const history = store.commentHistory(allComments, !!opts.full);
  const comments = history.comments;
  if (opts.json) {
    const payload: any = { project: slug, ticket: t.ref, comments };
    if (history.omittedBodies) Object.assign(payload, { omittedBodies: history.omittedBodies, notice: history.notice });
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    return;
  }
  if (!comments.length) {
    console.log(`No comments on ${t.ref}.`);
    return;
  }
  console.log(`${t.ref} — ${comments.length} comment(s)`);
  if (history.notice) console.log(`  ${history.notice}`);
  for (const c of comments) {
    if (c.bodyOmitted) console.log(`  » [${c.at}] ${c.by} (${c.kind || 'comment'}): [body omitted]`);
    else console.log(`  » [${c.at}] ${c.by}: ${c.body}`);
  }
}

async function cmdLink(opts: any, positional: any) {
  // sidequest link SQ-1 <blocks|depends-on|related> SQ-2
  const a = positional[0];
  const verb = positional[1];
  const b = positional[2];
  if (!a || !verb || !b) fail('link: usage — sidequest link SQ-1 <blocks|depends-on|related> SQ-2');
  const { slug, meta } = await resolveProject(opts);
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
    const messages: any = {
      bad_type: `unknown relationship "${verb}" — use blocks, depends-on, or related.`,
      from_not_found: `no ticket "${a}" in ${meta.name}.`,
      to_not_found: `no ticket "${b}" in ${meta.name}.`,
      self: 'a ticket cannot link to itself.',
    };
    console.log(`✗ ${messages[res.reason] || 'link failed: ' + res.reason}`);
  }
}

async function cmdUnlink(opts: any, positional: any) {
  const a = positional[0];
  const b = positional[1];
  if (!a || !b) fail('unlink: usage — sidequest unlink SQ-1 SQ-2');
  const { slug, meta } = await resolveProject(opts);
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
async function cmdReady(opts: any) {
  const { slug, meta } = await resolveProject(opts);
  if (!validateModelFilter('ready', opts)) return;
  // --brief is a JSON shape, so it implies --json rather than silently no-oping.
  if (opts.json || opts.brief) {
    const payload = store.readyPayload(slug, { model: opts.model, category: opts.category, brief: opts.brief });
    process.stdout.write(JSON.stringify(Object.assign({ project: slug, projectName: meta.name }, payload), null, 2) + '\n');
    return;
  }
  const tickets = store.readyTickets(slug, { model: opts.model, category: opts.category });
  const waves = store.readyWaves(slug, { model: opts.model, category: opts.category });
  const waveDependencies = store.readyWaveDependencies(slug, { model: opts.model, category: opts.category });
  if (!tickets.length) {
    console.log(`Nothing ready to work in ${meta.name}.`);
    return;
  }
  console.log(`${meta.name} — ${tickets.length} ready to work (unclaimed, unblocked):`);
  const printTicket = (t: any) => {
    const pr = PRIORITY_MARK[t.priority] ? ` ${PRIORITY_MARK[t.priority]}` : '';
    const md = modelMark(t);
    const files = t.files && t.files.length ? `  \u{1F4C1}${t.files.length}` : '';
    console.log(`    ${t.ref}${pr}  ${t.title}${files}${md}`);
  };
  if (waves.length > 1) {
    waves.forEach((wave: any, i: any) => {
      console.log(i === 0 ? '\n  Wave 1 — safe to run in parallel:' : `\n  Wave ${i + 1} — after wave ${i}:`);
      for (const t of wave) printTicket(t);
      for (const dependency of waveDependencies.filter((entry?: any) => wave.some((ticket?: any) => ticket.ref === entry.after))) {
        console.log(`      contract edge: ${dependency.reason}`);
      }
    });
  } else {
    for (const t of tickets) printTicket(t);
  }
  if (tickets.length > 1) {
    if (waves.length > 1) {
      console.log('\nFan out within a wave: one subagent per ticket — each claim --by <id> → do → done. Wait for a wave to clear before starting the next.');
    } else {
      console.log('\nIf these are independent (no shared files), fan out: one subagent per ticket — each claim --by <id> → do → done.');
    }
  }
}

async function cmdArchive(opts: any, positional: any) {
  const { slug, meta } = await resolveProject(opts);
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

async function cmdUnarchive(opts: any, positional: any) {
  const idOrRef = positional[0];
  if (!idOrRef) fail('unarchive: pass a ticket ref, e.g. sidequest unarchive SQ-3');
  const { slug, meta } = await resolveProject(opts);
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

async function cmdDispatch(opts: any, positional: any) {
  const idOrRef = positional[0];
  if (!idOrRef) fail('dispatch: pass a ticket ref, e.g. sidequest dispatch SQ-12.');
  const { slug, meta } = await resolveProject(opts);
  const ticket = store.getTicket(slug, idOrRef);
  const descriptionError = store.dispatchDescriptionError(ticket);
  if (descriptionError) fail(descriptionError);
  const sessionId = opts.session || process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || null;
  let prepared;
  try {
    prepared = store.prepareDispatch(slug, idOrRef, { sessionId, sharedTree: !!opts['shared-tree'] });
  } catch (err: any) {
    fail(`dispatch: ${(err && err.message) || err}`);
  }
  const isolation = agentsync.ticketIsolation(prepared.ticket, prepared.ticket.dispatch && prepared.ticket.dispatch.sharedTree);
  const prompt = agentsync.renderDispatchStub(prepared.ticket, prepared.token, meta.path);
  const resolved = store.resolveExec(prepared.ticket.model, prepared.ticket.effort);
  const agent = prepared.ticket.dispatchExecutor;
  const spawn = agentsync.agentSpawn(agent, isolation, resolved && resolved.model, agent, prompt);
  process.stdout.write(JSON.stringify({
    project: slug,
    projectPath: meta.path,
    ref: prepared.ticket.ref,
    effort: prepared.ticket.effort,
    exec: prepared.ticket.exec,
    mode: 'instant',
    agent,
    tokenPrefix: prepared.token.slice(0, 12),
    token: prepared.token,
    recovery: prepared.recovery || null,
    warnings: store.dispatchWarnings(prepared.ticket),
    spawn,
    guidance: prepared.recovery
      ? `Claude quota fallback prepared from ${prepared.recovery.failedModel} to ${prepared.recovery.model}·${prepared.recovery.effort}. Pass spawn unchanged; category policy is unchanged.`
      : `Pass spawn unchanged to Agent; it claims ${prepared.ticket.ref} with --executor ${agent} --token ${prepared.token}.`,
  }, null, 2) + '\n');
}

async function cmdBriefing(opts: any, positional: any) {
  const idOrRef = positional[0];
  if (!idOrRef) fail('briefing: pass a ticket ref, e.g. sidequest briefing SQ-12 --token <token>.');
  if (!opts.token) fail('briefing: pass the current dispatch token with --token.');
  const { slug, meta } = await resolveProject(opts);
  const result = store.readDispatchBriefing(slug, idOrRef, opts.token);
  if (!result.ok) fail(`briefing: ${result.reason === 'not_found' ? `no ticket "${idOrRef}".` : 'dispatch token was refused; re-run dispatch for a current spawn.'}`);
  process.stdout.write(agentsync.withProjectIdentity(agentsync.renderTicketBriefing(result.ticket, opts.token, slug, meta.path), meta.path));
}

async function cmdNativeAgent(opts: any, positional: any) {
  const action = String(positional[0] || '').toLowerCase();
  if (action === 'cleanup') {
    const sessionId = opts.session || process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID;
    if (!opts.name && !sessionId) fail('native-agent cleanup: pass --name or run inside a Claude Code session.');
    const res = agentsync.cleanupNativeAgents({ name: opts.name, sessionId });
    process.stdout.write(JSON.stringify(res, null, 2) + '\n');
    return;
  }

  const idOrRef = positional[0];
  if (!idOrRef) fail('native-agent: pass a ticket ref, e.g. sidequest native-agent SQ-12 --json.');
  const { slug, meta } = await resolveProject(opts);
  const ticket = store.getTicket(slug, idOrRef);
  if (!ticket) fail(`native-agent: no ticket "${idOrRef}".`);
  if (!ticket.model || !ticket.effort) fail(`native-agent: ${ticket.ref} has no routable model and effort.`);
  const resolved = store.resolveExec(ticket.model, ticket.effort);
  const sessionId = opts.session || process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || null;
  const prompt = agentsync.withProjectIdentity(work.executorPrompt(ticket, opts.prompt || `Work ${ticket.ref}: ${ticket.title}`), meta.path);
  const sharedTree = store.boardConfig(slug)?.worktreeIsolation === false || !!opts['shared-tree'];
  const created = agentsync.createNativeAgent({
    ref: ticket.ref,
    agentType: resolved.agent || `sidequest-exec-${ticket.effort || 'low'}`,
    spawnModel: resolved.model,
    effort: ticket.effort,
    runtime: resolved.runsModel,
    isolation: agentsync.ticketIsolation(ticket, sharedTree),
    sessionId,
    prompt,
  });
  process.stdout.write(JSON.stringify(Object.assign({ project: slug, projectPath: meta.path, ref: ticket.ref, effort: ticket.effort, exec: ticket.exec, prompt }, created), null, 2) + '\n');
}

// `sidequest models sync-agents` — regenerate the runtime
// sidequest-exec-<slug>-<effort>.md agent files for every tier pointed at a
// Codex model (prefs.tierBackend) x that tier's enabled non-max effort, without
// touching the dashboard (which triggers the same sync on save). Useful after
// changing a tier's backend some other way, or to clean up stale files.
async function cmdModelsSyncAgents(opts: any) {
  const res = agentsync.syncExecAgents(undefined, opts.dir ? { dir: opts.dir } : undefined);
  if (opts.json) {
    process.stdout.write(JSON.stringify(Object.assign({}, res, res.written > 0 ? { message: agentsync.RELOAD_NOTICE } : {}), null, 2) + '\n');
    return;
  }
  console.log(`✓ exec agents synced: ${res.written} written, ${res.removed} removed, ${res.unchanged} unchanged`);
  if (res.written > 0) console.log(`  ${agentsync.RELOAD_NOTICE}`);
}

async function cmdModels(opts: any, positional: any) {
  if (positional && positional[0] === 'sync-agents') {
    await cmdModelsSyncAgents(opts);
    return;
  }
  const { slug } = await resolveProject(opts);
  const payload = store.modelsPayload({ project: slug });
  if (opts.json) {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    return;
  }
  console.log('Available models:');
  console.log(`  ${payload.models.join(', ')}`);
  console.log(`Global fallback: ${payload.globalFallback ? `${payload.globalFallback.model}·${payload.globalFallback.effort}` : 'missing or invalid'}`);
  console.log('Categories:');
  for (const category of payload.categories) {
    const fallback = category.fallback ? `; fallback ${category.fallback.model}·${category.fallback.effort}` : '';
    console.log(`  ${category.id}  ${category.name}  route ${category.route.model}·${category.route.effort}${fallback}  → ${category.resolved.model}·${category.resolved.effort}`);
    for (const warning of category.warnings) console.log(`    ! ${warning}`);
  }
}

async function cmdRoute(opts: any, positional: any) {
  if (!opts.json) fail('route: pass --json.');
  const categoryId = positional[0];
  if (!categoryId) fail('route: pass a category id.');
  const { slug } = await resolveProject(opts);
  const category = store.getCategory(categoryId, { project: slug });
  if (!category || !category.enabled) {
    const disabled = store.getCategory(categoryId, { project: slug, includeDisabled: true })
      || store.getProjectCategories(slug).rows.some((row: any) => row.kind === 'DISABLE' && row.id === String(categoryId).trim().toLowerCase());
    fail(`route: category "${categoryId}" is ${disabled ? 'disabled for this project' : 'unknown'}.`);
  }
  const resolved = store.resolveCategoryRoute(category);
  if (!resolved || !resolved.exec) fail(`route: category "${category.id}" has no available route.`);
  const recipe = agentsync.workflowRecipe(Object.assign({}, category, { project: slug }), resolved);
  const selected = store.projectRoutingProfile(slug);
  process.stdout.write(JSON.stringify(Object.assign({}, recipe, {
    profile: { id: selected.profile.id, revision: selected.profile.revision },
    categorySource: { kind: category.origin || 'profile', baseProfileId: category.baseProfileId || null },
  }), null, 2) + '\n');
}

async function cmdBoardConfig(opts: any) {
  const { slug, meta } = await resolveProject(Object.assign({}, opts, { name: undefined }));
  const patch: any = {};
  if (opts.name != null) patch.name = opts.name;
  if (opts['always-in-scope'] != null) patch.alwaysInScope = opts['always-in-scope'];
  if (opts['integration-mode'] != null) patch.integrationMode = opts['integration-mode'];
  if (opts['worktree-isolation'] !== undefined) patch.worktreeIsolation = opts['worktree-isolation'];
  if (opts['worktree-setup'] != null) patch.worktreeSetup = opts['worktree-setup'];
  const result = Object.keys(patch).length
    ? store.setBoardConfig(slug, patch)
    : { ok: true, config: store.boardConfig(slug) };
  if (!result.ok) fail(`board-config: no board "${meta.name}".`);
  const payload: any = Object.assign({ project: slug, projectName: result.config.name }, result.config);
  if (opts.json) {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    return;
  }
  console.log(`board name: ${payload.name}`);
  console.log(`always in scope: ${payload.alwaysInScope.length ? payload.alwaysInScope.join(', ') : '(none)'}`);
  console.log(`integration mode: ${payload.integrationMode}`);
  console.log(`worktree isolation: ${payload.worktreeIsolation ? 'enabled' : 'disabled'}`);
  console.log(`worktree setup: ${payload.worktreeSetup || '(none)'}`);
}

async function cmdProjects(opts: any) {
  const projects = store.listProjects({ archived: !!opts.archived });
  if (opts.json) {
    process.stdout.write(JSON.stringify({ projects }, null, 2) + '\n');
    return;
  }
  if (!projects.length) {
    console.log(opts.archived ? 'No archived sidequest boards.' : 'No sidequest boards yet. Create a ticket to start one.');
    return;
  }
  console.log(`${projects.length} ${opts.archived ? 'archived ' : ''}board(s):`);
  for (const p of projects) {
    const stamp = opts.archived && p.archivedAt ? `, archived ${p.archivedAt}` : '';
    console.log(`  ${p.name}  —  ${p.open} open (${p.counts.todo} todo, ${p.counts.doing} doing, ${p.counts.done} done${stamp})`);
    console.log(`    ${p.path}`);
  }
}

async function cmdRouting(opts: any, positional: any) {
  const { slug, meta } = await resolveProject(opts);
  const routing = positional[0];
  if (routing != null && !['enabled', 'disabled'].includes(routing)) fail('routing: pass enabled or disabled.');
  const result = routing == null
    ? { ok: true, routing: store.projectRoutingEnabled(slug) ? 'enabled' : 'disabled' }
    : store.setProjectRouting(slug, routing);
  if (opts.json) {
    process.stdout.write(JSON.stringify(Object.assign({ project: slug, projectName: meta.name }, result), null, 2) + '\n');
    return;
  }
  console.log(`✓ routing ${result.routing} on ${meta.name}`);
}

// Board archive commands always require an explicit reference. Never call the
// normal default-project resolver here: running one from an unrelated cwd must
// not archive that cwd's board by accident.
function resolveExplicitBoard(opts: any, positional: any, action: any) {
  const ref = opts.project || positional[0];
  if (!ref) fail(`${action}: pass a board slug, display name, or registered path.`);
  const found = store.findProject(ref);
  if (!found.ok) fail(`${action}: board "${ref}" ${describeFindFailure(found, ref)}`);
  return found;
}

async function cmdArchiveBoard(opts: any, positional: any) {
  const board = resolveExplicitBoard(opts, positional, 'archive-board');
  const res = store.archiveProject(board.slug);
  if (!res.ok) fail(`archive-board: board "${opts.project || positional[0]}" no longer exists.`);
  if (opts.json) {
    process.stdout.write(JSON.stringify(Object.assign({ project: board.slug, projectName: board.meta.name }, res), null, 2) + '\n');
    return;
  }
  console.log(`✓ ${res.alreadyArchived ? 'already archived' : 'archived'} board ${board.meta.name}`);
}

async function cmdUnarchiveBoard(opts: any, positional: any) {
  const board = resolveExplicitBoard(opts, positional, 'unarchive-board');
  const res = store.unarchiveProject(board.slug);
  if (!res.ok) fail(`unarchive-board: board "${opts.project || positional[0]}" no longer exists.`);
  if (opts.json) {
    process.stdout.write(JSON.stringify(Object.assign({ project: board.slug, projectName: board.meta.name }, res), null, 2) + '\n');
    return;
  }
  console.log(`✓ ${res.wasArchived ? 'restored' : 'already active'} board ${board.meta.name}`);
}

// Turn a findProject failure into a one-line reason for the merge error text.
function describeFindFailure(res: any, ref: any) {
  if (res.reason === 'ambiguous') {
    return `matches ${res.matches.length} boards named "${ref}" — pass the path to disambiguate`;
  }
  const known = Array.from(new Set(res.known || []));
  return `does not match any registered board.` + (known.length ? ` Known: ${known.join(', ')}` : '');
}

// merge <src> <dst> [--dry-run]: fold one board into another. Both args resolve
// through findProject (slug / display name / registered path), same as --project.
async function cmdMerge(opts: any, positional: any) {
  const srcArg = positional[0];
  const dstArg = positional[1];
  if (!srcArg || !dstArg) {
    fail('merge: pass a source and destination board, e.g. sidequest merge docai_refactored contractify [--dry-run]');
  }
  const src = store.findProject(srcArg);
  if (!src.ok) fail(`merge: source "${srcArg}" ${describeFindFailure(src, srcArg)}`);
  const dst = store.findProject(dstArg);
  if (!dst.ok) fail(`merge: destination "${dstArg}" ${describeFindFailure(dst, dstArg)}`);
  if (src.slug === dst.slug) fail('merge: source and destination are the same board');

  const dryRun = !!opts['dry-run'];
  let res;
  try {
    res = store.mergeProject(src.slug, dst.slug, { dryRun });
  } catch (e: any) {
    fail(`merge: ${(e && e.message) || e}`);
  }
  const verb = dryRun ? 'would move' : 'moved';
  console.log(`✓ ${verb} ${res.tickets} ticket(s) and ${res.stories} story(ies) from ${src.meta.name} → ${dst.meta.name}`);
  for (const m of res.mapping) {
    console.log(`    ${m.from} → ${m.to}  ${m.title}`);
  }
  if (!dryRun) console.log(`  removed board "${src.meta.name}".`);
  else console.log('  (dry run — nothing was changed)');
}

/* ------------------------------------------------------------------ *
 *  User stories (a lightweight grouping tickets can belong to)
 * ------------------------------------------------------------------ */

// Count non-archived tickets that belong to a given story.
function storyTicketCount(slug: any, storyId: any) {
  return store.listTickets(slug).filter((t: any) => !t.archived && t.storyId === storyId).length;
}

async function cmdStory(opts: any, positional: any) {
  const action = (positional[0] || '').toLowerCase();
  const idOrRef = positional[1];
  const { slug, meta } = await resolveProject(opts);

  switch (action) {
    case 'add':
    case 'new':
    case 'create': {
      const title = opts.title;
      if (!title) fail('story add: --title/-t is required, e.g. sidequest story add -t "Auth revamp" [--color teal]');
      const story = store.createStory(slug, {
        title,
        description: opts.desc != null ? opts.desc : opts.description,
        color: opts.color,
      });
      if (opts.json) {
        process.stdout.write(JSON.stringify({ ok: true, project: slug, projectName: meta.name, story }, null, 2) + '\n');
        return;
      }
      console.log(`✓ ${story.ref}  "${story.title}"  [${story.color}]  — ${meta.name}`);
      return;
    }

    case 'list':
    case 'ls': {
      const stories = store.listStories(slug);
      if (opts.json) {
        const withCounts = stories.map((s: any) => Object.assign({}, s, { ticketCount: storyTicketCount(slug, s.id) }));
        process.stdout.write(JSON.stringify({ project: slug, projectName: meta.name, stories: withCounts }, null, 2) + '\n');
        return;
      }
      if (!stories.length) {
        console.log(`No user stories in ${meta.name}.`);
        return;
      }
      console.log(`${meta.name} — ${stories.length} user story/stories`);
      for (const s of stories) {
        const n = storyTicketCount(slug, s.id);
        console.log(`  ${s.ref}  [${s.color}]  ${s.title}  (${n} ticket${n === 1 ? '' : 's'})`);
      }
      return;
    }

    case 'show':
    case 'view': {
      if (!idOrRef) fail('story show: pass a story ref, e.g. sidequest story show US-1');
      const story = store.getStory(slug, idOrRef);
      if (!story) fail(`story show: no story "${idOrRef}" in ${meta.name}`);
      const tickets = store.listTickets(slug).filter((t: any) => !t.archived && t.storyId === story.id);
      if (opts.json) {
        process.stdout.write(JSON.stringify({ project: slug, projectName: meta.name, story, tickets }, null, 2) + '\n');
        return;
      }
      console.log(`${story.ref}  [${story.color}]  "${story.title}"  — ${meta.name}`);
      if (story.description) console.log(`  ${story.description}`);
      if (!tickets.length) {
        console.log('  (no tickets yet)');
        return;
      }
      console.log(`  ${tickets.length} ticket(s):`);
      for (const t of tickets) {
        const pr = PRIORITY_MARK[t.priority] ? ` ${PRIORITY_MARK[t.priority]}` : '';
        console.log(`    ${t.ref}${pr}  [${t.status}]  ${t.title}`);
      }
      return;
    }

    case 'contract': {
      if (!idOrRef) fail('story contract: pass a story ref, e.g. sidequest story contract US-1 [--body-file path]');
      const body = await bodyFromOpts(opts, 'story contract');
      const story = body === undefined
        ? store.getStory(slug, idOrRef)
        : store.updateStory(slug, idOrRef, { executionContract: body });
      if (!story) fail(`story contract: no story "${idOrRef}" in ${meta.name}`);
      if (opts.json) {
        process.stdout.write(JSON.stringify({ ok: true, project: slug, projectName: meta.name, story }, null, 2) + '\n');
        return;
      }
      if (body === undefined) {
        console.log(`${story.ref} execution contract revision ${story.contractRevision || 0}`);
        console.log(story.executionContract || '(no execution contract set)');
        return;
      }
      console.log(`✓ ${story.ref} execution contract revision ${story.contractRevision || 0} — ${meta.name}`);
      return;
    }

    case 'update':
    case 'edit':
    case 'set': {
      if (!idOrRef) fail('story update: pass a story ref, e.g. sidequest story update US-1 -t "New title"');
      const patch: any = {};
      if (opts.title != null) patch.title = opts.title;
      if (opts.desc != null || opts.description != null) patch.description = opts.desc != null ? opts.desc : opts.description;
      if (opts.color != null) patch.color = opts.color;
      const story = store.updateStory(slug, idOrRef, patch);
      if (!story) fail(`story update: no story "${idOrRef}" in ${meta.name}`);
      if (opts.json) {
        process.stdout.write(JSON.stringify({ ok: true, project: slug, story }, null, 2) + '\n');
        return;
      }
      console.log(`✓ ${story.ref} updated  [${story.color}]  "${story.title}"  — ${meta.name}`);
      return;
    }

    case 'rm':
    case 'remove':
    case 'delete': {
      if (!idOrRef) fail('story rm: pass a story ref, e.g. sidequest story rm US-1');
      const existing = store.getStory(slug, idOrRef);
      const ok = store.deleteStory(slug, idOrRef);
      if (opts.json) {
        process.stdout.write(JSON.stringify({ ok, project: slug, story: existing || null }, null, 2) + '\n');
        if (!ok) process.exitCode = 1;
        return;
      }
      if (!ok) fail(`story rm: no story "${idOrRef}" in ${meta.name}`);
      console.log(`✓ removed ${existing ? existing.ref : idOrRef} from ${meta.name} (member tickets detached)`);
      return;
    }

    default:
      fail(`story: unknown action "${positional[0] || ''}". Use add | list | show | update | rm. Run "sidequest help".`);
  }
}

/* ------------------------------------------------------------------ *
 *  Server lifecycle
 * ------------------------------------------------------------------ */

// The installed plugin version. Compared against a running server's health
// payload so an old, still-alive server (e.g. left up from before a plugin
// update) gets recognized as stale-code and recycled instead of quietly
// going on serving a routing ladder that predates the on-disk source — see
// SQ-92. Missing/unreadable just disables the check (never a hard failure).
let PLUGIN_VERSION: any = null;
try {
  PLUGIN_VERSION = require('../.claude-plugin/plugin.json').version || null;
} catch (_: any) {
  /* best effort */
}

function checkHealth(port: any, timeoutMs: any = undefined): Promise<any> {
  return new Promise((resolve: any) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: timeoutMs || 800 }, (res: any) => {
      let raw = '';
      res.on('data', (c: any) => (raw += c));
      res.on('end', () => {
        try {
          const info = JSON.parse(raw);
          resolve(info && info.name === 'sidequest' ? info : null);
        } catch (_: any) {
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

// A few retries with a short backoff before declaring a recorded server dead.
// A single slow/loaded poll timing out used to be read as "the old server is
// gone" and would spawn a fresh one on top of a perfectly healthy instance —
// the mintings-of-new-ports symptom in SQ-92. Cheap insurance: ~1s worst case.
async function checkHealthPatient(port: any, attempts: any = undefined) {
  for (let i = 0; i < (attempts || 3); i++) {
    const health = await checkHealth(port);
    if (health) return health;
    if (i < (attempts || 3) - 1) await delay(200);
  }
  return null;
}

function delay(ms: any) {
  return new Promise((r: any) => setTimeout(r, ms));
}

function isPidAlive(pid: any) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e && e.code === 'EPERM';
  }
}

function compareVersions(left: any, right: any) {
  const parse = (value: any) => /^\d+\.\d+\.\d+$/.test(String(value || '')) ? String(value).split('.').map(Number) : null;
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return null;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index] ?? 0;
    const rightValue = b[index] ?? 0;
    if (left !== rightValue) return left - rightValue;
  }
  return 0;
}

function isVersionAtLeast(version: any, baseline: any) {
  if (!baseline) return true;
  const comparison = compareVersions(version, baseline);
  return comparison !== null && comparison >= 0;
}

function isRecordedServer(health: any, info: any) {
  return Boolean(health && info && Number.isInteger(Number(health.pid)) && Number(health.pid) === Number(info.pid));
}

async function waitForPidExit(pid: any, timeoutMs: any = undefined) {
  const deadline = Date.now() + (timeoutMs || 10000);
  while (isPidAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await delay(50);
  }
  return true;
}

async function reapServer(info: any, health: any = undefined) {
  if (health && !isRecordedServer(health, info)) return false;
  if (info && info.pid && isPidAlive(info.pid)) {
    try {
      process.kill(info.pid, 'SIGTERM');
    } catch (_: any) {
      return false;
    }
    if (!await waitForPidExit(info.pid)) return false;
  }
  const current = store.readServerInfo();
  if (current && current.pid === info.pid) store.clearServerInfo();
  return true;
}

// Look at the recorded server (if any) and decide what to do with it:
//   'reuse'  — healthy and on the current plugin version, use it as-is
//   'reap'   — stale version, or unresponsive-but-alive, or dead-but-recorded;
//              caller should spawn a replacement
//   null     — nothing was recorded
// Reaping happens here so both `dashboard` and `serve` clean up identically.
async function resolveRunningServer() {
  const existing = store.readServerInfo();
  if (!existing || !existing.port) return null;
  const health = await checkHealthPatient(existing.port);
  if (health) {
    if (!isRecordedServer(health, existing)) {
      const current = store.readServerInfo();
      if (current && current.pid === existing.pid) store.clearServerInfo();
      return { action: 'foreign', reason: 'listener pid differs from server-info', existing };
    }
    if (PLUGIN_VERSION && (compareVersions(existing.version, PLUGIN_VERSION) ?? 0) < 0) {
      if (!await reapServer(existing, health)) {
        return { action: 'blocked', reason: `stale version ${existing.version || 'unknown'} could not stop`, existing };
      }
      return { action: 'reap', reason: `stale version ${existing.version || 'unknown'} (installed: ${PLUGIN_VERSION})`, existing };
    }
    return { action: 'reuse', existing };
  }
  if (isPidAlive(existing.pid)) {
    if (!await reapServer(existing)) return { action: 'blocked', reason: 'unresponsive server could not stop', existing };
    return { action: 'reap', reason: 'unresponsive', existing };
  }
  const current = store.readServerInfo();
  if (current && current.pid === existing.pid) store.clearServerInfo();
  return { action: 'reap', reason: 'dead', existing };
}

// Return the URL of a running dashboard, starting a detached one if needed.
async function ensureServer(requestedPort: any) {
  const running = await resolveRunningServer();
  if (running && running.action === 'reuse') {
    return running.existing.url || `http://127.0.0.1:${running.existing.port}`;
  }
  if (running && running.action === 'blocked') throw new Error(`the dashboard server is ${running.reason}`);
  const port = requestedPort || (running && running.existing && running.existing.port) || undefined;
  const args: any = [agentsync.ensureDispatchLauncher(), 'serve'];
  if (port) args.push('--port', String(port));
  const child = spawn(process.execPath, args, { cwd: os.homedir(), detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();

  for (let i = 0; i < 60; i++) {
    await delay(150);
    const info = store.readServerInfo();
    if (info && info.port && isVersionAtLeast(info.version, PLUGIN_VERSION)) {
      const health = await checkHealth(info.port);
      if (health && isRecordedServer(health, info) && isVersionAtLeast(health.version, PLUGIN_VERSION)) return info.url || `http://127.0.0.1:${info.port}`;
    }
  }
  throw new Error('the dashboard server did not start in time');
}

function openBrowser(targetUrl: any) {
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
  } catch (_: any) {
    /* opening the browser is best-effort */
  }
}

async function cmdDashboard(opts: any) {
  // Register the current project so it shows up even before its first ticket.
  try {
    await resolveProject(opts);
  } catch (_: any) {
    /* fine if we cannot */
  }
  const targetUrl = await ensureServer(opts.port);
  if (opts.open !== false) openBrowser(targetUrl);
  console.log(`sidequest dashboard: ${targetUrl}`);
  if (opts.open === false) console.log('(browser auto-open skipped; open the URL above)');
}

async function waitForHandoff(pid: any, timeoutMs: any = undefined) {
  if (!pid) return;
  const deadline = Date.now() + (timeoutMs || 10 * 1000);
  while (isPidAlive(pid)) {
    if (Date.now() >= deadline) throw new Error(`handoff server pid ${pid} did not exit in time`);
    await delay(100);
  }
}

async function cmdServe(opts: any) {
  // A successor spawned by server.js waits for the old listener to drain. This
  // keeps active requests alive during the upgrade and then binds the same URL.
  if (opts.handoffPid) await waitForHandoff(Number(opts.handoffPid));
  // Single-instance per home dir: a subagent smoke-testing "does serve start"
  // (or a human re-running it out of habit) used to spawn a second listener
  // on the next free port every time, leaving the old one running forever —
  // the zombie-process scare in SQ-92. Reuse a healthy, current-version
  // instance instead of starting a duplicate; reap anything stale/dead first.
  const running = await resolveRunningServer();
  if (running && running.action === 'reuse') {
    console.log(`sidequest dashboard already running at ${running.existing.url || 'http://127.0.0.1:' + running.existing.port} (pid ${running.existing.pid}) — reusing it.`);
    console.log('Run "sidequest stop" first if you need to restart it in place.');
    return;
  }
  if (running && running.action === 'reap') {
    console.log(`Recycled a ${running.reason} sidequest server (pid ${running.existing.pid}).`);
  }
  const server = require('../lib/server');
  const { url } = await server.start(opts.port || (running && running.existing && running.existing.port));
  console.log(`sidequest dashboard running at ${url}`);
  // Do not exit: the HTTP server keeps the process alive.
}

async function cmdStop() {
  const info = store.readServerInfo();
  if (!info || !info.pid) {
    console.log('No running sidequest server recorded.');
    return;
  }
  try {
    process.kill(info.pid);
    console.log(`Stopped sidequest server (pid ${info.pid}).`);
  } catch (e: any) {
    console.log(`Could not stop pid ${info.pid}: ${e.message}`);
  }
  store.clearServerInfo();
}

/* ------------------------------------------------------------------ *
 *  Help + dispatch
 * ------------------------------------------------------------------ */

const HELP_COMMANDS: any = {
  add: 'sidequest add -t "title" (--category <id> | --complexity 1-10 --why "motivation" | --unclassified) [-d desc] [-p low|normal|high|urgent] [-l label]... [--produces name]... [--changes name]... [--consumes name]... [--contract-waiver] [--readonly false] [-i image]... [-s todo|doing|done] [--dry-run] [--json]',
  list: 'sidequest list [--status todo|doing|done] [--archived] [--json] [--brief] [--limit N] [--cursor <nextCursor>] [--all]',
  pulse: 'sidequest pulse <SQ-n> [--project <path-or-slug>]',
  changes: 'sidequest changes [--since <iso>] [--project <path-or-slug>]',
  update: 'sidequest update <id|SQ-n> [-t title] [-d desc] [-p priority] [-s status] [-l label]... [--produces name]... [--changes name]... [--consumes name]... [--contract-waiver[=false]] [--readonly false] [-i image]... [--category <id|none>] [--complexity 1-10 --why "motivation"]',
  rm: 'sidequest rm <id|SQ-n> [--force]',
  profile: 'sidequest profile <hygiene|list|show|create|edit|retire|use|repoint|promote|new-board> ... [--retired] [--project <path-or-slug>] [--dry-run] [--json]',
  category: 'sidequest category <list|add|edit|rm|disable|enable|pin|reset> <id> [--profile <profile>|--project <path-or-slug>] [--route-model <model> --route-effort <effort>] [--fallback-model <model> --fallback-effort <effort>|--no-fallback] [--json]',
  'global-fallback': 'sidequest global-fallback [--model <model> --effort <effort>] [--json]',
  claim: 'sidequest claim <id|SQ-n> [--by who] [--token nonce] [--effort level] [--force] [--direct --reason "why"]',
  checkpoint: 'sidequest checkpoint <id|SQ-n> --by who (--commit <hash> | --worktree <absolute-path>) --verify "command: result" [--ttl-minutes N] [--json]',
  claims: 'sidequest claims sweep [--project <path-or-slug>]',
  worktrees: 'sidequest worktrees sweep [--dry-run] [--yes] [--min-age-hours N] [--project <path-or-slug>]',
  next: 'sidequest next [--by who] [-p priority] [--model <model>] [--category <id>] [--direct --reason "why"]',
  reconcile: 'sidequest reconcile [--session <id>] [--reason "..."]',
  work: 'sidequest work|drain',
  'groom-close': 'sidequest groom-close <id|SQ-n> --reason <evidence> [--by who] [--integration]',
  done: 'sidequest done <id|SQ-n> [--by who] [--model tier] [--effort level] [--body-file path]',
  commit: 'sidequest commit <id|SQ-n> --by who --message "message"',
  submit: 'sidequest submit <id|SQ-n> --by who --commit <hash> [--base <hash>] [--gitref refs/sidequest/SQ-n] [--verify "command"] [--worktree path] [--body-file path]',
  publish: 'sidequest publish <lock|unlock|status|queue> [--repo path] [--steal] [--force] [--json]',
  release: 'sidequest release <id|SQ-n> [--by who] [-s todo]',
  'scope-request': 'sidequest scope-request <id|SQ-n> --file path [--file path...] [--by who]',
  assign: 'sidequest assign <id|SQ-n> [--to who=you]',
  unassign: 'sidequest unassign <id|SQ-n>',
  remind: 'sidequest remind <id|SQ-n> (--in 1h|3h|tomorrow | --at "date/time")',
  unremind: 'sidequest unremind <id|SQ-n>',
  comment: 'sidequest comment <id|SQ-n> (-m "body" | --body-file path) [--by who]',
  comments: 'sidequest comments <id|SQ-n> [--json] [--full]',
  link: 'sidequest link <id|SQ-n> <blocks|depends-on|related> <id|SQ-n>',
  unlink: 'sidequest unlink <id|SQ-n> <id|SQ-n>',
  ready: 'sidequest ready [--model <model>] [--category <id>] [--json] [--brief]',
  archive: 'sidequest archive [<id|SQ-n>] [--done]',
  unarchive: 'sidequest unarchive <id|SQ-n>',
  dispatch: 'sidequest dispatch <SQ-n> [--shared-tree] [--project <path-or-slug>] [--session id]',
  briefing: 'sidequest briefing <SQ-n> --token <token> [--project <path-or-slug>]',
  'native-agent': 'sidequest native-agent <SQ-n> [--prompt "task"] [--shared-tree] [--json]',
  models: 'sidequest models [--project <path-or-slug>] [--json]',
  route: 'sidequest route <category> [--project <path-or-slug>] --json',
  'board-config': 'sidequest board-config [--always-in-scope path]... [--integration-mode <mode>] [--worktree-isolation|--no-worktree-isolation] [--worktree-setup "command"] [--json]',
  projects: 'sidequest projects [--archived] [--json]',
  routing: 'sidequest routing [enabled|disabled] [--project <path-or-slug>] [--json]',
  'archive-board': 'sidequest archive-board <board-ref> [--json]',
  'unarchive-board': 'sidequest unarchive-board <board-ref> [--json]',
  merge: 'sidequest merge <src> <dst> [--dry-run]',
  dashboard: 'sidequest dashboard [--port N] [--no-open]',
  serve: 'sidequest serve [--port N]',
  stop: 'sidequest stop',
  story: 'sidequest story <add|list|show|contract|update|rm> ... [--json]',
};

const HELP_ALIASES: any = {
  new: 'add', ticket: 'add', ls: 'list', edit: 'update', set: 'update', remove: 'rm', delete: 'rm',
  profiles: 'profile', categories: 'category', global_fallback: 'global-fallback', take: 'claim', grab: 'next',
  drain: 'work', complete: 'done', finish: 'done', unclaim: 'release', scope_request: 'scope-request', restore: 'unarchive',
  native_agent: 'native-agent', board_config: 'board-config', boards: 'projects', archive_board: 'archive-board',
  unarchive_board: 'unarchive-board', 'restore-board': 'unarchive-board', open: 'dashboard', board: 'dashboard',
};

function commandHelp(command: any) {
  const name = HELP_ALIASES[command] || command;
  const usage = HELP_COMMANDS[name];
  if (!usage) return false;
  console.log(`Usage:\n  ${usage}\n\nRun "sidequest help" for all commands.`);
  return true;
}

function help() {
  const colorNames = Object.keys(store.STORY_COLOR_NAMES || {}).join(', ');
  console.log(
    `sidequest — a Trello-light quest log for Claude Code

Usage:
  sidequest add -t "title" (--category <id> | --complexity 1-10 --why "<motivation>" | --unclassified) [-d desc] [-p low|normal|high|urgent] [-l label]... [--produces name]... [--changes name]... [--consumes name]... [--contract-waiver] [--readonly false] [-i image]... [-s todo|doing|done]
  sidequest list [--status todo|doing|done] [--json] [--brief] [--limit N] [--cursor <nextCursor>] [--all]   (--brief: compact JSON, no bodies; implies --json. --limit/--cursor page a big board; follow nextCursor until null. --all: whole column in one call)
  sidequest pulse <SQ-n> [--project <path-or-slug>]   compact liveness read for one ticket
  sidequest changes [--since <iso>] [--project <path-or-slug>]   compact ticket delta (defaults to last 60 min)
  sidequest update <id|SQ-n> [-t title] [-d desc] [-p priority] [-s status] [-l label]... [--produces name]... [--changes name]... [--consumes name]... [--contract-waiver[=false]] [--readonly false] [-i image]... [--category <id|none>] [--complexity 1-10 --why "<motivation>"]
  sidequest profile hygiene|list|show|create|edit|retire|use|repoint|promote|new-board ... [--json]
  sidequest category list|add|edit|rm|disable|enable|pin|reset <id> (--profile <profile> | --project <path-or-slug>) [--route-model <model> --route-effort <effort>] [--fallback-model <model> --fallback-effort <effort> | --no-fallback] [--json]
  sidequest global-fallback [--model <model> --effort <effort>] [--json]
  sidequest rm <id|SQ-n> [--force]
  sidequest projects [--archived] [--json]
  sidequest routing [enabled|disabled] [--project <path-or-slug>] [--json]
  sidequest archive-board <board-ref>                  archive a board
  sidequest unarchive-board <board-ref>                restore an archived board
  sidequest dashboard [--port N] [--no-open]     open the live board in the browser
  sidequest serve [--port N]                     run the board server in the foreground
  sidequest stop                                 stop the running board server

  -d/-m accept full markdown (headings, lists, fenced code, blockquotes, links, **bold**/*italic*/inline
    code) — use real newlines in the value (heredoc or $'...\\n...'), never a literal backslash-n.

Working the board safely (multi-agent):
  sidequest ready [--model <model>] [--category <id>] [--json] [--brief]   the ready set (unclaimed, unblocked) — fan subagents over it
  sidequest claim <id|SQ-n> [--by who] [--force] [--token nonce] [--effort level] [--direct --reason "why no executor can do this"]   atomically take a ticket (category-routed executor claims require a prepared nonce and exact executor; direct is a justified inline exception)
  sidequest checkpoint <id|SQ-n> --by who (--commit <hash> | --worktree <absolute-path>) --verify "<command: result>" [--ttl-minutes N]   record a live review candidate while the claim and dispatch stay active
  sidequest next [--by who] [-p priority] [--model <model>] [--category <id>] [--direct --reason "why no executor can do this"]   claim the best available ticket (routed tickets need --direct here because next has no dispatch token)
  sidequest done <id|SQ-n> [--by who] [--model tier] [--effort level] [--body-file path]   close non-repo or active authorized artifact work
  sidequest groom-close <id|SQ-n> --reason <evidence> [--by who] [--integration]   control-plane closure; --integration consumes a submitted ticket after publish
  sidequest release <id|SQ-n> [--by who] [-s todo] drop the claim without finishing
  sidequest scope-request <id|SQ-n> --file path [--file path...] [--by who] request a scope expansion and pause with the claim held
  sidequest commit <id|SQ-n> --by who --message "message"  commit only the ticket's declared scope; staged foreign paths stay staged
  sidequest submit <id|SQ-n> --by who --commit <hash> [--base <hash>] [--gitref refs/sidequest/SQ-n] [--verify "<cmd>"] [--worktree path] [--body-file path]
    executor terminal for repo-changing tickets: park the verified LOCAL commit as READY_FOR_INTEGRATION
    (releases the claim, status stays doing; no push, no version bumps — the orchestrator publishes).
  sidequest submit <id|SQ-n> --clear [-s todo]     orchestrator reset: drop a submission after a bounced integration
  sidequest publish lock|unlock|status [--repo path] [--steal] [--force]   cross-process publish lock (owner pid +
    session metadata in the repo's common git dir; stale/dead holders reclaimable, --steal takes over explicitly)
  sidequest publish queue [--json]                 tickets awaiting the publish transaction, oldest first
  A claim guarantees no other worker is on the ticket. Never work a ticket whose claim did not succeed.
  When 2+ ready tickets are independent (no shared files), fan out one subagent per ticket in parallel.
  sidequest add/update ... --file path [--file path...] (or --files "path,...")   declare the files a ticket will touch — repeat for
    several; "none" clears (update only). 'ready' groups tickets into parallel-safe waves by declared file
    scope: tickets in the same wave never touch overlapping files/directories; untagged tickets never conflict.
  sidequest add/update ... --produces name --changes name --consumes name   declare free-form contract edges;
    'ready --brief' reports a produce/consume or change/change collision in waveDependencies. --contract-waiver
    is a reviewed override and can be cleared with --contract-waiver=false.
  sidequest add/update ... --anchors "file:line symbol" --verify "<exact command>"
    seed a bounded executor with investigation findings and its exact check. Anchors (4k), verify (1k), and the
    final prompt (7.6k) stay below the Windows command-line ceiling; values are preserved verbatim.

Complexity is legacy input. Category routing chooses the concrete model and effort:
  sidequest add ... --category <id>
  sidequest update <id|SQ-n> --category <id|none>
  sidequest ready --model <model> --category <id>  ·  sidequest next --model <model> --category <id>
  sidequest models [--project <path-or-slug>] [--json]  available models and the selected project's effective category routes
  sidequest route <category> [--project <path-or-slug>] --json  live workflow agent recipe for a category
  sidequest global-fallback [--model <model> --effort <effort>] [--json]
  Legacy --complexity + --why remains supported for existing intake and maps to a category at read time.
  Ticket model and effort are resolved from its category. Use category add/edit to change routing policy.

Native Agent dispatch (routed work stays in this conversation):
  sidequest dispatch <SQ-n> [--shared-tree] [--project <path-or-slug>] [--session id]  prepare a token-gated dispatch: declared-file tickets use worktrees unless shared state or bounded artifact output is explicit
  sidequest briefing <SQ-n> --token <token> [--project <path-or-slug>]  print the current token-gated executor briefing
  sidequest native-agent <SQ-n> [--prompt "task"] [--shared-tree] [--json]  return an already-registered native Agent spawn spec + bounded prompt
  sidequest native-agent cleanup --name <name>        clean up any legacy temporary native Agent definition
    Invoke the returned executor through the current conversation's Agent tool. It is already registered; native-agent does not write a temporary definition.
    \`sidequest work\`/\`drain\` are disabled because they cannot invoke Agent and never start a separate Claude process.
  sidequest reconcile [--session <id>] [--reason "..."]   release a session's stale claims back to todo now
    (the SessionEnd hook calls this automatically on the session id it's given, so a crashed/ended worker's
    tickets recover immediately instead of waiting out the claim TTL; safe — it only touches that session's
    claims). Defaults to \$CLAUDE_CODE_SESSION_ID when --session is omitted.
  sidequest claims sweep [--project <path-or-slug>]  release claims older than SIDEQUEST_CLAIM_TTL_MIN (default 60m)
  sidequest worktrees sweep [--dry-run] [--yes] [--min-age-hours N] [--project <path-or-slug>]  list agent worktrees; removes only clean, patch-equivalent, older-than-3h entries

Assigning (persistent owner, e.g. handing a ticket to the human — separate from a claim):
  sidequest assign <id|SQ-n> [--to who=you]        assign a ticket (defaults to "you", the human)
  sidequest unassign <id|SQ-n>                      clear the assignee

Reminders (fires into the notification queue/bell inbox when the dashboard server is running):
  sidequest remind <id|SQ-n> --in 1h|3h|tomorrow   schedule a reminder from a preset
  sidequest remind <id|SQ-n> --at "<date/time>"    or a specific date/time
  sidequest unremind <id|SQ-n>                      cancel a pending reminder

Comments:
  sidequest comment <id|SQ-n> (-m "body" | --body-file path) [--by who]   durable cross-actor handoff; keep going
  sidequest comments <id|SQ-n> [--json] [--full]   list a ticket's comment thread

Links / dependencies:
  sidequest link <id|SQ-n> <blocks|depends-on|related> <id|SQ-n>   relate two tickets (inverse auto-set)
  sidequest unlink <id|SQ-n> <id|SQ-n>             remove the link between two tickets
  A ticket blocked by an unfinished ticket is skipped by 'next'/'ready' and shown as blocked.

Archive (put finished work out of the way, restorable):
  sidequest archive <id|SQ-n>                      archive one ticket    ·    --done archives ALL done
  sidequest unarchive <id|SQ-n>                    restore an archived ticket
  sidequest list --archived                        list archived tickets
  sidequest archive-board <board-ref>               archive a board (explicit reference required)
  sidequest unarchive-board <board-ref>             restore an archived board
  sidequest projects --archived                     list archived boards

User stories (a lightweight grouping tickets can belong to):
  sidequest story add -t "title" [-d desc] [--color <name|hex>]   create a story (prints its US-n ref)
  sidequest story list                             list stories with their color and ticket count
  sidequest story show US-n                         show a story and the tickets in it
  sidequest story contract US-n [-m text|--body-file path]  read or set its execution contract
  sidequest story update US-n [-t] [-d] [--color]  edit a story
  sidequest story rm US-n                           delete a story (member tickets are detached)
  sidequest add ... --story <US-n>                 file a ticket straight into a story
  sidequest update <id|SQ-n> --story <US-n|none>   move a ticket into a story, or "none" to clear
  --color names: ${colorNames} (or any #rrggbb hex)

Project selection:
  Boards are anchored to the git repo you're in: the CLI walks up from
  $CLAUDE_PROJECT_DIR (or the current directory) to the nearest .git, so running
  it from a subfolder uses the repo's one board instead of minting a duplicate.
  A folder with no repo is used as-is.
  --project <path-or-slug>   target another board  ·  --name <name>   set its display name
    A slug or display name must already be registered. An absolute path to a real
    directory is created on first use, so you can file into another repo's board
    (even one that doesn't exist yet) from anywhere by passing its full path.
  sidequest board-config [--name <display-name>] [--always-in-scope <path>...] [--integration-mode <auto|local|remote>] [--worktree-isolation|--no-worktree-isolation] [--worktree-setup <command>]
    View or update board settings. --name changes only the display name; the slug, path, tickets, claims, and refs stay put.
  sidequest merge <src> <dst> [--dry-run]   fold one board entirely into another
    (renumbers refs above the destination's, remaps links, moves assets, then
    deletes the source). --dry-run prints the ref mapping without touching disk.

Tickets and their images are stored centrally (default ~/.claude/sidequest), so
one dashboard shows every project's board at once.`
  );
}

function fail(msg: any) {
  console.error(`sidequest: ${msg}`);
  process.exit(1);
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  const { opts, positional } = parseArgs(argv.slice(1));

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    help();
    return;
  }
  if (cmd === '--version' || cmd === '-V' || cmd === 'version') {
    console.log(PLUGIN_VERSION || 'unknown');
    return;
  }
  if (opts.help) {
    if (!commandHelp(cmd)) help();
    return;
  }

  switch (cmd) {
    case 'add':
    case 'new':
    case 'ticket':
      await cmdAdd(opts);
      break;
    case 'list':
    case 'ls':
      await cmdList(opts);
      break;
    case 'pulse':
      await cmdPulse(opts, positional);
      break;
    case 'changes':
      await cmdChanges(opts);
      break;
    case 'update':
    case 'edit':
    case 'set':
      await cmdUpdate(opts, positional);
      break;
    case 'rm':
    case 'remove':
    case 'delete':
      await cmdRm(opts, positional);
      break;
    case 'profile':
    case 'profiles':
      await cmdProfile(opts, positional);
      break;
    case 'category':
    case 'categories':
      await cmdCategory(opts, positional);
      break;
    case 'global-fallback':
    case 'global_fallback':
      await cmdGlobalFallback(opts);
      break;
    case 'claim':
    case 'take':
      await cmdClaim(opts, positional);
      break;
    case 'checkpoint':
      await cmdCheckpoint(opts, positional);
      break;
    case 'claims':
      if (positional[0] !== 'sweep') fail('claims: expected `sidequest claims sweep`');
      await cmdSweepClaims(opts);
      break;
    case 'worktrees':
      await cmdWorktrees(opts, positional);
      break;
    case 'next':
    case 'grab':
      await cmdNext(opts);
      break;
    case 'reconcile':
      await cmdReconcile(opts);
      break;
    case 'work':
    case 'drain':
      await cmdWork(opts);
      break;
    case 'groom-close':
      await cmdGroomClose(opts, positional);
      break;
    case 'done':
    case 'complete':
    case 'finish':
      await cmdDone(opts, positional);
      break;
    case 'scope-request':
    case 'scope_request':
      await cmdScopeRequest(opts, positional);
      break;
    case 'commit':
      await cmdCommit(opts, positional);
      break;
    case 'submit':
      await cmdSubmit(opts, positional);
      break;
    case 'publish':
      await cmdPublish(opts, positional);
      break;
    case 'release':
    case 'unclaim':
      await cmdRelease(opts, positional);
      break;
    case 'assign':
      await cmdAssign(opts, positional, false);
      break;
    case 'unassign':
      await cmdAssign(opts, positional, true);
      break;
    case 'remind':
      await cmdRemind(opts, positional);
      break;
    case 'unremind':
      await cmdUnremind(opts, positional);
      break;
    case 'comment':
      await cmdComment(opts, positional);
      break;
    case 'comments':
      await cmdComments(opts, positional);
      break;
    case 'link':
      await cmdLink(opts, positional);
      break;
    case 'unlink':
      await cmdUnlink(opts, positional);
      break;
    case 'ready':
      await cmdReady(opts);
      break;
    case 'archive':
      await cmdArchive(opts, positional);
      break;
    case 'unarchive':
    case 'restore':
      await cmdUnarchive(opts, positional);
      break;
    case 'dispatch':
      await cmdDispatch(opts, positional);
      break;
    case 'briefing':
      await cmdBriefing(opts, positional);
      break;
    case 'native-agent':
    case 'native_agent':
      await cmdNativeAgent(opts, positional);
      break;
    case 'models':
      await cmdModels(opts, positional);
      break;
    case 'route':
      await cmdRoute(opts, positional);
      break;
    case 'board-config':
    case 'board_config':
      await cmdBoardConfig(opts);
      break;
    case 'projects':
    case 'boards':
      await cmdProjects(opts);
      break;
    case 'routing':
      await cmdRouting(opts, positional);
      break;
    case 'archive-board':
    case 'archive_board':
      await cmdArchiveBoard(opts, positional);
      break;
    case 'unarchive-board':
    case 'unarchive_board':
    case 'restore-board':
      await cmdUnarchiveBoard(opts, positional);
      break;
    case 'merge':
      await cmdMerge(opts, positional);
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
      await cmdStop();
      break;
    case 'story':
      await cmdStory(opts, positional);
      break;
    default:
      fail(`unknown command "${cmd}". Run "sidequest help".`);
  }
}

main().catch((err: any) => {
  console.error(`sidequest: ${(err && err.message) || err}`);
  process.exit(1);
});
