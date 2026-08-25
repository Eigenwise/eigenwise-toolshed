'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { resolveWindow } = require('./scan.js');
const { appendDecision } = require('./state.js');
const { streamTranscript } = require('./stream.js');

const MIN_APPROVALS = 3;
const ENABLED_SETTING = 'autoApprovePermissions';
// Anchoring on the start of the command missed every wrapped form (`sudo rm`,
// `xargs rm`, `find . -exec rm`), so the verb is matched as a word anywhere.
const DESTRUCTIVE_WORD = /^(?:rm|rmdir|rd|del|erase|unlink|shred|rimraf|remove-item|ri|taskkill|kill|killall|pkill|format|mkfs|dd|diskpart|drop|truncate)$/i;
const DESTRUCTIVE_PHRASE = /\bgit\s+(?:push[^\n]*(?:\s--force(?:\b|=)|\s-f\b)|reset\s+--hard\b|clean\b[^\n]*\s-[a-z]*[fdx]|branch[^\n]*\s-D\b|rm\b)|\b(?:docker|kubectl|podman)\s+(?:rm|rmi|delete|prune|system\s+prune)\b|\bnpm\s+unpublish\b|\bfind\b[^\n]*\s-delete\b|\b(?:drop|truncate)\s+(?:table|database)\b/i;

// A rule is a PREFIX wildcard, so it grants far more than the command that
// earned it: `git push origin main` would become `Bash(git push:*)`, which also
// permits `git push --force`. These never get a rule, however often approved.
const ARBITRARY_EXECUTION = /^(?:node|nodejs|deno|bun|python|python2|python3|py|ruby|perl|php|sh|bash|zsh|dash|pwsh|powershell|cmd|wsl|ssh|eval|exec|npx|pnpx|uvx|env|sudo|doas|xargs|start|call)$/i;
const NEEDS_SUBCOMMAND = /^(?:git|docker|podman|kubectl|helm|terraform|aws|gcloud|az|npm|pnpm|yarn|cargo|go|dotnet|gh|systemctl|sc|net)$/i;
const DESTRUCTIVE_FAMILY = /^(?:git\s+(?:push|reset|clean|branch|rm|checkout|restore)|docker\s+\S+|podman\s+\S+|kubectl\s+\S+|npm\s+(?:publish|unpublish|version))$/i;

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

function normalizedCommandPrefix(command) {
  const words = String(command ?? '').trim().replace(/\s+/g, ' ').replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)+/, '').split(' ');
  if (!words[0]) return null;
  const executable = words[0].replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase();
  const subcommand = words[1] && !words[1].startsWith('-') ? words[1].toLowerCase() : null;
  return subcommand ? `${executable} ${subcommand}` : executable;
}

function fingerprintFor(name, input) {
  if (!name) return null;
  if (name === 'Bash') {
    const prefix = normalizedCommandPrefix(input?.command);
    return prefix ? `permission:Bash:${prefix}` : null;
  }
  return `permission:${name}`;
}

function ruleFor(fingerprint) {
  const match = /^permission:Bash:(.+)$/.exec(fingerprint);
  return match ? `Bash(${match[1]}:*)` : fingerprint.slice('permission:'.length);
}

