import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isInScope, normalizeScope, scopeKey, scopedPaths } from './scope-match.js';

export { isInScope, scopedPaths } from './scope-match.js';

type UnknownRecord = Record<string, unknown>;
type GitResult = { ok: true; value: string } | { ok: false; message: string };

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}

function gitResult(cwd: string, args: readonly string[]): GitResult {
  try {
    return { ok: true, value: git(cwd, args).trim() };
  } catch (error) {
    return { ok: false, message: errorMessage(error) };
  }
}

function patchIds(cwd: string, args: readonly string[]): GitResult {
  try {
    const patches = git(cwd, args);
    if (!patches.trim()) return { ok: true, value: '' };
    return {
      ok: true,
      value: execFileSync('git', ['patch-id', '--stable'], {
        cwd,
        encoding: 'utf8',
        input: patches,
        windowsHide: true,
      }).trim(),
    };
  } catch (error) {
    return { ok: false, message: errorMessage(error) };
  }
}

function patchIdsForCommits(cwd: string, commits: string[]): Set<string> | null {
  const ids = new Set<string>();
  for (const commit of commits) {
    const result = patchIds(cwd, ['show', '--format=', '--no-ext-diff', commit]);
    if (!result.ok) return null;
    for (const line of result.value.split(/\r?\n/).filter(Boolean)) {
      const patchId = line.split(/\s+/)[0];
      if (patchId) ids.add(patchId);
    }
  }
  return ids;
}

function submissionAlreadyOnIntegrationBranch(cwd: string, submission: UnknownRecord): { reconciled: boolean; divergedPath?: string } {
  const commits = Array.isArray(submission.commits) ? submission.commits.filter((commit): commit is string => typeof commit === 'string' && commit.length > 0) : [];
  const changedPaths = Array.isArray(submission.changedPaths) ? submission.changedPaths.filter((file): file is string => typeof file === 'string' && file.length > 0) : [];
  const integrationBranch = String(submission.integrationBranch || submission.upstream || '').trim();
  if (!commits.length || !changedPaths.length || !integrationBranch || submission.noOp === true) return { reconciled: false };
  const submittedPatchIds = patchIdsForCommits(cwd, commits);
  if (!submittedPatchIds?.size) return { reconciled: false };
  const integrationCommits = gitResult(cwd, ['rev-list', '--no-merges', integrationBranch]);
  if (!integrationCommits.ok) return { reconciled: false };
  const integrationPatchIds = patchIdsForCommits(cwd, integrationCommits.value.split(/\r?\n/).filter(Boolean));
  if (integrationPatchIds == null || ![...submittedPatchIds].every((patchId) => integrationPatchIds.has(patchId))) return { reconciled: false };
  const differingPaths = gitResult(cwd, ['diff', '--name-only', integrationBranch, String(submission.commit), '--', ...changedPaths]);
  if (!differingPaths.ok) return { reconciled: false };
  const divergedPath = differingPaths.value.split(/\r?\n/).find(Boolean);
  return divergedPath ? { reconciled: false, divergedPath } : { reconciled: true };
}

export function repoRoot(cwd: string): string {
  return git(cwd, ['rev-parse', '--show-toplevel']).trim();
}

