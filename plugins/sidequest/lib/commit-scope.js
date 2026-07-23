"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var commit_scope_exports = {};
__export(commit_scope_exports, {
  commitPaths: () => commitPaths,
  commitScoped: () => commitScoped,
  isInScope: () => isInScope,
  rangePaths: () => rangePaths,
  repoRoot: () => repoRoot,
  scopedPaths: () => scopedPaths,
  submissionRange: () => submissionRange,
  unscopedWorkingPaths: () => unscopedWorkingPaths,
  validateCommitRangeScope: () => validateCommitRangeScope,
  validateCommitScope: () => validateCommitScope,
  validateRelativeScopes: () => validateRelativeScopes,
  validateScopeResolution: () => validateScopeResolution,
  validateStoredSubmissionRange: () => validateStoredSubmissionRange,
  workingPaths: () => workingPaths
});
module.exports = __toCommonJS(commit_scope_exports);
var import_node_child_process = require("node:child_process");
var import_node_fs = __toESM(require("node:fs"));
var import_node_path = __toESM(require("node:path"));
function isRecord(value) {
  return value !== null && typeof value === "object";
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function normalizeScope(scope) {
  return String(scope || "").trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/\*\*$/, "").replace(/\/+$/, "");
}
function scopeKey(scope) {
  const normalized = normalizeScope(scope);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
function scopedPaths(files) {
  const paths = [];
  const seen = /* @__PURE__ */ new Set();
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
  const filePath = scopeKey(file);
  return scopedPaths(files).some((scope) => {
    const key = scopeKey(scope);
    return filePath === key || filePath.startsWith(`${key}/`);
  });
}
function git(cwd, args) {
  return (0, import_node_child_process.execFileSync)("git", args, { cwd, encoding: "utf8", windowsHide: true });
}
function gitResult(cwd, args) {
  try {
    return { ok: true, value: git(cwd, args).trim() };
  } catch (error) {
    return { ok: false, message: errorMessage(error) };
  }
}
function repoRoot(cwd) {
  return git(cwd, ["rev-parse", "--show-toplevel"]).trim();
}
function indexedPaths(cwd) {
  return git(cwd, ["ls-files", "--full-name", "-z"]).split("\0").filter(Boolean).map((file) => file.replace(/\\/g, "/"));
}
function trackedPaths(cwd) {
  const paths = indexedPaths(cwd);
  const head = gitResult(cwd, ["ls-tree", "-r", "--name-only", "-z", "HEAD"]);
  if (!head.ok) return paths;
  const seen = new Set(paths.map(scopeKey));
  for (const file of head.value.split("\0").filter(Boolean).map((entry) => entry.replace(/\\/g, "/"))) {
    if (!seen.has(scopeKey(file))) {
      seen.add(scopeKey(file));
      paths.push(file);
    }
  }
  return paths;
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
function commitScopedPaths(root, scopes) {
  const tracked = trackedPaths(root);
  return scopes.filter((scope) => import_node_fs.default.existsSync(import_node_path.default.resolve(root, scope)) || tracked.some((file) => isInScope(file, [scope])));
}
function stageableScopedPaths(root, scopes) {
  const indexed = indexedPaths(root);
  return scopes.filter((scope) => import_node_fs.default.existsSync(import_node_path.default.resolve(root, scope)) || indexed.some((file) => isInScope(file, [scope])));
}
function workingPaths(cwd) {
  const status = git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const entries = status.split("\0");
  const paths = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (!entry) continue;
    const state = entry.slice(0, 2);
    const file = entry.slice(3).replace(/\\/g, "/");
    if (file) paths.push(file);
    if (state.includes("R") || state.includes("C")) {
      const previous = entries[++index];
      if (previous) paths.push(previous.replace(/\\/g, "/"));
    }
  }
  return Array.from(new Set(paths));
}
function unscopedWorkingPaths(cwd, files) {
  return workingPaths(cwd).filter((file) => !isInScope(file, files));
}
function pathKey(value) {
  const normalized = import_node_path.default.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
function relativeScopeOutside(scope) {
  const raw = String(scope || "").trim();
  const parts = raw.replace(/\\/g, "/").split("/");
  return import_node_path.default.isAbsolute(raw) || import_node_path.default.win32.isAbsolute(raw) || import_node_path.default.posix.isAbsolute(raw) || /^[a-z]:/i.test(raw) || parts.includes("..");
}
function repoRelativePath(root, target) {
  return import_node_path.default.relative(root, target).replace(/\\/g, "/") || ".";
}
function inspectExistingPath(root, realRoot, target, inspectDescendants) {
  const relative = import_node_path.default.relative(root, target);
  const parts = relative ? relative.split(import_node_path.default.sep) : [];
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    current = import_node_path.default.join(current, parts[index]);
    let stat;
    try {
      stat = import_node_fs.default.lstatSync(current);
    } catch (error) {
      if (error && error.code === "ENOENT") return { ok: true, indirect: [] };
      return { ok: false, reason: "scope_unavailable", indirect: [repoRelativePath(root, current)] };
    }
    if (stat.isSymbolicLink()) {
      return { ok: false, reason: "filesystem_indirection", indirect: [repoRelativePath(root, current)] };
    }
    try {
      const expected = import_node_path.default.join(realRoot, ...parts.slice(0, index + 1));
      if (pathKey(import_node_fs.default.realpathSync.native(current)) !== pathKey(expected)) {
        return { ok: false, reason: "filesystem_indirection", indirect: [repoRelativePath(root, current)] };
      }
    } catch {
      return { ok: false, reason: "scope_unavailable", indirect: [repoRelativePath(root, current)] };
    }
  }
  if (!inspectDescendants || !import_node_fs.default.existsSync(target)) return { ok: true, indirect: [] };
  const pending = [target];
  while (pending.length) {
    const currentPath = pending.pop();
    let stat;
    try {
      stat = import_node_fs.default.lstatSync(currentPath);
      const expected = import_node_path.default.join(realRoot, import_node_path.default.relative(root, currentPath));
      if (stat.isSymbolicLink() || pathKey(import_node_fs.default.realpathSync.native(currentPath)) !== pathKey(expected)) {
        return { ok: false, reason: "filesystem_indirection", indirect: [repoRelativePath(root, currentPath)] };
      }
      if (stat.isDirectory()) {
        for (const entry of import_node_fs.default.readdirSync(currentPath)) pending.push(import_node_path.default.join(currentPath, entry));
      }
    } catch {
      return { ok: false, reason: "scope_unavailable", indirect: [repoRelativePath(root, currentPath)] };
    }
  }
  return { ok: true, indirect: [] };
}
function validateRelativeScopes(files) {
  const scopes = scopedPaths(files);
  if (!scopes.length) return { ok: false, reason: "missing_scope", outside: [] };
  const outside = scopes.filter(relativeScopeOutside);
  return { ok: outside.length === 0, reason: outside.length ? "outside_scope" : null, outside };
}
function validateScopeResolution(root, files, opts) {
  const relativeValidation = validateRelativeScopes(files);
  const scopes = scopedPaths(files);
  if (!relativeValidation.ok) {
    return { ...relativeValidation, indirect: [] };
  }
  const resolvedRoot = import_node_path.default.resolve(root);
  const outside = scopes.filter((scope) => {
    const relative = import_node_path.default.relative(resolvedRoot, import_node_path.default.resolve(resolvedRoot, ...scope.split("/")));
    return relative === ".." || relative.startsWith(`..${import_node_path.default.sep}`) || import_node_path.default.isAbsolute(relative);
  });
  if (outside.length) return { ok: false, reason: "outside_scope", outside, indirect: [] };
  let realRoot;
  try {
    realRoot = import_node_fs.default.realpathSync.native(resolvedRoot);
  } catch {
    return { ok: false, reason: "scope_unavailable", outside: scopes, indirect: [] };
  }
  for (const scope of scopes) {
    const target = import_node_path.default.resolve(resolvedRoot, ...scope.split("/"));
    const inspected = inspectExistingPath(resolvedRoot, realRoot, target, opts?.inspectDescendants === true);
    if (!inspected.ok) {
      return { ok: false, reason: inspected.reason, outside: [], indirect: inspected.indirect };
    }
  }
  return { ok: true, reason: null, outside: [], indirect: [] };
}
function commitPaths(cwd, commit) {
  return git(cwd, ["diff-tree", "--root", "--no-commit-id", "-r", "--name-only", "-z", commit]).split("\0").filter(Boolean).map((file) => file.replace(/\\/g, "/"));
}
function rangePaths(cwd, commits) {
  const paths = [];
  const seen = /* @__PURE__ */ new Set();
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
  if (!scopes.length) return { ok: false, reason: "missing_scope", paths: [], outside: [] };
  const outside = paths.filter((file) => !isInScope(file, scopes));
  return { ok: outside.length === 0, reason: outside.length ? "outside_scope" : null, paths, outside };
}
function validateCommitScope(cwd, commit, files) {
  try {
    return validatePaths(files, commitPaths(cwd, commit));
  } catch (error) {
    return { ok: false, reason: "git_error", paths: [], outside: [], message: errorMessage(error) };
  }
}
function validateCommitRangeScope(cwd, commits, files) {
  try {
    return validatePaths(files, rangePaths(cwd, commits));
  } catch (error) {
    return { ok: false, reason: "git_error", paths: [], outside: [], message: errorMessage(error) };
  }
}
function resolvedCommit(cwd, name) {
  return gitResult(cwd, ["rev-parse", "--verify", `${String(name || "").trim()}^{commit}`]);
}
function isAncestor(cwd, ancestor, descendant) {
  try {
    git(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}
function submissionRange(cwd, options) {
  const opts = isRecord(options) ? options : {};
  const gitRef = String(opts.gitRef || "").trim();
  const upstream = String(opts.upstream || "origin/main").trim();
  const tipName = String(opts.commit || "").trim();
  if (!gitRef) return { ok: false, reason: "missing_git_ref" };
  const tip = resolvedCommit(cwd, tipName);
  if (!tip.ok) return { ok: false, reason: "missing_commit", message: tip.message };
  const refTip = resolvedCommit(cwd, gitRef);
  if (!refTip.ok) return { ok: false, reason: "missing_git_ref", message: refTip.message };
  if (tip.value !== refTip.value) return { ok: false, reason: "tip_mismatch", tip: tip.value, refTip: refTip.value, gitRef };
  const currentUpstream = resolvedCommit(cwd, upstream);
  if (!currentUpstream.ok) return { ok: false, reason: "missing_upstream", upstream, message: currentUpstream.message };
  const recordedUpstream = opts.upstreamCommit ? resolvedCommit(cwd, opts.upstreamCommit) : null;
  if (recordedUpstream && !recordedUpstream.ok) return { ok: false, reason: "missing_recorded_upstream", message: recordedUpstream.message };
  if (recordedUpstream && !isAncestor(cwd, recordedUpstream.value, currentUpstream.value)) {
    return { ok: false, reason: "expected_upstream_diverged", upstream, upstreamCommit: recordedUpstream.value, currentUpstream: currentUpstream.value };
  }
  const mergeBase = gitResult(cwd, ["merge-base", currentUpstream.value, tip.value]);
  if (!mergeBase.ok || !mergeBase.value) return { ok: false, reason: "unrelated_history", upstream, tip: tip.value, message: mergeBase.ok ? void 0 : mergeBase.message };
  const requestedBase = opts.base ? resolvedCommit(cwd, opts.base) : null;
  if (requestedBase && !requestedBase.ok) return { ok: false, reason: "missing_base", message: requestedBase.message };
  const integrationBranch = requestedBase ? resolvedCommit(cwd, opts.integrationBranch || upstream) : null;
  const baseIsOnTip = !!requestedBase && isAncestor(cwd, requestedBase.value, tip.value);
  const baseIsAfterMergeBase = !!requestedBase && isAncestor(cwd, mergeBase.value, requestedBase.value);
  const baseIsIntegrated = !!requestedBase && !!integrationBranch?.ok && isAncestor(cwd, requestedBase.value, integrationBranch.value);
  if (requestedBase && (!baseIsOnTip || !baseIsAfterMergeBase && !baseIsIntegrated)) {
    return { ok: false, reason: "base_not_reachable", base: requestedBase.value, actualBase: mergeBase.value, upstream, tip: tip.value };
  }
  const allowedBaseNames = Array.isArray(opts.allowedBases) ? opts.allowedBases : null;
  if (requestedBase && requestedBase.value !== mergeBase.value && allowedBaseNames) {
    const allowedBases = new Set(allowedBaseNames.map((name) => resolvedCommit(cwd, name)).filter((candidate) => candidate.ok).map((candidate) => candidate.value));
    if (!baseIsIntegrated && !allowedBases.has(requestedBase.value)) {
      return {
        ok: false,
        reason: "unrecognized_base",
        base: requestedBase.value,
        actualBase: mergeBase.value,
        upstream,
        tip: tip.value,
        message: "explicit base must be on the integration branch or match a validated submitted ticket boundary"
      };
    }
  }
  let effectiveBase = requestedBase ? requestedBase.value : mergeBase.value;
  if (!requestedBase && Array.isArray(opts.baseCandidates) && opts.baseCandidates.length) {
    const candidates = /* @__PURE__ */ new Set();
    for (const name of opts.baseCandidates) {
      const candidate = resolvedCommit(cwd, name);
      if (candidate.ok && isAncestor(cwd, mergeBase.value, candidate.value) && isAncestor(cwd, candidate.value, tip.value)) {
        candidates.add(candidate.value);
      }
    }
    if (candidates.size) {
      const history = gitResult(cwd, ["rev-list", "--reverse", `${mergeBase.value}..${tip.value}`]);
      if (!history.ok) return { ok: false, reason: "git_error", message: history.message };
      for (const commit of history.value.split(/\r?\n/).filter(Boolean)) {
        if (candidates.has(commit)) effectiveBase = commit;
      }
    }
  }
  const commitList = gitResult(cwd, ["rev-list", "--reverse", `${effectiveBase}..${tip.value}`]);
  if (!commitList.ok) return { ok: false, reason: "git_error", message: commitList.message };
  const commits = commitList.value ? commitList.value.split(/\r?\n/).filter(Boolean) : [];
  if (!commits.length) return { ok: false, reason: "empty_range", base: effectiveBase, tip: tip.value };
  const parents = gitResult(cwd, ["rev-list", "--parents", `${effectiveBase}..${tip.value}`]);
  if (!parents.ok) return { ok: false, reason: "git_error", message: parents.message };
  const mergeCommit = parents.value.split(/\r?\n/).find((line) => line.trim().split(/\s+/).length > 2);
  if (mergeCommit) return { ok: false, reason: "merge_commit", commit: mergeCommit.trim().split(/\s+/)[0] };
  try {
    return {
      ok: true,
      base: effectiveBase,
      commit: tip.value,
      gitRef,
      upstream,
      upstreamCommit: currentUpstream.value,
      commits,
      changedPaths: rangePaths(cwd, commits)
    };
  } catch (error) {
    return { ok: false, reason: "git_error", message: errorMessage(error) };
  }
}
function validateStoredSubmissionRange(cwd, submissionValue) {
  const submission = isRecord(submissionValue) ? submissionValue : {};
  const range = submissionRange(cwd, {
    commit: submission.commit,
    gitRef: submission.gitRef,
    upstream: submission.upstream,
    upstreamCommit: submission.upstreamCommit,
    base: submission.base
  });
  if (!range.ok) return range;
  const storedCommits = Array.isArray(submission.commits) ? submission.commits : [];
  if (storedCommits.length && JSON.stringify(storedCommits) !== JSON.stringify(range.commits)) {
    return Object.assign({ ok: false, reason: "range_changed", storedCommits }, range);
  }
  const storedPaths = Array.isArray(submission.changedPaths) ? submission.changedPaths : [];
  if (storedPaths.length && JSON.stringify(storedPaths) !== JSON.stringify(range.changedPaths)) {
    return Object.assign({ ok: false, reason: "changed_paths_changed", storedPaths }, range);
  }
  return range;
}
function commitScoped(cwd, message, files) {
  const scopes = scopedPaths(files);
  if (!scopes.length) return { ok: false, reason: "missing_scope" };
  try {
    const root = repoRoot(cwd);
    const resolution = validateScopeResolution(root, scopes);
    if (!resolution.ok) return resolution;
    const canonicalScopes = canonicalScopedPaths(root, scopes);
    const commitScopes = commitScopedPaths(root, canonicalScopes);
    const missingScopes = canonicalScopes.filter((scope) => !commitScopes.includes(scope));
    const unscopedPaths = unscopedWorkingPaths(root, scopes);
    if (!commitScopes.length) {
      return { ok: false, reason: "no_existing_scope", missingScopes, unscopedPaths };
    }
    const stageableScopes = stageableScopedPaths(root, commitScopes);
    if (stageableScopes.length) git(root, ["add", "--all", "--", ...stageableScopes]);
    git(root, ["commit", "--only", "-m", String(message || ""), "--", ...commitScopes]);
    const commit = git(root, ["rev-parse", "HEAD"]).trim();
    const validation = validateCommitScope(root, commit, scopes);
    return Object.assign({ commit, missingScopes, unscopedPaths }, validation);
  } catch (error) {
    return { ok: false, reason: "git_error", message: errorMessage(error) };
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  commitPaths,
  commitScoped,
  isInScope,
  rangePaths,
  repoRoot,
  scopedPaths,
  submissionRange,
  unscopedWorkingPaths,
  validateCommitRangeScope,
  validateCommitScope,
  validateRelativeScopes,
  validateScopeResolution,
  validateStoredSubmissionRange,
  workingPaths
});
