import os from 'node:os';
import path from 'node:path';
import { isRecord, readStdin, stringField, type HookInput } from './shared/input.js';
import { writeDeny, writeJson } from './shared/output.js';
import { runtimeModule } from './shared/paths.js';
// Dependency-free, so bundling it keeps launch naming identical in the hook and
// in the store even when the installed lib is mid-upgrade.
import { dispatchLaunchName } from '../lib/exec-names.js';

const PASS_THROUGH_AGENT_TYPES = new Set(['Explore', 'claude-code-guide', 'statusline-setup']);
const EXECUTOR_HELPER_TYPES = new Set(['Explore', 'claude-code-guide', 'web-researcher', 'general-purpose']);
const HELPER_REVIEW_WORK_RE = /\b(?:audits?|auditors?|auditing|audited|reviews?|reviewers?|reviewing|reviewed|review-audit)\b/i;

type ExecutorKind = 'codex_dispatch' | 'claude_builtin' | 'read_only_codex_dispatch' | 'read_only_claude_builtin' | 'legacy_ticket' | 'ticket' | 'unknown';
interface ExecutorClassification {
  kind: ExecutorKind;
  effort: string | null;
}
interface DispatchLaunch {
  ref: string;
  token: string;
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
  claim?: { by?: string };
  exec?: { model?: string };
  dispatchNonce?: string;
  dispatch?: {
    agentId?: string;
    agentName?: string;
    description?: string;
    launchName?: string;
    launchSeq?: number;
    sessionId?: string;
    terminalAt?: string | null;
    route?: { model?: string; effort?: string; marker?: string };
  };
}
interface PreparedDispatchSpawn {
  description: string | null;
  name: string;
  ref: string;
  token: string;
  project: string;
  route: { model: string; effort: string; marker: string | null } | null;
}
interface PreparedDispatchValidation {
  status: 'none' | 'stale' | 'valid';
  spawn?: PreparedDispatchSpawn;
}
interface Store {
  findProject: (project: string) => { ok: boolean; slug?: string };
  getTicket: (slug: string, ref: string) => Ticket | null;
  recordDispatchLaunch: (slug: string, ref: string, options: Record<string, unknown>) => unknown;
  listProjects: (options: { all: boolean }) => Array<{ slug: string }>;
  listTickets: (slug: string) => Ticket[];
  readMeta: (slug: string) => { path?: string } | null;
  effectiveScope: (slug: string, files: unknown) => string[];
  terminalDispatchTarget: (agentName: string) => { slug: string; ref: string; outcome: string } | null;
  addComment: (slug: string, ref: string, fields: { by: string; body: string }) => { ok: boolean } | null;
}

interface HelperScope {
  ref: string;
  projectPath: string;
  files: string[];
}

interface HelperScopeResolution {
  status: 'no-active-ticket' | 'no-owner' | 'ok';
  scopes: HelperScope[];
}

const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function fallbackClassify(type: string): ExecutorClassification {
  const readOnlyDispatch = /^sidequest-exec-dispatch-readonly(?:-(low|medium|high|xhigh|max))?$/.exec(type);
  if (readOnlyDispatch) return { kind: 'read_only_codex_dispatch', effort: readOnlyDispatch[1] || null };
  const readOnlyBuiltin = /^sidequest-exec-readonly-(low|medium|high|xhigh|max)$/.exec(type);
  if (readOnlyBuiltin) return { kind: 'read_only_claude_builtin', effort: readOnlyBuiltin[1] || null };
  const dispatch = /^sidequest-exec-dispatch(?:-(low|medium|high|xhigh|max))?$/.exec(type);
  if (dispatch) return { kind: 'codex_dispatch', effort: dispatch[1] || null };
  const builtin = /^sidequest-exec-(low|medium|high|xhigh|max)$/.exec(type);
  if (builtin) return { kind: 'claude_builtin', effort: builtin[1] || null };
  if (/^sidequest-ticket-/.test(type)) return { kind: 'legacy_ticket', effort: null };
  if (/^sidequest-(?:sq-|exec-)/.test(type)) return { kind: 'ticket', effort: null };
  return { kind: 'unknown', effort: null };
}

