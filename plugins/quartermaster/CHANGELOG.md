# Changelog

## 0.2.2 (2026-08-10)

Released in v3.441.0, up from 0.2.1.

### Fixes

- Retire Codegraph (SQ-1812)
  Codegraph is gone: the plugin, its marketplace entry, its docs page, and its MCP server. It never earned its keep next to the tools already in the shed. Grep, LSP, and Codebase Mapper cover the same ground without a pinned Pyright, a pinned TypeScript, a SQLite graph, and a 16-second query.

  Nothing else depended on it. Quartermaster's setup skill no longer has to explain why not to recommend it.

  If you have it installed, remove it in `/plugin` and delete `~/.claude/codegraph` (the graph snapshots and the pinned runtimes, which run to a gigabyte or so). Nothing else on disk is left behind.

## 0.2.1 (2026-08-10)

Released in v3.438.0, up from 0.2.0.

### Fixes

- Quartermaster setup explains what each Toolshed plugin is (SQ-1798)
  The setup skill now describes what each Toolshed plugin does before the reason to install it, so Claude can explain a proposal instead of only naming it. It also says plainly that every piece is independent and opt-in, and that Sidequest is the routing and executor system rather than a ticket tracker.

## 0.2.0 (2026-08-10)

Released in v3.437.0, up from 0.1.0.

### Features

- Add quartermaster; retire playbook and init-workspace (QM-1)
  quartermaster joins the shed: transcript-mining retros with a decision ledger and outcome verification, plus a history-grounded workspace setup skill that replaces workbench's init-workspace. playbook is retired; its verify-discipline skill moves into sidequest (executor skill pin updated to sidequest:verify-discipline).

## 0.1.0

Initial release.

- `mine`: streamed signal extraction from recent transcripts (friction, attribution, habits),
  bounded output, subagent transcripts included.
- `retro` skill: findings routed to plugin installs, rules, permission allowlist entries,
  disables, or new skills; per-item approval; decision ledger with rejection memory.
- `setup` skill: workspace setup for new or existing projects, grounded in cross-project
  history; installs and verifies the Toolshed core and stack plugins around the reload boundary.
  Replaces workbench's `init-workspace` and inherits its reference catalog.
- `verify`: before/after per-session comparison of the signal each applied decision targeted.
- SessionEnd tally hook and threshold-gated SessionStart nudge (72h cooldown, no analysis).
