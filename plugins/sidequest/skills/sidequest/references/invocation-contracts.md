# Invocation contracts

The things a caller cannot get right from the tool schema alone. Everything here is enforced at runtime,
so getting it wrong costs a refused call and a retry. Enum values themselves are already in the schemas;
this file only covers what the schema has no way to say.

## Conditional requirements

- **`release`**: `reason` is required at runtime even though schema `required` is only `ref` and `by`. An
  oracle ask in `oracle` stands in for it. `kind: technical_blocker` and `kind: contradiction` additionally
  need `command` and `outputTail`, and are refused without them. `kind: oracle` parks the ticket in
  `awaiting-oracle` and the handoff stays visible until `verdict`. `kind: handback` is for refused paths:
  commit the in-scope work first, then name the paths you could not touch.
- **`add` / `update` verification**: `verifyKind` is one of `suite`, `command`, `typecheck`, `document`,
  `link`, `schema`, `manual`, `attestation`, `review`, or `custom`. `suite`, `command` and `typecheck` require a
  runnable command; `typecheck` pins the project's type checker as the oracle for annotation-only work. The other
  kinds retain the submitted evidence contract. `verifyKind: attestation` also requires
  `verify` in the form `attestation: <attestationArtifact verbatim> | <evidence produced> | <what it showed>`;
  any other shape is refused. `verifyCwd` (`--verify-cwd`) is the directory the command runs from, relative to
  the project root; the capture and the integrate gate both use it. Prefer it to `cd <dir> && ...` for a nested workspace.
- **`submit` command verification**: when the dispatch pins `environment: shared`, submit records `deferred`, not a passing capture. Run focused checks that need no environment, commit, and submit; the orchestrator runs the pinned verifier at delivery. Otherwise, run the dispatched `verify-capture` wrapper after the final candidate commit. It records a completed capture bound to the ticket, exact declared command, and candidate revision. `verify` still has to equal the declared command, but that string is only a reference to the capture, never proof that it ran. A stale or missing capture is retryable: rerun the wrapper, which loads the declared command from the ticket, and submit again. `manual` and `attestation` stay evidence-based.
- **`done` working-tree verification**: a command or suite requirement still needs its matching final `verify-capture`; `done.verify` cannot replace it. A commandless document, link, schema, custom, manual, or attestation requirement needs nonblank explicit `verify` evidence, which Sidequest stores with its actual typed status. `review` is refused for working-tree delivery because executor evidence has no independent reviewer provenance.
- **`integrate` wave assembly**: MCP `ref` is one ticket ref or a comma-separated participant group, such as `"SQ-12,SQ-13"`. `wave` is only the options object, with `waveId`, `dependencies`, `verification`, `skipVerify`, and `verificationWaiver`; an array of refs there is refused. CLI groups stay positional: `sidequest integrate SQ-12 SQ-13 --by <who>`.
- **`integrate` environment lane**: the lane is the delivery gate in the shared checkout, against the merged tree. Use CLI `integrate <ref> --project <path> --json` with Bash `run_in_background` and act on its completion notification; MCP refuses `environment_lane_requires_cli`. Delivery must be `merge` or `replay`: `apply` leaves the target dirty and the next item refuses `integration_target_dirty`. A first post-merge verify failure or `--no-ff` merge conflict rolls back and returns an unbound candidate to `todo` with Pending rework evidence. Only the orchestrator dispatches again. A second lane failure parks with `environment_lane_second_failure`; review-bound candidates never auto-rework. `groomClose` with `deliveryCommit` runs the same delivery verification in the registered checkout and is a lane run.
- **`integrate` verification waiver**: `skipVerify: true` also requires `verificationWaiver` with `authority`,
  `reason`, `affectedGate`, and either a bounded `scope` or future `expiresAt`. Sidequest validates and stores
  the waiver Diagnostic with the integration result; a bare `skipVerify` is refused.
- **`add`**: `complexity` is the legacy ambiguity fallback and requires `why` alongside it (min 20 chars).
  Stamp `category` from the live taxonomy instead whenever one fits. `add` takes every ticket field `update`
  takes except `status`, `by`, and `ref`, which only describe an existing ticket, so `externalDeliverable`,
  `workingTreeDelivery`, `readonly`, and the verifier fields work at filing time. `unclassified` is `add`-only.
