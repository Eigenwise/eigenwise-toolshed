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
var external_refs_exports = {};
__export(external_refs_exports, {
  externalReference: () => externalReference,
  githubReference: () => githubReference,
  githubRepository: () => githubRepository,
  originRepository: () => originRepository,
  referenceHeader: () => referenceHeader,
  referenceKeys: () => referenceKeys
});
module.exports = __toCommonJS(external_refs_exports);
var import_git_process = require("./git-process");
function githubRepository(remote) {
  return /^(?:https?:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i.exec(remote.trim())?.[1] ?? null;
}
function originRepository(project) {
  try {
    return githubRepository((0, import_git_process.execFileSync)("git", ["remote", "get-url", "origin"], { cwd: project, encoding: "utf8", stdio: "pipe", timeout: 1e4 }));
  } catch {
    return null;
  }
}
function githubReference(value, repository) {
  const url = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(issues|pull)\/(\d+)\/?$/i.exec(value);
  if (url) return { key: "GH-" + Number(url[3]), url: "https://github.com/" + url[1] + "/" + url[2] + "/" + Number(url[3]) };
  const qualified = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(value);
  if (qualified) return { key: "GH-" + Number(qualified[2]), url: "https://github.com/" + qualified[1] + "/issues/" + Number(qualified[2]) };
  const local = /^(?:GH-|#)(\d+)$/.exec(value);
  if (local && repository) return { key: "GH-" + Number(local[1]), url: "https://github.com/" + repository + "/issues/" + Number(local[1]) };
  return null;
}
function externalReference(value, repository, jiraBaseUrl) {
  const github = githubReference(value, repository);
  if (github) return github;
  if (/^[A-Z][A-Z0-9]+-\d+$/.test(value) && !value.startsWith("GH-")) {
    return { key: value, url: jiraBaseUrl ? jiraBaseUrl + "/browse/" + value : null };
  }
  throw new Error('Invalid external ref "' + value + '". Accepted: GH-123 or #123 (GitHub origin required), owner/repo#123, https://github.com/owner/repo/issues/123 or /pull/123, Jira key ABC-123.');
}
function referenceKeys(references = []) {
  return references.map((reference) => reference.key);
}
function referenceHeader(references = []) {
  return references.length ? ["Refs: " + referenceKeys(references).join(", ")] : [];
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  externalReference,
  githubReference,
  githubRepository,
  originRepository,
  referenceHeader,
  referenceKeys
});
