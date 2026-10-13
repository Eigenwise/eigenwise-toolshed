"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
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
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var composition_range_exports = {};
__export(composition_range_exports, {
  proveCompositionRange: () => proveCompositionRange
});
module.exports = __toCommonJS(composition_range_exports);
var import_node_child_process = require("node:child_process");
var import_commit_scope = require("../commit-scope");
function refuse(reason, message) {
  return { ok: false, reason, message };
}
function git(repository, arguments_) {
  return (0, import_node_child_process.execFileSync)("git", [...arguments_], {
    cwd: repository,
    encoding: "utf8",
    timeout: 3e4,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
}
function exactCommit(repository, commit) {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Composition requires full immutable commit identities.");
  const observed = git(repository, ["rev-parse", "--verify", `${commit}^{commit}`]).trim();
  if (observed !== commit) throw new Error("Composition commit identity changed during resolution.");
  return observed;
}
function commitsInRange(repository, base, candidate) {
  exactCommit(repository, base);
  exactCommit(repository, candidate);
  git(repository, ["merge-base", "--is-ancestor", base, candidate]);
  return git(repository, ["rev-list", "--reverse", `${base}..${candidate}`, "--"]).trim().split(/\r?\n/).filter(Boolean);
}
function sameMembers(left, right) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}
function completeSourceRange(repository, source) {
  const observed = commitsInRange(repository, source.base, source.commit);
  if (!observed.length) return refuse("source_range_missing", `${source.ref} has no submitted range.`);
  if (!sameMembers(observed, source.commits)) return refuse("stale_source", `${source.ref} no longer matches its complete immutable submitted range.`);
}
function sourceRangeRefusal(repository, sources) {
  for (const source of sources) {
    const failure = completeSourceRange(repository, source);
    if (failure) return failure;
  }
}
function accountingRefusal(commits, input) {
  const accounted = [...input.sources.flatMap((source) => [...source.commits]), ...input.ownCommits];
  if (new Set(accounted).size !== accounted.length) return refuse("duplicate_commit", "Each composition commit must be accounted exactly once.");
  if (!commits.length) return refuse("empty_range", "Composition must preserve nonempty work beyond the original base.");
  if (!sameMembers(commits, accounted)) return refuse("hidden_commit", "The full original BASE..candidate range must equal the complete pinned source ranges plus ownCommits.");
}
function cleanMergePaths(repository, commit, parents) {
  if (parents.length !== 2) throw new Error("Only a clean two-parent composition merge is supported.");
  const mergedTree = git(repository, ["merge-tree", "--write-tree", ...parents]).trim().split(/\r?\n/)[0];
  const candidateTree = git(repository, ["rev-parse", `${commit}^{tree}`]).trim();
  if (mergedTree !== candidateTree) throw new Error("A composition own merge contains changes beyond its clean parent merge.");
  return [];
}
function ownCommitPaths(repository, commit) {
  const parents = git(repository, ["show", "-s", "--format=%P", commit]).trim().split(" ").filter(Boolean);
  if (parents.length > 1) return cleanMergePaths(repository, commit, parents);
  return git(repository, ["diff-tree", "--root", "--no-renames", "--no-commit-id", "-r", "--name-only", "-z", commit]).split("\0").filter(Boolean);
}
function ownDeltaPaths(repository, commits) {
  try {
    return { ok: true, paths: [...new Set(commits.flatMap((commit) => ownCommitPaths(repository, commit)))].sort() };
  } catch (error) {
    return refuse("own_merge_unsupported", error instanceof Error ? error.message : String(error));
  }
}
function ownScopeRefusal(paths, input) {
  if (!sameMembers(paths, input.ownPaths)) return refuse("own_delta_mismatch", "ownPaths must exactly name every actual own change, including both sides of a rename.");
  if (!(0, import_commit_scope.validatePaths)(input.rootScope, [...paths]).ok) return refuse("own_delta_out_of_scope", "Composition own changes must remain within the original root scope.");
}
function proveOwnDelta(repository, commits, input) {
  const delta = ownDeltaPaths(repository, input.ownCommits);
  if (!delta.ok) return delta;
  const failure = ownScopeRefusal(delta.paths, input);
  if (failure) return failure;
  return { ok: true, commits, ownPaths: delta.paths };
}
function proveRange(repository, input) {
  const commits = commitsInRange(repository, input.base, input.candidate);
  const failure = sourceRangeRefusal(repository, input.sources) || accountingRefusal(commits, input);
  if (failure) return failure;
  return proveOwnDelta(repository, commits, input);
}
function proveCompositionRange(repository, input) {
  const scopes = (0, import_commit_scope.validateRelativeScopes)([...input.rootScope, ...input.ownPaths]);
  if (!scopes.ok) return refuse("own_delta_out_of_scope", "Composition paths and scope must be repository-relative.");
  try {
    return proveRange(repository, input);
  } catch (error) {
    return refuse("composition_git_error", error instanceof Error ? error.message : String(error));
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  proveCompositionRange
});