- **`by` on control-plane calls**: `rework`, `supersede_submission`, and `groomClose` default an omitted `by`
  to the main session id. A subagent calling `rework` without `by` gets the owner label its own dispatch recorded,
  or a refusal naming the labels in conflict; a subagent calling `supersede_submission` or `groomClose` without
  `by` is refused, so pass your own claim id. `rework` still requires the candidate owner, so the default only
  passes when that is you; otherwise pass `by` as the submitter. Every other tool, `claim`, `done`, `release`,
  `submit`, `commit`, `checkpoint`, `scopeRequest`, `integrate`, and `next`, still needs an explicit `by`.
- **`rework` text over its cap**: `review` (1000 chars) and `reason` (4000 chars) are never refused for
  length. The full text is stored as a ticket comment attributed to `by`, and the field keeps a truncated
  summary ending in `[full text: comment <id>]`. Read the comment for the whole finding.
- **`groomClose`**: one tool, three purposes, each with a different gate. `deliveryCommit` closes it as a
  delivery and the commit must already be reachable from the integration target recorded when that ticket was
  prepared. A later board-target or checkout change does not retarget the ticket. `integration: true` closes
  it as an integration. Neither of those closes it as grooming. `reason` is required in all three.
- **`verdict` completed normal review**: after the independent bound review genuinely closes with `done`, the trusted main thread calls MCP `verdict` with explicit `outcome: "accepted"` or `"rejected"`, nonempty `by` and `text`, and `finalize: {sourceRef, commit, evidence}` (or exactly one `sourceRevision: {source, value}` instead of `commit`). Copy the original `reviewTarget` identity. Both tickets must be terminal and unclaimed, with the exact pending source, two-sided binding and distinct immutable runtime provenance. The original review completion, role, dispatch, report and candidate stay intact. `ACCEPTED` prose and generic links grant no outcome. Exact substantive retries write nothing; contradictory decisions use accepted-to-rejected correction or a fresh repair candidate. CLI and dashboard cannot grant finalization. Experimental awaiting-oracle rounds keep ordinary `verdict`. Unsupported non-Git provenance refuses explicitly.
- **`verdict` external review**: for a never-dispatched bound review still in todo, use the same main-thread `verdict.finalize` with `authority: "main-attestation"`, explicit accepted/rejected, nonempty by/text/evidence naming where the review happened, exact sourceRef and one commit/sourceRevision. Source must be terminal, unclaimed and pending. Accepted permits integration; rejected blocks it. Records `reviewerRuntimeProvenance: false`, preserving absent dispatch/completion. Active, released or incomplete reviewers refuse; do not use this to bypass a native reviewer. The same accepted-to-rejected correction rules apply.
- **`verdict` correction**: ordinary outcomes stay candidate-addressed: `accepted` approves the candidate, `rejected` confirms it must not ship, and `inconclusive` approves nothing. To correct a mistaken finalized accepted bound normal review (including a writable reviewer), or an accepted readonly oracle review, the trusted main thread calls MCP `verdict` with `outcome: "rejected"`, nonempty `by`, `text`, and `correct.evidence`, optional `why`, and no `constraint`. `correct` supplies `expectedOutcome: "accepted"`, the original timestamp from `list({ref: reviewRef}).ticket.reviewDecision.verdict.at` (or `ticket.oracle.verdict.at` for an oracle), `sourceRef`, and exactly one `commit` or `sourceRevision: {source, value}`. Both review and source must be unclaimed and terminal; the exact source submission must remain pending with a nonconflicting two-sided binding. The original verdict, completion, experiment log, and candidate identities stay intact; a correction audit/comment is appended and both binding halves become rejected. An exact substantive retry, including from a reloaded authorized main session, writes nothing. Different rationale/evidence, delivery, supersession, or binding drift refuses. A retained repair can then submit its full rejected-source range, but still needs its own independent review and delivery gates. `by` is audit provenance. Authority is the existing non-public MCP/store grant plus the host hook's main-thread caller class and actual runtime session identity, not cryptographic actor-origin proof. Subagents, ungranted store calls, CLI, and dashboard cannot mint this grant.
- **`update.admitComposition`**: the trusted main thread can adopt exact immutable candidate C for a genuinely released, unclaimed root using `authority: "main-attestation"` and `historicalCheckout: false`. `by` and `evidence` are audit fields; the caller class, internal MCP/store grant, and actual runtime session supply authority. Call it separately from ordinary updates. Omit `expected` for a write-free `expected_required` probe, then copy the observed root `attemptCount`, `releasedAt`, `preparedAt`, and each source's `ref`, `reviewTicketId`, `reviewOutcome`, `correctedAt`, and `snapshot` into `expected`. Name each related source's exact `commit` and `submittedAt`; sources need their complete recorded base, commits, and admitted scope. The locked CAS includes the authoritative two-sided review, verdict, and correction generation, even when the source mirror did not change. Rejected, delivered, superseded, active, or drifting sources refuse. `ownCommits` plus the complete source ranges must account for every commit in original BASE..C exactly once; `ownPaths` must match the root's own changes within its original scope. Another ticket's recorded commits or release fragments cannot become root own attribution. Admission leaves sources and old proofs unchanged and preserves the released dispatch snapshot. A fresh scoped writable native isolated checkout starts at C, while `dispatch.baseCommit` stays original BASE. One new attempt, `preparedAt`, and genuine nonce digest consume the grant; redispatch cannot replay it, and live-claim recovery (`dispatch` with `claimHolder`) refuses write-free with `admission_consumed` instead of re-minting that nonce. Run ordinary `update.verify`/`verifyCwd` separately for fresh holder-owned output, then ordinary controls, capture, full-range submission, independent post-submit exact-C review, and delivery. Adoption never supplies historical checkout ownership, source acceptance, capture evidence, or a delivery waiver.
- **`supersede_submission`**: `supersededBy` is the repair ticket's ref, not a commit. A bound candidate stays locked. Its completed normal review records the explicit decision through main-thread MCP `verdict.finalize`; an awaiting-oracle review uses ordinary `verdict`. When the defect means the bound candidate must not ship, record `outcome=rejected`; `accepted` approves the candidate, and verdict text does not override the enum. After a fresh repair is reviewed and integrated, `supersede_submission` can close the rejected source submission.

