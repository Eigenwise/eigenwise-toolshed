import { execFileSync } from '../lib/git-process.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isRecord, readStdin, stringField, type HookInput } from './shared/input.js';
import { writeDeny, writeToolUpdate } from './shared/output.js';
import { runtimeModule } from './shared/paths.js';
import { readSessionState, sessionStateFile, writeSessionState } from './shared/session-state.js';
// Dependency-free, so bundling it keeps launch naming identical in the hook and
// in the store even when the installed lib is mid-upgrade.
import { canonicalExecutorName, dispatchLaunchName, DIAGNOSTIC_PROBE_NAME, isReadOnlyExecutor } from '../lib/exec-names.js';
import { readOnlyShellRefusal } from './shared/read-only-shell.js';
import { mainThreadMutationDenial } from './shared/main-thread-mutations.js';
import { observeBoardMcp, type BoardMcpObservation } from '../lib/board-mcp-liveness.js';
import { checkSidequestInstall, installRefusalMessage } from '../lib/dispatch-preflight.js';

const { canonicalPath } = require(path.join(__dirname, '..', 'lib', 'worktrees.js')) as { canonicalPath: (value: unknown) => string };
const { isInScope: scopeMatch } = require(path.join(__dirname, '..', 'lib', 'scope-match.js')) as { isInScope: (file: unknown, files: unknown) => boolean };

const PASS_THROUGH_AGENT_TYPES = new Set(['Explore', 'claude-code-guide', 'Plan', 'statusline-setup']);
const READ_ONLY_NATIVE_AGENT_TYPES = new Set(['Explore', 'Plan', 'claude-code-guide']);
const EXECUTOR_HELPER_TYPES = new Set(['Explore', 'claude-code-guide', 'web-researcher', 'general-purpose']);
const HELPER_REVIEW_WORK_RE = /\b(?:audits?|auditors?|auditing|audited|reviews?|reviewers?|reviewing|reviewed|review-audit)\b/i;

type ExecutorKind = 'codex_dispatch' | 'claude_builtin' | 'discovered_model' | 'read_only_codex_dispatch' | 'read_only_claude_builtin' | 'read_only_discovered_model' | 'diagnostic' | 'legacy_ticket' | 'ticket' | 'unknown';
interface ExecutorClassification {
  kind: ExecutorKind;
  effort: string | null;
}
interface DispatchLaunch {
  ref: string;
  tokenFile: string;
}
interface ResolveResult {
  status: 'no-refs' | 'error' | 'no-project' | 'ticket-not-found' | 'ticket-not-builtin' | 'conflicting' | 'ok';
  refs: string[];
  missing?: string;
  ref?: string;
  models?: string[];
  model?: string;
}
interface Ticket {
  ref?: string;
  title?: string;
  files?: unknown;
  status?: string;
  archived?: boolean;
  claim?: { by?: string };
  completion?: { by?: string; purpose?: string; supersededBy?: { ref?: string } };
  submission?: { supersededBy?: { ref?: string } };
  exec?: {
    model?: string;
    backend?: string;
    dispatchModel?: string;
    runsLabel?: string;
    runsModel?: string;
  };
  dispatchNonce?: string;
  dispatchExecutor?: string;
  dispatch?: {
    agentId?: string;
    agentName?: string;
    description?: string;
    launchName?: string;
    launchSeq?: number;
    reducedAgentSchema?: boolean;
    tokenFile?: string;
    sessionId?: string;
    terminalAt?: string | null;
    route?: { model?: string; effort?: string; marker?: string };
    evidenceDirectory?: string;
    continuation?: { sourceWorktree?: string };
  };
}
interface PreparedDispatchSpawn {
  briefingCommand: string;
  continuationWorktree: string | null;
  description: string | null;
  executor: string;
  name: string;
  reducedAgentSchema: boolean;
  ref: string;
  project: string;
  route: { model: string; effort: string; marker: string | null } | null;
}
interface PreparedDispatchValidation {
  status: 'none' | 'stale' | 'valid';
  spawn?: PreparedDispatchSpawn;
}
interface TerminalExecutorTicket {
  ref: string;
  closedBy: string;
  outcome: string;
}

interface DispatchAdmission {
  status: 'no-project' | 'routing-disabled' | 'no-usable-route' | 'routed';
}

interface Store {
  findProject: (project: string) => { ok: boolean; slug?: string; meta?: { path?: string } };
  projectDispatchAdmission: (slug: string) => DispatchAdmission;
  getTicket: (slug: string, ref: string) => Ticket | null;
  recordDispatchLaunch: (slug: string, ref: string, options: Record<string, unknown>) => unknown;
  listProjects: (options: { all: boolean }) => Array<{ slug: string }>;
  listTickets: (slug: string) => Ticket[];
  readMeta: (slug: string) => { path?: string } | null;
  executionScope: (slug: string, ticket: Ticket) => string[];
  resolveExec: (model: string, effort: string) => unknown;
  getCategories: (options: { project: string }) => Array<{ enabled?: boolean }>;
  resolveCategoryRoute: (category: unknown) => { effort?: string | null; exec?: unknown } | null;
  terminalDispatchTarget: (agentName: string) => { slug: string; ref: string; outcome: string } | null;
  addComment: (slug: string, ref: string, fields: { by: string; body: string }) => { ok: boolean } | null;
}

interface HelperScope {
  ref: string;
  projectPath: string;
  files: string[];
  evidenceDirectory: string;
}

interface EvidenceScope {
  ref: string;
  evidenceDirectory: string;
}

interface HelperScopeResolution {
  status: 'no-active-ticket' | 'no-owner' | 'recovery-owner' | 'ok';
  scopes: HelperScope[];
  evidenceScopes: EvidenceScope[];
}

const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

function fallbackClassify(type: string): ExecutorClassification {
  const readOnlyDispatch = /^sidequest-exec-dispatch-readonly(?:-(low|medium|high|xhigh|max))?$/.exec(type);
  if (readOnlyDispatch) return { kind: 'read_only_codex_dispatch', effort: readOnlyDispatch[1] || null };
  const readOnlyBuiltin = /^sidequest-exec-readonly-(low|medium|high|xhigh|max)$/.exec(type);
  if (readOnlyBuiltin) return { kind: 'read_only_claude_builtin', effort: readOnlyBuiltin[1] || null };
  const dispatch = /^sidequest-exec-dispatch(?:-(low|medium|high|xhigh|max))?$/.exec(type);
  if (dispatch) return { kind: 'codex_dispatch', effort: dispatch[1] || null };
  const builtin = /^sidequest-exec-(low|medium|high|xhigh|max)$/.exec(type);
  if (builtin) return { kind: 'claude_builtin', effort: builtin[1] || null };
  if (type === DIAGNOSTIC_PROBE_NAME) return { kind: 'diagnostic', effort: null };
  if (/^sidequest-ticket-/.test(type)) return { kind: 'legacy_ticket', effort: null };
  if (/^sidequest-(?:sq-|exec-)/.test(type)) return { kind: 'ticket', effort: null };
  return { kind: 'unknown', effort: null };
}

function classifyExecutor(type: string): ExecutorClassification {
  if (type === DIAGNOSTIC_PROBE_NAME) return { kind: 'diagnostic', effort: null };
  try {
    return require(runtimeModule('exec-names')).classify(type) as ExecutorClassification;
  } catch (_) {
    return fallbackClassify(type);
  }
}

const CURRENT_EXECUTOR_KINDS: ReadonlySet<ExecutorKind> = new Set<ExecutorKind>([
  'claude_builtin', 'codex_dispatch', 'discovered_model',
  'read_only_claude_builtin', 'read_only_codex_dispatch', 'read_only_discovered_model',
]);

function isCurrentExecutor(classification: ExecutorClassification): boolean {
  return CURRENT_EXECUTOR_KINDS.has(classification.kind);
}

// These definitions carry their model in frontmatter, and an Agent `model` value would override it.
const FRONTMATTER_MODEL_KINDS: ReadonlySet<ExecutorKind> = new Set<ExecutorKind>([
  'codex_dispatch', 'read_only_codex_dispatch', 'discovered_model', 'read_only_discovered_model',
]);

function isSubagentCaller(input: HookInput): boolean {
  return Boolean(stringField(input, 'agent_id'));
}

function helperDenyReason(type: string): string {
  return `sidequest: ${type || 'unnamed'} is not an allowed executor helper. Route matching category work through its Sidequest ticket executor.`;
}

function helperReviewWorkDenyReason(): string {
  return 'sidequest: helper prompts that request audit or review work must run through the board as a review-audit ticket executor.';
}

function isHelperReviewWork(toolInput: Record<string, unknown>): boolean {
  return HELPER_REVIEW_WORK_RE.test(`${String(toolInput.prompt || '')}\n${String(toolInput.description || '')}`);
}

