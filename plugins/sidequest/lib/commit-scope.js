'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

function normalizeScope(scope) {
  return String(scope || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/\*\*$/, '')
    .replace(/\/+$/, '');
}

function scopeKey(scope) {
  const normalized = normalizeScope(scope);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function scopedPaths(files) {
  const paths = [];
  const seen = new Set();
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

function isInScope(file, files) {
  const path = scopeKey(file);
  return scopedPaths(files).some((scope) => {
    const key = scopeKey(scope);
    return path === key || path.startsWith(`${key}/`);
  });
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}

function gitResult(cwd, args) {
  try {
    return { ok: true, value: git(cwd, args).trim() };
  } catch (error) {
    return { ok: false, message: error.message };
  }
}

function repoRoot(cwd) {
  return git(cwd, ['rev-parse', '--show-toplevel']).trim();
}

function trackedPaths(cwd) {
  return git(cwd, ['ls-files', '--full-name', '-z'])
    .split('\0')
    .filter(Boolean)
    .map((file) => file.replace(/\\/g, '/'));
}

function canonicalScope(scope, paths) {
  const normalized = normalizeScope(scope);
  const key = scopeKey(normalized);
  const matchingPath = paths.find((file) => {
    const fileKey = scopeKey(file);
    return fileKey === key || fileKey.startsWith(`${key}/`);
  });
  return matchingPath ? matchingPath.slice(0, normalized.length) : normalized;
}

function canonicalScopedPaths(cwd, files) {
  const paths = trackedPaths(cwd);
  return scopedPaths(files).map((scope) => canonicalScope(scope, paths));
}

function validateScopeResolution(root, files) {
  const scopes = scopedPaths(files);
  if (!scopes.length) return { ok: false, reason: 'missing_scope', outside: [] };
  const outside = scopes.filter((scope) => {
    const relative = path.relative(root, path.resolve(root, scope));
    return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  });
  return { ok: outside.length === 0, reason: outside.length ? 'outside_scope' : null, outside };
}

function commitPaths(cwd, commit) {
  return git(cwd, ['diff-tree', '--root', '--no-commit-id', '-r', '--name-only', '-z', commit])
    .split('\0')
    .filter(Boolean)
    .map((file) => file.replace(/\\/g, '/'));
}

function rangePaths(cwd, commits) {
  const paths = [];
  const seen = new Set();
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

function validatePaths(files, paths) {
  const scopes = scopedPaths(files);
  if (!scopes.length) return { ok: false, reason: 'missing_scope', paths: [], outside: [] };
  const outside = paths.filter((file) => !isInScope(file, scopes));
  return { ok: outside.length === 0, reason: outside.length ? 'outside_scope' : null, paths, outside };
}

function validateCommitScope(cwd, commit, files) {
  try {
    return validatePaths(files, commitPaths(cwd, commit));
  } catch (err) {
    return { ok: false, reason: 'git_error', paths: [], outside: [], message: err.message };
  }
}

function validateCommitRangeScope(cwd, commits, files) {
  try {
    return validatePaths(files, rangePaths(cwd, commits));
  } catch (err) {
    return { ok: false, reason: 'git_error', paths: [], outside: [], message: err.message };
  }
}

function resolvedCommit(cwd, name) {
  return gitResult(cwd, ['rev-parse', '--verify', `${name}^{commit}`]);
}

function isAncestor(cwd, ancestor, descendant) {
  try {
    git(cwd, ['merge-base', '--is-ancestor', ancestor, descendant]);
    return true;
  } catch (_) {
    return false;
  }
}

function submissionRange(cwd, opts) {
  opts = opts || {};
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
  if (!mergeBase.ok || !mergeBase.value) return { ok: false, reason: 'unrelated_history', upstream, tip: tip.value, message: mergeBase.message };
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
    return { ok: false, reason: 'git_error', message: error.message };
  }
}

function validateStoredSubmissionRange(cwd, submission) {
  const range = submissionRange(cwd, {
    commit: submission && submission.commit,
    gitRef: submission && submission.gitRef,
    upstream: submission && submission.upstream,
    upstreamCommit: submission && submission.upstreamCommit,
    base: submission && submission.base,
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

function commitScoped(cwd, message, files) {
  const scopes = scopedPaths(files);
  if (!scopes.length) return { ok: false, reason: 'missing_scope' };
  try {
    const root = repoRoot(cwd);
    const resolution = validateScopeResolution(root, scopes);
    if (!resolution.ok) return resolution;
    const canonicalScopes = canonicalScopedPaths(root, scopes);
    git(root, ['commit', '--only', '-m', String(message || ''), '--', ...canonicalScopes]);
    const commit = git(root, ['rev-parse', 'HEAD']).trim();
    const validation = validateCommitScope(root, commit, scopes);
    return Object.assign({ commit }, validation);
  } catch (err) {
    return { ok: false, reason: 'git_error', message: err.message };
  }
}

module.exports = {
  scopedPaths,
  isInScope,
  commitPaths,
  rangePaths,
  validateCommitScope,
  validateCommitRangeScope,
  submissionRange,
  validateStoredSubmissionRange,
  validateScopeResolution,
  repoRoot,
  commitScoped,
};
