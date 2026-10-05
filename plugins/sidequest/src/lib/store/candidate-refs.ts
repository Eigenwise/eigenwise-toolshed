'use strict';

// A new board for the same repository numbers its tickets from SQ-1 again (GitHub #378), so an
// archived board's refs/sidequest/SQ-n would collide with the new board's candidates. Archiving
// moves the refs this board's tickets recorded under refs/sidequest-archived/<board>/, and
// restoring moves back every one whose live name is still free.

type Ref = { name: string; commit: string };
type RefMove = { from: string; to: string; commit: string };
type RefGit = {
  listRefs(cwd: string, prefix: string): Ref[];
  moveRefs(cwd: string, moves: RefMove[]): { ok: true } | { ok: false; message: string };
  recordsCommit(recorded: readonly unknown[], commit: string): boolean;
};

const LIVE_PREFIX = 'refs/sidequest/';

function archivedPrefix(slug: string): string {
  return `refs/sidequest-archived/${slug}/`;
}

function listed(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function ticketRecordedCommits(ticket: any): string[] {
  return [
    ticket.submission?.commit,
    ticket.checkpoint?.commit,
    ...listed(ticket.dispatch?.sanctionedCommits),
    ...listed(ticket.rejectedSubmissions).map((rejected: any) => rejected?.commit),
  ].filter(Boolean).map((commit: unknown) => String(commit).trim().toLowerCase());
}

// SQ-7, SQ-7-rejected-2 and SQ-7/r3 all name ticket SQ-7; SQ-70 does not.
function ticketRefOfCandidate(name: string): string {
  return /^[A-Z]+-\d+(?=$|[-/])/.exec(name)?.[0] || '';
}

function applyMoves(git: RefGit, repository: string, moves: RefMove[]) {
  if (!moves.length) return { moved: [] as RefMove[] };
  const result = git.moveRefs(repository, moves);
  return result.ok ? { moved: moves } : { moved: [] as RefMove[], error: result.message };
}

function archiveBoardCandidateRefs(git: RefGit, repository: string, slug: string, tickets: any[]) {
  const recorded = new Map(tickets.map((ticket: any) => [String(ticket.ref), ticketRecordedCommits(ticket)]));
  const moves = git.listRefs(repository, LIVE_PREFIX)
    .map((ref) => ({ ref, name: ref.name.slice(LIVE_PREFIX.length) }))
    .filter(({ ref, name }) => git.recordsCommit(recorded.get(ticketRefOfCandidate(name)) || [], ref.commit))
    .map(({ ref, name }) => ({ from: ref.name, to: archivedPrefix(slug) + name, commit: ref.commit }));
  return applyMoves(git, repository, moves);
}

function restoreBoardCandidateRefs(git: RefGit, repository: string, slug: string) {
  const prefix = archivedPrefix(slug);
  const live = new Set(git.listRefs(repository, LIVE_PREFIX).map((ref) => ref.name));
  const archived = git.listRefs(repository, prefix)
    .map((ref) => ({ from: ref.name, to: LIVE_PREFIX + ref.name.slice(prefix.length), commit: ref.commit }));
  const restored = applyMoves(git, repository, archived.filter((move) => !live.has(move.to)));
  return { ...restored, keptArchived: archived.filter((move) => live.has(move.to)) };
}

module.exports = { archiveBoardCandidateRefs, restoreBoardCandidateRefs, ticketRecordedCommits };
