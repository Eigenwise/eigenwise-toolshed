#!/usr/bin/env node
// SessionStart waits only for this worker's handoff deadline, so store maintenance
// cannot make Claude discard the briefing with the hook's entire stdout.
import type { HookInput } from './shared/input.js';
import { runtimeModule } from './shared/paths.js';
import { sweepWorktrees } from './shared/worktree-sweep.js';
import { writeReport } from './shared/sweep-handoff.js';

interface Store {
  sweepStaleClaims: (options: { source: string }) => unknown;
}

interface SyncResult {
  written: number;
}

interface AgentSync {
  RESTART_NOTICE: string;
  cleanupNativeAgents: (options: { staleBefore: number }) => unknown;
  syncExecAgentsIfChanged: (prefs?: unknown, options?: unknown) => SyncResult;
}

function argument(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? String(process.argv[index + 1] || '') : '';
}

function releasedClaimNotices(result: unknown): string[] {
  if (!result || typeof result !== 'object' || !('released' in result) || !Array.isArray(result.released)) return [];
  return result.released.flatMap((released) => {
    if (!released || typeof released !== 'object' || !('ref' in released)) return [];
    const ref = String(released.ref || '').trim();
    if (!ref) return [];
    const kind = 'kind' in released ? String(released.kind || '').trim() : '';
    return [`sidequest: released ${kind || 'stale'} claim ${ref}.`];
  });
}

function migrateLegacyExecAgentNotices(): string[] {
  try {
    const store = require(runtimeModule('store')) as Store;
    const sync = require(runtimeModule('agentsync')) as AgentSync;
    const sweepResult = store.sweepStaleClaims({ source: 'session-start' });
    sync.cleanupNativeAgents({ staleBefore: Date.now() - 6 * 60 * 60 * 1000 });
    const syncResult = sync.syncExecAgentsIfChanged();
    return [
      ...releasedClaimNotices(sweepResult),
      syncResult.written > 0 ? sync.RESTART_NOTICE : '',
    ].filter(Boolean);
  } catch (_) {
    return [];
  }
}

async function sessionStartMaintenance(data: HookInput): Promise<string[]> {
  const notices = migrateLegacyExecAgentNotices();
  try {
    notices.push(...await sweepWorktrees(data, true));
  } catch (error: unknown) {
    notices.push(`sidequest: worktree sweep failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return notices;
}

async function main(): Promise<void> {
  const cwd = argument('cwd') || process.cwd();
  const notices = await sessionStartMaintenance({ cwd, session_id: argument('session') });
  writeReport(cwd, notices);
}

main().catch((error: unknown) => {
  writeReport(argument('cwd') || process.cwd(), [
    `sidequest: session-start maintenance failed: ${error instanceof Error ? error.message : String(error)}`,
  ]);
});