function helperModelDenyReason(type: string): string {
  return `sidequest: executor helper ${type} needs an explicit Agent model. Nested spawns do not inherit the parent route, so a default model would silently weaken the helper.`;
}

function helperEvidenceRule(input: HookInput): string {
  const transcriptPath = stringField(input, 'transcript_path', 'transcriptPath').trim();
  const sessionPaths = transcriptPath
    ? [transcriptPath, path.join(path.dirname(transcriptPath), 'subagents')]
    : [];
  const knownLocations = sessionPaths.length ? ` Current session self-reference locations: ${sessionPaths.join(', ')}.` : '';
  return '\n\nEvidence rule: quoted ticket strings appear in this session’s context and generated transcripts. A match in the parent or helper session transcript, subagent transcript, or task-output files is self-reference, not evidence: report it as such. Do not search session, transcript, or task-output directories for evidence. Cite only the directly reachable artifact under investigation; if it is outside the parent worktree or otherwise unavailable, report a visibility block rather than a finding.' + knownLocations;
}

function rewriteExecutorHelper(input: HookInput, toolInput: Record<string, unknown>, type: string): void {
  if (!EXECUTOR_HELPER_TYPES.has(type)) {
    writeDeny('PreToolUse', helperDenyReason(type));
    return;
  }
  if (isHelperReviewWork(toolInput)) {
    writeDeny('PreToolUse', helperReviewWorkDenyReason());
    return;
  }
  const hasModel = Object.prototype.hasOwnProperty.call(toolInput, 'model') && toolInput.model != null && toolInput.model !== '';
  if (!hasModel) {
    writeDeny('PreToolUse', helperModelDenyReason(type));
    return;
  }
  const updatedInput: Record<string, unknown> = {
    ...toolInput,
    prompt: `${String(toolInput.prompt || '')}${helperEvidenceRule(input)}`,
    mode: 'bypassPermissions',
    run_in_background: true,
  };
  delete updatedInput.isolation;
  writeToolUpdate(updatedInput, 'sidequest: executor helpers run in the background from the parent working tree. If the target is unavailable there, report the visibility block instead of returning clean findings.');
}

function isDiagnosticProbe(type: string, toolInput: Record<string, unknown>): boolean {
  return type === DIAGNOSTIC_PROBE_NAME
    && toolInput.description === 'Sidequest dispatch self-test.'
    && toolInput.prompt === 'Diagnose Sidequest dispatch machinery. Read package.json, then report whether the Agent spawn can use a read-only tool.'
    && !Object.hasOwn(toolInput, 'model')
    && !Object.hasOwn(toolInput, 'isolation');
}

function diagnosticProbeDenyReason(): string {
  return `sidequest: ${DIAGNOSTIC_PROBE_NAME} is reserved for a foreground dispatch self-test. Use description "Sidequest dispatch self-test." and prompt "Diagnose Sidequest dispatch machinery. Read package.json, then report whether the Agent spawn can use a read-only tool." Omit model, ticket refs, isolation, and background mode. Ordinary work needs a ticket.`;
}

function sidequestTypeDenyReason(type: string, classification: ExecutorClassification): string {
  if (classification.kind === 'ticket' || classification.kind === 'legacy_ticket') {
    return `sidequest: ${type} looks like a Sidequest executor name but is invalid or retired. Re-run dispatch and spawn the returned executor.`;
  }
  return `sidequest: ${type} is an unknown Sidequest agent type. Use the executor returned by dispatch.`;
}

function genericAgentDenyReason(type: string): string {
  return `sidequest: ${type || 'custom'} requests write or ticket work without a prepared dispatch. Use a native read-only agent for lookups, or dispatch the ticket and spawn its returned executor for writes.`;
}

