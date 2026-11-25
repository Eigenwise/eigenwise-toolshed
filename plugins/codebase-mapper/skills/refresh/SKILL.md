---
name: refresh
description: Bring stale map cards back in line with the code. Use when the session line says cards are stale, or when asked to refresh or check the codebase map.
---

# Refresh the map

Cards go stale one at a time. Each card says the commit it was last checked at (`verified-at`), so only the cards whose area changed need work.

If there is no `.claude/rules/codebase-map.md`, there is no map yet. Use `map` instead.

## Steps

1. **Run the status script.**

   ```
   node "${CLAUDE_SKILL_DIR}/../../scripts/map-status.mjs"
   ```

   It prints JSON: one entry per card with `status` (`fresh` or `stale`), the number of `commits` under that card's globs since its `verified-at` that did not also change the card (or since the last commit that moved the stamp when the stamp is not on this history; `countedFrom` says which), a `reason` when it cannot tell, `emptyGlobs` (globs that match no file), `neverLoaded` (`./` patterns the host never loads) and `oversize`.

2. **Decide what needs work.**
   - `stale` with commits: the area changed. Re-derive the card.
   - `stale` with a `reason`: fix the frontmatter, then re-derive.
   - `emptyGlobs`: the area moved or was deleted. Fix the glob, or drop the card, or fold it into another.
   - `neverLoaded`: drop the `./`. `README.md` loads at any depth, `/README.md` only in the top folder.
   - `oversize`: shrink it. Cut what a file name already says.
   - Everything fresh: say so in one line and stop.

   Also look at the index. If areas were added, removed or renamed, or a key flow changed, it needs an edit too. The script does not watch the index, so check it against the stale cards.

3. **Re-derive each stale card from the code.** Read the files under its globs (and `git log --oneline <verified-at>..HEAD -- <globs>` for where to look first). Then rewrite the card from what the code says now. Do not patch it from a diff: a diff cannot show a line that was already wrong before the change. A card is small, so rewriting it is cheap.

   For several stale cards in a large repo, you may send read-only scouts, one per card. If Sidequest is installed, tag each spawn `[route:explore]`. A scout returns what it found about the area. It never writes the map. You write.

4. **Stamp the card.** Set `verified-at` to the current `git rev-parse HEAD`. Only on a card you actually re-read. Never stamp a card you did not check. The stamp counts before the commit and for a map git does not track, and it vouches for every commit before it. A commit that changes the card together with its area vouches for itself only. Fixing the wording alone does not vouch for anything.

5. **Re-run the status script.** Every card you touched should be fresh with no empty globs.

6. **Show the diff** (`git diff`). Leave the files in the working tree and do not commit. Keep `paths` free of braces and negation: list each pattern on its own line.

## Cadence

Refresh when the session line says cards are stale and you are about to work in that area, or before a release, or when asked. It is never needed after every change. A card that is a few commits behind and still accurate is fine: re-read it, change nothing but `verified-at` if it is still true, and say that you only confirmed it.

## Limits

- Subagents never write the map.
- Do not touch `CLAUDE.md`.
- Do not add history, lessons or hand-written guidance to a card. A rewrite from the code erases them.
- Never touch `.claude/rules/guides/`. People write those files, and nothing here checks them.
