#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { readStdin, stringField, type HookInput } from './shared/input.js';
import { writeContext } from './shared/output.js';
import { pluginRoot, runtimeModule } from './shared/paths.js';
import { initializeCompactionState, isPrimarySession } from './shared/compaction.js';
import { runSweep } from './shared/sweep-handoff.js';
import { registerSweepSession } from './shared/worktree-sweep.js';
import { diagnosticWorktreeWarning } from './diagnostic-worktree-warning.js';
import { reportLoadedSidequestVersion, sidequestReloadWarning } from '../lib/plugin-freshness.js';
import { classify } from '../lib/exec-names.js';

const MAX_SESSION_CONTEXT_BYTES = 4 * 1024;
const MAX_WORKFORCE_BYTES = 800;
const MAX_WORKFORCE_DESCRIPTION = 90;

interface Category {
  id: string;
  description?: string;
}

interface LifecycleTicket {
  archived?: boolean;
  claimLive?: boolean;
  dispatch?: { terminalAt?: string | null } | null;
  project?: string;
  status?: string;
  submission?: { commit?: string; integratedAt?: string | null } | null;
}

interface RegisteredProject {
  name: string;
  path: string;
}

interface Store {
  nearestRepoRoot: (start: string) => string;
  findProject: (start: string) => { ok: boolean; slug?: string };
  listProjects: (options: { all: boolean }) => RegisteredProject[];
  getCategories: (options: { project?: string; includeDisabled: boolean }) => Category[];
  resolveCategoryRoute: (category: Category) => { model: string; effort: string; exec?: unknown };
  projectDispatchAdmission: (slug: string) => { status: string };
  sweepStaleClaims: (options: { source: string }) => unknown;
  reconcileLaunchedDispatches: (sessionId: string, options: { source: string }) => { reconciled?: string[] } | null;
  worktreeGcTickets: () => LifecycleTicket[];
}

