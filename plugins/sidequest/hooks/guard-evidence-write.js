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

// src/hooks/shared/input.ts
var import_node_fs = __toESM(require("node:fs"));

// src/lib/exec-names.ts
var EFFORTS = Object.freeze(["low", "medium", "high", "xhigh", "max"]);
var CLAUDE_PREFIX = "sidequest-exec-";
var EVIDENCE_CLAUDE_PREFIX = "sidequest-exec-evidence-";
var EVIDENCE_DISPATCH_NAME = "sidequest-exec-dispatch-evidence";
var READ_ONLY_CLAUDE_PREFIX = "sidequest-exec-readonly-";
var DIAGNOSTIC_PROBE_NAME = "sidequest-diagnostic-probe";
var DISPATCH_NAME = "sidequest-exec-dispatch";
var READ_ONLY_DISPATCH_NAME = "sidequest-exec-dispatch-readonly";
function stableClaudeName(effort) {
  return `${CLAUDE_PREFIX}${effort}`;
}
function stableEvidenceClaudeName(effort) {
  return `${EVIDENCE_CLAUDE_PREFIX}${effort}`;
}
function stableReadOnlyClaudeName(effort) {
  return `${READ_ONLY_CLAUDE_PREFIX}${effort}`;
}
var BUNDLED_AGENT_NAMES = /* @__PURE__ */ new Set([
  DISPATCH_NAME,
  READ_ONLY_DISPATCH_NAME,
  EVIDENCE_DISPATCH_NAME,
  ...EFFORTS.map(stableEvidenceClaudeName),
  DIAGNOSTIC_PROBE_NAME,
  ...EFFORTS.map(stableClaudeName),
  ...EFFORTS.map(stableReadOnlyClaudeName)
]);
var PLUGIN_NAMESPACE = "sidequest:";
function canonicalExecutorName(name) {
  if (!name.startsWith(PLUGIN_NAMESPACE)) return name;
  const unqualifiedName = name.slice(PLUGIN_NAMESPACE.length);
  return BUNDLED_AGENT_NAMES.has(unqualifiedName) ? unqualifiedName : name;
}

