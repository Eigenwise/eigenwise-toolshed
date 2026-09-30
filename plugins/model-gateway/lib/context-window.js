'use strict';

const {
  CONTEXT_WINDOW_BACKENDS, CONTEXT_WINDOW_MAX, CONTEXT_WINDOW_MIN, capCompactTrigger, codexBillingNote,
  parseContextWindowValue,
} = require('./runtime.js');
const { readSettingsForWrite, writeSettings } = require('./settings-wiring.js');

// Claude Code 2.1.286 compacts at its window minus a 20k output reserve and a 13k buffer.
const CLAUDE_COMPACT_OFFSET = 33000;
const CLAUDE_FULL_WINDOW = 1000000;

function contextWindowUpdate(option, rawValue) {
  const backend = String(option).replace(/^--/, '');
  if (option === backend || !CONTEXT_WINDOW_BACKENDS.includes(backend)) {
    return { error: 'context-window expects --claude, --codex, or --grok followed by a token count or full' };
  }
  const value = parseContextWindowValue(backend, rawValue);
  if (value === null) {
    return { error: `invalid ${backend} context window "${rawValue}": use full or a whole number of tokens from ${CONTEXT_WINDOW_MIN[backend]} to ${CONTEXT_WINDOW_MAX}` };
  }
  return { backend, value };
}

function savedContextWindows(windows) {
  return Object.fromEntries(CONTEXT_WINDOW_BACKENDS
    .filter((backend) => windows[backend].source === 'saved')
    .map((backend) => [backend, windows[backend].value]));
}

function gatewayWindowNote(backend, cap) {
  const compaction = cap ? `compacts past ${capCompactTrigger(cap)}` : null;
  const billing = backend === 'codex' ? codexBillingNote(cap) : null;
  return [compaction, billing].filter(Boolean).join('; ') || null;
}

function gatewayWindowLine(backend, setting) {
  const cap = Number.isInteger(setting.value) ? setting.value : null;
  const window = cap ? `${cap} cap` : 'full (each model\'s backend window, compacting 40000 below it)';
  const note = gatewayWindowNote(backend, cap);
  return `${backend}: ${window} [${setting.source}]${note ? `; ${note}` : ''}`;
}

// autoCompactWindow is one number for the whole session, so any value in effect bounds Codex and Grok too.
function claudeWindowDescription(value) {
  return Number.isInteger(value) ? `${value} (autoCompactWindow in project-wired settings)` : 'full (1M through the [1m] alias pins)';
}

function claudeWindowLine(setting, autoCompact) {
  const window = Number.isInteger(setting.value) ? setting.value : CLAUDE_FULL_WINDOW;
  const capped = Boolean(autoCompact) && autoCompact.window < window;
  const effective = capped ? autoCompact.window : window;
  const capNote = capped ? `; autoCompactWindow ${autoCompact.window} from ${autoCompact.source} caps this session` : '';
  return `claude: ${claudeWindowDescription(setting.value)} [${setting.source}]${capNote}; compacts near ${effective - CLAUDE_COMPACT_OFFSET}`;
}

function contextWindowReport(windows, autoCompact) {
  return [
    claudeWindowLine(windows.claude, autoCompact),
    gatewayWindowLine('codex', windows.codex),
    gatewayWindowLine('grok', windows.grok),
  ];
}

function claudeWindowOwned(current, owned, next) {
  return current === undefined || current === owned || current === next;
}

function applyClaudeWindow(settings, next) {
  const current = settings.autoCompactWindow;
  if (next === 'full') delete settings.autoCompactWindow;
  else settings.autoCompactWindow = next;
  return current !== settings.autoCompactWindow;
}

// Only a value the gateway wrote (the previous saved cap) is replaced or removed; any other value is the user's.
function syncClaudeContextWindowFile(file, owned, next) {
  let settings;
  try { settings = readSettingsForWrite(file); } catch (error) { return { kind: 'skipped', file, reason: error.message }; }
  if (!claudeWindowOwned(settings.autoCompactWindow, owned, next)) {
    return { kind: 'skipped', file, reason: `autoCompactWindow ${settings.autoCompactWindow} is not gateway-owned` };
  }
  if (!applyClaudeWindow(settings, next)) return null;
  writeSettings(file, settings);
  return { kind: 'changed', file };
}

function syncClaudeContextWindow(files, { owned, next }) {
  const result = { changed: [], skipped: [] };
  for (const file of files) {
    const outcome = syncClaudeContextWindowFile(file, owned, next);
    if (outcome) result[outcome.kind].push(outcome);
  }
  return result;
}

module.exports = {
  contextWindowReport, contextWindowUpdate, gatewayWindowNote, savedContextWindows, syncClaudeContextWindow,
};
