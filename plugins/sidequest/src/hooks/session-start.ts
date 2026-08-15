#!/usr/bin/env node
import { readStdin, stringField, type HookInput } from './shared/input.js';
import { writeContext } from './shared/output.js';
import { pluginRoot, runtimeModule } from './shared/paths.js';
import { initializeCompactionState, isPrimarySession } from './shared/compaction.js';
import { runSweep } from './shared/sweep-handoff.js';
import { registerSweepSession } from './shared/worktree-sweep.js';
import { diagnosticWorktreeWarning } from './diagnostic-worktree-warning.js';
import { reportLoadedSidequestVersion, sidequestReloadWarning } from '../lib/plugin-freshness.js';

const MAX_SESSION_CONTEXT_BYTES = 4 * 1024;
const MAX_WORKFORCE_BYTES = 800;
const MAX_WORKFORCE_DESCRIPTION = 90;

interface Category {
  id: string;
  description?: string;
}

interface Store {
  nearestRepoRoot: (start: string) => string;
  findProject: (start: string) => { ok: boolean; slug?: string };
  getCategories: (options: { project?: string; includeDisabled: boolean }) => Category[];
  resolveCategoryRoute: (category: Category) => { model: string; effort: string; exec?: unknown };
  projectDispatchAdmission: (slug: string) => { status: string };
  sweepStaleClaims: (options: { source: string }) => unknown;
  reconcileLaunchedDispatches: (sessionId: string, options: { source: string }) => { reconciled?: string[] } | null;
}

interface SyncResult {
  written: number;
  removed: number;
  unchanged: number;
  skipped?: boolean;
}

