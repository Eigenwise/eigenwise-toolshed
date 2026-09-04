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
var hook_timeouts_exports = {};
__export(hook_timeouts_exports, {
  WORKTREE_CREATE_HOOK_TIMEOUT_SECONDS: () => WORKTREE_CREATE_HOOK_TIMEOUT_SECONDS,
  WORKTREE_CREATE_SETUP_HEADROOM_MS: () => WORKTREE_CREATE_SETUP_HEADROOM_MS,
  worktreeCreateHookTimeoutMs: () => worktreeCreateHookTimeoutMs,
  worktreeSetupDeadlineMs: () => worktreeSetupDeadlineMs
});
module.exports = __toCommonJS(hook_timeouts_exports);
const WORKTREE_CREATE_HOOK_TIMEOUT_SECONDS = 120;
const WORKTREE_CREATE_SETUP_HEADROOM_MS = 1e4;
function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}
function worktreeCreateHookTimeoutMs(environment = process.env) {
  const injected = positiveInteger(environment.SIDEQUEST_WORKTREE_CREATE_HOOK_TIMEOUT_MS);
  return injected || WORKTREE_CREATE_HOOK_TIMEOUT_SECONDS * 1e3;
}
function worktreeSetupDeadlineMs(environment = process.env) {
  const hookTimeoutMs = worktreeCreateHookTimeoutMs(environment);
  const headroomMs = Math.min(WORKTREE_CREATE_SETUP_HEADROOM_MS, Math.floor(hookTimeoutMs / 10));
  return Math.max(1, hookTimeoutMs - headroomMs);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  WORKTREE_CREATE_HOOK_TIMEOUT_SECONDS,
  WORKTREE_CREATE_SETUP_HEADROOM_MS,
  worktreeCreateHookTimeoutMs,
  worktreeSetupDeadlineMs
});