function truncateText(value: unknown, max: number): string {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : text.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

function workforceSection(): string {
  try {
    const store = require(runtimeModule('store')) as Store;
    const start = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const found = store.findProject(store.nearestRepoRoot(start));
    const project = found.ok && found.slug ? found.slug : '';
    if (!project || store.projectDispatchAdmission(project).status !== 'routed') return '';
    const header = 'YOUR EXECUTORS — delegate work AND investigation to them:';
    const entries = store.getCategories({ project, includeDisabled: false }).map((category) => {
      const route = store.resolveCategoryRoute(category);
      return {
        id: String(category.id || '').trim(),
        route: `(${route.model}·${route.effort})`,
        description: truncateText(category.description, MAX_WORKFORCE_DESCRIPTION),
        usable: Boolean(route.exec),
      };
    }).filter((entry) => entry.usable);
    const priority = new Set(['codebase-exploration', 'debugging', 'spike-investigation', 'source-lookup', 'evidence-research', 'visual-evaluation']);
    const preferred = [...entries.filter((entry) => priority.has(entry.id)), ...entries.filter((entry) => !priority.has(entry.id))];
    const bytesFor = (lines: string[]) => Buffer.byteLength([header, ...lines].join('\n'));
    const base = preferred.map((entry) => `${entry.id} — ${entry.route}`);
    if (bytesFor(base) > MAX_WORKFORCE_BYTES) {
      const bounded: string[] = [];
      for (let index = 0; index < base.length; index += 1) {
        const line = base[index] || '';
        const truncation = `… ${base.length - index} more enabled categories.`;
        if (bytesFor([...bounded, line, truncation]) > MAX_WORKFORCE_BYTES) return [header, ...bounded, truncation].join('\n');
        bounded.push(line);
      }
    }
    const descriptions = new Map<string, string>();
    for (const entry of preferred) {
      if (!entry.description) continue;
      descriptions.set(entry.id, entry.description);
      const lines = preferred.map((candidate) => `${candidate.id} — ${descriptions.get(candidate.id) ? descriptions.get(candidate.id) + ' ' : ''}${candidate.route}`);
      if (bytesFor(lines) > MAX_WORKFORCE_BYTES) descriptions.delete(entry.id);
    }
    return [header, ...preferred.map((entry) => `${entry.id} — ${descriptions.get(entry.id) || 'enabled'} ${entry.route}`)].join('\n');
  } catch (_) {
    return '';
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  let result = '';
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character);
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function withWorkforce(context: string): string {
  const section = workforceSection();
  if (!section) return truncateUtf8(context, MAX_SESSION_CONTEXT_BYTES);
  const contextBytes = MAX_SESSION_CONTEXT_BYTES - Buffer.byteLength(section) - 1;
  return `${truncateUtf8(context, Math.max(0, contextBytes))}\n${section}`;
}


function nudgeOff(): boolean {
  const value = String(process.env.SIDEQUEST_NUDGE || '').trim().toLowerCase();
  return value === 'off' || value === '0' || value === 'false' || value === 'no';
}

// Only a registered board makes this session an orchestrator. Claim and dispatch records cannot mark an executor:
// native executors run inside the orchestrator's process and share its session id, so a headless executor session
// is known by its launch identity instead (GH-225).
function sessionRole(data: HookInput): 'orchestrator' | 'executor' | 'plain' {
  if (process.env.SIDEQUEST_AGENT || classify(stringField(data, 'agent_type', 'agentType')).kind !== 'unknown') return 'executor';
  return projectHasBoard(data) ? 'orchestrator' : 'plain';
}

function projectHasBoard(data: HookInput): boolean {
  try {
    const store = require(runtimeModule('store')) as Store;
    return store.findProject(store.nearestRepoRoot(sessionProjectStart(data))).ok;
  } catch (_) {
    return true;
  }
}

function sessionProjectStart(data: HookInput): string {
  return stringField(data, 'cwd', 'project_dir', 'projectDir') || process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

function checkpointingGuidance(data: HookInput): string {
  const model = stringField(data, 'model').toLowerCase();
  const tier = model.includes('haiku') ? 'Haiku' : model.includes('sonnet') ? 'Sonnet' : '';
  if (!tier) return '';
  return ` CHECKPOINT MODE (${tier}): proceed on cheap reversible config and route edits; ask before irreversible spend, deletion, or an incomplete-evidence judgment.`;
}

function dispatchAdmissionStatus(data: HookInput): string {
  try {
    const store = require(runtimeModule('store')) as Store;
    const start = stringField(data, 'cwd', 'project_dir', 'projectDir') || process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const found = store.findProject(store.nearestRepoRoot(start));
    return found.ok && found.slug ? store.projectDispatchAdmission(found.slug).status : 'no-project';
  } catch (_) {
    return 'no-project';
  }
}

function lostLaunchNotices(data: HookInput): string[] {
  try {
    const sessionId = stringField(data, 'session_id', 'sessionId') || process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || '';
    const store = require(runtimeModule('store')) as Store;
    const reconciled = store.reconcileLaunchedDispatches(sessionId, { source: 'session-start' })?.reconciled || [];
    return reconciled.length ? [`sidequest: ${reconciled.join(', ')} launched but never claimed. Re-dispatch and spawn the returned spec.`] : [];
  } catch (_) {
    return [];
  }
}

function upstreamDefectDestination(): string {
  try {
    const store = require(runtimeModule('store')) as Store;
    const project = store.listProjects({ all: true }).find((candidate) => {
      const root = String(candidate.path || '').trim();
      return root && fs.existsSync(path.join(root, 'plugins', 'sidequest', '.claude-plugin', 'plugin.json'));
    });
    if (project) return `Offer to file it as a ticket on the ${project.name} board on this machine (the Toolshed working copy), not via the Anthropic feedback tool.`;
  } catch (_) {}
  return 'Offer to file it as a GitHub issue on Eigenwise/eigenwise-toolshed, not via the Anthropic feedback tool. Any GitHub body, comment, reply, or closure note you author must stand alone: summarize a sanitized reproduction, relevant findings, and version with public issue, PR, commit, or release links; omit local SQ-/US- IDs, board slugs, local-only paths, and board-only references. Preserve reporter text unless authorized to edit it; do not strip diagnostic error text or hand-edit historical changelogs or generated release history.';
}

function hasMidWaveBoard(data: HookInput): boolean {
  if (process.env.SIDEQUEST_AGENT) return false;
  const source = stringField(data, 'source');
  if (source !== 'startup' && source !== 'resume') return false;
  try {
    const store = require(runtimeModule('store')) as Store;
    const start = stringField(data, 'cwd', 'project_dir', 'projectDir') || process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const found = store.findProject(store.nearestRepoRoot(start));
    if (!found.ok || !found.slug) return false;
    return store.worktreeGcTickets().some((ticket) => ticket.project === found.slug
      && !ticket.archived
      && ticket.status !== 'done'
      && (Boolean(ticket.submission?.commit && !ticket.submission.integratedAt)
        || Boolean(ticket.claimLive && ticket.dispatch && !ticket.dispatch.terminalAt)));
  } catch (_) {
    return false;
  }
}

// Sweep reports and lost-launch notices are drained once, so a session that gets no briefing still gets them.
function briefingWithheld(data: HookInput, notice: string): boolean {
  if (nudgeOff()) return true;
  if (sessionRole(data) === 'orchestrator') return false;
  if (notice) writeContext('SessionStart', notice);
  return true;
}

function emit(context: string, notice: string, initialUserMessage = ''): void {
  const output = notice ? `${notice}\n${context}` : context;
  writeContext('SessionStart', withWorkforce(output), initialUserMessage);
}

function isRestoredContext(source: string): boolean {
  return source === 'compact' || source === 'resume';
}

function startCompactionTracking(data: HookInput): void {
  const sessionId = stringField(data, 'session_id', 'sessionId') || process.env.CLAUDE_CODE_SESSION_ID || '';
  initializeCompactionState(sessionId, data.transcript_path || data.transcriptPath);
}

async function restartNoticeFor(data: HookInput, primarySession: boolean): Promise<string> {
  const freshnessNotice = sidequestReloadWarning(sessionProjectStart(data), { pluginRoot: pluginRoot() });
  registerSweepSession(data);
  const sweepNotices = primarySession ? lostLaunchNotices(data) : [];
  try {
    sweepNotices.push(...await runSweep(data));
  } catch (error: unknown) {
    sweepNotices.push(`sidequest: worktree sweep failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return [
    freshnessNotice,
    isRestoredContext(stringField(data, 'source')) ? '' : diagnosticWorktreeWarning(data),
    ...sweepNotices,
  ].filter(Boolean).join('\n');
}

// The standing authorization leads the block: buried mid-paragraph, sessions kept offering dispatch instead of doing it (SQ-3181).
const ROUTED_GUIDANCE = {
  standingAuthorization: 'A usable Sidequest project route is standing authorization to file tickets and dispatch returned executors without offering it or asking for a further user request when work is a multi-file change, at an unknown location that needs discovery, or an investigation.\n',
  boardAuthorization: 'Quick edits at a named or known location, one-line fixes, operational requests, and direct questions stay inline and do not load user-story. For work beyond a small task, load the user-story skill before ticketing or dispatching; do not plan it inline. For independent per-item work, shard implementation and read-only investigation tickets, then dispatch each wave concurrently; isolated-worktree overlap is an integration concern, while sequential dependencies or a shared design decision stay together. Ask before work beyond the approved scope unless explicit standing permission covers it.',
  inlineBoundary: '',
  fanoutGuidance: '',
};
const UNROUTED_GUIDANCE = {
  standingAuthorization: '',
  boardAuthorization: 'Sidequest has no usable project route here, so substantive work may stay inline. Use board_config to enable a category with an available executor before asking for board dispatch.',
  inlineBoundary: 'Specific one-file or one-prompt asks stay inline unless dependency or risk warrants dispatch; say why. Ask before work beyond the approved scope unless explicit standing permission covers it.',
  fanoutGuidance: 'For independent per-item work, shard implementation and read-only investigation tickets, then dispatch each wave concurrently; isolated-worktree overlap is an integration concern, while sequential dependencies or a shared design decision stay together.',
};

function emitOrchestratorBriefing(data: HookInput, restartNotice: string): void {
  const cli = `node "${pluginRoot()}/bin/sidequest.js"`;
  const watch = `Arm a persistent Monitor running ${cli} watch --project <path>; ticket alerts default to dispatches prepared by this session plus unowned and terminal tickets, while failed GitHub CI runs stay project-wide. Use --all for project-wide ticket alerts. Skip it if Monitor is unavailable.`;
  const { standingAuthorization, boardAuthorization, inlineBoundary, fanoutGuidance } = dispatchAdmissionStatus(data) === 'routed'
    ? ROUTED_GUIDANCE
    : UNROUTED_GUIDANCE;
  const upstreamDefects = `If Sidequest itself misbehaves (a refusal contradicting observed state, a dead retrieval handle, a guard loop, a reproducible tool error), report it to the user with the reproducing evidence as an upstream defect; never encode a workaround into project rules, hooks, or memory, and mark any unavoidable stopgap temporary, naming the defect it awaits. ${upstreamDefectDestination()}`;
  const checkpointGuidance = checkpointingGuidance(data);
  const checkpoint = checkpointGuidance ? `${checkpointGuidance} ` : '';
  const recovery = 'Context is UTF-8 bounded. Omitted details name a typed board retrieval call.';
  const initialUserMessage = hasMidWaveBoard(data) ? '/sidequest:sidequest' : '';

  if (isRestoredContext(stringField(data, 'source'))) {
    emit(
      `=== sidequest (active — context restored) ===\n${standingAuthorization}${recovery}\nROLE: ORCHESTRATOR. ${checkpoint}${boardAuthorization} ${watch} ${inlineBoundary} ${fanoutGuidance} ${upstreamDefects} Dispatch executors with the returned spawn unchanged. Ticket and dispatch before multi-file investigation. never TaskOutput. If Board MCP is unavailable, stop and tell the user to run /mcp and reconnect plugin:sidequest:board, or restart Claude Code; do not retry. Use pulse/changes for liveness; the board, not a replayed background-task reminder, decides ticket state, so a reminder about a finished agent needs no action. If the host still lists a terminal ticket's executor as running, or keeps reporting it stopped with background work still running, TaskStop it once and never resume or message it. An executor ends its own run at submit, done, or release, so terminal board evidence needs no TaskStop; TaskStop is host cleanup only when pulse still shows one alive after its ticket went terminal. A dispatch that died before its first claim is retired from this session with dispatch recoveryEvidence (the host failure report), never release or TaskStop. Keep live claims, retained continuations, and integration candidates steerable. If a board path refuses verified work, deliver it yourself through groomClose with deliveryCommit and record the refusal evidence. Board MCP is the lifecycle authority; no Sidequest CLI or raw Agent fallback.`,
      restartNotice,
      initialUserMessage,
    );
    return;
  }

  emit(
    `=== sidequest (active) ===\n${standingAuthorization}${recovery}\nROLE: ORCHESTRATOR. ${checkpoint}${boardAuthorization} ${watch} ${inlineBoundary} ${fanoutGuidance} ${upstreamDefects} Substantive multi-file changes and investigations need tickets, then dispatch and the returned executor. Operational requests can run inline. Use board MCP tools first. Tiny lookups use Read, Glob, Grep, or WebFetch. Do not use TaskOutput. One diagnose-first retry; two failures need evidence and user escalation. An executor ends its own run at submit, done, or release, so terminal board evidence needs no TaskStop; TaskStop is host cleanup only when pulse still shows one alive after its ticket went terminal. A dispatch that died before its first claim is retired from this session with dispatch recoveryEvidence (the host failure report), never release or TaskStop. Keep live claims, retained continuations, and integration candidates steerable. When a board path refuses verified work, deliver it yourself through groomClose with deliveryCommit and record the refusal evidence. Workers own claimed work and report conflicts, verification, and cleanup.`,
    restartNotice,
    initialUserMessage,
  );
}

async function main(): Promise<void> {
  const data = readStdin();
  if (!data) return;
  const primarySession = isPrimarySession(data);
  if (primarySession) startCompactionTracking(data);

  reportLoadedSidequestVersion(data, { pluginRoot: pluginRoot() });
  const restartNotice = await restartNoticeFor(data, primarySession);
  if (briefingWithheld(data, restartNotice)) return;
  emitOrchestratorBriefing(data, restartNotice);
}

main().catch((error: unknown) => {
  console.error(`sidequest: session-start failed: ${error instanceof Error ? error.message : String(error)}`);
});
