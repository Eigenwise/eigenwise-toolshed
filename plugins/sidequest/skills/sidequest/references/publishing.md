# Publishing: the orchestrator control plane

Executors never publish. A repo-changing executor ends at a verified LOCAL commit in its isolated
worktree, pins it to a durable ref (`refs/sidequest/<SQ-n>`), and parks the ticket
ready-for-integration with `sidequest submit` (claim released, status stays `doing` and out of
`ready`, no push, no version bumps). Publishing — integrating those commits, assigning versions, reverifying, reviewing,
pushing main, marking done — is ONE serialized transaction owned by the orchestrator. This file is that
transaction.

`submit` derives the admitted range from the base recorded on the ticket's dispatch. Pass `--base <commit>`
(or MCP `base`) only when automatic selection cannot identify the boundary. An explicit base must always lie on the
submitted tip's history, and it must additionally either sit at or after the current merge base or already be
reachable from the integration branch. A base that is not reachable from the integration branch must match the
dispatch-recorded boundary; otherwise admission refuses it as `unrecognized_base` and preserves the candidate
for retry. The range still has to satisfy the current ticket's declared scope and ownership checks. For an
executor based on a feature branch, pass that branch as MCP dispatch `integrationBranch`. The dispatch
records that target and its starting commit. A submitted range may contain merge commits; validate its
reachable range and scope instead of treating a merge commit as an automatic refusal.

A retryable admission refusal preserves the claim plus the immutable candidate, changed surfaces, Git ref, optional worktree, verifier evidence, diagnostics, and foreign working paths. A retry may send only corrected verifier evidence; the checkpoint supplies omitted candidate fields and the original verifier. For non-Git candidates, the server integration registers `store.registerSourceRevisionCapability(project, resolver)`. Sidequest restores a checkpointed candidate before calling the current project resolver exactly once with that candidate and dispatch-pinned baseline. The result, including null or an exception, stays bound to both and is never re-probed by the store. A replacement registration invalidates the earlier resolver; either unregister callback only removes its own current generation and never restores a stale resolver. CLI and MCP callers cannot supply existence or baseline-membership facts or replace a checkpointed candidate. A missing or unavailable capability returns `baseline_membership_unavailable` and keeps the checkpoint for retry. Update `refs/sidequest/<SQ-n>` only when an explicit rework transition creates a different candidate. Do not sync onto a moving integration tip to work around an admission refusal.

## When to run it (event-driven, never polled)

The wakeups you already get are the triggers; never hold a turn open waiting for submissions:

