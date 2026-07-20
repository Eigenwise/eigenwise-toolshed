export const EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max'] as const);
export type Effort = (typeof EFFORTS)[number];

export const CLAUDE_PREFIX = 'sidequest-exec-';
export const DISPATCH_PREFIX = 'sidequest-exec-dispatch-';
export const TICKET_PREFIX = 'sidequest-sq-';
export const LEGACY_TICKET_PREFIX = 'sidequest-ticket-';

export type ExecutorKind = 'codex_dispatch' | 'claude_builtin' | 'ticket' | 'legacy_ticket' | 'unknown';
export interface ExecutorClassification {
  kind: ExecutorKind;
  effort: Effort | null;
}

export function isEffort(value: unknown): value is Effort {
  return typeof value === 'string' && (EFFORTS as readonly string[]).includes(value);
}

export function stableClaudeName(effort: Effort): string {
  return `${CLAUDE_PREFIX}${effort}`;
}

export function stableDispatchName(effort: Effort): string {
  return `${DISPATCH_PREFIX}${effort}`;
}

export function classify(name: unknown): ExecutorClassification {
  if (typeof name !== 'string' || !name) return { kind: 'unknown', effort: null };

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
