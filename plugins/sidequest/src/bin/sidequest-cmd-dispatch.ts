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

const { fail, resolveProject, workerId, sessionId } = require('./sidequest-cmd-shared');
async function cmdDispatch(opts: any, positional: any) {
  const idOrRef = positional[0];
  if (!idOrRef) fail('dispatch: pass a ticket ref, e.g. sidequest dispatch SQ-12.');
  const { slug, meta } = await resolveProject(opts);
  const ticket = store.getTicket(slug, idOrRef);
  const descriptionError = store.dispatchDescriptionError(ticket);
  if (descriptionError) fail(descriptionError);
  const sessionId = opts.session || process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || null;
  const unverifiedTransport = !!opts['unverified-transport'];
  let prepared;
  try {
    prepared = store.prepareDispatch(slug, idOrRef, {
      sessionId,
      sharedTree: !!opts['shared-tree'],
      allowRepeatFailure: !!opts['allow-repeat-failure'],
      allowUnscoped: !!opts['allow-unscoped'],
      source: 'cli',
      transport: 'cli',
      allowUnverifiedTransport: unverifiedTransport,
    });
  } catch (err: any) {
    fail(`dispatch: ${(err && err.message) || err}`);
  }
  const isolation = agentsync.ticketIsolation(prepared.ticket, prepared.ticket.dispatch && prepared.ticket.dispatch.sharedTree);
  const prompt = agentsync.renderDispatchStub(prepared.ticket, prepared.token, meta.path);
  const resolved = store.resolveExec(prepared.ticket.model, prepared.ticket.effort);
  const agent = prepared.ticket.dispatchExecutor;
  const dispatchState = prepared.ticket.dispatch || {};
  const spawn = agentsync.agentSpawn(dispatchState.launchName, isolation, resolved && resolved.model, agent, prompt, dispatchState.description);
  const warnings = store.dispatchWarnings(prepared.ticket);
  if (unverifiedTransport) {
    warnings.push('dispatch warning: --unverified-transport was used — this does NOT prove any session will have the Sidequest board MCP connected; a fresh native Agent could still receive zero board tools.');
  }
  const presentedWarnings = store.presentWarnings(prepared.ticket, warnings, sessionId);
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
    warnings: presentedWarnings,
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

async function cmdTempCleanup(opts: any, positional: any) {
  if (positional[0] && positional[0] !== 'cleanup') fail('temp: expected `sidequest temp cleanup`');
  const report = tempCleanup.cleanupTempRoots({ root: opts.root });
  if (opts.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return;
  }
  console.log(`✓ temp cleanup: removed ${report.removed} root(s), ${report.removedEntries} entr${report.removedEntries === 1 ? 'y' : 'ies'}; scanned ${report.scanned}; skipped ${report.skippedRecent.length} recent, ${report.skippedUnsafe.length} unsafe, ${report.failed.length} failed`);
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
  // native-agent does not go through prepareDispatch, so it needs its own copy
  // of the same install preflight (SQ-1017) — see dispatch-preflight.js.
  const unverifiedTransport = !!opts['unverified-transport'];
  if (meta.path) {
    try {
      assertSidequestInstall(meta.path);
      assertDispatchTransport('cli', { allowUnverifiedTransport: unverifiedTransport });
    } catch (err: any) {
      fail(`native-agent: ${(err && err.message) || err}`);
    }
  }
  const ticket = store.getTicket(slug, idOrRef);
  if (!ticket) fail(`native-agent: no ticket "${idOrRef}".`);
  const route = store.resolveTicketRoute(ticket, ticket.category);
  if (!route || !route.exec) fail(`native-agent: ${route?.refusal || `${ticket.ref} has no routable model and effort.`}`);
  const resolved = route.exec;
  const sessionId = opts.session || process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || null;
  const prompt = agentsync.withProjectIdentity(work.executorPrompt(ticket, opts.prompt || `Work ${ticket.ref}: ${ticket.title}`), meta.path);
  const sharedTree = store.boardConfig(slug)?.worktreeIsolation === false || !!opts['shared-tree'];
  const created = agentsync.createNativeAgent({
    ref: ticket.ref,
    agentType: resolved.agent || `sidequest-exec-${route.effort || 'low'}`,
    spawnModel: resolved.model,
    effort: route.effort,
    runtime: resolved.runsModel,
    launchName: execNames.dispatchLaunchName(ticket.ref, ticket.title),
    description: agentsync.spawnDescription(ticket, resolved),
    isolation: agentsync.ticketIsolation(ticket, sharedTree),
    sessionId,
    prompt,
  });
  const warnings = unverifiedTransport
    ? ['native-agent warning: --unverified-transport was used — this does NOT prove any session will have the Sidequest board MCP connected; this native Agent could still receive zero board tools.']
    : undefined;
  process.stdout.write(JSON.stringify(Object.assign({ project: slug, projectPath: meta.path, ref: ticket.ref, effort: ticket.effort, exec: ticket.exec, prompt }, created, warnings ? { warnings } : {}), null, 2) + '\n');
}

// `sidequest models sync-agents` — regenerate the runtime
// sidequest-exec-<slug>-<effort>.md agent files for every tier pointed at a
// Codex model (prefs.tierBackend) x that tier's enabled non-max effort, without
// touching the dashboard (which triggers the same sync on save). Useful after
// changing a tier's backend some other way, or to clean up stale files.
async function cmdModelsSyncAgents(opts: any) {
  const { slug } = await resolveProject(opts);
  const config = store.boardConfig(slug);
  const res = agentsync.syncExecAgents(undefined, {
    ...(opts.dir ? { dir: opts.dir } : {}),
    readOnlyDeniedTools: config?.readOnlyDeniedTools,
  });
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
  const payload = store.modelsPayload({ project: slug, full: !!opts.full });
  if (opts.json) {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    return;
  }
  console.log('Available models:');
  console.log(`  ${payload.models.join(', ')}`);
  console.log(`Global fallback: ${payload.globalFallback ? `${payload.globalFallback.model}·${payload.globalFallback.effort}` : 'missing or invalid'}`);
  console.log('Categories:');
  for (const category of payload.categories) {
    if (!opts.full) {
      console.log(`  ${category.id}  ${category.route || 'unresolved'}`);
      continue;
    }
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
  const ticket = opts.ticket == null ? null : store.getTicket(slug, opts.ticket);
  if (opts.ticket != null && !ticket) fail(`route: no ticket "${opts.ticket}".`);
  const ticketCategoryId = ticket && (ticket.categoryId || (typeof ticket.category === 'object' ? ticket.category.id : ticket.category));
  if (ticket && ticketCategoryId !== category.id) fail(`route: ticket "${ticket.ref}" belongs to category "${ticketCategoryId || 'none'}", not "${category.id}".`);
  const resolved = ticket ? store.resolveTicketRoute(ticket, category) : store.resolveCategoryRoute(category);
  if (!resolved || !resolved.exec) fail(resolved?.refusal || `route: category "${category.id}" has no available route.`);
  const recipe = agentsync.workflowRecipe(Object.assign({}, category, { project: slug }), resolved);
  const selected = store.projectRoutingProfile(slug);
  process.stdout.write(JSON.stringify(Object.assign({}, recipe, {
    profile: { id: selected.profile.id, revision: selected.profile.revision },
    categorySource: { kind: category.origin || 'profile', baseProfileId: category.baseProfileId || null },
    ...(ticket ? { ticket: { ref: ticket.ref, route: ticket.route || null } } : {}),
  }), null, 2) + '\n');
}

async function cmdBoardConfig(opts: any) {
  const { slug, meta } = await resolveProject(Object.assign({}, opts, { name: undefined }));
  const patch: any = {};
  if (opts.name != null) patch.name = opts.name;
  if (opts['always-in-scope'] != null) patch.alwaysInScope = opts['always-in-scope'];
  if (opts['read-only-denied-tool'] != null) patch.readOnlyDeniedTools = opts['read-only-denied-tool'];
  if (opts['generated-pairs'] != null) {
    try { patch.generatedPairs = JSON.parse(opts['generated-pairs']); } catch (_: any) { fail('board-config: --generated-pairs must be a JSON array of { from, to } patterns.'); }
  }
  if (opts['integration-mode'] != null) patch.integrationMode = opts['integration-mode'];
  if (opts['integration-branch'] != null) patch.integrationBranch = opts['integration-branch'];
  if (opts.delivery != null) patch.delivery = opts.delivery;
  if (opts['integration-verify-timeout-ms'] != null) patch.integrationVerifyTimeoutMs = opts['integration-verify-timeout-ms'];
  if (opts['worktree-isolation'] !== undefined) patch.worktreeIsolation = opts['worktree-isolation'];
  if (opts['not-integrated-salvage-age-hours'] != null) patch.notIntegratedSalvageAgeHours = opts['not-integrated-salvage-age-hours'];
  if (opts['auto-approve-test-scope'] !== undefined) patch.autoApproveTestScope = opts['auto-approve-test-scope'];
  if (opts['auto-approve-scope'] != null) patch.autoApproveScope = opts['auto-approve-scope'];
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
  console.log(`generated pairs: ${payload.generatedPairs.length ? payload.generatedPairs.map((pair: any) => `${pair.from} -> ${pair.to}`).join(', ') : '(none)'}`);
  console.log(`integration mode: ${payload.integrationMode}`);
  console.log(`integration branch: ${payload.integrationBranch}`);
  console.log(`delivery: ${payload.delivery}`);
  console.log(`integration verify timeout: ${payload.integrationVerifyTimeoutMs}ms`);
  console.log(`worktree isolation: ${payload.worktreeIsolation ? 'enabled' : 'disabled'}`);
  console.log(`unintegrated worktree salvage age: ${payload.notIntegratedSalvageAgeHours}h`);
  console.log(`test scope auto-approval: ${payload.autoApproveTestScope ? 'enabled' : 'disabled'}`);
  console.log(`configured scope auto-approval: ${payload.autoApproveScope.length ? payload.autoApproveScope.join(', ') : '(none)'}`);
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

module.exports = { cmdDispatch, cmdBriefing, cmdTempCleanup, cmdNativeAgent, cmdModels, cmdRoute, cmdBoardConfig, cmdProjects, cmdRouting, cmdArchiveBoard, cmdUnarchiveBoard, cmdMerge };