function filesystemPathKey(value: string): string {
  const normalized = path.resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function linkedWorktree(cwd: string): { ok: true; linked: boolean } | { ok: false; message: string } {
  const gitDir = gitResult(cwd, ['rev-parse', '--git-dir']);
  if (!gitDir.ok) return { ok: false, message: gitDir.message };
  const commonDir = gitResult(cwd, ['rev-parse', '--git-common-dir']);
  if (!commonDir.ok) return { ok: false, message: commonDir.message };
  return {
    ok: true,
    linked: filesystemPathKey(path.resolve(cwd, gitDir.value)) !== filesystemPathKey(path.resolve(cwd, commonDir.value)),
  };
}

function indexedPaths(cwd: string): string[] {
  return git(cwd, ['ls-files', '--full-name', '-z'])
    .split('\0')
    .filter(Boolean)
    .map((file) => file.replace(/\\/g, '/'));
}

function trackedPaths(cwd: string): string[] {
  const paths = indexedPaths(cwd);
  const head = gitResult(cwd, ['ls-tree', '-r', '--name-only', '-z', 'HEAD']);
  if (!head.ok) return paths;

  const seen = new Set(paths.map(scopeKey));
  for (const file of head.value.split('\0').filter(Boolean).map((entry) => entry.replace(/\\/g, '/'))) {
    if (!seen.has(scopeKey(file))) {
      seen.add(scopeKey(file));
      paths.push(file);
    }
  }
  return paths;
}

function canonicalScope(scope: string, paths: readonly string[]): string {
  const normalized = normalizeScope(scope);
  const key = scopeKey(normalized);
  const matchingPath = paths.find((file) => {
    const fileKey = scopeKey(file);
    return fileKey === key || fileKey.startsWith(`${key}/`);
  });
  return matchingPath ? matchingPath.slice(0, normalized.length) : normalized;
}

function canonicalScopedPaths(cwd: string, files: unknown): string[] {
  const paths = trackedPaths(cwd);
  return scopedPaths(files).map((scope) => canonicalScope(scope, paths));
}

function commitScopedPaths(root: string, scopes: readonly string[]): string[] {
  const tracked = trackedPaths(root);
  return scopes.filter((scope) => (
    fs.existsSync(path.resolve(root, scope))
    || tracked.some((file) => isInScope(file, [scope]))
  ));
}

function ignoredUntrackedScope(root: string, scope: string): boolean {
  const target = path.resolve(root, scope);
  try {
    fs.lstatSync(target);
  } catch {
    return false;
  }
  if (gitResult(root, ['ls-files', '--error-unmatch', '--', scope]).ok) return false;
  return gitResult(root, ['check-ignore', '--quiet', '--no-index', '--', scope]).ok;
}

function stageableScopedPaths(root: string, scopes: readonly string[]): string[] {
  const indexed = indexedPaths(root);
  return scopes.filter((scope) => !ignoredUntrackedScope(root, scope) && (
    fs.existsSync(path.resolve(root, scope))
    || indexed.some((file) => isInScope(file, [scope]))
  ));
}

export function workingPaths(cwd: string): string[] {
  const status = git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const entries = status.split('\0');
  const paths: string[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (!entry) continue;
    const state = entry.slice(0, 2);
    const file = entry.slice(3).replace(/\\/g, '/');
    if (file) paths.push(file);
    if (state.includes('R') || state.includes('C')) {
      const previous = entries[++index];
      if (previous) paths.push(previous.replace(/\\/g, '/'));
    }
  }
  return Array.from(new Set(paths));
}

export function ticketReleaseFragment(ticketRef: unknown): string | null {
  const ref = typeof ticketRef === 'string' ? ticketRef.trim() : '';
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(ref) ? `.release/unreleased/${ref}.md` : null;
}

export function ticketCommitScope(effectiveFiles: unknown, declaredFiles: unknown, ticketRef: unknown): string[] {
  const scope = Array.isArray(effectiveFiles) ? effectiveFiles.slice() : [];
  const fragment = Array.isArray(declaredFiles) && declaredFiles.length ? ticketReleaseFragment(ticketRef) : null;
  return fragment && !isInScope(fragment, scope) ? [...scope, fragment] : scope;
}

export function foreignReleaseFragmentPaths(cwd: string, ticketRef: unknown): string[] {
  const ownFragment = ticketReleaseFragment(ticketRef);
  return workingPaths(cwd).filter((file) => (
    file.startsWith('.release/unreleased/')
    && file.endsWith('.md')
    && file !== ownFragment
  ));
}

export function unscopedWorkingPaths(cwd: string, files: unknown): string[] {
  return workingPaths(cwd).filter((file) => !isInScope(file, files));
}

function pathKey(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function relativeScopeOutside(scope: string): boolean {
  const raw = String(scope || '').trim();
  const parts = raw.replace(/\\/g, '/').split('/');
  return path.isAbsolute(raw)
    || path.win32.isAbsolute(raw)
    || path.posix.isAbsolute(raw)
    || /^[a-z]:/i.test(raw)
    || parts.includes('..');
}

function repoRelativePath(root: string, target: string): string {
  return path.relative(root, target).replace(/\\/g, '/') || '.';
}

function inspectExistingPath(root: string, realRoot: string, target: string, inspectDescendants: boolean) {
  const relative = path.relative(root, target);
  const parts = relative ? relative.split(path.sep) : [];
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]!);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error: any) {
      if (error && error.code === 'ENOENT') return { ok: true, indirect: [] as string[] };
      return { ok: false, reason: 'scope_unavailable', indirect: [repoRelativePath(root, current)] };
    }
    if (stat.isSymbolicLink()) {
      return { ok: false, reason: 'filesystem_indirection', indirect: [repoRelativePath(root, current)] };
    }
    try {
      const expected = path.join(realRoot, ...parts.slice(0, index + 1));
      if (pathKey(fs.realpathSync.native(current)) !== pathKey(expected)) {
        return { ok: false, reason: 'filesystem_indirection', indirect: [repoRelativePath(root, current)] };
      }
    } catch {
      return { ok: false, reason: 'scope_unavailable', indirect: [repoRelativePath(root, current)] };
    }
  }

  if (!inspectDescendants || !fs.existsSync(target)) return { ok: true, indirect: [] as string[] };
  const pending = [target];
  while (pending.length) {
    const currentPath = pending.pop()!;
    let stat;
    try {
      stat = fs.lstatSync(currentPath);
      const expected = path.join(realRoot, path.relative(root, currentPath));
      if (stat.isSymbolicLink() || pathKey(fs.realpathSync.native(currentPath)) !== pathKey(expected)) {
        return { ok: false, reason: 'filesystem_indirection', indirect: [repoRelativePath(root, currentPath)] };
      }
      if (stat.isDirectory()) {
        for (const entry of fs.readdirSync(currentPath)) pending.push(path.join(currentPath, entry));
      }
    } catch {
      return { ok: false, reason: 'scope_unavailable', indirect: [repoRelativePath(root, currentPath)] };
    }
  }
  return { ok: true, indirect: [] as string[] };
}

