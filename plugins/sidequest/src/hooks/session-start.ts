#!/usr/bin/env node
import { readStdin, stringField, type HookInput } from './shared/input.js';
import { writeContext } from './shared/output.js';
import { runtimeModule } from './shared/paths.js';

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
    const priority = new Set(['codebase-exploration', 'debugging', 'spike-investigation', 'deep-research', 'web-research']);
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

function emit(context: string, notice: string): void {
  const output = notice ? context + '\n' + notice : context;
  writeContext('SessionStart', withWorkforce(output));
}

function main(): void {
  const data = readStdin();
  if (!data) return;

  const syncResult = provisionExecAgents();
  const lostLaunches = reconcileLostLaunches(data);
  const restartNotice = [
    syncResult && syncResult.written > 0 ? (require(runtimeModule('agentsync')) as AgentSync).RESTART_NOTICE : '',
    lostLaunches.length ? `sidequest: ${lostLaunches.join(', ')} launched but never claimed before this reload. Their native task is gone; re-dispatch and spawn them, then pulse to confirm the token claim.` : '',
  ].filter(Boolean).join('\n');

  if (nudgeOff()) return;
  const cli = 'node "${CLAUDE_PLUGIN_ROOT}/bin/sidequest.js"';
  const source = stringField(data, 'source');

  if (source === 'compact' || source === 'resume') {
    emit(
      '=== sidequest (active — context restored) ===\n' +
        'ROLE: ORCHESTRATOR. Reload Sidequest. REQUIRED: Substantive work needs a board ticket; fresh dispatch\'s exact token-gated executor and spawn. Every Agent launch must use that executor. Ticket + dispatch BEFORE multi-file exploration: the second file you open to answer one question is the boundary. Tiny lookup: Read, Glob, Grep, or WebFetch inline; tracing code across files needs a spike ticket. Routed direct:true needs `direct-ok` + a reason; invalid: "the context is already loaded in this session", "it\'s a small patch", "a fresh executor would need context transfer / handoff costs more". Direct never retroactively legitimizes inline investigation. Use mcp__plugin_sidequest_board__list with status=doing FIRST; CLI fallback: `' + cli + ' list --status doing`.\n' +
        'Native results: never TaskOutput. pulse ref / changes --since; TaskStop only after terminal board evidence. ONE diagnose-first retry, never blind respawn. Two failures: comment evidence + surface user. one background timer, never foreground sleep loop.\n',
      restartNotice,
    );
    return;
  }

  emit(
    '=== sidequest (active) ===\n' +
      'ROLE: you are this project\'s ORCHESTRATOR, the most expensive model here. Executors execute/investigate and are cheaper: offload them; read only to write tickets.\n' +
      'Reload the Sidequest skill before acting. Plan multi-part: independently checkable ATOMIC tickets. ' +
      'Atomic = one change, investigation, spike, or review one agent checks. Split for parallelism; keep tightly coupled work together. ' +
      'Specs need exact anchors, contract, bounds/non-goals, dependencies/decisions, and a verify command, or the artifact/answer. several deliverables on one ticket is a smell: use a ticketed planning investigation that pins the shared contract, a wave fanning the pieces out. An external tracker such as Jira still uses Sidequest locally.\n' +
      'Execution economy:\n' +
      '• REQUIRED: Route execution DOWN: substantive changes and investigations are tickets; fresh `dispatch` returns executor, spawn, and token. Every Agent launch uses it. Tiny lookup: Read, Glob, Grep, or WebFetch inline. Ticket + dispatch MUST precede multi-file exploration: the second file is the boundary, never a ten-read retrospective. Any delegated work, including a quick investigation, is a spike ticket (usually `codebase-exploration`): file it, then route and dispatch. `Explore`, `claude-code-guide`, and `statusline-setup` are narrow harness reconnaissance utilities; other delegated implementation or investigation work needs a ticketed route. Routed direct:true needs user `direct-ok` + a reason; invalid: "the context is already loaded in this session", "it\'s a small patch", "a fresh executor would need context transfer / handoff costs more". Direct never retroactively legitimizes inline investigation. Native results: never TaskOutput. Liveness: pulse ref / changes --since; TaskStop only after terminal board evidence. Never proxy-wait: no Bash/PowerShell/Monitor/cron executor/report poll or blocking TaskOutput. Denied: pulse + deny, ONE diagnose-first retry only, never blind respawn. Two failures: comment evidence + surface user. Registration: one background timer, never foreground sleep loop. Inline: trivial one-step work; beyond allowance, substantive actions are BLOCKED until a claim. Use `bypassPermissions`; do not use `native_agent`.\n' +
      '• SHORT: category description; ticket description is executor brief; bounce back.\n' +
      '• Batch small SAME-model tickets into ONE executor; parallelize only independent tickets.\n' +
      '• Before each wave, assess shared runtime resources: fixed ports, domains, shared DBs, servers, and files outside declared scope. Serialize tickets that touch the same resource even across worktrees.\n' +
      '• Workers own their ticket and report conflicts, server lifecycle, files changed, blockers, and cleanup.\n' +
      '• File issues with mcp__plugin_sidequest_board__add, continue.\n' +
      'Board actions go through the mcp__plugin_sidequest_board__* MCP tools whenever available — reach for them FIRST; Bash+CLI is the fallback. Open the board: `' +
      cli + ' dashboard`.',
    restartNotice,
  );
}

try {
  main();
} catch (_) {
  process.exit(0);
}
