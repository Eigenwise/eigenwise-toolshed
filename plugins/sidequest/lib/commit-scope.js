'use strict';

const { execFileSync } = require('child_process');

function normalizeScope(scope) {
  return String(scope || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/\*\*$/, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

function scopedPaths(files) {
  return [...new Set((Array.isArray(files) ? files : []).map(normalizeScope).filter(Boolean))];
}

function isInScope(file, files) {
  const path = normalizeScope(file);
  return scopedPaths(files).some((scope) => path === scope || path.startsWith(`${scope}/`));
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
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
    git(cwd, ['commit', '--only', '-m', String(message || ''), '--', ...scopes]);
    const commit = git(cwd, ['rev-parse', 'HEAD']).trim();
    const validation = validateCommitScope(cwd, commit, scopes);
    return Object.assign({ commit }, validation);
  } catch (err) {
    return { ok: false, reason: 'git_error', message: err.message };
  }
}

module.exports = { scopedPaths, isInScope, commitPaths, validateCommitScope, commitScoped };
