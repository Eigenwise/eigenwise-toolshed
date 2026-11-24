# codebase-mapper

A map of your codebase that Claude Code loads by itself. The map is plain rules files in your project, so a teammate who never installed this plugin still gets it.

```bash
claude plugin marketplace add Eigenwise/eigenwise-toolshed#v2
```

```bash
claude plugin install codebase-mapper@toolshed-next
```

## What you get

```
.claude/rules/codebase-map.md     the index: what the system is, the areas, the key flows
.claude/rules/map/<area>.md       one card per area
.claude/rules/guides/<name>.md    only when an older map held hand-written guidance: copied, never rewritten
```

The index has no `paths` frontmatter, so it is always loaded, and it comes back after a compaction. It stays under 40 lines.

A card has `paths` frontmatter with the globs of its area. Claude Code loads it the first time a file in that area is touched. Cards stay around 2 KB. Each one records `verified-at: <commit sha>`, the commit it was last checked against.

Nothing is injected by a hook and nothing is asked of the model every turn. No process runs per tool call; one background process runs at session start, and only where the card folder `.claude/rules/map` exists. `CLAUDE.md` is never touched.

## Skills

**`map`** creates the map. It investigates first, reading the repo itself or, for a large one, sending read-only scouts in parallel (routed to the cheap tier when Sidequest is installed, plain Explore agents otherwise). Then it proposes the areas and key flows in one message, with a recommended answer, and you confirm or correct. Only then does it write the index and cards and show you the diff. For a new project it asks two or three questions and writes a lean starting map.

**`refresh`** keeps it honest. It runs the status script, re-derives only the stale cards from the code (a small card is rewritten from source, never patched from a diff), updates `verified-at` and shows the diff. Both skills leave the files in your working tree and never commit. Subagents never write the map.

## Staleness

`scripts/map-status.mjs` needs only Node and git. For each card it counts the commits under that card's globs since a starting commit:

```
git rev-list --count <starting commit>..HEAD -- <globs>
```

A card is stale by every commit under its globs since its stamp that did not also change the card file, so a card changed together with its area stays fresh however it lands, by merge, squash or rebase. A refresh moves `verified-at` to HEAD, and the stamp vouches for everything before it, even before the stamp is committed. Fixing a card's wording or renaming it vouches for nothing. When the stamp is not a commit on this history (no stamp, or a branch commit that was squashed or rebased away), the check counts from the last commit that moved the stamp, so two clones agree, and a card git does not hold with no usable stamp is reported with a reason. Each card in the JSON says which applied in `countedFrom` (`verified-at` or `card-commit`). One case stays hidden: a stamp from a branch commit that was squashed away, plus a teammate's change to the area made while that branch was open, reads fresh.

Zero means fresh. Anything else means stale, with the count. Because each card has its own commit and its own globs, refreshing one card never vouches for another.

The check runs from the folder that holds `.claude`, found by walking up from the working directory (or `--root`) to the git top level, so a project in a subfolder of a larger repository is judged by its own commits.

It also reports cards whose globs match no file, cards with a `./` pattern (the host never loads it, so the status line says so and nothing is counted for it), cards over about 2.5 KB, and cards with no `verified-at`.

```
node plugins/codebase-mapper/scripts/map-status.mjs            # JSON
node plugins/codebase-mapper/scripts/map-status.mjs --line     # Codebase map: 2 of 7 areas out of date. /codebase-mapper:refresh updates them.
node plugins/codebase-mapper/scripts/map-status.mjs --root <dir>
```

Globs are git glob pathspecs, so no braces and no negation: list each pattern on its own line instead of `src/**/*.{ts,tsx}`. `src/billing/**` and `src/**/*.ts` work. Claude Code reads a card's paths from the folder that holds its `.claude` folder, and the status check reads them the same way: a name with no slash (`README.md`, `*.md`) loads at any depth, and a leading slash (`/README.md`) means that top folder only. A `./README.md` pattern loads for nothing.

## The session line

The plugin's one hook runs at session start. Where the card folder exists, it starts the status script in the background, never waiting for it, so the session opens at normal speed. If any card is stale it pins one line under the prompt, for example `map: 2 of 7 cards stale`. A fresh map, no map, no `node` on the PATH or any failure shows nothing. It never blocks, never asks the model anything and never writes a file. The line is a snapshot from session start. It does not change after a refresh; the next session shows the new state.

## In a team

The map is committed like code. Everyone who clones the repository gets it, with or without this plugin, because Claude Code loads rules files by itself.

- **Who keeps a card up.** Whoever changes an area updates that area's card in the same change, the way they would update a test. With the plugin `refresh` does it. Without it, edit the card by hand. The card is loaded while they work there, so an agent sees it next to the code: in six test sessions that changed code in an area with no map plugin to tell them, all six updated the card in the same change.
- **When.** In the change that makes the card untrue. A card changed in the same commit as its area reads fresh once that commit lands, by merge, squash or rebase.
- **Nothing forces it.** No hook holds up a commit or a turn over a stale card. The session line only says how many cards are stale, and only to people who have the plugin. A card nobody kept up stays a few commits behind until someone works in that area again.
- **Review.** A card change shows in the diff beside the code it describes, so a reviewer sees both.
- **Conflicts.** Different areas never conflict: each card is its own file. Two people who refresh the same card do, at least on its `verified-at` line. The way out is to take either side and refresh that card. There is no shared manifest to clash on.

## What it does not do

No acknowledgment line, no Stop hook, no per-turn documentation check, no hash manifest, no automatic refresh. The map changes only when you ask for a refresh and say yes to the diff.

## Moving from an older map

Older versions kept the map in `.claude/.codebase-info/` and injected it with hooks. Run `map` in that project. It reads the old documents as source material, checks what it uses against the code, and writes the new index and cards. It then asks whether to delete `.claude/.codebase-info/`, and removes it only on a yes. Not everything in an old map describes code. A style guide, a how-to or an evaluation guide that someone wrote by hand never goes on a card, because `refresh` rewrites a card from the code and would erase it. `map` copies each such document to `.claude/rules/guides/<name>.md`, in its own words, with `paths` for the files it is about, and `refresh` never touches that folder. Lessons and incident notes go to your memory when the map is your own, and into a guide when git tracks the map, so the team keeps them. `map` ends by listing every old document and where it went.

Where git tracks the old folder, the map is the team's, so move it for everyone in one commit: the new index and cards, the old folder removed, and the older mapper switched off in the committed settings with `"codebase-mapper@eigenwise-toolshed": false`. Set to `false`, the key switches it off in this repository even for a teammate who has it on for all their projects; a key that is only removed leaves it on for them. Until that commit merges, everyone keeps the older mapper: one person's own copy of the new map drifts from the team's in both directions. After the merge a teammate needs to install nothing to get the map. A branch that still edits a file in the old folder gets a conflict when it merges the move, and puts that fact on the card instead.

## Check it

From a checkout of this repository. An installed copy has the same script in its install folder, and the skills run it for you.

```
claude plugin validate plugins/codebase-mapper
claude plugin test plugins/codebase-mapper
node --test plugins/codebase-mapper/scripts/map-status.test.mjs
```
