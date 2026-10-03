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
var sync_check_exports = {};
__export(sync_check_exports, {
  SYNC_CHECK_RESULT: () => SYNC_CHECK_RESULT,
  retainedSyncCheckStep: () => retainedSyncCheckStep,
  syncCheck: () => syncCheck,
  syncCheckCommand: () => syncCheckCommand
});
module.exports = __toCommonJS(sync_check_exports);
var import_node_fs = __toESM(require("node:fs"));
var import_git_process = require("./git-process");
const UNMERGED_CODES = /* @__PURE__ */ new Set(["UU", "AA", "DU", "UD", "AU", "UA", "DD"]);
const SYNC_CHECK_RESULT = "It prints one line and exits 0 for `sync-check: ok (...)` or 1 for `sync-check: FAILED <reason> (...)`; run it on its own and read that line, because no `; echo $?` is needed.";
function syncCheckCommand(quotedLauncher, commit, flags = "") {
  return "`" + ["node", quotedLauncher, "sync-check", commit + flags].join(" ") + "`";
}
function retainedSyncCheckStep(quotedLauncher, commit, retainedCommit) {
  return [
    "run " + syncCheckCommand(quotedLauncher, commit, " --head " + retainedCommit + " --retained") + ".",
    "It requires HEAD to be " + retainedCommit + " and `git status --porcelain` to still list the retained changes with no unmerged entries, and only then tests base ancestry.",
    SYNC_CHECK_RESULT,
    "If it reports `FAILED head-mismatch`, `retained-changes-missing` or `unmerged`, stop and report that this checkout is not the retained candidate."
  ].join(" ");
}
const short = (sha) => sha.slice(0, 7);
const failed = (reason, detail) => ({ ok: false, line: `sync-check: FAILED ${reason} (${detail})` });
function resolveCommit(cwd, revision) {
  if (!revision || revision.startsWith("-")) return "";
  try {
    return (0, import_git_process.execFileSync)("git", ["rev-parse", "--verify", "--quiet", `${revision}^{commit}`], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch (_) {
    return "";
  }
}
function porcelainCodes(cwd) {
  const output = (0, import_git_process.execFileSync)("git", ["status", "--porcelain"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return output.split("\n").filter(Boolean).map((entry) => entry.slice(0, 2));
}
function ancestry(cwd, base, head) {
  try {
    (0, import_git_process.execFileSync)("git", ["merge-base", "--is-ancestor", base, head], { cwd, stdio: "ignore" });
    return "ancestor";
  } catch (error) {
    return error.status === 1 ? "unrelated" : "unknown";
  }
}
function headProblem({ input, cwd, head }) {
  if (!input.head) return null;
  const wanted = resolveCommit(cwd, input.head);
  return wanted === head ? null : failed("head-mismatch", `HEAD is ${short(head)}, expected ${wanted ? short(wanted) : input.head}`);
}
function retainedProblem({ input, cwd }) {
  if (!input.retained) return null;
  const codes = porcelainCodes(cwd);
  if (!codes.length) return failed("retained-changes-missing", "git status --porcelain lists no changes, so this is not the retained candidate");
  return codes.some((code) => UNMERGED_CODES.has(code)) ? failed("unmerged", "git status --porcelain lists unmerged entries") : null;
}
function ancestryProblem({ cwd, head, base }) {
  const relation = ancestry(cwd, base, head);
  if (relation === "unknown") return failed("unreadable", "git merge-base could not run");
  return relation === "unrelated" ? failed("not-ancestor", `${short(base)} is not an ancestor of HEAD ${short(head)}`) : null;
}
const CHECKS = [headProblem, retainedProblem, ancestryProblem];
function gatherFacts(input) {
  const cwd = input.worktree || process.cwd();
  if (!import_node_fs.default.existsSync(cwd)) return failed("no-worktree", `${cwd} does not exist`);
  const head = resolveCommit(cwd, "HEAD");
  if (!head) return failed("not-a-worktree", `${cwd} has no resolvable HEAD`);
  const base = resolveCommit(cwd, input.commit);
  return base ? { input, cwd, head, base } : failed("unknown-revision", `${input.commit} is not a commit in ${cwd}`);
}
function okExtras(input) {
  const extras = [];
  if (input.head) extras.push("HEAD is the expected commit");
  if (input.retained) extras.push("retained changes present, none unmerged");
  return extras;
}
function okLine({ input, head, base }) {
  const detail = [`${short(base)} is an ancestor of HEAD ${short(head)}`, ...okExtras(input)].join("; ");
  return { ok: true, line: `sync-check: ok (${detail})` };
}
function syncCheck(input) {
  const facts = gatherFacts(input);
  if ("line" in facts) return facts;
  for (const check of CHECKS) {
    const problem = check(facts);
    if (problem) return problem;
  }
  return okLine(facts);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  SYNC_CHECK_RESULT,
  retainedSyncCheckStep,
  syncCheck,
  syncCheckCommand
});
