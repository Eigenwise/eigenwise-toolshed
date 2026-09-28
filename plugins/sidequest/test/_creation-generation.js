'use strict';

// The attempt generation a WorktreeCreate carries from its own start binding onward. Fixtures used to
// re-call `bindDispatchWorktreeCreation` just to read it back, which is the shape SQ-2959 showed a stale hook
// using to acquire a live replacement's generation mid-creation, so that second generation-less binding is
// refused now (SQ-2961). Read it the way the hook holds it instead: the binding hands it out once.
//
// `store` is required lazily because every suite points SIDEQUEST_HOME at its own fixture before loading it.
function creationGeneration(project, sessionId, worktree) {
  const worktreeLease = require('../lib/kernel/worktree.js');
  const store = require('../lib/store.js');
  const bound = worktreeLease.canonicalPath(worktree);
  const owner = store.listTickets(project).find((ticket) => ticket.dispatch
    && ticket.dispatch.sessionId === sessionId
    && ticket.dispatch.worktree
    && worktreeLease.canonicalPath(ticket.dispatch.worktree) === bound);
  return String((owner && owner.dispatch && owner.dispatch.preparedAt) || '');
}

module.exports = { creationGeneration };
