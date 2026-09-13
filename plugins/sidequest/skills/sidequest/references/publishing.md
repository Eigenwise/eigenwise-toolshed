# Publishing: the orchestrator control plane

Executors never publish. A repo-changing executor ends at a verified LOCAL commit in its isolated
worktree, pins it to a durable ref (`refs/sidequest/<SQ-n>`), and parks the ticket
ready-for-integration with `sidequest submit` (claim released, status stays `doing` and out of
`ready`, no push, no version bumps). Publishing — integrating those commits, running local delivery
verification, completing tickets in the control plane, then gating, assigning versions, and pushing
main — is ONE serialized transaction owned by the orchestrator. This file is that transaction.

`submit` derives the admitted range from the base recorded on the ticket's dispatch. Pass `--base <commit>`
(or MCP `base`) only when automatic selection cannot identify the boundary. An explicit base must always lie on the
submitted tip's history, and it must additionally either sit at or after the current merge base or already be
reachable from the integration branch. A base that is not reachable from the integration branch must match the
dispatch-recorded boundary; otherwise admission refuses it as `unrecognized_base` and preserves the candidate
for retry. The range still has to satisfy the current ticket's declared scope and ownership checks. For an
executor based on a feature branch, pass that branch as MCP dispatch `integrationBranch`. The dispatch
records that ticket delivery target and its starting commit. Submit validation, wave assembly, and delivery
keep using it even if the board default later changes. A wave can contain only tickets with the same recorded
target identity, including local versus remote mode; mixed targets refuse before assembly or branch writes.
A submitted range may contain merge commits; validate its reachable range and scope instead of treating a
merge commit as an automatic refusal.

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

`integrate` with `wave: {}` opens a fresh wave at the matching tickets' recorded delivery target current head.
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
- When a working-tree delivery cannot record its initial dirty baseline, it still dispatches without an inherited-path exemption, so every dirty path is attributed to the executor at closeout.

### Overlapping candidates with different pinned verifiers

A wave refuses when participants pin different verifier requirements. Keep those frozen records intact. When reviewed candidates overlap, compose their exact accepted candidate refs in the registered target, run every participant's pinned verifier and the full composed gate against that tree, then record each delivery through `groomClose` with its own immutable candidate as `deliveryCommit` and `deliveryMethod: "manual"`. Omit `integration: true`: that field selects the assembled-wave route and requires a matching delivered wave.

This route still fails closed. Do not skip a verifier or review, substitute current `HEAD` for the pinned candidate, claim an unverified target, or close when the candidate's submitted paths are missing or differ. `groomClose` compares the pinned candidate to the registered target working tree and reruns delivery verification before it records delivery.

Set the board default with `sidequest board-config --delivery merge|replay|apply`. Consumer boards
usually want `apply` or `replay`; use `merge` where the repository's release flow owns integration.

If a repair ticket deliberately delivers an earlier parked submission, do not replay the obsolete range. Use MCP `supersede_submission` with the earlier ref, the later integrated repair ref, concise closure evidence, and `reviewedReplacements` for every original path whose delivered content intentionally differs. The control plane requires the repair's recorded delivery to include every original changed path, preserves the earlier submission and its lineage under `supersededBy`, marks it done, and removes its pending-submission warning. A missing path, an unintegrated repair, or unreviewed divergent content leaves the original submission parked.

## Integration mode: where delivery happens versus what proves a candidate landed

`auto` (the default) picks `remote` mode whenever an `origin` remote exists and `local` otherwise;
`board-config --integration-mode local` pins local. The mode does not change where delivery happens.
**Both modes deliver by merging or cherry-picking into the LOCAL configured branch in the registered
checkout and running the pinned verifier there.** The board never fetches and never pushes, so your
push is still a separate operator step after `integrate` returns. What `remote` mode adds is a second
piece of landed proof: the frozen `refs/remotes/<upstream>` ref counts alongside `refs/heads/<branch>`
when the control plane asks whether a candidate, an accepted equivalent patch, or a submitted base is
already contained in the integration target. Local mode stays local-only. Refs are always read fully
qualified, so a tag named `main` or `origin/main` cannot shadow either one.

Two consequences worth knowing before a publish run:

- A recorded delivery revision names the ref that actually carried it. Work you merged and verified
  locally is recorded as `git:<branch>`, never as `git:origin/<branch>` when origin does not have it
  yet. A candidate someone landed out of band and that the board only observes on the remote ref is
  recorded as already-landed against that remote ref, not abandoned.
- If a closure needs the merged-tree gate but the candidate (or its exact accepted equivalent) exists
  only on the remote ref while the local branch is behind, `integrate` refuses with
  `integration_target_behind_landed_candidate`, naming the ref, the observed commit, and the candidate.
  It does not move your checkout, does not fast-forward anything, and does not run the verifier. For a
  wave, every participant is preflighted before any branch moves or any verifier runs, so the refusal
  leaves no partial delivery. Synchronize the local target deliberately (your own fetch, then
  `git merge --ff-only <ref>`) and re-run the closure. A candidate that simply has not landed yet
  still merges locally as usual.

