'use strict';

const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const nativeFs = require('node:fs');
const { execFileSync, spawn } = require('node:child_process');
const commitScope = require('./commit-scope.js');
const worktreeLease = require('./kernel/worktree.js') as {
  canonicalPath: (value: string) => string;
  createWorktreeLease: (facts: any) => any;
  worktreeCleanupDecision: (lease: any, registered: readonly string[]) => { allowed: boolean; reason: string };
};

const DEFAULT_MIN_AGE_MS = 3 * 60 * 60 * 1000;
const DEFAULT_NOT_INTEGRATED_SALVAGE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const QUARANTINE_RETRY_INTERVAL_MS = 24 * 60 * 60 * 1000;

interface GitResult {
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
}

function git(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn('git', ['-c', 'core.editor=true', ...args], {
      cwd,
      env: { ...process.env, GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' },
      timeout: 120_000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', (error: NodeJS.ErrnoException) => {
      resolve({ ok: false, status: null, stdout: '', stderr: String(error.message || '').trim() });
    });
    child.once('close', (status: number | null) => {
      resolve({
        ok: status === 0,
        status,
        stdout: Buffer.concat(stdout).toString('utf8').trim(),
        stderr: Buffer.concat(stderr).toString('utf8').trim(),
      });
    });
  });
}

function pathIsInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function preferredWorktreeIntegrationTarget(repository: string, branch: string) {
  const local = `refs/heads/${branch}`;
  const remote = `refs/remotes/origin/${branch}`;
  try {
    execFileSync('git', ['rev-parse', '--verify', `${local}^{commit}`], {
      cwd: repository,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    execFileSync('git', ['rev-parse', '--verify', `${remote}^{commit}`], {
      cwd: repository,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
  } catch (_) {
    return null;
  }
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', remote, local], {
      cwd: repository,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return { mode: 'local', upstream: branch, branch };
  } catch (_) {
    return { mode: 'remote', upstream: `origin/${branch}`, branch };
  }
}

function dependencyCachePath(relativePath: string): boolean {
  return relativePath.split(/[\\/]+/).includes('node_modules');
}

function ignoredPathsMissingFromWorktree(repository: string, worktree: string, candidatePaths: string[]): string[] {
  if (!nativeFs.existsSync(repository) || !nativeFs.existsSync(worktree) || !candidatePaths.length) return [];
  const scopes = candidatePaths
    .map((candidate) => path.resolve(repository, candidate))
    .filter((candidate) => pathIsInside(repository, candidate));
  if (!scopes.length) return [];
  let output = '';
  try {
    output = execFileSync('git', ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory'], {
      cwd: repository,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (_) {
    return [];
  }
  return output.split(/\r?\n/)
    .map((entry) => entry.trim().replace(/[\\/]+$/, '').replace(/\\/g, '/'))
    .filter(Boolean)
    .filter((relativePath) => !dependencyCachePath(relativePath))
    .filter((relativePath) => {
      const repositoryPath = path.resolve(repository, relativePath);
      if (!pathIsInside(repository, repositoryPath) || !nativeFs.existsSync(repositoryPath)) return false;
      if (nativeFs.existsSync(path.resolve(worktree, relativePath))) return false;
      return scopes.some((scope) => pathIsInside(scope, repositoryPath) || pathIsInside(repositoryPath, scope));
    })
    .sort();
}

function configuredDependencyDirectory(repository: string, worktree: string, relativePath: string): { source: string; target: string } {
  const source = path.resolve(repository, relativePath);
  const target = path.resolve(worktree, relativePath);
  if (!pathIsInside(repository, source) || !pathIsInside(worktree, target)) {
    throw new Error(`worktree dependency path must stay inside the repository: ${relativePath}`);
  }
  if (!nativeFs.existsSync(source)) throw new Error(`configured worktree dependency path does not exist: ${relativePath}`);
  if (!nativeFs.statSync(source).isDirectory()) throw new Error(`configured worktree dependency path must be a directory: ${relativePath}`);
  if (nativeFs.existsSync(target)) throw new Error(`worktree dependency path already exists after checkout: ${relativePath}`);
  return { source, target };
}

function provisionDependencyDirectory(repository: string, worktree: string, dependency: { path: string; mode: string }): void {
  const { source, target } = configuredDependencyDirectory(repository, worktree, dependency.path);
  nativeFs.mkdirSync(path.dirname(target), { recursive: true });
  if (dependency.mode === 'copy') {
    nativeFs.cpSync(source, target, { recursive: true });
    return;
  }
  nativeFs.symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir');
}

function provisionWorktree(repository: string, worktree: string, config: { worktreeDependencyPaths?: { path: string; mode: string }[]; worktreeSetup?: string | null }): void {
  for (const dependency of config.worktreeDependencyPaths || []) {
    provisionDependencyDirectory(repository, worktree, dependency);
  }
  const setup = String(config.worktreeSetup || '').trim();
  if (!setup) return;
  try {
    execFileSync(setup, { cwd: worktree, encoding: 'utf8', shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error: any) {
    const detail = String(error?.stderr || error?.message || '').trim();
    throw new Error(`worktree setup command failed: ${setup}${detail ? `\n${detail.slice(0, 1000)}` : ''}`);
  }
}

function gitBashPath(value: string): string {
  const drive = process.platform === 'win32' ? /^\/([a-zA-Z])(?=\/|$)/.exec(value) : null;
  return drive ? `${drive[1]}:${value.slice(2)}` : value;
}

function canonicalPath(value: unknown): string {
  return worktreeLease.canonicalPath(String(value));
}

function sidequestHome(): string {
  const configured = String(process.env.SIDEQUEST_HOME || '').trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), '.claude', 'sidequest');
}

function worktreeProjectSlug(repository: string): string {
  const resolved = path.resolve(repository);
  const normalized = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  const base = path.basename(resolved)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'project';
  const hash = crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 8);
  return `${base}-${hash}`;
}

function worktreeRoot(repository: string): string {
  const project = canonicalPath(repository);
  const slug = worktreeProjectSlug(project);
  const preferred = path.join(sidequestHome(), 'worktrees', slug);
  if (!pathIsInside(project, preferred)) return preferred;
  const fallback = path.join(os.tmpdir(), 'sidequest', 'worktrees', slug);
  if (!pathIsInside(project, fallback)) return fallback;
  throw new Error(`Sidequest cannot place an isolated worktree outside project root ${project}.`);
}

function legacyWorktreeRoot(repository: string): string {
  return path.join(repository, '.claude', 'worktrees');
}

function agentWorktreePath(repository: string, agentId: string): string {
  return path.join(worktreeRoot(repository), `agent-${String(agentId).trim()}`);
}

// Sidequest provisions under worktreeRoot(), but Claude Code's own
// `isolation: worktree` provisions under legacyWorktreeRoot(), and an executor
// can legitimately be running in either. Anything deciding "is this agent
// writing where it belongs?" has to accept both, or it refuses a worktree that
// is present and correct (SQ-1546).
function agentWorktreeCandidates(repository: string, agentId: string): string[] {
  const segment = `agent-${String(agentId).trim()}`;
  return agentWorktreeRoots(repository).map((root) => path.join(root, segment));
}

function resolvedAgentWorktree(repository: string, agentId: string): string {
  const existing = agentWorktreeCandidates(repository, agentId).find((candidate) => nativeFs.existsSync(candidate));
  return existing || agentWorktreePath(repository, agentId);
}

function namedWorktreePath(repository: string, name: string): string {
  const segment = String(name).trim();
  if (!segment || segment === '.' || segment === '..' || path.basename(segment) !== segment) {
    throw new Error(`invalid worktree name: ${name}`);
  }
  return path.join(worktreeRoot(repository), segment);
}

function agentWorktreeRoots(repository: string): string[] {
  return [worktreeRoot(repository), legacyWorktreeRoot(repository)];
}

function persistentStateFile(): string {
  return path.join(sidequestHome(), 'worktree-sweep-failures.json');
}

type FailureState = Record<string, {
  fingerprint: string;
  attempts: number;
  extendedPathAttempted?: boolean;
  quarantineAttempted?: boolean;
  quarantineFailed?: boolean;
  quarantineFailedAt?: string;
  quarantinedPath?: string;
  quarantinedAt?: string;
}>;

function readFailureState(): FailureState {
  try {
    return JSON.parse(nativeFs.readFileSync(persistentStateFile(), 'utf8')) as FailureState;
  } catch (_) {
    return {};
  }
}

function writeFailureState(state: FailureState): void {
  try {
    nativeFs.mkdirSync(path.dirname(persistentStateFile()), { recursive: true });
    nativeFs.writeFileSync(persistentStateFile(), JSON.stringify(state), 'utf8');
  } catch (_) {
    // Cleanup continues even when its diagnostic state cannot be persisted.
  }
}

function isFilenameTooLong(message: unknown): boolean {
  return /filename too long|enametoolong/i.test(String(message || ''));
}

function failureFingerprint(message: unknown): string {
  return isFilenameTooLong(message) ? 'filename-too-long' : String(message || '').replace(/\d+/g, '#').slice(0, 500);
}

function recordFailure(pathname: string, message: string): { attempts: number; suppressed: boolean } {
  const state = readFailureState();
  const key = canonicalPath(pathname);
  const fingerprint = failureFingerprint(message);
  const existing = state[key];
  const attempts = existing?.fingerprint === fingerprint ? existing.attempts + 1 : 1;
  state[key] = { ...existing, fingerprint, attempts };
  writeFailureState(state);
  return { attempts, suppressed: attempts > 2 };
}

function clearFailure(pathname: string): void {
  const state = readFailureState();
  const key = canonicalPath(pathname);
  if (!(key in state)) return;
  delete state[key];
  writeFailureState(state);
}

function recordQuarantine(pathname: string, message: string, destination: string): void {
  const state = readFailureState();
  const key = canonicalPath(pathname);
  const existing = state[key];
  state[key] = {
    ...(existing || { fingerprint: failureFingerprint(message), attempts: 1 }),
    quarantineAttempted: true,
    quarantinedPath: destination,
    quarantinedAt: new Date().toISOString(),
  };
  writeFailureState(state);
}

function recordQuarantineFailure(pathname: string, message: string): void {
  const state = readFailureState();
  const key = canonicalPath(pathname);
  const existing = state[key];
  state[key] = {
    ...(existing || { fingerprint: failureFingerprint(message), attempts: 1 }),
    quarantineAttempted: true,
    quarantineFailed: true,
    quarantineFailedAt: new Date().toISOString(),
  };
  writeFailureState(state);
}

function quarantineRetryDue(pathname: string): boolean {
  const failure = readFailureState()[canonicalPath(pathname)];
  if (!failure?.quarantineFailed) return true;
  const failedAt = Date.parse(String(failure.quarantineFailedAt || ''));
  return !Number.isFinite(failedAt) || Date.now() - failedAt >= QUARANTINE_RETRY_INTERVAL_MS;
}

function shouldSkipKnownFailure(pathname: string): boolean {
  const state = readFailureState()[canonicalPath(pathname)];
  return state?.fingerprint === 'filename-too-long' && state.attempts >= 2;
}

function shouldTryExtendedPath(pathname: string, message: string): boolean {
  if (process.platform !== 'win32' || !isFilenameTooLong(message)) return false;
  const state = readFailureState();
  const key = canonicalPath(pathname);
  if (state[key]?.extendedPathAttempted) return false;
  state[key] = { ...(state[key] || { fingerprint: 'filename-too-long', attempts: 0 }), extendedPathAttempted: true };
  writeFailureState(state);
  return true;
}

function extendedWindowsPath(pathname: string): string {
  return path.win32.toNamespacedPath(path.resolve(pathname));
}

function parseWorktreeList(output: string): any[] {
  return output.split(/\r?\n\r?\n/).filter(Boolean).map((block) => {
    const entry: Record<string, string> = {};
    for (const line of block.split(/\r?\n/)) {
      const match = /^(worktree|HEAD|branch|locked)\s*(.*)$/.exec(line);
      if (match?.[1] && match[2] != null) entry[match[1].toLowerCase()] = match[2];
    }
    return entry;
  }).filter((entry) => entry.worktree);
}

function isAgentWorktree(repo: string, worktree: string): boolean {
  const candidate = canonicalPath(worktree);
  return agentWorktreeRoots(repo).some((root) => {
    const relative = path.relative(canonicalPath(root), candidate);
    return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative)
      && !relative.includes(path.sep) && path.basename(relative).startsWith('agent-');
  });
}

function ticketForWorktree(tickets: any[], entry: any): any | null {
  const worktree = canonicalPath(entry.worktree);
  return tickets.find((ticket) => {
    const knownWorktree = dispatchWorktreeForTicket(ticket);
    return Boolean(knownWorktree && canonicalPath(knownWorktree) === worktree);
  }) || null;
}

function localBranchName(ref: unknown): string | null {
  const match = /^refs\/heads\/(.+)$/.exec(String(ref || ''));
  return match?.[1] || null;
}

function worktreePath(entry: any): string {
  return String(entry.path || entry.worktree);
}

function salvageRef(entry: any, suffix = ''): string {
  return `refs/salvage/${path.basename(worktreePath(entry))}${suffix}`;
}

async function createSalvageRef(repo: string, ref: string, revision: string): Promise<void> {
  const created = await git(repo, ['update-ref', ref, revision, '0000000000000000000000000000000000000000']);
  if (!created.ok) throw new Error(created.stderr || `could not create salvage ref ${ref}`);
}

async function salvageWorktree(repo: string, entry: any): Promise<{ ref: string; uncommittedRef: string | null }> {
  const worktree = worktreePath(entry);
  const head = await git(worktree, ['rev-parse', 'HEAD']);
  if (!head.ok || !head.stdout) throw new Error(head.stderr || 'could not resolve worktree HEAD');
  const ref = salvageRef(entry);
  await createSalvageRef(repo, ref, head.stdout);
  if (entry.clean) return { ref, uncommittedRef: null };

  const stash = await git(worktree, ['stash', 'create']);
  if (!stash.ok || !stash.stdout) throw new Error(stash.stderr || 'could not capture uncommitted worktree changes');
  const uncommittedRef = salvageRef(entry, '-uncommitted');
  await createSalvageRef(repo, uncommittedRef, stash.stdout);
  return { ref, uncommittedRef };
}

function recoveryCommand(entry: any): string {
  const worktree = String(entry.path || entry.worktree);
  const ref = String(entry.salvage?.ref || '');
  const uncommittedRef = entry.salvage?.uncommittedRef ? ` && git -C "${worktree}" stash apply "${entry.salvage.uncommittedRef}"` : '';
  return `git worktree add --detach "${worktree}" "${ref}"${uncommittedRef}`;
}

function integrationUpstream(options: any): string {
  const target = options.integrationTarget || {};
  const upstream = String(target.upstream || options.upstream || '').trim();
  if (!upstream) throw new Error('worktree sweep requires the board integration target.');
  return upstream;
}

function finalTicket(ticket: any): boolean {
  return Boolean(ticket && (ticket.archived || ticket.status === 'done'));
}

// `done` is a board fact, not an agent fact. An integration closure marks the
// ticket done and sweeps in the same breath, so its executor can still be alive
// in that tree; the claim is the only thing that knows. worktreeGcTickets()
// stamps claimLive from the same verdict the claim sweep uses.
function liveClaimTicket(ticket: any): boolean {
  return Boolean(ticket && ticket.claimLive);
}

function dispatchWorktreeForTicket(ticket: any): string | null {
  const worktree = String(ticket?.dispatch?.worktree || ticket?.submission?.worktree || '').trim();
  return worktree || null;
}

function worktreeLeaseIdentity(ticket: any, entry: any): { status: 'bound'; agentId: string } | { status: 'unknown' } {
  const expected = dispatchWorktreeForTicket(ticket);
  const agentId = String(ticket?.dispatch?.agentId || '').trim();
  if (expected && agentId && canonicalPath(expected) === canonicalPath(entry.worktree)) return { status: 'bound', agentId };
  return { status: 'unknown' };
}

function worktreeLeasePhase(ticket: any): 'working' | 'integrated' | 'terminal' {
  if (!finalTicket(ticket)) return 'working';
  return ticket?.archived ? 'terminal' : 'integrated';
}

function worktreeLeaseLiveness(ticket: any, entry: any, livePaths: readonly string[]): { status: 'live' | 'terminal' | 'unknown'; evidence: string } {
  if (livePaths.some((livePath) => canonicalPath(livePath) === canonicalPath(entry.worktree))) return { status: 'live', evidence: 'active session path' };
  if (liveClaimTicket(ticket)) return { status: 'live', evidence: 'live ticket claim' };
  if (finalTicket(ticket)) return { status: 'terminal', evidence: 'terminal board ticket without a live claim' };
  return { status: 'unknown', evidence: 'no terminal board evidence' };
}

async function worktreeCleanupLease(repo: string, ticket: any, entry: any, livePaths: readonly string[]): Promise<any> {
  const [gitDirectory, commonGitDirectory, observedRevision] = await Promise.all([
    git(entry.worktree, ['rev-parse', '--git-dir']),
    git(entry.worktree, ['rev-parse', '--git-common-dir']),
    git(entry.worktree, ['rev-parse', 'HEAD']),
  ]);
  const resolveGitPath = (result: GitResult) => result.ok && result.stdout
    ? (path.isAbsolute(result.stdout) ? result.stdout : path.resolve(entry.worktree, result.stdout))
    : entry.worktree;
  return worktreeLease.createWorktreeLease({
    repository: repo,
    gitDirectory: resolveGitPath(gitDirectory),
    commonGitDirectory: resolveGitPath(commonGitDirectory),
    dispatchRef: ticket?.ref || null,
    dispatchBaseline: String(ticket?.dispatch?.baseCommit || '').trim() || null,
    observedRevision: observedRevision.ok ? observedRevision.stdout || null : null,
    observedWorktree: entry.worktree,
    identity: worktreeLeaseIdentity(ticket, entry),
    phase: worktreeLeasePhase(ticket),
    locked: Boolean(entry.locked),
    liveness: worktreeLeaseLiveness(ticket, entry, livePaths),
    provisioning: entry.orphanDirectory ? 'unknown' : 'host',
  });
}

function leaseCleanupSkipReason(decision: { reason: string }): string {
  if (/bound worktree identity/.test(decision.reason)) return 'unknown_identity';
  if (/canonical registered/.test(decision.reason)) return 'not_registered';
  if (/terminal lease phase/.test(decision.reason)) return 'active_ticket';
  if (/locked worktree/.test(decision.reason)) return 'locked';
  if (/terminal liveness/.test(decision.reason)) return 'live_session';
  if (/unknown provisioning/.test(decision.reason)) return 'unknown_provisioning';
  return 'lease_refused';
}


async function worktreeAge(pathname: string): Promise<number | null> {
  try {
    const stat = await fs.stat(pathname);
    return Math.max(0, Date.now() - stat.mtimeMs);
  } catch (_) {
    return null;
  }
}

async function patchEquivalence(repo: string, revision: string, upstream: string): Promise<any> {
  const base = await git(repo, ['merge-base', revision, upstream]);
  if (!base.ok || !base.stdout) return { equivalent: false, ahead: null, equivalentCommits: 0, unmatchedCommits: null };

  const [ahead, cherry] = await Promise.all([
    git(repo, ['rev-list', '--count', `${base.stdout}..${revision}`]),
    git(repo, ['cherry', upstream, revision, base.stdout]),
  ]);
  const aheadCount = ahead.ok && /^\d+$/.test(ahead.stdout) ? Number(ahead.stdout) : null;
  if (aheadCount == null || !cherry.ok) {
    return { equivalent: false, ahead: aheadCount, equivalentCommits: 0, unmatchedCommits: null };
  }

  const marks = cherry.stdout ? cherry.stdout.split(/\r?\n/).filter(Boolean).map((line) => line[0]) : [];
  const equivalentCommits = marks.filter((mark) => mark === '-').length;
  const unmatchedCommits = marks.filter((mark) => mark !== '-').length;
  return {
    equivalent: marks.length === aheadCount && unmatchedCommits === 0,
    ahead: aheadCount,
    equivalentCommits,
    unmatchedCommits,
  };
}

async function reachableFrom(repo: string, revision: string, upstream: string): Promise<boolean> {
  return (await git(repo, ['merge-base', '--is-ancestor', revision, upstream])).ok;
}

function skippedEntry(entry: any, ticket: any, reason: string, current: boolean): any {
  return {
    path: entry.worktree,
    branch: entry.branch || null,
    ticket: ticket ? ticket.ref : null,
    clean: null,
    ahead: null,
    reachable: null,
    patchEquivalent: null,
    equivalentCommits: 0,
    unmatchedCommits: null,
    ageMs: null,
    minAgeMs: null,
    oldEnough: null,
    locked: entry.locked || null,
    action: 'keep',
    reason,
    current,
  };
}

async function classifyWorktree(repo: string, tickets: any[], entry: any, currentPath: string, minAgeMs: number, upstream: string, livePaths: string[] = [], notIntegratedSalvageAgeMs = DEFAULT_NOT_INTEGRATED_SALVAGE_AGE_MS, registeredWorktrees: readonly string[] = []): Promise<any> {
  const ticket = ticketForWorktree(tickets, entry);
  const worktreePath = canonicalPath(entry.worktree);
  const current = worktreePath === canonicalPath(currentPath);
  if (current) return skippedEntry(entry, ticket, 'current_worktree', true);
  const lease = await worktreeCleanupLease(repo, ticket, entry, livePaths);
  const cleanup = worktreeLease.worktreeCleanupDecision(lease, registeredWorktrees);
  if (!cleanup.allowed) return { ...skippedEntry(entry, ticket, leaseCleanupSkipReason(cleanup), false), lease, leaseDecision: cleanup.reason };

  const [cleanResult, ageMs, patch, reachable] = await Promise.all([
    git(entry.worktree, ['status', '--porcelain']),
    worktreeAge(entry.worktree),
    patchEquivalence(entry.worktree, 'HEAD', upstream),
    reachableFrom(entry.worktree, 'HEAD', upstream),
  ]);
  const clean = cleanResult.ok ? cleanResult.stdout === '' : false;
  const untracked = cleanResult.ok && cleanResult.stdout.split(/\r?\n/).some((line) => line.startsWith('?? '));
  const trackedChanges = cleanResult.ok && cleanResult.stdout.split(/\r?\n/).some((line) => line && !line.startsWith('?? '));
  const oldEnough = ageMs != null && ageMs >= minAgeMs;
  const oldEnoughToSalvage = ageMs != null && ageMs >= notIntegratedSalvageAgeMs;

  let action = 'keep';
  let reason = 'not_integrated';
  if (!cleanResult.ok) reason = 'status_unknown';
  else if (ticket?.archived && !trackedChanges) {
    action = 'remove';
    reason = 'ticket_archived';
  } else if (ticket?.status === 'done' && !trackedChanges) {
    action = 'remove';
    reason = 'ticket_done';
  } else if (trackedChanges && (reachable || patch.equivalent)) {
    // Both settled-branch reasons below remove the directory, and uncommitted
    // tracked edits exist nowhere else, so guarding only `reachable` still lost
    // work through the patch-equivalent branch (SQ-1848 follow-up).
    reason = 'tracked_changes';
  } else if (!oldEnough) reason = 'too_young';
  else if (reachable) {
    action = 'remove';
    reason = 'branch_reachable';
  } else if (patch.equivalent) {
    action = 'remove';
    reason = 'patch_equivalent';
  } else if (oldEnoughToSalvage && untracked) {
    reason = 'unrecoverable_untracked';
  } else if (oldEnoughToSalvage) {
    action = 'salvage';
    reason = 'not_integrated_salvage';
  }

  return {
    path: entry.worktree,
    branch: entry.branch || null,
    ticket: ticket ? ticket.ref : null,
    clean,
    ahead: patch.ahead,
    reachable,
    patchEquivalent: patch.equivalent,
    equivalentCommits: patch.equivalentCommits,
    unmatchedCommits: patch.unmatchedCommits,
    ageMs,
    minAgeMs,
    oldEnough,
    notIntegratedSalvageAgeMs,
    oldEnoughToSalvage,
    locked: null,
    action,
    reason,
    current: false,
    lease,
    leaseDecision: cleanup.reason,
  };
}

async function orphanDirectories(repo: string, registered: Set<string>): Promise<any[]> {
  const legacyRoot = canonicalPath(legacyWorktreeRoot(repo));
  const directories = (await Promise.all(agentWorktreeRoots(repo).map(async (parent) => {
    try {
      const entries: import('node:fs').Dirent[] = await fs.readdir(parent, { withFileTypes: true });
      const legacy = canonicalPath(parent) === legacyRoot;
      return entries
        .filter((entry: import('node:fs').Dirent) => entry.isDirectory() && (legacy || entry.name.startsWith('agent-')))
        .map((entry: import('node:fs').Dirent) => path.join(parent, entry.name));
    } catch (error: any) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
  }))).flat();
  return Promise.all(directories
    .filter((directory: string) => quarantineRetryDue(directory))
    .filter((directory: string) => !registered.has(canonicalPath(directory)))
    .map(async (directory: string) => {
      try {
        await fs.lstat(path.join(directory, '.git'));
        return null;
      } catch (error: any) {
        if (error?.code !== 'ENOENT') throw error;
      }
      return { worktree: directory, branch: null, orphanDirectory: true };
    })).then((entries) => entries.filter(Boolean));
}

async function classifyOrphanDirectory(tickets: any[], entry: any, livePaths: string[], minAgeMs: number): Promise<any> {
  const ticket = ticketForWorktree(tickets, entry);
  if (livePaths.some((livePath) => canonicalPath(entry.worktree) === canonicalPath(livePath))) return skippedEntry(entry, ticket, 'live_session', false);
  if (ticket && !finalTicket(ticket)) return skippedEntry(entry, ticket, 'active_ticket', false);
  if (liveClaimTicket(ticket)) return skippedEntry(entry, ticket, 'live_claim', false);
  const [ageMs, contents] = await Promise.all([worktreeAge(entry.worktree), fs.readdir(entry.worktree)]);
  const oldEnough = ageMs != null && ageMs >= minAgeMs;
  if (!oldEnough) return skippedEntry(entry, ticket, 'too_young', false);
  return {
    path: entry.worktree,
    branch: null,
    ticket: ticket ? ticket.ref : null,
    clean: contents.length === 0,
    ahead: null,
    reachable: null,
    patchEquivalent: null,
    equivalentCommits: 0,
    unmatchedCommits: null,
    ageMs,
    minAgeMs,
    oldEnough,
    locked: null,
    action: 'remove',
    reason: 'orphan_directory',
    current: false,
    orphanDirectory: true,
  };
}

function backupRoot(options: any): string {
  return options.backupDir || path.join(sidequestHome(), 'worktree-backups');
}

async function backupDirtyWorktree(repo: string, entry: any, upstream: string, options: any): Promise<string> {
  const agentId = path.basename(entry.path).replace(/^agent-/, '') || 'unknown-agent';
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destination = path.join(backupRoot(options), `${agentId}-${timestamp}`);
  await fs.mkdir(destination, { recursive: true });

  const staged = await git(entry.path, ['add', '-A']);
  if (!staged.ok) throw new Error(staged.stderr || 'git add -A failed');
  const diff = await git(entry.path, ['diff', '--cached', 'HEAD']);
  if (!diff.ok) throw new Error(diff.stderr || 'git diff --cached HEAD failed');
  const branch = localBranchName(entry.branch);
  const commits = branch ? await git(repo, ['format-patch', '--stdout', `${upstream}..${branch}`]) : { ok: true, stdout: '', stderr: '' };
  if (!commits.ok) throw new Error(commits.stderr || 'git format-patch failed');

  await Promise.all([
    fs.writeFile(path.join(destination, 'working-tree.patch'), diff.stdout ? `${diff.stdout}\n` : '', 'utf8'),
    fs.writeFile(path.join(destination, 'commits.patch'), commits.stdout ? `${commits.stdout}\n` : '', 'utf8'),
    fs.writeFile(path.join(destination, 'metadata.json'), JSON.stringify({
      worktree: entry.path,
      branch,
      upstream,
      backedUpAt: new Date().toISOString(),
    }, null, 2) + '\n', 'utf8'),
  ]);
  return destination;
}

async function backupDirtyOrphanDirectory(entry: any, options: any): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destination = path.join(backupRoot(options), `orphan-${path.basename(entry.path)}-${timestamp}`);
  await fs.mkdir(destination, { recursive: true });
  await fs.cp(entry.path, path.join(destination, 'contents'), { recursive: true, errorOnExist: true });
  await fs.writeFile(path.join(destination, 'metadata.json'), JSON.stringify({
    worktree: entry.path,
    backedUpAt: new Date().toISOString(),
    reason: 'unregistered worktree directory without .git metadata',
  }, null, 2) + '\n', 'utf8');
  return destination;
}

async function findOrphanBranches(repo: string, checkedOutBranches: Set<string>, upstream: string, maxCandidates: number): Promise<any[]> {
  const result = await git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/worktree-agent-*']);
  if (!result.ok) throw new Error(result.stderr || 'could not list worktree branches');
  const branches = result.stdout ? result.stdout.split(/\r?\n/).filter(Boolean) : [];
  return Promise.all(branches
    .filter((branch) => !checkedOutBranches.has(branch))
    .slice(0, maxCandidates)
    .map(async (branch) => {
      const [patch, reachable, subject] = await Promise.all([
        patchEquivalence(repo, branch, upstream),
        reachableFrom(repo, branch, upstream),
        git(repo, ['log', '-1', '--format=%s', branch]),
      ]);
      return {
        branch,
        subject: subject.ok ? subject.stdout : '',
        ahead: patch.ahead,
        reachable,
        patchEquivalent: patch.equivalent,
        equivalentCommits: patch.equivalentCommits,
        unmatchedCommits: patch.unmatchedCommits,
        action: reachable || patch.equivalent ? 'prune' : 'keep',
        reason: reachable ? 'reachable_orphan' : patch.equivalent ? 'patch_equivalent_orphan' : 'not_integrated',
      };
    }));
}

async function repositoryBusy(repo: string): Promise<boolean> {
  const states = await Promise.all(['REBASE_HEAD', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'].map((ref) => (
    git(repo, ['rev-parse', '--verify', '--quiet', ref])
  )));
  return states.some((state) => state.ok);
}

function shortCommit(commit: unknown): string {
  return String(commit || '').slice(0, 12);
}

// Always quoted: these are printed for a human to paste, and a Windows repo path
// with a space in it would otherwise hand them a broken command.
function quoted(value: string): string {
  return `"${value}"`;
}

function mergeCommand(repo: string, commit: string): string {
  return `git -C ${quoted(repo)} merge --ff-only ${commit}`;
}

async function resolveCommit(repo: string, revision: string): Promise<string | null> {
  const result = await git(repo, ['rev-parse', '--verify', '--quiet', `${revision}^{commit}`]);
  return result.ok && /^[0-9a-f]{40}$/.test(result.stdout) ? result.stdout : null;
}

// Untracked files do not block a fast-forward: git itself refuses to clobber one,
// and a repo with a stray .env would otherwise never advance.
async function checkoutState(repo: string): Promise<{ branch: string | null; dirtyPaths: string[]; untrackedPaths: string[] }> {
  const [head, modified, staged, untracked] = await Promise.all([
    git(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
    git(repo, ['diff', '--name-only']),
    git(repo, ['diff', '--cached', '--name-only']),
    git(repo, ['ls-files', '--others', '--exclude-standard']),
  ]);
  const paths = (result: GitResult) => result.ok && result.stdout ? result.stdout.split(/\r?\n/).filter(Boolean) : [];
  return {
    branch: head.ok && head.stdout ? head.stdout : null,
    dirtyPaths: Array.from(new Set([...paths(modified), ...paths(staged)])),
    untrackedPaths: paths(untracked),
  };
}

function advanceOutcome(fields: any): any {
  return Object.assign({
    attempted: true,
    advanced: false,
    mode: null,
    branch: null,
    from: null,
    to: null,
    reason: 'unknown',
    message: '',
    command: null,
    candidates: [],
  }, fields);
}

// Which commit did the integration land on? Every checkout of this repo is a
// candidate except the ones the executor owned — advancing onto an executor's
// own branch would skip the integration commits and leave the branch unable to
// fast-forward again. A candidate only qualifies when it carries the closed
// ticket's submitted work, so a stale feature branch can never be mistaken for
// an integration.
async function integrationCandidates(repo: string, options: any, branchHead: string, submissionCommit: string): Promise<any[]> {
  const listed = await git(repo, ['worktree', 'list', '--porcelain']);
  if (!listed.ok) throw new Error(listed.stderr || 'could not list git worktrees');
  const executorWorktree = options.submissionWorktree ? canonicalPath(options.submissionWorktree) : null;
  const heads = new Map<string, string>();
  for (const entry of parseWorktreeList(listed.stdout)) {
    const commit = String(entry.head || '').trim();
    if (!/^[0-9a-f]{40}$/.test(commit) || commit === branchHead) continue;
    if (isAgentWorktree(repo, entry.worktree) || !quarantineRetryDue(entry.worktree)) continue;
    if (executorWorktree && canonicalPath(entry.worktree) === executorWorktree) continue;
    if (!heads.has(commit)) heads.set(commit, entry.worktree);
  }
  return Promise.all([...heads].map(async ([commit, worktree]) => {
    const [fastForward, patch] = await Promise.all([
      reachableFrom(repo, branchHead, commit),
      patchEquivalence(repo, submissionCommit, commit),
    ]);
    return { commit, worktree, fastForward, carriesWork: patch.equivalent };
  }));
}

// A local-mode integration branch only moves if something moves it, and nothing
// did: every integration left the board's `main` one step further behind while
// the next dispatch pinned its worktree base to that stale commit, so the user
// closed the loop by hand (SQ-878). This closes it, and refuses loudly rather
// than ever rewriting the default branch: fast-forward only, only onto a commit
// that provably carries the closed ticket's work, only while the checkout sits
// on that branch with clean tracked files, and never near a remote ref.
async function advanceIntegrationBranch(repo: string, options: any = {}): Promise<any> {
  try {
    return await advanceLocalIntegrationBranch(repo, options);
  } catch (error: any) {
    const branch = String((options.integrationTarget || {}).branch || '').trim() || null;
    return advanceOutcome({
      branch,
      reason: 'error',
      message: `${branch || 'the integration branch'} was left unadvanced: ${(error && error.message) || error}.`,
    });
  }
}

async function advanceLocalIntegrationBranch(repo: string, options: any): Promise<any> {
  const target = options.integrationTarget || {};
  const mode = String(target.mode || '').trim();
  const branch = String(target.branch || '').trim();
  if (!branch) throw new Error('advancing the integration branch requires the board integration target.');
  if (mode !== 'local') {
    return advanceOutcome({
      attempted: false,
      mode,
      branch,
      reason: 'remote_mode',
      message: `integration mode is "${mode || 'unset'}", so ${branch} advances by push and nothing is advanced locally.`,
    });
  }

  const branchHead = await resolveCommit(repo, `refs/heads/${branch}`);
  if (!branchHead) {
    return advanceOutcome({
      mode,
      branch,
      reason: 'branch_missing',
      message: `local integration branch ${branch} does not exist in ${repo}, so the integrated commit has nothing to fast-forward.`,
    });
  }
  const submitted = String(options.submissionCommit || '').trim().toLowerCase();
  if (!submitted) {
    return advanceOutcome({
      mode,
      branch,
      from: branchHead,
      reason: 'submission_commit_missing',
      message: `${branch} was left at ${shortCommit(branchHead)}: this closure carries no submitted commit, so no integrated commit can be proven and the branch is not moved.`,
    });
  }
  const submissionCommit = await resolveCommit(repo, submitted);
  if (!submissionCommit) {
    return advanceOutcome({
      mode,
      branch,
      from: branchHead,
      reason: 'submission_commit_unresolvable',
      message: `${branch} was left at ${shortCommit(branchHead)}: submitted commit ${shortCommit(submitted)} is not in ${repo}, so which commit integrated it cannot be proven.`,
      command: mergeCommand(repo, '<integrated-commit>'),
    });
  }
  if ((await patchEquivalence(repo, submissionCommit, branchHead)).equivalent) {
    return advanceOutcome({
      mode,
      branch,
      from: branchHead,
      to: branchHead,
      reason: 'already_integrated',
      message: `${branch} already carries ${shortCommit(submissionCommit)} at ${shortCommit(branchHead)}; nothing to advance.`,
    });
  }

  const candidates = await integrationCandidates(repo, options, branchHead, submissionCommit);
  const carrying = candidates.filter((candidate) => candidate.carriesWork);
  const advanceable = carrying.filter((candidate) => candidate.fastForward);
  if (!carrying.length) {
    return advanceOutcome({
      mode,
      branch,
      from: branchHead,
      reason: 'no_integrated_commit',
      candidates,
      message: `${branch} was left at ${shortCommit(branchHead)}: no checkout of ${repo} holds a commit carrying submitted ${shortCommit(submissionCommit)}, so the integrated commit could not be identified.`,
      command: mergeCommand(repo, '<integrated-commit>'),
    });
  }
  if (!advanceable.length) {
    const blocked = carrying.map((candidate) => shortCommit(candidate.commit)).join(', ');
    return advanceOutcome({
      mode,
      branch,
      from: branchHead,
      reason: 'not_fast_forward',
      candidates,
      message: `${branch} was left at ${shortCommit(branchHead)}: the integrated commit(s) ${blocked} do not descend from it, so advancing would need a merge or a rewrite. Refusing — resolve the divergence by hand.`,
    });
  }
  if (advanceable.length > 1) {
    const listed = advanceable.map((candidate) => `${shortCommit(candidate.commit)} (${candidate.worktree})`).join(', ');
    return advanceOutcome({
      mode,
      branch,
      from: branchHead,
      reason: 'ambiguous_integrated_commit',
      candidates,
      message: `${branch} was left at ${shortCommit(branchHead)}: ${advanceable.length} checkouts carry this work — ${listed} — so the integrated commit is ambiguous.`,
      command: mergeCommand(repo, '<integrated-commit>'),
    });
  }

  const to = advanceable[0]!.commit;
  const common = { mode, branch, from: branchHead, to, candidates };
  if (await repositoryBusy(repo)) {
    return advanceOutcome(Object.assign({
      reason: 'repository_busy',
      message: `${branch} was left at ${shortCommit(branchHead)}: ${repo} is mid merge, rebase, cherry-pick or revert, so it must not be fast-forwarded to ${shortCommit(to)} now.`,
      command: mergeCommand(repo, to),
    }, common));
  }
  const state = await checkoutState(repo);
  if (state.branch !== branch) {
    const checkedOut = state.branch ? `"${state.branch}"` : 'a detached HEAD';
    return advanceOutcome(Object.assign({
      reason: 'branch_not_checked_out',
      message: `${branch} was left at ${shortCommit(branchHead)}: ${repo} has ${checkedOut} checked out, not ${branch}, so it cannot be fast-forwarded to ${shortCommit(to)} here. Sidequest never checks out branches for you — advance it yourself once that checkout is free.`,
      command: `git -C ${quoted(repo)} switch ${branch} && ${mergeCommand(repo, to)}`,
    }, common));
  }
  const protectedPaths = Array.from(new Set([
    ...(Array.isArray(options.admittedScope) ? options.admittedScope : []),
    ...(Array.isArray(options.changedPaths) ? options.changedPaths : []),
  ]));
  const scopedDirtyPaths = [...state.dirtyPaths, ...state.untrackedPaths]
    .filter((entry) => protectedPaths.length && commitScope.isInScope(entry, protectedPaths));
  const ignoredDirtyPaths = protectedPaths.length
    ? state.dirtyPaths.filter((entry) => !commitScope.isInScope(entry, protectedPaths))
    : state.untrackedPaths;
  const blockingDirtyPaths = protectedPaths.length ? scopedDirtyPaths : state.dirtyPaths;
  if (blockingDirtyPaths.length) {
    const scopeReason = protectedPaths.length
      ? `uncommitted changes inside this ticket's declared scope: ${blockingDirtyPaths.join(', ')}`
      : 'modified tracked files';
    return advanceOutcome(Object.assign({
      reason: 'checkout_dirty',
      dirtyPaths: blockingDirtyPaths,
      ignoredDirtyPaths,
      message: `${branch} was left at ${shortCommit(branchHead)}: ${repo} has ${scopeReason}, so fast-forwarding it to ${shortCommit(to)} could clobber them. Commit or stash them, then advance it yourself.`,
      command: mergeCommand(repo, to),
    }, common));
  }

  const merged = await git(repo, ['merge', '--ff-only', to]);
  if (!merged.ok) {
    return advanceOutcome(Object.assign({
      reason: 'merge_failed',
      message: `${branch} was left at ${shortCommit(branchHead)}: git refused to fast-forward it to ${shortCommit(to)} — ${merged.stderr || `exit ${merged.status}`}.`,
      command: mergeCommand(repo, to),
    }, common));
  }
  const landed = await resolveCommit(repo, `refs/heads/${branch}`);
  if (landed !== to) {
    return advanceOutcome(Object.assign({
      reason: 'merge_incomplete',
      message: `${branch} reports ${shortCommit(landed)} after fast-forwarding to ${shortCommit(to)}; treat the branch as unadvanced and check it by hand.`,
      command: mergeCommand(repo, to),
    }, common));
  }
  return advanceOutcome(Object.assign({
    advanced: true,
    reason: 'advanced',
    ignoredDirtyPaths,
    message: `advanced ${branch} ${shortCommit(branchHead)} → ${shortCommit(to)} (fast-forward, ${repo}).`,
  }, common));
}

function quarantineRoot(options: any): string {
  return options.quarantineDir || path.join(sidequestHome(), 'worktree-quarantine');
}

async function quarantineCandidate(entry: any, message: string, options: any): Promise<{ ok: boolean; destination?: string; stderr: string }> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destination = path.join(quarantineRoot(options), `${path.basename(entry.path)}-${timestamp}`);
  try {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.rename(entry.path, destination);
    recordQuarantine(entry.path, message, destination);
    return { ok: true, destination, stderr: '' };
  } catch (error: any) {
    const stderr = String((error && error.message) || error);
    recordQuarantineFailure(entry.path, stderr);
    return { ok: false, stderr };
  }
}

async function hasReparsePoint(pathname: string): Promise<boolean> {
  let status: import('node:fs').Stats;
  try {
    status = await fs.lstat(pathname);
  } catch (_) {
    return true;
  }
  if (status.isSymbolicLink()) return true;
  if (!status.isDirectory()) return false;
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(pathname, { withFileTypes: true });
  } catch (_) {
    return true;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink() || await hasReparsePoint(path.join(pathname, entry.name))) return true;
  }
  return false;
}

