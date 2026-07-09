# haiku-jar: a codebase-mapper example

A tiny, zero-dependency Python program: a command line that keeps haiku in a JSON
file and draws one back out at random. It exists as a sample for the
[codebase-mapper](../../plugins/codebase-mapper) plugin.

## What haiku-jar does

A haiku is a little three-line poem (classically 5-7-5 syllables). haiku-jar is a
small "jar" you drop them into and pull one back out of later:

- `haiku-jar add "old pond / a frog leaps in / the sound of water" --author Basho`
  stores a haiku (the three lines are separated by `/`).
- `haiku-jar draw` prints one at random.
- `haiku-jar list` and `haiku-jar count` show what's in the jar.

The jar is just a JSON file on disk (`./haiku-jar.json`, or wherever
`HAIKU_JAR_PATH` points). There's no database and no server; it's one small program
that runs and exits. Adding a haiku also runs a gentle, advisory 5-7-5 check, but it
never refuses a poem whose shape wanders. That small, clear shape is exactly why
it's a good thing to point a codebase mapper at.

The point of this folder is to show **both halves** of what codebase-mapper does:

1. **A small source tree** to map (six little files under `src/haiku_jar/`).
2. **The map it produced, committed right here** in
   [`.claude/.codebase-info/`](./.claude/.codebase-info). That's the whole idea of
   the plugin: map once, commit the result, and every teammate and every future
   Claude session starts already grounded. So browse that folder now: it's a real,
   generated map, not a mock-up.

> Sibling example: [`../code-and-ode`](../code-and-ode) does the same for the
> **live-rules** plugin.

## The committed map

```
.claude/.codebase-info/
├── INDEX.md                # compact hub, re-injected into context every prompt
├── architecture.md         # the CLI → Jar → storage picture
├── tech-landscape.md       # Python, the stdlib modules used, build + dev tooling
├── directory-structure.md  # the annotated tree
├── entry-points.md         # the console script, `python -m`, the four subcommands
├── modules.md              # haiku · jar · storage · cli
├── patterns.md             # value object, layering, injected randomness, testing
├── coding-style.md         # conventions derived from the ruff config
├── onboarding.md           # quick start + common tasks
└── .map-state.json         # commit + date, used to detect staleness on the next update
```

Notice what's **not** there: no `database.md`, `docker.md`, `communication.md`, or
`dependencies.md`. This program has no database, no containers, no network, and no
runtime dependencies, so the mapper left those docs out. It only writes the docs
that apply.

## Try it yourself

### 1. Install the plugin (once)

```text
/plugin marketplace add Eigenwise/eigenwise-toolshed
/plugin install codebase-mapper@eigenwise-toolshed
```

Then `/reload-plugins` (or restart Claude Code).

> This folder ships a `.claude/settings.json` that enables `codebase-mapper`. If you
> cloned the toolshed and want it to use your **local** checkout instead of the
> published marketplace, edit the `path` in that file to point at your clone's root.

#### Prefer not to install a second plugin? Load the same map with live-rules

The auto-loading half of codebase-mapper (re-inject the map every prompt) is just "inject a live
file," which the [live-rules](../../plugins/live-rules) plugin does with its `include:` field. If you
already run live-rules, you can surface this exact map without installing codebase-mapper at all. Drop
this one rule into `.claude/live-rules.md`:

```markdown
---
description: Codebase map protocol
include: .claude/.codebase-info/INDEX.md
---
This repo has a maintained codebase map. Before starting any task, say which doc(s)
from .claude/.codebase-info/ you will read, and read them before exploring. After
changing code, review whether the map needs updating.
```

That re-injects `INDEX.md` on every prompt, the same as the plugin's hook. The trade is division of
labor: the live-rules rule gives you the **loading**; the codebase-mapper plugin additionally ships the
`map-codebase` and `update-codebase-map` skills that **generate and maintain** the docs in the first
place. Same map file on disk, two ways to keep it in front of Claude. (This is a documented
alternative; the folder's committed `settings.json` uses the plugin so the example runs out of the box.)

### 2. cd into this project, then start Claude Code here

codebase-mapper maps **the directory Claude Code is running in.** Open your terminal
in *this* folder, not the repo root:

```bash
cd examples/haiku-jar
claude
```

This matters: from the toolshed root you'd map the marketplace, not haiku-jar.

### 3. Watch the map already work

Because the map is committed, the plugin's `UserPromptSubmit` hook injects
`INDEX.md` on your very first prompt. Ask anything about the project ("how does
`draw` stay testable?") and Claude will answer from the map instead of grepping
around blind.

### 4. Regenerate it, or update it

Re-create the map from scratch:

```text
map the codebase
```

(or `/codebase-mapper:map-codebase`). It will rewrite `.claude/.codebase-info/`.
Or change the code and let the map self-heal:

```text
Add a `haiku-jar random` alias for `draw`, then update the codebase map.
```

That touches `entry-points.md` (a new subcommand) and re-stamps `.map-state.json`,
and leaves the rest alone. Use `git diff` to see exactly which docs moved.

## Running haiku-jar itself (optional)

You don't need to run the program to map it, but it's real and it works:

```bash
cd examples/haiku-jar
pip install -e ".[dev]"     # or skip install: PYTHONPATH=src python -m haiku_jar ...

haiku-jar add "old pond / a frog leaps in / the sound of water" --author Basho
haiku-jar list
haiku-jar draw
pytest                       # 7 tests
ruff check . && ruff format --check .
```

The jar is written to `./haiku-jar.json` (override with `HAIKU_JAR_PATH`), and that
file is git-ignored so running the tool never dirties the repo.

---

*Part of the [eigenwise-toolshed](../../README.md), free and MIT. If it helps you, [a coffee](https://ko-fi.com/eigenwise) or [a GitHub sponsorship](https://github.com/sponsors/Eigenwise) keeps the shed stocked.*

| Ko-fi | GitHub Sponsors |
|:-----:|:---------------:|
| <a href="https://ko-fi.com/eigenwise"><img height="32" alt="Support me on Ko-fi" src="https://ko-fi.com/img/githubbutton_sm.svg"></a> | <a href="https://github.com/sponsors/Eigenwise"><img height="32" alt="Sponsor on GitHub" src="https://img.shields.io/badge/Sponsor-EA4AAA?style=for-the-badge&logo=githubsponsors&logoColor=white"></a> |
