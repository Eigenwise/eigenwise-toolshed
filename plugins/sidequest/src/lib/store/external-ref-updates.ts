import { execFileSync } from '../git-process';
import type { ExternalReference } from '../external-refs';

type ExternalRefEvent = {
  mode: 'off' | 'comment' | 'close';
  cwd: string;
  onFailure: (body: string) => void;
} & ({ kind: 'delivered'; branch: string; sha: string } | { kind: 'released'; tag: string });

type ExternalRefTicket = { ref: string; externalRefs?: ExternalReference[] };

function updateGithubReference(ticket: ExternalRefTicket, event: ExternalRefEvent, url: string): void {
  const body = event.kind === 'delivered'
    ? `Fixed on ${event.branch} in ${event.sha} (${ticket.ref})`
    : `Shipped in ${event.tag}`;
  const options = { cwd: event.cwd, encoding: 'utf8' as const, stdio: 'pipe' as const, timeout: 10000 };
  try {
    execFileSync('gh', ['issue', 'comment', url, '--body', body], options);
    if (event.kind === 'released' && event.mode === 'close') execFileSync('gh', ['issue', 'close', url], options);
  } catch (error: unknown) {
    event.onFailure(`GitHub sync failed for ${url}: ${String(error)}`);
  }
}

function githubUrls(references: ExternalReference[] = []): string[] {
  return [...new Set(references.map((reference) => reference.url ?? ''))]
    .filter((url) => /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\/\d+\/?$/i.test(url));
}

export function emitExternalRefUpdates(ticket: ExternalRefTicket, event: ExternalRefEvent): void {
  if (event.mode === 'off') return;
  for (const url of githubUrls(ticket.externalRefs)) updateGithubReference(ticket, event, url);
}