function hasWriteIntent(toolInput: Record<string, unknown>): boolean {
  const work = `${String(toolInput.prompt ?? '')}\n${String(toolInput.description ?? '')}`;
  const instructions = work.replace(/\b(?:do not|don't|never|without)\s+(?:edit(?:ing)?|modify(?:ing)?|writ(?:e|ing)|implement(?:ing)?|chang(?:e|ing)|creat(?:e|ing)|delet(?:e|ing)|remov(?:e|ing)|commit(?:ting)?|push(?:ing)?|install(?:ing)?)\b/gi, '');
  return /(?:^|[.!?:;\n]|\b(?:and|then|please|must|should|to))\s*(?:edit(?:s|ing|ed)?|modif(?:y|ies|ying|ied)|writ(?:e|es|ing)|implement(?:s|ing|ed)?|chang(?:e|es|ing|ed)|creat(?:e|es|ing|ed)|delet(?:e|es|ing|ed)|remov(?:e|es|ing|ed)|commit(?:s|ting|ted)?|push(?:es|ing|ed)?|install(?:s|ing|ed)?|update|refactor|patch|rewrite)\b/i.test(instructions);
}

function spawnText(toolInput: Record<string, unknown>): string {
  return `${String(toolInput.prompt ?? '')}\n${String(toolInput.description ?? '')}\n${String(toolInput.name ?? '')}`;
}

function citesTicketRef(toolInput: Record<string, unknown>): boolean {
  return /\bSQ-\d+\b/i.test(spawnText(toolInput));
}

function carriesRouteMarker(toolInput: Record<string, unknown>): boolean {
  return /\[sidequest-route\b/i.test(spawnText(toolInput));
}

function ticketRefOnlyDenyReason(type: string): string {
  return `sidequest: ${type} cites a ticket ref without a prepared dispatch, and ${type} can write. For a read-only lookup that cites ticket refs, spawn ${[...READ_ONLY_NATIVE_AGENT_TYPES].join(', ')} instead; for ticket work, dispatch the ticket and spawn its returned executor.`;
}

// A read-only type may cite refs as lookup context; only write intent or a route marker makes it ticket work.
function ticketWorkDenyReason(toolInput: Record<string, unknown>, type: string): string | null {
  if (carriesRouteMarker(toolInput)) return genericAgentDenyReason(type);
  if (!citesTicketRef(toolInput)) return null;
  if (hasWriteIntent(toolInput)) return genericAgentDenyReason(type);
  return READ_ONLY_NATIVE_AGENT_TYPES.has(type) ? null : ticketRefOnlyDenyReason(type);
}

// Dispatch refuses a project with no Sidequest install, and /mcp cannot fix that, so the install goes first (GH-158).
function missingInstallDenyReason(input: HookInput, type: string): string | null {
  const project = registeredProjectPath(input);
  if (!project) return null;
  const check = checkSidequestInstall(project);
  return check.ok ? null : `sidequest: ${type || 'custom'} is a generic Agent, and this project cannot dispatch a ticket executor either. ${installRefusalMessage(check, project)}`;
}

const BOARD_MCP_RECONNECT = 'Stop and report this to the user instead of retrying. The user must run /mcp and reconnect plugin:sidequest:board, or restart Claude Code. Do not use a raw Agent or Sidequest CLI fallback.';

// A live server recorded under an earlier session id (/clear, resume, compaction) is still this session's board.
function boardMcpDownReason(input: HookInput): string | null {
  const sessionId = stringField(input, 'session_id', 'sessionId').trim();
  if (!sessionId) return null;
  return boardMcpDownDescription(observeBoardMcp(sessionId, process.env.CLAUDE_PROJECT_DIR || stringField(input, 'cwd')));
}

function boardMcpDownDescription(observed: BoardMcpObservation): string | null {
  if (observed.state === 'exited') {
    return `sidequest: the Board MCP server last recorded for this session or project (pid ${observed.marker.pid}, ${observed.marker.file}) has exited. ${BOARD_MCP_RECONNECT}`;
  }
  if (observed.state === 'absent') {
    return `sidequest: no Board MCP server has recorded itself for this session or project in ${observed.directory}. ${BOARD_MCP_RECONNECT}`;
  }
  if (observed.state === 'unreadable') {
    return `sidequest: could not read Board MCP liveness markers in ${observed.directory} (${observed.detail}), so the board server state is unknown. If board tools answer, dispatch through them; otherwise the user must run /mcp and reconnect plugin:sidequest:board. Do not use a raw Agent or Sidequest CLI fallback.`;
  }
  return null;
}

function agentDenyReason(input: HookInput, type: string, classification: ExecutorClassification): string {
  if (type.startsWith('sidequest-')) return sidequestTypeDenyReason(type, classification);
  return missingInstallDenyReason(input, type) || boardMcpDownReason(input) || genericAgentDenyReason(type);
}

const DENIED_WORK_PROMPT_PREFIX_CHARS = 160;
const DENIED_WORK_MAX_RECORDS = 20;

interface DeniedWorkRecord {
  description: string;
  promptPrefix: string;
  writeIntent?: boolean;
}

function guardSessionId(input: HookInput): string {
  return (
    stringField(input, 'session_id', 'sessionId')
    || process.env.CLAUDE_CODE_SESSION_ID
    || process.env.CLAUDE_SESSION_ID
    || ''
  ).trim();
}

function normalizedWork(value: unknown): string {
  return String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function deniedWorkPromptPrefix(toolInput: Record<string, unknown>): string {
  return normalizedWork(toolInput.prompt).slice(0, DENIED_WORK_PROMPT_PREFIX_CHARS);
}

function deniedWorkRecords(state: Record<string, unknown>): DeniedWorkRecord[] {
  if (!Array.isArray(state.deniedWork)) return [];
  return state.deniedWork.filter((record): record is DeniedWorkRecord =>
    isRecord(record) && typeof record.description === 'string' && typeof record.promptPrefix === 'string')
    .filter((record) => record.writeIntent === true || hasWriteIntent({ prompt: record.promptPrefix, description: record.description }));
}

function recordDeniedGenericWork(input: HookInput, toolInput: Record<string, unknown>): void {
  const sessionId = guardSessionId(input);
  if (!sessionId) return;
  try {
    const file = sessionStateFile('explore-fanout', sessionId);
    const state = readSessionState(file);
    const records = deniedWorkRecords(state);
    records.push({ description: normalizedWork(toolInput.description), promptPrefix: deniedWorkPromptPrefix(toolInput), writeIntent: true });
    state.deniedWork = records.slice(-DENIED_WORK_MAX_RECORDS);
    writeSessionState(file, state);
  } catch (_) {
    /* bookkeeping must never block the deny that follows */
  }
}

function matchesDeniedWork(records: DeniedWorkRecord[], toolInput: Record<string, unknown>): boolean {
  const description = normalizedWork(toolInput.description);
  const promptPrefix = deniedWorkPromptPrefix(toolInput);
  return records.some((record) =>
    (record.description !== '' && record.description === description)
    || (record.promptPrefix !== '' && record.promptPrefix === promptPrefix));
}

function guardDeniedWrite(input: HookInput, toolInput: Record<string, unknown>): boolean {
  const sessionId = guardSessionId(input);
  if (!sessionId) return false;
  const state = readSessionState(sessionStateFile('explore-fanout', sessionId));
  if (!matchesDeniedWork(deniedWorkRecords(state), toolInput)) return false;
  writeDeny('PreToolUse', 'sidequest: this spawn resumes denied write work without a prepared dispatch. Use a native read-only agent for separate lookups, or dispatch the write ticket and spawn its returned executor.');
  return true;
}

function guardNativeAgent(input: HookInput, toolInput: Record<string, unknown>, type: string): boolean {
  const ticketWorkDenial = ticketWorkDenyReason(toolInput, type);
  if (ticketWorkDenial) {
    writeDeny('PreToolUse', ticketWorkDenial);
    return true;
  }
  if (guardDeniedWrite(input, toolInput)) return true;
  if (PASS_THROUGH_AGENT_TYPES.has(type)) return false;
  if (!hasWriteIntent(toolInput)) return false;
  recordDeniedGenericWork(input, toolInput);
  writeDeny('PreToolUse', agentDenyReason(input, type, { kind: 'unknown', effort: null }));
  return true;
}

const REF_RE = /\bSQ-\d+\b/gi;

function extractRefs(prompt: unknown): string[] {
  if (typeof prompt !== 'string' || !prompt) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of prompt.match(REF_RE) || []) {
    const ref = match.toUpperCase();
    if (!seen.has(ref)) {
      seen.add(ref);
      out.push(ref);
    }
  }
  return out;
}

function extractProjectArg(prompt: unknown): string | null {
  if (typeof prompt !== 'string' || !prompt) return null;
  const matches = [...prompt.matchAll(/--project\s+"([^"]+)"|--project[=\s]+(\S+)/g)];
  const match = matches.at(-1);
  return match ? match[1] || match[2] || null : null;
}

function extractDispatchTokenFile(prompt: unknown): string | null {
  if (typeof prompt !== 'string' || !prompt) return null;
  const matches = [...prompt.matchAll(/--token-file\s+"([^"]+)"|--token-file[=\s]+(\S+)/g)];
  const match = matches.at(-1);
  return match ? match[1] || match[2] || null : null;
}

// The refs a spawn actually dispatches are the ones paired with a token in a
// briefing command. Spawn prompts carry ticket title, description, and anchors,
// and ticket prose routinely names other tickets, so scanning the whole prompt
// resolved unrelated refs: the gate then denied the spawn as conflicting or
// ticket-not-found and recorded no launch, surfacing as unbound_dispatch.
function dispatchRefs(prompt: unknown): string[] {
  if (typeof prompt !== 'string' || !prompt) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of prompt.matchAll(/briefing\s+(SQ-\d+)\s+--token-file\s+(?:"[^"]+"|\S+)/gi)) {
    const ref = (match[1] || '').toUpperCase();
    if (ref && !seen.has(ref)) {
      seen.add(ref);
      out.push(ref);
    }
  }
  return out;
}

function dispatchLaunches(prompt: unknown): DispatchLaunch[] {
  if (typeof prompt !== 'string' || !prompt) return [];
  const headings = [...prompt.matchAll(/^Ref:\s*(SQ-\d+)\s*$/gim)];
  const launches = headings.map((match, index) => {
    const next = headings[index + 1];
    const section = prompt.slice(match.index, next ? next.index : prompt.length);
    return { ref: (match[1] || '').toUpperCase(), tokenFile: extractDispatchTokenFile(section) };
  }).filter((launch): launch is DispatchLaunch => Boolean(launch.ref && launch.tokenFile));
  if (launches.length) return launches;

  // The briefing command pairs its ref with its token file, so read the pair from
  // there rather than counting refs across the whole prompt. Spawn prompts now
  // carry ticket title, description, and anchors, and any of those may mention
  // another ticket; counting prompt-wide silently recorded no launch at all,
  // which surfaced later as unbound_dispatch.
  return [...prompt.matchAll(/briefing\s+(SQ-\d+)\s+--token-file\s+(?:"([^"]+)"|(\S+))/gi)]
    .map((match) => ({ ref: (match[1] || '').toUpperCase(), tokenFile: match[2] || match[3] || '' }))
    .filter((launch): launch is DispatchLaunch => Boolean(launch.ref && launch.tokenFile));
}

function toolInputOf(input: HookInput): Record<string, unknown> | null {
  return isRecord(input.tool_input) ? input.tool_input : null;
}

function executorLiveClaimMutationRefusal(input: HookInput): boolean {
  if (!isSubagentCaller(input)) return false;
  const toolInput = toolInputOf(input);
  const denial = toolInput && mainThreadMutationDenial(stringField(input, 'tool_name'), toolInput);
  if (!denial) return false;
  writeDeny('PreToolUse', denial);
  return true;
}

// Last resort for a single-ticket launch whose board record could not be read
// (unregistered project, deleted ticket). No title is reachable, so the name is
// the bare ref rather than an opaque token slice.
function dispatchAgentName(input: HookInput): string | null {
  const toolInput = toolInputOf(input);
  const dispatched = dispatchRefs(toolInput?.prompt);
  const refs = dispatched.length ? dispatched : extractRefs(toolInput?.prompt);
  const launch = dispatched[0];
  if (refs.length !== 1 || (dispatched.length && !launch)) return null;
  return dispatchLaunchName(refs[0]);
}

function recordAuthoritativeLaunch(input: HookInput, type: string, agentName: string | null): void {
  const toolInput = toolInputOf(input);
  if (!toolInput) return;
  const launches = dispatchLaunches(toolInput.prompt);
  const projectArg = extractProjectArg(toolInput.prompt) || stringField(input, 'cwd') || process.env.CLAUDE_PROJECT_DIR;
  const sessionId = stringField(input, 'session_id', 'sessionId') || process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID;
  if (!launches.length || !projectArg || !sessionId) return;
  try {
    const store = require(runtimeModule('store')) as Store;
    const found = store.findProject(projectArg);
    if (!found.ok || !found.slug) return;
    for (const launch of launches) {
      store.recordDispatchLaunch(found.slug, launch.ref, {
        tokenFile: launch.tokenFile,
        executor: type,
        sessionId,
        agentName: agentName || toolInput.name,
      });
    }
  } catch (_) {}
}

function resolveStampedModel(input: HookInput): ResolveResult {
  const toolInput = toolInputOf(input);
  const prompt = toolInput?.prompt;
  const dispatched = dispatchRefs(prompt);
  const refs = dispatched.length ? dispatched : extractRefs(prompt);
  if (!refs.length) return { status: 'no-refs', refs };

  let store: Store;
  try {
    store = require(runtimeModule('store')) as Store;
  } catch (_) {
    return { status: 'error', refs };
  }

  const projectArg = extractProjectArg(prompt) || stringField(input, 'cwd') || process.env.CLAUDE_PROJECT_DIR;
  const found = projectArg ? store.findProject(projectArg) : { ok: false };
  if (!found.ok || !found.slug) return { status: 'no-project', refs };

  const models = new Set<string>();
  for (const ref of refs) {
    const ticket = store.getTicket(found.slug, ref);
    if (!ticket) return { status: 'ticket-not-found', refs, missing: ref };
    if (!ticket.exec?.model) return { status: 'ticket-not-builtin', refs, ref };
    models.add(ticket.exec.model);
  }
  if (models.size !== 1) return { status: 'conflicting', refs, models: [...models] };
  return { status: 'ok', refs, model: [...models][0] };
}

function requestedProject(input: HookInput): string {
  return extractProjectArg(toolInputOf(input)?.prompt) || stringField(input, 'cwd') || process.env.CLAUDE_PROJECT_DIR || '';
}

function registeredProjectPath(input: HookInput): string {
  const project = requestedProject(input);
  if (!project) return '';
  try {
    const found = (require(runtimeModule('store')) as Store).findProject(project);
    return found.ok ? found.meta?.path || project : '';
  } catch (_) {
    return '';
  }
}

function dispatchAdmission(input: HookInput): DispatchAdmission {
  const project = requestedProject(input);
  if (!project) return { status: 'no-project' };
  try {
    const store = require(runtimeModule('store')) as Store;
    const found = store.findProject(project);
    return found.ok && found.slug ? store.projectDispatchAdmission(found.slug) : { status: 'no-project' };
  } catch (_) {
    return { status: 'no-project' };
  }
}

const ROUTE_MARKER_RE = /^\[sidequest-route model=([a-z0-9][a-z0-9.-]{0,63}) effort=(low|medium|high|xhigh|max)(?: ticket=[A-Za-z][A-Za-z0-9_-]{0,63})?\]$/gm;

function dispatchRouteMarkers(input: HookInput): Array<{ model: string; effort: string }> {
  const prompt = toolInputOf(input)?.prompt;
  if (typeof prompt !== 'string' || !prompt) return [];
  return [...prompt.matchAll(ROUTE_MARKER_RE)].map((match) => ({ model: match[1] || '', effort: match[2] || '' }));
}

function preparedBriefingCommand(ticket: Ticket, project: string): string | null {
  try {
    const agentsync = require(runtimeModule('agentsync')) as {
      renderDispatchStub: (ticket: Ticket, project: string) => string;
    };
    const stub = agentsync.renderDispatchStub(ticket, project);
    return /^FIRST action: run `([^`]+)` and execute exactly what it prints\.$/m.exec(stub)?.[1] || null;
  } catch (_) {
    return null;
  }
}

function preparedLaunchExec(store: Store, ticket: Ticket): unknown {
  const route = ticket.dispatch?.route;
  return route?.model && route.effort ? store.resolveExec(route.model, route.effort) : null;
}

function preparedDispatchValidation(input: HookInput): PreparedDispatchValidation {
  const prompt = toolInputOf(input)?.prompt;
  if (typeof prompt !== 'string') return { status: 'none' };
  const commands = [...prompt.matchAll(/^FIRST action: run `([^`]+)` and execute exactly what it prints\.$/gm)];
  if (commands.length !== 1) return { status: 'none' };
  const command = commands[0]?.[1];
  const ref = /\bbriefing\s+(SQ-\d+)\b/i.exec(command || '')?.[1]?.toUpperCase();
  const project = extractProjectArg(command);
  if (!ref || !project) return { status: 'none' };
  try {
    const store = require(runtimeModule('store')) as Store;
    const found = store.findProject(project);
    if (!found.ok || !found.slug) return { status: 'none' };
    const ticket = store.getTicket(found.slug, ref);
    if (!ticket?.dispatch) return { status: 'none' };
    const briefingCommand = preparedBriefingCommand(ticket, project);
    if (!briefingCommand) return { status: 'none' };
    if (command !== briefingCommand) return { status: 'stale' };
    const description = ticket.dispatch.description;
    const route = ticket.dispatch.route;
    const resolvedExec = preparedLaunchExec(store, ticket);
    return {
      status: 'valid',
      spawn: {
        briefingCommand,
        continuationWorktree: String(ticket.dispatch.continuation?.sourceWorktree || '').trim() || null,
        description: typeof description === 'string' && description ? description : null,
        executor: typeof ticket.dispatchExecutor === 'string' ? ticket.dispatchExecutor : '',
        name: ticket.dispatch.launchName
          || dispatchLaunchName(ticket.ref || ref, ticket.title, resolvedExec, route?.effort, ticket.dispatch.launchSeq),
        reducedAgentSchema: ticket.dispatch.reducedAgentSchema === true,
        ref,
        project,
        route: typeof route?.model === 'string' && typeof route.effort === 'string'
          ? { model: route.model, effort: route.effort, marker: typeof route.marker === 'string' && route.marker ? route.marker : null }
          : null,
      },
    };
  } catch (_) {
    return { status: 'none' };
  }
}

function hasExactPreparedBriefing(prompt: unknown, spawn: PreparedDispatchSpawn): boolean {
  return typeof prompt === 'string'
    && prompt.includes(`FIRST action: run \`${spawn.briefingCommand}\` and execute exactly what it prints.`);
}

function correctionMessage(corrections: string[]): string | null {
  return corrections.length ? `sidequest: corrected prepared dispatch ${corrections.join(' and ')}.` : null;
}

function denyReason(result: ResolveResult, type: string): string {
  const retry = 'Re-read the wave (`ready --brief`) and re-spawn with `model: exec.model`.';
  const ticketRetry = 'Include the dispatch briefing (with its SQ-n ref) in the prompt, or file a ticket and dispatch it via Board MCP first.';
  const base = `sidequest: ${type} was spawned without \`model\` and it couldn't be resolved`;
  switch (result.status) {
    case 'no-refs':
      return `sidequest: ${type} is missing its dispatched ticket — no SQ-\\d+ ticket ref was found in the prompt. ${ticketRetry}`;
    case 'no-project':
      return `${base} — the board for ${result.refs.join(', ')} couldn't be determined (no --project, cwd, or CLAUDE_PROJECT_DIR resolved to a registered board). ${retry}`;
    case 'ticket-not-found':
      return `sidequest: ${type}'s dispatched ticket ${result.missing} isn't on the resolved board. Re-read the wave (\`ready --brief\`) rather than retyping refs. ${ticketRetry}`;
    case 'ticket-not-builtin':
      return `${base} — ${result.ref} resolves to a Codex route, which spawns its own pinned executor, not a builtin. Re-read the wave (\`ready --brief\`) and spawn its \`exec.agent\` instead.`;
    case 'conflicting':
      return `${base} — ${result.refs.join(', ')} resolve to conflicting concrete models (${(result.models || []).join(', ')}). That's an illegal mixed-model batch: split it per model and re-spawn each with its own \`model: exec.model\`.`;
    default:
      return `${base}. ${retry}`;
  }
}

// A terminal record keeps whatever agent id a SubagentStart guess once gave it. When this runtime is bound to a live
// dispatch, that stale guess names a sibling, not this executor (SQ-53, GitHub #298).
function liveDispatchBinding(ticket: Ticket, sessionId: string, agentId: string): boolean {
  const dispatch = ticket.dispatch;
  return dispatch?.sessionId === sessionId && !dispatch.terminalAt && dispatch.agentId === agentId;
}

function dispatchIdentityMatches(ticket: Ticket, agentId: string, type: string): boolean {
  const dispatch = ticket.dispatch;
  if (dispatch?.agentId === agentId) return true;
  const agentName = dispatch?.agentName;
  return Boolean(agentName && (
    agentId === agentName
    || agentId.startsWith(`${agentName}-`)
    || agentId.startsWith(`a${agentName}-`)
    || type === agentName
    || type.startsWith(`${agentName}-`)
    || type.startsWith(`a${agentName}-`)
  ));
}

function dispatchAttemptRef(input: HookInput): string | null {
  const toolName = stringField(input, 'tool_name');
  const toolInput = toolInputOf(input);
  if (toolName === 'mcp__plugin_sidequest_board__dispatch') {
    const ref = stringField(toolInput || {}, 'ref').toUpperCase();
    return /^SQ-\d+$/.test(ref) ? ref : null;
  }
  if (toolName !== 'Bash' && toolName !== 'PowerShell') return null;
  const command = stringField(toolInput || {}, 'command');
  const match = /\bsidequest(?:\.js)?["']?\s+dispatch\s+(SQ-\d+)\b/i.exec(command);
  return match ? match[1]!.toUpperCase() : null;
}

function activeExecutorTicketRefs(input: HookInput): Set<string> {
  const agentId = stringField(input, 'agent_id', 'agentId');
  const executor = stringField(input, 'agent_type', 'agentType', 'subagent_type');
  const sessionId = stringField(input, 'session_id', 'sessionId') || process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || '';
  if (!agentId || !sessionId || !isCurrentExecutor(classifyExecutor(executor))) return new Set();
  try {
    const store = require(runtimeModule('store')) as Store;
    const refs = new Set<string>();
    for (const project of store.listProjects({ all: true })) {
      for (const ticket of store.listTickets(project.slug)) {
        if (ticket.dispatch?.sessionId !== sessionId || ticket.dispatch?.terminalAt) continue;
        if (dispatchIdentityMatches(ticket, agentId, executor) && ticket.ref) refs.add(ticket.ref.toUpperCase());
      }
    }
    return refs;
  } catch (_) {
    return new Set();
  }
}

function terminalExecutorTicket(input: HookInput): TerminalExecutorTicket | null {
  const agentId = stringField(input, 'agent_id', 'agentId');
  const executor = stringField(input, 'agent_type', 'agentType', 'subagent_type');
  const sessionId = stringField(input, 'session_id', 'sessionId') || process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || '';
  if (!agentId || !sessionId || !isCurrentExecutor(classifyExecutor(executor))) return null;
  try {
    const store = require(runtimeModule('store')) as Store;
    const matches: TerminalExecutorTicket[] = [];
    let liveBinding = false;
    for (const project of store.listProjects({ all: true })) {
      for (const ticket of store.listTickets(project.slug)) {
        liveBinding = liveBinding || liveDispatchBinding(ticket, sessionId, agentId);
        if (!ticket.ref || ticket.dispatch?.sessionId !== sessionId || !dispatchIdentityMatches(ticket, agentId, executor)) continue;
        // One runtime identity reaches more than one sibling dispatch of the same
        // session: a bind records an agent id on any sibling whose own id is still unset,
        // and the name fallbacks above match by prefix. So a terminal sibling alone never
        // proves this agent is finished, while a non-terminal one proves the identity is
        // still in play, whether or not that sibling has been claimed yet: the caller's own
        // dispatch may itself be unclaimed on its first tool call, which is the claim call
        // that would otherwise create the claim this guard is looking for. Standing down for
        // an unclaimed non-terminal sibling too means a finished agent goes unrefused
        // somewhat more often, the same trade this guard already makes for a claimed one; an
        // unrefused finished agent burns a few calls, a wrongly refused live agent loses its
        // ticket.
        if (!ticket.dispatch?.terminalAt) return null;
        if (ticket.claim?.by) continue;
        if (ticket.submission?.supersededBy?.ref || ticket.completion?.supersededBy?.ref) {
          const by = String(ticket.completion?.by || 'the control plane').trim();
          matches.push({ ref: ticket.ref, closedBy: `superseded by ${ticket.submission?.supersededBy?.ref || ticket.completion?.supersededBy?.ref} through ${by}`, outcome: 'superseded' });
        } else if (ticket.status === 'done' || ticket.archived) {
          const by = String(ticket.completion?.by || 'the control plane').trim();
          const action = ticket.completion?.purpose === 'grooming' ? 'groomClosed' : 'delivered';
          matches.push({ ref: ticket.ref, closedBy: `${action} by ${by}`, outcome: ticket.archived ? 'archived' : 'done' });
        }
      }
    }
    return !liveBinding && matches.length === 1 ? matches[0] || null : null;
  } catch (_) {
    return null;
  }
}

function guardTerminalExecutor(input: HookInput): boolean {
  const terminal = terminalExecutorTicket(input);
  if (!terminal) return false;
  writeDeny(
    'PreToolUse',
    `sidequest: ${terminal.ref} is closed (${terminal.outcome}; ${terminal.closedBy}). End this turn now without further calls.`,
  );
  return true;
}

function guardOwnTicketDispatch(input: HookInput): boolean {
  const ref = dispatchAttemptRef(input);
  if (!ref || !activeExecutorTicketRefs(input).has(ref)) return false;
  writeDeny(
    'PreToolUse',
    `sidequest: refusing to dispatch ${ref} from its active executor. Release ${ref} with a reason so the orchestrator can redispatch it; do not rotate this dispatch token yourself.`,
  );
  return true;
}

function helperScope(store: Store, project: string, projectPath: string, ticket: Ticket): HelperScope {
  return {
    ref: ticket.ref!,
    projectPath,
    files: store.executionScope(project, ticket),
    evidenceDirectory: String(ticket.dispatch?.evidenceDirectory || '').trim(),
  };
}

function evidenceScope(ticket: Ticket): EvidenceScope | null {
  const evidenceDirectory = String(ticket.dispatch?.evidenceDirectory || '').trim();
  return ticket.ref && evidenceDirectory ? { ref: ticket.ref, evidenceDirectory } : null;
}

function helperScopeResolution(
  status: HelperScopeResolution['status'],
  scopes: HelperScope[],
  evidenceScopes: EvidenceScope[],
): HelperScopeResolution {
  return { status, scopes, evidenceScopes };
}

function helperScopes(input: HookInput): HelperScopeResolution {
  const agentId = stringField(input, 'agent_id', 'agentId');
  const type = stringField(input, 'agent_type', 'agentType', 'subagent_type');
  const sessionId = stringField(input, 'session_id', 'sessionId') || process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || '';
  if (!agentId || !type || !sessionId || isCurrentExecutor(classifyExecutor(type))) return helperScopeResolution('no-active-ticket', [], []);
  try {
    const store = require(runtimeModule('store')) as Store;
    const activeTickets: Array<{ project: string; projectPath: string; ticket: Ticket }> = [];
    const recoveryTickets: Array<{ project: string; projectPath: string; ticket: Ticket }> = [];
    const evidenceScopes: EvidenceScope[] = [];
    for (const project of store.listProjects({ all: true })) {
      const projectPath = String(store.readMeta(project.slug)?.path || '').trim();
      if (!projectPath) continue;
      for (const ticket of store.listTickets(project.slug)) {
        const evidence = evidenceScope(ticket);
        if (evidence) evidenceScopes.push(evidence);
        if (!ticket.ref || ticket.dispatch?.sessionId !== sessionId) continue;
        const candidate = { project: project.slug, projectPath, ticket };
        if (ticket.claim?.by && !ticket.dispatch?.terminalAt) activeTickets.push(candidate);
        if (dispatchIdentityMatches(ticket, agentId, type)) recoveryTickets.push(candidate);
      }
    }
    const ownedTickets = activeTickets.filter(({ ticket }) => dispatchIdentityMatches(ticket, agentId, type));
    if (ownedTickets.length === 1) {
      const owner = ownedTickets[0]!;
      return helperScopeResolution('ok', [helperScope(store, owner.project, owner.projectPath, owner.ticket)], evidenceScopes);
    }
    if (ownedTickets.length > 1) return helperScopeResolution('no-owner', ownedTickets.map((owner) => helperScope(store, owner.project, owner.projectPath, owner.ticket)), evidenceScopes);
    if (recoveryTickets.length === 1) {
      const owner = recoveryTickets[0]!;
      return helperScopeResolution('recovery-owner', [helperScope(store, owner.project, owner.projectPath, owner.ticket)], evidenceScopes);
    }
    if (activeTickets.length === 1) {
      const owner = activeTickets[0]!;
      return helperScopeResolution('ok', [helperScope(store, owner.project, owner.projectPath, owner.ticket)], evidenceScopes);
    }
    return helperScopeResolution(
      activeTickets.length ? 'no-owner' : 'no-active-ticket',
      activeTickets.map((owner) => helperScope(store, owner.project, owner.projectPath, owner.ticket)),
      evidenceScopes,
    );
  } catch (_) {
    return helperScopeResolution('no-active-ticket', [], []);
  }
}

function writeTargetValue(input: HookInput): string {
  const toolInput = toolInputOf(input);
  if (!toolInput) return '';
  const raw = toolInput.file_path ?? toolInput.notebook_path ?? toolInput.path;
  return raw == null ? '' : String(raw).trim();
}

function writeTarget(input: HookInput): string {
  const raw = writeTargetValue(input);
  if (!raw) return '';
  const cwd = stringField(input, 'cwd') || process.cwd();
  return path.resolve(cwd, raw);
}

function restoresCommittedContent(input: HookInput, target: string): boolean {
  try {
    const toolInput = toolInputOf(input);
    const toolName = stringField(input, 'tool_name');
    let restored: string;
    if (toolName === 'Write' && typeof toolInput?.content === 'string') {
      restored = toolInput.content;
    } else if (toolName === 'Edit' && typeof toolInput?.old_string === 'string' && typeof toolInput.new_string === 'string') {
      const current = fs.readFileSync(target, 'utf8');
      const first = current.indexOf(toolInput.old_string);
      if (first < 0 || (!toolInput.replace_all && current.indexOf(toolInput.old_string, first + toolInput.old_string.length) >= 0)) return false;
      restored = toolInput.replace_all
        ? current.split(toolInput.old_string).join(toolInput.new_string)
        : `${current.slice(0, first)}${toolInput.new_string}${current.slice(first + toolInput.old_string.length)}`;
    } else {
      return false;
    }
    const repository = canonicalPath(execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: path.dirname(target), encoding: 'utf8', windowsHide: true,
    }).trim());
    const relative = path.relative(repository, canonicalPath(target)).replace(/\\/g, '/');
    if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) return false;
    const committed = execFileSync('git', ['show', `HEAD:${relative}`], {
      cwd: repository, windowsHide: true,
    });
    return Buffer.from(restored, 'utf8').equals(committed);
  } catch (_) {
    return false;
  }
}

function relativeInside(root: string, target: string): string | null {
  const relative = path.relative(root, target).replace(/\\/g, '/');
  return relative && relative !== '..' && !relative.startsWith('../') && !path.isAbsolute(relative) ? relative : null;
}

function linkedWorktreeRelative(target: string, projectPath: string): string | null {
  let existing = path.dirname(target);
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return null;
    existing = parent;
  }
  try {
    const checkout = canonicalPath(execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: existing, encoding: 'utf8', windowsHide: true,
    }).trim());
    const commonOutput = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: checkout, encoding: 'utf8', windowsHide: true,
    }).trim();
    const common = canonicalPath(path.isAbsolute(commonOutput) ? commonOutput : path.resolve(checkout, commonOutput));
    if (common !== canonicalPath(path.join(projectPath, '.git'))) return null;
    return relativeInside(checkout, target);
  } catch (_) {
    return null;
  }
}

