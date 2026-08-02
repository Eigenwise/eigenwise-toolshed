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


async function cmdTempCleanup(opts: any, positional: any) {
  if (positional[0] && positional[0] !== 'cleanup') fail('temp: expected `sidequest temp cleanup`');
  const report = tempCleanup.cleanupTempRoots({ root: opts.root });
  if (opts.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return;
  }
  console.log(`✓ temp cleanup: removed ${report.removed} root(s), ${report.removedEntries} entr${report.removedEntries === 1 ? 'y' : 'ies'}; scanned ${report.scanned}; skipped ${report.skippedRecent.length} recent, ${report.skippedUnsafe.length} unsafe, ${report.failed.length} failed`);
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
  if (opts['auto-approve-plugin-tests'] !== undefined) patch.autoApprovePluginTests = opts['auto-approve-plugin-tests'];
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
  console.log(`plugin test scope auto-approval: ${payload.autoApprovePluginTests ? 'enabled' : 'disabled'}`);
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


/* ------------------------------------------------------------------ *
 *  User stories (a lightweight grouping tickets can belong to)
 * ------------------------------------------------------------------ */

// Count non-archived tickets that belong to a given story.

module.exports = { cmdTempCleanup, cmdBoardConfig, cmdProjects, cmdArchiveBoard, cmdUnarchiveBoard };
