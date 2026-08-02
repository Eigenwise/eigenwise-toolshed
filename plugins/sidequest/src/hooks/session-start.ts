#!/usr/bin/env node
import { readStdin, stringField, type HookInput } from './shared/input.js';
import { writeContext } from './shared/output.js';
import { pluginRoot, runtimeModule } from './shared/paths.js';
import { initializeCompactionState, isPrimarySession } from './shared/compaction.js';

interface Store {
  nearestRepoRoot: (start: string) => string;
  findProject: (start: string) => { ok: boolean; slug?: string };
  countOpenTickets: (slug: string) => number;
}

function openTicketCount(): number {
  try {
    const store = require(runtimeModule('store')) as Store;
    const found = store.findProject(store.nearestRepoRoot(process.env.CLAUDE_PROJECT_DIR || process.cwd()));
    return found.ok && found.slug ? store.countOpenTickets(found.slug) : 0;
  } catch (_) {
    return 0;
  }
}

function nudgeOff(): boolean {
  const value = String(process.env.SIDEQUEST_NUDGE || '').trim().toLowerCase();
  return value === 'off' || value === '0' || value === 'false' || value === 'no';
}

function main(): void {
  const data: HookInput | null = readStdin();
  if (!data) return;
  if (isPrimarySession(data)) {
    const sessionId = stringField(data, 'session_id', 'sessionId') || process.env.CLAUDE_CODE_SESSION_ID || '';
    initializeCompactionState(sessionId, data.transcript_path || data.transcriptPath);
  }
  if (nudgeOff()) return;

  const open = openTicketCount();
  writeContext('SessionStart', [
    '=== sidequest ===',
    `A tracker for this project: ${open === 1 ? '1 open ticket' : `${open} open tickets`}. \`${pluginRoot()}/bin/sidequest.js list\`, or the MCP tools.`,
    'Capture side issues the user mentions in passing as tickets, so they outlive this session. That is what the board is for.',
    'Do not pick work off the board on your own. Work a ticket when the user asks for that ticket.',
  ].join('\n'));
}

main();
