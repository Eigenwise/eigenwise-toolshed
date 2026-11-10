'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { readInstalled } = require('./catalog.js');
const { resolveWindow } = require('./scan.js');
const { appendDecision, rejectedFingerprints } = require('./state.js');
const { streamTranscript } = require('./stream.js');
const { readProjectSettings, writeProjectSettings } = require('./project-settings.js');

const MIN_APPROVALS = 3;
const ENABLED_SETTING = 'autoApprovePermissions';
// Anchoring on the start of the command missed every wrapped form (`sudo rm`,
// `xargs rm`, `find . -exec rm`), so the verb is matched as a word anywhere.
const DESTRUCTIVE_WORD = /^(?:rm|rmdir|rd|del|erase|unlink|shred|rimraf|remove-item|ri|taskkill|kill|killall|pkill|format|mkfs|dd|diskpart|drop|truncate)$/i;
const DESTRUCTIVE_PHRASE = /\bgit\s+(?:push[^\n]*(?:\s--force(?:\b|=)|\s-f\b)|reset\s+--hard\b|clean\b[^\n]*\s-[a-z]*[fdx]|branch[^\n]*\s-D\b|rm\b)|\b(?:docker|kubectl|podman)\s+(?:rm|rmi|delete|prune|system\s+prune)\b|\bnpm\s+unpublish\b|\bfind\b[^\n]*\s-delete\b|\b(?:drop|truncate)\s+(?:table|database)\b/i;

// A rule is a PREFIX wildcard, so it grants far more than the command that
// earned it: `git push origin main` would become `Bash(git push:*)`, which also
// permits `git push --force`. These never get a rule, however often approved.
// The wrapper family (`nohup`, `timeout`, `nice`, `setsid`, `stdbuf`,
// `command`, `builtin`, `watch`, `script`, `chroot`) is included because a
// wrapper in the executable slot otherwise hides the real interpreter one
// word over, where nothing checks it. `source` and `.` run a file's contents
// in the current shell, the same blast radius as `bash script.sh`.
const ARBITRARY_EXECUTION = /^(?:node|nodejs|deno|bun|python|python2|python3|py|ruby|perl|php|sh|bash|zsh|dash|pwsh|powershell|cmd|wsl|ssh|eval|exec|npx|pnpx|uvx|env|sudo|doas|xargs|start|call|source|\.|nohup|timeout|nice|setsid|stdbuf|command|builtin|watch|script|chroot)$/i;
const NEEDS_SUBCOMMAND = /^(?:git|docker|podman|kubectl|helm|terraform|aws|gcloud|az|npm|pnpm|yarn|cargo|go|dotnet|gh|systemctl|sc|net)$/i;
const DESTRUCTIVE_FAMILY = /^(?:git\s+(?:push|reset|clean|branch|rm|checkout|restore)|docker\s+\S+|podman\s+\S+|kubectl\s+\S+|npm\s+(?:publish|unpublish|version))$/i;

