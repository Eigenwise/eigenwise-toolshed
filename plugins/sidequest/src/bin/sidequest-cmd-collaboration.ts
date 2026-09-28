const path = require('path');
const os = require('os');
const fs = require('node:fs/promises');
const { existsSync } = require('node:fs');
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

const { fail, resolveProject, workerId, controlPlaneIdentity, sessionId, bodyFromOpts } = require('./sidequest-cmd-shared');
const { modelMark, PRIORITY_MARK } = require('./sidequest-cmd-tickets');
const { validateModelFilter } = require('./sidequest-cmd-execution');
async function cmdSweepClaims(opts: any) {
  const { slug, meta } = await resolveProject(opts);
  const res = store.sweepStaleClaims({ project: slug, source: opts.source || 'cli' });
  if (opts.json) {
    process.stdout.write(JSON.stringify(Object.assign({ project: slug }, res), null, 2) + '\n');
    return;
  }
  const kinds = res.released.map((entry: any) => entry.kind).filter(Boolean);
  const detail = kinds.length ? `: ${kinds.join(', ')}` : '';
  console.log(`✓ swept ${res.released.length} dead claim(s) from ${meta.name}${detail} (idle backstop ${Math.round(res.idleMs / 60000)}m, abandoned ${Math.round(res.abandonMs / 60000)}m)`);
}

type WorktreeSweepOutputEntry = {
  action: string;
  path: string;
  ticket?: string | null;
  reason: string;
  clean: boolean | null;
  ahead: number | null;
  patchEquivalent: boolean | null;
  ageMs: number | null;
  quarantine?: string;
};

type WorktreeSweepProgress = {
  phase: 'classifying' | 'sweeping' | 'complete';
  candidates: number;
  observed: number;
  current: string | null;
  reason: string | null;
  planned: number;
  removed: number;
  keptByReason: Record<string, number>;
};

function worktreeSweepProgressLine(progress: WorktreeSweepProgress): string {
  const candidate = progress.current ? `: ${progress.current}` : '';
  const reason = progress.reason ? ` (${progress.reason})` : '';
  const count = progress.phase === 'classifying' ? ` ${progress.observed}/${progress.candidates}${candidate}${reason}` : '';
  return `worktrees sweep: ${progress.phase}${count}; planned ${progress.planned}, removed ${progress.removed}`;
}

function worktreeSweepEntryLine(entry: WorktreeSweepOutputEntry): string {
  const ticket = entry.ticket ? ` ${entry.ticket}` : '';
  const cleanliness = entry.clean === true ? 'clean' : entry.clean === false ? 'dirty' : 'cleanliness unavailable';
  const ahead = entry.ahead == null ? 'unavailable' : entry.ahead;
  const patchEquivalent = entry.patchEquivalent == null ? 'unavailable' : entry.patchEquivalent;
  const age = entry.ageMs == null ? 'unavailable' : `${Math.round(entry.ageMs / 60000)}m`;
  const quarantine = entry.quarantine ? `; quarantined ${entry.quarantine}` : '';
  return `  ${entry.action.toUpperCase()} ${entry.path}${ticket} [${entry.reason}; ${cleanliness}; ahead ${ahead}; patch-equivalent ${patchEquivalent}; age ${age}${quarantine}]`;
}

function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return 'unavailable';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function printStorage(storage: any): void {
  console.log(`  worktrees: ${formatBytes(storage.worktrees.bytes)} (${storage.worktrees.path})`);
  for (const directory of storage.worktrees.directories || []) {
    console.log(`    ${formatBytes(directory.bytes)} ${directory.path}`);
  }
  console.log(`  quarantine: ${formatBytes(storage.quarantine.bytes)} (${storage.quarantine.path})`);
  const total = [storage.worktrees.bytes, storage.quarantine.bytes]
    .filter((bytes: number | null) => bytes != null)
    .reduce((sum: number, bytes: number) => sum + bytes, 0);
  console.log(`  total: ${formatBytes(total)}`);
}

