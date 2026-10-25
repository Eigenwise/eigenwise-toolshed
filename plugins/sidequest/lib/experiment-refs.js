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
var experiment_refs_exports = {};
__export(experiment_refs_exports, {
  experimentRoundRef: () => experimentRoundRef,
  migrateExperimentRoundRefs: () => migrateExperimentRoundRefs,
  resolveExperimentRoundRef: () => resolveExperimentRoundRef
});
module.exports = __toCommonJS(experiment_refs_exports);
var import_node_child_process = require("node:child_process");
function experimentRoundRef(ref, round) {
  return `refs/sidequest-rounds/${ref}/r${round}`;
}
function resolveExperimentRoundRef(project, ref, round) {
  const target = experimentRoundRef(ref, round);
  const current = (0, import_node_child_process.spawnSync)("git", ["show-ref", "--verify", "--quiet", target], { cwd: project, windowsHide: true });
  if (current.status === 0) return target;
  const legacy = `refs/sidequest/${ref}/r${round}`;
  const previous = (0, import_node_child_process.spawnSync)("git", ["show-ref", "--verify", "--quiet", legacy], { cwd: project, windowsHide: true });
  return previous.status === 0 ? legacy : target;
}
function migrateExperimentRound(project, name, commit, ref) {
  const round = name.slice(`refs/sidequest/${ref}/r`.length);
  const target = experimentRoundRef(ref, round);
  const existing = (0, import_node_child_process.spawnSync)("git", ["show-ref", "--verify", "--hash", target], { cwd: project, encoding: "utf8", windowsHide: true });
  if (existing.status === 0 && existing.stdout.trim() !== commit) {
    throw new Error(`Cannot migrate ${name}: ${target} already pins a different commit.`);
  }
  const preserve = existing.status === 0 ? `verify ${target} ${commit}` : `create ${target} ${commit}`;
  (0, import_node_child_process.execFileSync)("git", ["update-ref", "--stdin"], {
    cwd: project,
    encoding: "utf8",
    windowsHide: true,
    input: `start
${preserve}
delete ${name} ${commit}
prepare
commit
`,
    stdio: ["pipe", "pipe", "pipe"]
  });
}
function migrateExperimentRoundRefs(project, ref) {
  const repository = (0, import_node_child_process.spawnSync)("git", ["rev-parse", "--git-dir"], { cwd: project, windowsHide: true });
  if (repository.status !== 0) return;
  const prefix = `refs/sidequest/${ref}/`;
  const output = (0, import_node_child_process.execFileSync)("git", ["for-each-ref", "--format=%(refname) %(objectname)", prefix], {
    cwd: project,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  for (const line of output.trim().split("\n")) {
    const [name = "", commit = ""] = line.trim().split(" ");
    if (/^r[1-9]\d*$/.test(name.slice(prefix.length))) migrateExperimentRound(project, name, commit, ref);
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  experimentRoundRef,
  migrateExperimentRoundRefs,
  resolveExperimentRoundRef
});
