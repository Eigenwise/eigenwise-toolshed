export const EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max'] as const);
export type Effort = (typeof EFFORTS)[number];

export const CLAUDE_PREFIX = 'sidequest-exec-';
export const DISPATCH_PREFIX = 'sidequest-exec-dispatch-';
export const READ_ONLY_CLAUDE_PREFIX = 'sidequest-exec-readonly-';
export const READ_ONLY_DISPATCH_PREFIX = 'sidequest-exec-dispatch-readonly-';
export const TICKET_PREFIX = 'sidequest-sq-';
export const LEGACY_TICKET_PREFIX = 'sidequest-ticket-';

export type ExecutorKind = 'codex_dispatch' | 'claude_builtin' | 'read_only_codex_dispatch' | 'read_only_claude_builtin' | 'ticket' | 'legacy_ticket' | 'unknown';
export interface ExecutorClassification {
  kind: ExecutorKind;
  effort: Effort | null;
}

export function isEffort(value: unknown): value is Effort {
  return typeof value === 'string' && (EFFORTS as readonly string[]).includes(value);
}

// Claude Code validates the Agent `name` parameter against
// /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, so 64 is a hard ceiling. The launch names
// below stay far shorter: the native agent list truncates, and a name only earns
// its place there by being readable at a glance.
export const AGENT_NAME_MAX_LENGTH = 64;
const LAUNCH_SLUG_MAX_WORDS = 3;
const LAUNCH_SLUG_MAX_LENGTH = 24;

// Filler words spend the slug budget without distinguishing one ticket from
// another, so they are dropped before the budget is counted.
const LAUNCH_SLUG_FILLER = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'in', 'into', 'is', 'it',
  'its', 'of', 'on', 'or', 'over', 'per', 'that', 'the', 'their', 'then', 'this', 'to', 'under',
  'via', 'when', 'while', 'with', 'without',
]);

function slugTokens(value: unknown): string[] {
  return String(value == null ? '' : value)
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

export function refSlug(ref: unknown): string {
  return slugTokens(ref).join('-');
}

export function titleSlug(title: unknown): string {
  const tokens = slugTokens(title);
  const meaningful = tokens.filter((token) => !LAUNCH_SLUG_FILLER.has(token));
  const chosen = (meaningful.length ? meaningful : tokens).slice(0, LAUNCH_SLUG_MAX_WORDS);
  let slug = '';
  for (const token of chosen) {
    const next = slug ? `${slug}-${token}` : token;
    if (next.length > LAUNCH_SLUG_MAX_LENGTH) break;
    slug = next;
  }
  if (!slug && chosen.length) slug = String(chosen[0]).slice(0, LAUNCH_SLUG_MAX_LENGTH);
  return slug;
}

/**
 * The name a Sidequest launch carries in Claude Code's native agent list.
 * Deterministic from board state alone: ticket ref, ticket title, and the
 * dispatch's launch sequence. Sequence 1 is unsuffixed; a redispatch of the same
 * ticket counts up (`sq-843-release-engine-2`) so a resumed or reworked launch
 * never shadows a live sibling, and no random id is ever appended.
 */
export function dispatchLaunchName(ref: unknown, title?: unknown, sequence?: unknown): string {
  const base = refSlug(ref) || 'sidequest';
  const slug = titleSlug(title);
  const seq = Number(sequence);
  const suffix = Number.isInteger(seq) && seq > 1 ? `-${seq}` : '';
  let name = slug ? `${base}-${slug}` : base;
  const budget = AGENT_NAME_MAX_LENGTH - suffix.length;
  if (name.length > budget) name = name.slice(0, budget).replace(/-+$/, '');
  return `${name}${suffix}`;
}

export function stableClaudeName(effort: Effort): string {
  return `${CLAUDE_PREFIX}${effort}`;
}

export function stableDispatchName(effort: Effort): string {
  return `${DISPATCH_PREFIX}${effort}`;
}

export function stableReadOnlyClaudeName(effort: Effort): string {
  return `${READ_ONLY_CLAUDE_PREFIX}${effort}`;
}

export function stableReadOnlyDispatchName(effort: Effort): string {
  return `${READ_ONLY_DISPATCH_PREFIX}${effort}`;
}

export function classify(name: unknown): ExecutorClassification {
  if (typeof name !== 'string' || !name) return { kind: 'unknown', effort: null };

  if (name.startsWith(READ_ONLY_DISPATCH_PREFIX)) {
    const effort = name.slice(READ_ONLY_DISPATCH_PREFIX.length);
    if (isEffort(effort)) return { kind: 'read_only_codex_dispatch', effort };
    return { kind: 'ticket', effort: null };
  }
  if (name.startsWith(READ_ONLY_CLAUDE_PREFIX)) {
    const effort = name.slice(READ_ONLY_CLAUDE_PREFIX.length);
    if (isEffort(effort)) return { kind: 'read_only_claude_builtin', effort };
    return { kind: 'ticket', effort: null };
  }
  if (name.startsWith(DISPATCH_PREFIX)) {
    const effort = name.slice(DISPATCH_PREFIX.length);
    if (isEffort(effort)) return { kind: 'codex_dispatch', effort };
    return { kind: 'ticket', effort: null };
  }
  if (name.startsWith(CLAUDE_PREFIX)) {
    const effort = name.slice(CLAUDE_PREFIX.length);
    if (isEffort(effort)) return { kind: 'claude_builtin', effort };
    return { kind: 'ticket', effort: null };
  }
  if (name.startsWith(TICKET_PREFIX)) return { kind: 'ticket', effort: null };
  if (name.startsWith(LEGACY_TICKET_PREFIX)) return { kind: 'legacy_ticket', effort: null };
  return { kind: 'unknown', effort: null };
}
