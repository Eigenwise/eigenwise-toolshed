# quartermaster

Looks back at your Claude Code sessions and turns the friction into setup fixes: plugins worth
installing, rules worth writing, permissions worth allowing, plugins worth disabling. Every change
is proposed one at a time and applied only when you say yes. The next retro then tells you whether
the last round of changes actually reduced the friction it targeted.

It also outfits workspaces: the setup skill mines your history across all projects, interviews
you briefly, and installs and verifies the Toolshed core plus stack plugins for a new or existing
project, with every item approved individually.

## Install

Quartermaster spans every project, so install it once at user scope:

```text
/plugin marketplace add Eigenwise/eigenwise-toolshed
/plugin install quartermaster@eigenwise-toolshed --scope user
```

Then `/quartermaster:setup` in a project, or `/quartermaster:retro` after some real sessions.

## How it works

Two cheap hooks and two skills. The hooks never analyze content and never call a model.

- **SessionEnd hook**: streams the transcript that just ended and records a small tally per
  session (prompts, denials, interrupts, corrections, tool errors) under
  `~/.claude/quartermaster-state/`. Local file reads only.
- **SessionStart hook**: once enough unanalyzed sessions or friction events pile up, injects one
  line suggesting a retro. Cooldown of 72h between nudges; silent otherwise.
- **retro skill**: runs the miner (`bin/quartermaster.js mine`), which streams recent transcripts
  and emits a bounded JSON aggregate: friction counts with short quotes, per-plugin/skill/MCP
  attribution, top repeated commands, denial targets. The skill turns that into at most 7
  findings, each routed to a destination (plugin install, live-rule or CLAUDE.md rule, permission
  allowlist entry, disable, new skill) and each individually approved. Applied and rejected
  decisions land in a ledger; rejected recommendations are never surfaced again.
- **setup skill**: for new or freshly cloned projects. Mines all projects, reads the new project's
  stack, proposes a baseline. Same approval and ledger contract.

Plugin recommendations come from local data: the official catalog cache (with install counts) plus
every marketplace manifest already on the machine. No network calls from the scripts.

## Why the loop closes

Every applied recommendation records which friction signal it targets. `bin/quartermaster.js
verify` compares that signal per session before and after the decision, so the retro opens with a
track record ("the allowlist rule: denials went 2.1 to 0.3 per session") and proposes rolling back
what didn't work. Rejections are remembered so the same advice doesn't come back.

## CLI

```
node bin/quartermaster.js mine [--project <path>] [--days 30] [--sessions 40] [--all-projects]
node bin/quartermaster.js status [--project <path>]
node bin/quartermaster.js catalog [--query <terms>] [--installed]
node bin/quartermaster.js decisions list
node bin/quartermaster.js decisions add --title <t> --fingerprint <f> --status applied|rejected ...
node bin/quartermaster.js verify [--project <path>]
node bin/quartermaster.js mark-retro [--project <path>]
```

Everything prints JSON. Node stdlib only, no dependencies, cross-platform.

## Configuration

Environment variables, all optional:

| Variable | Default | Meaning |
| --- | --- | --- |
| `QUARTERMASTER_MIN_SESSIONS` | 8 | Unanalyzed sessions before a nudge |
| `QUARTERMASTER_MIN_FRICTION` | 12 | Friction events (denials + interrupts + corrections) before a nudge |
| `QUARTERMASTER_NUDGE_HOURS` | 72 | Cooldown between nudges, and after a retro |
| `QUARTERMASTER_STATE_DIR` | `~/.claude/quartermaster-state` | Where tallies and the decision ledger live |

## Privacy

Transcripts are read locally by a script and reduced to counts plus a handful of clipped quotes
(max 300 chars each). Raw transcripts are never loaded into model context; the retro skill is
explicitly forbidden from opening them. State files contain tallies and decisions, not
conversation content.
