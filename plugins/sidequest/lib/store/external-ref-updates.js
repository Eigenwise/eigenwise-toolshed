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
var external_ref_updates_exports = {};
__export(external_ref_updates_exports, {
  emitExternalRefUpdates: () => emitExternalRefUpdates
});
module.exports = __toCommonJS(external_ref_updates_exports);
var import_git_process = require("../git-process");
function updateGithubReference(ticket, event, url) {
  const body = event.kind === "delivered" ? `Fixed on ${event.branch} in ${event.sha} (${ticket.ref})` : `Shipped in ${event.tag}`;
  const options = { cwd: event.cwd, encoding: "utf8", stdio: "pipe", timeout: 1e4 };
  try {
    (0, import_git_process.execFileSync)("gh", ["issue", "comment", url, "--body", body], options);
    if (event.kind === "released" && event.mode === "close") (0, import_git_process.execFileSync)("gh", ["issue", "close", url], options);
  } catch (error) {
    event.onFailure(`GitHub sync failed for ${url}: ${String(error)}`);
  }
}
function githubUrls(references = []) {
  return [...new Set(references.map((reference) => reference.url ?? ""))].filter((url) => /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\/\d+\/?$/i.test(url));
}
function emitExternalRefUpdates(ticket, event) {
  if (event.mode === "off") return;
  for (const url of githubUrls(ticket.externalRefs)) updateGithubReference(ticket, event, url);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  emitExternalRefUpdates
});
