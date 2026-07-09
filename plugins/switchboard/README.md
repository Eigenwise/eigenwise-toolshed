# switchboard

**Complexity-scored model and effort routing for Claude Code.** Score a task 1-10 and switchboard
works out which model tier should run it and how hard it should think, then hands the work to a
**named executor subagent** at exactly that tier. You never pick a model by hand: the score is the
only knob you turn, and the ladder does the rest.

## Install

```text
/plugin marketplace add Eigenwise/eigenwise-toolshed
/plugin install switchboard@eigenwise-toolshed
```

Then run `/reload-plugins` (or restart Claude Code). No dependencies, no build step: it's Node
stdlib only (Claude Code already ships Node), cross-platform.

## How the ladder works

Routing isn't per-tier bands, it's one merged, capability-ranked ladder of model×effort rungs.
Tiers overlap and cross over: `sonnet·xhigh` can outrank `opus·medium`, because a cheaper model
thinking harder often beats a pricier one thinking less. Rungs are ordered by measured capability,
wherever that lands them — sometimes a pricier tier's low rung sits below a cheaper tier's top one.

Complexity 1 through 10 maps onto that rung sequence, so neighboring scores can land on the same
rung. `max` effort sits outside the normal spread on purpose: only complexity 10 gets it (and 9,
only at the most generous bias setting), the same spirit as Anthropic's own guidance to use max
sparingly, for the genuinely hardest work only.

A **bias dial** (`-5` frugal ... `0` neutral ... `+5` generous) tunes how eagerly a score climbs the
ladder, gamma-curving the score-to-rung mapping. The two ends stay fixed at any bias: complexity 1
always gets the cheapest rung, complexity 10 always gets the top one.

Each model also carries a **per-effort allowlist**: turn off `opus·medium` and leave `sonnet·medium`
on, and that rung just drops out of opus's row. Two guards keep the ladder always usable: at least
one tier stays enabled, and every enabled tier keeps at least one effort on.

## CLI reference

```
$ node plugins/switchboard/bin/switchboard.js models

Routing: on
Bias: 0  (neutral — see "switchboard bias")
Model tiers:
  ✓ opus
  ✓ sonnet
  ✓ haiku
  ✓ fable
Effort levels (per model):
  ✓ opus      low, medium, high, xhigh, max
  ✓ sonnet    low, medium, high, xhigh, max
  · haiku     (no effort axis — haiku ignores effort)
  ✓ fable     low, medium, high, xhigh, max
Complexity ladder (score → derived routing):
  C1   haiku
  C2   sonnet·low
  C3   sonnet·medium
  C4   opus·low
  C5   sonnet·xhigh
  C6   opus·high
  C7   opus·xhigh
  C8   fable·medium
  C9   fable·high
  C10  fable·max
```

The full command set:

```bash
node plugins/switchboard/bin/switchboard.js models [--json]              # routing state, tiers, per-model efforts, live ladder
node plugins/switchboard/bin/switchboard.js bias [<int>] [--json]        # read (no arg) or set (-5..5) the bias dial
node plugins/switchboard/bin/switchboard.js route <complexity> [--json] # derive one score's model/effort, e.g. route 6
node plugins/switchboard/bin/switchboard.js enable <target...>          # turn on a tier (haiku) or a model.effort pair (opus.medium)
node plugins/switchboard/bin/switchboard.js disable <target...>         # turn one off, same target shape
node plugins/switchboard/bin/switchboard.js routing on|off              # master switch, off means switchboard scores nothing
```

Prefs live under `SWITCHBOARD_HOME` (default `~/.claude/switchboard/prefs.json`).

## The exec agents and how the skill spawns them

Five bundled agents, `switchboard-exec-low` through `switchboard-exec-max`, cover the five effort
rungs. Effort is pinned in each agent's own frontmatter (`effort: high`, and so on), since reasoning
effort can only be fixed that way; model is a spawn-time argument instead, so the two compose at
spawn time. All five are generated from one template, `scripts/_exec-template.md`. Run
`scripts/gen-exec-agents.js` to regenerate them after an edit, rather than hand-editing five near-copies.

The bundled `switchboard` skill is what actually drives this. Before spawning, it states the
complexity score and a one-line motivation, calls `switchboard route <score>` to get the derived
model and effort, then spawns `subagent_type: switchboard-exec-<effort>` with `model: <tier>` and a
unique `name:`. A haiku-derived task has no effort axis, so it spawns a plain named agent with
`model: haiku` instead. Independent work at complexity 6+ fans out as several named executors in one
message rather than running serially, and the skill proposes (never launches unasked) a workflow for
the largest, most repeatable fan-outs.

## Relation to sidequest

sidequest is this same routing engine plus a ticket board on top; switchboard is the routing alone,
for anyone who wants the ladder without a board. The engine is shared **by copy**, not by dependency:
each plugin carries its own `lib/ladder.js` and its own tests, and each plugin's tests are the source
of truth for changes to its copy.

## License

MIT (c) Eigenwise