function printSweepResult(result: any, name: string, minAgeHours: number, recoveryRetentionAgeHours: number): void {
  console.log(`worktrees sweep: ${result.dryRun ? 'dry run' : 'executed'} for ${name} (minimum age ${minAgeHours}h; quarantine retention ${recoveryRetentionAgeHours}h by age alone)`);
  if (result.upstreamFallback) console.log(`  the configured integration ref is unavailable; settled checks used the fallback ${result.upstream}.`);
  if (result.storage.worktrees.bytes != null) printStorage(result.storage);
  for (const entry of result.entries) console.log(worktreeSweepEntryLine(entry));
  for (const entry of result.strayDirectories || []) {
    console.log(`  ${entry.action.toUpperCase()} STRAY ${entry.path} [${entry.reason}; ${entry.entries} entr${entry.entries === 1 ? 'y' : 'ies'}${entry.repository ? `; repository ${entry.repository}` : ''}]`);
  }
  for (const entry of result.recovery.quarantine.entries.filter((entry: any) => entry.action === 'remove')) {
    console.log(`  REMOVE ${entry.store.toUpperCase()} ${entry.path} [${entry.reason}; ${formatBytes(entry.sizeBytes)}]`);
  }
  if (result.dryRun) console.log('  pass --yes to remove the planned worktree and recovery entries.');
  if (result.removed.length) console.log(`  removed ${result.counts.removedWorktrees} worktree(s) and deleted ${result.counts.deletedBranches} branch(es).`);
  for (const entry of result.retainedBranches || []) console.log(`  KEPT BRANCH ${entry.branch} from ${entry.path}; ${worktrees.retainedBranchExplanation(entry.reason, result.upstream)}.`);
  if (result.counts.removedStrayDirectories) console.log(`  removed ${result.counts.removedStrayDirectories} empty stray worktree directory(s).`);
  if (result.counts.removedRecoveryEntries) console.log(`  removed ${result.counts.removedRecoveryEntries} recovery entry(s), reclaimed ${formatBytes(result.counts.reclaimedBytes)}.`);
  for (const entry of result.salvaged || []) console.log(`  SALVAGED ${entry.path} at ${entry.ref}; recover with ${entry.recovery}`);
  if (result.prunedOrphanBranches.length) console.log(`  pruned ${result.counts.prunedOrphanBranches} orphan worktree branch(es).`);
  if (result.remainingCandidates) console.log(`  ${result.remainingCandidates} candidate(s) remain past this run's limit; re-run to continue.`);
  for (const failure of result.failures) console.log(`  ERROR ${failure.path || 'prune'}: ${failure.message}`);
}

