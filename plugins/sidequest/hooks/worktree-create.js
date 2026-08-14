#!/usr/bin/env node
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
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

// src/hooks/worktree-create.ts
var import_node_fs2 = __toESM(require("node:fs"));
var import_node_path2 = __toESM(require("node:path"));
var import_node_child_process = require("node:child_process");

// src/hooks/shared/input.ts
var import_node_fs = __toESM(require("node:fs"));
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function readStdin() {
  try {
    const raw = import_node_fs.default.readFileSync(0, "utf8");
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}
function stringField(input, ...names) {
  for (const name of names) {
    const value = input[name];
    if (value != null) return String(value);
  }
  return "";
}

// src/hooks/shared/paths.ts
var import_node_path = __toESM(require("node:path"));
function pluginRoot() {
  return process.env.CLAUDE_PLUGIN_ROOT || import_node_path.default.join(__dirname, "..");
}
function runtimeModule(name) {
  return import_node_path.default.join(pluginRoot(), "lib", `${name}.js`);
}

// src/hooks/worktree-create.ts
var leaseKernel = require(runtimeModule("kernel/worktree"));
function git(repository, args) {
  return (0, import_node_child_process.execFileSync)("git", args, {
    cwd: repository,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}
function gitSucceeds(repository, args) {
  try {
    git(repository, args);
    return true;
  } catch (_) {
    return false;
  }
}
function repositoryFor(cwd) {
  return import_node_path2.default.resolve(git(cwd, ["rev-parse", "--show-toplevel"]));
}
function samePath(left, right) {
  return leaseKernel.canonicalPath(left) === leaseKernel.canonicalPath(right);
}
function linkedCheckoutIdentity(target) {
  try {
    const worktree = import_node_path2.default.resolve(git(target, ["rev-parse", "--show-toplevel"]));
    const gitPath = (value) => import_node_path2.default.isAbsolute(value) ? value : import_node_path2.default.resolve(worktree, value);
    const gitDirectory = gitPath(git(worktree, ["rev-parse", "--git-dir"]));
    return {
      worktree,
      gitDirectory,
      commonGitDirectory: gitPath(git(worktree, ["rev-parse", "--git-common-dir"])),
      checkoutInstance: leaseKernel.checkoutInstanceIdentity(gitDirectory),
      revision: git(worktree, ["rev-parse", "--verify", "HEAD^{commit}"])
    };
  } catch (_) {
    return null;
  }
}
function completedTargetMatches(binding) {
  const identity = linkedCheckoutIdentity(String(binding.worktree));
  return Boolean(identity && binding.expectedGitDirectory && binding.expectedCommonGitDirectory && binding.expectedCheckoutInstance && binding.expectedRevision && samePath(identity.worktree, String(binding.worktree)) && samePath(identity.gitDirectory, binding.expectedGitDirectory) && samePath(identity.commonGitDirectory, binding.expectedCommonGitDirectory) && identity.checkoutInstance === binding.expectedCheckoutInstance && identity.revision === binding.expectedRevision);
}
function createWorktree(binding, name) {
  const repository = String(binding.repository);
  const target = String(binding.worktree);
  const baseline = String(binding.baseline);
  import_node_fs2.default.mkdirSync(import_node_path2.default.dirname(target), { recursive: true });
  if (import_node_fs2.default.existsSync(target)) {
    if (binding.creationCompleted && completedTargetMatches(binding)) return false;
    throw new Error(`worktree destination existed before this dispatch completed its creation: ${target}`);
  }
  if (binding.creationCompleted) throw new Error(`completed worktree creation is missing its bound checkout: ${target}`);
  const branch = `worktree-${name}`;
  git(repository, ["check-ref-format", "--branch", branch]);
  if (gitSucceeds(repository, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])) {
    git(repository, ["worktree", "add", target, branch]);
    return true;
  }
  git(repository, ["worktree", "add", "-b", branch, target, baseline]);
  return true;
}
function bindCreation(repository, sessionId, worktree) {
  const store = require(runtimeModule("store"));
  const project = store.findProject(repository);
  if (!project.ok || !project.slug) return { ok: false, reason: "project_unavailable" };
  return store.bindDispatchWorktreeCreation(project.slug, sessionId, worktree);
}
function completeCreation(repository, sessionId, worktree) {
  const store = require(runtimeModule("store"));
  const project = store.findProject(repository);
  if (!project.ok || !project.slug) return { ok: false, reason: "project_unavailable" };
  return store.completeDispatchWorktreeCreation(project.slug, sessionId, worktree);
}
function plannedRevision(repository, name, baseline) {
  const branch = `worktree-${name}`;
  git(repository, ["check-ref-format", "--branch", branch]);
  return gitSucceeds(repository, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]) ? git(repository, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]) : git(repository, ["rev-parse", "--verify", `${baseline}^{commit}`]);
}
function preparedWorktreeLease(binding, name) {
  const gitDirectory = git(binding.repository, ["rev-parse", "--git-dir"]);
  const commonGitDirectory = git(binding.repository, ["rev-parse", "--git-common-dir"]);
  const gitPath = (value) => import_node_path2.default.isAbsolute(value) ? value : import_node_path2.default.resolve(binding.repository, value);
  return leaseKernel.createWorktreeLease({
    repository: binding.repository,
    gitDirectory: gitPath(gitDirectory),
    commonGitDirectory: gitPath(commonGitDirectory),
    dispatchRef: binding.ref,
    dispatchBaseline: binding.baseline,
    observedRevision: plannedRevision(binding.repository, name, binding.baseline),
    observedWorktree: binding.worktree,
    boundWorktree: binding.worktree,
    identity: { status: "bound", dispatchRef: binding.ref },
    phase: "prepared",
    locked: false,
    liveness: { status: "live", evidence: `dispatch ${binding.ref} reserved this creation` },
    provisioning: "host"
  });
}
function provisioningConfig(repository) {
  const store = require(runtimeModule("store"));
  const project = store.findProject(repository);
  return project.ok && project.slug ? store.boardConfig(project.slug) || {} : {};
}
function removeCreatedWorktree(repository, target) {
  try {
    git(repository, ["worktree", "remove", "--force", target]);
  } catch (_) {
    import_node_fs2.default.rmSync(target, { recursive: true, force: true });
    git(repository, ["worktree", "prune"]);
  }
}
function main() {
  const input = readStdin();
  if (!input || stringField(input, "hook_event_name") !== "WorktreeCreate") return;
  const name = stringField(input, "name");
  const sessionId = stringField(input, "session_id", "sessionId");
  const cwd = stringField(input, "cwd") || process.cwd();
  if (!name) throw new Error("WorktreeCreate requires a worktree name.");
  if (!sessionId) throw new Error("WorktreeCreate requires a dispatch session binding.");
  const repository = repositoryFor(cwd);
  const worktrees = require(runtimeModule("worktrees"));
  const target = worktrees.namedWorktreePath(repository, name);
  const binding = bindCreation(repository, sessionId, target);
  if (!binding.ok || !binding.ref || !binding.baseline || !binding.repository || !binding.worktree) {
    throw new Error(`worktree lease refused creation: ${binding.reason || "dispatch binding is incomplete"}`);
  }
  const boundCreation = {
    ...binding,
    ref: binding.ref,
    baseline: binding.baseline,
    repository: binding.repository,
    worktree: binding.worktree
  };
  const decision = leaseKernel.worktreeCreateDecision(preparedWorktreeLease(boundCreation, name));
  if (!decision.allowed) throw new Error(`worktree lease refused creation: ${decision.reason}`);
  const created = createWorktree(boundCreation, name);
  if (created) {
    try {
      const identity = linkedCheckoutIdentity(boundCreation.worktree);
      if (!identity) throw new Error("new worktree identity is unavailable");
      leaseKernel.createCheckoutInstanceMarker(identity.gitDirectory);
      worktrees.provisionWorktree(boundCreation.repository, boundCreation.worktree, provisioningConfig(boundCreation.repository));
      const completed = completeCreation(boundCreation.repository, sessionId, boundCreation.worktree);
      if (!completed.ok) throw new Error(`worktree lease could not record completed creation: ${completed.reason || "completion binding is incomplete"}`);
    } catch (error) {
      removeCreatedWorktree(boundCreation.repository, boundCreation.worktree);
      throw error;
    }
  }
  process.stdout.write(`${boundCreation.worktree}
`);
}
try {
  main();
} catch (error) {
  process.stderr.write(`sidequest: could not create external worktree: ${error?.message || String(error)}
`);
  process.exit(1);
}
