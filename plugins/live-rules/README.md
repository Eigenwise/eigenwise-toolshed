# live-rules

**Developer-friendly, live rules for Claude Code.** Drop small Markdown rule files in
`.claude/rules/`, and a pair of bundled hooks inject the ones that apply, right when they apply:
global rules and prompt-keyword rules on every prompt, path/glob and directory rules the moment
Claude is about to edit a matching file. The hooks read your rule files fresh every time, so editing
a rule takes effect on the **next prompt, with no restart**. That is the "live" part.

It is the same idea behind [codebase-mapper](../codebase-mapper) (a hook that re-injects context so
it stays salient), pointed at a different job: instead of a map of your codebase, it injects **your
rules**, scoped to the moment they matter.

## Install

```text
/plugin marketplace add Eigenwise/claude-toolshed
/plugin install live-rules@claude-toolshed
```

Then run `/reload-plugins` (or restart Claude Code).

## Why not just use `CLAUDE.md`?

`CLAUDE.md` is great for a static, always-on brief. live-rules is for everything that is **conditional
or that needs to stay salient**:

- **Scoped.** A React rule only shows up when editing `*.tsx`. A deploy checklist only shows up when
  you mention deploying. Your context is not permanently full of rules that apply 5% of the time.
- **Salient.** Rules are re-asserted on every prompt (and right before each relevant edit), so they
  do not get buried and forgotten deep in a long session.
- **Live.** Edit a rule and it applies on the very next prompt. No restart, no re-reading a giant
  file.
- **Atomic and toggleable.** One rule per file. Disable one with a single field; the rest are
  untouched.

Use both: `CLAUDE.md` for the permanent project brief, live-rules for conditional guidance and
guardrails. live-rules never touches `CLAUDE.md`.

## Quick start

Create one file:

```markdown
.claude/rules/house-style.md
---
description: House style
---
- No em dashes. Use commas, colons, parentheses, or periods.
- Prefer plain words over jargon.
```

That is a **global** rule (no scope fields), so it is injected on every prompt from now on. Add a
**scoped** one:

```markdown
.claude/rules/react-components.md
---
description: React component conventions
globs: ["**/*.tsx"]
---
- Function components with hooks only; no class components.
- No inline styles; use CSS modules.
```

This one stays out of your way until Claude is about to edit a `.tsx` file. Commit `.claude/rules/`
and your whole team shares the rules.

Prefer to let Claude write them for you? Just ask: *"add a rule that we always use httpx instead of
requests in Python files"*, and the `add-rule` skill scaffolds the right file with the right scope.

## How it works

The plugin ships two hooks (Node, standard library only, cross-platform, and fail-soft: any error or
a missing `.claude/rules/` produces no output and never blocks anything).

| Hook | Fires | Injects |
|------|-------|---------|
| `UserPromptSubmit` | every time you submit a prompt | **global** rules, **prompt-keyword** rules matching your text, and **directory** rules whose folder contains the session's working dir |
| `PreToolUse` (Edit / Write / MultiEdit / NotebookEdit) | right before Claude edits a file | **path/glob** rules matching the file, and **directory** rules whose folder contains it |

Why this split? `UserPromptSubmit` sees your prompt text and working directory, so it serves the
rules that depend on those. `PreToolUse` is the only event that knows **which file** is about to be
edited, so it serves the file-scoped rules, delivered exactly when they are relevant.

The `PreToolUse` hook only **adds context**; it never sends a permission decision, so your normal
edit-approval flow is unchanged. It informs Claude, it does not auto-approve anything.

## The four trigger types

Scope is inferred from which frontmatter fields a rule declares. You never set a "type".

### 1. Global (always-on)

No scope fields. Injected on every prompt. Reserve these for things that truly always apply.

```markdown
---
description: Commit hygiene
---
- Never commit directly to main; branch first.
- Run the tests before committing.
```

### 2. Path / glob

`globs:` a list of gitignore-style patterns. Injected before editing a matching file.

```markdown
---
description: SQL safety
globs: ["*.sql"]
---
- Always use parameterized queries.
- Every destructive migration needs a tested rollback.
```

### 3. Directory

