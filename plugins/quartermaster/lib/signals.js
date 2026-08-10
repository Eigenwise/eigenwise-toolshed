'use strict';

const MAX_SAMPLES = 12;
const QUOTE_CHARS = 300;
const TOP_LIMIT = 15;

// Openers that mean the previous turn went the wrong way, matched at the start of the prompt where
// a correction almost always lands, so an incidental "actually" mid-paragraph does not trip it.
const CORRECTION_OPENERS = /^\s*(?:no\b|nope\b|stop\b|wrong\b|don'?t\b|do not\b|actually\b|not (?:like )?that\b|that'?s not\b|revert\b|undo\b|never\b|please (?:don'?t|stop)\b)/i;
const CORRECTION_PHRASES = /\b(?:i (?:already )?(?:told|said|asked)|you keep|again,|why did you|i didn'?t ask|that'?s wrong|not what i)\b/i;

const CORRECTION_THEMES = [
  ['commit/git', /\b(?:commit(?:s|ted|ting)?|push(?:es|ed|ing)?|branch(?:es|ed|ing)?|merg(?:e|es|ed|ing)|rebas(?:e|es|ed|ing)|git)\b/],
  ['scope', /\b(?:scope[ds]?|only|just|don'?t touch|out of scope|stay in)\b/],
  ['style/voice', /\b(?:em dash(?:es)?|voice|tone|wording|phrasing|style|comments?)\b/],
  ['tooling', /\b(?:powershell|bash|scripts?|hooks?|plugins?|skills?|mcp)\b/],
  ['verification', /\b(?:tests?|verif(?:y|ied|ies)|check(?:s|ed)?|prov(?:e|ed|en)|run it)\b/],
];

const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const SUBCOMMAND_EXECUTABLES = new Set([
  'git', 'gh', 'npm', 'pnpm', 'yarn', 'npx', 'cargo', 'docker', 'kubectl', 'claude',
  'dotnet', 'pip', 'uv', 'poetry', 'terraform', 'aws', 'gcloud', 'az',
]);
const SCRIPT_RUNNERS = new Set(['node', 'python', 'python3', 'deno', 'bun', 'bash', 'sh', 'pwsh', 'powershell']);

function clip(text, limit = QUOTE_CHARS) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

function themeOf(text) {
  const value = String(text).toLowerCase();
  for (const [name, pattern] of CORRECTION_THEMES) if (pattern.test(value)) return name;
  return 'general';
}

function basenameOf(token) {
  return String(token).replace(/["']/g, '').replace(/\\/g, '/').split('/').pop();
}

/**
 * Reduces a shell command to a recognizable headline ("git push", "node build.js") so the same
 * habit counts as one entry across sessions regardless of flags, paths, and arguments.
 */
function normalizeCommand(rawCommand) {
  let command = String(rawCommand ?? '').trim();
  command = command.replace(/^(?:\w+=\S+\s+)+/, '');
  // "cd <path> && <real command>" is a wrapper, not the habit itself.
  command = command.replace(/^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/, '');
  const tokens = command.split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;
  const executable = basenameOf(tokens[0]).toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');
  const next = tokens.find((token, index) => index > 0 && !token.startsWith('-') && !/["'{(]/.test(token[0]));
  if (SCRIPT_RUNNERS.has(executable)) {
    // Inline scripts (node -e, python -c) have no script file; the runner alone is the habit.
    const script = next && /\.\w+$/.test(basenameOf(next)) ? basenameOf(next) : null;
    return script ? `${executable} ${script}` : executable;
  }
  if (SUBCOMMAND_EXECUTABLES.has(executable) && next) return `${executable} ${next.toLowerCase()}`;
  return executable;
}

function hostnameOf(url) {
  try {
    return new URL(String(url)).hostname;
  } catch {
    return null;
  }
}

function bump(map, key, sessionId) {
  if (!key) return;
  const entry = map.get(key) ?? { count: 0, sessions: new Set() };
  entry.count += 1;
  if (sessionId) entry.sessions.add(sessionId);
  map.set(key, entry);
}

function topOf(map, limit = TOP_LIMIT) {
  return [...map.entries()]
    .map(([key, entry]) => ({ name: key, count: entry.count, sessions: entry.sessions.size }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

function countsOf(map) {
  const result = {};
  for (const [key, entry] of [...map.entries()].sort((a, b) => b[1].count - a[1].count)) {
    result[key] = entry.count;
  }
  return result;
}

function emptyTally() {
  return { prompts: 0, toolCalls: 0, toolErrors: 0, denials: 0, interrupts: 0, corrections: 0 };
}

/**
 * Single-pass aggregator over every streamed event. Everything it keeps is bounded: counters,
 * top-N maps, and a fixed number of clipped quotes, so the output stays safe to load into context
 * no matter how many transcripts were scanned.
 */
function createSignalCollector() {
  const perSession = new Map();
  const corrections = [];
  const denialTargets = [];
  const denialsByKind = new Map();
  const denialsByTool = new Map();
  const errorsByTool = new Map();
  const hookErrorsByHook = new Map();
  const attributionPlugins = new Map();
  const attributionSkills = new Map();
  const attributionMcpServers = new Map();
  const commands = new Map();
  const webFetchDomains = new Map();
  const totals = { interrupts: 0, apiErrors: 0, toolErrors: 0, denials: 0, webSearches: 0 };
  let lastAction = null;

  const sessionTally = (sessionId) => {
    const entry = perSession.get(sessionId) ?? { ...emptyTally(), firstMs: null, lastMs: null };
    perSession.set(sessionId, entry);
    return entry;
  };

  return {
    onEvent(event) {
      const tally = sessionTally(event.sessionId);
      if (event.timestampMs !== null) {
        if (tally.firstMs === null || event.timestampMs < tally.firstMs) tally.firstMs = event.timestampMs;
        if (tally.lastMs === null || event.timestampMs > tally.lastMs) tally.lastMs = event.timestampMs;
      }

      switch (event.kind) {
        case 'interrupt':
          totals.interrupts += 1;
          tally.interrupts += 1;
          return;
        case 'api_error':
          totals.apiErrors += 1;
          return;
        case 'hook_error':
          bump(hookErrorsByHook, event.hookName, event.sessionId);
          return;
        case 'tool_use': {
          tally.toolCalls += 1;
          lastAction = { name: event.name, target: event.input?.file_path ?? event.input?.command ?? null };
          bump(attributionPlugins, event.attributionPlugin, event.sessionId);
          bump(attributionSkills, event.attributionSkill, event.sessionId);
          bump(attributionMcpServers, event.attributionMcpServer, event.sessionId);
          if (SHELL_TOOLS.has(event.name)) bump(commands, normalizeCommand(event.input?.command), event.sessionId);
          if (event.name === 'WebSearch') totals.webSearches += 1;
          if (event.name === 'WebFetch') bump(webFetchDomains, hostnameOf(event.input?.url), event.sessionId);
          return;
        }
        case 'tool_result': {
          if (event.isError) {
            totals.toolErrors += 1;
            tally.toolErrors += 1;
            bump(errorsByTool, event.name ?? 'unknown', event.sessionId);
          }
          if (event.denial) {
            totals.denials += 1;
            tally.denials += 1;
            bump(denialsByKind, event.denial, event.sessionId);
            bump(denialsByTool, event.name ?? 'unknown', event.sessionId);
            if (denialTargets.length < MAX_SAMPLES) {
              denialTargets.push({
                tool: event.name ?? 'unknown',
                kind: event.denial,
                target: clip(event.input?.command ?? event.input?.file_path ?? '', 160),
                sessionId: event.sessionId,
              });
            }
          }
          return;
        }
        case 'user_prompt': {
          const text = String(event.text ?? '');
          if (text.startsWith('[Request interrupted')) {
            totals.interrupts += 1;
            tally.interrupts += 1;
            return;
          }
          tally.prompts += 1;
          if (!CORRECTION_OPENERS.test(text) && !CORRECTION_PHRASES.test(text)) return;
          tally.corrections += 1;
          if (corrections.length < MAX_SAMPLES * 3) {
            corrections.push({
              quote: clip(text),
              theme: themeOf(text),
              after: lastAction ? clip(`${lastAction.name} ${lastAction.target ?? ''}`, 120) : null,
              sessionId: event.sessionId,
            });
          }
          return;
        }
        default:
      }
    },

    onTranscriptEnd() {},

    finish() {
      const byTheme = new Map();
      for (const correction of corrections) bump(byTheme, correction.theme, correction.sessionId);

      const sessions = [...perSession.entries()]
        .map(([sessionId, tally]) => ({
          sessionId,
          startedAt: tally.firstMs ? new Date(tally.firstMs).toISOString() : null,
          minutes: tally.firstMs && tally.lastMs ? Math.round((tally.lastMs - tally.firstMs) / 60000) : null,
          prompts: tally.prompts,
          toolCalls: tally.toolCalls,
          toolErrors: tally.toolErrors,
          denials: tally.denials,
          interrupts: tally.interrupts,
          corrections: tally.corrections,
        }))
        .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));

      return {
        friction: {
          interrupts: totals.interrupts,
          apiErrors: totals.apiErrors,
          corrections: {
            count: corrections.length,
            byTheme: countsOf(byTheme),
            samples: corrections.slice(0, MAX_SAMPLES),
          },
          denials: {
            total: totals.denials,
            byKind: countsOf(denialsByKind),
            byTool: countsOf(denialsByTool),
            targets: denialTargets,
          },
          toolErrors: { total: totals.toolErrors, byTool: topOf(errorsByTool, 10) },
          hookErrors: countsOf(hookErrorsByHook),
        },
        attribution: {
          plugins: countsOf(attributionPlugins),
          skills: countsOf(attributionSkills),
          mcpServers: countsOf(attributionMcpServers),
        },
        habits: {
          commandsTop: topOf(commands),
          webSearches: totals.webSearches,
          webFetchDomainsTop: topOf(webFetchDomains, 10),
        },
        sessions,
      };
    },
  };
}

/** One-transcript tally for the SessionEnd hook: same collector, reduced to flat counters. */
function tallyFromSignals(signals) {
  const tally = emptyTally();
  for (const session of signals.sessions) {
    tally.prompts += session.prompts;
    tally.toolCalls += session.toolCalls;
    tally.toolErrors += session.toolErrors;
    tally.denials += session.denials;
    tally.interrupts += session.interrupts;
    tally.corrections += session.corrections;
  }
  return tally;
}

module.exports = { clip, createSignalCollector, emptyTally, normalizeCommand, tallyFromSignals, themeOf };
