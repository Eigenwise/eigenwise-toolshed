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
var github_import_exports = {};
__export(github_import_exports, {
  importGitHubIssue: () => importGitHubIssue,
  sanitizeIssueBody: () => sanitizeIssueBody
});
module.exports = __toCommonJS(github_import_exports);
var import_git_process = require("./git-process");
function sanitizeIssueBody(body) {
  return body.replace(/<!--[\s\S]*?-->/g, "").replace(/!\[[^\]]*\](?:\([^)]*\)|\[[^\]]*\])?/g, "").replace(/<img\b[^>]*>/gi, "").trim();
}
function importGitHubIssue(url) {
  if (url === void 0) return {};
  const match = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(issues|pull)\/\d+\/?$/.exec(url);
  if (!match) throw new Error("--github requires a GitHub issue or pull URL.");
  const kind = match[1] === "pull" ? "pr" : "issue";
  let output;
  try {
    output = (0, import_git_process.execFileSync)("gh", [kind, "view", url, "--json", "number,title,body,url"], { encoding: "utf8", stdio: "pipe", timeout: 3e4 });
  } catch (error) {
    throw new Error('GitHub import failed. Install gh if missing, run "gh auth login", then retry "gh ' + kind + " view " + url + ' --json number,title,body,url". ' + String(error));
  }
  const issue = JSON.parse(output);
  return { title: "GH-" + issue.number + ": " + issue.title, body: sanitizeIssueBody(issue.body), refs: [issue.url] };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  importGitHubIssue,
  sanitizeIssueBody
});