A missing or unreadable frozen integration ref fails closed as `integration_target_unavailable`
instead of quietly falling back to a local ref; fetch or recreate it, then retry. Non-Git and artifact
completions are unaffected by all of this. Legacy submissions recorded before the mode was stored keep
local semantics.

Local-only repositories use the same assembled-wave gate: assemble the exact participant set, record a
passing gate, and deliver it through `integrate` before any participant can be recorded as delivered or
closed, then skip fetch and push. An existing but broken upstream still rejects the submission.

## The publish transaction

Run every step in order. Local delivery through `sidequest integrate` records the delivery and
completes each ticket in the control plane after its local delivery verification. That closure happens
before the merged-tree gate, version assignment, or push. A later failure can therefore leave a done
ticket with an unpushed commit: finish the push when safe, or record the failure and unpushed state on
the ticket.

1. **Acquire the publish lock**: `sidequest publish lock`. The lock identity is derived internally
   from the current session and worker, and the lock lives in the repo's common git dir, so every
   session, process, and worktree serializes on it. If held, do NOT wait or poll: note the holder from
   the failure output and retry at the next natural wakeup. `--steal` only when `publish status` shows
   the holder stale (TTL expired or dead pid). Re-acquiring from the same session refreshes the lock —
   that is the crash-recovery path for your own interrupted transaction.
2. **Read the queue**: `sidequest publish queue --json`. Queue admission mechanically revalidates each durable range and its submit-time admitted scope snapshot. Rejected entries name their offending paths and stay parked. A legacy entry without a scope snapshot stays parked until its executor resubmits it.
3. **Read each submitted handoff**: before integrating or closing a ticket, run
   `sidequest comments <ref> --json` for it. The queue is intentionally compact and does not replace the
   full thread. Act on unresolved risks or questions: resolve them, skip and file a scoped integration
   ticket, or leave the submission parked. Do not cherry-pick until the thread is understood.
4. **Put the project's registered checkout on a clean configured target branch.** `integrate` always
   merges and verifies in that registered checkout: the control plane folds whatever directory you call
   it from back to the registered repo root, so adding a scratch linked worktree does NOT move the
   target. Check out the configured integration branch there and confirm
   `git branch --show-current` reports it; a detached HEAD or any other branch refuses. Any staged,
   modified, or untracked file in that checkout refuses with `integration_target_dirty` and names the
   offending paths before a branch moves or a verifier runs, so commit, stash, or remove them first
   rather than trying to hide them in another worktree. Install the touched plugin's dependencies
   before reverifying, for this repo: `cd plugins/<name> && npm ci`.
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
   participant set from the passing assembly to `sidequest integrate` while the configured target branch
   is checked out; a partial set, a mixed wave, or a failed/missing gate refuses before a delivery record
   exists. `integrate` delivers all Git participants as one unit. It runs the pinned project verifier
   against the resulting revision before it records delivery for an assembled wave. A red result rolls
   back the delivery and leaves every participant parked. Do not record or close a participant through
   an administrative closure to bypass this gate. After verification passes, it records delivery for
   every participant and completes them as control-plane tickets. A conflict or failed delivery
   verification rolls back the delivery, leaves the wave parked, and requires a repair or refreshed
   assembly. This local completion does not wait for remote reachability.
7. **Seam check the batch**: with 2+ integrated commits, run the shared suite the tickets sit in
   (for this repo: `node --test plugins/sidequest/test/*.test.js`, or the suites of the touched
   plugins) so per-ticket-green but jointly-red seams are caught before versioning or the push.
8. **Apply review at the sized depth**: consume each submission report and the delivery and
   merged-tree gate evidence. Do not inspect executor source or diffs as an orchestrator review.
   A deterministic singleton needs no bound review. Bind a `review-audit` ticket to the exact
   candidate when the oracle is weak, consumers remain materially unchecked, or the work is
   high-stakes; use distinct review lenses for high-stakes or multi-wave work. A bound candidate
   cannot be reclaimed, amended, cleared, superseded, or integrated until its review finishes.
   Neither the candidate nor its bound review can ever be deleted, even with `force`; keep both
   immutable records instead of cancelling the review. This guard does not repair older orphaned
   records. A fresh independently reviewed replacement is separate work. No caller-controlled route
   can reject the candidate: `rework` and every other direct route return
   `candidate_review_locked` without writing. A review that finds a defect records its evidence on
   the review ticket and releases that review with `kind=oracle`. When that oracle accepts the
   defect conclusion, Sidequest marks both binding halves `rejected`; after a fresh repair is
   reviewed and integrated, `supersede_submission` closes the rejected source against the repair.
   Integration also needs the immutable terminal dispatch identities for the submitted source and
   completed review, and refuses when either is missing or both are the same agent. Resolve or
   explicitly accept every finding before versioning or pushing. A finding that needs repair leaves
   its submission parked and goes through the applicable rejection flow below.
