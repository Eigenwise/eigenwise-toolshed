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

Three cheap hooks and two skills. The hooks never call a model.

- **SessionStart auto-allowlist hook**: opt-in only. Once the project enables it, the hook streams the bounded recent-transcript window and appends project-local `permissions.allow` entries for a tool fingerprint approved at least three times with no user rejection. Bash rules use the normalized command prefix. Destructive commands are reported but never added. Every addition is logged to the decision ledger and printed. Enable it with `node "${CLAUDE_PLUGIN_ROOT}/bin/quartermaster.js" enable-auto-allowlist --project "${CLAUDE_PROJECT_DIR}"`; it writes only `.claude/settings.local.json`. Before that marker exists, both the hook and the `allowlist` command only report what they would add.
- **SessionEnd hook**: streams the transcript that just ended and records a small tally per
  session (prompts, denials, interrupts, corrections, tool errors) under
  `~/.claude/quartermaster-state/`. Local file reads only.
- **SessionStart hook**: injects the capability-capture charter, one short paragraph asking Claude
  to notice mid-session when the thing it is doing for the third time should become a skill, a
  codebase-map entry, a rule, or a committed measurement, and to offer capturing it right then.
  Skipped in projects where setup already seeded the stronger self-improvement live rule, which is
  re-grounded at session start and returns on a later prompt or edit only when its text changes. Once enough unreviewed sessions or friction events pile up, the same hook proactively asks
  whether you want a focused optimization round for your development system, setup, tooling, or
  workflow; cooldown of 24h between offers. It runs the pass after you say yes, or automatically when
  you have explicitly given standing permission for optimization rounds.
- **resupply skill**: after the user accepts the optimization round, runs the miner (`bin/quartermaster.js mine`), which streams recent transcripts
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
node bin/quartermaster.js allowlist [--project <path>] [--days 30] [--sessions 40]
node bin/quartermaster.js enable-auto-allowlist [--project <path>]
```

Everything prints JSON. Node stdlib only, no dependencies, cross-platform.

## Configuration

Environment variables, all optional:

| Variable | Default | Meaning |
| --- | --- | --- |
| `QUARTERMASTER_MIN_SESSIONS` | 4 | Unreviewed sessions before a nudge |
| `QUARTERMASTER_MIN_FRICTION` | 6 | Friction events (denials + interrupts + corrections) before a nudge |
| `QUARTERMASTER_NUDGE_HOURS` | 24 | Cooldown between nudges, and after a resupply pass |
| `QUARTERMASTER_STATE_DIR` | `~/.claude/quartermaster-state` | Where tallies and the decision ledger live |

## Privacy

Transcripts are read locally by a script and reduced to counts plus a handful of clipped quotes
(max 300 chars each). Raw transcripts are never loaded into model context; the resupply skill is
explicitly forbidden from opening them. State files contain tallies and decisions, not
conversation content.
