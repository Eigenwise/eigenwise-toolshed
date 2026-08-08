import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runtimeModule } from './paths.js';

const MAX_INSTRUCTION_BYTES = 1500;

interface Story {
  ref?: string;
  title?: string;
  contractRevision?: number;
  logRevision?: number;
}

interface Store {
  nearestRepoRoot: (start: string) => string;
  findProject: (start: string) => { ok: boolean; slug?: string; meta?: { path?: string } };
  listTickets: (slug: string) => any[];
  getStory: (slug: string, id: string) => Story | null;
  worktreeGcTickets: () => Array<{ project?: string; ref?: string; claimLive?: boolean }>;
  sessionClaims: (sessionId: string) => Array<{ held?: boolean }>;
}

interface CounterState {
  blocks: number;
  instruction?: string;
}

function policy(): 'off' | 'pin' | 'veto' {
  const value = String(process.env.SIDEQUEST_COMPACTION_POLICY || '').trim().toLowerCase();
  if (value === 'off') return 'off';
  return value === 'veto' ? 'veto' : 'pin';
}

function stateFile(sessionId: string): string {
  const home = String(process.env.SIDEQUEST_HOME || '').trim() || path.join(os.homedir(), '.claude', 'sidequest');
  return path.join(home, 'compaction-policy', `${encodeURIComponent(sessionId)}.json`);
}

function readCounter(sessionId: string): CounterState {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile(sessionId), 'utf8')) as CounterState;
    return {
      blocks: Number.isInteger(parsed.blocks) && parsed.blocks > 0 ? parsed.blocks : 0,
      instruction: typeof parsed.instruction === 'string' ? parsed.instruction : '',
    };
  } catch (_) {
    return { blocks: 0 };
  }
}

function writeCounter(sessionId: string, blocks: number, instruction = ''): void {
  if (!sessionId) return;
  try {
    const file = stateFile(sessionId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ blocks, instruction }));
  } catch (error) {
    console.error(`sidequest: could not persist compaction veto counter: ${String(error)}`);
  }
}

function compactText(value: unknown, limit: number): string {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (Buffer.byteLength(text, 'utf8') <= limit) return text;
  const marker = '…';
  let result = '';
  let bytes = 0;
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes + Buffer.byteLength(marker, 'utf8') > limit) break;
    result += character;
    bytes += characterBytes;
  }
  return `${result}${marker}`;
}

function ticketLine(ticket: any): string {
  const claim = ticket?.claim || {};
  const dispatch = ticket?.dispatch || {};
  const details = claim.by ? [
    `claim ${compactText(claim.by, 100)}`,
    dispatch.executor || ticket?.dispatchExecutor ? `executor ${compactText(dispatch.executor || ticket.dispatchExecutor, 100)}` : '',
    dispatch.token || ticket?.dispatchToken ? `dispatch token ${compactText(dispatch.token || ticket.dispatchToken, 160)}` : '',
  ].filter(Boolean).join('; ') : '';
  return `- ${compactText(ticket?.ref, 40)} — ${compactText(ticket?.title, 220)}${details ? ` (${details})` : ''}`;
}

function boundedInstruction(lines: string[]): string {
  const kept = ['Preserve verbatim in the summary:'];
  for (const line of lines) {
    const candidate = [...kept, line].join('\n');
    if (Buffer.byteLength(candidate, 'utf8') > MAX_INSTRUCTION_BYTES) {
      const omitted = `… ${lines.length - (kept.length - 1)} more board entries omitted.`;
      if (Buffer.byteLength([...kept, omitted].join('\n'), 'utf8') <= MAX_INSTRUCTION_BYTES) kept.push(omitted);
      break;
    }
    kept.push(line);
  }
  return kept.length > 1 ? kept.join('\n') : '';
}

function shouldAvoidVetoForSession(store: Store, sessionId: string): boolean {
  try {
    return store.sessionClaims(sessionId).some((claim) => claim.held);
  } catch {
    return true;
  }
}

function liveTicketLine(ticket: any, story: Story | undefined): string {
  const ref = compactText(ticket?.ref, 40);
  const claim = compactText(ticket?.claim?.by, 80);
  const storyRef = compactText(story?.ref, 40);
  const revisions = story
    ? `contractRevision=${Number(story.contractRevision) || 0} logRevision=${Number(story.logRevision) || 0}`
    : `watermark=${compactText(ticket?.updatedAt, 32) || 'unavailable'}`;
  const retrieval = [`mcp__plugin_sidequest_board__comments({ref:"${ref}"})`];
  if (storyRef) {
    retrieval.push(
      `mcp__plugin_sidequest_board__story_contract({story:"${storyRef}"})`,
      `mcp__plugin_sidequest_board__story_log({story:"${storyRef}"})`,
    );
  }
  return `Keep live ticket ${ref}${claim ? ` claim=${claim}` : ''}${storyRef ? ` story=${storyRef}` : ''} ${revisions}. ${compactText(ticket?.title, 80)}${story ? ` Story: ${compactText(story.title, 60)}.` : ''} Retrieve: ${retrieval.join(' and ')}.`;
}

