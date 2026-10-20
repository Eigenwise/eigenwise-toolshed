#!/usr/bin/env node
// SessionStart waits only for this worker's handoff deadline, so store maintenance
// cannot make Claude discard the briefing with the hook's entire stdout.
import type { HookInput } from './shared/input.js';
import { runtimeModule, pluginRoot } from './shared/paths.js';
import path from 'node:path';
import { protectSweepFlight, releaseSweepFlight, sweepFlightOwned } from './shared/sweep-flight.js';
import { sweepWorktrees, withWorktreeSweepLock } from './shared/worktree-sweep.js';
import { clearSessionEndHandoff, writeReport } from './shared/sweep-handoff.js';

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
    notices.push(...await withWorktreeSweepLock(() => sweepWorktrees(data, true)));
  } catch (error: unknown) {
    notices.push(`sidequest: worktree sweep failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return notices;
}

function workerDeadlineMilliseconds(): number {
  const configured = Number(process.env.SIDEQUEST_SWEEP_WORKER_DEADLINE_MS);
  return Number.isFinite(configured) && configured > 0 ? Math.min(configured, 60_000) : 60_000;
}

async function superviseSweep(cwd: string, token: string): Promise<void> {
  if (!sweepFlightOwned(cwd, token)) return;
  const { runOwnedPhase } = require(path.join(pluginRoot(), 'scripts', 'owned-process-tree.js')) as {
    runOwnedPhase(options: {
      command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; timeoutMilliseconds: number;
      onPhaseStarted(owner: { ownerPid: number; ownedGroupId: number | null }): void;
    }): Promise<{ timedOut: boolean; cleanupError: string | null; status: number | null }>;
  };
  protectSweepFlight(cwd, token);
  const result = await runOwnedPhase({
    command: process.execPath,
    args: [path.join(pluginRoot(), 'hooks', 'sweep-worktrees.js'), '--cwd', cwd, '--session', argument('session')],
    // The project directory can be gone (a removed worktree); spawning inside it fails with ENOENT.
    cwd: process.cwd(),
    env: process.env,
    timeoutMilliseconds: workerDeadlineMilliseconds(),
    onPhaseStarted: ({ ownerPid, ownedGroupId }) => protectSweepFlight(cwd, token, ownedGroupId === null ? ownerPid : -ownedGroupId),
  });
  if (result.timedOut) writeReport(cwd, ['sidequest: worktree sweep reached its worker deadline; owned process-tree cleanup was requested.']);
  if (result.cleanupError) {
    protectSweepFlight(cwd, token);
    throw new Error(result.cleanupError);
  }
  releaseSweepFlight(cwd, token);
}

async function main(): Promise<void> {
  const cwd = argument('cwd') || process.cwd();
  const data = { cwd, session_id: argument('session') };
  if (argument('supervise')) return superviseSweep(cwd, argument('supervise'));
  writeReport(cwd, await sessionStartMaintenance(data));
  clearSessionEndHandoff(cwd);
}

main().catch((error: unknown) => {
  writeReport(argument('cwd') || process.cwd(), [
    `sidequest: session-start maintenance failed: ${error instanceof Error ? error.message : String(error)}`,
  ]);
});
