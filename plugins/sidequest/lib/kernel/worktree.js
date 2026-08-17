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
  checkoutInstanceIdentity: () => checkoutInstanceIdentity,
  createCheckoutInstanceMarker: () => createCheckoutInstanceMarker,
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
var import_node_crypto = __toESM(require("node:crypto"));
const CHECKOUT_INSTANCE_MARKER = "sidequest-checkout-instance";
function checkoutInstanceDigest(token) {
  return import_node_crypto.default.createHash("sha256").update(token, "utf8").digest("hex");
}
function checkoutInstanceIdentity(gitDirectory) {
  try {
    const token = import_node_fs.default.readFileSync(import_node_path.default.join(gitDirectory, CHECKOUT_INSTANCE_MARKER), "utf8").trim();
    return /^[a-f0-9]{64}$/.test(token) ? checkoutInstanceDigest(token) : null;
  } catch {
    return null;
  }
}
function createCheckoutInstanceMarker(gitDirectory) {
  const token = import_node_crypto.default.randomBytes(32).toString("hex");
  import_node_fs.default.writeFileSync(import_node_path.default.join(gitDirectory, CHECKOUT_INSTANCE_MARKER), `${token}
`, {
    encoding: "utf8",
    flag: "wx",
    mode: 384
  });
  return checkoutInstanceDigest(token);
}
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
    sanctionedRevisions: Object.freeze((facts.sanctionedRevisions || []).map((revision) => String(revision).toLowerCase())),
    baselineAncestry: facts.baselineAncestry || "unknown",
    claimHeld: Boolean(facts.claimHeld),
    canonicalRepository: canonicalPath(facts.repository),
    canonicalGitDirectory: canonicalPath(facts.gitDirectory),
    canonicalCommonGitDirectory: canonicalPath(facts.commonGitDirectory),
    canonicalWorktree: facts.observedWorktree ? canonicalPath(facts.observedWorktree) : null,
    canonicalBoundWorktree: facts.boundWorktree ? canonicalPath(facts.boundWorktree) : null,
    canonicalBoundGitDirectory: facts.boundGitDirectory ? canonicalPath(facts.boundGitDirectory) : null,
    canonicalBoundCommonGitDirectory: facts.boundCommonGitDirectory ? canonicalPath(facts.boundCommonGitDirectory) : null,
    observedCheckoutInstance: checkoutInstanceIdentity(facts.gitDirectory)
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
function sanctionedRevision(lease, revision) {
  return Boolean(revision && (lease.sanctionedRevisions || []).includes(revision.toLowerCase()));
}
function shortRevision(revision) {
  return String(revision || "").slice(0, 12);
}
function revisionIsBaseline(lease) {
  return !lease.dispatchBaseline || !lease.observedRevision || lease.dispatchBaseline === lease.observedRevision;
}
function unsanctionedRevisionRefusal(lease, cause) {
  return denied(
    `${cause}; not a scope decision (baseline ${shortRevision(lease.dispatchBaseline)}, observed ${shortRevision(lease.observedRevision)}).`
  );
}
function creationBaselineDecision(lease) {
  if (revisionIsBaseline(lease)) return null;
  if (sanctionedRevision(lease, lease.observedRevision)) return null;
  return unsanctionedRevisionRefusal(lease, "this revision is not the dispatch baseline and was not sanctioned by the board for this claim");
}
function writeBaselineDecision(lease) {
  if (revisionIsBaseline(lease)) return null;
  if (sanctionedRevision(lease, lease.observedRevision)) return null;
  if (lease.baselineAncestry === "ancestor" && lease.claimHeld) return null;
  return unsanctionedRevisionRefusal(lease, writeBaselineCause(lease));
}
function writeBaselineCause(lease) {
  if (lease.baselineAncestry === "unrelated") {
    return "HEAD does not descend from the dispatch baseline, so this worktree left the history the board dispatched";
  }
  if (lease.baselineAncestry === "ancestor") {
    return "the claim that authorized this worktree is no longer held, so commits made under it no longer carry a write lease";
  }
  return "this revision was not sanctioned by the board for this claim and its descent from the dispatch baseline could not be read";
}
function boundRevisionDecision(lease) {
  if (!lease.boundRevision || !lease.observedRevision || lease.boundRevision === lease.observedRevision) return null;
  return denied(`bound worktree revision ${lease.boundRevision} differs from observed worktree revision ${lease.observedRevision}.`);
}
function repositoryDecision(lease) {
  if (lease.canonicalCommonGitDirectory !== canonicalPath(import_node_path.default.join(lease.canonicalRepository, ".git"))) {
    return denied("The observed worktree does not share the dispatch repository Git directory.");
  }
  if (lease.canonicalBoundWorktree && lease.canonicalBoundWorktree !== lease.canonicalWorktree) {
    return denied("The observed worktree differs from the dispatch-bound worktree.");
  }
  if (lease.canonicalBoundGitDirectory && lease.canonicalBoundGitDirectory !== lease.canonicalGitDirectory) {
    return denied("The observed worktree Git directory differs from the dispatch-bound Git directory.");
  }
  if (lease.canonicalBoundCommonGitDirectory && lease.canonicalBoundCommonGitDirectory !== lease.canonicalCommonGitDirectory) {
    return denied("The observed common Git directory differs from the dispatch-bound common Git directory.");
  }
  return null;
}
function checkoutInstanceDecision(lease) {
  if (lease.canonicalGitDirectory === lease.canonicalCommonGitDirectory) return null;
  if (!lease.boundCheckoutInstance) return denied("The dispatch-bound checkout instance is unavailable.");
  if (!lease.observedCheckoutInstance) return denied("The observed checkout instance is unavailable.");
  return lease.boundCheckoutInstance === lease.observedCheckoutInstance ? null : denied("The observed checkout instance differs from the dispatch-bound checkout instance.");
}
function worktreeCreateDecision(lease) {
  if (lease.identity.status === "unknown") return unknownIdentityDecision("Creation");
  if (lease.phase !== "prepared") return denied("Creation requires a prepared worktree lease.");
  if (!lease.dispatchRef) return denied("Creation requires a dispatch binding.");
  if (!lease.canonicalWorktree || !lease.canonicalBoundWorktree) return denied("Creation requires a bound worktree target.");
  return repositoryDecision(lease) || creationBaselineDecision(lease) || allowed("the prepared dispatch owns the bound worktree target.");
}
function worktreeWriteDecision(lease, target) {
  if (lease.identity.status === "unknown") return unknownIdentityDecision("A write");
  if (!lease.canonicalWorktree) return denied("A write requires an observed worktree.");
  if (!lease.canonicalBoundWorktree) return denied("A write requires an immutable worktree binding.");
  const repository = repositoryDecision(lease);
  if (repository) return repository;
  const checkoutInstance = checkoutInstanceDecision(lease);
  if (checkoutInstance) return checkoutInstance;
  const baseline = writeBaselineDecision(lease);
  if (baseline) return baseline;
  const relative = import_node_path.default.relative(lease.canonicalWorktree, canonicalPath(target));
  return relative === "" || !relative.startsWith("..") && !import_node_path.default.isAbsolute(relative) ? allowed("target belongs to the bound worktree.") : denied("target is outside the bound worktree.");
}
function worktreeResumeDecision(lease) {
  if (lease.identity.status === "unknown") return unknownIdentityDecision("Resume");
  if (!lease.canonicalWorktree) return denied("Resume requires an observed worktree.");
  return repositoryDecision(lease) || checkoutInstanceDecision(lease) || boundRevisionDecision(lease) || allowed("the bound worktree matches its release-time identity.");
}
function worktreeCleanupDecision(lease, registeredWorktrees) {
  if (lease.identity.status === "unknown") return unknownIdentityDecision("Cleanup");
  if (!lease.canonicalWorktree) return denied("Cleanup requires an observed worktree.");
  const repository = repositoryDecision(lease);
  if (repository) return repository;
  const checkoutInstance = checkoutInstanceDecision(lease);
  if (checkoutInstance) return checkoutInstance;
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
  checkoutInstanceIdentity,
  createCheckoutInstanceMarker,
  createWorktreeLease,
  isCanonicalRegisteredWorktree,
  sameCanonicalPath,
  worktreeCleanupDecision,
  worktreeCreateDecision,
  worktreeResumeDecision,
  worktreeWriteDecision
});
