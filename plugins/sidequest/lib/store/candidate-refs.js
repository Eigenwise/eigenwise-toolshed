"use strict";
const LIVE_PREFIX = "refs/sidequest/";
function archivedPrefix(slug) {
  return `refs/sidequest-archived/${slug}/`;
}
function listed(value) {
  return Array.isArray(value) ? value : [];
}
function ticketRecordedCommits(ticket) {
  return [
    ticket.submission?.commit,
    ticket.checkpoint?.commit,
    ...listed(ticket.dispatch?.sanctionedCommits),
    ...listed(ticket.rejectedSubmissions).map((rejected) => rejected?.commit)
  ].filter(Boolean).map((commit) => String(commit).trim().toLowerCase());
}
function ticketRefOfCandidate(name) {
  return /^[A-Z]+-\d+(?=$|[-/])/.exec(name)?.[0] || "";
}
function applyMoves(git, repository, moves) {
  if (!moves.length) return { moved: [] };
  const result = git.moveRefs(repository, moves);
  return result.ok ? { moved: moves } : { moved: [], error: result.message };
}
function archiveBoardCandidateRefs(git, repository, slug, tickets) {
  const recorded = new Map(tickets.map((ticket) => [String(ticket.ref), ticketRecordedCommits(ticket)]));
  const moves = git.listRefs(repository, LIVE_PREFIX).map((ref) => ({ ref, name: ref.name.slice(LIVE_PREFIX.length) })).filter(({ ref, name }) => git.recordsCommit(recorded.get(ticketRefOfCandidate(name)) || [], ref.commit)).map(({ ref, name }) => ({ from: ref.name, to: archivedPrefix(slug) + name, commit: ref.commit }));
  return applyMoves(git, repository, moves);
}
function restoreBoardCandidateRefs(git, repository, slug) {
  const prefix = archivedPrefix(slug);
  const live = new Set(git.listRefs(repository, LIVE_PREFIX).map((ref) => ref.name));
  const archived = git.listRefs(repository, prefix).map((ref) => ({ from: ref.name, to: LIVE_PREFIX + ref.name.slice(prefix.length), commit: ref.commit }));
  const restored = applyMoves(git, repository, archived.filter((move) => !live.has(move.to)));
  return { ...restored, keptArchived: archived.filter((move) => live.has(move.to)) };
}
module.exports = { archiveBoardCandidateRefs, restoreBoardCandidateRefs, ticketRecordedCommits };
