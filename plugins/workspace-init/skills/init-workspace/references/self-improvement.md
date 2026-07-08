# The self-improvement loop

Every workspace gets a baked-in self-improvement loop. It's the thing that makes the setup a
**starting point that keeps sharpening itself** instead of a static scaffold that goes stale. The
mechanism is deliberately simple: a global live rule (re-injected every prompt) plus the on-demand
`retro` skill for a deeper pass. No hook, no background process — it rides the live-rules mechanism
that's already installed.

## Install this rule into `.claude/live-rules.md`

Ship it on every workspace, global scope, `priority: 40`:

```markdown
---
description: Self-improvement — turn friction into a fix that sticks
priority: 40
---
After finishing a chunk of work, take a beat: did you hit friction? Signs — you fumbled the stack or
its tooling, re-derived something that should've been written down, tripped over a missing or unclear
convention, guessed wrong about where code lives, or repeated a workaround. If so, don't just move on:
make that friction cheaper or impossible next time by improving the workspace itself.
- Wrong/missing convention → add or refine a **live rule** (scope it tightly).
- Stale or missing project knowledge → update the **codebase map** (`.claude/.codebase-info/`).
- A repeatable multi-step task you did by hand → propose a **skill** (via skill-creator).
- A durable project fact or decision → into **CLAUDE.md** or a map doc.
Keep it small and incremental — one improvement, not a rewrite. Do it as its own step/commit. If
nothing was off, skip it silently; don't manufacture busywork. For a deeper periodic pass, run `retro`.
```

## Why a rule and not a hook

- A **hook** (like a `Stop` hook) fires deterministically but can't judge whether a turn was worth
  reflecting on — it either nags on everything or needs brittle path-matching to guess. A read-only Q&A
  turn shouldn't trigger a retro; a hairy debugging session should.
- A **live rule** leaves that judgment to Claude, where it belongs, and stays in front of the model on
  every prompt so it doesn't get forgotten mid-session. It also costs nothing to disable
  (`enabled: false`) or tune, like any other rule.
- Keeping it a rule also keeps workspace-init **hook-free and orchestrator-pure**: it installs content,
  not machinery.

## What "improving the workspace" actually means

Map each kind of friction to the cheapest durable fix:

| Friction you hit | The fix that makes it stick |
|------------------|-----------------------------|
| Kept correcting the same style/convention thing | A tightly-scoped **live rule** |
| Re-explored the same code / re-learned the layout | Update the **codebase map** doc for that area |
| Did the same multi-step chore by hand again | A **skill** (`skill-creator`) |
| A decision/fact you'll want to remember | A line in **CLAUDE.md** or the relevant map doc |
| The setup itself was missing something for this stack | Extend `init-workspace`'s reference catalog |

The last row is the loop eating its own tail: when the workspace setup didn't cover your stack well,
the improvement is to teach the catalog, so the next project of that kind starts better.

## The `retro` skill (deeper, on-demand)

The rule handles the lightweight, in-the-moment nudge. The `retro` skill is the periodic deep pass:
run it (or say "let's do a retro" / "reflect on this session") and it reviews the session for
**recurring** friction — patterns, not one-offs — and proposes a concrete batch of improvements across
rules, the map, `CLAUDE.md`, and skills, then applies the ones you approve. Point users at it in the
Phase 5 wrap-up.
