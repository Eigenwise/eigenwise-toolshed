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
var exec_names_exports = {};
__export(exec_names_exports, {
  CLAUDE_PREFIX: () => CLAUDE_PREFIX,
  DISPATCH_PREFIX: () => DISPATCH_PREFIX,
  EFFORTS: () => EFFORTS,
  LEGACY_TICKET_PREFIX: () => LEGACY_TICKET_PREFIX,
  READ_ONLY_CATEGORY_IDS: () => READ_ONLY_CATEGORY_IDS,
  READ_ONLY_CLAUDE_PREFIX: () => READ_ONLY_CLAUDE_PREFIX,
  READ_ONLY_DISPATCH_PREFIX: () => READ_ONLY_DISPATCH_PREFIX,
  TICKET_PREFIX: () => TICKET_PREFIX,
  classify: () => classify,
  isEffort: () => isEffort,
  isReadOnlyCategory: () => isReadOnlyCategory,
  stableClaudeName: () => stableClaudeName,
  stableDispatchName: () => stableDispatchName,
  stableReadOnlyClaudeName: () => stableReadOnlyClaudeName,
  stableReadOnlyDispatchName: () => stableReadOnlyDispatchName
});
module.exports = __toCommonJS(exec_names_exports);
const EFFORTS = Object.freeze(["low", "medium", "high", "xhigh", "max"]);
const CLAUDE_PREFIX = "sidequest-exec-";
const DISPATCH_PREFIX = "sidequest-exec-dispatch-";
const READ_ONLY_CLAUDE_PREFIX = "sidequest-exec-readonly-";
const READ_ONLY_DISPATCH_PREFIX = "sidequest-exec-dispatch-readonly-";
const TICKET_PREFIX = "sidequest-sq-";
const LEGACY_TICKET_PREFIX = "sidequest-ticket-";
const READ_ONLY_CATEGORY_IDS = Object.freeze([
  "codebase-exploration",
  "research",
  "review-audit",
  "spike-investigation"
]);
function isEffort(value) {
  return typeof value === "string" && EFFORTS.includes(value);
}
function stableClaudeName(effort) {
  return `${CLAUDE_PREFIX}${effort}`;
}
function stableDispatchName(effort) {
  return `${DISPATCH_PREFIX}${effort}`;
}
function stableReadOnlyClaudeName(effort) {
  return `${READ_ONLY_CLAUDE_PREFIX}${effort}`;
}
function stableReadOnlyDispatchName(effort) {
  return `${READ_ONLY_DISPATCH_PREFIX}${effort}`;
}
function isReadOnlyCategory(categoryId) {
  return typeof categoryId === "string" && READ_ONLY_CATEGORY_IDS.includes(categoryId);
}
function classify(name) {
  if (typeof name !== "string" || !name) return { kind: "unknown", effort: null };
  if (name.startsWith(READ_ONLY_DISPATCH_PREFIX)) {
    const effort = name.slice(READ_ONLY_DISPATCH_PREFIX.length);
    if (isEffort(effort)) return { kind: "read_only_codex_dispatch", effort };
    return { kind: "ticket", effort: null };
  }
  if (name.startsWith(READ_ONLY_CLAUDE_PREFIX)) {
    const effort = name.slice(READ_ONLY_CLAUDE_PREFIX.length);
    if (isEffort(effort)) return { kind: "read_only_claude_builtin", effort };
    return { kind: "ticket", effort: null };
  }
  if (name.startsWith(DISPATCH_PREFIX)) {
    const effort = name.slice(DISPATCH_PREFIX.length);
    if (isEffort(effort)) return { kind: "codex_dispatch", effort };
    return { kind: "ticket", effort: null };
  }
  if (name.startsWith(CLAUDE_PREFIX)) {
    const effort = name.slice(CLAUDE_PREFIX.length);
    if (isEffort(effort)) return { kind: "claude_builtin", effort };
    return { kind: "ticket", effort: null };
  }
  if (name.startsWith(TICKET_PREFIX)) return { kind: "ticket", effort: null };
  if (name.startsWith(LEGACY_TICKET_PREFIX)) return { kind: "legacy_ticket", effort: null };
  return { kind: "unknown", effort: null };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CLAUDE_PREFIX,
  DISPATCH_PREFIX,
  EFFORTS,
  LEGACY_TICKET_PREFIX,
  READ_ONLY_CATEGORY_IDS,
  READ_ONLY_CLAUDE_PREFIX,
  READ_ONLY_DISPATCH_PREFIX,
  TICKET_PREFIX,
  classify,
  isEffort,
  isReadOnlyCategory,
  stableClaudeName,
  stableDispatchName,
  stableReadOnlyClaudeName,
  stableReadOnlyDispatchName
});
