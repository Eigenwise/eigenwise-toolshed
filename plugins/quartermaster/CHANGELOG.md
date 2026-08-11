# Changelog

## 0.3.0 (2026-08-11)

Released in v3.444.0, up from 0.2.2.

### Features

- /quartermaster:retro becomes /quartermaster:resupply, and asks what would make the work easier (SQ-1815)
  **The command changed: `/quartermaster:retro` is now `/quartermaster:resupply`.** Your session tallies and decision ledger carry over untouched, including the timestamp of your last pass.

  The old skill was a friction hunt: count the denials, the corrections, the interrupts, the commands you kept retyping, then fix those. That misses the improvements that matter most, because the best ones leave no trace. When you need a measurement that doesn't exist yet, nothing errors, nothing gets denied, nobody corrects you, and you only do it once, so every "did this happen repeatedly" threshold skips right past it. Removing friction gets you back to the speed you already expected. Adding a capability moves that baseline.

  So the pass now starts from what you're actually trying to get done, then looks for what's missing against it, in value order: something you have no way to measure, work you keep doing by hand, knowledge you keep re-deriving, and only then the setup pushing back at you. Findings route to a new destination list that puts a measurement built as a committed skill at the top and permissions near the bottom, with a project-knowledge destination that didn't exist before.

  A goal phrased as a standard ("make it reliable", "make sure the output is correct") is the case this is really aimed at. You can't close one of those without a way to check it, so every fix underneath stays a guess and the same argument reopens a week later. That missing ruler is now the highest-value thing the skill can propose.

  Hence the name. A quartermaster keeps a unit supplied: `setup` outfits a new workspace, and `resupply` works out what an existing one is short of and gets it. "Retro" pointed backwards at what went wrong, which is exactly the frame this drops.

  The self-improvement live rule that quartermaster installs on every workspace got the same treatment, and both it and the skill now send new skills through skill-creator instead of suggesting it in passing. Hand-rolled skill files tend to encode the one example in front of you and end up too vague to trigger when you need them.

  Value order is where the pass *looks*, not the order it *proposes* in. A missing measurement leads only when the history actually attests it: a goal restated and never met, a check improvised dozens of times, one question answered two different ways. Read off a single session title plus a habit, it gets labelled as inference and ranks below the cheap fixes you can be sure about, and on a project holding no standard at all the honest answer is that there's nothing to build. That distinction came out of running the skill against three sandboxed histories: without it, a project shipping steadily against a working test suite got an invented measurement gap ranked first, above two well-evidenced fixes.

  Numbers quoted back at you are now the aggregate's numbers as it reports them, and nothing gets shown as a command that was run unless it was. The whole point of mining is that you don't have to take the pass on trust.

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
