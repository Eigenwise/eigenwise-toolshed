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
  retainedAttemptHistory: () => retainedAttemptHistory,
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
function git(root, argumentsList, input) {
  return (0, import_node_child_process.execFileSync)("git", argumentsList, { cwd: root, windowsHide: true, input, stdio: [input === void 0 ? "ignore" : "pipe", "pipe", "pipe"] });
}
function gitLines(root, argumentsList, input) {
  return git(root, argumentsList, input).toString().trim().split(/\r?\n/).filter(Boolean);
}
function gitSucceeds(root, argumentsList) {
  try {
    git(root, argumentsList);
    return true;
  } catch {
    return false;
  }
}
function gitLinesOrEmpty(root, argumentsList) {
  try {
    return gitLines(root, argumentsList);
  } catch {
    return [];
  }
}
function sha256(bytes) {
  return (0, import_node_crypto.createHash)("sha256").update(bytes).digest("hex");
}
function committedFile(root, commit, file) {
  const exists = git(root, ["ls-tree", "--name-only", commit, "--", file]).toString().trim();
  return { path: file, sha256: exists ? sha256(git(root, ["show", `${commit}:${file}`])) : null };
}
function wholeInheritedBranchTips(root, baseCommit, ownedInRange) {
  return gitLines(root, [
    "for-each-ref",
    "--format=%(objectname)",
    "--no-merged",
    baseCommit,
    ...ownedInRange.flatMap((commit) => ["--no-contains", commit]),
    "refs/heads",
    "refs/remotes"
  ]);
}
function sourceRange(root, generation, input, owned, recordedTips) {
  requireFact(immutableCommit(generation.baseCommit), "producer needs an immutable native base");
  git(root, ["merge-base", "--is-ancestor", generation.baseCommit, input.commit]);
  const range = gitLines(root, ["rev-list", "--reverse", "--parents", `${generation.baseCommit}..${input.commit}`]).map((line) => {
    const [commit = "", ...parents] = line.split(" ");
    return { commit, parents };
  });
  const commits = range.map((entry) => entry.commit);
  const exclusions = recordedTips ?? wholeInheritedBranchTips(root, generation.baseCommit, commits.filter((commit) => owned.includes(commit)));
  const authored = new Set(gitLines(root, ["rev-list", "--stdin"], [input.commit, `^${generation.baseCommit}`, ...exclusions.map((tip) => `^${tip}`), ""].join("\n")));
  const inherited = range.filter((entry) => !authored.has(entry.commit));
  return {
    authored: commits.filter((commit) => authored.has(commit)),
    inheritedTips: inherited.filter((entry) => !inherited.some((other) => other.parents.includes(entry.commit))).map((entry) => entry.commit)
  };
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
function missingFact(generation, fact) {
  return `producer generation ${generation.preparedAt} missing ${fact}`;
}
function generationCaptures(producer, generation) {
  const [from, to] = [Date.parse(generation.preparedAt), Date.parse(String(generation.terminalAt))];
  const prefix = String(generation.tokenPrefix || "");
  return (producer.verificationCaptures ?? []).filter((capture) => [
    capture.candidate.source === "git",
    immutableCommit(capture.candidate.value),
    String(capture.dispatchNonce).startsWith(prefix),
    Date.parse(capture.completedAt) >= from,
    Date.parse(capture.completedAt) <= to
  ].every(Boolean)).sort((left, right) => Date.parse(left.completedAt) - Date.parse(right.completedAt));
}
function derivedBaseCommit(root, generation, captures, integrationCommit) {
  if (generation.baseCommit) return { generation, derivedFacts: [] };
  const first = captures[0];
  requireFact(first !== void 0, `${missingFact(generation, "baseCommit")}; no verification capture in that generation records a git candidate to derive it from`);
  const candidate = first.candidate.value;
  const [baseCommit, ...otherBases] = gitLinesOrEmpty(root, ["merge-base", "--all", candidate, integrationCommit]);
  requireFact(
    baseCommit !== void 0 && otherBases.length === 0 && baseCommit !== candidate,
    `${missingFact(generation, "baseCommit")}; derivation is ambiguous: capture ${first.id} candidate ${candidate} is already on integration commit ${integrationCommit || "(unknown)"} or shares no single merge base with it`
  );
  return { generation: { ...generation, baseCommit }, derivedFacts: [{ fact: "baseCommit", derivedFrom: [`capture:${first.id}`], integrationCommit }] };
}
function derivedSanctionedCommits(root, derived, captures) {
  const { generation } = derived;
  if (generation.sanctionedCommits || generation.outcome !== "released") return derived;
  const owners = captures.filter((capture) => gitSucceeds(root, ["merge-base", "--is-ancestor", generation.baseCommit, capture.candidate.value]));
  requireFact(owners.length > 0, `${missingFact(generation, "sanctionedCommits")}; no verification capture in that generation records a git candidate descending from baseCommit ${generation.baseCommit}`);
  const sanctionedCommits = [...new Set(owners.flatMap((capture) => gitLinesOrEmpty(root, ["rev-list", "--reverse", `${generation.baseCommit}..${capture.candidate.value}`])))];
  return {
    generation: { ...generation, sanctionedCommits },
    derivedFacts: [...derived.derivedFacts, { fact: "sanctionedCommits", derivedFrom: owners.map((capture) => `capture:${capture.id}`) }]
  };
}
function derivedGeneration(root, producer, generation, input, integrationCommit) {
  const captures = generationCaptures(producer, generation);
  const derived = derivedSanctionedCommits(root, derivedBaseCommit(root, generation, captures, integrationCommit), captures);
  requireSourceFacts(derived.generation, input);
  return derived;
}
function retainedAttemptHistory(current) {
  const attempts = structuredClone([...current.attempts]);
  const terminalAttempt = attempts.find((attempt) => attempt.preparedAt === current.preparedAt);
  if (current.terminalAt && terminalAttempt) {
    Object.assign(terminalAttempt, structuredClone({
      baseCommit: current.baseCommit,
      declaredFiles: current.declaredFiles,
      sanctionedCommits: current.sanctionedCommits,
      verificationRequirement: current.verificationRequirement
    }));
  }
  return attempts;
}
function citedGenerations(producer, dispatch, consumerRef) {
  const attempts = dispatch.attempts ?? [];
  if (producer.ref === consumerRef) return retainedAttemptHistory({ ...dispatch, attempts }).reverse();
  requireFact(!producer.claim?.by && !producer.dispatchNonce, "producer is still active");
  return [dispatch, ...attempts.slice().reverse()];
}
function sourceGeneration(producer, input, consumerRef) {
  const dispatch = producer.dispatch;
  requireFact(dispatch !== void 0, "producer has no native generation");
  const generation = citedGenerations(producer, dispatch, consumerRef).find((candidate) => candidate.preparedAt === input.preparedAt);
  requireFact(generation !== void 0 && Boolean(generation.terminalAt), "producer generation mismatch");
  requireFact(
    generation === dispatch || generation.outcome !== "submitted" || generation.commit === producer.submission?.commit,
    `historical submitted generation ${input.preparedAt} candidate ${generation.commit} differs from current submission ${producer.submission?.commit}`
  );
  requireFact(["released", "submitted"].includes(generation.outcome), "producer must be released preparation or submitted source");
  return generation;
}
function ownedCommits(producer, generation) {
  return (generation.outcome === "submitted" ? producer.submission?.commits : generation.sanctionedCommits) ?? [];
}
function sourceOwnership(producer, generation, input, commits, owned) {
  requireFact(owned.includes(input.commit) && commits.length > 0, "commit lacks native producer ownership");
  requireFact(commits.every((commit) => owned.includes(commit)), "range includes work not owned by this producer");
  requireFact(generation.outcome !== "submitted" || producer.submission?.commit === input.commit, "submitted candidate mismatch");
}
function sourceCapture(producer, generation, input) {
  if (!input.captureId) return;
  const capture = producer.verificationCaptures?.find((candidate) => candidate.id === input.captureId);
  requireFact(capture !== void 0, "capture identity is unavailable");
  requireFact(capture.candidate.source === "git" && capture.candidate.value === input.commit, "capture source mismatch");
  requireFact(Boolean(capture.command.trim()) && Boolean(capture.dispatchNonce), "capture needs command and nonce identities");
  compatibleSourceCapture(capture, generation);
  return capture;
}
function compatibleSourceCapture(capture, generation) {
  requireFact(capture.command === generation.verificationRequirement?.command, "capture command is incompatible with producer generation");
  requireFact(Boolean(generation.tokenPrefix) && capture.dispatchNonce.startsWith(String(generation.tokenPrefix)), "capture nonce is incompatible with producer generation");
  const completed = Date.parse(capture.completedAt);
  requireFact(completed >= Date.parse(generation.preparedAt) && completed <= Date.parse(String(generation.terminalAt)), "historical capture cannot be rebound to a different generation");
}
function observeSource(root, input, lookup, integrationCommit, consumerRef, recordedTips) {
  const producer = lookup(input.ref);
  requireFact(producer !== null, "native producer is unavailable");
  const { generation, derivedFacts } = derivedGeneration(root, producer, sourceGeneration(producer, input, consumerRef), input, integrationCommit);
  const owned = ownedCommits(producer, generation);
  const { authored, inheritedTips } = sourceRange(root, generation, input, owned, recordedTips);
  sourceOwnership(producer, generation, input, authored, owned);
  const scope = (0, import_commit_scope.validateCommitRangeScope)(root, authored, (0, import_commit_scope.ticketCommitScope)(generation.declaredFiles, generation.declaredFiles, producer.ref));
  requireFact(scope.ok, "source range escapes native declared scope");
  return {
    input,
    producerId: producer.id,
    generation,
    ...inheritedTips.length ? { inheritedTips } : {},
    status: generation.outcome === "submitted" ? "submitted-unaccepted" : "preparation-unaccepted",
    files: scope.paths.map((file) => committedFile(root, input.commit, file)),
    capture: sourceCapture(producer, generation, input),
    ...derivedFacts.length ? { derivedFacts } : {}
  };
}
function prepareWorkProvenance(root, declaration, sessionId, lookup, integrationCommit = "", consumerRef = "") {
  if (!declaration) return;
  return structuredClone({
    kind: declaration.kind,
    authority: "main-thread-attestation",
    sessionId,
    execution: "UNVERIFIED",
    quality: "UNVERIFIED",
    admission: "UNVERIFIED",
    sources: declaration.sources.map((input) => observeSource(root, input, lookup, integrationCommit, consumerRef))
  });
}
function workingFile(root, file) {
  const location = import_node_path.default.join(root, file.path);
  return { path: file.path, sha256: import_node_fs.default.existsSync(location) ? sha256(import_node_fs.default.readFileSync(location)) : null };
}
function unchangedSource(root, source, lookup, consumerRef) {
  const derivedBase = source.derivedFacts?.find((fact) => fact.fact === "baseCommit");
  requireFact(JSON.stringify(source) === JSON.stringify(observeSource(root, source.input, lookup, derivedBase?.integrationCommit ?? "", consumerRef, source.inheritedTips ?? [])), "source generation or capture mutated");
  requireFact(source.files.every((file) => workingFile(root, file).sha256 === file.sha256), "source/test bytes are incompatible with frozen origin");
}
function ownedWorkPaths(root, provenance, paths, lookup, consumerRef = "") {
  if (!provenance) return [...paths];
  provenance.sources.forEach((source) => unchangedSource(root, source, lookup, consumerRef));
  const inherited = new Set(provenance.sources.flatMap((source) => source.files.map((file) => file.path)));
  const owned = paths.filter((file) => !inherited.has(file));
  requireFact(provenance.kind !== "inherited-read-only" || owned.every((file) => (0, import_commit_scope.isInScope)(file, [".release/unreleased/"])), "inherited-read-only declaration has new owned work");
  return owned;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  WORK_KINDS,
  authorizeWorkDeclaration,
  ownedWorkPaths,
  prepareWorkProvenance,
  retainedAttemptHistory,
  workDeclaration
});