async function removeCandidate(repo: string, entry: any): Promise<{ ok: boolean; stderr: string }> {
  const remove = async (pathname: string): Promise<{ ok: boolean; stderr: string }> => (
    git(repo, entry.clean ? ['worktree', 'remove', pathname] : ['worktree', 'remove', '--force', pathname])
  );
  const first = await remove(entry.path);
  if (first.ok || !shouldTryExtendedPath(entry.path, first.stderr)) return first;
  const extended = await remove(extendedWindowsPath(entry.path));
  return extended.ok
    ? extended
    : { ok: false, stderr: `${first.stderr}; extended-path retry: ${extended.stderr}` };
}

function reclaimUnclaimedDispatchWorktree(repository: string, dispatch: any): any {
  const worktree = String(dispatch?.worktree || '').trim();
  if (dispatch?.sharedTree !== false || dispatch?.claimedAt || !worktree) return null;
  const expected = canonicalPath(worktree);
  const entries = parseWorktreeList(execFileSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: repository,
    encoding: 'utf8',
    windowsHide: true,
  }));
  const entry = entries.find((candidate) => canonicalPath(candidate.worktree) === expected);
  if (!entry) return { worktree, reclaimed: false, reason: 'not_registered' };
  const resolveGitPath = (value: string) => path.isAbsolute(value) ? value : path.resolve(entry.worktree, value);
  const lease = worktreeLease.createWorktreeLease({
    repository,
    gitDirectory: resolveGitPath(execFileSync('git', ['rev-parse', '--git-dir'], { cwd: entry.worktree, encoding: 'utf8', windowsHide: true }).trim()),
    commonGitDirectory: resolveGitPath(execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: entry.worktree, encoding: 'utf8', windowsHide: true }).trim()),
    dispatchRef: dispatch.ref || null,
    dispatchBaseline: dispatch.baseCommit || null,
    observedRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: entry.worktree, encoding: 'utf8', windowsHide: true }).trim(),
    observedWorktree: entry.worktree,
    identity: { status: 'unknown' },
    phase: 'terminal',
    locked: Boolean(entry.locked),
    liveness: { status: 'terminal', evidence: 'unclaimed dispatch' },
    provisioning: 'host',
  });
  const cleanup = worktreeLease.worktreeCleanupDecision(lease, [entry.worktree]);
  if (!cleanup.allowed) return { worktree, reclaimed: false, reason: 'lease_refused', message: cleanup.reason };
  const dirty = execFileSync('git', ['status', '--porcelain'], {
    cwd: entry.worktree,
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
  if (dirty) throw new Error(`never-claimed dispatch worktree ${entry.worktree} has uncommitted changes and cannot be reclaimed.`);
  const baseCommit = String(dispatch.baseCommit || '').trim();
  if (baseCommit) {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: entry.worktree,
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
    if (head !== baseCommit) throw new Error(`never-claimed dispatch worktree ${entry.worktree} advanced beyond its dispatch base and cannot be reclaimed.`);
  }
  execFileSync('git', ['worktree', 'remove', entry.worktree], { cwd: repository, windowsHide: true });
  execFileSync('git', ['worktree', 'prune'], { cwd: repository, windowsHide: true });
  const branch = localBranchName(entry.branch);
  if (branch) execFileSync('git', ['branch', '-D', '--', branch], { cwd: repository, windowsHide: true });
  return { worktree: entry.worktree, branch, reclaimed: true };
}

async function sweep(repo: string, tickets: any[], options: any = {}): Promise<any> {
  const minAgeMs = Number.isFinite(Number(options.minAgeMs)) && Number(options.minAgeMs) >= 0
    ? Number(options.minAgeMs)
    : DEFAULT_MIN_AGE_MS;
  const notIntegratedSalvageAgeMs = Number.isFinite(Number(options.notIntegratedSalvageAgeMs)) && Number(options.notIntegratedSalvageAgeMs) >= 0
    ? Number(options.notIntegratedSalvageAgeMs)
    : DEFAULT_NOT_INTEGRATED_SALVAGE_AGE_MS;
  const upstream = integrationUpstream(options);
  if (await repositoryBusy(repo)) {
    return {
      dryRun: !options.execute,
      minAgeMs,
      notIntegratedSalvageAgeMs,
      upstream,
      entries: [],
      orphanBranches: [],
      removed: [],
      backups: [],
      salvaged: [],
      deletedBranches: [],
      prunedOrphanBranches: [],
      quarantined: [],
      counts: { removedWorktrees: 0, salvagedWorktrees: 0, quarantinedWorktrees: 0, backedUpWorktrees: 0, deletedBranches: 0, prunedOrphanBranches: 0 },
      failures: [],
      skipped: 'repository_busy',
    };
  }
  const listed = await git(repo, ['worktree', 'list', '--porcelain']);
  if (!listed.ok) throw new Error(listed.stderr || 'could not list git worktrees');
  const worktreeList = parseWorktreeList(listed.stdout);
  const registered = new Set(worktreeList.map((entry) => canonicalPath(entry.worktree)));
  const candidates = worktreeList
    .filter((entry) => isAgentWorktree(repo, entry.worktree))
    .filter((entry) => quarantineRetryDue(entry.worktree))
    .filter((entry) => !options.ticketRef || ticketForWorktree(tickets, entry)?.ref === options.ticketRef);
  const orphanCandidates: any[] = [];
  const allCandidates = candidates;
  const maxCandidates = Number.isFinite(Number(options.maxCandidates)) && Number(options.maxCandidates) > 0
    ? Math.floor(Number(options.maxCandidates))
    : allCandidates.length;
  const boundedCandidates = allCandidates.slice(0, maxCandidates);
  const livePaths = Array.isArray(options.livePaths) ? options.livePaths.map((pathname: unknown) => String(pathname)) : [];
  const entries = await Promise.all(boundedCandidates.map((entry) => (
    entry.orphanDirectory
      ? classifyOrphanDirectory(tickets, entry, livePaths, minAgeMs)
      : classifyWorktree(repo, tickets, entry, options.currentPath || process.cwd(), minAgeMs, upstream, livePaths, notIntegratedSalvageAgeMs, [...registered])
  )));
  const execute = !!options.execute;
  const removed: string[] = [];
  const backups: string[] = [];
  const salvaged: Array<{ path: string; ref: string; uncommittedRef: string | null; recovery: string }> = [];
  const deletedBranches: string[] = [];
  const prunedOrphanBranches: string[] = [];
  const quarantined: Array<{ path: string; destination: string; message: string }> = [];
  const failures: Array<{ path: string | null; message: string; suppressed?: boolean }> = [];

  if (execute) {
    for (const entry of entries.filter((candidate) => candidate.action === 'remove' || candidate.action === 'salvage')) {
      if (shouldSkipKnownFailure(entry.path)) {
        entry.action = 'keep';
        entry.reason = 'known_permanent_failure';
        continue;
      }
      if (await hasReparsePoint(entry.path)) {
        entry.action = 'keep';
        entry.reason = 'reparse_point';
        continue;
      }
      if (entry.action === 'salvage') {
        try {
          entry.salvage = await salvageWorktree(repo, entry);
          salvaged.push({ path: entry.path, ...entry.salvage, recovery: recoveryCommand(entry) });
        } catch (error: any) {
          entry.action = 'keep';
          entry.reason = 'salvage_failed';
          failures.push({ path: entry.path, message: `salvage failed: ${(error && error.message) || error}` });
          continue;
        }
      }
      if (!entry.clean && !entry.salvage) {
        try {
          entry.backup = entry.orphanDirectory
            ? await backupDirtyOrphanDirectory(entry, options)
            : await backupDirtyWorktree(repo, entry, upstream, options);
          backups.push(entry.backup);
        } catch (error: any) {
          failures.push({ path: entry.path, message: `backup failed: ${(error && error.message) || error}` });
          continue;
        }
      }
      const result = await removeCandidate(repo, entry);
      if (!result.ok) {
        const message = result.stderr || 'worktree remove failed';
        recordFailure(entry.path, message);
        const quarantine = await quarantineCandidate(entry, message, options);
        if (!quarantine.ok || !quarantine.destination) {
          entry.action = 'keep';
          entry.reason = 'quarantine_failed';
          failures.push({ path: entry.path, message: `${message}; quarantine failed: ${quarantine.stderr}` });
          continue;
        }
        entry.action = 'quarantine';
        entry.reason = 'remove_failed_quarantined';
        entry.quarantine = quarantine.destination;
        quarantined.push({ path: entry.path, destination: quarantine.destination, message });
        continue;
      }
      clearFailure(entry.path);
      removed.push(entry.path);
      if (entry.orphanDirectory) continue;
      const branch = localBranchName(entry.branch);
      if (!branch) continue;
      const deleted = await git(repo, ['branch', '-D', '--', branch]);
      if (deleted.ok) deletedBranches.push(branch);
      else failures.push({ path: branch, message: deleted.stderr || 'git branch delete failed' });
    }
    if (removed.length || quarantined.length) {
      const prune = await git(repo, ['worktree', 'prune']);
      if (!prune.ok) failures.push({ path: null, message: prune.stderr || 'git worktree prune failed' });
    }
  }

  const remainingList = execute ? await git(repo, ['worktree', 'list', '--porcelain']) : listed;
  if (!remainingList.ok) throw new Error(remainingList.stderr || 'could not list git worktrees');
  const remainingWorktrees = parseWorktreeList(remainingList.stdout);
  const checkedOutBranches = new Set<string>(remainingWorktrees
    .map((entry) => localBranchName(entry.branch))
    .filter((branch): branch is string => !!branch));
  const orphanBranches = options.ticketRef ? [] : await findOrphanBranches(repo, checkedOutBranches, upstream, maxCandidates);
  if (execute) {
    for (const entry of orphanBranches.filter((candidate) => candidate.action === 'prune')) {
      const deleted = await git(repo, ['branch', '-D', '--', entry.branch]);
      if (deleted.ok) prunedOrphanBranches.push(entry.branch);
      else failures.push({ path: entry.branch, message: deleted.stderr || 'git branch delete failed' });
    }
  }

  return {
    dryRun: !execute,
    minAgeMs,
    notIntegratedSalvageAgeMs,
    upstream,
    entries,
    orphanBranches,
    removed,
    backups,
    salvaged,
    deletedBranches,
    prunedOrphanBranches,
    quarantined,
    counts: {
      removedWorktrees: removed.length,
      salvagedWorktrees: salvaged.length,
      quarantinedWorktrees: quarantined.length,
      backedUpWorktrees: backups.length,
      deletedBranches: deletedBranches.length,
      prunedOrphanBranches: prunedOrphanBranches.length,
    },
    failures,
  };
}

module.exports = { DEFAULT_MIN_AGE_MS, DEFAULT_NOT_INTEGRATED_SALVAGE_AGE_MS, gitBashPath, canonicalPath, worktreeRoot, legacyWorktreeRoot, agentWorktreePath, agentWorktreeCandidates, resolvedAgentWorktree, namedWorktreePath, agentWorktreeRoots, parseWorktreeList, isAgentWorktree, ignoredPathsMissingFromWorktree, provisionWorktree, preferredWorktreeIntegrationTarget, classifyWorktree, advanceIntegrationBranch, reclaimUnclaimedDispatchWorktree, sweep };
