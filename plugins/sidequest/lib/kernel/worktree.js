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
var worktree_exports = {};
__export(worktree_exports, {
  canonicalPath: () => canonicalPath,
  createWorktreeLease: () => createWorktreeLease,
  isCanonicalRegisteredWorktree: () => isCanonicalRegisteredWorktree,
  sameCanonicalPath: () => sameCanonicalPath,
  worktreeCleanupDecision: () => worktreeCleanupDecision,
  worktreeCreateDecision: () => worktreeCreateDecision,
  worktreeResumeDecision: () => worktreeResumeDecision,
  worktreeWriteDecision: () => worktreeWriteDecision
});
module.exports = __toCommonJS(worktree_exports);
var import_node_fs = __toESM(require("node:fs"));
var import_node_path = __toESM(require("node:path"));
function platformPath(value) {
  return process.platform === "win32" ? value.toLowerCase() : value;
}
function canonicalPath(value) {
  const gitBashDrive = process.platform === "win32" ? /^\/([a-zA-Z])(?=\/|$)/.exec(value) : null;
  const resolved = import_node_path.default.resolve(gitBashDrive ? `${gitBashDrive[1]}:${value.slice(2)}` : value);
  const missing = [];
  let existing = resolved;
  while (!import_node_fs.default.existsSync(existing)) {
    const parent = import_node_path.default.dirname(existing);
    if (parent === existing) return platformPath(resolved);
    missing.unshift(import_node_path.default.basename(existing));
    existing = parent;
  }
  try {
    return platformPath(import_node_path.default.join(import_node_fs.default.realpathSync.native(existing), ...missing));
  } catch {
    return platformPath(resolved);
  }
}
function sameCanonicalPath(left, right) {
  return canonicalPath(left) === canonicalPath(right);
}
function createWorktreeLease(facts) {
  return Object.freeze({
    ...facts,
    identity: Object.freeze({ ...facts.identity }),
    liveness: Object.freeze({ ...facts.liveness }),
    canonicalRepository: canonicalPath(facts.repository),
    canonicalGitDirectory: canonicalPath(facts.gitDirectory),
    canonicalCommonGitDirectory: canonicalPath(facts.commonGitDirectory),
    canonicalWorktree: facts.observedWorktree ? canonicalPath(facts.observedWorktree) : null,
    canonicalBoundWorktree: facts.boundWorktree ? canonicalPath(facts.boundWorktree) : null
  });
}
function denied(reason) {
  return Object.freeze({ allowed: false, reason });
}
function allowed(reason) {
  return Object.freeze({ allowed: true, reason });
}
function unknownIdentityDecision(operation) {
  return denied(`${operation} requires a bound worktree identity.`);
}
function incorrectBaselineDecision(lease) {
  if (!lease.dispatchBaseline || !lease.observedRevision || lease.dispatchBaseline === lease.observedRevision) return null;
  return denied(`dispatch baseline ${lease.dispatchBaseline} differs from observed worktree revision ${lease.observedRevision}.`);
}
function repositoryDecision(lease) {
  if (lease.canonicalCommonGitDirectory !== canonicalPath(import_node_path.default.join(lease.canonicalRepository, ".git"))) {
    return denied("The observed worktree does not share the dispatch repository Git directory.");
  }
  if (lease.canonicalBoundWorktree && lease.canonicalBoundWorktree !== lease.canonicalWorktree) {
    return denied("The observed worktree differs from the dispatch-bound worktree.");
  }
  return null;
}
function worktreeCreateDecision(lease) {
  if (!lease.canonicalWorktree) return denied("Creation requires an observed worktree.");
  return repositoryDecision(lease) || incorrectBaselineDecision(lease) || allowed("the observed worktree belongs to the dispatch repository.");
}
function worktreeWriteDecision(lease, target) {
  if (lease.identity.status === "unknown") return unknownIdentityDecision("A write");
  if (!lease.canonicalWorktree) return denied("A write requires an observed worktree.");
  const repository = repositoryDecision(lease);
  if (repository) return repository;
  const baseline = incorrectBaselineDecision(lease);
  if (baseline) return baseline;
  const relative = import_node_path.default.relative(lease.canonicalWorktree, canonicalPath(target));
  return relative === "" || !relative.startsWith("..") && !import_node_path.default.isAbsolute(relative) ? allowed("target belongs to the bound worktree.") : denied("target is outside the bound worktree.");
}
function worktreeResumeDecision(lease) {
  if (lease.identity.status === "unknown") return unknownIdentityDecision("Resume");
  if (!lease.canonicalWorktree) return denied("Resume requires an observed worktree.");
  return repositoryDecision(lease) || incorrectBaselineDecision(lease) || allowed("the bound worktree matches the dispatch baseline.");
}
function worktreeCleanupDecision(lease, registeredWorktrees) {
  if (lease.identity.status === "unknown") return unknownIdentityDecision("Cleanup");
  if (!lease.canonicalWorktree) return denied("Cleanup requires an observed worktree.");
  if (!registeredWorktrees.some((registered) => sameCanonicalPath(registered, lease.canonicalWorktree))) return denied("Cleanup requires a canonical registered worktree.");
  if (lease.phase !== "terminal" && lease.phase !== "integrated") return denied("Cleanup requires a terminal lease phase.");
  if (lease.locked) return denied("Cleanup refuses a locked worktree.");
  if (lease.liveness.status !== "terminal") return denied("Cleanup requires proven terminal liveness.");
  if (lease.provisioning === "unknown") return denied("Cleanup refuses an unknown provisioning strategy.");
  return allowed("the terminal bound worktree is safe to clean.");
}
function isCanonicalRegisteredWorktree(lease, registeredWorktrees) {
  return Boolean(lease.canonicalWorktree) && registeredWorktrees.some((registered) => sameCanonicalPath(registered, lease.canonicalWorktree));
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  canonicalPath,
  createWorktreeLease,
  isCanonicalRegisteredWorktree,
  sameCanonicalPath,
  worktreeCleanupDecision,
  worktreeCreateDecision,
  worktreeResumeDecision,
  worktreeWriteDecision
});
