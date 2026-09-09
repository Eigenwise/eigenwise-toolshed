'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MODES = new Set(['lite', 'full', 'ultra', 'off']);
const policyPath = path.join(__dirname, '..', '..', 'skills', 'whittle', 'SKILL.md');

function readInput() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8')) || {};
  } catch (_) {
    return {};
  }
}

function projectDirectory(input) {
  return path.resolve(input.project_directory || process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd());
}

function sessionId(input) {
  return typeof input.session_id === 'string' && input.session_id.trim() ? input.session_id.trim() : '';
}

function parentSessionId(input) {
  for (const value of [input.parent_session_id, input.parentSessionId, input.parent_session?.id]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function stateRoot() {
  return process.env.WHITTLE_STATE_DIR || path.join(os.homedir(), '.claude', 'whittle');
}

function stateKey(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function projectStateDirectory(projectDir) {
  return path.join(stateRoot(), 'projects', stateKey(projectDir));
}

function sessionStatePath(projectDir, identity) {
  return path.join(projectStateDirectory(projectDir), 'sessions', stateKey(identity) + '.json');
}

function defaultStatePath(projectDir) {
  return path.join(projectStateDirectory(projectDir), 'default.json');
}

function readMode(file) {
  try {
    const mode = JSON.parse(fs.readFileSync(file, 'utf8')).mode;
    return MODES.has(mode) ? mode : '';
  } catch (_) {
    return '';
  }
}

function writeMode(file, mode) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = file + '.' + process.pid + '.' + crypto.randomUUID() + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify({ mode }) + '\n');
    fs.renameSync(temporary, file);
    return true;
  } catch (_) {
    return false;
  }
}

function defaultMode(projectDir) {
  return readMode(defaultStatePath(projectDir)) || 'full';
}

function activeMode(input) {
  const projectDir = projectDirectory(input);
  const identity = sessionId(input);
  return identity ? readMode(sessionStatePath(projectDir, identity)) || defaultMode(projectDir) : defaultMode(projectDir);
}

function selectSessionMode(input, mode) {
  const identity = sessionId(input);
  return identity && MODES.has(mode)
    ? writeMode(sessionStatePath(projectDirectory(input), identity), mode)
    : false;
}

function selectDefaultMode(input, mode) {
  return MODES.has(mode) && writeMode(defaultStatePath(projectDirectory(input)), mode);
}

function section(policy, name) {
  const normalized = policy.replace(/\r\n/g, '\n');
  const header = '## ' + name + '\n';
  const start = normalized.indexOf(header);
  if (start < 0) return '';
  const contentStart = start + header.length;
  const end = normalized.indexOf('\n## ', contentStart);
  return normalized.slice(contentStart, end < 0 ? undefined : end).trim();
}

function instructionsForMode(mode) {
  if (!MODES.has(mode) || mode === 'off') return '';
  try {
    const policy = fs.readFileSync(policyPath, 'utf8');
    const text = [section(policy, 'Shared'), section(policy, mode[0].toUpperCase() + mode.slice(1))].filter(Boolean).join('\n\n');
    return text ? 'Whittle mode: ' + mode + '.\n\n' + text : '';
  } catch (_) {
    return '';
  }
}

function status(mode) {
  return 'Whittle mode: ' + mode + '. Sidequest owns reports and audits; Whittle does not measure gains.';
}

function formatStatusline(mode) {
  return mode === 'off' ? '' : '[WHITTLE:' + mode.toUpperCase() + ']';
}

function promptText(input) {
  return typeof input.user_prompt === 'string' ? input.user_prompt.trim() : typeof input.prompt === 'string' ? input.prompt.trim() : '';
}

function command(input) {
  const prompt = promptText(input).toLowerCase();
  if (prompt === 'stop whittle' || prompt === 'normal mode') return { type: 'mode', mode: 'off' };
  const match = prompt.match(/^\/whittle(?::whittle)?(?:\s+(.*))?$/);
  if (!match) return null;
  const parts = (match[1] || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length || parts[0] === 'status') return { type: 'status' };
  if (parts[0] === 'default' && MODES.has(parts[1])) return { type: 'default', mode: parts[1] };
  if (MODES.has(parts[0])) return { type: 'mode', mode: parts[0] };
  return { type: 'help' };
}

function selectionInstructions(mode, failedSelections) {
  const instructions = instructionsForMode(mode);
  if (!failedSelections.length) return instructions;
  const message = 'Whittle could not save the ' + failedSelections.join(' or ') + ' selection.';
  return instructions ? instructions + '\n\n' + message : message;
}

function handleHook(eventName, input) {
  if (eventName === 'SessionStart') {
    const mode = activeMode(input);
    selectSessionMode(input, mode);
    return instructionsForMode(mode);
  }
  if (eventName === 'SubagentStart') {
    const parentIdentity = parentSessionId(input) || sessionId(input);
    const mode = activeMode({ ...input, session_id: parentIdentity });
    selectSessionMode(input, mode);
    return instructionsForMode(mode);
  }
  if (eventName !== 'UserPromptSubmit') return '';
  const selection = command(input);
  if (!selection) return '';
  if (selection.type === 'status') return status(activeMode(input));
  if (selection.type === 'help') return 'Whittle commands: status, lite, full, ultra, off, or default <mode>. Mode changes persist when the host provides a session identity.';
  const failedSelections = [];
  if (selection.type === 'default' && !selectDefaultMode(input, selection.mode)) failedSelections.push('default');
  if (!selectSessionMode(input, selection.mode)) failedSelections.push('session');
  return selectionInstructions(selection.mode, failedSelections);
}

module.exports = { activeMode, formatStatusline, handleHook, instructionsForMode, readInput };
