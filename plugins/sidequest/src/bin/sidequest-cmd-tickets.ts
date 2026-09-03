const path = require('path');
const os = require('os');
const fs = require('node:fs/promises');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const store = require('../lib/store');
const agentsync = require('../lib/agentsync');
const work = require('../lib/work');
const commitScope = require('../lib/commit-scope');
const worktrees = require('../lib/worktrees');
const tempCleanup = require('../lib/temp-cleanup');
const execNames = require('../lib/exec-names');
const { claimRefusalMessage } = require('../lib/refusal-guidance');
const { assertSidequestInstall, assertDispatchTransport } = require('../lib/dispatch-preflight');

const { bodyFromOpts, fail, resolveProject } = require('./sidequest-cmd-shared');
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
  const value = String(opts.readonly).toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;
  fail('--readonly accepts true or false.');
}

function workingTreeDeliveryFromOpts(opts: any) {
  if (opts['working-tree-delivery'] === undefined) return undefined;
  return opts['working-tree-delivery'] !== false && String(opts['working-tree-delivery']).toLowerCase() !== 'false';
}

function externalDeliverableFromOpts(opts: any) {
  if (opts['external-deliverable'] === undefined) return undefined;
  return opts['external-deliverable'] !== false && String(opts['external-deliverable']).toLowerCase() !== 'false';
}

function reviewTargetFromOpts(opts: any) {
  const ref = opts['review-ref'];
  const commit = opts['review-commit'];
  const source = opts['review-source'];
  const value = opts['review-revision'];
  if (![ref, commit, source, value].some((entry) => entry != null)) return undefined;
  if (!ref) fail('--review-ref names the reviewed ticket and is required with a review target.');
  const hasCommit = commit != null;
  const hasRevision = source != null || value != null;
  if (hasCommit === hasRevision) fail('pass exactly --review-commit, or both --review-source and --review-revision.');
  if (hasRevision && (!source || !value)) fail('--review-source and --review-revision must be provided together.');
  return { ref, ...(hasCommit ? { commit } : { sourceRevision: { source, value } }) };
}

function highStakesFromOpts(opts: any) {
  if (opts['high-stakes'] === undefined) return undefined;
  return String(opts['high-stakes']).toLowerCase() !== 'false';
}

function ticketRouteFromOpts(opts: any, allowClear = false) {
  if (allowClear && opts.route === 'none') return null;
  const hasModel = opts['route-model'] != null;
  const hasEffort = opts['route-effort'] != null;
  if (!hasModel && !hasEffort) return undefined;
  if (!hasModel || !hasEffort) fail('--route-model and --route-effort must be provided together.');
  const route = store.normalizeRoute({ model: opts['route-model'], effort: opts['route-effort'] });
  if (!route) fail('ticket route override requires a valid model and effort.');
  if (!store.availableRoute(route.model)) fail(`ticket route override model "${route.model}" isn't currently available.`);
  return route;
}

async function ticketDescriptionFromOpts(opts: any, command: any) {
  return bodyFromOpts(Object.assign({}, opts, { body: opts.body ?? opts.desc ?? opts.description }), command);
}

async function addPreview(opts: any, category: any, complexity: any) {
  const description = await ticketDescriptionFromOpts(opts, 'add');
  const priority = store.VALID_PRIORITY.includes(String(opts.priority || '').toLowerCase())
    ? String(opts.priority).toLowerCase()
    : 'normal';
  return {
    title: String(opts.title).trim().slice(0, 300) || 'Untitled',
    description: String(description ?? opts.desc ?? opts.description ?? opts.body ?? '').trim(),
    status: String(opts.status || 'todo').toLowerCase(),
    priority,
    highStakes: highStakesFromOpts(opts) || false,
    labels: opts.label || [],
    images: opts.image || [],
    files: opts.file ?? opts.files ?? [],
    contracts: contractsFromOpts(opts),
    contractWaiver: contractWaiverFromOpts(opts) || false,
    readonly: readonlyFromOpts(opts),
    workingTreeDelivery: workingTreeDeliveryFromOpts(opts),
    externalDeliverable: externalDeliverableFromOpts(opts),
    executorAnchors: opts.anchors || '',
    executorVerifyKind: opts['verify-kind'],
    executorAttestationArtifact: opts['attestation-artifact'],
    executorVerify: opts.verify || '',
    storyId: opts.story || null,
    category,
    reviewTarget: reviewTargetFromOpts(opts),
    route: ticketRouteFromOpts(opts),
    complexity,
    complexityWhy: opts.why || '',
    source: opts.source || 'cli',
  };
}

