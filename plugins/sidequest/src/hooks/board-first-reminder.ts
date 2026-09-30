import { reportLoadedSidequestVersion } from '../lib/plugin-freshness.js';
import { isSubagent, readStdin, stringField, type HookInput } from './shared/input.js';
import { writeContext } from './shared/output.js';
import { runtimeModule } from './shared/paths.js';
import { readSessionState, sessionStateFile, writeSessionState } from './shared/session-state.js';

const AUTOMATION_TAG = /^<(?:agent-message|local-command(?:-caveat)?|task-notification|task-progress|task-result)\b/i;
// ponytail: keyword-and-length heuristic; a greeting or a short status question stays silent.
const CHANGE_VERB = /\b(?:add|build|implement|fix|refactor|change|update|create|write|remove|delete|rename|move|migrate|rewrite|port|wire|improve|investigate|audit|debug|make)\b/i;
const GREETING_LENGTH = 60;
const INLINE_WORK_WINDOW_KEYS = ['boardInteraction', 'readActions', 'substantiveActions', 'soloChoiceSurfaced', 'investigationChoiceSurfaced'];

const ROUTED_BOARD_REMINDER = 'sidequest: gather enough read-only evidence, using Explore only for a quick sweep (it inherits the session model; deep or fan-out investigation is a codebase-exploration spike), then file precise tickets with add and dispatch them without offering. Only a one-or-two-file edit at a known location stays inline.';
const NEW_BOARD_HINT = 'sidequest: no board here yet. For multi-file or multi-step work, the first add creates this repo\'s board and dispatch is ready through the default profile; file the ticket and dispatch it without offering.';

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

// A board call silences the inline-work nudge only until the next prompt, so a later inline burst is still counted.
// boardTouchedEarlier keeps the Explore fan-out cap lifted for the rest of the session.
function reopenInlineWorkWindow(sessionId: string): void {
  const file = sessionStateFile('inline-work', sessionId);
  const state = readSessionState(file);
  if (!state.boardInteraction) return;
  for (const key of INLINE_WORK_WINDOW_KEYS) delete state[key];
  writeSessionState(file, { ...state, boardTouchedEarlier: true });
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
  if (isSubagent(input)) return;

  const sessionId = stringField(input, 'session_id', 'sessionId').trim();
  const prompt = humanPrompt(input);
  if (!sessionId || !prompt) return;
  reopenInlineWorkWindow(sessionId);
  remindOnce(input, sessionId, prompt);
}

try {
  main();
} catch (_) {
  process.exit(0);
}