function projectRelative(target: string, projectPath: string): string | null {
  const direct = relativeInside(projectPath, target);
  if (direct) {
    const legacyWorktree = /^\.claude\/worktrees\/[^/]+\/(.+)$/.exec(direct);
    return legacyWorktree ? legacyWorktree[1] || null : direct;
  }
  return linkedWorktreeRelative(target, projectPath);
}

// add accepts a declared path outside the repo as non-repo output, so that path
// is matched as declared instead of refused for having no repo-relative form (GH-300).
function inScope(target: string, scope: HelperScope): boolean {
  const canonicalTarget = canonicalPath(target);
  const relative = projectRelative(canonicalTarget, canonicalPath(scope.projectPath));
  if (relative != null) return scopeMatch(relative, scope.files);
  return scopeMatch(canonicalTarget, scope.files.filter((file) => path.isAbsolute(file)).map(canonicalPath));
}

function evidencePathRelation(target: string, scope: EvidenceScope): 'inside' | 'related' | null {
  const evidenceDirectory = canonicalPath(scope.evidenceDirectory);
  const canonicalTarget = canonicalPath(target);
  if (relativeInside(evidenceDirectory, canonicalTarget) != null) return 'inside';
  if (evidenceDirectory === canonicalTarget || relativeInside(canonicalTarget, evidenceDirectory) != null) return 'related';
  return null;
}

