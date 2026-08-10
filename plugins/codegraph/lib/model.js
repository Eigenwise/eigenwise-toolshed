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
var model_exports = {};
__export(model_exports, {
  assertGraphResponseInvariants: () => assertGraphResponseInvariants,
  compareGraphResults: () => compareGraphResults,
  createGraphEdgeId: () => createGraphEdgeId,
  createGraphNodeId: () => createGraphNodeId,
  sortGraphResults: () => sortGraphResults
});
module.exports = __toCommonJS(model_exports);
var import_node_crypto = require("node:crypto");
function createGraphNodeId(identity) {
  const identityParts = [
    identity.extractor,
    identity.projectId,
    identity.declarationFile,
    identity.kind,
    identity.qualifiedName
  ];
  return (0, import_node_crypto.createHash)("sha256").update(identityParts.join("\0")).digest("hex");
}
function createGraphEdgeId(identity) {
  const identityParts = [
    identity.kind,
    identity.sourceId,
    identity.targetId ?? "",
    identity.resolution,
    identity.evidence.file,
    String(identity.evidence.startLine),
    String(identity.evidence.startColumn),
    identity.reason ?? ""
  ];
  return (0, import_node_crypto.createHash)("sha256").update(identityParts.join("\0")).digest("hex");
}
function compareGraphResults(left, right) {
  return right.rank - left.rank || left.file.localeCompare(right.file) || left.startLine - right.startLine || left.kind.localeCompare(right.kind) || left.qualifiedName.localeCompare(right.qualifiedName) || left.id.localeCompare(right.id);
}
function sortGraphResults(results) {
  return [...results].sort(compareGraphResults);
}
function assertGraphResponseInvariants(response) {
  if (response.status !== "ready" && response.results.length > 0) {
    throw new Error(`${response.status} graph responses cannot include graph results`);
  }
  if (response.status === "ready" && (response.snapshot === null || response.coverage === null)) {
    throw new Error("ready graph responses require snapshot and coverage");
  }
  if (!Number.isInteger(response.omitted) || response.omitted < 0) {
    throw new Error("graph response omitted count must be a non-negative integer");
  }
  if (!Number.isInteger(response.tokenEstimate) || response.tokenEstimate < 0) {
    throw new Error("graph response token estimate must be a non-negative integer");
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  assertGraphResponseInvariants,
  compareGraphResults,
  createGraphEdgeId,
  createGraphNodeId,
  sortGraphResults
});