async function cmdWorktrees(opts: any, positional: any) {
  const action = String(positional[0] || '').toLowerCase();
  if ((action && !['status', 'sweep'].includes(action)) || (!action && !opts.sweep)) {
    fail('worktrees: use `sidequest worktrees status` or `sidequest worktrees sweep` to inspect worktree storage.');
  }
  const { slug, meta } = await resolveProject(opts);
  if (action === 'status') {
    const storage = await worktrees.storageStatus();
    if (opts.json) {
      process.stdout.write(JSON.stringify({ project: slug, storage }, null, 2) + '\n');
      return;
    }
    console.log(`worktree storage for ${meta.name}`);
    printStorage(storage);
    return;
  }
  const minAgeHours = opts['min-age-hours'] == null ? 3 : Number(opts['min-age-hours']);
  if (!Number.isFinite(minAgeHours) || minAgeHours < 0) fail('worktrees sweep: --min-age-hours must be a non-negative number.');
  const config = store.boardConfig(slug) || {};
  const recoveryRetentionAgeHours = opts['recovery-retention-age-hours'] == null
    ? Number(config.worktreeRecoveryRetentionAgeHours || 14 * 24)
    : Number(opts['recovery-retention-age-hours']);
  if (!Number.isFinite(recoveryRetentionAgeHours) || recoveryRetentionAgeHours < 0) {
    fail('worktrees sweep: --recovery-retention-age-hours must be a non-negative number.');
  }
  // A missing integration ref used to abort the whole sweep for that project, which
  // is why projects with a stale integrationBranch never reclaimed anything; the
  // sweep falls back to origin's default or HEAD and says so (SQ-2924).
  const integrationTargetOrFallback = (projectSlug: string) => {
    try {
      return store.integrationTarget(projectSlug);
    } catch (_) {
      return null;
    }
  };
  const targets = opts['all-projects']
    ? store.listProjects({ all: true })
      .filter((project: any) => project && project.slug && project.path && existsSync(project.path))
      .sort((left: any, right: any) => String(left.slug).localeCompare(String(right.slug)))
      .map((project: any) => ({ slug: project.slug, name: project.name || project.slug, path: project.path }))
    : [{ slug, name: meta.name, path: meta.path }];
  const results: any[] = [];
  for (const [index, target] of targets.entries()) {
    let result;
    try {
      result = await worktrees.sweep(target.path, store.worktreeGcTickets(), {
        execute: !!opts.yes && !opts['dry-run'],
        currentPath: store.nearestRepoRoot(process.cwd()),
        integrationTarget: integrationTargetOrFallback(target.slug),
        minAgeMs: minAgeHours * 60 * 60 * 1000,
        recoveryRetentionAgeMs: recoveryRetentionAgeHours * 60 * 60 * 1000,
        // The store lives in one shared home, so measuring it once per run is
        // enough; repeating the walk per project is just slower.
        includeStoreUsage: index === 0,
        onProgress: (progress: WorktreeSweepProgress) => {
          const output = `${worktreeSweepProgressLine(progress)}\n`;
          (opts.json ? process.stderr : process.stdout).write(output);
        },
      });
    } catch (error: any) {
      if (!opts['all-projects']) fail(`worktrees: ${(error && error.message) || error}`);
      result = { project: target.slug, failures: [{ path: target.path, message: (error && error.message) || String(error) }] };
    }
    results.push(Object.assign({ project: target.slug }, result));
  }
  if (opts.json) {
    process.stdout.write(JSON.stringify(opts['all-projects'] ? { projects: results } : results[0], null, 2) + '\n');
    if (results.some((entry: any) => entry.failures?.length)) process.exitCode = 1;
    return;
  }
  for (const [index, result] of results.entries()) {
    if (!result.entries) {
      for (const failure of result.failures) console.log(`worktrees sweep: skipped ${targets[index].name}: ${failure.message}`);
      continue;
    }
    printSweepResult(result, targets[index].name, minAgeHours, recoveryRetentionAgeHours);
  }
  if (results.some((entry: any) => entry.failures?.length)) process.exitCode = 1;
}