// A rule anchored on a shell control keyword or a subshell opener grants
// whatever the loop or branch body runs, not the keyword itself.
const SHELL_CONTROL_KEYWORD = /^(?:for|while|until|if|case|select|function|time|coproc)$/i;
// The fingerprint is only ever the first one or two words of the observed
// command, so a separator or operator inside it means the rest of a compound
// command was cut off the fingerprint but not off the permission it grants.
// Redirections (`<`, `>`) are included: they cut a command off from what it
// reads or writes just as surely as a pipe cuts it off from the next stage.
const COMPOUND_OPERATOR = /[;&|<>]/;
// fingerprintFor tests the RAW command against this, before normalization
// truncates it to one or two words: a separator, a newline, or a trailing
// line-continuation backslash further into a longer compound command is
// otherwise silently dropped, and the harmless half in the kept prefix earns
// a rule the rest of the command never sees.
const RAW_COMPOUND_SEPARATOR = /[;&|\r\n]|\\\s*$/;
// `"$w"`, `'$w'`, `$w`, `${w}` and quoted/braced variants: a target or
// argument that resolves only at runtime, from whatever the caller's
// environment happens to hold. The apostrophe is written as \x27: a literal
// one here makes lizard's JS tokenizer misread the character class as an
// unterminated string and miscount every function in the file.
const VARIABLE_ONLY_ARG = /^["\x27]?\$\{?[A-Za-z_][A-Za-z0-9_]*\}?["\x27]?$/;
// `$(...)`, `${...}`, and a backtick all resolve to whatever that subcommand
// prints at runtime, the same reasoning as a bare variable argument. The
// backtick is written as \x60: a literal one here breaks lizard's JS
// tokenizer the same way the apostrophe in VARIABLE_ONLY_ARG used to.
const COMMAND_SUBSTITUTION = /\$\(|\$\{|\x60/;
// A plugin cache path is dead the moment the pinned version updates; a
// scratchpad path is dead the moment the session ends. Both match
// case-insensitively and accept the version/scratchpad segment itself with
// no trailing separator required, not just a path further inside it.
const PLUGIN_CACHE_PATH = /\.claude[\\/]plugins[\\/]cache[\\/][^\\/]+[\\/][^\\/]+[\\/][^\\/]+(?:[\\/]|$)/i;
const SESSION_SCRATCHPAD_PATH = /claude[-\\/][^\\/]+[\\/][\s\S]*[\\/]scratchpad(?:[\\/]|$)/i;
// A glob metacharacter in the kept argument (`ls foo/*.test.ts`) is spliced
// verbatim ahead of the `:*` suffix by ruleFor, and Claude Code reads that `*`
// literally rather than as a glob, so the rule can never match the command that
// earned it. The rule is dead on arrival, so the fingerprint earns none.
const GLOB_ARGUMENT = /[*?[\]]/;
// A shell word: unquoted characters, backslash escapes, and whole quoted
// spans. Quotes are \x22 and \x27 for the lizard reason given above.
const SHELL_WORD = /(?:[^\s\x22\x27\\]|\\[\s\S]|\x22(?:[^\x22\\]|\\[\s\S])*\x22|\x27[^\x27]*\x27)+/g;
// An escape is matched before a quote can open, so `\"` never starts a span.
const QUOTED_SPAN_OR_ESCAPE = /\\[\s\S]|\x22(?:[^\x22\\]|\\[\s\S])*\x22|\x27[^\x27]*\x27/g;
const ENVIRONMENT_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
// The kept second word must read as a subcommand (`npm run`, `git status`),
// never a file, a path, a quoted string, or a generated name: those pin the
// rule to one session's worktree, scratchpad, or file (GH-457).
const STABLE_SUBCOMMAND = /^[A-Za-z][A-Za-z0-9_-]*$/;
const GENERATED_IDENTIFIER = /(?=[0-9a-f]*\d)[0-9a-f]{8,}/i;
const PATH_OR_QUOTED_EXECUTABLE = /^[\x22\x27]|[\\/]/;
// The host stamps `permissionDecision.source` on each tool result; before it
// did, only the session's permission mode tells an auto approval apart.
const AUTO_APPROVING_MODE = /^(?:auto|bypassPermissions|dontAsk)$/;
const PLUGIN_TOOL_FINGERPRINT = /^permission:mcp__plugin_/;

function settingsFile(projectDir) {
  return path.join(projectDir, '.claude', 'settings.local.json');
}

function readSettings(projectDir) {
  try {
    const raw = fs.readFileSync(settingsFile(projectDir), 'utf8');
    const settings = JSON.parse(raw);
    return settings && typeof settings === 'object' ? settings : {};
  } catch {
    return {};
  }
}

function permissionAutomationEnabled(projectDir) {
  return readSettings(projectDir).quartermaster?.[ENABLED_SETTING] === true;
}

// Unbalanced quotes yield no words at all: what the shell would run is
// unknowable, so nothing is learned from it.
function shellWords(command) {
  const text = String(command ?? '').trim();
  if (text.replace(SHELL_WORD, '').trim()) return [];
  const words = text.match(SHELL_WORD) ?? [];
  const start = words.findIndex((word) => !ENVIRONMENT_ASSIGNMENT.test(word));
  return start < 0 ? [] : words.slice(start);
}

function withoutQuotedData(command) {
  return String(command ?? '').replace(QUOTED_SPAN_OR_ESCAPE, (span) => (span.startsWith('\\') ? span : '""'));
}

// Words keep their quotes and their path: Claude Code matches a rule against
// the command as typed, so `Bash(Blender":*)` or a basename-only rule for a
// path-invoked script never matches again (GH-521). The veto below refuses
// both instead. Case is kept for the same literal-match reason; the veto
// regexes compare with an `i` flag rather than lowercasing here.
function normalizedCommandPrefix(command) {
  const [first, second] = shellWords(command);
  if (!first) return null;
  const executable = first.replace(/\.exe$/i, '');
  return second && !second.startsWith('-') ? `${executable} ${second}` : executable;
}

function fingerprintFor(name, input) {
  if (!name) return null;
  if (name === 'Bash') {
    const command = input?.command;
    // Checked on the whole command, before normalizedCommandPrefix truncates
    // it to a word or two: a separator, newline, or trailing backslash
    // anywhere outside a quoted string means the rest of it is unaccounted
    // for, so it earns no fingerprint at all.
    if (RAW_COMPOUND_SEPARATOR.test(withoutQuotedData(command))) return null;
    const prefix = normalizedCommandPrefix(command);
    return prefix ? `permission:Bash:${prefix}` : null;
  }
  return `permission:${name}`;
}

function ruleFor(fingerprint) {
  const match = /^permission:Bash:(.+)$/.exec(fingerprint);
  return match ? `Bash(${match[1]}:*)` : fingerprint.slice('permission:'.length);
}

// A quoted argument is data (`grep -F "drop"`), so only unquoted words are
// tested as commands (GH-397). DESTRUCTIVE_PHRASE still reads the whole
// command: `psql db -c "drop table t"` hands that quoted SQL to a client.
function commandWords(command) {
  return withoutQuotedData(command)
    .split(/[\s;&|(){}<>]+/)
    .filter(Boolean)
    .map((word) => word.replace(/^.*[\\/]/, '').replace(/\.exe$/i, ''));
}

function isDestructive(input) {
  const command = String(input?.command ?? '');
  return commandWords(command).some((word) => DESTRUCTIVE_WORD.test(word)) || DESTRUCTIVE_PHRASE.test(command);
}

// The rule, not the observed command, is what gets granted, so it carries its
// own veto: anything that runs caller-supplied code, a bare tool whose
// subcommands differ wildly in blast radius, or a family with a destructive
// sibling the wildcard would cover. Each check is independent of the others,
// so they are walked as a table by a single `find` rather than a chain of
// ifs; add the next veto class by adding the next row.
const TOO_BROAD_RULES = [
  // A loop or branch keyword, or a `{`/`(` subshell opener, grants its whole
  // body, not the keyword: the body is arbitrary execution the fingerprint
  // never captures.
  {
    reason: 'shell control keyword',
    test: ({ executable }) => SHELL_CONTROL_KEYWORD.test(executable) || executable.startsWith('{') || executable.startsWith('('),
  },
  // The fingerprint is a two-word slice of a longer, still-attached compound
  // command; a separator or redirection proves the harmless half was cut off
  // mid-command.
  {
    reason: 'compound command fragment',
    test: ({ prefix }) => COMPOUND_OPERATOR.test(prefix) || prefix.endsWith('\\'),
  },
  // `cd` with no target, or a target that only resolves at runtime, goes
  // wherever that variable happened to point when it was approved.
  {
    reason: 'variable or empty cd target',
    test: ({ executable, firstArg }) => executable.toLowerCase() === 'cd' && (!firstArg || VARIABLE_ONLY_ARG.test(firstArg)),
  },
  // Any other first argument that is nothing but a bare variable reference is
  // just as runtime-dependent, regardless of which command it follows.
  {
    reason: 'bare shell variable argument',
    test: ({ firstArg }) => Boolean(firstArg) && VARIABLE_ONLY_ARG.test(firstArg),
  },
  // A glob metacharacter in the argument makes ruleFor emit a literal-`*`
  // prefix that Claude Code never matches, so the rule is written dead; veto it
  // rather than let a fresh one accrete for every distinct `cmd path/*` command.
  {
    reason: 'glob argument',
    test: ({ firstArg }) => Boolean(firstArg) && GLOB_ARGUMENT.test(firstArg),
  },
  // A command substitution resolves to whatever that subcommand prints,
  // same reasoning as a bare variable, just not anchored to one argument.
  {
    reason: 'command substitution',
    test: ({ prefix }) => COMMAND_SUBSTITUTION.test(prefix),
  },
  // A version-pinned plugin cache path or per-session scratchpad path is dead
  // the instant the version bumps or the session ends.
  {
    reason: 'version-pinned or session-scoped path',
    test: ({ prefix }) => PLUGIN_CACHE_PATH.test(prefix) || SESSION_SCRATCHPAD_PATH.test(prefix),
  },
  // A wrapper word or the interpreter itself, anywhere in the prefix, runs
  // caller-supplied code; a bare wrapper alone grants the wrapped command.
  {
    reason: 'arbitrary execution',
    test: ({ words }) => words.some((word) => ARBITRARY_EXECUTION.test(word)),
  },
  {
    reason: 'bare tool',
    test: ({ prefix, executable }) => !prefix.includes(' ') && NEEDS_SUBCOMMAND.test(executable),
  },
  {
    reason: 'wildcard would cover destructive siblings',
    test: ({ prefix }) => DESTRUCTIVE_FAMILY.test(prefix),
  },
  // A rule matches the command as typed, so a path or quoted executable earns
  // a rule that only fits that one spelling, and a basename rule fits none.
  {
    reason: 'path-invoked or quoted executable',
    test: ({ executable }) => PATH_OR_QUOTED_EXECUTABLE.test(executable),
  },
  // A bare executable grants every argument: `Bash(curl:*)` also allows
  // `curl -T ~/.ssh/id_rsa`, `Bash(sed:*)` allows `sed -i`. Growing the veto
  // list one executable at a time never closes that, so none is learned.
  {
    reason: 'bare executable without a subcommand',
    test: ({ firstArg }) => !firstArg,
  },
  {
    reason: 'argument is a file, path, or generated name, not a subcommand',
    test: ({ firstArg }) => !STABLE_SUBCOMMAND.test(firstArg) || GENERATED_IDENTIFIER.test(firstArg),
  },
];

function ruleTooBroadReason(fingerprint) {
  if (fingerprint === 'permission:PowerShell') return 'unsafe shell rule';
  const match = /^permission:Bash:(.+)$/.exec(fingerprint);
  if (!match) return null;
  const prefix = match[1];
  const words = prefix.split(' ');
  const [executable, ...rest] = words;
  const firstArg = rest.length ? rest.join(' ') : null;
  const rule = TOO_BROAD_RULES.find((entry) => entry.test({ prefix, executable, firstArg, words }));
  return rule ? rule.reason : null;
}

function ruleIsBlocked(entry) {
  const vetoReason = ruleTooBroadReason(entry.fingerprint);
  if (vetoReason) {
    entry.destructive = true;
    entry.vetoReason = vetoReason;
  }
  return entry.destructive;
}

function bumpHookBlocks(entry) {
  entry.hookBlocks = (entry.hookBlocks ?? 0) + 1;
}

// A hook block is not a rejection of the fingerprint itself, so it must not count as a denial (that
// would misreport why the candidate was excluded) or as an approval (the call did not go through).
// It gets its own counter, left absent until the first sighting, so a hook-blocked fingerprint is
// kept off the allowlist without inventing a false denial reason for it.
// An approval the host granted from config, the auto-mode classifier, or a
// bypassing mode was never put to the user, so it says nothing about what the
// user would allow (GH-481).
function approvedByUser(event) {
  const source = event.permissionDecision?.source;
  if (source) return String(source).startsWith('user');
  return !AUTO_APPROVING_MODE.test(event.permissionMode ?? '');
}

function recordOutcome(entry, event) {
  if (event.denial === 'user-rejected') entry.denials += 1;
  else if (event.denial === 'hook_block') bumpHookBlocks(entry);
  else if (event.isError) return;
  else if (approvedByUser(event)) entry.approvals += 1;
  else entry.automaticApprovals += 1;
}

function createPermissionCollector() {
  const fingerprints = new Map();
  const see = (name, input) => {
    const fingerprint = fingerprintFor(name, input);
    if (!fingerprint) return null;
    let entry = fingerprints.get(fingerprint);
    if (!entry) {
      const vetoReason = ruleTooBroadReason(fingerprint);
      entry = {
        fingerprint,
        input,
        approvals: 0,
        automaticApprovals: 0,
        denials: 0,
        destructive: Boolean(vetoReason),
        vetoReason,
        destructiveCommand: null,
      };
      fingerprints.set(fingerprint, entry);
    }
    // One destructive sighting condemns the fingerprint: `git push origin main`
    // and `git push --force` share a prefix, and the first must not earn a rule
    // that covers the second.
    if (isDestructive(input)) {
      entry.destructive = true;
      entry.destructiveCommand ??= String(input?.command ?? '');
    }
    return entry;
  };
  return {
    onEvent(event) {
      if (event.kind !== 'tool_result') return;
      const entry = see(event.name, event.input);
      if (!entry) return;
      recordOutcome(entry, event);
    },
    onTranscriptEnd() {},
    entries() { return [...fingerprints.values()]; },
  };
}

async function collectPermissionDecisions(options = {}) {
  const window = resolveWindow(options);
  const collector = createPermissionCollector();
  for (const source of window.files) {
    try {
      await streamTranscript(source, collector);
    } catch {
      // An active or truncated transcript cannot make the pass fail open.
    }
  }
  return { window, decisions: collector.entries() };
}

function appendRulesToSettings(projectDir, rules) {
  const additions = [...new Set(rules)].filter(Boolean);
  if (!additions.length) return [];
  let settings;
  try {
    settings = readProjectSettings(projectDir);
  } catch {
    throw new Error(`cannot update invalid JSON in ${settingsFile(projectDir)}`);
  }
  const existing = Array.isArray(settings.permissions?.allow) ? settings.permissions.allow : [];
  const newRules = additions.filter((rule) => !existing.includes(rule));
  if (!newRules.length) return [];

  settings.permissions = { ...settings.permissions, allow: [...existing, ...newRules] };
  writeProjectSettings(projectDir, settings);
  return newRules;
}

function enablePermissionAutomation(projectDir) {
  const file = settingsFile(projectDir);
  const settings = readSettings(projectDir);
  if (settings.quartermaster?.[ENABLED_SETTING] === true) return false;
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ quartermaster: { [ENABLED_SETTING]: true } }, null, 2)}\n`, 'utf8');
    return true;
  }
  const raw = fs.readFileSync(file, 'utf8');
  const rootEnd = raw.lastIndexOf('}');
  if (rootEnd < 0) throw new Error(`cannot update invalid JSON in ${file}`);
  const rootHasContent = raw.slice(0, rootEnd).replace(/[\s{]/g, '').length > 0;
  const indent = /(?:^|\n)([ \t]*)\}/.exec(raw.slice(0, rootEnd + 1))?.[1] ?? '';
  const propertyIndent = `${indent}  `;
  const addition = `${rootHasContent ? ',' : ''}\n${propertyIndent}"quartermaster": { "${ENABLED_SETTING}": true }\n${indent}`;
  fs.writeFileSync(file, `${raw.slice(0, rootEnd)}${addition}${raw.slice(rootEnd)}`, 'utf8');
  return true;
}

function installedPluginToolPrefixes(env) {
  return readInstalled(env).map((plugin) => `permission:mcp__plugin_${plugin.name.replace(/[^A-Za-z0-9_-]/g, '_')}_`);
}

function skipReasonFor(entry, ledger) {
  if (ledger.rejected.has(entry.fingerprint)) return 'rejected in the decision ledger';
  const fromMissingPlugin = PLUGIN_TOOL_FINGERPRINT.test(entry.fingerprint)
    && !ledger.installedToolPrefixes.some((prefix) => entry.fingerprint.startsWith(prefix));
  return fromMissingPlugin ? 'its plugin is no longer installed' : null;
}

// A rejection recorded in the ledger silences the rule for good, the same
// promise resupply makes, and a removed plugin's tools stay in the 30-day
// transcript window after the tools themselves are gone (GH-469).
function setAsideSkipped(candidates, options, projectDir) {
  const ledger = {
    rejected: new Set(rejectedFingerprints(options.env, projectDir).rejected),
    installedToolPrefixes: installedPluginToolPrefixes(options.env),
  };
  for (const entry of candidates) entry.skipReason = skipReasonFor(entry, ledger);
  return candidates.filter((entry) => entry.skipReason);
}

async function learnPermissionAllowlist(options = {}) {
  const projectDir = path.resolve(options.projectPath ?? process.cwd());
  const collected = await collectPermissionDecisions({ ...options, projectPath: projectDir });
  const candidates = collected.decisions.filter((entry) => entry.approvals >= MIN_APPROVALS && entry.denials === 0 && !entry.hookBlocks);
  const hookBlocked = collected.decisions.filter((entry) => entry.hookBlocks).length;
  for (const entry of candidates) ruleIsBlocked(entry);
  return { candidates, hookBlocked, window: collected.window };
}

function applyLearnedPermissionAllowlist(learning, options = {}) {
  const projectDir = path.resolve(options.projectPath ?? process.cwd());
  const { candidates, hookBlocked } = learning;
  const skipped = setAsideSkipped(candidates, options, projectDir);
  const proposable = candidates.filter((entry) => !entry.skipReason);
  const blocked = proposable.filter(ruleIsBlocked);
  const eligible = proposable.filter((entry) => !ruleIsBlocked(entry));
  // Writing permission rules is the opt-in itself, so a caller that has not
  // enabled the marker only ever gets the report. Without this, `quartermaster
  // allowlist` silently granted permissions in any project it was run in.
  if (!permissionAutomationEnabled(projectDir)) {
    return { projectDir, additions: [], blocked, eligible, skipped, hookBlocked, applied: false, scanned: learning.window.files.length };
  }
  const writable = eligible.filter((entry) => !ruleIsBlocked(entry));
  const added = appendRulesToSettings(projectDir, writable.map((entry) => ruleFor(entry.fingerprint)));
  const addedRules = new Set(added);
  const additions = writable.filter((entry) => addedRules.has(ruleFor(entry.fingerprint)));
  for (const entry of additions) {
    appendDecision({
      projectDir,
      kind: 'permission',
      title: `allow ${ruleFor(entry.fingerprint)}`,
      fingerprint: entry.fingerprint,
      status: 'applied',
      signal: 'denials',
      detail: `auto-approved after ${entry.approvals} approvals`,
      approvals: entry.approvals,
    }, options.env);
  }
  return { projectDir, additions, blocked, eligible, skipped, hookBlocked, applied: true, scanned: learning.window.files.length };
}

async function applyPermissionAllowlist(options = {}) {
  const learning = await learnPermissionAllowlist(options);
  return applyLearnedPermissionAllowlist(learning, options);
}

module.exports = {
  applyLearnedPermissionAllowlist,
  learnPermissionAllowlist,
  ENABLED_SETTING,
  MIN_APPROVALS,
  appendRulesToSettings,
  applyPermissionAllowlist,
  collectPermissionDecisions,
  enablePermissionAutomation,
  fingerprintFor,
  isDestructive,
  normalizedCommandPrefix,
  permissionAutomationEnabled,
  ruleFor,
  ruleTooBroadReason,
  settingsFile,
};