function commandWords(command) {
  return String(command ?? '')
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
// sibling the wildcard would cover.
function ruleTooBroadReason(fingerprint) {
  const match = /^permission:Bash:(.+)$/.exec(fingerprint);
  if (!match) return null;
  const prefix = match[1];
  const [executable] = prefix.split(' ');
  if (ARBITRARY_EXECUTION.test(executable)) return 'arbitrary execution';
  if (!prefix.includes(' ') && NEEDS_SUBCOMMAND.test(executable)) return 'bare tool';
  if (DESTRUCTIVE_FAMILY.test(prefix)) return 'wildcard would cover destructive siblings';
  return null;
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
      if (event.denial === 'user-rejected') entry.denials += 1;
      else if (!event.isError) entry.approvals += 1;
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

function arrayBounds(raw, start) {
  let quoted = false;
  let escaped = false;
  let depth = 0;
  for (let index = start; index < raw.length; index += 1) {
    const character = raw[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === '[') depth += 1;
    else if (character === ']') {
      depth -= 1;
      if (!depth) return { start, end: index };
    }
  }
  return null;
}

function appendedArrayValues(raw, bounds, values) {
  const existing = raw.slice(bounds.start + 1, bounds.end).trim();
  const propertyIndent = /(?:^|\n)([ \t]*)[^\n]*$/.exec(raw.slice(0, bounds.start))?.[1] ?? '';
  const closingIndent = /(?:^|\n)([ \t]*)$/.exec(raw.slice(0, bounds.end))?.[1] ?? propertyIndent;
  const itemIndent = `${propertyIndent}  `;
  const prefix = raw.slice(0, bounds.end);
  const trailingWhitespace = /\s*$/.exec(prefix)?.[0] ?? '';
  const comma = existing ? ',' : '';
  const inserted = `\n${values.map((value) => `${itemIndent}${JSON.stringify(value)}`).join(`,\n`)}\n${closingIndent}`;
  return `${prefix.slice(0, prefix.length - trailingWhitespace.length)}${comma}${inserted}${raw.slice(bounds.end)}`;
}

function appendRulesToSettings(projectDir, rules) {
  const file = settingsFile(projectDir);
  const additions = [...new Set(rules)].filter(Boolean);
  if (!additions.length) return [];
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ permissions: { allow: additions } }, null, 2)}\n`, 'utf8');
    return additions;
  }
  const raw = fs.readFileSync(file, 'utf8');
  let settings;
  try {
    settings = JSON.parse(raw);
  } catch {
    throw new Error(`cannot update invalid JSON in ${file}`);
  }
  const existing = Array.isArray(settings.permissions?.allow) ? settings.permissions.allow : [];
  const newRules = additions.filter((rule) => !existing.includes(rule));
  if (!newRules.length) return [];

  const allowMatch = /"allow"\s*:\s*\[/.exec(raw);
  if (allowMatch) {
    const start = allowMatch.index + allowMatch[0].lastIndexOf('[');
    const bounds = arrayBounds(raw, start);
    if (bounds) {
      fs.writeFileSync(file, appendedArrayValues(raw, bounds, newRules), 'utf8');
      return newRules;
    }
  }

  const rootEnd = raw.lastIndexOf('}');
  if (rootEnd < 0) throw new Error(`cannot update invalid JSON in ${file}`);
  const rootHasContent = raw.slice(0, rootEnd).replace(/[\s{]/g, '').length > 0;
  const indent = /(?:^|\n)([ \t]*)\}/.exec(raw.slice(0, rootEnd + 1))?.[1] ?? '';
  const propertyIndent = `${indent}  `;
  const property = `"permissions": {\n${propertyIndent}  "allow": ${JSON.stringify(newRules)}\n${propertyIndent}}`;
  const addition = `${rootHasContent ? ',' : ''}\n${propertyIndent}${property}\n${indent}`;
  fs.writeFileSync(file, `${raw.slice(0, rootEnd)}${addition}${raw.slice(rootEnd)}`, 'utf8');
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

async function applyPermissionAllowlist(options = {}) {
  const projectDir = path.resolve(options.projectPath ?? process.cwd());
  const collected = await collectPermissionDecisions({ ...options, projectPath: projectDir });
  const eligible = collected.decisions.filter((entry) => entry.approvals >= MIN_APPROVALS && entry.denials === 0);
  const blocked = eligible.filter((entry) => entry.destructive);
  // Writing permission rules is the opt-in itself, so a caller that has not
  // enabled the marker only ever gets the report. Without this, `quartermaster
  // allowlist` silently granted permissions in any project it was run in.
  if (!permissionAutomationEnabled(projectDir)) {
    return { projectDir, additions: [], blocked, eligible, applied: false, scanned: collected.window.files.length };
  }
  const added = appendRulesToSettings(projectDir, eligible.filter((entry) => !entry.destructive).map((entry) => ruleFor(entry.fingerprint)));
  const addedRules = new Set(added);
  const additions = eligible.filter((entry) => addedRules.has(ruleFor(entry.fingerprint)));
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
  return { projectDir, additions, blocked, eligible, applied: true, scanned: collected.window.files.length };
}

module.exports = {
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
  settingsFile,
};