// src/hooks/shared/input.ts
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function readStdin() {
  try {
    const raw = import_node_fs.default.readFileSync(0, "utf8");
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    for (const field of ["agent_type", "agentType", "subagent_type"]) {
      const executor = parsed[field];
      if (typeof executor === "string") parsed[field] = canonicalExecutorName(executor);
    }
    return parsed;
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
  SessionStart: 4 * 1024,
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

// src/lib/evidence-writes.ts
var import_node_path2 = __toESM(require("node:path"));

// src/lib/kernel/worktree.ts
var import_node_fs2 = __toESM(require("node:fs"));
var import_node_path = __toESM(require("node:path"));
var import_node_crypto2 = __toESM(require("node:crypto"));
function platformPath(value) {
  return process.platform === "win32" ? value.toLowerCase() : value;
}
function canonicalPath(value) {
  const gitBashDrive = process.platform === "win32" ? /^\/([a-zA-Z])(?=\/|$)/.exec(value) : null;
  const resolved = import_node_path.default.resolve(gitBashDrive ? `${gitBashDrive[1]}:${value.slice(2)}` : value);
  const missing = [];
  let existing = resolved;
  while (!import_node_fs2.default.existsSync(existing)) {
    const parent = import_node_path.default.dirname(existing);
    if (parent === existing) return platformPath(resolved);
    missing.unshift(import_node_path.default.basename(existing));
    existing = parent;
  }
  try {
    return platformPath(import_node_path.default.join(import_node_fs2.default.realpathSync.native(existing), ...missing));
  } catch {
    return platformPath(resolved);
  }
}

// src/hooks/shared/read-only-git.ts
var READ_ONLY_SUBCOMMANDS = /* @__PURE__ */ new Set([
  "status",
  "log",
  "show",
  "diff",
  "rev-parse",
  "rev-list",
  "ls-files",
  "ls-tree",
  "cat-file",
  "describe",
  "blame",
  "merge-base",
  "grep",
  "for-each-ref",
  "show-ref",
  "shortlog",
  "ls-remote",
  "name-rev",
  "count-objects",
  "check-ignore",
  "check-attr",
  "diff-tree",
  "diff-index"
]);
var GLOBAL_VALUE_FLAGS = /* @__PURE__ */ new Set(["-C", "-c", "--config-env", "--git-dir", "--work-tree", "--namespace", "--super-prefix"]);
var GLOBAL_FLAGS = /* @__PURE__ */ new Set(["--no-pager", "--paginate", "-P", "-p", "--no-optional-locks", "--literal-pathspecs", "--no-replace-objects"]);
var BRANCH_READ_FLAGS = /^(?:--list|--show-current|-l|-a|--all|-r|--remotes|-v|-vv|--verbose|--no-color|--color(?:=.*)?|--format=.*|--sort=.*|--contains(?:=.*)?|--no-contains(?:=.*)?|--merged(?:=.*)?|--no-merged(?:=.*)?|--points-at(?:=.*)?)$/;
function branchReads(arguments_) {
  const flags = arguments_.filter((argument) => argument.startsWith("-"));
  if (!flags.every((flag) => BRANCH_READ_FLAGS.test(flag))) return false;
  return arguments_.every((argument) => argument.startsWith("-")) || arguments_.includes("--list");
}
var CONFIG_READ_ARGUMENTS = /^(?:(?:--global|--local|--system|--worktree) )?(?:(?:--get|--get-all) [^ -][^ ]*|(?:--list|-l))$/;
var TAG_READ_FLAGS = /^(?:--list|-l|--contains(?:=.*)?|--points-at(?:=.*)?|--no-color|--color(?:=.*)?|--format=.*|--sort=.*|--ignore-case|-i|-n\d*)$/;
function tagReads(arguments_) {
  const flags = arguments_.filter((argument) => argument.startsWith("-"));
  return flags.some((flag) => /^(?:--list|-l|--contains|--points-at)(?:=|$)/.test(flag)) && flags.every((flag) => TAG_READ_FLAGS.test(flag));
}
function reflogReads(arguments_) {
  return !arguments_.some((argument) => ["expire", "delete", "drop", "write"].includes(argument));
}
var READ_ARGUMENTS = /* @__PURE__ */ new Map([
  ["branch", branchReads],
  ["worktree", (arguments_) => arguments_[0] === "list"],
  ["remote", (arguments_) => /^(?:-v$|(?:show|get-url)(?: |$))/.test(arguments_.join(" "))],
  ["config", (arguments_) => CONFIG_READ_ARGUMENTS.test(arguments_.join(" "))],
  ["tag", tagReads],
  ["stash", (arguments_) => ["list", "show"].includes(arguments_[0] ?? "")],
  ["reflog", reflogReads]
]);
function isReadOnlyGit(subcommand, arguments_) {
  if (arguments_.some((argument) => /^--output(?:=|$)/.test(argument))) return false;
  if (READ_ONLY_SUBCOMMANDS.has(subcommand)) return true;
  return READ_ARGUMENTS.get(subcommand)?.(arguments_) ?? false;
}
function globalFlagWidth(word) {
  if (GLOBAL_VALUE_FLAGS.has(word)) return 2;
  if (GLOBAL_FLAGS.has(word)) return 1;
  return /^(?:--(?:config-env|git-dir|work-tree|namespace|super-prefix)=|-C.|-c.)/.test(word) ? 1 : 0;
}
function gitSubcommandIndex(words) {
  let index = 1;
  while (words[index]?.startsWith("-")) {
    const width = globalFlagWidth(words[index]);
    if (!width) return -1;
    index += width;
  }
  return index < words.length ? index : -1;
}
function gitWordsReadOnly(words) {
  const index = gitSubcommandIndex(words);
  return index > 0 && isReadOnlyGit(words[index], words.slice(index + 1));
}

// src/hooks/shared/shell-writes.ts
var SHELL_TOKEN_RE = /(@"\r?\n[\s\S]*?\r?\n"@|@'\r?\n[\s\S]*?\r?\n'@|"(?:[^"\\`]|[\\`][\s\S]|"")*"|'(?:[^']|'')*')|((?:\d|&)?>>?(?:&\d?)?|&&|\|\||[|;\n])|([^\s|;&<>"']+)|(<<<|<<-?)[ \t]*("[^"\r\n]*"|'[^'\r\n]*'|[^\s|;&<>"']+)?/g;
function unquote(word) {
  return word.replace(/^(["'])([\s\S]*)\1$/, "$2");
}
function heredocEnd(command, start, heredoc) {
  const terminator = heredoc.terminator.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const indentation = heredoc.stripTabs ? "\\t*" : "";
  const ending = new RegExp(`^${indentation}${terminator}\\r?(?:\\n|$)`, "m");
  const match = ending.exec(command.slice(start));
  return match ? start + match.index + match[0].length : command.length;
}
function recordHeredoc(match, heredocs) {
  if (match[4] === "<<<" || match[5] === void 0) return;
  heredocs.push({ terminator: unquote(match[5]), stripTabs: match[4] === "<<-" });
}
var SEGMENT_OPERATORS = /* @__PURE__ */ new Set(["&&", "||", "|", ";", "\n"]);
var NULL_SINKS = /* @__PURE__ */ new Set(["/dev/null", "nul", "$null"]);
function operands(words) {
  return words.slice(1).filter((word) => !word.startsWith("-"));
}
function gitWriteTargets(words) {
  const flagIndex = words.indexOf("-C");
  const directory = flagIndex > 0 ? words[flagIndex + 1] : ".";
  return gitWordsReadOnly(words) ? [] : [directory || "."];
}
var SED_SCRIPT_FLAGS = /* @__PURE__ */ new Set(["-e", "--expression", "-f", "--file"]);
function inPlaceEditTargets(words) {
  if (!words.some((word) => /^-[a-z]*i/i.test(word))) return [];
  const fileOperands = words.slice(1).filter((word, index, rest) => word && !word.startsWith("-") && !SED_SCRIPT_FLAGS.has(rest[index - 1] ?? ""));
  return words.some((word) => SED_SCRIPT_FLAGS.has(word)) ? fileOperands : fileOperands.slice(1);
}
function contentCmdletTargets(words) {
  const pathFlag = words.findIndex((word) => /^-(path|literalpath|filepath)$/i.test(word));
  if (pathFlag > 0) return words.slice(pathFlag + 1, pathFlag + 2);
  return words.slice(1).filter((word, index) => !word.startsWith("-") && !/^-(value|encoding|itemtype|width|name)$/i.test(words[index])).slice(0, 1);
}
var WRITE_TARGET_READERS = new Map([
  ...[
    "rm",
    "rmdir",
    "mv",
    "touch",
    "mkdir",
    "tee",
    "truncate",
    "chmod",
    "chown",
    "unlink",
    "remove-item",
    "move-item",
    "rename-item",
    "clear-content",
    "ri",
    "del",
    "erase",
    "rd",
    "md",
    "move",
    "ren"
  ].map((name) => [name, operands]),
  ...["set-content", "add-content", "out-file", "new-item", "ni"].map((name) => [name, contentCmdletTargets]),
  ...["cp", "copy", "copy-item", "ln", "install", "rsync"].map((name) => [name, (words) => operands(words).slice(-1)]),
  ["sed", inPlaceEditTargets],
  ["perl", inPlaceEditTargets],
  ["git", gitWriteTargets]
]);
function commandName(words) {
  return (words[0] || "").split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, "");
}
function isGitMutation(words) {
  return commandName(words) === "git" && gitWriteTargets(words).length > 0;
}
function commandWriteTargets(words) {
  const reader = WRITE_TARGET_READERS.get(commandName(words));
  return reader ? reader(words) : [];
}
function shellToken(match) {
  return match[2] ? { operator: match[2] } : { word: unquote(match[1] || match[3]) };
}
function shellTokens(command) {
  const lexer = new RegExp(SHELL_TOKEN_RE);
  const tokens = [];
  const heredocs = [];
  let match;
  while ((match = lexer.exec(command)) !== null) {
    if (match[4]) {
      recordHeredoc(match, heredocs);
      continue;
    }
    tokens.push(shellToken(match));
    if (match[2] === "\n") {
      lexer.lastIndex = heredocs.reduce((start, heredoc) => heredocEnd(command, start, heredoc), lexer.lastIndex);
      heredocs.length = 0;
    }
  }
  return tokens;
}
function shellSegments(command) {
  const segments = [{ words: [], redirects: [] }];
  let pendingRedirect = false;
  for (const token of shellTokens(command)) {
    const segment = segments[segments.length - 1];
    if ("word" in token) {
      (pendingRedirect ? segment.redirects : segment.words).push(token.word);
      pendingRedirect = false;
    } else if (SEGMENT_OPERATORS.has(token.operator)) {
      segments.push({ words: [], redirects: [] });
    } else {
      pendingRedirect = !token.operator.includes("&", 1);
    }
  }
  return segments;
}
function ignoredTarget(word) {
  return !word || word.startsWith("$") || NULL_SINKS.has(word.toLowerCase());
}

// src/lib/evidence-writes.ts
function within(root, target) {
  const relative = import_node_path2.default.relative(canonicalPath(root), canonicalPath(target));
  return relative !== ".." && !relative.startsWith(`..${import_node_path2.default.sep}`) && !import_node_path2.default.isAbsolute(relative);
}
function protectedRoots(scope) {
  return [scope.evidenceRepositoryRoot, scope.worktree].filter((root) => Boolean(root));
}
function evidencePathAllowed(target, scope) {
  if (!scope.evidenceMode || !import_node_path2.default.isAbsolute(target)) return false;
  if (protectedRoots(scope).some((root) => within(root, target))) return false;
  return (scope.evidenceWriteRoots ?? []).some((root) => within(root, target));
}
function refusal(scope) {
  return `sidequest: evidence executor may write only under admitted roots: ${(scope.evidenceWriteRoots ?? []).join(", ") || "(no live evidence scope)"}. Repository paths remain forbidden. Close through done, without commit or submit.`;
}
function nativeTarget(base, target) {
  const native = process.platform === "win32" ? target.replace(/^\/([a-z])(\/|$)/i, "$1:/") : target;
  return import_node_path2.default.resolve(base, native);
}
function segmentTargets(segment, base) {
  return [...segment.redirects, ...commandWriteTargets(segment.words)].filter((target) => !ignoredTarget(target)).map((target) => nativeTarget(base, target));
}
function changedDirectory(segment, base) {
  return segment.words[0] === "cd" && segment.words[1] ? nativeTarget(base, segment.words[1]) : base;
}
function segmentForbidden(segment, base, scope) {
  return isGitMutation(segment.words) || segmentTargets(segment, base).some((target) => !evidencePathAllowed(target, scope));
}
function shellDenial(command, cwd, scope) {
  let base = cwd;
  for (const segment of shellSegments(command)) {
    base = changedDirectory(segment, base);
    if (segmentForbidden(segment, base, scope)) return refusal(scope);
  }
  return null;
}
function fileDenial(input, _cwd, scope) {
  return evidencePathAllowed(String(input.file_path ?? input.path ?? ""), scope) ? null : refusal(scope);
}
var TOOL_GUARDS = {
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

// src/hooks/guard-evidence-write.ts
function main() {
  const input = readStdin();
  if (!input) throw new Error("evidence guard requires a snapshot-bound request");
  const scope = isRecord(input.scope) ? input.scope : {};
  const argumentsInput = isRecord(input.tool_input) ? input.tool_input : {};
  const denial = evidenceToolDenial(stringField(input, "tool_name"), argumentsInput, stringField(input, "cwd"), scope);
  if (denial) writeDeny("PreToolUse", denial);
}
main();
