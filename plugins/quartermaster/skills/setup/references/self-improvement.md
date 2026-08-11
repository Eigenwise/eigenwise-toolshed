# The self-improvement loop

Every workspace gets a baked-in self-improvement loop. It's what makes the setup a **starting point
that keeps sharpening itself** instead of a static scaffold that goes stale. The mechanism is
deliberately simple: a global live rule (re-injected every prompt) plus the on-demand `resupply` skill
for a deeper pass. No hook, no background process, it rides the live-rules mechanism that's already
installed.

The rule is written around one question: **what would have made this easier?** That is deliberately
not "what went wrong". Fixing what went wrong returns the workspace to the speed the user already
expected; adding a capability it never had moves that baseline. The highest-value improvements
almost never announce themselves as errors.

## Install this atomic rule

Ship it on every workspace as `.claude/live-rules/rules/self-improvement.md`, global scope,
`priority: 40`. Include its path, SHA-256 hash, and frontmatter metadata in
`.claude/live-rules/manifest.json` as described in `rule-templates.md`:

```markdown
---
description: Self-improvement: build the capability that makes the next goal cheaper
priority: 40
---
When you finish a chunk of work, ask what would have made it easier, and build that. The question
is not "did anything go wrong", it's "what was missing here that I needed".
- **A claim you couldn't check** (is it correct? fast enough? complete?) is the most expensive gap
  of all: with no way to measure it, every fix underneath is a guess and the same argument reopens
  a week later. Build the measurement first, as a skill with its scripts committed in the repo, so
  the number can be re-run instead of re-argued.
- **A multi-step task you did by hand** becomes a skill (build it with skill-creator).
- **Something you re-derived or re-explored** becomes a codebase map doc or a CLAUDE.md line.
- **A convention you had to be told** becomes a tightly-scoped live rule.
- **A tool that would have done this for you**: check what's already installed, then propose one.
Look at what exists before building; a lot of what feels missing is installed under a name you
didn't think of. Keep it to one improvement, as its own step and commit. If the work genuinely
needed nothing new, skip silently. For a deeper periodic pass, run `resupply`.
```

## Why a rule and not a hook

- A **hook** (like a `Stop` hook) fires deterministically but can't judge whether a turn was worth
  reflecting on: it either nags on everything or needs brittle path-matching to guess. A read-only
  Q&A turn shouldn't trigger a pass; a hairy debugging session should.
- A **live rule** leaves that judgment to Claude, where it belongs, and stays in front of the model
  on every prompt so it doesn't get forgotten mid-session. It also costs nothing to disable
  (`enabled: false`) or tune, like any other rule.
- Keeping it a rule also keeps the quartermaster setup skill **hook-free and orchestrator-pure**: it
  installs content, not machinery.

## What "improving the workspace" actually means

Map what was missing to the cheapest durable fix. The rows are in value order, which is roughly the
inverse of how loudly each one complains:

| What was missing | The fix that makes it stick |
|------------------|-----------------------------|
| A way to tell whether a quality goal is met | A **measurement built as a skill**, scripts committed |
| A capability, for work done by hand | A **plugin** if one exists, else a **skill** (skill-creator) |
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
run it (or say "what would make this easier" / "what are we missing") and it names the user's current
goal, mines recent sessions for what's missing against that goal, and proposes a batch of
improvements across skills, plugins, the map, `CLAUDE.md`, and rules, applying the ones the user
approves. Point users at it in the Phase 5 wrap-up.
