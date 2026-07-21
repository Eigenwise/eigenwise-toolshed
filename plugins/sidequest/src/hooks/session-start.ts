#!/usr/bin/env node
import { readStdin, stringField, type HookInput } from './shared/input.js';
import { writeContext } from './shared/output.js';
import { runtimeModule } from './shared/paths.js';

const MAX_TAXONOMY_BYTES = 400;
const MAX_TAXONOMY_IDS = 10;

interface Category {
  id: string;
}

interface ProjectCategory {
  id: string;
  kind: string;
}

interface Store {
  nearestRepoRoot: (start: string) => string;
  findProject: (start: string) => { ok: boolean; slug?: string };
  getCategories: (options: { project?: string; includeDisabled: boolean }) => Category[];
  getProjectCategories: (project: string) => { rows: ProjectCategory[] };
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

function taxonomyIds(ids: string[]): string {
  const shown = ids.slice(0, MAX_TAXONOMY_IDS);
  return shown.join(', ') + (shown.length < ids.length ? `, +${ids.length - shown.length} more` : '');
}

function taxonomyLine(): string {
  try {
    const store = require(runtimeModule('store')) as Store;
    const start = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const found = store.findProject(store.nearestRepoRoot(start));
    const project = found.ok && found.slug ? found.slug : '';
    const globalIds = store.getCategories({ includeDisabled: false }).map((category) => category.id);
    const effectiveIds = new Set(store.getCategories({ project, includeDisabled: false }).map((category) => category.id));
    const projectIds = project
      ? store.getProjectCategories(project).rows
        .filter((row) => row.kind === 'ADD' && effectiveIds.has(row.id))
        .map((row) => row.id)
      : [];
    const line = 'taxonomy (' + globalIds.length + '): ' + taxonomyIds(globalIds) +
      (projectIds.length ? ' | project: ' + taxonomyIds(projectIds) : '');
    return Buffer.byteLength(line) <= MAX_TAXONOMY_BYTES ? line : '';
  } catch (_) {
    return '';
  }
}

function withTaxonomy(context: string): string {
  const line = taxonomyLine();
  return line ? context + '\n' + line : context;
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
  writeContext('SessionStart', withTaxonomy(output));
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
        'Reload Sidequest. Gather enough evidence with Read, Glob, Grep, WebFetch, or Explore, then write precise tickets and route implementation by default. Use informed inline judgment. Routed ticket execution uses fresh dispatch\'s exact token-gated executor and spawn. Use mcp__plugin_sidequest_board__list with status=doing FIRST; CLI fallback: `' + cli + ' list --status doing`.\n' +
        'Native results: never TaskOutput. Liveness: pulse ref / changes --since; TaskStop only after terminal board evidence. Denied/unclaimed: pulse + deny verbatim, ONE diagnose-first retry, never blind respawn. Two failures: comment evidence + surface user. Registration: one background timer, never foreground sleep loop. Ack launch: confirm holder/token.\n',
      restartNotice,
    );
    return;
  }

  emit(
    '=== sidequest (active) ===\n' +
      'Reload the Sidequest skill before acting. Plan multi-part requests as independently checkable ATOMIC tickets. ' +
      'Atomic = one change, investigation, spike, or review a single agent finishes and checks. Split for parallelism: independent tickets fan out; keep tightly coupled work together. ' +
      'Specs need exact anchors, contract, bounds/non-goals, dependencies/decisions, and a verify command, or the artifact/answer. One ticket owning several deliverables (CLI + wiring + tests) is a smell: use a ticketed planning investigation that pins the shared contract, then a wave fanning the pieces out. An external tracker such as Jira still uses Sidequest locally.\n' +
      'Execution economy — expensive orchestrator, cheap executors:\n' +
      '• Route execution DOWN: gather enough evidence with read-only tools or Explore, then write precise tickets and route implementation by default. Use informed inline judgment. Fresh `dispatch` returns the exact stable executor, spawn, and token for routed ticket execution. Any implementation agent still needs a ticketed route; Explore and approved harness utilities are the narrow reconnaissance exceptions. Native results: never TaskOutput. Liveness: pulse ref / changes --since; TaskStop only after terminal board evidence. Never proxy-wait: no Bash/PowerShell/Monitor/cron executor/report poll or blocking TaskOutput on a proxy. Denied/unclaimed: pulse + deny reason verbatim; ONE diagnose-first retry only, never blind respawn. Two failures: comment evidence + surface user. Registration: one background timer, never foreground sleep loop. Claude passes `model: exec.model`; Codex omits it. Use `bypassPermissions`; do not use `native_agent`.\n' +
      '• SHORT: categories by description, not name; ticket description is executor brief; bounce back.\n' +
      '• Batch small SAME-model tickets into ONE executor; parallelize only independent tickets.\n' +
      '• Before each wave, assess shared runtime resources: fixed ports, domains, shared DBs, servers, and files outside declared scope. Serialize tickets that touch the same resource even across worktrees.\n' +
      '• Workers own their ticket and report conflicts, server lifecycle, files changed, blockers, and cleanup.\n' +
      '• File side issues with mcp__plugin_sidequest_board__add (or the CLI fallback), then keep working. Filing never asks you to work it.\n' +
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