function evidenceTraversalAttempt(input: HookInput, scope: EvidenceScope): boolean {
  const rawTarget = writeTargetValue(input);
  if (!rawTarget) return false;
  const cwd = stringField(input, 'cwd') || process.cwd();
  const candidate = (path.isAbsolute(rawTarget) ? rawTarget : path.join(cwd, rawTarget)).replace(/\\/g, '/');
  const evidenceDirectory = path.resolve(scope.evidenceDirectory).replace(/\\/g, '/').replace(/\/+$/, '');
  const comparableCandidate = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
  const comparableDirectory = process.platform === 'win32' ? evidenceDirectory.toLowerCase() : evidenceDirectory;
  if (!comparableCandidate.startsWith(`${comparableDirectory}/`)) return false;
  return comparableCandidate.slice(comparableDirectory.length + 1).split('/').includes('..');
}

function denyEvidenceWrite(target: string): void {
  writeDeny(
    'PreToolUse',
    `sidequest: refusing helper write to ${target}. Board-owned verification evidence is writable only by a helper resolved to its active ticket owner. Do not request scope for board-owned verification evidence.`,
  );
}

function isScratchpadPath(target: string): boolean {
  const configuredRoot = process.env.CLAUDE_SCRATCHPAD_DIR || process.env.CLAUDE_CODE_SCRATCHPAD_DIR;
  const roots = [configuredRoot, path.join(os.tmpdir(), 'claude')].filter((root): root is string => Boolean(root));
  return roots.some((root) => {
    const relative = path.relative(path.resolve(root), target);
    return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  });
}

