# The self-improvement loop

Every workspace gets a baked-in self-improvement loop. It's a starting point that keeps sharpening
itself instead of a static scaffold that goes stale. The mechanism is deliberately simple: a global
live rule plus the on-demand `resupply` skill. It uses the existing live-rules mechanism, with no
new hook or background process.

The rule is written around one question: **what would have made this easier?** Fixing what went
wrong returns the workspace to the speed the user already expected; adding a capability it never had
moves that baseline. The highest-value improvements almost never announce themselves as errors, so a
rule that asked about errors would miss them.

## Install this atomic rule

Ship it on every workspace as `.claude/live-rules/rules/self-improvement.md`, global scope,
`priority: 40`. Include its path, SHA-256 hash, and frontmatter metadata in
`.claude/live-rules/manifest.json` as described in `rule-templates.md`:

```markdown
---
description: Self-improvement: build the capability that makes the next goal cheaper
priority: 40
---
At a natural pause, assess whether a concrete weakness earns an improvement. Keep what works; do not
change the workspace for novelty. The orchestrator decides the benefit, approach, and boundaries before
implementation. Focused research may return facts or bounded alternatives when an unknown could change that
decision; do not investigate unrequested optimizations by default. First check whether the
existing project, standard library, native platform, installed plugins, skills, rules, or instruments
already cover it. Improve the installed capability before proposing a parallel one. Offer
`/quartermaster:resupply` only with current or standing user approval; every recommended change still
needs its own approval unless that exact class is covered by standing permission.
- **A claim you couldn't check** (is it correct? fast enough? complete?) may need a measurement.
  First check whether an existing instrument can answer it or can be improved. Build a new measurement
  only when it is the smallest durable missing capability.
- **A multi-step task you did by hand** may belong in a skill (build it with skill-creator).
- **Something you re-derived or re-explored** may belong in a codebase map doc or a CLAUDE.md line.
- **A convention you had to be told** may belong in a tightly-scoped live rule.
Keep it to one evidenced improvement. If existing capabilities hold up, say so explicitly.
```

## The fallback when this rule is absent

Quartermaster's own SessionStart hook injects a condensed version of this charter once per session
in any project that does not have this rule file at
`.claude/live-rules/rules/self-improvement.md`. Seeding the rule supersedes the hook line: the
hook checks for that exact path and stays silent when it exists. The seeded rule follows the project's
live-rules matching and deduplication behavior.

## Why a rule and not a hook

- A **hook** (like a `Stop` hook) fires deterministically but can't judge whether a turn was worth
  reflecting on: it either nags on everything or needs brittle path-matching to guess. A read-only
  Q&A turn shouldn't trigger a pass; a hairy debugging session should.
- A **live rule** leaves that judgment to Claude, where it belongs, and is re-injected when its scope
  newly matches or its content changes. It also costs nothing to disable (`enabled: false`) or tune,
  like any other rule.
- Keeping it a rule also keeps the quartermaster setup skill **hook-free and orchestrator-pure**: it
  installs content, not machinery.

## What "improving the workspace" actually means

Map what was missing to the cheapest durable fix. The rows are in value order, which is roughly the
inverse of how loudly each one complains:

| What was missing | The fix that makes it stick |
|------------------|-----------------------------|
| A way to tell whether a quality goal is met | An existing **measurement** improved when needed, else a small re-runnable skill |
| A capability, for work done by hand | Reuse an existing **plugin** or skill, else propose the smallest fit |
| Project knowledge, re-derived again | The **codebase map** doc for that area, or **CLAUDE.md** |
| A convention nobody wrote down | A tightly-scoped **live rule** |
| Coverage in the setup itself, for this stack | Extend the quartermaster setup skill's reference catalog |

Two rows deserve the extra note:

**The measurement row is first because it is the one nothing else can find.** Building an instrument
produces no errors, no denials, and no corrections, and it happens exactly once, so anything that
watches for repeated pain will miss it every time. Meanwhile a goal phrased as a standard ("make it
reliable", "make sure it's correct") cannot be closed without one: the work under it stays a matter
of opinion, and the same ground gets re-argued in later sessions because nothing ever settled it.

**The last row is the loop eating its own tail:** when the workspace setup didn't cover this stack
well, the improvement is to teach the catalog, so the next project of that kind starts better.

## The `resupply` skill (deeper, on-demand)

The rule handles the lightweight, in-the-moment case. The `resupply` skill is the periodic deep pass:
offer it at a natural pause when evidence supports it, then run it only after current or standing user
approval. It reads recent sessions for what the user was working toward, taken from each session's own
title, its opening ask, and any explicit `/goal`, then ranks missing capabilities against that and
proposes changes across skills, plugins, the map, `CLAUDE.md`, and rules for approval. Point users at
it in the Phase 5 wrap-up.
