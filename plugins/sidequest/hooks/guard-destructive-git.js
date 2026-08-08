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

// src/hooks/guard-destructive-git.ts
var import_node_fs2 = __toESM(require("node:fs"));
var import_node_path = __toESM(require("node:path"));
var import_node_child_process = require("node:child_process");
var import_node_module = require("node:module");

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

// src/hooks/shared/output.ts
var import_node_crypto = __toESM(require("node:crypto"));
var CONTEXT_BUDGETS = Object.freeze({
  SessionStart: 2 * 1024,
  UserPromptSubmit: 1024,
  PreToolUse: 768,
  PreCompact: 1500,
  PostCompact: 1500,
  SubagentStart: 512,
  SubagentStop: 512,
  Stop: 512,
  PostToolUseFailure: 512,
  TeammateIdle: 512
});
function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}
function contextBudget(hookEventName) {
  return CONTEXT_BUDGETS[hookEventName] || 512;
}
function stableWatermark(value) {
  return import_node_crypto.default.createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}
function truncateUtf8(value, maxBytes) {
  if (byteLength(value) <= maxBytes) return value;
  let truncated = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = byteLength(character);
    if (bytes + characterBytes > maxBytes) break;
    truncated += character;
    bytes += characterBytes;
  }
  return truncated;
}
function projectedText(hookEventName, value) {
  const budget = contextBudget(hookEventName);
  if (byteLength(value) <= budget) return value;
  const watermark = stableWatermark(value);
  const omission = `
[sidequest context v1 id=${hookEventName} revision=${watermark} watermark=${watermark}; content omitted for ${budget}B budget. Retrieve current board state with mcp__plugin_sidequest_board__comments({ref:"<ticket-ref>"}).]`;
  return `${truncateUtf8(value, Math.max(0, budget - byteLength(omission)))}${omission}`;
}
function writeJson(value) {
  process.stdout.write(JSON.stringify(value));
}
function writeDeny(hookEventName, permissionDecisionReason) {
  writeJson({
    hookSpecificOutput: {
      hookEventName,
      permissionDecision: "deny",
      permissionDecisionReason: projectedText(hookEventName, permissionDecisionReason)
    }
  });
}