## Held-executor messages

If a board-derived name fails, only the ORIGINAL matching host session may send once to the authentic `dispatch.agentId`, or the exact original host Agent-returned identifier when actually available. Confirm the recorded original session. `claim.by` and holder labels are not addresses; never guess an ID/name, shorten an ID, use another session, or dispatch a replacement as an address substitute. Missing/mismatched authentic ID or session means continuation UNVERIFIED: preserve claim/work. Honor an explicit user **Pause retries** decision.

A queued/resuming transport result proves no work, completion, or death. Call the executor resumed only after its authentic response/activity. Unknown/completed/absent/failed-send results stay nonterminal. Never restart a terminal executor. This is one original-executor continuation, with no automatic send, retry loop, retirement, takeover, or claim/token/status mutation. See `orchestration.md` for the surrounding lifecycle.

## Synonyms the validator accepts

Pass either name, never both: passing both is refused before anything is written. When a synonym is used
the response carries `acceptedAliases` naming the substitution.

- `add`: `story` for `storyId`
- `comment`: `message` or `m` for `body`
- `link`: `ref` for `from`, `type` for `verb`, `target` for `to`
- `link`: `dependsOn` is the depends-on relation, either as the verb or as `{ from: "SQ-4", dependsOn: "SQ-3" }`
  in place of `verb` and `to`
- `story_log`: `append` for `entry`
- `unlink`: `from` for `a`, `to` for `b`
- any tool taking a priority: `priority: "medium"` is coerced to `"normal"` (`medium` is an effort value,
  not a priority)

An unknown argument name is refused with the full accepted list, plus a suggestion when exactly one
accepted name is within two edits.

## The CLI and MCP name the same things differently

| what | CLI | MCP |
| --- | --- | --- |
| file a ticket into a story | `--story US-n` | `storyId: "US-n"` |
| clear a ticket's story | `--story none` | `storyId: "none"` |
| comment body | `-m "text"` or `--body-file <path>` | `body` |
| relate two tickets | `sidequest link SQ-4 depends-on SQ-3` (positional) | `{ from: "SQ-4", verb: "depends-on", to: "SQ-3" }` |
| append to a story's decision log | `sidequest story log US-1 -m text` | `story_log` with `entry` |
| waive integration verification | `--skip-verify` plus `--waiver-authority`, `--waiver-reason`, `--waiver-gate`, and `--waiver-scope` or `--waiver-expires-at` | `skipVerify: true` plus the structured `verificationWaiver` object |

Paging is the same on both: `limit` plus `cursor`, and you follow `nextCursor` until it is null.

## Reads that take no arguments

Call these with `{}`, or with `project` alone to target another board: `list`, `changes`, `ready`,
`category_list`, `profile_list`, `board_config`, `models`, `projects`.

`board_config` and `global_fallback` are read-or-write on the same tool: with no writable key they return
current settings, and with one they patch. So a bare `board_config` call is always safe.
