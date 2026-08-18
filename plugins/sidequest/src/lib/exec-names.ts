export const EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max'] as const);
export type Effort = (typeof EFFORTS)[number];

export const CLAUDE_PREFIX = 'sidequest-exec-';
export const DISPATCH_PREFIX = 'sidequest-exec-dispatch-';
export const READ_ONLY_CLAUDE_PREFIX = 'sidequest-exec-readonly-';
export const READ_ONLY_DISPATCH_PREFIX = 'sidequest-exec-dispatch-readonly-';
export const TICKET_PREFIX = 'sidequest-sq-';
export const LEGACY_TICKET_PREFIX = 'sidequest-ticket-';
export const DIAGNOSTIC_PROBE_NAME = 'sidequest-diagnostic-probe';

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
const ROUTE_MODEL_TOKEN_MAX_LENGTH = 24;

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

function routeModelToken(resolvedExec: unknown): string {
  if (!resolvedExec || typeof resolvedExec !== 'object') return '';
  const exec = resolvedExec as Record<string, unknown>;
  const isClaude = exec.backend === 'claude';
  const value = isClaude
    ? String(exec.runsModel || exec.dispatchModel || '')
    : String(exec.runsLabel || exec.dispatchModel || exec.runsModel || '');
  const tokens = slugTokens(value).filter((token) => !isClaude || token !== 'claude');
  const token = isClaude ? tokens.join('-') : tokens.at(-1) || '';
  return token.slice(0, ROUTE_MODEL_TOKEN_MAX_LENGTH);
}

/**
 * The name a Sidequest launch carries in Claude Code's native agent list.
 * Deterministic from board state alone: ticket ref, title, resolved execution
 * route, and dispatch sequence. Sequence 1 is unsuffixed; a redispatch counts up
 * (`sq-843-release-engine-terra-high-2`) so it never shadows a live sibling.
 */
export function dispatchLaunchName(ref: unknown, title?: unknown, resolvedExec?: unknown, effort?: unknown, sequence?: unknown): string {
  const base = refSlug(ref) || 'sidequest';
  const model = routeModelToken(resolvedExec);
  const routeEffort = isEffort(effort) ? effort : '';
  const route = [model, routeEffort].filter(Boolean);
  const seq = Number(sequence);
  const suffix = Number.isInteger(seq) && seq > 1 ? `-${seq}` : '';
  const fixedName = [base, ...route].join('-') + suffix;
  const availableTitleLength = AGENT_NAME_MAX_LENGTH - fixedName.length - 1;
  const slug = titleSlug(title).slice(0, Math.max(availableTitleLength, 0)).replace(/-+$/, '');
  return slug ? [base, slug, ...route].join('-') + suffix : fixedName;
}

// Codex dispatch executors are effort-collapsed: the gateway resolves BOTH model and
// effort from the [sidequest-route model=... effort=...] marker in the briefing and
// overwrites the request's output_config.effort, so a per-effort definition ladder on
// this side carried five copies of dead frontmatter (verified on the wire 2026-08-02:
// a def pinned to effort low produced effort=xhigh when the marker said so). Claude
// executors keep the per-effort ladder because the Agent tool has no effort parameter,
// leaving frontmatter as the only carrier.
export const DISPATCH_NAME = 'sidequest-exec-dispatch';
export const READ_ONLY_DISPATCH_NAME = 'sidequest-exec-dispatch-readonly';

export function stableClaudeName(effort: Effort): string {
  return `${CLAUDE_PREFIX}${effort}`;
}

export function stableDispatchName(_effort?: Effort): string {
  return DISPATCH_NAME;
}

export function stableReadOnlyClaudeName(effort: Effort): string {
  return `${READ_ONLY_CLAUDE_PREFIX}${effort}`;
}

export function stableReadOnlyDispatchName(_effort?: Effort): string {
  return READ_ONLY_DISPATCH_NAME;
}

export function classify(name: unknown): ExecutorClassification {
  if (typeof name !== 'string' || !name) return { kind: 'unknown', effort: null };

  // The collapsed names carry no effort; the dispatch marker does. Checked before the
  // prefix rules because READ_ONLY_DISPATCH_NAME is a proper prefix-collision with
  // DISPATCH_PREFIX ('...dispatch-readonly' starts with '...dispatch-').
  if (name === READ_ONLY_DISPATCH_NAME) return { kind: 'read_only_codex_dispatch', effort: null };
  if (name === DISPATCH_NAME) return { kind: 'codex_dispatch', effort: null };
  if (name === DIAGNOSTIC_PROBE_NAME) return { kind: 'unknown', effort: null };

  // Pre-collapse records still name per-effort executors; classifying them keeps old
  // dispatch records readable so the board can heal by redispatch instead of erroring.
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