export function validateRelativeScopes(files: unknown) {
  const scopes = scopedPaths(files);
  if (!scopes.length) return { ok: false, reason: 'missing_scope', outside: [] as string[] };
  const outside = scopes.filter(relativeScopeOutside);
  return { ok: outside.length === 0, reason: outside.length ? 'outside_scope' : null, outside };
}

export function validateScopeResolution(root: string, files: unknown, opts?: { inspectDescendants?: boolean }) {
  const relativeValidation = validateRelativeScopes(files);
  const scopes = scopedPaths(files);
  if (!relativeValidation.ok) {
    return { ...relativeValidation, indirect: [] as string[] };
  }
  const resolvedRoot = path.resolve(root);
  const outside = scopes.filter((scope) => {
    const relative = path.relative(resolvedRoot, path.resolve(resolvedRoot, ...scope.split('/')));
    return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  });
  if (outside.length) return { ok: false, reason: 'outside_scope', outside, indirect: [] as string[] };

  let realRoot;
  try {
    realRoot = fs.realpathSync.native(resolvedRoot);
  } catch {
    return { ok: false, reason: 'scope_unavailable', outside: scopes, indirect: [] as string[] };
  }
  for (const scope of scopes) {
    const target = path.resolve(resolvedRoot, ...scope.split('/'));
    const inspected = inspectExistingPath(resolvedRoot, realRoot, target, opts?.inspectDescendants === true);
    if (!inspected.ok) {
      return { ok: false, reason: inspected.reason, outside: [] as string[], indirect: inspected.indirect };
    }
  }
  return { ok: true, reason: null, outside: [] as string[], indirect: [] as string[] };
}

export function commitPaths(cwd: string, commit: string): string[] {
  return git(cwd, ['diff-tree', '--root', '--no-commit-id', '-r', '--name-only', '-z', commit])
    .split('\0')
    .filter(Boolean)
    .map((file) => file.replace(/\\/g, '/'));
}

export function rangePaths(cwd: string, commits: readonly string[]): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const commit of commits) {
    for (const file of commitPaths(cwd, commit)) {
      const key = scopeKey(file);
      if (!seen.has(key)) {
        seen.add(key);
        paths.push(file);
      }
    }
  }
  return paths;
}

function validatePaths(files: unknown, paths: string[]) {
  const scopes = scopedPaths(files);
  if (!scopes.length) return { ok: false, reason: 'missing_scope', paths: [] as string[], outside: [] as string[] };
  const outside = paths.filter((file) => !isInScope(file, scopes));
  return { ok: outside.length === 0, reason: outside.length ? 'outside_scope' : null, paths, outside };
}

export function validateCommitScope(cwd: string, commit: string, files: unknown) {
  try {
    return validatePaths(files, commitPaths(cwd, commit));
  } catch (error) {
    return { ok: false, reason: 'git_error', paths: [] as string[], outside: [] as string[], message: errorMessage(error) };
  }
}

