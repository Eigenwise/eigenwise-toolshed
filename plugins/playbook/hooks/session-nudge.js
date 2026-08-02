'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_EVERY = 10;
const TRUTHY = new Set(['1', 'on', 'true', 'yes', 'enabled']);

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return {};
  }
}

function enabled(env) {
  return TRUTHY.has(String(env.PLAYBOOK_NUDGE ?? '').trim().toLowerCase());
}

function every(env) {
  const value = Number(env.PLAYBOOK_NUDGE_EVERY);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_EVERY;
}

function projectDir(data, env) {
  return data.cwd || env.CLAUDE_PROJECT_DIR || process.cwd();
}

function stateFile(root, env) {
  const home = env.CLAUDE_CONFIG_DIR ? env.CLAUDE_CONFIG_DIR : path.join(os.homedir(), '.claude');
  const slug = path.resolve(root).replace(/[^a-zA-Z0-9]/g, '-');
  return path.join(home, 'playbook-state', `${slug}.json`);
}

function readState(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

/**
 * Tallies finished sessions and, at the start of a later one, says how many have gone by.
 *
 * The tally is kept at SessionEnd but delivered at SessionStart, because a session that is ending has
 * no context left to inject into: a nudge written there would go nowhere. Counting only, never mining,
 * so ending a session stays instant.
 */
function main() {
  const env = process.env;
  if (!enabled(env)) return;

  const data = readStdin();
  const root = projectDir(data, env);
  const file = stateFile(root, env);
  const state = readState(file);
  const event = data.hook_event_name;

  if (event === 'SessionEnd') {
    const seen = new Set(Array.isArray(state.sessions) ? state.sessions : []);
    if (data.session_id) seen.add(data.session_id);
    writeState(file, { ...state, sessions: [...seen].slice(-200) });
    return;
  }

  const since = Array.isArray(state.sessions) ? state.sessions.length : 0;
  const threshold = every(env);
  if (since < threshold) return;

  const lastRun = state.lastRunAt ? ` Last retro: ${state.lastRunAt}.` : ' No retro has been run for this project yet.';
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext:
        `[playbook] ${since} sessions have ended since the last transcript retro.${lastRun}`
        + ' Suggest running the /playbook:skill-retro skill when the user has a moment; do not start one unprompted.',
    },
  }));
}

try {
  main();
} catch {
  // A nudge is never worth interrupting a session over.
}

module.exports = { enabled, every, stateFile };
