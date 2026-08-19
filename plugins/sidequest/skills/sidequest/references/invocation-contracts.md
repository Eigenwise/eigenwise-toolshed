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
  any other shape is refused.
- **`submit` command verification**: run the dispatched `verify-capture` wrapper after the final candidate commit. It records a completed capture bound to the ticket, exact declared command, and candidate revision. `verify` still has to equal the declared command, but that string is only a reference to the capture, never proof that it ran. A stale or missing capture is retryable: rerun the exact declared command through the wrapper and submit again. `manual` and `attestation` stay evidence-based.
- **`integrate` verification waiver**: `skipVerify: true` also requires `verificationWaiver` with `authority`,
  `reason`, `affectedGate`, and either a bounded `scope` or future `expiresAt`. Sidequest validates and stores
  the waiver Diagnostic with the integration result; a bare `skipVerify` is refused.
- **`add`**: `complexity` is the legacy ambiguity fallback and requires `why` alongside it. Stamp
  `category` from the live taxonomy instead whenever one fits.
- **`groomClose`**: one tool, three purposes, each with a different gate. `deliveryCommit` closes it as a
  delivery and the commit must already be reachable from the integration branch. `integration: true` closes
  it as an integration. Neither of those closes it as grooming. `reason` is required in all three.
- **`supersede_submission`**: `supersededBy` is the repair ticket's ref, not a commit. A bound candidate stays locked until its review ticket has an oracle verdict. When that verdict accepts the recorded defect conclusion, Sidequest marks the candidate rejected on both binding halves; after a fresh repair integrates, `supersede_submission` can close the rejected source submission.

## Synonyms the validator accepts

Pass either name, never both: passing both is refused before anything is written. When a synonym is used
the response carries `acceptedAliases` naming the substitution.

- `comment`: `message` or `m` for `body`
- `link`: `ref` for `from`, `type` for `verb`, `target` for `to`
- `story_log`: `append` for `entry`
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