`dirs:` a list of repo-relative directories. Injected before editing a file under one of them (and on
prompts when your session's working dir is inside one).

```markdown
---
description: API layer rules
dirs: ["packages/api"]
---
- Validate input with the shared schemas in packages/api/schemas.
- Return the standard error envelope; do not invent ad hoc shapes.
```

### 4. Prompt-keyword

`prompt:` a list of triggers. Each is a literal substring (case-insensitive) or a `/regex/flags`.
Injected when your prompt matches.

```markdown
---
description: Deploy checklist
prompt: ["deploy", "release", "/ship.*prod/i"]
---
- Confirm staging smoke tests passed.
- Bump the version and update CHANGELOG.md.
```

Scopes combine. A rule with both `globs` and `prompt` fires on either condition (OR).

## Rule file reference

```markdown
---
description: Short human title (shown as the heading when injected)
globs: ["**/*.tsx", "**/*.jsx"]   # path/glob scope
dirs:  ["packages/api"]            # directory scope
prompt: ["deploy", "/migrat/i"]    # prompt-keyword scope
priority: 10                        # higher injects first (default 0)
enabled: true                      # default true; set false to switch off
---
- The body is the instruction Claude sees. Keep it tight and imperative.
```

| Field | Type | Default | Purpose |
|-------|------|---------|---------|
| `description` | string | `""` | Title shown when injected and in listings. |
| `globs` | list | none | Path/glob scope (also accepts singular `glob`). |
| `dirs` | list | none | Directory scope (also accepts singular `dir`). |
| `prompt` | list | none | Prompt-keyword scope (also accepts `prompts` / `keywords`). |
| `priority` | number | `0` | Ordering when several rules match; higher first. |
| `enabled` | boolean | `true` | `false` switches the rule off without deleting it. |

- A rule with **none** of `globs` / `dirs` / `prompt` is **global**.
- Rules can live in subfolders of `.claude/rules/`. A `README.md` there is ignored by the hooks.
- Files are read fresh on every prompt and every edit, so all changes are live.

### Glob syntax

Matched gitignore-style against the **repo-relative** path:

- **No `/` in the pattern** matches that name at any depth: `*.sql` matches `db/schema.sql`.
- **A `/` in the pattern** anchors it: `src/*.ts` matches `src/index.ts`, not `src/util/x.ts`.

Tokens: `*` (within a segment), `**` (any depth, including zero), `?` (one char), `{a,b}`
(alternation). Trailing `**` also matches the bare directory (`packages/api/**` matches
`packages/api`). Not supported: POSIX classes `[a-z]`, extglobs, numeric ranges, nested braces.

### Size budget

Claude Code caps injected context at about **10,000 characters** per event. All rules matching one
event share that budget. The hooks stay under it and, if too many match, inject the highest-priority
rules and note how many were held back. Keep each rule short, use `priority` for the important ones,
and split unrelated guidance into separate files.

## Skills

| Skill | Invoke with | Does |
|-------|-------------|------|
| `add-rule` | "add a rule that...", "make a guardrail for...", or `/live-rules:add-rule` | Creates or edits a rule file, picking the right scope and writing valid frontmatter |
| `manage-rules` | "list my rules", "audit my rules", "disable the X rule", or `/live-rules:manage-rules` | Lists, audits, enables/disables rules, and explains which rules are active when |

You never have to use the skills: hand-editing the files works exactly as well, since the hooks just
read whatever is on disk.

## Sharing with your team

Commit `.claude/rules/`. Everyone who pulls the repo and has the plugin installed gets the same rules,
injected the same way. Disabling a rule (`enabled: false`) is a reviewable one-line diff, so you can
pause a strict gate during a refactor and turn it back on later.

## Troubleshooting

- **A rule is not showing up.** Check the scope: a glob rule only fires on an edit to a matching file,
  not on a plain prompt. Ask `manage-rules` to "explain what is active when I edit `path/to/file`".
- **A glob never matches.** Globs are repo-relative. Remember the gitignore rule: use `**/*.ext` (or a
  slash-free `*.ext`) to match at any depth; `*.ext` with no `**` and no `/` still matches at any
  depth, but `dir/*.ext` only matches direct children of `dir`. `manage-rules` can test a glob
  against your actual files.
- **Nothing happens at all.** The hooks are silent when there is no `.claude/rules/`. Confirm the
  folder exists at the project root and the plugin is enabled (`/plugin`), then reload plugins.
- **Too much context.** If many rules match at once you will hit the size note; raise `priority` on
  the few that matter and trim or split the rest.
- **It is safe by design.** Every hook exits cleanly on any error and never blocks a prompt or an
  edit, so a broken rule file degrades to "that one rule is skipped", nothing worse.

## Clean up

- Rules: delete `.claude/rules/` (or individual files).
- Plugin: `/plugin uninstall live-rules@claude-toolshed`.

## License

MIT (c) Eigenwise