async function cmdRecoverShared(opts: any) {
  const { meta } = await resolveProject(opts);
  const repo = path.resolve(meta.path);
  const stash = String(opts.stash || '').trim();
  const action = 'git reset --hard && git clean -fd';
  if (!stash) fail(`recover-shared: refusing recovery action "${action}"; pass --stash <stash@{n}> with the named stash that preserves this checkout.`);
  if (!opts.yes) fail(`recover-shared: refusing recovery action "${action}"; re-run \`sidequest recover-shared --project "${repo}" --stash ${stash} --yes\` after checking the stash evidence.`);
  let shared = false;
  try { shared = (await fs.stat(path.join(repo, '.git'))).isDirectory(); } catch (_) {}
  if (!shared) fail(`recover-shared: refusing recovery action "${action}"; "${repo}" is not a shared checkout.`);

  const git = (args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const statusEntries = git(['status', '--porcelain=v1', '-z']).split('\0').filter(Boolean);
  const dirty: string[] = [];
  for (let index = 0; index < statusEntries.length; index += 1) {
    const entry = statusEntries[index];
    dirty.push(entry.slice(3));
    if (/^[RC]/.test(entry.slice(0, 2)) && statusEntries[index + 1]) dirty.push(statusEntries[++index]);
  }
  if (!dirty.length) fail(`recover-shared: refusing recovery action "${action}"; the shared checkout is already clean.`);

  const namedStashes = git(['stash', 'list', '--format=%gd']).split(/\r?\n/).filter(Boolean);
  if (!namedStashes.includes(stash)) fail(`recover-shared: refusing recovery action "${action}"; "${stash}" is not a named stash in "${repo}".`);
  const object = git(['rev-parse', '--verify', `${stash}^{commit}`]);
  const preserved = new Set(git(['stash', 'show', '--name-only', '--format=', '--include-untracked', '-z', stash]).split('\0').filter(Boolean));
  const missing = dirty.filter((file: string) => !preserved.has(file));
  if (missing.length) fail(`recover-shared: refusing recovery action "${action}"; stash ${stash} (${object}) does not preserve: ${missing.join(', ')}.`);

  execFileSync('git', ['reset', '--hard'], { cwd: repo, windowsHide: true, stdio: 'ignore' });
  execFileSync('git', ['clean', '-fd'], { cwd: repo, windowsHide: true, stdio: 'ignore' });
  const remaining = git(['status', '--porcelain']);
  if (remaining) fail(`recover-shared: ${action} completed, but the checkout remains dirty:\n${remaining}`);
  console.log(`✓ recovered shared checkout with ${action}`);
  console.log(`  preserved evidence: stash ${stash} (${object}) covering ${dirty.join(', ')}`);
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

// Forget a session's claim registrations and report the claims it still holds.
// Called by the SessionEnd hook with the ending session's id; safe to run by hand.
// It does NOT release those claims: a session id proves nothing about whether that
// session's runtime stopped, so a replayed assertion would hand live work to a
// replacement (see store.reconcileSession). Recovery stays with the ticket's own
// terminal records and the claim backstops. No session id -> a clean no-op.
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
  if (res.held.length) {
    console.log(`✓ reconciled ${sid}: forgot its claim registrations. ${res.held.join(', ')} stay claimed — a session id is not evidence its runtime stopped, so recovery waits for a terminal record or the claim backstop.`);
  } else console.log(`✓ reconciled ${sid}: no outstanding claims.`);
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
  const acceptedMessage = opts.body == null && opts.message != null;
  const body = await bodyFromOpts(acceptedMessage ? Object.assign({}, opts, { body: opts.message }) : opts, 'comment');
  if (!body || !String(body).trim()) fail('comment: -m/--body or --body-file is required, e.g. sidequest comment SQ-3 -m "note"');
  const { slug, meta } = await resolveProject(opts);
  const by = controlPlaneIdentity(opts);
  const res = store.addComment(slug, idOrRef, { by, body, source: opts.source || 'cli' });
  if (opts.json) {
    process.stdout.write(JSON.stringify(Object.assign({ project: slug }, res, acceptedMessage ? { acceptedAliases: ['accepted message as body'] } : {}), null, 2) + '\n');
    if (!res.ok) process.exitCode = 1;
    return;
  }
  if (res.ok) {
    console.log(`✓ » comment added to ${res.ticket.ref} by "${by}"  — ${meta.name}`);
    if (acceptedMessage) console.log('  accepted message as body');
    if (res.advisory) console.log(`  advisory: ${res.advisory}`);
  } else {
    process.exitCode = 1;
    const messages: any = {
      not_found: `no ticket "${idOrRef}" in ${meta.name}.`,
      empty: 'comment body cannot be empty.',
      too_long: `comment body is ${res.length} chars, over the ${res.max}-char cap — trim it, or put long-form content in the ticket's plan document (the MCP \`plan\` verb) and point to it here (nothing was stored).`,
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
  const a = positional[0] || opts.ref;
  const verb = positional[1] || opts.type;
  const b = positional[2] || opts.target;
  const acceptedAliases = [
    ...(positional[0] == null && opts.ref != null ? ['accepted ref as from'] : []),
    ...(positional[1] == null && opts.type != null ? ['accepted type as verb'] : []),
    ...(positional[2] == null && opts.target != null ? ['accepted target as to'] : []),
  ];
  if (!a || !verb || !b) fail('link: usage — sidequest link SQ-1 <blocks|depends-on|related> SQ-2');
  const { slug, meta } = await resolveProject(opts);
  const res = store.linkTickets(slug, a, verb, b);
  if (opts.json) {
    process.stdout.write(JSON.stringify(Object.assign({ project: slug }, res, acceptedAliases.length ? { acceptedAliases } : {}), null, 2) + '\n');
    if (!res.ok) process.exitCode = 1;
    return;
  }
  if (res.ok) {
    console.log(`✓ linked ${res.from.ref} ${res.type} ${res.to.ref}  — ${meta.name}`);
    for (const acceptedAlias of acceptedAliases) console.log(`  ${acceptedAlias}`);
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


module.exports = { cmdSweepClaims, cmdWorktrees, worktreeSweepEntryLine, worktreeSweepProgressLine, cmdRecoverShared, cmdNext, cmdWork, cmdReconcile, cmdAssign, cmdRemind, cmdUnremind, cmdComment, cmdComments, cmdLink, cmdUnlink, cmdReady, cmdArchive, cmdUnarchive };