9. **Validate the release window, do not write versions**: the cut is the only writer of plugin and
   marketplace versions, so never hand-edit `plugins/<name>/.claude-plugin/plugin.json` or the root
   `.claude-plugin/marketplace.json`. Confirm instead that every integrated ticket that changed a
   published plugin left a fragment in `.release/unreleased/`, and that the window is the one you mean
   to ship: `node scripts/release/plan.mjs` then `node scripts/release/cut.mjs --prepare --dry-run`.
   A missing fragment is what `node scripts/release/note.mjs <REF> --plugins <name> --bump <level>
   --commit <sha>` is for. If this or the seam/review gate fails, the locally delivered ticket is
   already done; record the failure and do not claim that it was pushed.
10. **Push and confirm**: push the integration branch the dispatch recorded, from the registered
    checkout — never a new branch. Where that branch is protected (Toolshed: both `develop` and
    `main` are), it moves through a pull request instead of a direct push, and the release itself is
    a separate promotion PR from a release branch: `node scripts/release/cut.mjs --prepare --push`,
    merge the PR it prints, then `node scripts/release/finalize.mjs --push` to tag the merged commit,
    then merge the `main` → `develop` sync PR that finalize prints before any further feature PR.
    Never force-push, reset, or otherwise rewrite a protected branch to get work landed. A
    non-fast-forward → `git pull --rebase origin <branch>`, rerun steps 7-9, push again. Then
    fetch fresh and confirm the integrated commits (the cherry-picked equivalents, not the submitted
    range hashes) are covered by `git log origin/<branch>`; the assembled-wave record identifies the
    exact participant set whose delivered content passed verification. If push or confirmation fails,
    the ticket remains done from local delivery but unpushed; finish the push or record the failure on
    the ticket instead of claiming remote reachability.
11. **Clean up after confirmation**: do not use `groom-close --integration` as a publish step or to
    close a wave participant individually. After every delivered commit is reachable, remove its
    durable ref (`git update-ref -d refs/sidequest/<SQ-n>`) and run `sidequest publish unlock`. Unlock
    happens LAST, in a step that runs even when earlier cleanup partially fails. If a later step
    failed, retain the refs or executor worktrees needed for recovery, record the failure on the done
    ticket, and still release the publish lock.

## Integration failures fail closed

A submission that conflicts or fails post-integration reverify before local delivery closure is never
force-merged and never silently dropped. A seam, review, version, or push failure after local delivery
is recorded against the already-done ticket; it must not be described as remotely reachable:

- Before local delivery closure, leave its submission parked (do NOT `done`, do NOT clear it reflexively).
- File a narrowly scoped integration ticket for a local delivery conflict or verification failure: the
  conflicting ref, the exact failure output, the submitted commit + durable ref, and what the integrator
  may touch. Link it `blocks` the original.
- For a later gate or push failure, keep the done ticket's failure evidence and either finish the push
  or file the narrowly scoped recovery ticket needed to complete or repair it.
- For an **unbound** candidate that a review rejects or otherwise needs its original work redone,
  use `sidequest rework <ref> --by <candidate-owner> --review "<evidence>" --reason "<repair>"`.
  It preserves the candidate and rejection evidence while returning the ticket to `todo` for a
  normal repair claim.
- Use `sidequest submit <ref> --clear -s todo` only for an actual integration bounce: delivery
  returned an unbound candidate to its producer without a review rejection, and the candidate must
  be dropped before the ticket can restart. Record the delivery refusal. A review-bound candidate
  rejects both routes; retain its oracle, then repair through a fresh ticket and supersede it only
  after the reviewed repair integrates.

## Dead executor salvage

A dead executor's `done` only proves the board transition, never that work shipped. Inspect its
declared scope and publish anything uncommitted. For work it committed and verified but never
submitted, recover `refs/sidequest/<ref>`, re-run the verify, release the dead claim, publish, then
close it with the control-plane grooming closure citing the pushed commit. Never spawn an executor
just to run `submit` or `done`.

## Crash recovery

The lock records owner pid + session metadata + timestamp. A publisher that dies mid-transaction leaves: a
held lock (reclaimable — same session refreshes on re-acquire; anyone else waits for the TTL or
`--steal`s a provably stale holder), a registered checkout left mid-delivery or dirty (`git status`,
and `integrate` refuses it as `integration_target_dirty` until it is clean), and either parked
submissions from a pre-delivery failure or done tickets whose local delivery has not reached the remote
yet. Nothing is lost: rerun the transaction from step 1, inspect each ticket's completion and delivery
record, recover any durable refs needed for the push, then finish the push or record the failure on the
ticket. A done ticket alone never
proves that its commit is reachable from `origin/main`.
