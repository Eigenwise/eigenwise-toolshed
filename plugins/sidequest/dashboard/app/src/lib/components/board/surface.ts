import type { Status, Ticket } from '../../types';

export function plainText(value: string) {
  return value
    .replace(/```[\s\S]*?```/g, ' code ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_>#~|-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function relativeTime(value: unknown) {
  const timestamp = Date.parse(String(value ?? ''));
  if (!Number.isFinite(timestamp)) return '';
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1_000));
  if (seconds < 60) return 'just now';
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

export function projectFor(ticket: Ticket) {
  return String(ticket.projectSlug ?? ticket.project ?? '');
}

export function movePayload(ticket: Ticket, status: Status, now = Date.now()) {
  return ticket.status === status ? null : { status, order: now };
}

export function isStaleClaim(claim: unknown) {
  const at = Date.parse(String((claim as { at?: unknown } | undefined)?.at ?? ''));
  return !Number.isFinite(at) || Date.now() - at > 60 * 60 * 1_000;
}
