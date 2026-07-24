#!/usr/bin/env node
import { readStdin, stringField } from './shared/input.js';
import { runtimeModule } from './shared/paths.js';

function main(): void {
  const data = readStdin();
  if (!data) return;
  const sessionId = stringField(data, 'session_id', 'sessionId') || process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || '';
  if (!sessionId) return;
  const reasonValue = data.reason;
  const reason = reasonValue ? `session ended (${String(reasonValue)})` : 'session ended';
  try {
    const store = require(runtimeModule('store')) as {
      reconcileSession: (sessionId: string, options: { reason: string; source: string }) => unknown;
      nearestRepoRoot: (start: string) => string;
      findProject: (ref: string) => { ok: boolean; slug?: string; meta?: { path?: string } };
      integrationTarget: (slug: string) => { upstream: string; branch: string } | null;
      worktreeGcTickets: () => any[];
    };
    store.reconcileSession(sessionId, { reason, source: 'session-end' });
    const agentsync = require(runtimeModule('agentsync')) as {
      cleanupNativeAgents: (options: { sessionId: string }) => unknown;
    };
    agentsync.cleanupNativeAgents({ sessionId });

    const start = stringField(data, 'cwd', 'project_dir', 'projectDir') || process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const project = store.findProject(store.nearestRepoRoot(start));
    if (!project.ok || !project.slug || !project.meta?.path) return;
    const target = store.integrationTarget(project.slug);
    if (!target) return;
    const worktrees = require(runtimeModule('worktrees')) as {
      sweep: (repo: string, tickets: any[], options: { execute: boolean; currentPath: string; integrationTarget: { upstream: string; branch: string } }) => Promise<unknown>;
    };
    void worktrees.sweep(project.meta.path, store.worktreeGcTickets(), {
      execute: true,
      currentPath: store.nearestRepoRoot(start),
      integrationTarget: target,
    }).catch(() => {});
  } catch (_) {}
}

try {
  main();
} catch (_) {
  process.exit(0);
}
