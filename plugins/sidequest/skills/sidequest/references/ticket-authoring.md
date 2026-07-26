# Ticket authoring

Declare scope by the surfaces a change reaches, not just the first file you found. For a cross-cutting change inside one plugin, declare its `src/lib`, `test`, and, where relevant, `hooks` directories. Use file-granular scope for surgical work where blast-radius control is the point.

## Sidequest category and config schema

A Sidequest category or config-schema change normally spans `src/lib/store.ts`, `src/lib/category-defaults.ts`, `src/lib/exec-names.ts`, `src/lib/agentsync.ts`, `src/lib/mcp.ts`, `src/bin`, `SKILL.md`, and their tests. Include `category-defaults.json`, `mcp-tool-descriptors.json`, and `cli-goldens.json` fixtures/goldens, plus generated `hooks/*.js` when the change reaches hooks.

Decide explicitly whether existing materialized profiles need a seed catch-up. Put that decision and the exact verify command in the ticket description.