function classifyExecutor(type: string): ExecutorClassification {
  try {
    return require(runtimeModule('exec-names')).classify(type) as ExecutorClassification;
  } catch (_) {
    return fallbackClassify(type);
  }
}

function isCurrentExecutor(classification: ExecutorClassification): boolean {
  return classification.kind === 'claude_builtin'
    || classification.kind === 'codex_dispatch'
    || classification.kind === 'read_only_claude_builtin'
    || classification.kind === 'read_only_codex_dispatch';
}

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
  writeJson({
    systemMessage: 'sidequest: executor helpers run in the background from the parent working tree. If the target is unavailable there, report the visibility block instead of returning clean findings.',
    hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput },
  });
}

function agentDenyReason(type: string, classification: ExecutorClassification): string {
  if (type.startsWith('sidequest-')) {
    if (classification.kind === 'ticket' || classification.kind === 'legacy_ticket') {
      return `sidequest: ${type} looks like a Sidequest executor name but is invalid or retired. Re-run dispatch and spawn the returned executor.`;
    }
    return `sidequest: ${type} is an unknown Sidequest agent type. Use the executor returned by dispatch.`;
  }
  return `sidequest: ${type || 'custom'} is a generic Agent, not a Sidequest ticket executor. ` +
    'For a tiny lookup, use Read, Glob, Grep, or WebFetch inline, not WebSearch. WebSearch is executor-only: file and dispatch a research ticket. Any delegated work, including a quick investigation, needs a ticket: file a spike (usually codebase-exploration), route it, dispatch it, then spawn the returned executor. The blocked work still gates any dependent action: do not proceed to a PR, merge, publish, or ship until its ticket is filed, dispatched, and closed; rerouting around this block is a violation.';
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

function extractDispatchToken(prompt: unknown): string | null {
  if (typeof prompt !== 'string' || !prompt) return null;
  const matches = [...prompt.matchAll(/--token\s+([^\s`"']+)/g)];
  const match = matches.at(-1);
  return match ? match[1] || null : null;
}

function dispatchLaunches(prompt: unknown): DispatchLaunch[] {
  if (typeof prompt !== 'string' || !prompt) return [];
  const headings = [...prompt.matchAll(/^Ref:\s*(SQ-\d+)\s*$/gim)];
  const launches = headings.map((match, index) => {
    const next = headings[index + 1];
    const section = prompt.slice(match.index, next ? next.index : prompt.length);
    return { ref: (match[1] || '').toUpperCase(), token: extractDispatchToken(section) };
  }).filter((launch): launch is DispatchLaunch => Boolean(launch.ref && launch.token));
  if (launches.length) return launches;

  const refs = extractRefs(prompt);
  const tokens = [...prompt.matchAll(/--token\s+([^\s`"']+)/g)].map((match) => match[1] || '');
  if (refs.length === tokens.length) return refs.map((ref, index) => ({ ref, token: tokens[index] || '' }));
  return refs.length === 1 && tokens.length === 1 ? [{ ref: refs[0] || '', token: tokens[0] || '' }] : [];
}

function toolInputOf(input: HookInput): Record<string, unknown> | null {
  return isRecord(input.tool_input) ? input.tool_input : null;
}

// Last resort for a single-ticket launch whose board record could not be read
// (unregistered project, deleted ticket). No title is reachable, so the name is
// the bare ref rather than an opaque token slice.
function dispatchAgentName(input: HookInput): string | null {
  const toolInput = toolInputOf(input);
  const refs = extractRefs(toolInput?.prompt);
  const token = extractDispatchToken(toolInput?.prompt);
  if (refs.length !== 1 || !token) return null;
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
        token: launch.token,
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
  const refs = extractRefs(prompt);
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

const ROUTE_MARKER_RE = /^\[sidequest-route model=([a-z0-9][a-z0-9.-]{0,63}) effort=(low|medium|high|xhigh|max)\]$/gm;

function dispatchRouteMarkers(input: HookInput): Array<{ model: string; effort: string }> {
  const prompt = toolInputOf(input)?.prompt;
  if (typeof prompt !== 'string' || !prompt) return [];
  return [...prompt.matchAll(ROUTE_MARKER_RE)].map((match) => ({ model: match[1] || '', effort: match[2] || '' }));
}

function preparedDispatchValidation(input: HookInput): PreparedDispatchValidation {
  const toolInput = toolInputOf(input);
  if (!toolInput) return { status: 'none' };
  const launches = dispatchLaunches(toolInput.prompt);
  if (launches.length !== 1) return { status: 'none' };
  const launch = launches[0];
  const project = extractProjectArg(toolInput.prompt) || stringField(input, 'cwd') || process.env.CLAUDE_PROJECT_DIR;
  if (!launch || !project) return { status: 'none' };
  try {
    const store = require(runtimeModule('store')) as Store;
    const found = store.findProject(project);
    if (!found.ok || !found.slug) return { status: 'none' };
    const ticket = store.getTicket(found.slug, launch.ref);
    if (!ticket) return { status: 'none' };
    if (ticket.dispatchNonce !== launch.token) return { status: 'stale' };
    const description = ticket.dispatch?.description;
    const route = ticket.dispatch?.route;
    return {
      status: 'valid',
      spawn: {
        description: typeof description === 'string' && description ? description : null,
        // Records prepared before launch naming existed still get a readable
        // name: ref plus title is the same derivation the store now stores.
        name: ticket.dispatch?.launchName
          || dispatchLaunchName(ticket.ref || launch.ref, ticket.title, ticket.dispatch?.launchSeq),
        ref: launch.ref,
        token: launch.token,
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

function briefingCommandDrifted(prompt: unknown, spawn: PreparedDispatchSpawn): boolean {
  if (typeof prompt !== 'string' || !/FIRST action:\s*run/i.test(prompt)) return false;
  const command = /FIRST action:\s*run\s+`([^`]+)`/i.exec(prompt)?.[1];
  if (!command) return true;
  const refs = extractRefs(command);
  return !/sidequest-launcher\.js["']?\s+briefing\b/i.test(command)
    || refs.length !== 1
    || refs[0] !== spawn.ref
    || extractDispatchToken(command) !== spawn.token
    || extractProjectArg(command) !== spawn.project;
}

function correctionMessage(corrections: string[]): string | null {
  return corrections.length ? `sidequest: corrected prepared dispatch ${corrections.join(' and ')}.` : null;
}

function denyReason(result: ResolveResult, type: string): string {
  const retry = 'Re-read the wave (`ready --brief`) and re-spawn with `model: exec.model`.';
  const base = `sidequest: ${type} was spawned without \`model\` and it couldn't be resolved`;
  switch (result.status) {
    case 'no-refs':
      return `${base} — no SQ-\\d+ ticket ref was found in the prompt. ${retry}`;
    case 'no-project':
      return `${base} — the board for ${result.refs.join(', ')} couldn't be determined (no --project, cwd, or CLAUDE_PROJECT_DIR resolved to a registered board). ${retry}`;
    case 'ticket-not-found':
      return `${base} — ${result.missing} wasn't found on the resolved board. ${retry}`;
    case 'ticket-not-builtin':
      return `${base} — ${result.ref} resolves to a Codex route, which spawns its own pinned executor, not a builtin. Re-read the wave (\`ready --brief\`) and spawn its \`exec.agent\` instead.`;
    case 'conflicting':
      return `${base} — ${result.refs.join(', ')} resolve to conflicting concrete models (${(result.models || []).join(', ')}). That's an illegal mixed-model batch: split it per model and re-spawn each with its own \`model: exec.model\`.`;
    default:
      return `${base}. ${retry}`;
  }
}

function helperScopes(input: HookInput): HelperScopeResolution {
  const agentId = stringField(input, 'agent_id', 'agentId');
  const type = stringField(input, 'agent_type', 'agentType', 'subagent_type');
  const sessionId = stringField(input, 'session_id', 'sessionId') || process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || '';
  if (!agentId || !type || !sessionId || isCurrentExecutor(classifyExecutor(type))) return { status: 'no-active-ticket', scopes: [] };
  try {
    const store = require(runtimeModule('store')) as Store;
    const activeTickets: Array<{ project: string; projectPath: string; ticket: Ticket }> = [];
    for (const project of store.listProjects({ all: true })) {
      const projectPath = String(store.readMeta(project.slug)?.path || '').trim();
      if (!projectPath) continue;
      for (const ticket of store.listTickets(project.slug)) {
        if (!ticket.claim?.by || ticket.dispatch?.terminalAt || ticket.dispatch?.sessionId !== sessionId || !ticket.ref) continue;
        activeTickets.push({ project: project.slug, projectPath, ticket });
      }
    }
    if (!activeTickets.length) return { status: 'no-active-ticket', scopes: [] };
    // A per-ticket generated executor definition carries the dispatch's agentName as its
    // type, and its runtime id never binds, so identity has to match either field. A true
    // helper spawned by an executor matches neither; it inherits the sole active ticket,
    // which is unambiguous by construction. Two or more still refuse rather than borrow.
    const ownedTickets = activeTickets.filter(({ ticket }) => {
      const dispatch = ticket.dispatch;
      return dispatch?.agentId === agentId
        || (dispatch?.agentName && (dispatch.agentName === agentId || dispatch.agentName === type));
    });
    const owners = ownedTickets.length ? ownedTickets : activeTickets;
    if (owners.length !== 1) return { status: 'no-owner', scopes: [] };
    const owner = owners[0]!;
    return {
      status: 'ok',
      scopes: [{ ref: owner.ticket.ref!, projectPath: owner.projectPath, files: store.effectiveScope(owner.project, owner.ticket.files) }],
    };
  } catch (_) {
    return { status: 'no-active-ticket', scopes: [] };
  }
}

function writeTarget(input: HookInput): string {
  const toolInput = toolInputOf(input);
  if (!toolInput) return '';
  const raw = toolInput.file_path ?? toolInput.notebook_path ?? toolInput.path;
  if (raw == null || !String(raw).trim()) return '';
  const cwd = stringField(input, 'cwd') || process.cwd();
  return path.resolve(cwd, String(raw));
}

function projectRelative(target: string, projectPath: string): string | null {
  const relative = path.relative(projectPath, target).replace(/\\/g, '/');
  if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) return null;
  const worktree = /^\.claude\/worktrees\/[^/]+\/(.+)$/.exec(relative);
  return worktree ? worktree[1] || null : relative;
}

function inScope(target: string, scope: HelperScope): boolean {
  const relative = projectRelative(target, scope.projectPath);
  if (!relative) return false;
  const key = process.platform === 'win32' ? relative.toLowerCase() : relative;
  return scope.files.some((file) => {
    const normalized = String(file || '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    const scopeKey = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
    return key === scopeKey || key.startsWith(`${scopeKey}/`);
  });
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
  if (resolution.status === 'no-active-ticket') return;
  const target = writeTarget(input);
  if (!target) return;
  if (resolution.status === 'no-owner') {
    writeDeny(
      'PreToolUse',
      `sidequest: refusing helper write to ${target}. No active ticket is bound to acting agent ${stringField(input, 'agent_id', 'agentId')}; refusing to borrow another ticket's scope.`,
    );
    return;
  }
  const scope = resolution.scopes[0]!;
  if (isScratchpadPath(target) || inScope(target, scope)) return;
  const display = projectRelative(target, scope.projectPath) || target;
  writeDeny(
    'PreToolUse',
    `sidequest: refusing helper write to ${display}. It is outside ${scope.ref}'s effective scope. Route this path through the parent executor as a scope request or file a new ticket.`,
  );
}

// A steer aimed at an executor that already finished is dropped on the floor: the
// teammate wakes, the idle guard ends it, and the instruction is gone. The sender is
// the only party holding the text, so this is the one place it can be saved.
function guardLateSteer(input: HookInput): void {
  const toolInput = toolInputOf(input);
  const recipient = String(toolInput?.to || '').trim();
  const message = toolInput?.message;
  if (!recipient || typeof message !== 'string' || !message.trim()) return;
  try {
    const store = require(runtimeModule('store')) as Store;
    const terminal = store.terminalDispatchTarget(recipient);
    if (!terminal) return;
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

function main(): void {
  const input = readStdin();
  if (!input) return;
  const toolName = stringField(input, 'tool_name');
  if (toolName === 'SendMessage') {
    guardLateSteer(input);
    return;
  }
  if (WRITE_TOOLS.has(toolName)) {
    guardHelperWrite(input);
    return;
  }
  if (toolName !== 'Agent') return;
  const toolInput = toolInputOf(input);
  if (!toolInput) return;
  const type = String(toolInput.subagent_type || '');
  const classification = classifyExecutor(type);
  if (isSubagentCaller(input) && !isCurrentExecutor(classification)) {
    rewriteExecutorHelper(input, toolInput, type);
    return;
  }
  if (PASS_THROUGH_AGENT_TYPES.has(type)) return;
  if (!isCurrentExecutor(classification)) {
    writeDeny('PreToolUse', agentDenyReason(type, classification));
    return;
  }

  const subagentOverride = String(process.env.CLAUDE_CODE_SUBAGENT_MODEL || '').trim();
  if (subagentOverride) {
    writeDeny(
      'PreToolUse',
      `sidequest: CLAUDE_CODE_SUBAGENT_MODEL="${subagentOverride}" is set — it overrides every sidequest ` +
        `executor's routed model (a Codex route would silently run on a Claude model; builtins collapse to one ` +
        `route), defeating routing. Unset it before spawning sidequest executors.`,
    );
    return;
  }

  const updatedInput: Record<string, unknown> = {
    ...toolInput,
    mode: 'bypassPermissions',
    ...(isSubagentCaller(input) ? { run_in_background: true } : {}),
  };
  if (isSubagentCaller(input)) delete updatedInput.isolation;
  const dispatchValidation = preparedDispatchValidation(input);
  if (dispatchValidation.status === 'stale') {
    writeDeny('PreToolUse', 'sidequest: dispatch token is stale or rotated. Re-run dispatch and pass its spawn unchanged.');
    return;
  }
  const preparedSpawn = dispatchValidation.spawn;
  if (preparedSpawn && briefingCommandDrifted(toolInput.prompt, preparedSpawn)) {
    writeDeny('PreToolUse', 'sidequest: dispatch briefing command must match the prepared spawn. Re-run dispatch and pass its spawn unchanged.');
    return;
  }
  const corrections: string[] = [];
  if (preparedSpawn?.description && toolInput.description !== preparedSpawn.description) {
    updatedInput.description = preparedSpawn.description;
    corrections.push('description');
  }
  if (preparedSpawn && toolInput.name !== preparedSpawn.name) {
    updatedInput.name = preparedSpawn.name;
    corrections.push('name');
  }
  const launchAgentName = preparedSpawn?.name || dispatchAgentName(input);
  if (launchAgentName) updatedInput.name = launchAgentName;
  const preparedCorrection = correctionMessage(corrections);

  if (classification.kind === 'codex_dispatch' || classification.kind === 'read_only_codex_dispatch') {
    const markers = dispatchRouteMarkers(input);
    const routeModels = [...new Set(markers.map((marker) => marker.model))];
    // The prompt marker carries the gateway model form, so compare it against
    // route.marker (recorded at dispatch-prepare since 3.6.7), not the board
    // slug in route.model — those never match for codex routes. Falling back
    // to route.model keeps pre-3.6.7 prepared dispatches denied into the
    // "re-run dispatch" path, which records the marker.
    if (preparedSpawn?.route && markers.some((marker) =>
      marker.model !== (preparedSpawn.route?.marker ?? preparedSpawn.route?.model)
        || marker.effort !== preparedSpawn.route?.effort)) {
      writeDeny('PreToolUse', 'sidequest: dispatch route marker must match the prepared spawn. Re-run dispatch and pass the returned spawn unchanged.');
      return;
    }
    if (!routeModels.length) {
      writeDeny('PreToolUse', 'sidequest: dispatch executor is missing the route marker from spawn.prompt. Re-run dispatch and pass the returned spawn unchanged.');
      return;
    }
    // The collapsed dispatch names carry no effort (classification.effort is null): the
    // marker owns it and the prepared-spawn comparison above audits it against the
    // board. The name-vs-marker check only applies to legacy per-effort executors,
    // where a stale name could silently contradict the marker.
    const mismatch = classification.effort === null
      ? null
      : markers.find((marker) => marker.effort !== classification.effort);
    if (mismatch) {
      writeDeny('PreToolUse', `sidequest: dispatch executor effort "${classification.effort}" does not match route marker effort "${mismatch.effort}". Re-run dispatch and pass the returned spawn unchanged.`);
      return;
    }
    if (routeModels.length > 1) {
      writeDeny(
        'PreToolUse',
        `sidequest: this batch mixes tickets stamped with different models (${routeModels.join(', ')}) under one ` +
          `dispatch executor — every ticket would silently run on the last route marker's model. Split the batch ` +
          `per model and re-spawn each with its own dispatch prompt.`,
      );
      return;
    }
    const hadModel = Object.prototype.hasOwnProperty.call(toolInput, 'model');
    if (hadModel) delete updatedInput.model;
    recordAuthoritativeLaunch(input, type, launchAgentName);
    const messages = [
      preparedCorrection,
      hadModel ? `sidequest: removed the Agent model override for ${type}; its frontmatter pin selects the routed backend.` : null,
    ].filter((message): message is string => Boolean(message));
    writeJson({
      ...(messages.length ? { systemMessage: messages.join(' ') } : {}),
      hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput },
    });
    return;
  }

  const hasModel = Object.prototype.hasOwnProperty.call(toolInput, 'model') && toolInput.model != null && toolInput.model !== '';
  if (!hasModel) {
    const result = resolveStampedModel(input);
    if (result.status === 'ok' && result.model) {
      updatedInput.model = result.model;
      recordAuthoritativeLaunch(input, type, launchAgentName);
      writeJson({
        systemMessage: [
          preparedCorrection,
          `sidequest: ${type} spawned without a model — injected "${result.model}" from ${result.refs.join(', ')}'s resolved category route. Always pass model: exec.model on Claude routes.`,
        ].filter(Boolean).join(' '),
        hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput },
      });
      return;
    }
    writeDeny('PreToolUse', denyReason(result, type));
    return;
  }

  const result = resolveStampedModel(input);
  if (result.status === 'ok' && result.model !== toolInput.model) {
    recordAuthoritativeLaunch(input, type, launchAgentName);
    writeJson({
      systemMessage: [
        preparedCorrection,
        `sidequest: ${type} was spawned with model "${String(toolInput.model)}" but ${result.refs.join(', ')} resolves to "${result.model}" — kept the caller's value; confirm the cap is deliberate.`,
      ].filter(Boolean).join(' '),
      hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput },
    });
    return;
  }
  recordAuthoritativeLaunch(input, type, launchAgentName);
  writeJson({
    ...(preparedCorrection ? { systemMessage: preparedCorrection } : {}),
    hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput },
  });
}

try {
  main();
} catch (_) {
  process.exit(0);
}
