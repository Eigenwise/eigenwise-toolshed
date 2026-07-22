# Publishing: the orchestrator control plane

Executors never publish. A repo-changing executor ends at a verified LOCAL commit in its isolated
worktree, pins it to a durable ref (`refs/sidequest/<SQ-n>`), and parks the ticket
ready-for-integration with `sidequest submit` (claim released, status stays `doing`, no push, no
version bumps). Publishing — integrating those commits, assigning versions, reverifying, reviewing,
pushing main, marking done — is ONE serialized transaction owned by the orchestrator. This file is that
transaction.

## When to run it (event-driven, never polled)

The wakeups you already get are the triggers; never hold a turn open waiting for submissions:

- An executor stop notification whose verdict reads `READY_FOR_INTEGRATION` (the SubagentStop hook
  emits it when a stopped executor's ticket carries a pending submission).
- `sidequest publish queue --json` showing pending submissions at any natural wakeup (`pulse` and
  `list --brief` also surface a ticket's `submission`).

Batch deliberately: when a wave is mid-flight, let its remaining executors finish and publish the
wave's submissions in one transaction — one lock hold, one version assignment, one seam check, one
push — instead of one transaction per ticket. Don't wait on work that isn't in flight.

## Local-only repositories

`board-config --integration-mode local` records ranges against local `main`; `auto` chooses that mode when
`origin` is absent. Integrate in a clean worktree from `main`, run the same reachability checks against
`main`, then skip fetch and push. Use `groom-close --integration` after the integrated commits are reachable
from local `main`. Remote mode keeps the transaction below unchanged; an existing but broken upstream still
rejects the submission.

## The publish transaction

Run every step in order; any failure before the push aborts the transaction without touching the
board (submissions stay parked — fail closed).

1. **Acquire the publish lock**: `sidequest publish lock --by <session-worker-id>`. The lock lives
   in the repo's common git dir, so every session, process, and worktree serializes on it. If held,
   do NOT wait or poll: note the holder from the failure output and retry at the next natural
   wakeup. `--steal` only when `publish status` shows the holder stale (TTL expired or dead pid).
   Re-acquiring from the same session refreshes the lock — that is the crash-recovery path for your
   own interrupted transaction.
2. **Read the queue**: `sidequest publish queue --json` — each entry carries the durable ref,
   submission base, expected upstream, ordered commit range, full changed-path union, declared files,
   and the verify command the executor ran. A legacy entry without range metadata stays parked until
   its executor resubmits it; never guess a range from a tip hash.
3. **Read each submitted handoff**: before integrating or closing a ticket, run
   `sidequest comments <ref> --json` for it. The queue is intentionally compact and does not replace the
   full thread. Act on unresolved risks or questions: resolve them, skip and file a scoped integration
   ticket, or leave the submission parked. Do not cherry-pick until the thread is understood.
4. **Create a clean integration worktree** from the current remote main, never from any working
   tree: `git fetch origin` then `git worktree add <scratch>/sq-integrate origin/main --detach`.
   Install the touched plugin's dependencies before reverifying, for this repo:
   `cd <worktree>/plugins/<name> && npm ci`. Never integrate in the shared session tree — pre-staged
   or dirty files there are exactly the contamination this flow exists to prevent.
5. **Reconstruct and admit each submission before integration**. Resolve its durable ref and require
   it still points to the submitted tip. Require `git merge-base --is-ancestor <base> origin/main`, then
   compare `git rev-list --reverse <base>..<tip>` to the queue's ordered `commits` array exactly. Reject
   an empty range, merge commit, divergent or unrelated history, a range containing a commit from another
   queued ticket, or a changed-path union outside the ticket scope. Leave rejected submissions parked.
6. **Integrate each admitted range**, oldest first: `git cherry-pick <commit-1> ... <commit-n>`. The
   durable tip ref keeps every ancestor in that range reachable. Save `git diff --binary <base> <tip>`
   before cherry-picking, then run `git apply --check --reverse <saved-patch>` in the integration worktree
   after the range lands. That confirms the integrated tree contains the complete submitted diff. A
   conflict or reverse-check failure means abort or rebuild the integration worktree, skip the ticket,
   and file a narrowly scoped integration ticket; keep integrating the rest.
7. **Assign versions centrally**: for each plugin touched by the integrated set, take origin's next
   free version ONCE for the batch and bump BOTH `plugins/<name>/.claude-plugin/plugin.json` and the
   root `.claude-plugin/marketplace.json` (they must match) in one commit. Executors no longer bump
   anything, so versioning has exactly one writer: this step.
8. **Reverify per ticket, post-integration**: run each integrated ticket's exact verify command
   (from the queue entry / ticket `--verify`) from the integration worktree root. Submission commands
   must use repo-relative paths, so this is the same command the executor ran. A red here means the
   commit does not survive integration: drop that ticket's range (rebuild the worktree or
   `git revert` its commits), file the integration ticket, continue with the green rest.
9. **Seam check the batch**: with 2+ integrated commits, run the shared suite the tickets sit in
   (for this repo: `node --test plugins/sidequest/test/*.test.js`, or the suites of the touched
   plugins) so per-ticket-green but jointly-red seams are caught before the push.
10. **Review the integrated diff — the gate before the push**. Green verification is necessary but is
   NOT a review. For each integrated ticket, review the change for correctness, scope-safety, and
   security. Read the diff yourself (`git diff <base>..HEAD -- <scope>`) for a small or mechanical
   change; for a substantial, cross-cutting, or security-sensitive one, dispatch a `review-audit`
   executor (or `security-audit`) on the integrated range and read its findings before continuing.
   Resolve or explicitly accept every finding before pushing. A finding that needs rework is an
   integration failure: drop that ticket's range, leave its submission parked, and file a scoped ticket
   (see "Integration failures fail closed") — never push code you have only tested and not read.
11. **Push and confirm**: `git push origin HEAD:main` from the integration worktree — never a new
   branch. A non-fast-forward → `git pull --rebase origin main`, rerun steps 8-10, push again. Then
   fetch fresh and confirm the integrated commits (the cherry-picked equivalents, not the submitted
   range hashes) are covered by `git log origin/main`; step 6's reverse-diff check already proved
   content completeness.
12. **Mark done + clean up**, only after every integrated commit is reachable: for each shipped ticket
   `sidequest groom-close <ref> --by <session-worker-id> --integration --reason "Integrated <commit> into origin/main."`
   (the control-plane integration closure consumes the submission, records the pushed commit as
   evidence, and removes the ticket from the integration queue). Then delete its durable ref (`git
   update-ref -d refs/sidequest/<SQ-n>`), remove the integration worktree (`git worktree remove
   <scratch>/sq-integrate`), and `sidequest publish unlock --by <session-worker-id>`. Unlock happens
   LAST, in a step that runs even when earlier cleanup partially fails.

## Integration failures fail closed

A submission that conflicts, fails post-integration reverify, or breaks the seam check is never
force-merged and never silently dropped:

- Leave its submission parked (do NOT `done`, do NOT clear it reflexively).
- File a narrowly scoped integration ticket: the conflicting ref, the exact failure output, the
  submitted commit + durable ref, and what the integrator may touch. Link it `blocks` the original.
- Only when the fix requires REDOING the original work (not merging it) clear the submission so the
  ticket is claimable again: `sidequest submit <ref> --clear -s todo`.

## Crash recovery

The lock records owner pid + session metadata + timestamp. A publisher that dies mid-transaction
leaves: a held lock (reclaimable — same session refreshes on re-acquire; anyone else waits for the
TTL or `--steal`s a provably stale holder), an orphan integration worktree (`git worktree list` →
`git worktree remove --force`), and parked submissions (still queued; the durable refs still pin
the commits). Nothing is lost: rerun the transaction from step 1. Tickets are only marked done
after their commits are reachable from `origin/main`, so a crash can never strand a done-but-
unpushed ticket.
