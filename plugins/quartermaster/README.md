# quartermaster

Looks at your recent Claude Code sessions and asks what would make your goals easier to reach:
a measurement nobody can run yet, work you keep doing by hand, knowledge you keep re-deriving,
permissions worth allowing, plugins worth installing or disabling. Every change is proposed one at
a time and applied only when you say yes. The next pass then tells you whether the last round
actually helped.

Friction is in there, at the bottom of the list. Fixing what went wrong gets you back to the speed
you already expected; adding a capability you never had moves that baseline, and the best
capabilities leave no friction trace at all.

It also outfits workspaces: the setup skill mines your history across all projects, interviews
you briefly, and installs and verifies the Toolshed core plus stack plugins for a new or existing
project, with every item approved individually.

## Install

Quartermaster spans every project, so install it once at user scope:

```text
/plugin marketplace add Eigenwise/eigenwise-toolshed
/plugin install quartermaster@eigenwise-toolshed --scope user
```

Then `/quartermaster:setup` in a project, or `/quartermaster:resupply` after some real sessions.

## How it works

Two cheap hooks and two skills. The hooks never analyze content and never call a model.

- **SessionEnd hook**: streams the transcript that just ended and records a small tally per
  session (prompts, denials, interrupts, corrections, tool errors) under
  `~/.claude/quartermaster-state/`. Local file reads only.
- **SessionStart hook**: once enough unreviewed sessions or friction events pile up, injects one
  line suggesting a resupply pass. Cooldown of 72h between nudges; silent otherwise.
- **resupply skill**: runs the miner (`bin/quartermaster.js mine`), which streams recent transcripts
  and emits a bounded JSON aggregate. Each session carries **what it was for**: its own title, its
  first real prompt, any explicit `/goal` and whether that goal was ever met, plus a `humanDriven`
  flag so hook-spawned sessions can't pass as your work. Alongside that: the areas of the tree the
  work landed in, per-session cost, top repeated commands, attribution, fetch domains, and friction
  counts with short quotes. The skill looks for what's missing against that purpose (something
  unmeasurable, then manual work, then re-derived knowledge, then friction), and leads with whatever
  the history actually attests rather than with whatever it found first: at most 7 findings, each
  routed to a destination (a measurement built as a skill, plugin install, workflow skill, map
  or CLAUDE.md knowledge, rule, permission allowlist entry, disable) and each individually approved.
  Applied and rejected decisions land in a ledger; rejected recommendations are never surfaced again.
- **setup skill**: for new or freshly cloned projects. Mines all projects, reads the new project's
  stack, proposes a baseline. Same approval and ledger contract.

Plugin recommendations come from local data: the official catalog cache (with install counts) plus
every marketplace manifest already on the machine. No network calls from the scripts.

## Why the loop closes

Every applied recommendation records what it targets. `bin/quartermaster.js verify` compares that
signal per session before and after the decision, so each pass opens with a track record ("the
allowlist rule: denials went 2.1 to 0.3 per session") and proposes rolling back what didn't work.
For a capability no counter tracks, the check is whether the new skill or plugin shows up in
attribution at all. Rejections are remembered so the same advice doesn't come back.

## CLI

```
node bin/quartermaster.js mine [--project <path>] [--days 30] [--sessions 40] [--all-projects]
node bin/quartermaster.js status [--project <path>]
node bin/quartermaster.js catalog [--query <terms>] [--installed]
node bin/quartermaster.js decisions list
node bin/quartermaster.js decisions add --title <t> --fingerprint <f> --status applied|rejected ...
node bin/quartermaster.js verify [--project <path>]
node bin/quartermaster.js mark-resupply [--project <path>]
```

Everything prints JSON. Node stdlib only, no dependencies, cross-platform.

## Configuration

Environment variables, all optional:

| Variable | Default | Meaning |
| --- | --- | --- |
| `QUARTERMASTER_MIN_SESSIONS` | 8 | Unreviewed sessions before a nudge |
| `QUARTERMASTER_MIN_FRICTION` | 12 | Friction events (denials + interrupts + corrections) before a nudge |
| `QUARTERMASTER_NUDGE_HOURS` | 72 | Cooldown between nudges, and after a resupply pass |
| `QUARTERMASTER_STATE_DIR` | `~/.claude/quartermaster-state` | Where tallies and the decision ledger live |

## Privacy

Transcripts are read locally by a script and reduced to counts plus a handful of clipped quotes
(max 300 chars each). Raw transcripts are never loaded into model context; the resupply skill is
explicitly forbidden from opening them. State files contain tallies and decisions, not
conversation content.
