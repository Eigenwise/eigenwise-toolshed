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
- **`add` / `update` verification**: `verifyKind` is one of `suite`, `command`, `document`, `link`,
  `schema`, `manual`, `attestation`, `review`, or `custom`. `suite` and `command` require a runnable
  command. The other kinds retain the submitted evidence contract. `verifyKind: attestation` also requires
  `verify` in the form `attestation: <attestationArtifact verbatim> | <evidence produced> | <what it showed>`;
  any other shape is refused. `verifyCwd` (`--verify-cwd`) is the directory the command runs from, relative to
  the project root; the capture and the integrate gate both use it. Prefer it to `cd <dir> && ...` for a nested workspace.
- **`submit` command verification**: run the dispatched `verify-capture` wrapper after the final candidate commit. It records a completed capture bound to the ticket, exact declared command, and candidate revision. `verify` still has to equal the declared command, but that string is only a reference to the capture, never proof that it ran. A stale or missing capture is retryable: rerun the wrapper, which loads the declared command from the ticket, and submit again. `manual` and `attestation` stay evidence-based.
- **`done` working-tree verification**: a command or suite requirement still needs its matching final `verify-capture`; `done.verify` cannot replace it. A commandless document, link, schema, custom, manual, or attestation requirement needs nonblank explicit `verify` evidence, which Sidequest stores with its actual typed status. `review` is refused for working-tree delivery because executor evidence has no independent reviewer provenance.
- **`integrate` wave assembly**: MCP `ref` is one ticket ref or a comma-separated participant group, such as `"SQ-12,SQ-13"`. `wave` is only the options object, with `waveId`, `dependencies`, `verification`, `skipVerify`, and `verificationWaiver`; an array of refs there is refused. CLI groups stay positional: `sidequest integrate SQ-12 SQ-13 --by <who>`.
- **`integrate` verification waiver**: `skipVerify: true` also requires `verificationWaiver` with `authority`,
  `reason`, `affectedGate`, and either a bounded `scope` or future `expiresAt`. Sidequest validates and stores
  the waiver Diagnostic with the integration result; a bare `skipVerify` is refused.
- **`add`**: `complexity` is the legacy ambiguity fallback and requires `why` alongside it (min 20 chars).
  Stamp `category` from the live taxonomy instead whenever one fits. `add` takes every ticket field `update`
  takes except `status`, `by`, and `ref`, which only describe an existing ticket, so `externalDeliverable`,
  `workingTreeDelivery`, `readonly`, and the verifier fields work at filing time. `unclassified` is `add`-only.
- **`by` on control-plane calls**: `rework`, `supersede_submission`, and `groomClose` default an omitted `by`
  to your session id. A subagent calling `rework` without `by` gets the owner label its own dispatch recorded, or
  a refusal naming the labels in conflict. `rework` still requires the candidate owner, so the default only
  passes when that is you; otherwise pass `by` as the submitter. Every other tool, `claim`, `done`, `release`,
  `submit`, `commit`, `checkpoint`, `scopeRequest`, `integrate`, and `next`, still needs an explicit `by`.
- **`rework` text over its cap**: `review` (1000 chars) and `reason` (4000 chars) are never refused for
  length. The full text is stored as a ticket comment attributed to `by`, and the field keeps a truncated
  summary ending in `[full text: comment <id>]`. Read the comment for the whole finding.
- **`groomClose`**: one tool, three purposes, each with a different gate. `deliveryCommit` closes it as a
  delivery and the commit must already be reachable from the integration target recorded when that ticket was
  prepared. A later board-target or checkout change does not retarget the ticket. `integration: true` closes
  it as an integration. Neither of those closes it as grooming. `reason` is required in all three.
- **`verdict` correction**: ordinary outcomes stay candidate-addressed: `accepted` approves the candidate, `rejected` confirms it must not ship, and `inconclusive` approves nothing. To correct a mistaken finalized accepted readonly bound review, the trusted main thread calls MCP `verdict` with `outcome: "rejected"`, nonempty `by`, `text`, and `correct.evidence`, optional `why`, and no `constraint`. `correct` supplies `expectedOutcome: "accepted"`, the original timestamp from `list({ref: reviewRef}).ticket.oracle.verdict.at`, `sourceRef`, and exactly one `commit` or `sourceRevision: {source, value}`. Both review and source must be unclaimed and terminal; the exact source submission must remain pending with a nonconflicting two-sided binding. The original verdict, completion, experiment log, and candidate identities stay intact; a correction audit/comment is appended and both binding halves become rejected. An exact substantive retry, including from a reloaded authorized main session, writes nothing. Different rationale/evidence, delivery, supersession, or binding drift refuses. A retained repair can then submit its full rejected-source range, but still needs its own independent review and delivery gates. `by` is audit provenance. Authority is the existing non-public MCP/store grant plus the host hook's main-thread caller class and actual runtime session identity, not cryptographic actor-origin proof. Subagents, ungranted store calls, CLI, and dashboard cannot mint this grant.
- **`supersede_submission`**: `supersededBy` is the repair ticket's ref, not a commit. A bound candidate stays locked until its review ticket has an oracle verdict. When the defect means the bound candidate must not ship, record `outcome=rejected`; `accepted` approves the candidate, and verdict text does not override the enum. After a fresh repair is reviewed and integrated, `supersede_submission` can close the rejected source submission.

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
