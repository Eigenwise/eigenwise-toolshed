# Ticket authoring

Declare scope by the surfaces a change reaches, not just the first file you found. For a cross-cutting change inside one plugin, declare its `src/lib`, `test`, and, where relevant, `hooks` directories. Use file-granular scope for surgical work where blast-radius control is the point.

## Sidequest category and config schema

A Sidequest category or config-schema change normally spans `src/lib/store.ts`, `src/lib/category-defaults.ts`, `src/lib/exec-names.ts`, `src/lib/agentsync.ts`, `src/lib/mcp.ts`, `src/bin`, `SKILL.md`, and their tests. Include `category-defaults.json`, `mcp-tool-descriptors.json`, and `cli-goldens.json` fixtures/goldens, plus generated `hooks/*.js` when the change reaches hooks.

Decide explicitly whether existing materialized profiles need a seed catch-up. Put that decision and the exact verify command in the ticket description.

## Describe implementation work

Descriptions are developer-to-developer specs, never PM summaries. Include anchors, behavior and edge cases, bounds, dependencies or decisions, and a runnable `cd <repo-relative-dir> && ...` verify command. Bugs include a reproduction. Front-load evidence for cheaper executors. Route by remaining uncertainty, not original difficulty: a settled one-or-two-file edit is `coding.easy`; use direct only for the INLINE-SAFE allowlist, with its recorded reason.

## Establish the premise and acceptance behavior

A quantitative or behavioral claim that a fix depends on needs evidence before it becomes a ticket premise. Include the measurement command, its output, and where it ran, or link the read-only measurement ticket that established the numbers. When the claim has not been measured, file measurement work first and create the fix ticket from that result.

State the behavior that must keep working, the regression input or consumer that would expose a break, and what a useful failure should identify. The verification oracle must observe that property on produced output. Greps for class names, function names, route names, or other implementation identifiers are diagnostics only because another implementation can reproduce the same broken behavior. Add or update only the coverage needed to prove that behavior; use as many assertions as the contract requires.

For overlapping wave changes, treat source anchors as baseline hints. Write acceptance against the assembled behavior and rerun that property oracle after the terminal wave is assembled, before publish.

## Carry paid recon into the ticket

For every touched surface, include a `file:line` anchor and the relevant excerpt from the authoring
recon. The executor starts where you left off, never cold. This removes orientation work, which is
31% of executor calls and costs about 60k cache-read tokens each.

## Review-gated acceptance

Before the first dispatch, give review-gated work adversarial acceptance criteria: name the exact
bypass classes the reviewer must probe, not a generic "review it" request. After two rework rounds,
re-spec the ticket with the failed contract, anchors, and acceptance criteria. Do not re-dispatch a
third time; that avoids the 21x rework tail observed in SQ-203.
