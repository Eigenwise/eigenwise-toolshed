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
var evidence_writes_exports = {};
__export(evidence_writes_exports, {
  evidencePathAllowed: () => evidencePathAllowed,
  evidenceToolDenial: () => evidenceToolDenial
});
module.exports = __toCommonJS(evidence_writes_exports);
var import_node_path = __toESM(require("node:path"));
var import_worktree = require("./kernel/worktree.js");
var import_shell_writes = require("../hooks/shared/shell-writes.js");
function within(root, target) {
  const relative = import_node_path.default.relative((0, import_worktree.canonicalPath)(root), (0, import_worktree.canonicalPath)(target));
  return relative !== ".." && !relative.startsWith(`..${import_node_path.default.sep}`) && !import_node_path.default.isAbsolute(relative);
}
function protectedRoots(scope) {
  return [scope.evidenceRepositoryRoot, scope.worktree].filter((root) => Boolean(root));
}
function evidencePathAllowed(target, scope) {
  if (!scope.evidenceMode || !import_node_path.default.isAbsolute(target)) return false;
  if (protectedRoots(scope).some((root) => within(root, target))) return false;
  return (scope.evidenceWriteRoots ?? []).some((root) => within(root, target));
}
function refusal(scope) {
  return `sidequest: evidence executor may write only under admitted roots: ${(scope.evidenceWriteRoots ?? []).join(", ") || "(no live evidence scope)"}. Repository paths remain forbidden. Close through done, without commit or submit.`;
}
function nativeTarget(base, target) {
  const native = process.platform === "win32" ? target.replace(/^\/([a-z])(\/|$)/i, "$1:/") : target;
  return import_node_path.default.resolve(base, native);
}
function segmentTargets(segment, base) {
  return [...segment.redirects, ...(0, import_shell_writes.commandWriteTargets)(segment.words)].filter((target) => !(0, import_shell_writes.ignoredTarget)(target)).map((target) => nativeTarget(base, target));
}
function changedDirectory(segment, base) {
  return segment.words[0] === "cd" && segment.words[1] ? nativeTarget(base, segment.words[1]) : base;
}
function segmentForbidden(segment, base, scope) {
  return (0, import_shell_writes.isGitMutation)(segment.words) || segmentTargets(segment, base).some((target) => !evidencePathAllowed(target, scope));
}
function shellDenial(command, cwd, scope) {
  let base = cwd;
  for (const segment of (0, import_shell_writes.shellSegments)(command)) {
    base = changedDirectory(segment, base);
    if (segmentForbidden(segment, base, scope)) return refusal(scope);
  }
  return null;
}
function fileDenial(input, _cwd, scope) {
  return evidencePathAllowed(String(input.file_path ?? input.path ?? ""), scope) ? null : refusal(scope);
}
const TOOL_GUARDS = {
  Bash: (input, cwd, scope) => shellDenial(String(input.command ?? ""), cwd, scope),
  PowerShell: (input, cwd, scope) => shellDenial(String(input.command ?? ""), cwd, scope),
  Write: fileDenial,
  Edit: fileDenial,
  MultiEdit: fileDenial,
  NotebookEdit: (_input, _cwd, scope) => refusal(scope),
  Agent: (_input, _cwd, scope) => refusal(scope),
  mcp__plugin_sidequest_board__commit: (_input, _cwd, scope) => refusal(scope),
  mcp__plugin_sidequest_board__submit: (_input, _cwd, scope) => refusal(scope),
  mcp__plugin_sidequest_board__integrate: (_input, _cwd, scope) => refusal(scope)
};
function evidenceToolDenial(tool, input, cwd, scope) {
  return TOOL_GUARDS[tool]?.(input, cwd, scope) ?? null;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  evidencePathAllowed,
  evidenceToolDenial
});
