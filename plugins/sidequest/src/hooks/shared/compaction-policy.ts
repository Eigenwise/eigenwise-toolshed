import { runtimeModule } from './paths.js';

const MAX_INSTRUCTION_BYTES = 1500;

interface Store {
  nearestRepoRoot: (start: string) => string;
  findProject: (start: string) => { ok: boolean; slug?: string; meta?: { path?: string } };
  listTickets: (slug: string) => any[];
}

function policy(): 'off' | 'pin' {
  return String(process.env.SIDEQUEST_COMPACTION_POLICY || '').trim().toLowerCase() === 'off' ? 'off' : 'pin';
}

function compactText(value: unknown, limit: number): string {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function ticketLine(ticket: any): string {
  return `- ${compactText(ticket?.ref, 40)} — ${compactText(ticket?.title, 220)}`;
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

function boardState(cwd: string): string {
  const store = require(runtimeModule('store')) as Store;
  const found = store.findProject(store.nearestRepoRoot(cwd));
  if (!found.ok || !found.slug) return '';
  const doing = store.listTickets(found.slug).filter((ticket) => ticket?.status === 'doing');
  return doing.length ? boundedInstruction(doing.map(ticketLine)) : '';
}

// This hook pins board state and nothing else. A "keep working, this is not a stopping
// point" instruction lived here briefly in 4.1.0 and was reverted: summaries canonizing
// "I stopped because context was low" is a Claude Code behavior, and countering it with
// prompt text was unmeasured and could as easily make context more salient than less.
// See SQ-1276 for the transcript evidence if that is ever worth revisiting.
export function compactionPolicyOutput(input: Record<string, unknown>): string {
  if (input.hook_event_name !== 'PreCompact' || input.trigger !== 'auto') return '';
  if (policy() === 'off') return '';
  try {
    return boardState(String(input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd()));
  } catch (error) {
    console.error(`sidequest: compaction policy could not read board state: ${String(error)}`);
    return '';
  }
}
