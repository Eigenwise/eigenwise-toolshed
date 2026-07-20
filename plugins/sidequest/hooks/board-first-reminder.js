'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const AUTOMATION_TAG = /^<(?:agent-message|local-command(?:-caveat)?|task-notification|task-progress|task-result)\b/i;

function pluginRoot() {
  return process.env.CLAUDE_PLUGIN_ROOT || path.join(__dirname, '..');
}

function sessionId(input) {
  return String(input.session_id || input.sessionId || '').trim();
}

function stateFile(id) {
  const home = process.env.SIDEQUEST_HOME || path.join(os.homedir(), '.claude', 'sidequest');
  return path.join(home, 'tmp', 'state', `board-first-${encodeURIComponent(id)}.json`);
}

function boardFor(input) {
  const store = require(path.join(pluginRoot(), 'lib', 'store.js'));
  const start = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const found = store.findProject(store.nearestRepoRoot(start));
  if (!found.ok || !store.projectRoutingEnabled(found.slug)) return null;
  return found.slug;
}

function loadState(file) {
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    return state && typeof state === 'object' ? state : {};
  } catch (_) {
    return {};
  }
}

function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state));
}

function main() {
  const raw = fs.readFileSync(0, 'utf8');
  if (!raw) return;
  const input = JSON.parse(raw);
  if (!input || typeof input !== 'object' || input.agent_id || input.agentId) return;

  const id = sessionId(input);
  const prompt = String(input.prompt || '').trim();
  if (!id || !prompt || AUTOMATION_TAG.test(prompt) || !boardFor(input)) return;

  const file = stateFile(id);
  const state = loadState(file);
  if (state.reminded) return;
  state.reminded = true;
  saveState(file, state);

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: 'sidequest: ROLE: you are the orchestrator. Decompose, file tickets, dispatch executors, and integrate findings into further delegation; read only enough to write a good ticket. REQUIRED: ticket + dispatch BEFORE multi-file exploration, with the second file you open to answer one question as the boundary. Routed claim --direct (direct:true) needs user `direct-ok` + a reason; invalid: "the context is already loaded in this session", "it\'s a small patch", "a fresh executor would need context transfer / handoff costs more". Direct never retroactively legitimizes inline investigation. Only trivial one-file lookups are exempt. Inline work past the free allowance will be BLOCKED until a claim exists.',
    },
  }));
}

try {
  main();
} catch (_) {
  process.exit(0);
}
