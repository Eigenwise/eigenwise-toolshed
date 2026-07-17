# Publishing: the orchestrator control plane

Executors never publish. A repo-changing executor ends at a verified LOCAL commit in its isolated
worktree, pins it to a durable ref (`refs/sidequest/<SQ-n>`), and parks the ticket
ready-for-integration with `sidequest submit` (claim released, status stays `doing`, no push, no
version bumps). Publishing — integrating those commits, assigning versions, reverifying, pushing
main, marking done — is ONE serialized transaction owned by the orchestrator. This file is that
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

## The publish transaction

Run every step in order; any failure before the push aborts the transaction without touching the
board (submissions stay parked — fail closed).

1. **Acquire the publish lock**: `sidequest publish lock --by <session-worker-id>`. The lock lives
   in the repo's common git dir, so every session, process, and worktree serializes on it. If held,
   do NOT wait or poll: note the holder from the failure output and retry at the next natural
   wakeup. `--steal` only when `publish status` shows the holder stale (TTL expired or dead pid).
   Re-acquiring from the same session refreshes the lock — that is the crash-recovery path for your
   own interrupted transaction.
2. **Read the queue**: `sidequest publish queue --json` — each entry carries the ref, submitted
   commit, durable git ref, declared files, and the verify command the executor ran.
3. **Create a clean integration worktree** from the current remote main, never from any working
   tree: `git fetch origin` then `git worktree add <scratch>/sq-integrate origin/main --detach`.
   Never integrate in the shared session tree — pre-staged or dirty files there are exactly the
   contamination this flow exists to prevent.
4. **Integrate each submission**, oldest first: `git cherry-pick <commit>` (the durable ref keeps
   the commit reachable even after the executor worktree is cleaned). A conflict → abort the
   cherry-pick, skip the ticket, and file a narrowly scoped integration ticket (below); keep
   integrating the rest.
5. **Assign versions centrally**: for each plugin touched by the integrated set, take origin's next
   free version ONCE for the batch and bump BOTH `plugins/<name>/.claude-plugin/plugin.json` and the
   root `.claude-plugin/marketplace.json` (they must match) in one commit. Executors no longer bump
   anything, so versioning has exactly one writer: this step.
6. **Reverify per ticket, post-integration**: run each integrated ticket's exact verify command
   (from the queue entry / ticket `--verify`) inside the integration worktree. A red here means the
   commit does not survive integration: drop that ticket's commit (rebuild the worktree or
   `git revert` it), file the integration ticket, continue with the green rest.
7. **Seam check the batch**: with 2+ integrated commits, run the shared suite the tickets sit in
   (for this repo: `node --test plugins/sidequest/test/*.test.js`, or the suites of the touched
   plugins) so per-ticket-green but jointly-red seams are caught before the push.
8. **Push and confirm**: `git push origin HEAD:main` from the integration worktree — never a new
   branch. A non-fast-forward → `git pull --rebase origin main`, rerun steps 6-7, push again. Then
   confirm every integrated commit is reachable:
   `git merge-base --is-ancestor <integrated-tip> origin/main` (after a fresh fetch).
9. **Mark done + clean up**, only after reachability holds: for each shipped ticket
   `sidequest done <ref> --by <session-worker-id> --model <its stamped model> --effort <its effort>`
   with a closing comment naming the pushed commit (done consumes the submission — the ticket
   leaves the integration queue). Then delete its durable ref (`git update-ref -d
   refs/sidequest/<SQ-n>`), remove the integration worktree (`git worktree remove <scratch>/sq-integrate`),
   and `sidequest publish unlock --by <session-worker-id>`. Unlock happens LAST, in a step that runs
   even when earlier cleanup partially fails.

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
