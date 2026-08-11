'use strict';

const MAX_SAMPLES = 12;
const QUOTE_CHARS = 300;
const TOP_LIMIT = 15;
const TITLE_CHARS = 120;
const ASK_CHARS = 240;
const GOAL_CHARS = 300;

// Openers that mean the previous turn went the wrong way, matched at the start of the prompt where
// a correction almost always lands, so an incidental "actually" mid-paragraph does not trip it.
const CORRECTION_OPENERS = /^\s*(?:no\b|nope\b|stop\b|wrong\b|don'?t\b|do not\b|actually\b|not (?:like )?that\b|that'?s not\b|revert\b|undo\b|never\b|please (?:don'?t|stop)\b)/i;
const CORRECTION_PHRASES = /\b(?:i (?:already )?(?:told|said|asked)|you keep|again,|why did you|i didn'?t ask|that'?s wrong|not what i)\b/i;

// A prompt that opens with a markup tag is the harness talking, not the user: a slash-command
// wrapper, piped command output, a hook's injected line. Taking one of these as the opening ask
// reports "/clear" back as what the user wanted.
const HARNESS_PROMPT = /^\s*<[a-z][a-z-]*>/i;

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

// Directories that hold throwaway work, and per-session identifiers, both of which would otherwise
// rank as areas the user was working in. A scratch file is written to be deleted; its path says
// nothing about the purpose it served.
const THROWAWAY_SEGMENTS = new Set(['scratchpad', 'tmp', 'temp', 'node_modules', '__pycache__', '.venv', '.git']);
const OPAQUE_SEGMENT = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$|^[0-9a-f]{16,}$/i;

/**
 * Reduces a touched file to the area it lives in, as the two directory segments closest to it
 * ("poker_ai/hand_history"). Taking the tail rather than the head keeps this meaningful for
 * absolute paths and identical across machines, where a leading drive or home directory is not.
 * Returns null for scratch space, so a session's temp directory cannot outrank its real work.
 */
function areaOf(filePath) {
  const normalized = String(filePath ?? '').replace(/\\/g, '/');
  if (!normalized.includes('/')) return null;
  const segments = normalized.split('/').filter(Boolean);
  segments.pop();
  if (segments.some((segment) => THROWAWAY_SEGMENTS.has(segment.toLowerCase()) || OPAQUE_SEGMENT.test(segment))) {
    return null;
  }
  return segments.length ? segments.slice(-2).join('/') : null;
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
  const areas = new Map();
  const goalsByCondition = new Map();
  const totals = { interrupts: 0, apiErrors: 0, toolErrors: 0, denials: 0, webSearches: 0 };
  let lastAction = null;

  const sessionTally = (sessionId) => {
    const entry = perSession.get(sessionId)
      ?? { ...emptyTally(), firstMs: null, lastMs: null, title: null, openingAsk: null, goal: null };
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
        case 'session_title':
          if (event.title && !tally.title) tally.title = clip(event.title, TITLE_CHARS);
          return;
        case 'goal': {
          if (!event.condition) return;
          const condition = clip(event.condition, GOAL_CHARS);
          // goal_status repeats every turn while a goal is open, so dedupe by condition and let a
          // single met:true win: a goal that was ever satisfied is not an unmet goal.
          if (!tally.goal) tally.goal = { condition, met: event.met === true };
          else if (event.met === true) tally.goal.met = true;
          const existing = goalsByCondition.get(condition);
          if (!existing) goalsByCondition.set(condition, { met: event.met === true, sessionId: event.sessionId });
          else if (event.met === true) existing.met = true;
          return;
        }
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
          bump(areas, areaOf(event.input?.file_path), event.sessionId);
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
          // The opening ask is the fallback when a session has no title: it is what the user came
          // in wanting, before any of the work reshaped it.
          if (!tally.openingAsk && !HARNESS_PROMPT.test(text)) tally.openingAsk = clip(text, ASK_CHARS);
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
          title: tally.title,
          openingAsk: tally.openingAsk,
          goal: tally.goal,
          // A session nobody typed into twice was almost certainly spawned by a hook or a harness.
          // Its title states that machinery's purpose, not the user's, and there are often many
          // more of them than real sessions, so counting titles without this flag would report the
          // automation back to the user as their own goal.
          humanDriven: tally.prompts >= 2,
        }))
        .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));

      const goals = [...goalsByCondition.entries()]
        .map(([condition, entry]) => ({ condition, met: entry.met, sessionId: entry.sessionId }));

      return {
        purpose: {
          goals: {
            set: goals.length,
            met: goals.filter((goal) => goal.met).length,
            samples: goals.slice(0, MAX_SAMPLES),
          },
          areasTop: topOf(areas, 12),
        },
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
