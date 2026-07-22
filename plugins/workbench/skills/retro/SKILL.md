---
name: retro
description: >-
  Review this session's recurring friction and apply workspace improvements. Use for a retrospective,
  reflection, session review, or workspace improvement.
---

# Retro

A structured reflection pass on the session so far. The point is not to write a diary — it's to find
the **recurring** friction and convert it into durable improvements to the workspace, so the next
session (yours or a teammate's) starts smoother. This is the deep counterpart to the always-on
self-improvement live rule: that rule nudges small in-the-moment fixes; `retro` does the periodic
batch pass.

## Process

### Step 1 — Review the session for friction

Look back over what actually happened this session and list the friction points — concretely, with
evidence. Signs to look for:

- **Repeated corrections** — the same style/convention thing you got told to fix more than once.
- **Re-derivation** — you re-explored the same code, re-learned the layout, or re-checked the same
  API you could've had written down.
- **Missing or wrong convention** — a rule that should exist didn't, or one that exists was unclear or
  wrong.
- **Guessed wrong** — about where code lives, how a tool works, or what the user wanted, and it cost a
  round trip.
- **Manual chores** — a multi-step task you did by hand that you'll clearly do again.
- **Setup gaps** — something the workspace should have had for this stack but didn't.

Focus on **patterns, not one-offs.** A single typo isn't a retro item; a thing that bit you three
times is. If the session was smooth, say so plainly and stop — don't manufacture findings.

### Step 2 — Map each friction to the cheapest durable fix

For every real pattern, pick where the fix belongs:

| Friction | Durable fix | Tool |
|----------|-------------|------|
| Repeated convention correction | a tightly-scoped **live rule** | `add-rule`, or edit `.claude/live-rules.md` |
| Re-explored the same area | update the **codebase map** doc | `update-codebase-map`, or edit `.claude/.codebase-info/` |
| Did a multi-step chore by hand | a **skill** | `skill-creator` |
| A durable fact or decision | a line in **CLAUDE.md** or a map doc | direct edit |
| The setup missed something for this stack | extend init-workspace's **reference catalog** | edit the catalog |

Prefer the smallest fix that makes the friction not recur. A live rule beats a skill beats a whole new
process — reach for the heavier fix only when the lighter one can't hold the lesson.

### Step 3 — Propose, then apply what's approved

- **Show the user the list first**: each friction, the proposed fix, and where it lands. Keep it tight
  — a few high-value items beat a long wish-list.
- Let the user approve, drop, or adjust. Don't apply a pile of workspace changes unannounced.
- **Apply the approved ones**, each as its own small step (and its own commit if the user commits as
  you go). Use the owning tool: `add-rule` / edit `live-rules.md` for rules, `update-codebase-map` for
  the map, `skill-creator` for a new skill, a direct edit for `CLAUDE.md`.
- **Verify** the change took: a new rule should parse and be scoped to files that exist; a new skill
  should have a triggering description; a map edit should be accurate.

### Step 4 — Close out

Tell the user what changed and where, and that rule/map edits take effect on the next prompt (no
restart). If a fix was to extend the init-workspace catalog, note that future projects of this kind
now start better — that's the loop paying off.

## Guidelines

- **Patterns over one-offs.** The bar is "this will happen again," not "this happened once."
- **Smallest durable fix.** Don't build a skill for something a one-line rule prevents.
- **Approve before applying.** Workspace changes are shared; the user gets a say.
- **Honest empties.** A smooth session produces no findings, and saying so is the correct output.
- **One step at a time.** Each improvement is its own change, so any of them is easy to undo.

## Success criteria

- [ ] Session reviewed; friction listed concretely (or a clean "nothing recurring" verdict)
- [ ] Each real pattern mapped to the cheapest durable fix and its location
- [ ] Proposals shown to the user before applying
- [ ] Approved fixes applied via the owning tool and verified
- [ ] User told what changed and that rule/map edits apply next prompt
