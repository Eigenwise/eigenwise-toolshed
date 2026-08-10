# Changelog

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