async function boardState(cwd: string, store: Store): Promise<{ instruction: string; unsafeReason: string } | null> {
  const found = store.findProject(store.nearestRepoRoot(cwd));
  if (!found.ok || !found.slug || !found.meta?.path) return null;

  const tickets = store.listTickets(found.slug);
  const liveRefs = new Set(store.worktreeGcTickets()
    .filter((ticket) => ticket.project === found.slug && ticket.claimLive && ticket.ref)
    .map((ticket) => String(ticket.ref)));
  const doing = tickets.filter((ticket) => ticket?.status === 'doing');
  const fresh = doing.filter((ticket) => liveRefs.has(String(ticket.ref)));
  const stale = doing.filter((ticket) => !liveRefs.has(String(ticket.ref)));
  const publish = require(runtimeModule('publish')) as { publishLockStatus: (repoPath: string) => Promise<{ locked?: boolean; holder?: any }> };
  const lock = await publish.publishLockStatus(found.meta.path);
  const storyIds = [...new Set(doing.map((ticket) => String(ticket?.storyId || '')).filter(Boolean))];
  const stories = storyIds.map((id) => store.getStory(found.slug!, id)).filter((story): story is Story => Boolean(story));
  const storiesByRef = new Map(stories.map((story) => [story.ref, story]));
  const lines = [
    'sidequest compaction recovery v1: board history omitted under the 1500B recovery budget.',
    ...fresh.map((ticket) => liveTicketLine(ticket, storiesByRef.get(String(ticket?.storyId || '')))),
    ...stale.map(ticketLine),
    ...stories.filter((story) => !fresh.some((ticket) => String(ticket?.storyId || '') === story.ref)).map((story) => `Compaction policy story ${compactText(story.title, 80)}: id=${compactText(story.ref, 40)} contractRevision=${Number(story.contractRevision) || 0} logRevision=${Number(story.logRevision) || 0}. Retrieve: mcp__plugin_sidequest_board__story_contract({story:"${compactText(story.ref, 40)}"}) and mcp__plugin_sidequest_board__story_log({story:"${compactText(story.ref, 40)}"}).`),
    ...(lock.locked ? [`Publish lock: ${compactText(lock.holder?.by || lock.holder?.sessionId || JSON.stringify(lock.holder || 'held'), 260)}`] : []),
  ];
  if (lines.length === 1) return null;
  const freshRefs = compactText(fresh.map((ticket) => String(ticket.ref)).join(', '), 300);
  const unsafe = [
    fresh.length ? `fresh claims: ${freshRefs}` : '',
    lock.locked ? `publish lock: ${compactText(lock.holder?.by || lock.holder?.sessionId || 'held', 180)}` : '',
  ].filter(Boolean).join('; ');
  return { instruction: boundedInstruction(lines), unsafeReason: unsafe };
}

export async function compactionPolicyOutput(input: Record<string, unknown>): Promise<string> {
  if (input.hook_event_name !== 'PreCompact' || input.trigger !== 'auto') return '';
  const mode = policy();
  if (mode === 'off') return '';
  const sessionId = String(input.session_id || input.sessionId || process.env.CLAUDE_CODE_SESSION_ID || '').trim();
  try {
    const store = require(runtimeModule('store')) as Store;
    const state = await boardState(String(input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd()), store);
    if (!state) {
      writeCounter(sessionId, 0);
      return '';
    }
    const counter = readCounter(sessionId);
    if (mode !== 'veto' || !state.unsafeReason || shouldAvoidVetoForSession(store, sessionId)) {
      if (counter.instruction === state.instruction) return '';
      writeCounter(sessionId, 0, state.instruction);
      return state.instruction;
    }
    if (counter.blocks >= 2) {
      if (counter.instruction === state.instruction) return '';
      writeCounter(sessionId, 0, state.instruction);
      return state.instruction;
    }
    writeCounter(sessionId, counter.blocks + 1, '');
    return JSON.stringify({ decision: 'block', reason: `sidequest compaction delayed: ${state.unsafeReason}` });
  } catch (error) {
    console.error(`sidequest: compaction policy could not read board state: ${String(error)}`);
    return '';
  }
}