function guardHelperWrite(input: HookInput): void {
  const resolution = helperScopes(input);
  const target = writeTarget(input);
  if (!target) return;
  const evidenceRelations = resolution.evidenceScopes.map((scope) => evidencePathRelation(target, scope));
  const evidenceTarget = evidenceRelations.some((relation) => relation != null)
    || resolution.evidenceScopes.some((scope) => evidenceTraversalAttempt(input, scope));
  if (resolution.status === 'no-active-ticket') {
    if (evidenceTarget) denyEvidenceWrite(target);
    return;
  }
  const matchingScopes = resolution.scopes.filter((scope) => inScope(target, scope));
  if ((resolution.status === 'recovery-owner' || resolution.status === 'no-owner')
    && matchingScopes.length === 1
    && restoresCommittedContent(input, target)) return;
  if (resolution.status === 'no-owner' || resolution.status === 'recovery-owner') {
    writeDeny(
      'PreToolUse',
      `sidequest: refusing helper write to ${target}. No active ticket is bound to acting agent ${stringField(input, 'agent_id', 'agentId')}; refusing to borrow another ticket's scope.`,
    );
    return;
  }
  const scope = resolution.scopes[0]!;
  const ownedEvidenceRelation = evidencePathRelation(target, scope);
  if (evidenceTarget && ownedEvidenceRelation !== 'inside') {
    denyEvidenceWrite(target);
    return;
  }
  if (isScratchpadPath(target) || ownedEvidenceRelation === 'inside' || inScope(target, scope)) return;
  const display = projectRelative(target, scope.projectPath) || target;
  writeDeny(
    'PreToolUse',
    `sidequest: refusing helper write to ${display}. It is outside ${scope.ref}'s effective scope. Ask the parent executor to request scope; a granted ruling takes effect immediately. File a new ticket when this work belongs elsewhere.`,
  );
}

function guardReadOnlyShell(input: HookInput): void {
  if (!isReadOnlyExecutor(stringField(input, 'agent_type', 'agentType'))) return;
  const refusal = readOnlyShellRefusal(String(toolInputOf(input)?.command ?? ''), stringField(input, 'cwd') || process.cwd());
  if (refusal) writeDeny('PreToolUse', refusal);
}

// Claude Code ignores permissionMode in plugin agent files and the Agent mode field, but older hosts
// honored the spawn field, so a read-only executor is never launched into bypassPermissions (GH-282).
function spawnPermissionFields(reducedAgentSchema: boolean, type: string): { mode?: string } {
  return reducedAgentSchema || isReadOnlyExecutor(type) ? {} : { mode: 'bypassPermissions' };
}

// A steer aimed at an executor with a recorded terminal Agent failure cannot be
// delivered. The sender is the only party holding the text, so this is the one
// place it can be saved.
function guardLateSteer(input: HookInput): void {
  const toolInput = toolInputOf(input);
  const recipient = String(toolInput?.to || '').trim();
  const message = toolInput?.message;
  if (!recipient || typeof message !== 'string' || !message.trim()) return;
  try {
    const store = require(runtimeModule('store')) as Store;
    const terminal = store.terminalDispatchTarget(recipient);
    if (!terminal) return;
    if (terminal.outcome !== 'died') {
      writeDeny(
        'PreToolUse',
        `sidequest: ${terminal.ref} is terminal (${terminal.outcome}) and ${recipient} cannot receive messages. ` +
          'File a follow-up ticket for changes, or redispatch the existing ticket when it was released without a pending submission.',
      );
      return;
    }
    const sender = stringField(input, 'agent_id', 'agentId') || 'orchestrator';
    const recorded = store.addComment(terminal.slug, terminal.ref, {
      by: sender,
      body: `Late steer to ${recipient}, which had already finished (${terminal.outcome}). Recorded here so it is not lost:\n\n${message.trim()}`,
    });
    writeDeny(
      'PreToolUse',
      `sidequest: ${terminal.ref} is already ${terminal.outcome} and ${recipient} has ended, so this steer would be dropped. ${recorded?.ok
        ? 'It is now a comment on the ticket.'
        : 'Record it on the ticket yourself.'} Re-dispatch ${terminal.ref} if the work itself must change.`,
    );
  } catch (_) {
    /* never block a message because the board was unreadable */
  }
}

