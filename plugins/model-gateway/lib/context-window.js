'use strict';

const {
  COMPACT_AT_BACKENDS, CONTEXT_WINDOW_BACKENDS, CONTEXT_WINDOW_MAX, CONTEXT_WINDOW_MIN, MODEL_WINDOW_POLICY,
  gatewayCompactTrigger, codexBillingNote, effectiveSentryPolicy, parseCompactAtValue, parseContextWindowValue,
} = require('./runtime.js');
const { readSettingsForWrite, writeSettings } = require('./settings-wiring.js');

const CLAUDE_FULL_WINDOW = 1000000;

function compactAtUpdate(backend, rawValue) {
  if (!COMPACT_AT_BACKENDS.includes(backend)) {
    return { error: `unsupported compactAt.${backend}: direct compaction maxima are supported for Codex and Grok only; use --claude <tokens|full> for the native window` };
  }
  const value = rawValue === 'cap' ? null : parseCompactAtValue(rawValue);
  if (value === null && rawValue !== 'cap') return { error: `invalid ${backend} compact-at "${rawValue}": use cap or a positive whole token count` };
  return { backend, field: 'compactAt', value };
}

function contextWindowUpdate(option, rawValue) {
  const flag = String(option).replace(/^--/, '');
  if (option === flag) return { error: 'context-window expects --claude, --codex, or --grok followed by a token count or full; --codex-compact-at or --grok-compact-at accepts tokens or cap' };
  if (flag.endsWith('-compact-at')) return compactAtUpdate(flag.slice(0, -'-compact-at'.length), rawValue);
  if (!CONTEXT_WINDOW_BACKENDS.includes(flag)) return { error: 'context-window expects --claude, --codex, or --grok followed by a token count or full; --codex-compact-at or --grok-compact-at accepts tokens or cap' };
  const value = parseContextWindowValue(flag, rawValue);
  if (value === null) {
    return { error: `invalid ${flag} context window "${rawValue}": use full or a whole number of tokens from ${CONTEXT_WINDOW_MIN[flag]} to ${CONTEXT_WINDOW_MAX}` };
  }
  return { backend: flag, field: 'window', value };
}

function savedContextWindows(windows) {
  const saved = Object.fromEntries(CONTEXT_WINDOW_BACKENDS
    .filter((backend) => windows[backend].source === 'saved')
    .map((backend) => [backend, windows[backend].value]));
  const compactAt = Object.fromEntries(COMPACT_AT_BACKENDS
    .filter((backend) => windows[backend].compactAt !== undefined)
    .map((backend) => [backend, windows[backend].compactAt]));
  if (Object.keys(compactAt).length) saved.compactAt = compactAt;
  return saved;
}

function saveContextWindowUpdate(saved, update) {
  if (update.field === 'window') {
    saved[update.backend] = update.value;
    return;
  }
  const compactAt = { ...saved.compactAt, [update.backend]: update.value };
  if (update.value === null) delete compactAt[update.backend];
  if (Object.keys(compactAt).length) saved.compactAt = compactAt;
  else delete saved.compactAt;
}

function gatewayCompactionNote(cap, compactAt, policy, env) {
  if (compactAt === null) return cap ? `compacts past ${gatewayCompactTrigger(cap, null)}` : null;
  const sentry = effectiveSentryPolicy(policy, Number(env.CODEX_GATEWAY_COMPACT_TRIGGER), cap, compactAt);
  return `requested compact-at ${compactAt}; backend window ${sentry.backendWindow}; effective maximum ${sentry.compactTrigger} (${sentry.source}); compacts past ${sentry.compactTrigger}`;
}

function ignoredCompactTriggerNote(compactAt, env) {
  if (compactAt === null || env.CODEX_GATEWAY_COMPACT_TRIGGER === undefined) return null;
  return `CODEX_GATEWAY_COMPACT_TRIGGER=${env.CODEX_GATEWAY_COMPACT_TRIGGER} ignored: compact-at is saved`;
}

function gatewayWindowNote(backend, cap, compactAt = null, policy = Object.values(MODEL_WINDOW_POLICY).find((entry) => entry.backend === backend), env = process.env) {
  const compaction = gatewayCompactionNote(cap, compactAt, policy, env);
  const billing = backend === 'codex' ? codexBillingNote(cap, compactAt) : null;
  return [compaction, ignoredCompactTriggerNote(compactAt, env), billing].filter(Boolean).join('; ') || null;
}

function gatewayWindowLine(backend, setting) {
  const cap = Number.isInteger(setting.value) ? setting.value : null;
  const window = cap ? `${cap} cap` : 'full (each model\'s backend window, compacting 40000 below it)';
  const note = gatewayWindowNote(backend, cap, setting.compactAt);
  return `${backend}: ${window} [${setting.source}]${note ? `; ${note}` : ''}`;
}

function claudeWindowDescription(value) {
  return Number.isInteger(value) ? `${value} (autoCompactWindow in project-wired settings)` : 'full (1M through the [1m] alias pins)';
}

function claudeWindowLine(setting, autoCompact) {
  const window = Number.isInteger(setting.value) ? setting.value : CLAUDE_FULL_WINDOW;
  const effective = Math.min(autoCompact?.window ?? window, window);
  const capNote = effective < window ? `; autoCompactWindow ${autoCompact.window} from ${autoCompact.source} caps this session` : '';
  return `claude: ${claudeWindowDescription(setting.value)} [${setting.source}]${capNote}; native window ${effective}; exact compaction trigger unverified (native engine headroom applies)`;
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
  contextWindowReport, contextWindowUpdate, gatewayWindowNote, savedContextWindows, saveContextWindowUpdate, syncClaudeContextWindow,
};
