'use strict';

const { execFileSync } = require('child_process');

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

function commitPaths(cwd, commit) {
  return git(cwd, ['diff-tree', '--root', '--no-commit-id', '-r', '--name-only', '-z', commit])
    .split('\0')
    .filter(Boolean)
    .map((file) => file.replace(/\\/g, '/'));
}

function validateCommitScope(cwd, commit, files) {
  const scopes = scopedPaths(files);
  if (!scopes.length) return { ok: false, reason: 'missing_scope', paths: [], outside: [] };
  let paths;
  try {
    paths = commitPaths(cwd, commit);
  } catch (err) {
    return { ok: false, reason: 'git_error', paths: [], outside: [], message: err.message };
  }
  const outside = paths.filter((file) => !isInScope(file, scopes));
  return { ok: outside.length === 0, reason: outside.length ? 'outside_scope' : null, paths, outside };
}

function commitScoped(cwd, message, files) {
  const scopes = scopedPaths(files);
  if (!scopes.length) return { ok: false, reason: 'missing_scope' };
  try {
    const root = repoRoot(cwd);
    const canonicalScopes = canonicalScopedPaths(root, scopes);
    git(root, ['commit', '--only', '-m', String(message || ''), '--', ...canonicalScopes]);
    const commit = git(root, ['rev-parse', 'HEAD']).trim();
    const validation = validateCommitScope(root, commit, scopes);
    return Object.assign({ commit }, validation);
  } catch (err) {
    return { ok: false, reason: 'git_error', message: err.message };
  }
}

module.exports = { scopedPaths, isInScope, commitPaths, validateCommitScope, commitScoped };
