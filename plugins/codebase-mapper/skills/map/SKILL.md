---
name: map
description: Create the codebase map as native rules, an index plus one card per area. Use to map, onboard or document a repo, or to start a map for a new project.
---

# Map the codebase

The map is plain Claude Code rules, so Claude Code loads it for you. Nothing here is injected by a hook.

```
.claude/rules/codebase-map.md     the index, always loaded, 40 lines at most
.claude/rules/map/<area>.md       one card per area, loads when a file in the area is first touched
```

Never edit `CLAUDE.md`. Never write anything outside `.claude/rules/`.

A third kind of file exists only when an older map held guidance a person wrote: `.claude/rules/guides/<name>.md`. See step 1.

## The files

**Index** (`codebase-map.md`), no frontmatter:

- What the system is, in two or three lines.
- The areas, one line each: name, what it owns, its card.
- The three to five key flows, each as a chain of areas or files ("request -> router -> billing -> ledger").
- Where the commands live (build, test, run), if the repo does not say so already.

**Card** (`map/<area>.md`), about 2 KB at most:

```markdown
---
paths:
  - "src/billing/**"
verified-at: <output of git rev-parse HEAD>
---
# Billing
What it owns, in a sentence.
- Entry points: files an agent starts reading from.
- How it works: the few facts you cannot see from a file name.
- Touches: other areas it calls or is called by.
- Watch out: traps that cost someone time.
```

Rules for a card: write facts you checked in the code, with file paths. No incident history, no lessons, no guidance a person wrote (step 1 says where those go), no copied code. `refresh` rewrites a card from the code, so anything else on it is erased the next time. Globs use `**` and must match real files. No braces or negation in `paths`: list each pattern on its own line. A name with no slash (`README.md`) loads at any depth. Write `/README.md` for the top folder only. Never start a pattern with `./`: the host loads nothing for it. Keep them to the area.

## Steps

1. **Check what exists.** If `.claude/rules/codebase-map.md` exists, stop and offer `refresh` instead. If `.claude/.codebase-info/` exists (an older map), read it as source material and sort its documents before anything else:
   - **A description** of the system or an area (architecture, entry points, a folder's layout) is a lead for the index and cards. Verify what you use against the code. It is a lead, not a fact.
   - **Guidance a person wrote** (a style guide, a how-to, a convention, an evaluation guide: anything the code cannot tell you) never goes on a card. Each such document becomes `.claude/rules/guides/<name>.md`, in its own words, changed only where it names the old folder. Give it `paths` frontmatter for the files it is about, so it loads when those are touched; only a short guide that applies everywhere goes without. No `verified-at`: nothing checks it and `refresh` never touches it. A document that mixes both: the description is a lead, the guidance is copied to a guide.
   - **Lessons and incident notes**: when git tracks the old map they are the team's, so they go into a guide too, never into one person's memory. In a map of the person's own they go to memory.
2. **Greenfield (empty repo, scaffold or only a spec).** Ask two or three questions: what the system is for, the stack, the areas the person expects. Write the index only, with the intended areas marked "planned". Add cards when code exists. Skip the investigation.
3. **Investigate.**
   - Small repo: read it yourself. Entry points, top-level folders, manifests, test layout, how the pieces call each other.
   - Large repo (hundreds of source files): send read-only scouts in parallel, one per top-level area or package. If Sidequest is installed, tag each spawn `[route:explore]` so it runs on the cheap tier. Otherwise use plain Explore agents. Each scout returns its area's purpose, entry points, key files, neighbours and traps. Scouts never write.
4. **Propose, then ask.** Put the proposal in one message: the areas with their globs, the key flows, anything you could not tell. Ask the person to confirm or correct, with your recommended answer first so "yes" accepts it. One round. If they hand it over ("you decide"), take your recommendation and say so.
5. **Write.** You, the main session, write the index and the cards. Fill `verified-at` with the current `git rev-parse HEAD`. Run `node "${CLAUDE_SKILL_DIR}/../../scripts/map-status.mjs"` and fix any card whose globs match no file or that is over size.
6. **Show the diff** (`git status` and `git diff`, or the new files). Do not commit. With an older map, list every one of its documents and where it went: a lead for which card, copied to which guide, or left out and why. Nothing disappears without a line. Say that the cards load when a file in their area is touched, and that `refresh` re-derives the ones that go stale.
7. **Old map.** If `.claude/.codebase-info/` existed, ask whether to remove it now that the map is native. Delete it only on a yes.

## Sizing

A repo with a handful of areas needs a handful of cards. If you are past ten, merge areas. If a card cannot fit in 2 KB, the area is too big: split it by what an agent would want to read next.

## Done

The index is under 40 lines, every card has `paths` and `verified-at`, the status script shows no empty globs, and the person has seen the files.