interface AgentSync {
  RESTART_NOTICE: string;
  cleanupNativeAgents: (options: { staleBefore: number }) => unknown;
  syncExecAgentsIfChanged: (prefs?: unknown, options?: unknown) => SyncResult;
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
    if (project && store.projectDispatchAdmission(project).status !== 'routed') return '';
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

function provisionExecAgents(): SyncResult | null {
  try {
    const store = require(runtimeModule('store')) as Store;
    const sync = require(runtimeModule('agentsync')) as AgentSync;
    store.sweepStaleClaims({ source: 'session-start' });
    sync.cleanupNativeAgents({ staleBefore: Date.now() - 6 * 60 * 60 * 1000 });
    return sync.syncExecAgentsIfChanged();
  } catch (_) {
    return null;
  }
}

function reconcileLostLaunches(data: HookInput): string[] {
  try {
    const sessionId = stringField(data, 'session_id', 'sessionId') || process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || '';
    const store = require(runtimeModule('store')) as Store;
    const result = store.reconcileLaunchedDispatches(sessionId, { source: 'session-start' });
    return result && Array.isArray(result.reconciled) ? result.reconciled : [];
  } catch (_) {
    return [];
  }
}

function nudgeOff(): boolean {
  const value = String(process.env.SIDEQUEST_NUDGE || '').trim().toLowerCase();
  return value === 'off' || value === '0' || value === 'false' || value === 'no';
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

function emit(context: string, notice: string): void {
  const output = notice ? `${notice}\n${context}` : context;
  writeContext('SessionStart', withWorkforce(output));
}

async function main(): Promise<void> {
  const data = readStdin();
  if (!data) return;
  if (isPrimarySession(data)) {
    const sessionId = stringField(data, 'session_id', 'sessionId') || process.env.CLAUDE_CODE_SESSION_ID || '';
    initializeCompactionState(sessionId, data.transcript_path || data.transcriptPath);
  }

  const syncResult = provisionExecAgents();
  reportLoadedSidequestVersion(data, { pluginRoot: pluginRoot() });
  const freshnessNotice = sidequestReloadWarning(stringField(data, 'cwd', 'project_dir', 'projectDir') || process.env.CLAUDE_PROJECT_DIR || process.cwd(), { pluginRoot: pluginRoot() });
  const lostLaunches = reconcileLostLaunches(data);
  registerSweepSession(data);
  let sweepNotices: string[] = [];
  try {
    sweepNotices = await runSweep(data);
  } catch (error: unknown) {
    sweepNotices = [`sidequest: worktree sweep failed: ${error instanceof Error ? error.message : String(error)}`];
  }
  const source = stringField(data, 'source');
  const restartNotice = [
    freshnessNotice,
    syncResult && syncResult.written > 0 ? (require(runtimeModule('agentsync')) as AgentSync).RESTART_NOTICE : '',
    lostLaunches.length ? `sidequest: ${lostLaunches.join(', ')} launched but never claimed. Re-dispatch and spawn the returned spec.` : '',
    source === 'compact' || source === 'resume' ? '' : diagnosticWorktreeWarning(data),
    ...sweepNotices,
  ].filter(Boolean).join('\n');

  if (nudgeOff()) return;
  const cli = `node "${pluginRoot()}/bin/sidequest.js"`;
  const watch = `Arm a persistent Monitor running ${cli} watch --project <path>; it interrupts you on scope requests, blockers, and failed GitHub CI runs. Skip it if Monitor is unavailable.`;
  const dispatchAdmission = dispatchAdmissionStatus(data);
  const boardAuthorization = dispatchAdmission === 'routed'
    ? 'A usable Sidequest project route authorizes ticket and executor dispatch without a further user request, overriding conservative default agent-spawning guidance. For substantive solo work beyond that inline boundary, say in your next reply that board dispatch is available and they can ask to use it.'
    : 'Sidequest has no usable project route here, so substantive work may stay inline. Do not ask for board dispatch until routing is enabled and an enabled category resolves to an available executor.';
  const inlineBoundary = 'Specific one-file or one-prompt asks stay inline unless dependency or risk warrants dispatch; say why. Ask before work beyond the approved scope unless explicit standing permission covers it.';
  const fanoutGuidance = 'For independent per-item work, shard tickets and dispatch concurrently; isolated-worktree overlap is an integration concern, while sequential dependencies or a shared design decision stay together.';
  const checkpoint = checkpointingGuidance(data);
  const recovery = 'Context is UTF-8 bounded. Omitted details name a typed board retrieval call.';

  if (source === 'compact' || source === 'resume') {
    emit(
      `=== sidequest (active — context restored) ===\n${recovery}\nROLE: ORCHESTRATOR. ${checkpoint}${checkpoint ? ' ' : ''}${boardAuthorization} ${watch} ${inlineBoundary} ${fanoutGuidance} Dispatch executors with the returned spawn unchanged. Ticket and dispatch before multi-file investigation. never TaskOutput. Reconnect Board MCP, re-dispatch, and spawn the exact returned executor before recovering lifecycle work. Use pulse/changes for liveness; a restored window replays background-task reminders that can name already-finished agents, so believe the board over them and do not investigate. After terminal board evidence is consumed and its handoff is preserved, retire the exact native teammate once with TaskStop({ task_id: "<agent name>" }); TaskStop is Claude Code host cleanup, not a Sidequest tool. Keep live claims, retained continuations, and integration candidates steerable. If a board path refuses verified work, deliver it yourself through groomClose with deliveryCommit and record the refusal evidence. Board MCP is the lifecycle authority; no Sidequest CLI or raw Agent fallback.`,
      restartNotice,
    );
    return;
  }

  emit(
    `=== sidequest (active) ===\n${recovery}\nROLE: ORCHESTRATOR. ${checkpoint}${checkpoint ? ' ' : ''}${boardAuthorization} ${watch} ${inlineBoundary} ${fanoutGuidance} Substantive multi-file changes and investigations need tickets, then dispatch and the returned executor. Operational requests can run inline. Use board MCP tools first. Tiny lookups use Read, Glob, Grep, or WebFetch. Do not use TaskOutput. One diagnose-first retry; two failures need evidence and user escalation. After terminal board evidence is consumed and its handoff is preserved, retire the exact native teammate once with TaskStop({ task_id: "<agent name>" }); TaskStop is Claude Code host cleanup, not a Sidequest tool. Keep live claims, retained continuations, and integration candidates steerable. When a board path refuses verified work, deliver it yourself through groomClose with deliveryCommit and record the refusal evidence. Workers own claimed work and report conflicts, verification, and cleanup.${checkpointingGuidance(data)}`,
    restartNotice,
  );
}

main().catch((error: unknown) => {
  console.error(`sidequest: session-start failed: ${error instanceof Error ? error.message : String(error)}`);
});