// src/hooks/guard-destructive-git.ts
var runtimeRequire = (0, import_node_module.createRequire)(__filename);
var store = runtimeRequire(["..", "lib", "store"].join("/"));
var publish = runtimeRequire(["..", "lib", "publish"].join("/"));
var worktrees = runtimeRequire(["..", "lib", "worktrees"].join("/"));
var GIT = String.raw`git\s+(?:-C\s+(?:"[^"]+"|'[^']+'|\S+)\s+)?`;
var DESTRUCTIVE = [
  { pattern: new RegExp(`${GIT}reset\\s+[^\\n;|&]*--hard`, "i"), label: "git reset --hard" },
  { pattern: new RegExp(`${GIT}clean\\s+-[a-z]*f`, "i"), label: "git clean -f" },
  { pattern: new RegExp(`${GIT}(?:checkout|restore)\\s+(?:[^\\n;|&]*\\s)?(?:--\\s+)?(?:\\.|:/)(?:\\s|$|;|&|\\|)`, "i"), label: "a whole-tree checkout/restore" },
  { pattern: new RegExp(`${GIT}(?:checkout|switch)\\s+[^\\n;|&]*(?:--force|\\s-f)\\b`, "i"), label: "a forced checkout/switch" }
];
var GIT_ACTION = /(?:^|[;&|\n]\s*|\$\(\s*)(?:&\s*)?git\s+(?:-C\s+("[^"]+"|'[^']+'|\S+)\s+)?(tag|push)\b([^\n;|&]*)/gi;
function commandText(input) {
  const toolInput = input.tool_input;
  return isRecord(toolInput) ? String(toolInput.command || "") : "";
}
function destructive(command) {
  for (const { pattern, label } of DESTRUCTIVE) if (pattern.test(command)) return label;
  return null;
}
function unquote(value) {
  return value.replace(/^["']|["']$/g, "");
}
function resolvedShellPath(cwd, value) {
  return import_node_path.default.resolve(worktrees.gitBashPath(cwd || "."), worktrees.gitBashPath(value));
}
function targetRepo(command, cwd) {
  const dashCs = Array.from(command.matchAll(/git\s+-C\s+("[^"]+"|'[^']+'|\S+)/gi));
  const dashC = dashCs.at(-1);
  if (dashC?.[1]) return resolvedShellPath(cwd, unquote(dashC[1]));
  const cds = Array.from(command.matchAll(/(?:^|[\n;&|])\s*cd\s+("[^"]+"|'[^']+'|\S+)/gi));
  const cd = cds.at(-1);
  if (cd?.[1]) return resolvedShellPath(cwd, unquote(cd[1]));
  return resolvedShellPath(cwd, ".");
}
function quotedAt(command, index) {
  let quote = "";
  for (let cursor = 0; cursor < index; cursor += 1) {
    const character = command[cursor];
    if (character === "\\") {
      cursor += 1;
    } else if (quote) {
      if (character === quote) quote = "";
    } else if (character === '"' || character === "'") {
      quote = character;
    }
  }
  return !!quote;
}
function actionRepo(command, cwd, index, options) {
  const beforeAction = command.slice(0, index);
  const base = targetRepo(beforeAction, cwd);
  const paths = Array.from(options.matchAll(/(?:^|\s)-C\s+("[^"]+"|'[^']+'|\S+)/gi));
  const selected = paths.at(-1);
  return repoRoot(selected?.[1] ? resolvedShellPath(base, unquote(selected[1])) : base);
}
function repoRoot(repo) {
  try {
    return worktrees.canonicalPath((0, import_node_child_process.execFileSync)("git", ["rev-parse", "--show-toplevel"], {
      cwd: repo,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"]
    }).trim());
  } catch {
    return worktrees.canonicalPath(repo);
  }
}
function sharedCheckout(repo) {
  try {
    return import_node_fs2.default.statSync(import_node_path.default.join(repo, ".git")).isDirectory();
  } catch (_) {
    return false;
  }
}
function dirtyPaths(repo) {
  try {
    return (0, import_node_child_process.execFileSync)("git", ["status", "--porcelain"], {
      cwd: repo,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"]
    }).split(/\r?\n/).filter(Boolean);
  } catch (_) {
    return [];
  }
}
function shellTokens(value) {
  return (value.match(/"[^"]*"|'[^']*'|\S+/g) || []).map(unquote);
}
function gitOutput(repo, args) {
  try {
    return (0, import_node_child_process.execFileSync)("git", args, {
      cwd: repo,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return "";
  }
}
function configuredIntegrationBranch(repo) {
  try {
    const project = store.findProject(repo);
    if (project.ok) return store.boardConfig(project.slug).integrationBranch;
  } catch {
  }
  return "main";
}
function defaultBranch(repo, remote) {
  const ref = gitOutput(repo, ["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`]);
  if (ref.startsWith(`${remote}/`)) return ref.slice(remote.length + 1);
  const branches = gitOutput(repo, ["for-each-ref", "--format=%(refname:short)", `refs/remotes/${remote}`]).split(/\r?\n/).map((branch) => branch.replace(`${remote}/`, "")).filter((branch) => branch && branch !== "HEAD");
  return ["main", "master", "trunk"].find((branch) => branches.includes(branch)) || branches[0] || "main";
}
function currentBranch(repo) {
  return gitOutput(repo, ["branch", "--show-current"]);
}
function upstream(repo) {
  const ref = gitOutput(repo, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  const slash = ref.indexOf("/");
  return slash > 0 ? { remote: ref.slice(0, slash), branch: ref.slice(slash + 1) } : null;
}
function isRemote(repo, name) {
  return !!gitOutput(repo, ["remote", "get-url", name]);
}
function branchName(value) {
  return value.replace(/^\+/, "").replace(/^refs\/heads\//, "").replace(/^\/+/, "");
}
function isTagRef(value) {
  return value.replace(/^\+/, "").startsWith("refs/tags/") || value === "--tags" || value === "--follow-tags";
}
function tagAction(args) {
  const tokens = shellTokens(args);
  if (!tokens.length) return false;
  if (tokens.some((token) => /^(?:-a|--annotate|-s|--sign|-u|--local-user|-d|--delete|-f|--force)$/.test(token))) return true;
  const lists = tokens.some((token) => /^(?:-l|--list|-n\d*|--contains|--no-contains|--points-at|--merged|--no-merged|--column|--sort|--format)$/.test(token));
  return !lists && tokens.some((token) => !token.startsWith("-"));
}
function pushAction(args, repo, integrationBranch) {
  const tokens = shellTokens(args);
  if (tokens.some((token) => token === "--tags" || token === "--follow-tags" || token === "--all" || token === "--mirror")) return true;
  const positional = tokens.filter((token) => !token.startsWith("-"));
  let remote = upstream(repo)?.remote || "origin";
  if (positional.length && isRemote(repo, positional[0])) remote = positional.shift() || remote;
  const specs = positional;
  if (specs.some((spec) => isTagRef(spec) || spec.includes("*"))) return true;
  const defaultTarget = upstream(repo)?.branch || currentBranch(repo);
  const published = defaultBranch(repo, remote);
  return specs.length === 0 ? defaultTarget === published && defaultTarget !== integrationBranch : specs.some((spec) => {
    const destination = spec.includes(":") ? spec.slice(spec.indexOf(":") + 1) : spec;
    if (!destination || isTagRef(destination)) return true;
    const target = destination === "HEAD" ? defaultTarget : branchName(destination);
    return target === published && target !== integrationBranch;
  });
}
function publicationAction(command, cwd) {
  const actions = Array.from(command.matchAll(GIT_ACTION));
  for (const match of actions) {
    if (quotedAt(command, match.index || 0)) continue;
    const optionPath = match[1] || "";
    const action = match[2] || "";
    const args = match[3] || "";
    const repo = actionRepo(command, cwd, match.index || 0, optionPath ? `-C ${optionPath}` : "");
    const integrationBranch = configuredIntegrationBranch(repo);
    if (action.toLowerCase() === "tag" && tagAction(args)) return { label: "manual git tag", repo };
    if (action.toLowerCase() === "push" && pushAction(args, repo, integrationBranch)) {
      return { label: `a push to the published branch (${defaultBranch(repo, upstream(repo)?.remote || "origin")})`, repo };
    }
  }
  return null;
}
function destructiveRefusal(label, repo, dirty) {
  const shown = dirty.slice(0, 10).map((line) => `  ${line}`);
  if (dirty.length > shown.length) shown.push(`  … +${dirty.length - shown.length} more`);
  return [
    `sidequest: refusing ${label} — the shared checkout has ${dirty.length} uncommitted change(s) that this operation would destroy.`,
    `  repo: ${repo}`,
    ...shown,
    "Some of this may be a live executor's finished work that lost its worktree; the shared tree is not yours alone.",
    `Next step: preserve every dirty path in a named stash (for example, \`git stash push -u -m "sidequest recovery"\`), then run \`sidequest recover-shared --project "${repo}" --stash <stash@{n}> --yes\`. That exact recovery action verifies the stash before it runs \`git reset --hard && git clean -fd\`.`
  ].join("\n");
}
function publicationRefusal(label, repo) {
  return [
    `sidequest: refusing ${label} without the current session's publish lock.`,
    `  repo: ${repo}`,
    "Acquire it with `sidequest publish lock` before a deliberate release cut, then retry.",
    "This blocks the entire shell invocation, including earlier compound-command segments.",
    "This is a local early warning. Server-side GitHub rules remain the guarantee."
  ].join("\n");
}
function main() {
  const input = readStdin();
  if (!input || !["Bash", "PowerShell"].includes(stringField(input, "tool_name"))) return;
  const command = commandText(input);
  const repo = repoRoot(targetRepo(command, stringField(input, "cwd")));
  const publication = publicationAction(command, stringField(input, "cwd"));
  if (publication && !publish.publishLockOwnedBySession(publication.repo, stringField(input, "session_id"))) {
    writeDeny("PreToolUse", publicationRefusal(publication.label, publication.repo));
    return;
  }
  const label = destructive(command);
  if (!label || !sharedCheckout(repo)) return;
  const dirty = dirtyPaths(repo);
  if (dirty.length) writeDeny("PreToolUse", destructiveRefusal(label, repo, dirty));
}
try {
  main();
} catch (_) {
  process.exit(0);
}
