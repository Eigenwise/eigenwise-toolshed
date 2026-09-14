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
var integration_checkout_exports = {};
__export(integration_checkout_exports, {
  captureIntegrationCheckout: () => captureIntegrationCheckout,
  integrationCheckoutKey: () => integrationCheckoutKey,
  integrationCheckoutPath: () => integrationCheckoutPath
});
module.exports = __toCommonJS(integration_checkout_exports);
var import_node_fs = __toESM(require("node:fs"));
var import_node_path = __toESM(require("node:path"));
var import_node_child_process = require("node:child_process");
var import_worktree = require("./kernel/worktree.js");
function git(repository, args) {
  return (0, import_node_child_process.execFileSync)("git", args, { cwd: repository, encoding: "utf8", windowsHide: true, stdio: "pipe", timeout: 1e4 }).trim();
}
function gitPath(repository, flag) {
  const value = git(repository, ["rev-parse", flag]);
  return (0, import_worktree.canonicalPath)(import_node_path.default.resolve(repository, value));
}
function checkoutFacts(repository, value, branch) {
  if (typeof value !== "string" || !import_node_path.default.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error("integrationCheckout must be an absolute checkout path.");
  }
  const checkout = (0, import_worktree.canonicalPath)(value);
  if (!import_node_fs.default.statSync(checkout).isDirectory() || gitPath(checkout, "--show-toplevel") !== checkout) {
    throw new Error("integrationCheckout must name the checkout root.");
  }
  const gitDirectory = gitPath(checkout, "--git-dir");
  const commonGitDirectory = gitPath(checkout, "--git-common-dir");
  if (commonGitDirectory !== gitPath(repository, "--git-common-dir") || gitDirectory === commonGitDirectory) {
    throw new Error("integrationCheckout must be a linked checkout of the same repository, not its shared main checkout.");
  }
  const registered = git(repository, ["worktree", "list", "--porcelain", "-z"]).split("\0").some((line) => line.startsWith("worktree ") && (0, import_worktree.canonicalPath)(line.slice(9)) === checkout);
  if (!registered) throw new Error("integrationCheckout is not a registered worktree.");
  if (git(checkout, ["branch", "--show-current"]) !== branch) {
    throw new Error(`integrationCheckout must have branch ${branch} checked out.`);
  }
  return { path: checkout, gitDirectory, commonGitDirectory, startingRevision: git(checkout, ["rev-parse", "--verify", "HEAD^{commit}"]) };
}
function captureIntegrationCheckout(repository, value, branch) {
  try {
    const facts = checkoutFacts(repository, value, branch);
    if (git(facts.path, ["status", "--porcelain", "--untracked-files=all"])) throw new Error("integrationCheckout must be clean before dispatch.");
    let instance = (0, import_worktree.checkoutInstanceIdentity)(facts.gitDirectory);
    if (!instance) {
      try {
        instance = (0, import_worktree.createCheckoutInstanceMarker)(facts.gitDirectory);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        instance = (0, import_worktree.checkoutInstanceIdentity)(facts.gitDirectory);
      }
    }
    if (!instance) throw new Error("integrationCheckout has an unreadable checkout-instance marker.");
    return { ...facts, checkoutInstance: instance };
  } catch (error) {
    throw new Error(`integrationCheckout: ${error.message}`);
  }
}
function integrationCheckoutKey(target) {
  const checkout = target?.checkout;
  return checkout ? JSON.stringify([checkout.path, checkout.gitDirectory, checkout.commonGitDirectory, checkout.checkoutInstance]) : null;
}
function integrationCheckoutPath(repository, target) {
  if (!target || !Object.hasOwn(target, "checkout")) return repository;
  try {
    const pinned = target.checkout;
    if (!pinned || !["path", "gitDirectory", "commonGitDirectory", "checkoutInstance", "startingRevision"].every((key) => typeof pinned[key] === "string" && pinned[key])) {
      throw new Error("pinned checkout identity is incomplete; no fallback is allowed.");
    }
    const actual = checkoutFacts(repository, pinned.path, target.branch);
    if (actual.path !== pinned.path || actual.gitDirectory !== pinned.gitDirectory || actual.commonGitDirectory !== pinned.commonGitDirectory || (0, import_worktree.checkoutInstanceIdentity)(actual.gitDirectory) !== pinned.checkoutInstance) {
      throw new Error("pinned checkout identity no longer matches; no fallback is allowed.");
    }
    git(actual.path, ["merge-base", "--is-ancestor", pinned.startingRevision, actual.startingRevision]);
    return actual.path;
  } catch (error) {
    throw new Error(`integrationCheckout: ${error.message}`);
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  captureIntegrationCheckout,
  integrationCheckoutKey,
  integrationCheckoutPath
});
