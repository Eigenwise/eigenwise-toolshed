# Converting the older rules

Read this only when the scan lists `rules-folder` or `rules-page` with the verdict convert. The older rules plugin injected rules through hooks. Claude Code now loads `.claude/rules/` itself, so each old rule becomes a native rule file or a project skill. The converter ships with Quartermaster: it needs no rules plugin loaded, older or v2.

Two older forms are read: the folder `.claude/live-rules/rules/*.md`, and the single page `.claude/live-rules.md` when there is no folder. If both exist the folder wins, since that is what the older plugin loaded first. The first line of the output says which one was read.

## 1. Show the plan

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/upgrade-rules-convert.mjs" --project "<project root>"
```

This writes nothing. Show the output as it is, and say what each line means:

- `CONVERT ... rule`: a file under `.claude/rules/`. `globs` and `dirs` became `paths`, an `include` became an `@` import line, and the description became the H1.
- `CONVERT ... skill`: the rule matched on prompt keywords, which rules cannot do, so it becomes a project skill. Its name comes from what the rule calls itself (never a bare numeric id), and its description is the topic, then "Use when the request mentions a, b or c". A note says when the keywords were a regular expression that is not a plain list: the description leaves them out and the note shows the original.
- A note that says `no skill`: nothing usable to name a skill from, so the rule stays a rule and its keyword trigger is dropped.
- A rule with both file scope and keywords gets a rule file with the whole body and a short skill that points at it by path, so the body is read from one place.
- `SKIPPED ... disabled`: turned off in the older version. Nothing is written for it.
- `SKIPPED ... cannot parse`: broken frontmatter, with the reason. A single page that cannot be parsed shows as one such item and is left alone.
- `CONFLICT`: the target already exists. It is never overwritten.
- A note that a glob has no slash: the pattern was copied as written. The older version matched a bare name at any depth, and so does this one; `/name` would mean only the root one.
- A note that `priority` was dropped: it has no native form. Say so if any rule relied on order.

## 2. Write

The person's go-ahead for the upgrade covers this: do not ask again. Write on the recommended answer, which is to convert what the plan marks `CONVERT` and leave `SKIPPED` and `CONFLICT` alone. Name those in the report, with the reason, for the person to fix by hand later.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/upgrade-rules-convert.mjs" --project "<project root>" --write
```

It never overwrites a file and never deletes the old rules. Undo: delete the files it lists.

If git ignored or excluded the old folder or page, those rules were personal. The new files are not excluded, so add each written path to `.git/info/exclude` to keep them personal, and say so (undo: delete the lines). Skills written under `.claude/skills/` appear in the next session.

## 3. The old rules

The output's last line depends on git. When git tracks the old folder or page, the line says it stays and that removing it is a committed change: it goes only in the committed change (step 14 of `team-repository.md`). When git does not track it, the line names the path to delete. Delete nothing here either way: the old folder or page goes with the scan's deletion list, and only on the person's yes to that list. The older rules plugin goes off in the plugin switch, so the old and new rules never both apply.
