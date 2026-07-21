import { isSubagent, readStdin, stringField, type HookInput } from './shared/input.js';
import { writeContext } from './shared/output.js';
import { runtimeModule } from './shared/paths.js';
import { readSessionState, sessionStateFile, writeSessionState } from './shared/session-state.js';

const AUTOMATION_TAG = /^<(?:agent-message|local-command(?:-caveat)?|task-notification|task-progress|task-result)\b/i;

interface Store {
  nearestRepoRoot: (start: string) => string;
  findProject: (start: string) => { ok: boolean; slug?: string };
  projectRoutingEnabled: (slug: string) => boolean;
}

function boardFor(input: HookInput): string | null {
  const store = require(runtimeModule('store')) as Store;
  const start = stringField(input, 'cwd') || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const found = store.findProject(store.nearestRepoRoot(start));
  if (!found.ok || !found.slug || !store.projectRoutingEnabled(found.slug)) return null;
  return found.slug;
}

function main(): void {
  const input = readStdin();
  if (!input || isSubagent(input)) return;

  const id = stringField(input, 'session_id', 'sessionId').trim();
  const prompt = stringField(input, 'prompt').trim();
  if (!id || !prompt || AUTOMATION_TAG.test(prompt)) return;

  const file = sessionStateFile('board-first', id);
  const state = readSessionState(file);
  if (state.reminded || !boardFor(input)) return;
  state.reminded = true;
  writeSessionState(file, state);

  writeContext('UserPromptSubmit', 'sidequest: gather enough read-only evidence or use Explore, then write precise tickets and route implementation by default. Use informed inline judgment when it fits.');
}

try {
  main();
} catch (_) {
  process.exit(0);
}
