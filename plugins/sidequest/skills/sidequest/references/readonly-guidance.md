# Read-only review and audit guidance

Sidequest routes reviews, repository audits, and shortcut-debt reports through the existing readonly `review-audit` category. They report findings only. They never edit the repository, create a ledger, run a migration, or start a sweep.

These reports need Sidequest installed in the host. When it is unavailable, say the routed report capability is unavailable rather than pretending to have board integration.

## Candidate diff review

Use this only for a submitted candidate that needs independent scrutiny. Create a readonly `review-audit` ticket with an immutable `reviewTarget`: the submitted ticket ref and its exact submitted commit (or source revision for a non-Git artifact). Never review a working tree, a live claim, or a retargeted candidate. The isolated reviewer reports evidence and closes through the bound-review flow.

## Repository audit

Create a readonly `review-audit` ticket with a named scope such as `plugins/sidequest/` or `src/billing/`. Ask for concrete, source-backed findings: code to delete, existing local reuse, standard-library or native-platform replacements, speculative behavior to remove, and smaller direct shapes. Each finding names its file and line, why the current code costs something, and the smallest safe change. No automatic edits.

## Shortcut debt

Create a readonly `review-audit` ticket with the source directories to inspect. Scan actual source comments for `whittle:` markers. Report each deliberate shortcut with its file and line, known ceiling, observable upgrade trigger, and replacement. A missing ceiling or trigger is itself a finding. Do not invent either one, require a marker for every simplification, or move results into a ledger.

## Measurement

Use Observability for absolute measurements. Call a gain unmeasured unless a matched baseline supports the comparison. Absolute metrics do not establish causal gain. Do not reuse static headline figures or private workflow data as report evidence.
