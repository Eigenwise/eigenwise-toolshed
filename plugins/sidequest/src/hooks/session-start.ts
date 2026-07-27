#!/usr/bin/env node
import { readStdin, stringField, type HookInput } from './shared/input.js';
import { writeContext } from './shared/output.js';
import { pluginRoot, runtimeModule } from './shared/paths.js';
import { initializeCompactionState, isPrimarySession } from './shared/compaction.js';
import { sweepWorktrees } from './shared/worktree-sweep.js';

const MAX_WORKFORCE_BYTES = 1800;
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
    const priority = new Set(['codebase-exploration', 'debugging', 'spike-investigation', 'research']);
    const preferred = [...entries.filter((entry) => priority.has(entry.id)), ...entries.filter((entry) => !priority.has(entry.id))];
    const descriptions = new Map<string, string>();
    for (const entry of preferred) {
      if (!entry.description) continue;
      descriptions.set(entry.id, entry.description);
      const lines = entries.map((candidate) => `${candidate.id} — ${descriptions.get(candidate.id) ? descriptions.get(candidate.id) + ' ' : ''}${candidate.route}`);
      if (bytesFor(lines) > MAX_WORKFORCE_BYTES) descriptions.delete(entry.id);
    }
    return [header, ...entries.map((entry) => `${entry.id} — ${descriptions.get(entry.id) ? descriptions.get(entry.id) + ' ' : ''}${entry.route}`)].join('\n');
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
  return '\nCHECKPOINT MODE (' + tier + '): state your read and proceed on cheap-to-reverse config, category, or route edits. Ask only before an incomplete-evidence judgment ships, deletes data or refs, spends irreversible quota, or locks in work others build on. Do not ask for routine ticket filing, an exact user spec, or mechanical single-project work. `references/orchestrator-checkpointing.md`.';
}

function emit(context: string, notice: string): void {
  const output = notice ? context + '\n' + notice : context;
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
  const lostLaunches = reconcileLostLaunches(data);
  let sweepNotices: string[] = [];
  try {
    sweepNotices = await sweepWorktrees(data, true);
  } catch (error: any) {
    sweepNotices = [`sidequest: worktree sweep failed: ${(error && error.message) || error}`];
  }
  const restartNotice = [
    syncResult && syncResult.written > 0 ? (require(runtimeModule('agentsync')) as AgentSync).RESTART_NOTICE : '',
    lostLaunches.length ? `sidequest: ${lostLaunches.join(', ')} launched but never claimed before this reload. Their native task is gone; re-dispatch and spawn them, then pulse to confirm the token claim.` : '',
    ...sweepNotices,
  ].filter(Boolean).join('\n');

  if (nudgeOff()) return;
  const cli = `node "${pluginRoot()}/bin/sidequest.js"`;
  const source = stringField(data, 'source');

  if (source === 'compact' || source === 'resume') {
    emit(
      '=== sidequest (active — context restored) ===\n' +
        'ROLE: ORCHESTRATOR. Reload Sidequest. Use dispatch executor/spawn verbatim. Ticket + dispatch BEFORE multi-file exploration. Tiny lookup: Read, Glob, Grep, or WebFetch inline, not WebSearch. WebSearch is executor-only: file and dispatch a research ticket. USER-DIRECTED TRIVIAL EDIT: 1–2 exact user-named files, no investigation: Edit inline, no ticket/dispatch. Need other-file reading? Ticket it. `direct:true` needs `direct-ok` + reason; mcp__plugin_sidequest_board__list status=doing FIRST; `' + cli + ' list --status=doing`; mcp__plugin_sidequest_board__* absent (not errors)? Ask USER to `/reload-plugins`.\n' +
        'never TaskOutput; pulse ref/changes --since; TaskStop only after terminal board evidence. ONE diagnose-first retry, never blind respawn. Two failures: comment evidence + surface user. BOOKEND dispatch→submission: no unprompted reads/pulses/peeks; oracle=verify+wave suite+submit report; never re-review diffs/source.\n' +
        checkpointingGuidance(data),
      restartNotice,
    );
    return;
  }

  emit(
    '=== sidequest (active) ===\n' +
      'REQUIRED: Substantive changes/investigations need tickets; fresh `dispatch` returns executor/spawn/token. Every Agent uses it.\n' +
      'Operational requests (run/build/test app; start/stop dev server; open dashboard; answer from visible context): act inline, without the Sidequest skill, category_list, or board reads.\n' +
      'ROLE: you are this project\'s ORCHESTRATOR.\n' +
      checkpointingGuidance(data) +
      '\n' +
      'Reload the Sidequest skill before board work. SOLO-FIT picks one-executor vs wave; it NEVER means you implement inline. Small coherent work, or work whose contract cannot be pinned without doing it: ONE ticket, ONE executor. If spec pins shared types/interfaces, file bounds, and per-piece verifies, 3+ independently checkable pieces use contract-first: pin contract, one parallel wave to category-appropriate cheaper models, integrate once. Unpinnable only after a completed planning ticket that tried and names the specific resisting interface, or with no written contract surface; “feels coupled” is not evidence. Plan first when unsure. Wave mode: pre-dispatch, file COMPLETE backlog under a story; pin its contract: all tickets, declared files, dependencies, per-ticket verify. Dispatch the ready wave in parallel; never drip-file/dispatch/wait. Discoveries still file mid-run. Otherwise use checkable ATOMIC tickets; several deliverables are a smell. Passing done-oracle skips audit/fix unless high-stakes; full suite once/wave. An external tracker like Jira still uses Sidequest.\n' +
      '• Tiny lookup: Read, Glob, Grep, or WebFetch inline, not WebSearch. WebSearch is executor-only: file and dispatch a research ticket. USER-DIRECTED TRIVIAL EDIT: 1–2 exact user-named files, no investigation: Edit inline, no ticket/dispatch. Need other-file reading? Ticket it. Ticket + dispatch MUST precede multi-file exploration. `Explore`/`claude-code-guide`/`statusline-setup`: narrow harness recon. direct:true claims need user `direct-ok` + reason. Native results: never TaskOutput. pulse ref / changes --since; TaskStop only after terminal board evidence; never proxy-wait via shell/Monitor/cron polls or blocking TaskOutput. ONE diagnose-first retry, never blind respawn. Two failures: comment evidence + surface user. BOOKEND: between dispatch and submission, no unprompted ticket reads, pulses, or worktree peeks. Integrate by oracle: verify + wave suite + submit report; never re-review diffs or source. substantive actions are BLOCKED until claim. Use `bypassPermissions`; never `native_agent`.\n' +
      '• Batch small same-model tickets into ONE executor.\n' +
      '• Before each wave, assess shared runtime resources: fixed ports, domains, shared DBs, servers, and files outside declared scope. Serialize tickets that touch the same resource even across worktrees.\n' +
      '• Workers own their ticket and report conflicts, server lifecycle, files changed, blockers, and cleanup.\n' +
      'mcp__plugin_sidequest_board__ MCP tools FIRST; CLI fallback. If those tools are absent (not errors), ask USER to run `/reload-plugins`.',
    restartNotice,
  );
}

main().catch((error) => {
  console.error(`sidequest: session-start failed: ${(error && error.message) || error}`);
});
