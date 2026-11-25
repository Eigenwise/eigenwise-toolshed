import type { Ticket } from './tickets'

const buildsOnEarlierWork = (ticket: Ticket): boolean => ticket.blockedBy.length > 0 || ticket.story !== undefined

// branchToMerge is the branch the board was on when the ticket was started. It is undefined when that checkout is on
// no branch or the repository has no remote: there the host cuts the worktree from what is checked out, so a merge
// does nothing and "cut from the remote's default branch" would be untrue.
export const buildOnEarlierWorkSection = (ticket: Ticket, isIsolated: boolean, branchToMerge: string | undefined): string[] => {
  if (!isIsolated || branchToMerge === undefined || !buildsOnEarlierWork(ticket)) return []

  return [
    [
      '## Start from the work this builds on',
      "Your worktree is cut from the remote's default branch, so it may lack work that landed only here. " +
        `Before anything else run \`git merge ${branchToMerge}\`, where \`${branchToMerge}\` is the branch the board was on when this ticket was started. ` +
        'If it does not merge cleanly, stop and say so in your result.',
    ].join('\n'),
  ]
}