export function validateCommitRangeScope(cwd: string, commits: readonly string[], files: unknown) {
  try {
    return validatePaths(files, rangePaths(cwd, commits));
  } catch (error) {
    return { ok: false, reason: 'git_error', paths: [] as string[], outside: [] as string[], message: errorMessage(error) };
  }
}

function resolvedCommit(cwd: string, name: unknown): GitResult {
  return gitResult(cwd, ['rev-parse', '--verify', `${String(name || '').trim()}^{commit}`]);
}

function isAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  try {
    git(cwd, ['merge-base', '--is-ancestor', ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

export function submissionCommitReachedIntegrationBranch(cwd: string, submission: UnknownRecord, integrationBranchOverride?: unknown): boolean {
  if (submission.noOp === true) return false;
  const commit = String(submission.commit || '').trim();
  const integrationBranch = String(integrationBranchOverride || submission.integrationBranch || submission.upstream || '').trim();
  return Boolean(commit && integrationBranch && isAncestor(cwd, commit, integrationBranch));
}

function parentCommits(cwd: string, commit: string): string[] {
  const parents = gitResult(cwd, ['rev-list', '--parents', '-n', '1', commit]);
  return parents.ok ? parents.value.trim().split(/\s+/).slice(1).filter(Boolean) : [];
}

// git's canonical empty tree. A repository's root commit has no parent to name
// as a submission base, and the range metadata is a pair of hex object ids, so
// the empty tree stands in for "everything before this commit" — `diff-tree
// --root` already reads root commits, so the scoped paths still resolve.
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function isEmptyTreeBase(value: unknown): boolean {
  return String(value || '').trim().toLowerCase() === EMPTY_TREE;
}

export function headCommit(cwd: string): string | null {
  const head = resolvedCommit(cwd, 'HEAD');
  return head.ok ? head.value : null;
}

export function preserveCommitRef(cwd: string, commit: unknown, gitRef: unknown, options?: { noOverwrite?: boolean }) {
  const ref = String(gitRef || '').trim();
  if (!ref) return { ok: false as const, reason: 'missing_git_ref' };
  try {
    const root = repoRoot(cwd);
    const tip = resolvedCommit(root, commit);
    if (!tip.ok) return { ok: false as const, reason: 'missing_commit', message: tip.message };
    const validRef = gitResult(root, ['check-ref-format', ref]);
    if (!validRef.ok) return { ok: false as const, reason: 'invalid_git_ref', message: validRef.message };
    if (options?.noOverwrite) {
      const existing = resolvedCommit(root, ref);
      if (existing.ok) {
        if (existing.value === tip.value) return { ok: true as const, commit: tip.value, gitRef: ref };
        return { ok: false as const, reason: 'git_ref_collision', message: `${ref} already points to ${existing.value}` };
      }
      const emptyRef = '0000000000000000000000000000000000000000';
      const created = gitResult(root, ['update-ref', ref, tip.value, emptyRef]);
      if (!created.ok) return { ok: false as const, reason: 'git_ref_collision', message: created.message };
      return { ok: true as const, commit: tip.value, gitRef: ref };
    }
    git(root, ['update-ref', ref, tip.value]);
    return { ok: true as const, commit: tip.value, gitRef: ref };
  } catch (error) {
    return { ok: false as const, reason: 'git_error', message: errorMessage(error) };
  }
}

// What a done-time caller needs before it may claim a run wrote nothing: the
// declared scope's uncommitted paths, plus the scoped paths this checkout has
// already committed past `base`. Either one means the ticket owes a submission
// rather than a closeout (SQ-923).
export function scopedWorkPending(cwd: string, files: unknown, options?: unknown) {
  const opts = isRecord(options) ? options : {};
  const scopes = scopedPaths(files);
  if (!scopes.length) return { ok: false as const, reason: 'missing_scope' };
  const baseName = String(opts.base || '').trim();
  if (!baseName) return { ok: false as const, reason: 'missing_base' };
  try {
    const root = repoRoot(cwd);
    const working = workingPaths(root).filter((file) => isInScope(file, scopes));
    const base = resolvedCommit(root, baseName);
    if (!base.ok) return { ok: false as const, reason: 'missing_base', message: base.message };
    const tip = resolvedCommit(root, 'HEAD');
    if (!tip.ok) return { ok: false as const, reason: 'missing_commit', message: tip.message };
    let committed: string[] = [];
    if (base.value !== tip.value) {
      const list = gitResult(root, ['rev-list', `${base.value}..${tip.value}`]);
      if (!list.ok) return { ok: false as const, reason: 'git_error', message: list.message };
      const commits = list.value ? list.value.split(/\r?\n/).filter(Boolean) : [];
      if (commits.length) committed = rangePaths(root, commits).filter((file) => isInScope(file, scopes));
    }
    return { ok: true as const, root, working, committed, pending: working.length > 0 || committed.length > 0 };
  } catch (error) {
    return { ok: false as const, reason: 'git_error', message: errorMessage(error) };
  }
}

export function submissionRange(cwd: string, options: unknown) {
  const opts = isRecord(options) ? options : {};
  const gitRef = String(opts.gitRef || '').trim();
  const upstream = String(opts.upstream || '').trim();
  const tipName = String(opts.commit || '').trim();
  if (!gitRef) return { ok: false, reason: 'missing_git_ref' };
  if (!upstream) return { ok: false, reason: 'missing_upstream' };

  const tip = resolvedCommit(cwd, tipName);
  if (!tip.ok) return { ok: false, reason: 'missing_commit', message: tip.message };
  const refTip = resolvedCommit(cwd, gitRef);
  if (!refTip.ok) return { ok: false, reason: 'missing_git_ref', message: refTip.message };
  if (tip.value !== refTip.value) return { ok: false, reason: 'tip_mismatch', tip: tip.value, refTip: refTip.value, gitRef };

  const currentUpstream = resolvedCommit(cwd, upstream);
  if (!currentUpstream.ok) return { ok: false, reason: 'missing_upstream', upstream, message: currentUpstream.message };
  const recordedUpstream = opts.upstreamCommit ? resolvedCommit(cwd, opts.upstreamCommit) : null;
  if (recordedUpstream && !recordedUpstream.ok) return { ok: false, reason: 'missing_recorded_upstream', message: recordedUpstream.message };
  if (recordedUpstream && !isAncestor(cwd, recordedUpstream.value, currentUpstream.value)) {
    return { ok: false, reason: 'expected_upstream_diverged', upstream, upstreamCommit: recordedUpstream.value, currentUpstream: currentUpstream.value };
  }

  const mergeBase = gitResult(cwd, ['merge-base', currentUpstream.value, tip.value]);
  if (!mergeBase.ok || !mergeBase.value) return { ok: false, reason: 'unrelated_history', upstream, tip: tip.value, message: mergeBase.ok ? undefined : mergeBase.message };

  const rootBase = isEmptyTreeBase(opts.base);
  const requestedBase = opts.base && !rootBase ? resolvedCommit(cwd, opts.base) : null;
  if (requestedBase && !requestedBase.ok) return { ok: false, reason: 'missing_base', message: requestedBase.message };
  const integrationBranch = resolvedCommit(cwd, opts.integrationBranch || upstream);
  const baseIsOnTip = !!requestedBase && isAncestor(cwd, requestedBase.value, tip.value);
  const baseIsAfterMergeBase = !!requestedBase && isAncestor(cwd, mergeBase.value, requestedBase.value);
  const baseIsIntegrated = !!requestedBase && integrationBranch.ok && isAncestor(cwd, requestedBase.value, integrationBranch.value);
  if (requestedBase && (!baseIsOnTip || (!baseIsAfterMergeBase && !baseIsIntegrated))) {
    return { ok: false, reason: 'base_not_reachable', base: requestedBase.value, actualBase: mergeBase.value, upstream, tip: tip.value };
  }

  const allowedBaseNames = Array.isArray(opts.allowedBases) ? opts.allowedBases : null;
  if (requestedBase && requestedBase.value !== mergeBase.value && allowedBaseNames) {
    const allowedBases = new Set(allowedBaseNames
      .map((name) => resolvedCommit(cwd, name))
      .filter((candidate) => candidate.ok)
      .map((candidate) => candidate.value));
    if (!baseIsIntegrated && !allowedBases.has(requestedBase.value)) {
      return {
        ok: false,
        reason: 'unrecognized_base',
        base: requestedBase.value,
        actualBase: mergeBase.value,
        upstream,
        tip: tip.value,
        message: 'explicit base must be on the integration branch or match a validated submitted ticket boundary',
      };
    }
  }

  let effectiveBase = requestedBase ? requestedBase.value : mergeBase.value;
  if (!requestedBase && !rootBase && opts.dispatchBase) {
    const dispatchBase = resolvedCommit(cwd, opts.dispatchBase);
    const dispatchBaseIsOnTip = dispatchBase.ok && isAncestor(cwd, dispatchBase.value, tip.value);
    const dispatchBaseIsAfterMergeBase = dispatchBase.ok && isAncestor(cwd, mergeBase.value, dispatchBase.value);
    const dispatchBaseIsIntegrated = dispatchBase.ok && integrationBranch.ok && isAncestor(cwd, dispatchBase.value, integrationBranch.value);
    if (dispatchBaseIsOnTip && (dispatchBaseIsAfterMergeBase || dispatchBaseIsIntegrated)) {
      effectiveBase = dispatchBase.value;
    }
  }
  if (!requestedBase && !rootBase && Array.isArray(opts.baseCandidates) && opts.baseCandidates.length) {
    const candidates = new Set<string>();
    for (const name of opts.baseCandidates) {
      const candidate = resolvedCommit(cwd, name);
      if (candidate.ok && isAncestor(cwd, effectiveBase, candidate.value) && isAncestor(cwd, candidate.value, tip.value)) {
        candidates.add(candidate.value);
      }
    }
    if (candidates.size) {
      const history = gitResult(cwd, ['rev-list', '--reverse', `${effectiveBase}..${tip.value}`]);
      if (!history.ok) return { ok: false, reason: 'git_error', message: history.message };
      for (const commit of history.value.split(/\r?\n/).filter(Boolean)) {
        if (candidates.has(commit)) effectiveBase = commit;
      }
    }
  }

  let commits: string[];
  let rootCommit = false;
  let noOp = false;
  if (rootBase) {
    // Re-validating a stored root-commit submission: there is no parent range to
    // walk, so confirm the tip really is parentless and take the commit itself.
    if (parentCommits(cwd, tip.value).length) {
      return { ok: false, reason: 'base_not_reachable', base: EMPTY_TREE, actualBase: mergeBase.value, upstream, tip: tip.value };
    }
    rootCommit = true;
    effectiveBase = EMPTY_TREE;
    commits = [tip.value];
  } else {
    const commitList = gitResult(cwd, ['rev-list', '--reverse', `${effectiveBase}..${tip.value}`]);
    if (!commitList.ok) return { ok: false, reason: 'git_error', message: commitList.message };
    commits = commitList.value ? commitList.value.split(/\r?\n/).filter(Boolean) : [];
    // An empty range does not mean nothing was done — it means the tip is not
    // AHEAD of the integration branch, which is what happens whenever the scoped
    // commit IS the branch tip: a greenfield repo whose first commit is the board
    // commit, or a shared-tree dispatch whose commit advanced main. Merge-base and
    // tip are then the same commit. Recover the way the orchestrator did by hand,
    // submitting against the tip's own parent (SQ-923).
    if (!commits.length && requestedBase && requestedBase.value === tip.value) {
      noOp = true;
    }
    if (!commits.length && !noOp && !requestedBase && effectiveBase === tip.value) {
      const tipParents = parentCommits(cwd, tip.value);
      rootCommit = tipParents.length === 0;
      effectiveBase = rootCommit ? EMPTY_TREE : tipParents[0]!;
      commits = [tip.value];
    }
    if (!commits.length && !noOp) return { ok: false, reason: 'empty_range', base: effectiveBase, tip: tip.value };
  }

  try {
    return {
      ok: true,
      base: effectiveBase,
      commit: tip.value,
      gitRef,
      upstream,
      upstreamCommit: currentUpstream.value,
      commits,
      changedPaths: rangePaths(cwd, commits),
      ...(noOp ? { noOp: true } : {}),
    };
  } catch (error) {
    return { ok: false, reason: 'git_error', message: errorMessage(error) };
  }
}

export function validateStoredSubmissionRange(cwd: string, submissionValue: unknown, ticketRef?: unknown, integrationBranchOverride?: unknown) {
  const submission = isRecord(submissionValue) ? submissionValue : {};
  const candidateReachedIntegration = submissionCommitReachedIntegrationBranch(cwd, submission, integrationBranchOverride);
  const range = submissionRange(cwd, {
    commit: submission.commit,
    gitRef: submission.gitRef,
    upstream: submission.upstream,
    upstreamCommit: submission.upstreamCommit,
    integrationBranch: submission.integrationBranch,
    base: submission.base,
  });
  const reconciliation = candidateReachedIntegration
    ? { reconciled: true }
    : !range.ok && range.reason === 'expected_upstream_diverged'
      ? submissionAlreadyOnIntegrationBranch(cwd, submission)
      : { reconciled: false };
  if (!range.ok && !reconciliation.reconciled) {
    if (reconciliation.divergedPath) {
      return Object.assign({}, range, {
        reason: 'reconciled_path_diverged',
        divergedPath: reconciliation.divergedPath,
        message: `submitted path diverged at integration tip: ${reconciliation.divergedPath}`,
      });
    }
    return range;
  }
  const reconciled = reconciliation.reconciled;
  const storedCommits = Array.isArray(submission.commits) ? submission.commits : [];
  const storedPaths = Array.isArray(submission.changedPaths) ? submission.changedPaths : [];
  const rangeNoOp = reconciled ? false : 'noOp' in range && range.noOp === true;
  const rangeCommits = reconciled ? storedCommits : 'commits' in range && Array.isArray(range.commits) ? range.commits : [];
  const rangeChangedPaths = reconciled ? storedPaths : 'changedPaths' in range && Array.isArray(range.changedPaths) ? range.changedPaths : [];
  if (Boolean(submission.noOp) !== rangeNoOp) {
    return Object.assign({}, range, { ok: false, reason: 'no_op_changed', storedNoOp: Boolean(submission.noOp) });
  }
  if (storedCommits.length && JSON.stringify(storedCommits) !== JSON.stringify(rangeCommits)) {
    return Object.assign({}, range, { ok: false, reason: 'range_changed', storedCommits });
  }
  if (storedPaths.length && JSON.stringify(storedPaths) !== JSON.stringify(rangeChangedPaths)) {
    return Object.assign({}, range, { ok: false, reason: 'changed_paths_changed', storedPaths });
  }
  const admittedScope = scopedPaths(submission.admittedScope);
  if (!admittedScope.length) {
    return Object.assign({}, range, {
      ok: false,
      reason: 'missing_scope_snapshot',
      message: 'submission has no admitted scope snapshot; re-submit it, or close with the explicit legacy-scope override and a recorded reason.',
    });
  }
  const submissionScope = ticketCommitScope(admittedScope, admittedScope, ticketRef);
  const scopeValidation = validatePaths(submissionScope, rangeChangedPaths);
  if (!scopeValidation.ok) return Object.assign({}, range, scopeValidation, { admittedScope });
  return Object.assign({}, range, {
    ok: true,
    commits: rangeCommits,
    changedPaths: rangeChangedPaths,
    admittedScope,
    ...(reconciled ? { reconciled: true } : {}),
  });
}

export function commitScoped(cwd: string, message: unknown, files: unknown) {
  const scopes = scopedPaths(files);
  if (!scopes.length) return { ok: false, reason: 'missing_scope' };
  try {
    const root = repoRoot(cwd);
    const resolution = validateScopeResolution(root, scopes);
    if (!resolution.ok) return resolution;
    const canonicalScopes = canonicalScopedPaths(root, scopes);
    const commitScopes = commitScopedPaths(root, canonicalScopes);
    const missingScopes = canonicalScopes.filter((scope) => !commitScopes.includes(scope));
    const unscopedPaths = unscopedWorkingPaths(root, scopes);
    if (!commitScopes.length) {
      return { ok: false, reason: 'no_existing_scope', missingScopes, unscopedPaths };
    }
    const stageableScopes = stageableScopedPaths(root, commitScopes);
    const committableScopes = commitScopes.filter((scope) => !ignoredUntrackedScope(root, scope));
    if (stageableScopes.length) git(root, ['add', '--all', '--', ...stageableScopes]);
    git(root, ['commit', '--only', '-m', String(message || ''), '--', ...committableScopes]);
    const commit = git(root, ['rev-parse', 'HEAD']).trim();
    const validation = validateCommitScope(root, commit, scopes);
    return Object.assign({ commit, missingScopes, unscopedPaths }, validation);
  } catch (error) {
    return { ok: false, reason: 'git_error', message: errorMessage(error) };
  }
}
