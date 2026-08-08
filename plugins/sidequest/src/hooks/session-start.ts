#!/usr/bin/env node
import { readStdin, stringField, type HookInput } from './shared/input.js';
import { writeContext } from './shared/output.js';
import { pluginRoot, runtimeModule } from './shared/paths.js';
import { initializeCompactionState, isPrimarySession } from './shared/compaction.js';
import { runSweep } from './shared/sweep-handoff.js';
import { registerSweepSession } from './shared/worktree-sweep.js';
import { diagnosticWorktreeWarning } from './diagnostic-worktree-warning.js';
import { reportLoadedSidequestVersion, sidequestReloadWarning } from '../lib/plugin-freshness.js';

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
  resolveCategoryRoute: (category: Category) => { model: string; effort: string };
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
    const header = 'YOUR EXECUTORS — delegate work AND investigation to them:';
    const entries = store.getCategories({ project, includeDisabled: false }).map((category) => {
      const route = store.resolveCategoryRoute(category);
      return {
        id: String(category.id || '').trim(),
        route: `(${route.model}·${route.effort})`,
        description: truncateText(category.description, MAX_WORKFORCE_DESCRIPTION),
      };
    });
    const bytesFor = (lines: string[]) => Buffer.byteLength([header, ...lines].join('\n'));
    const base = entries.map((entry) => `${entry.id} — ${entry.route}`);
    if (bytesFor(base) > MAX_WORKFORCE_BYTES) {
      const bounded: string[] = [];
      for (let index = 0; index < base.length; index += 1) {
        const line = base[index] || '';
        const truncation = `… ${base.length - index} more enabled categories.`;
        if (bytesFor([...bounded, line, truncation]) > MAX_WORKFORCE_BYTES) return [header, ...bounded, truncation].join('\n');
        bounded.push(line);
      }
    }
    const priority = new Set(['codebase-exploration', 'debugging', 'spike-investigation', 'source-lookup', 'evidence-research']);
    const preferred = [...entries.filter((entry) => priority.has(entry.id)), ...entries.filter((entry) => !priority.has(entry.id))];
    const descriptions = new Map<string, string>();
    for (const entry of preferred) {
      if (!entry.description) continue;
      descriptions.set(entry.id, entry.description);
      const lines = entries.map((candidate) => `${candidate.id} — ${descriptions.get(candidate.id) ? descriptions.get(candidate.id) + ' ' : ''}${candidate.route}`);
      if (bytesFor(lines) > MAX_WORKFORCE_BYTES) descriptions.delete(entry.id);
    }
    return [header, ...entries.map((entry) => `${entry.id} — ${descriptions.get(entry.id) || 'enabled'} ${entry.route}`)].join('\n');
  } catch (_) {
    return '';
  }
}

function withWorkforce(context: string): string {
  const section = workforceSection();
  return section ? context + '\n' + section : context;
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
  const recovery = 'Context is UTF-8 bounded. Omitted details name a typed board retrieval call.';

  if (source === 'compact' || source === 'resume') {
    emit(
      `=== sidequest (active — context restored) ===\n${recovery}\nROLE: ORCHESTRATOR. Dispatch executors with the returned spawn unchanged. Ticket and dispatch before multi-file investigation. never TaskOutput. Use pulse/changes for liveness; TaskStop only after terminal board evidence. mcp__plugin_sidequest_board__* first; ${cli} list --status=doing only if MCP is absent.${checkpointingGuidance(data)}`,
      restartNotice,
    );
    return;
  }

  emit(
    `=== sidequest (active) ===\n${recovery}\nROLE: ORCHESTRATOR. Substantive changes and investigations need tickets, then dispatch and the returned executor. Operational requests can run inline. Use board MCP tools first. Tiny lookups use Read, Glob, Grep, or WebFetch. Do not use TaskOutput. One diagnose-first retry; two failures need evidence and user escalation. Workers own claimed work and report conflicts, verification, and cleanup.${checkpointingGuidance(data)}`,
    restartNotice,
  );
}

main().catch((error: unknown) => {
  console.error(`sidequest: session-start failed: ${error instanceof Error ? error.message : String(error)}`);
});
