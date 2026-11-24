---
name: resupply
description: Run a Quartermaster improvement round. Use when asked what would make this work easier, after an accepted Quartermaster offer, or for one named candidate.
argument-hint: "[candidate fingerprint]"
---

# Resupply

Find what this workspace is short of and draft at most three proposals for it. Proposals go to the `/qm` inbox. Nothing is applied here: the human approves in `/qm` and the `apply` skill makes the change.

If an argument was given, it is one candidate fingerprint. Work on that candidate only.

## 1. Read the evidence

Call `mcp__quartermaster__evidence`. It returns the candidates (each a fingerprint and a sentence such as "ran `npm run build:x` by hand 14 times in 6 sessions"), the skills exercised and the top failures. Rejected candidates are already left out. Then `mcp__quartermaster__proposal` with `operation: list` shows what is already proposed.

If the evidence tool is missing, the mod is not loaded. Say so in one line, then fall back to hindsight: `node "${CLAUDE_PLUGIN_ROOT}/scripts/mine.mjs" "${CLAUDE_PROJECT_DIR}"`, plus `.claude/quartermaster/proposals/` and `.claude/quartermaster/rejected.md` read directly.

Drop every candidate that already has a proposal, and anything in `rejected.md`. A rejection is the human's no and is never proposed again.

## 2. Look for what should already cover it

For each remaining candidate, before inventing anything new, search for an existing skill, rule, script or plugin that should have handled it: the project's `.claude/skills/`, `.claude/rules/`, `CLAUDE.md`, `package.json` scripts or `Makefile`, the installed plugins, and earlier changes in `.claude/quartermaster/changes/`.

When one exists, the proposal improves it: a sharper skill description, a rule with the right `paths:`, a script that takes the missing flag. A capability that exists but never fires is the problem to fix, and a second one beside it makes things worse.

When something added earlier was never exercised, the right proposal may be to retire it (kind `retire`).

## 3. Order by capability, then friction

1. **Work done by hand that a script or skill should own.** The same command sequence typed every session, the same area explored from scratch, a check the human runs by eye. These come first: a new capability moves the baseline, removing friction only gets back to it.
2. **Missing measurement.** Something the human cares about that nothing can count yet.
3. **Friction.** Repeated permission denials, a tool that keeps failing, a hook that keeps timing out.

When the friction traces to a shipped plugin, the proposal is kind `upstream` and its body points at `/quartermaster:report`.

## 4. Draft at most three

Create each with `mcp__quartermaster__proposal`, `operation: create`:

- `kind`: `skill`, `skill-improvement`, `rule`, `permission`, `setting`, `plugin`, `routing`, `script`, `retire`, `upstream` or `docs`
- `target`: the one file, setting, plugin or command it changes, on one line
- `evidence`: the candidate fingerprints behind it
- `expect`: a countable check on one line, such as "`npm run build:x` typed by hand per 5 sessions" or "`release-notes` skill invocations in the next 5 sessions"
- `baseline`: that count today, a number
- `body`: what, why, the exact diff or command, and the one-step rollback

A permission proposal follows the veto list in the `outfit` skill. Never propose a broad rule.

The tool refuses a proposal the human already rejected. Take that as final.

Without the tool, write `.claude/quartermaster/proposals/P-<4 digits>.md` with that frontmatter plus `id`, `status: draft`, `authority: ask` and `created`, and the body below it.

This skill never writes to the project or the human's setup. Drafting is all it does.

## 5. Say what happened

A few lines: what you looked at, each proposal by id and title with its evidence, and that `/qm` shows them with Approve, Reject and Later.

Proposing nothing is a valid outcome. When nothing is worth the human's time, say so plainly ("looked at 4 candidates, none worth a change: ...") and stop. Never pad a round to look useful.
