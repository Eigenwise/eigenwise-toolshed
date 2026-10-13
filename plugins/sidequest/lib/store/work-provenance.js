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
var work_provenance_exports = {};
__export(work_provenance_exports, {
  WORK_KINDS: () => WORK_KINDS,
  authorizeWorkDeclaration: () => authorizeWorkDeclaration,
  ownedWorkPaths: () => ownedWorkPaths,
  prepareWorkProvenance: () => prepareWorkProvenance,
  provenanceAdmissionHold: () => provenanceAdmissionHold,
  workDeclaration: () => workDeclaration
});
module.exports = __toCommonJS(work_provenance_exports);
var import_node_crypto = require("node:crypto");
var import_node_child_process = require("node:child_process");
var import_node_fs = __toESM(require("node:fs"));
var import_node_path = __toESM(require("node:path"));
var import_commit_scope = require("../commit-scope");
const WORK_KINDS = ["new-behavior", "behavior-preserving-refactor", "inherited-read-only", "docs", "type-annotation-only", "fixture-only"];
function requireFact(valid, reason) {
  if (!valid) throw new Error(`work provenance refused: ${reason}`);
}
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function immutableCommit(value) {
  return typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
}
function sourceInput(value) {
  if (!record(value)) return false;
  return [
    text(value.ref),
    text(value.preparedAt),
    immutableCommit(value.commit),
    value.captureId === void 0 || text(value.captureId),
    Object.keys(value).every((field) => ["ref", "preparedAt", "commit", "captureId"].includes(field))
  ].every(Boolean);
}
function workDeclaration(value) {
  requireFact(record(value), "declaration must be an object");
  const kind = WORK_KINDS.find((candidate) => candidate === value.kind);
  requireFact(kind !== void 0, "unknown work kind");
  requireFact(Array.isArray(value.sources) && value.sources.length <= 20 && value.sources.every(sourceInput), "invalid bounded sources");
  requireFact(Object.keys(value).every((field) => ["kind", "sources"].includes(field)), "unknown declaration field");
  return { kind, sources: value.sources.map((source) => ({ ...source })) };
}
function authorizeWorkDeclaration(value, sessionId, granted, active) {
  if (value === void 0) return;
  requireFact(granted && text(sessionId), "main-thread MCP grant and runtime session required; actor labels grant nothing");
  requireFact(!active, "late declaration cannot change an existing prepared or executing generation");
}
function git(root, argumentsList) {
  return (0, import_node_child_process.execFileSync)("git", argumentsList, { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
}
function sha256(bytes) {
  return (0, import_node_crypto.createHash)("sha256").update(bytes).digest("hex");
}
function committedFile(root, commit, file) {
  const exists = git(root, ["ls-tree", "--name-only", commit, "--", file]).toString().trim();
  return { path: file, sha256: exists ? sha256(git(root, ["show", `${commit}:${file}`])) : null };
}
function sourceCommits(root, generation, input) {
  requireFact(immutableCommit(generation.baseCommit), "producer needs an immutable native base");
  git(root, ["merge-base", "--is-ancestor", generation.baseCommit, input.commit]);
  return git(root, ["rev-list", "--reverse", `${generation.baseCommit}..${input.commit}`]).toString().trim().split(/\r?\n/).filter(Boolean);
}
function requireSourceFacts(generation, input) {
  const fields = [
    "baseCommit",
    "declaredFiles",
    ...generation.outcome === "released" ? ["sanctionedCommits"] : [],
    ...input.captureId ? ["verificationRequirement", "tokenPrefix"] : []
  ];
  for (const field of fields) {
    requireFact(generation[field] != null, `producer generation ${input.preparedAt} missing ${field}`);
  }
}
function sourceGeneration(producer, input) {
  const dispatch = producer.dispatch;
  requireFact(dispatch !== void 0, "producer has no native generation");
  const { attempts = [] } = dispatch;
  const generation = [dispatch, ...attempts.slice().reverse()].find((candidate) => candidate.preparedAt === input.preparedAt);
  requireFact(generation !== void 0 && Boolean(generation.terminalAt), "producer generation mismatch");
  requireSourceFacts(generation, input);
  requireFact(
    generation === dispatch || generation.outcome !== "submitted" || generation.commit === producer.submission?.commit,
    `historical submitted generation ${input.preparedAt} candidate ${generation.commit} differs from current submission ${producer.submission?.commit}`
  );
  requireFact(!producer.claim?.by && !producer.dispatchNonce, "producer is still active");
  requireFact(["released", "submitted"].includes(generation.outcome), "producer must be released preparation or submitted source");
  return generation;
}
function sourceOwnership(producer, generation, input, commits) {
  const owned = generation.outcome === "submitted" ? producer.submission?.commits : generation.sanctionedCommits;
  requireFact(Boolean(owned?.includes(input.commit)) && commits.length > 0, "commit lacks native producer ownership");
  requireFact(commits.every((commit) => owned?.includes(commit) === true), "range includes work not owned by this producer");
  requireFact(generation.outcome !== "submitted" || producer.submission?.commit === input.commit, "submitted candidate mismatch");
}
function sourceCapture(producer, input) {
  if (!input.captureId) return;
  const capture = producer.verificationCaptures?.find((candidate) => candidate.id === input.captureId);
  requireFact(capture !== void 0, "capture identity is unavailable");
  requireFact(capture.candidate.source === "git" && capture.candidate.value === input.commit, "capture source mismatch");
  requireFact(Boolean(capture.command.trim()) && Boolean(capture.dispatchNonce), "capture needs command and nonce identities");
  compatibleSourceCapture(capture, sourceGeneration(producer, input));
  return capture;
}
function compatibleSourceCapture(capture, generation) {
  requireFact(capture.command === generation.verificationRequirement?.command, "capture command is incompatible with producer generation");
  requireFact(Boolean(generation.tokenPrefix) && capture.dispatchNonce.startsWith(String(generation.tokenPrefix)), "capture nonce is incompatible with producer generation");
  const completed = Date.parse(capture.completedAt);
  requireFact(completed >= Date.parse(generation.preparedAt) && completed <= Date.parse(String(generation.terminalAt)), "historical capture cannot be rebound to a different generation");
}
function observeSource(root, input, lookup) {
  const producer = lookup(input.ref);
  requireFact(producer !== null, "native producer is unavailable");
  const generation = sourceGeneration(producer, input);
  const commits = sourceCommits(root, generation, input);
  sourceOwnership(producer, generation, input, commits);
  const scope = (0, import_commit_scope.validateCommitRangeScope)(root, commits, (0, import_commit_scope.ticketCommitScope)(generation.declaredFiles, generation.declaredFiles, producer.ref));
  requireFact(scope.ok, "source range escapes native declared scope");
  return {
    input,
    producerId: producer.id,
    generation,
    status: generation.outcome === "submitted" ? "submitted-unaccepted" : "preparation-unaccepted",
    files: scope.paths.map((file) => committedFile(root, input.commit, file)),
    capture: sourceCapture(producer, input)
  };
}
function prepareWorkProvenance(root, declaration, sessionId, lookup) {
  if (!declaration) return;
  return structuredClone({
    kind: declaration.kind,
    authority: "main-thread-attestation",
    sessionId,
    execution: "UNVERIFIED",
    quality: "UNVERIFIED",
    admission: "UNVERIFIED",
    sources: declaration.sources.map((input) => observeSource(root, input, lookup))
  });
}
function workingFile(root, file) {
  const location = import_node_path.default.join(root, file.path);
  return { path: file.path, sha256: import_node_fs.default.existsSync(location) ? sha256(import_node_fs.default.readFileSync(location)) : null };
}
function unchangedSource(root, source, lookup) {
  requireFact(JSON.stringify(source) === JSON.stringify(observeSource(root, source.input, lookup)), "source generation or capture mutated");
  requireFact(source.files.every((file) => workingFile(root, file).sha256 === file.sha256), "source/test bytes are incompatible with frozen origin");
}
function ownedWorkPaths(root, provenance, paths, lookup) {
  if (!provenance) return [...paths];
  provenance.sources.forEach((source) => unchangedSource(root, source, lookup));
  const inherited = new Set(provenance.sources.flatMap((source) => source.files.map((file) => file.path)));
  const owned = paths.filter((file) => !inherited.has(file));
  requireFact(provenance.kind !== "inherited-read-only" || owned.every((file) => (0, import_commit_scope.isInScope)(file, [".release/unreleased/"])), "inherited-read-only declaration has new owned work");
  return owned;
}
function provenanceAdmissionHold(provenance) {
  if (!provenance) return;
  return { ok: false, reason: "work_provenance_unverified", message: "Frozen work provenance is a factual declaration only. Execution, quality and source admission remain UNVERIFIED; checkpoint and release preparation, never submit it as accepted work." };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  WORK_KINDS,
  authorizeWorkDeclaration,
  ownedWorkPaths,
  prepareWorkProvenance,
  provenanceAdmissionHold,
  workDeclaration
});