interface AgentSpawnRequest {
  input: HookInput;
  toolInput: Record<string, unknown>;
  type: string;
  classification: ExecutorClassification;
}

interface AdmittedExecutorSpawn extends AgentSpawnRequest {
  admission: DispatchAdmission;
  preparedSpawn: PreparedDispatchSpawn | undefined;
}

interface CorrectedSpawnInput {
  updatedInput: Record<string, unknown>;
  launchAgentName: string | null;
  preparedCorrection: string | null;
}

function nonAgentToolGuard(toolName: string): ((input: HookInput) => void) | null {
  if (toolName === 'SendMessage') return guardLateSteer;
  if (WRITE_TOOLS.has(toolName)) return guardHelperWrite;
  if (SHELL_TOOLS.has(toolName)) return guardReadOnlyShell;
  return null;
}

function decidedBeforeAgentAdmission(input: HookInput): boolean {
  const toolName = stringField(input, 'tool_name');
  if (guardTerminalExecutor(input) || guardOwnTicketDispatch(input) || executorLiveClaimMutationRefusal(input)) return true;
  const toolGuard = nonAgentToolGuard(toolName);
  if (toolGuard) toolGuard(input);
  return toolName !== 'Agent';
}

function decidedForHelperOrPassThroughAgent({ input, toolInput, type, classification }: AgentSpawnRequest): boolean {
  if (classification.kind !== 'unknown' || type.startsWith('sidequest-')) return false;
  if (guardNativeAgent(input, toolInput, type)) return true;
  if (isSubagentCaller(input)) rewriteExecutorHelper(input, toolInput, type);
  return true;
}

function admitOrRefuseDiagnosticProbe(type: string, toolInput: Record<string, unknown>): void {
  if (isDiagnosticProbe(type, toolInput)) writeToolUpdate({ ...toolInput, mode: 'bypassPermissions', run_in_background: false });
  else writeDeny('PreToolUse', diagnosticProbeDenyReason());
}

function refusedForMissingExecutorRoute(type: string, classification: ExecutorClassification, admission: DispatchAdmission): boolean {
  if (admission.status !== 'routing-disabled' && admission.status !== 'no-usable-route') return false;
  if (isCurrentExecutor(classification)) {
    writeDeny('PreToolUse', 'sidequest: this project has no usable executor route. Continue only bounded inline work, or restore routing and an available category route before a fresh Board MCP dispatch.');
    return true;
  }
  if (type.startsWith('sidequest-')) return false;
  writeDeny('PreToolUse', 'sidequest: this project has no usable executor route. Continue bounded inline work with direct tools; do not create a fake Sidequest or raw Agent lifecycle fallback.');
  return true;
}

function routeMismatchRefusal(route: PreparedDispatchSpawn['route']): string {
  return `sidequest: ticket resolved route is ${route?.model || 'unavailable'} / ${route?.effort || 'unavailable'}. Re-run dispatch and pass its spawn unchanged.`;
}

function routeMarkerMatches(markers: Array<{ model: string; effort: string }>, route: NonNullable<PreparedDispatchSpawn['route']>): boolean {
  if (markers.length !== 1) return false;
  const [marker] = markers;
  return marker?.model === (route.marker ?? route.model) && marker.effort === route.effort;
}

function refusedRouteMarkerMismatch(input: HookInput, route: PreparedDispatchSpawn['route']): boolean {
  if (route && routeMarkerMatches(dispatchRouteMarkers(input), route)) return false;
  writeDeny('PreToolUse', routeMismatchRefusal(route));
  return true;
}

function refusedPreparedDispatchSpawn({ input, toolInput, type }: AgentSpawnRequest, preparedSpawn: PreparedDispatchSpawn | undefined): boolean {
  if (!preparedSpawn || !hasExactPreparedBriefing(toolInput.prompt, preparedSpawn) || type !== preparedSpawn.executor) {
    writeDeny('PreToolUse', 'sidequest: dispatch executor requires the exact prepared FIRST action briefing command and executor. Re-run dispatch and pass its spawn unchanged.');
    return true;
  }
  return refusedRouteMarkerMismatch(input, preparedSpawn.route);
}

function refusedPreparedDispatch(request: AgentSpawnRequest, dispatchValidation: PreparedDispatchValidation): boolean {
  const { kind } = request.classification;
  if (kind !== 'codex_dispatch' && kind !== 'read_only_codex_dispatch') return false;
  if (dispatchValidation.status !== 'valid') {
    writeDeny('PreToolUse', dispatchValidation.status === 'stale'
      ? 'sidequest: dispatch briefing command is stale or drifted. Re-run dispatch and pass its spawn unchanged.'
      : 'sidequest: dispatch executor requires the exact prepared FIRST action briefing command. Re-run dispatch and pass its spawn unchanged.');
    return true;
  }
  return refusedPreparedDispatchSpawn(request, dispatchValidation.spawn);
}

function refusedGenericAgent({ input, type, classification }: AgentSpawnRequest): boolean {
  if (isCurrentExecutor(classification)) return false;
  writeDeny('PreToolUse', agentDenyReason(input, type, classification));
  return true;
}

interface ResearchSpawn {
  subagentType: string;
  model?: string;
  promptPrefix: string;
}

type ResearchSpawnFor = (exec: unknown, effort: unknown) => ResearchSpawn | null;

const RESEARCH_KINDS: ReadonlySet<ExecutorKind> = new Set<ExecutorKind>(['read_only_codex_dispatch', 'read_only_claude_builtin']);

function categoryResearchSpawn(store: Store, researchSpawnFor: ResearchSpawnFor, category: unknown): ResearchSpawn | null {
  const route = store.resolveCategoryRoute(category);
  return route?.exec ? researchSpawnFor(route.exec, route.effort) : null;
}

// Built from route_recipe's own research field, so the hook and the recipe cannot disagree on a live route.
function liveResearchSpawns(input: HookInput): ResearchSpawn[] {
  try {
    const store = require(runtimeModule('store')) as Store;
    const { researchSpawn } = require(runtimeModule('agentsync')) as { researchSpawn: ResearchSpawnFor };
    const found = store.findProject(requestedProject(input));
    if (!found.ok || !found.slug) return [];
    return store.getCategories({ project: found.slug })
      .filter((category) => category.enabled)
      .map((category) => categoryResearchSpawn(store, researchSpawn, category))
      .filter((spawn): spawn is ResearchSpawn => spawn !== null);
  } catch (_) {
    return [];
  }
}

function matchingResearchSpawn({ input, toolInput, type }: AgentSpawnRequest): ResearchSpawn | undefined {
  const prompt = String(toolInput.prompt ?? '');
  if (dispatchRouteMarkers(input).length !== 1) return undefined;
  return liveResearchSpawns(input).find((spawn) =>
    canonicalExecutorName(spawn.subagentType) === type && prompt.startsWith(spawn.promptPrefix.trimEnd()));
}

function researchSpawnInput(toolInput: Record<string, unknown>, research: ResearchSpawn): Record<string, unknown> {
  const updatedInput: Record<string, unknown> = { ...toolInput };
  delete updatedInput.mode;
  delete updatedInput.isolation;
  delete updatedInput.model;
  if (research.model) updatedInput.model = research.model;
  return updatedInput;
}

// A ticketless read-only research spawn: its definition forbids writes, so the live route marker is the only admission it needs.
function isResearchAttempt({ toolInput, classification }: AgentSpawnRequest, dispatchValidation: PreparedDispatchValidation): boolean {
  return dispatchValidation.status === 'none'
    && RESEARCH_KINDS.has(classification.kind)
    && String(toolInput.prompt ?? '').startsWith('[sidequest-route ');
}

function decidedResearchSpawn(request: AgentSpawnRequest, dispatchValidation: PreparedDispatchValidation): boolean {
  if (!isResearchAttempt(request, dispatchValidation)) return false;
  const research = matchingResearchSpawn(request);
  if (!research) {
    writeDeny('PreToolUse', `sidequest: ${request.type} research prompt does not open with the live research prefix of an enabled category route. Re-fetch route_recipe(category).research and spawn its subagentType, model and promptPrefix unchanged.`);
    return true;
  }
  if (!refusedSubagentModelOverride()) writeToolUpdate(researchSpawnInput(request.toolInput, research));
  return true;
}

