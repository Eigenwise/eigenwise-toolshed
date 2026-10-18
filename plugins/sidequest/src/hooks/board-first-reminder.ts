import { reportLoadedSidequestVersion } from '../lib/plugin-freshness.js';
import { isSubagent, readStdin, stringField, type HookInput } from './shared/input.js';
import { writeContext } from './shared/output.js';
import { runtimeModule } from './shared/paths.js';
import { readSessionState, sessionStateFile, writeSessionState } from './shared/session-state.js';

const AUTOMATION_TAG = /^<(?:agent-message|local-command(?:-caveat)?|task-notification|task-progress|task-result)\b/i;
// ponytail: keyword-and-length heuristic; a greeting or a short status question stays silent.
const CHANGE_VERB = /\b(?:add|build|implement|fix|refactor|change|update|create|write|remove|delete|rename|move|migrate|rewrite|port|wire|improve|investigate|audit|debug|make)\b/i;
const GREETING_LENGTH = 60;

const ROUTED_BOARD_REMINDER = 'sidequest: I can offer one-owner dispatch when it helps; small bounded fixes may stay inline and read-only investigations run without tickets through the route_recipe(category).research spawn.';
const NEW_BOARD_HINT = 'sidequest: no board here yet. I can offer one-owner dispatch; the first add creates the board. Small bounded fixes and read-only investigations may stay ticket-free.';

interface Store {
  nearestRepoRoot: (start: string) => string;
  findProject: (start: string) => { ok: boolean; slug?: string };
  projectDispatchAdmission: (slug: string) => { status: string };
  boardRootRefusal: (absPath: string, options: { implicit: boolean }) => string | null;
}

function projectRoot(input: HookInput, store: Store): string {
  return store.nearestRepoRoot(stringField(input, 'cwd') || process.env.CLAUDE_PROJECT_DIR || process.cwd());
}

// A folder that could not get a board implicitly (temp, the Sidequest home, a non-git folder) hears nothing.
function boardReminder(input: HookInput): string | null {
  const store = require(runtimeModule('store')) as Store;
  const root = projectRoot(input, store);
  const found = store.findProject(root);
  if (!found.ok) return store.boardRootRefusal(root, { implicit: true }) ? null : NEW_BOARD_HINT;
  return store.projectDispatchAdmission(String(found.slug)).status === 'routed' ? ROUTED_BOARD_REMINDER : null;
}

function looksLikeWorkRequest(prompt: string): boolean {
  return CHANGE_VERB.test(prompt) || prompt.length > GREETING_LENGTH;
}

function remindOnce(input: HookInput, sessionId: string, prompt: string): void {
  const file = sessionStateFile('board-first', sessionId);
  const state = readSessionState(file);
  if (state.reminded || !looksLikeWorkRequest(prompt)) return;
  const reminder = boardReminder(input);
  if (!reminder) return;
  state.reminded = true;
  writeSessionState(file, state);
  writeContext('UserPromptSubmit', reminder);
}

function humanPrompt(input: HookInput): string {
  const prompt = stringField(input, 'prompt').trim();
  return AUTOMATION_TAG.test(prompt) ? '' : prompt;
}

function main(): void {
  const input = readStdin();
  if (!input) return;
  reportLoadedSidequestVersion(input);
  const sessionId = stringField(input, 'session_id', 'sessionId').trim();
  const prompt = humanPrompt(input);
  if (isSubagent(input) || !sessionId || !prompt) return;
  remindOnce(input, sessionId, prompt);
}

try {
  main();
} catch (_) {
  process.exit(0);
}