async function cmdAdd(opts: any) {
  if (opts.priority === 'medium') opts.priority = 'normal';
  const input = validatedAddInput(opts);
  if (opts['dry-run']) {
    const ticket = await addPreview(opts, input.category, input.complexity);
    if (opts.json) {
      process.stdout.write(JSON.stringify({ ok: true, dryRun: true, ticket }, null, 2) + '\n');
      return;
    }
    console.log(`Dry run: would create "${ticket.title}" [${ticket.status}/${ticket.priority}]`);
    console.log(JSON.stringify(ticket, null, 2));
    return;
  }
  const { slug, meta } = await resolveProject(opts);
  const description = await ticketDescriptionFromOpts(opts, 'add');
  const category = input.category == null ? null : categoryIdOrFail(slug, input.category);
  const route = ticketRouteFromOpts(opts);
  const warnings: any = [];
  const created = store.createTicket(slug, {
    title: opts.title,
    description: description ?? opts.desc ?? opts.description ?? '',
    priority: opts.priority,
    status: opts.status,
    highStakes: highStakesFromOpts(opts),
    labels: opts.label,
    images: opts.image || [],
    files: opts.file ?? opts.files,
    contracts: contractsFromOpts(opts),
    contractWaiver: contractWaiverFromOpts(opts),
    readonly: readonlyFromOpts(opts),
    workingTreeDelivery: workingTreeDeliveryFromOpts(opts),
    externalDeliverable: externalDeliverableFromOpts(opts),
    executorAnchors: opts.anchors,
    executorVerifyKind: opts['verify-kind'],
    executorAttestationArtifact: opts['attestation-artifact'],
    executorVerify: opts.verify,
    storyId: opts.story,
    complexity: opts.complexity,
    complexityWhy: opts.why,
    category,
    route,
    source: opts.source || 'cli',
    onAssetError: (src: any) => warnings.push(`could not attach image: ${src}`),
  }, reviewTargetFromOpts(opts));
  // Re-read through getTicket so the returned ticket carries its derived
  // model/effort (stamped from complexity at read time) for display/JSON.
  const ticket = store.getTicket(slug, created.ref) || created;
  warnings.push(...store.ticketReferenceWarnings(slug, ticket.title, ticket.description));
  warnings.push(...store.ticketCategoryWarnings(ticket));
  warnings.push(...store.ticketPlanningWarnings(ticket, meta.path));
  warnings.splice(0, warnings.length, ...store.presentWarnings(ticket, warnings));

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
  // the shape can't drift. Default reads contain only active tickets and one
  // bounded page; --status done or --all opts into completed tickets.
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
  else if (!opts.all) tickets = tickets.filter((t: any) => t.status === 'todo' || t.status === 'doing' || t.status === 'awaiting-oracle');
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
      const clm = t.claim && t.claim.by ? `  @${t.claim.by}${store.claimReclaimable(t) ? ' (reclaimable)' : ''}` : '';
      const asn = t.assignee ? `  \u{1F464}${t.assignee}` : '';
      const blockers = store.openBlockers(slug, t);
      const blk = blockers.length ? `  ⛔ blocked-by ${blockers.join(',')}` : '';
      const lnk = t.links && t.links.length ? `  ⇄${t.links.length}` : '';
      const cmt = t.comments && t.comments.length ? `  \u{1F4AC}${t.comments.length}` : '';
      const files = t.files && t.files.length ? `  \u{1F4C1}${t.files.length}` : '';
      const readonly = t.readonlyOverride === false ? '  readonly:false' : '';
      const oracle = store.oracleProjection(t);
      const awaitingOracle = oracle ? `  ${oracle.summary}` : '';
      console.log(`    ${t.ref}${pr}  ${t.title}${labels}${imgs}${files}${readonly}${cmt}${lnk}${blk}${clm}${asn}${modelMark(t)}${awaitingOracle}`);
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
  const description = await ticketDescriptionFromOpts(opts, 'update');
  const patch: any = {};
  if (opts.title != null) patch.title = opts.title;
  if (description != null || opts.desc != null || opts.description != null) patch.description = description ?? (opts.desc != null ? opts.desc : opts.description);
  if (opts.status != null) patch.status = opts.status;
  if (opts.priority != null) patch.priority = opts.priority === 'medium' ? 'normal' : opts.priority;
  if (opts['high-stakes'] !== undefined) patch.highStakes = highStakesFromOpts(opts);
  if (opts.label != null) patch.labels = opts.label;
  if (opts.image != null) patch.images = opts.image;
  if (opts.file != null || opts.files != null) {
    const files = opts.file != null ? opts.file : opts.files;
    patch.files = (Array.isArray(files) && files.length === 1 && String(files[0]).toLowerCase() === 'none') || String(files).toLowerCase() === 'none' ? [] : files;
  }
  if (opts.produces !== undefined || opts.changes !== undefined || opts.consumes !== undefined) patch.contracts = contractsFromOpts(opts, current && current.contracts);
  if (opts['contract-waiver'] !== undefined) patch.contractWaiver = contractWaiverFromOpts(opts);
  if (opts.readonly !== undefined) patch.readonly = readonlyFromOpts(opts);
  if (opts['working-tree-delivery'] !== undefined) patch.workingTreeDelivery = workingTreeDeliveryFromOpts(opts);
  if (opts['external-deliverable'] !== undefined) patch.externalDeliverable = externalDeliverableFromOpts(opts);
  if (opts.anchors != null) patch.executorAnchors = opts.anchors;
  if (opts.verify != null) patch.executorVerify = opts.verify;
  if (opts['verify-kind'] != null) patch.executorVerifyKind = opts['verify-kind'];
  if (opts['attestation-artifact'] != null) patch.executorAttestationArtifact = opts['attestation-artifact'];
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
  const route = ticketRouteFromOpts(opts, true);
  if (route !== undefined) patch.route = route;
  patch.by = String(opts.by || '').trim() || null;
  patch.source = opts.source || 'cli'; // a CLI/subagent change (Claude), not the dashboard
  const saved = store.updateTicket(slug, idOrRef, patch, reviewTargetFromOpts(opts));
  if (!saved) fail(`update: no ticket "${idOrRef}" in ${meta.name}`);
  // Re-read so derived model/effort (stamped from complexity at read time) show.
  const updated = store.getTicket(slug, saved.ref) || saved;
  const warnings: any = [
    ...store.ticketReferenceWarnings(slug, patch.title, patch.description),
    ...store.ticketPlanningWarnings(updated, meta.path),
  ];
  warnings.splice(0, warnings.length, ...store.presentWarnings(updated, warnings));
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


async function cmdRm(opts: any, positional: any) {
  const idOrRef = positional[0];
  if (!idOrRef) fail('rm: pass a ticket id or ref, e.g. sidequest rm SQ-4');
  const { slug, meta } = await resolveProject(opts);
  const ticket = store.getTicket(slug, idOrRef);
  if (!ticket) fail(`rm: no ticket "${idOrRef}" in ${meta.name}`);
  if (ticket.claim && ticket.claim.by && !store.claimReclaimable(ticket)) {
    fail(`rm: ${ticket.ref} is live-claimed by "${ticket.claim.by}"; release the claim first (rm --force cannot override a live claim).`);
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

module.exports = { cmdAdd, cmdList, cmdPulse, cmdChanges, cmdUpdate, cmdRm, PRIORITY_MARK, modelMark, categoryIdOrFail, categoryEcho, categoryEchoLine, contractsFromOpts, contractWaiverFromOpts, readonlyFromOpts, highStakesFromOpts, ticketRouteFromOpts };