function decidedBeforeExecutorLaunch(request: AgentSpawnRequest, dispatchValidation: PreparedDispatchValidation): boolean {
  return decidedResearchSpawn(request, dispatchValidation)
    || refusedPreparedDispatch(request, dispatchValidation)
    || refusedGenericAgent(request)
    || refusedSubagentModelOverride();
}

function routedExecutorSpawn(request: AgentSpawnRequest): AdmittedExecutorSpawn | null {
  const admission = dispatchAdmission(request.input);
  if (refusedForMissingExecutorRoute(request.type, request.classification, admission)) return null;
  const dispatchValidation = preparedDispatchValidation(request.input);
  if (decidedBeforeExecutorLaunch(request, dispatchValidation)) return null;
  return { ...request, admission, preparedSpawn: dispatchValidation.spawn };
}

function admittedExecutorSpawn(input: HookInput): AdmittedExecutorSpawn | null {
  const toolInput = toolInputOf(input);
  if (!toolInput) return null;
  const type = canonicalExecutorName(String(toolInput.subagent_type || ''));
  const request: AgentSpawnRequest = { input, toolInput, type, classification: classifyExecutor(type) };
  if (decidedForHelperOrPassThroughAgent(request)) return null;
  if (request.classification.kind === 'diagnostic') {
    admitOrRefuseDiagnosticProbe(type, toolInput);
    return null;
  }
  return routedExecutorSpawn(request);
}

function refusedSubagentModelOverride(): boolean {
  const subagentOverride = String(process.env.CLAUDE_CODE_SUBAGENT_MODEL || '').trim();
  if (!subagentOverride) return false;
  writeDeny(
    'PreToolUse',
    `sidequest: CLAUDE_CODE_SUBAGENT_MODEL="${subagentOverride}" is set — it overrides every sidequest ` +
      `executor's routed model (a Codex route would silently run on a Claude model; builtins collapse to one ` +
      `route), defeating routing. Unset it before spawning sidequest executors.`,
  );
  return true;
}

// A continuation spawn carries no isolation field because the board already bound it to the checkout the
// previous attempt retained. Adding one sends the harness to WorktreeCreate, which cannot bind a checkout
// this dispatch never reserved, and the spawn dies there with no executor and a launched attempt (SQ-2537).
function refusedContinuationIsolation({ input, toolInput, preparedSpawn }: AdmittedExecutorSpawn): boolean {
  if (!preparedSpawn?.continuationWorktree || !Object.hasOwn(toolInput, 'isolation') || isSubagentCaller(input)) return false;
  writeDeny(
    'PreToolUse',
    `sidequest: ${preparedSpawn.ref} continues the retained checkout ${preparedSpawn.continuationWorktree}, so its prepared spawn carries no isolation field. Spawn it unchanged: an added isolation asks the harness to create a checkout the board cannot bind, and the Agent call fails before the executor starts.`,
  );
  return true;
}

function permissionCorrectedInput({ input, toolInput, type }: AdmittedExecutorSpawn, reducedAgentSchema: boolean): Record<string, unknown> {
  const permissionFields = spawnPermissionFields(reducedAgentSchema, type);
  const updatedInput: Record<string, unknown> = {
    ...toolInput,
    ...permissionFields,
    ...(!reducedAgentSchema && isSubagentCaller(input) ? { run_in_background: true } : {}),
  };
  if (!permissionFields.mode) delete updatedInput.mode;
  if (isSubagentCaller(input)) delete updatedInput.isolation;
  return updatedInput;
}

function preparedSpawnCorrections({ toolInput, preparedSpawn }: AdmittedExecutorSpawn, updatedInput: Record<string, unknown>, reducedAgentSchema: boolean): string[] {
  if (!preparedSpawn) return [];
  const preparedFields: Array<[field: string, value: string]> = [];
  if (preparedSpawn.description) preparedFields.push(['description', preparedSpawn.description]);
  if (!reducedAgentSchema) preparedFields.push(['name', preparedSpawn.name]);
  const differingFields = preparedFields.filter(([field, value]) => toolInput[field] !== value);
  for (const [field, value] of differingFields) updatedInput[field] = value;
  return differingFields.map(([field]) => field);
}

function launchAgentNameFor({ input, toolInput, preparedSpawn }: AdmittedExecutorSpawn): string | null {
  const requestedAgentName = typeof toolInput.name === 'string' ? toolInput.name : null;
  return preparedSpawn?.name || requestedAgentName || dispatchAgentName(input);
}

function correctedSpawnInput(spawn: AdmittedExecutorSpawn): CorrectedSpawnInput {
  const reducedAgentSchema = spawn.preparedSpawn?.reducedAgentSchema === true;
  const updatedInput = permissionCorrectedInput(spawn, reducedAgentSchema);
  const corrections = preparedSpawnCorrections(spawn, updatedInput, reducedAgentSchema);
  const launchAgentName = launchAgentNameFor(spawn);
  if (reducedAgentSchema) delete updatedInput.name;
  else if (launchAgentName) updatedInput.name = launchAgentName;
  return { updatedInput, launchAgentName, preparedCorrection: correctionMessage(corrections) };
}

function launchWithFrontmatterModel({ input, toolInput, type }: AdmittedExecutorSpawn, { updatedInput, launchAgentName, preparedCorrection }: CorrectedSpawnInput): void {
  const hadModel = Object.prototype.hasOwnProperty.call(toolInput, 'model');
  if (hadModel) delete updatedInput.model;
  recordAuthoritativeLaunch(input, type, launchAgentName);
  const messages = [
    preparedCorrection,
    hadModel ? `sidequest: removed the Agent model override for ${type}; its frontmatter pin selects the routed backend.` : null,
  ].filter((message): message is string => Boolean(message));
  writeToolUpdate(updatedInput, messages.join(' '));
}

function launchWithInjectedModel({ input, type }: AdmittedExecutorSpawn, { updatedInput, launchAgentName, preparedCorrection }: CorrectedSpawnInput): void {
  const result = resolveStampedModel(input);
  if (result.status !== 'ok' || !result.model) {
    writeDeny('PreToolUse', denyReason(result, type));
    return;
  }
  updatedInput.model = result.model;
  recordAuthoritativeLaunch(input, type, launchAgentName);
  writeToolUpdate(updatedInput, [
    preparedCorrection,
    `sidequest: ${type} spawned without a model — injected "${result.model}" from ${result.refs.join(', ')}'s resolved category route. Always pass model: exec.model on Claude routes.`,
  ].filter(Boolean).join(' '));
}

function callerModelLaunchMessage(result: ResolveResult, { toolInput, type }: AdmittedExecutorSpawn, preparedCorrection: string | null): string | null {
  if (result.status !== 'ok' || result.model === toolInput.model) return preparedCorrection;
  return [
    preparedCorrection,
    `sidequest: ${type} was spawned with model "${String(toolInput.model)}" but ${result.refs.join(', ')} resolves to "${result.model}" — kept the caller's value; confirm the cap is deliberate.`,
  ].filter(Boolean).join(' ');
}

function launchWithCallerModel(spawn: AdmittedExecutorSpawn, { updatedInput, launchAgentName, preparedCorrection }: CorrectedSpawnInput): void {
  const result = resolveStampedModel(spawn.input);
  if (spawn.admission.status === 'routed' && (result.status === 'no-refs' || result.status === 'ticket-not-found')) {
    writeDeny('PreToolUse', denyReason(result, spawn.type));
    return;
  }
  recordAuthoritativeLaunch(spawn.input, spawn.type, launchAgentName);
  writeToolUpdate(updatedInput, callerModelLaunchMessage(result, spawn, preparedCorrection));
}

function stampSpawnModel(spawn: AdmittedExecutorSpawn, corrected: CorrectedSpawnInput): void {
  const { toolInput } = spawn;
  const callerChoseModel = Object.prototype.hasOwnProperty.call(toolInput, 'model') && toolInput.model != null && toolInput.model !== '';
  if (FRONTMATTER_MODEL_KINDS.has(spawn.classification.kind)) launchWithFrontmatterModel(spawn, corrected);
  else if (callerChoseModel) launchWithCallerModel(spawn, corrected);
  else launchWithInjectedModel(spawn, corrected);
}

function main(): void {
  const input = readStdin();
  if (!input || decidedBeforeAgentAdmission(input)) return;
  const spawn = admittedExecutorSpawn(input);
  if (!spawn || refusedContinuationIsolation(spawn)) return;
  stampSpawnModel(spawn, correctedSpawnInput(spawn));
}

// The guards module runs this per decision and fails an Agent spawn closed on a non-zero exit.
try {
  main();
} catch (error) {
  process.stderr.write(String(error));
  process.exit(1);
}
