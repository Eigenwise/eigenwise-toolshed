---
name: add-rule
description: Turn "from now on, when X, do Y" into a rule file or project skill. Use when the user states a standing instruction, convention or guardrail.
---

# Add a rule

Claude Code loads `.claude/rules/*.md` by itself. You write the file and check it. No hook runs.

## 1. Pick the shape

Infer as much as you can from the request. Ask only for what you cannot tell, and only one question: where should it apply?

| Applies | You write | How it loads |
| --- | --- | --- |
| Always | `.claude/rules/<name>.md`, no `paths` | At session start, and again after compaction |
| Files matching a glob | `.claude/rules/<name>.md` with `paths` | When Claude touches a matching file |
| A directory | `.claude/rules/<name>.md` with `paths: ["<dir>/**"]` | Same |
| A prompt keyword or a procedure to run on request | `.claude/skills/<name>/SKILL.md` | The description is the trigger. The body loads when it is used |

Rules cannot match words in a prompt. A "when I say X" request is always a skill.

A rule that has to hold through a long session gets no `paths`. A path rule sits in the conversation, so compaction summarises it away and it only comes back when a matching file is touched again. Keep always-loaded rules few and short: they cost context on every turn, and a `CLAUDE.md` past about 200 lines is followed less well.

Project scope is the default. Use `~/.claude/rules/` or `~/.claude/skills/` only when the user says user scope or "everywhere". Say which one you used.

If the instruction is a hard check (it must never be skipped), tell the user a rule only advises and a hook or CI check enforces. Write the rule anyway, and say so in one line.

## 2. Write the file

One concern per file. A name that says the rule: `commit-message-style.md`, not `rules1.md`. The first line of the body is an H1 that states the rule. Then a few short imperative lines. Aim well under 1.5 KB for an always-loaded rule and 2 KB for a path-scoped one.

Path-scoped rule:

```markdown
---
paths:
  - "src/**/*.tsx"
---
# Components are function components

- Use hooks. No class components.
- Keep the test next to the component.
```

Always-loaded rule: same, with no frontmatter at all.

Skill: frontmatter `name` and a `description` under 200 characters that starts with when to use it ("Use when the user asks to cut a release"). The body is the procedure.

Rules for the `paths` list:

- Quote each glob.
- A pattern with no slash matches at any depth (`*.sql`). A pattern with a slash is anchored to the folder that holds the rule's `.claude` folder (`src/*.ts`). A leading `/` is how to mean "this folder only": `/README.md` is the one next to `.claude`, while `README.md` also loads for `docs/README.md`.
- Brace lists work: `src/**/*.{ts,tsx}`.
- A trailing `/**` is dropped and `src/**` means the directory `src`. A list of only `**` means always loaded, so leave `paths` out instead.
- To pull in another file, put `@relative/path.md` on its own line in the body. The path is relative to the rule file.

Do not edit `CLAUDE.md` for this. Do not write a rule that restates what the code or a linter already shows.

## 3. Audit it

Run the audit on the file you wrote and show the output:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/audit-rules.mjs" --rules .claude/rules --file .claude/rules/<name>.md --table
```

The audit needs Node 22.5 or later. Without it, skip this step and say so. For a user-scope rule use `--rules ~/.claude/rules`. Glob matching is skipped there because no project applies.

A warning about a glob that matches nothing usually means the path is wrong. Fix it and run again. If the user wants a rule for files that do not exist yet, say so and leave it.

For a skill there is nothing to audit. Check that the description reads as a trigger.

## 4. Report

Say in two lines: the file path, and when it loads. A new rule file takes effect in the next session, or when Claude next touches a matching file. Tell the user to commit it if they want the team to have it.
