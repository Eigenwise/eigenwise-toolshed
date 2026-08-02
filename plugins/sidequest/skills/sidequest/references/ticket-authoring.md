# Ticket authoring

Declare scope by the surfaces a change reaches, not just the first file you found. For a cross-cutting change inside one plugin, declare its `src/lib`, `test`, and, where relevant, `hooks` directories. Use file-granular scope for surgical work where blast-radius control is the point.

## Sidequest category and config schema

A Sidequest category or config-schema change normally spans `src/lib/store.ts`, `src/lib/category-defaults.ts`, `src/lib/exec-names.ts`, `src/lib/agentsync.ts`, `src/lib/mcp.ts`, `src/bin`, `SKILL.md`, and their tests. Include `category-defaults.json`, `mcp-tool-descriptors.json`, and `cli-goldens.json` fixtures/goldens, plus generated `hooks/*.js` when the change reaches hooks.

Decide explicitly whether existing materialized profiles need a seed catch-up. Put that decision and the exact verify command in the ticket description.

## Carry paid recon into the ticket

For every touched surface, include a `file:line` anchor and the relevant excerpt from the authoring
recon. The executor starts where you left off, never cold. This removes orientation work, which is
31% of executor calls and costs about 60k cache-read tokens each.

## Review-gated acceptance

Before the first dispatch, give review-gated work adversarial acceptance criteria: name the exact
bypass classes the reviewer must probe, not a generic "review it" request. After two rework rounds,
re-spec the ticket with the failed contract, anchors, and acceptance criteria. Do not re-dispatch a
third time; that avoids the 21x rework tail observed in SQ-203.
