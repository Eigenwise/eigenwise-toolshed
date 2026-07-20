import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

type UnknownRecord = Record<string, unknown>;
type GitResult = { ok: true; value: string } | { ok: false; message: string };

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeScope(scope: unknown): string {
  return String(scope || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/\*\*$/, '')
    .replace(/\/+$/, '');
}

function scopeKey(scope: unknown): string {
  const normalized = normalizeScope(scope);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function scopedPaths(files: unknown): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const file of Array.isArray(files) ? files : []) {
    const scope = normalizeScope(file);
    const key = scopeKey(scope);
    if (scope && !seen.has(key)) {
      seen.add(key);
      paths.push(scope);
    }
  }
  return paths;
}

export function isInScope(file: unknown, files: unknown): boolean {
  const filePath = scopeKey(file);
  return scopedPaths(files).some((scope) => {
    const key = scopeKey(scope);
    return filePath === key || filePath.startsWith(`${key}/`);
  });
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

export function repoRoot(cwd: string): string {
  return git(cwd, ['rev-parse', '--show-toplevel']).trim();
}

function trackedPaths(cwd: string): string[] {
  return git(cwd, ['ls-files', '--full-name', '-z'])
    .split('\0')
    .filter(Boolean)
    .map((file) => file.replace(/\\/g, '/'));
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

function existingScopedPaths(root: string, files: unknown): string[] {
  return canonicalScopedPaths(root, files).filter((scope) => fs.existsSync(path.resolve(root, scope)));
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

export function unscopedWorkingPaths(cwd: string, files: unknown): string[] {
  return workingPaths(cwd).filter((file) => !isInScope(file, files));
}

export function validateScopeResolution(root: string, files: unknown) {
  const scopes = scopedPaths(files);
  if (!scopes.length) return { ok: false, reason: 'missing_scope', outside: [] as string[] };
  const outside = scopes.filter((scope) => {
    const relative = path.relative(root, path.resolve(root, scope));
    return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  });
  return { ok: outside.length === 0, reason: outside.length ? 'outside_scope' : null, outside };
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

export function submissionRange(cwd: string, options: unknown) {
  const opts = isRecord(options) ? options : {};
  const gitRef = String(opts.gitRef || '').trim();
  const upstream = String(opts.upstream || 'origin/main').trim();
  const tipName = String(opts.commit || '').trim();
  if (!gitRef) return { ok: false, reason: 'missing_git_ref' };

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
  const requestedBase = opts.base ? resolvedCommit(cwd, opts.base) : null;
  if (requestedBase && !requestedBase.ok) return { ok: false, reason: 'missing_base', message: requestedBase.message };
  if (requestedBase && !isAncestor(cwd, requestedBase.value, currentUpstream.value)) {
    return { ok: false, reason: 'base_not_reachable', base: requestedBase.value, upstream, upstreamCommit: currentUpstream.value };
  }

  const mergeBase = gitResult(cwd, ['merge-base', currentUpstream.value, tip.value]);
  if (!mergeBase.ok || !mergeBase.value) return { ok: false, reason: 'unrelated_history', upstream, tip: tip.value, message: mergeBase.ok ? undefined : mergeBase.message };
  if (requestedBase && requestedBase.value !== mergeBase.value) {
    return { ok: false, reason: 'diverged_history', base: requestedBase.value, actualBase: mergeBase.value, upstream, tip: tip.value };
  }

  const commitList = gitResult(cwd, ['rev-list', '--reverse', `${mergeBase.value}..${tip.value}`]);
  if (!commitList.ok) return { ok: false, reason: 'git_error', message: commitList.message };
  const commits = commitList.value ? commitList.value.split(/\r?\n/).filter(Boolean) : [];
  if (!commits.length) return { ok: false, reason: 'empty_range', base: mergeBase.value, tip: tip.value };

  const parents = gitResult(cwd, ['rev-list', '--parents', `${mergeBase.value}..${tip.value}`]);
  if (!parents.ok) return { ok: false, reason: 'git_error', message: parents.message };
  const mergeCommit = parents.value.split(/\r?\n/).find((line) => line.trim().split(/\s+/).length > 2);
  if (mergeCommit) return { ok: false, reason: 'merge_commit', commit: mergeCommit.trim().split(/\s+/)[0] };

  try {
    return {
      ok: true,
      base: mergeBase.value,
      commit: tip.value,
      gitRef,
      upstream,
      upstreamCommit: currentUpstream.value,
      commits,
      changedPaths: rangePaths(cwd, commits),
    };
  } catch (error) {
    return { ok: false, reason: 'git_error', message: errorMessage(error) };
  }
}

export function validateStoredSubmissionRange(cwd: string, submissionValue: unknown) {
  const submission = isRecord(submissionValue) ? submissionValue : {};
  const range = submissionRange(cwd, {
    commit: submission.commit,
    gitRef: submission.gitRef,
    upstream: submission.upstream,
    upstreamCommit: submission.upstreamCommit,
    base: submission.base,
  });
  if (!range.ok) return range;
  const storedCommits = Array.isArray(submission.commits) ? submission.commits : [];
  if (storedCommits.length && JSON.stringify(storedCommits) !== JSON.stringify(range.commits)) {
    return Object.assign({ ok: false, reason: 'range_changed', storedCommits }, range);
  }
  const storedPaths = Array.isArray(submission.changedPaths) ? submission.changedPaths : [];
  if (storedPaths.length && JSON.stringify(storedPaths) !== JSON.stringify(range.changedPaths)) {
    return Object.assign({ ok: false, reason: 'changed_paths_changed', storedPaths }, range);
  }
  return range;
}

export function commitScoped(cwd: string, message: unknown, files: unknown) {
  const scopes = scopedPaths(files);
  if (!scopes.length) return { ok: false, reason: 'missing_scope' };
  try {
    const root = repoRoot(cwd);
    const resolution = validateScopeResolution(root, scopes);
    if (!resolution.ok) return resolution;
    const canonicalScopes = canonicalScopedPaths(root, scopes);
    const missingScopes = canonicalScopes.filter((scope) => !fs.existsSync(path.resolve(root, scope)));
    const commitScopes = existingScopedPaths(root, scopes);
    const unscopedPaths = unscopedWorkingPaths(root, scopes);
    if (!commitScopes.length) {
      return { ok: false, reason: 'no_existing_scope', missingScopes, unscopedPaths };
    }
    git(root, ['commit', '--only', '-m', String(message || ''), '--', ...commitScopes]);
    const commit = git(root, ['rev-parse', 'HEAD']).trim();
    const validation = validateCommitScope(root, commit, scopes);
    return Object.assign({ commit, missingScopes, unscopedPaths }, validation);
  } catch (error) {
    return { ok: false, reason: 'git_error', message: errorMessage(error) };
  }
}