- An executor stop notification whose verdict reads `READY_FOR_INTEGRATION` (the SubagentStop hook
  emits it when a stopped executor's ticket carries a pending submission).
- `sidequest publish queue --json` showing pending submissions at any natural wakeup (`pulse` and
  `list --brief` also surface a ticket's `submission`).

Batch deliberately: when a wave is mid-flight, let its remaining executors finish and publish the
wave's submissions in one transaction — one lock hold, one version assignment, one seam check, one
push — instead of one transaction per ticket. Don't wait on work that isn't in flight.

## Delivery modes

The orchestrator is the integrator. A submitted range stays pinned at `refs/sidequest/<SQ-n>` until
its exact assembled wave has delivered. A singleton can be assembled and gated during `integrate`; for
a group, first run `sidequest assemble-wave <SQ-n> [SQ-n...] --verify "<gate evidence>"`, then pass
that exact same participant set to `sidequest integrate`. The engine refuses delivery when the group
has no passing assembled-wave gate, includes a participant from another wave, omits a participant, or
tries to deliver one participant from a multi-ticket wave. It records delivery only after one passing
wave delivers its exact Git participant set and the resulting revision passes its delivery verification.
`integrate <ref> --by <who> --mode <merge|replay|apply>` performs that delivery and closes every
participant only after the record exists. It validates each submitted range and admitted scope again,
names stray paths, and never deletes a pinned ref.

`integrate` with `wave: {}` opens a fresh wave at the configured integration target's current head.
A recorded wave for the same participants whose baseline is behind that head is superseded rather than
reused. A candidate verified against an ancestor of the current target can join that wave; the merged-tree
gate covers the newer target content. An assembly refusal leaves every submitted participant parked in
`doing` with its candidate intact, including a refusal that reports an invalidated candidate.

- `merge` is the default for release-pipeline repos such as Toolshed. It merges the submitted tip into
  the configured integration branch.
- `replay` cherry-picks the submitted commits in order, keeping atomic history. A conflict aborts the
  cherry-pick and restores the prior HEAD.
- `apply` materializes the range without a commit so the user can review it in their changes view. It
  refuses overlapping uncommitted paths and names them. Its delivery record plus pinned ref is enough
  to close the ticket, no user-side commit is required.
- An external reset, manual, or working-tree integration can record the pinned candidate even when it
  is not an ancestor of the integration branch. Pass that candidate as `--delivery-commit` with
  `--delivery-method reset|working-tree|manual` and evidence naming the mechanism. Sidequest compares
  every submitted path against the integration working tree, reruns the delivery gate, then records
  the pinned candidate with the observed integration revision. A missing or different path refuses.

Set the board default with `sidequest board-config --delivery merge|replay|apply`. Consumer boards
usually want `apply` or `replay`; use `merge` where the repository's release flow owns integration.

If a repair ticket deliberately delivers an earlier parked submission, do not replay the obsolete range. Use MCP `supersede_submission` with the earlier ref, the later integrated repair ref, concise closure evidence, and `reviewedReplacements` for every original path whose delivered content intentionally differs. The control plane requires the repair's recorded delivery to include every original changed path, preserves the earlier submission and its lineage under `supersededBy`, marks it done, and removes its pending-submission warning. A missing path, an unintegrated repair, or unreviewed divergent content leaves the original submission parked.

## Local-only repositories

`board-config --integration-mode local` records ranges against local `main`; `auto` chooses that mode when
`origin` is absent. Integrate in a clean worktree from `main`, run the same reachability checks against
`main`, then skip fetch and push. Local delivery uses the same assembled-wave gate: assemble the exact
participant set, record a passing gate, and deliver it through `integrate` before any participant can
be recorded as delivered or closed. The configured delivery mode runs only from a clean checkout on
the target branch; any other checkout state refuses and names the condition. Remote mode keeps the
transaction below unchanged; an existing but broken upstream still rejects the submission.

## The publish transaction

Run every step in order; any failure before the push aborts the transaction without touching the
board (submissions stay parked — fail closed).

1. **Acquire the publish lock**: `sidequest publish lock --by <session-worker-id>`. The lock lives
   in the repo's common git dir, so every session, process, and worktree serializes on it. If held,
   do NOT wait or poll: note the holder from the failure output and retry at the next natural
   wakeup. `--steal` only when `publish status` shows the holder stale (TTL expired or dead pid).
   Re-acquiring from the same session refreshes the lock — that is the crash-recovery path for your
   own interrupted transaction.
2. **Read the queue**: `sidequest publish queue --json`. Queue admission mechanically revalidates each durable range and its submit-time admitted scope snapshot. Rejected entries name their offending paths and stay parked. A legacy entry without a scope snapshot stays parked until its executor resubmits it.
3. **Read each submitted handoff**: before integrating or closing a ticket, run
   `sidequest comments <ref> --json` for it. The queue is intentionally compact and does not replace the
   full thread. Act on unresolved risks or questions: resolve them, skip and file a scoped integration
   ticket, or leave the submission parked. Do not cherry-pick until the thread is understood.
4. **Create a clean integration worktree** from the current remote main, never from any working
   tree: `git fetch origin` then `git worktree add <scratch>/sq-integrate origin/main --detach`.
   Install the touched plugin's dependencies before reverifying, for this repo:
   `cd <worktree>/plugins/<name> && npm ci`. Never integrate in the shared session tree — pre-staged
   or dirty files there are exactly the contamination this flow exists to prevent.
5. **Reconstruct each admitted submission before assembly**. Resolve its durable ref and require it
   still points to the submitted tip. Require the recorded upstream commit to remain reachable from
   the current recorded integration target, then require the stored dispatch base to lie on the tip's
   history and either follow their merge-base or already be reachable from that integration target.
   Compare `git rev-list --reverse <base>..<tip>` to the queue's ordered `commits` array exactly.
   Reject an empty range, divergent or unrelated history, or a range containing a commit from another
   queued ticket. A merge commit inside the submitted range is admissible when this reconstruction and
   scope admission pass. Scope admission is mechanical at queue read and again at delivery closure,
   against the immutable submit-time snapshot. Leave rejected submissions parked.
6. **Assemble and deliver exact waves**, oldest compatible waves first. For every group, call
   `sidequest assemble-wave` with every intended participant and its project-defined gate evidence.
   A moved baseline, missing verifier, out-of-scope surface, or overlapping participant surface refuses
   assembly and reports the affected candidates without changing their submissions. Pass only the exact
   participant set from the passing assembly to `sidequest integrate`; a partial set, a mixed wave, or a
   failed/missing gate refuses before a delivery record exists. `integrate` delivers all Git participants as
   one unit, verifies the resulting revision, then records delivery for every participant. A conflict or
   failed delivery verification rolls back the delivery, leaves the wave parked, and requires a repair or
   refreshed assembly.
7. **Assign versions centrally**: for each plugin touched by the integrated set, take origin's next
   free version ONCE for the batch and bump BOTH `plugins/<name>/.claude-plugin/plugin.json` and the
   root `.claude-plugin/marketplace.json` (they must match) in one commit. Executors no longer bump
   anything, so versioning has exactly one writer: this step.
8. **Require delivery verification**: `integrate` runs the pinned project verifier against the
   resulting revision before it records delivery for an assembled wave. A red result rolls back the
   delivery and leaves every participant parked. Do not record or close a participant through an
   administrative closure to bypass this gate.
9. **Seam check the batch**: with 2+ integrated commits, run the shared suite the tickets sit in
   (for this repo: `node --test plugins/sidequest/test/*.test.js`, or the suites of the touched
   plugins) so per-ticket-green but jointly-red seams are caught before the push.
10. **Review the integrated diff — the gate before the push**. Green verification is necessary but is
   NOT a review. For each integrated ticket, review the change for correctness, scope-safety, and
   security. Read the diff yourself (`git diff <base>..HEAD -- <scope>`) for a small or mechanical
   change; for a substantial, cross-cutting, or security-sensitive one, dispatch a `review-audit`
   executor (or `security-audit`) bound with `reviewTarget` to that ticket and its exact submitted
   commit, so the review runs against a pinned immutable checkout, and read its findings before
   continuing. A bound candidate cannot be reclaimed, amended, cleared, superseded, or integrated until
   its review finishes, and no caller-controlled route can reject it: `rework` and every other direct route
   return `candidate_review_locked` without writing. A review that finds a defect records its evidence on the
   review ticket and releases that review with `kind=oracle`. When that oracle accepts the defect conclusion,
   Sidequest marks both binding halves `rejected`; after a fresh repair is reviewed and integrated,
   `supersede_submission` closes the rejected source against the repair. Integration also needs both runtime
   identities from the immutable terminal dispatch attempts (the source's `submitted` attempt for that exact
   commit, the review's `done` attempt) and refuses when either is missing or both are the same agent.
   Resolve or explicitly accept every finding before pushing. A finding that needs rework is an
   integration failure: drop that ticket's range, leave its submission parked, and file a scoped ticket
   (see "Integration failures fail closed") — never push code you have only tested and not read.
11. **Push and confirm**: `git push origin HEAD:main` from the integration worktree — never a new
   branch. A non-fast-forward → `git pull --rebase origin main`, rerun steps 8-10, push again. Then
   fetch fresh and confirm the integrated commits (the cherry-picked equivalents, not the submitted
   range hashes) are covered by `git log origin/main`; the assembled-wave record identifies the exact
   participant set whose delivered content passed verification.
12. **Confirm delivery, then clean up**: `integrate` records delivery and closes every exact wave
    participant only after the full participant set landed and its delivery verification passed. Do
    not use `groom-close --integration` as a publish step or to close a wave participant individually.
    After every delivered commit is reachable, remove its durable ref (`git update-ref -d
    refs/sidequest/<SQ-n>`), remove the integration worktree (`git worktree remove
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

## Dead executor salvage

A dead executor's `done` only proves the board transition, never that work shipped. Inspect its
declared scope and publish anything uncommitted. For work it committed and verified but never
submitted, recover `refs/sidequest/<ref>`, re-run the verify, release the dead claim, publish, then
close it with the control-plane grooming closure citing the pushed commit. Never spawn an executor
just to run `submit` or `done`.

## Crash recovery

The lock records owner pid + session metadata + timestamp. A publisher that dies mid-transaction
leaves: a held lock (reclaimable — same session refreshes on re-acquire; anyone else waits for the
TTL or `--steal`s a provably stale holder), an orphan integration worktree (`git worktree list` →
`git worktree remove --force`), and parked submissions (still queued; the durable refs still pin
the commits). Nothing is lost: rerun the transaction from step 1. Tickets are only marked done
after their commits are reachable from `origin/main`, so a crash can never strand a done-but-
unpushed ticket.
