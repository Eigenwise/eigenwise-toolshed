# live-rules

**Developer-friendly, live rules for Claude Code.** Keep your rules in one Markdown file
(`.claude/live-rules.md` by default, or anywhere you like), and a pair of bundled hooks re-inject the
ones that apply, right when they apply: global rules and prompt-keyword rules on every prompt,
path/glob and directory rules the moment Claude is about to edit a matching file. The hooks read the
file fresh every time, so editing a rule takes effect on the **next prompt, with no restart**. That
is the "live" part: the rules are re-asserted every turn, so they do not get buried and forgotten as
a session grows.

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
  do not get buried and forgotten deep in a long session. That is the difference from a one-time read
  of `CLAUDE.md`: models drift, and live-rules keeps repeating the rules that still apply.
- **Live.** Edit a rule and it applies on the very next prompt. No restart, no re-reading a giant
  file.
- **Toggleable.** One rule per section, each with its own scope. Disable one with a single field; the
  rest are untouched.

Use both: `CLAUDE.md` for the permanent project brief, live-rules for conditional guidance and
guardrails that need to stay in front of the model. live-rules never touches `CLAUDE.md`.

## Quick start

Create one file, `.claude/live-rules.md`:

```markdown
# Live rules (re-injected every turn)

---
description: House style
---
- No em dashes. Use commas, colons, parentheses, or periods.
- Prefer plain words over jargon.

---
description: React component conventions
globs: ["**/*.tsx"]
---
- Function components with hooks only; no class components.
- No inline styles; use CSS modules.
```

That is two rules in one file. The first is **global** (no scope fields), so it is injected on every
prompt. The second is **scoped** to `.tsx` files, so it stays out of your way until Claude is about to
edit one. Commit `.claude/live-rules.md` and your whole team shares the rules.

Anything before the first `---` fence (the `# Live rules` heading above) is just a title and is
ignored. Each rule is a frontmatter block (`--- ... ---`) followed by its body; the next `---` starts
the next rule.

Prefer to let Claude write them for you? Just ask: *"add a rule that we always use httpx instead of
requests in Python files"*, and the `add-rule` skill appends a correctly-scoped rule to the file.

## Where the file lives (configurable)

By default the hooks read `.claude/live-rules.md` at the project root. Point them anywhere with the
`LIVE_RULES_PATH` environment variable, set in `.claude/settings.json` so it is committed with the
project:

```json
{
  "env": {
    "LIVE_RULES_PATH": "docs/live-rules.md"
  }
}
```

The value can be:

- **project-relative** (`docs/live-rules.md`, `rules/team.md`) — resolved from the repo root,
- **absolute** (`C:\\work\\shared\\rules.md`, `/srv/rules.md`),
- **home-relative** (`~/claude-rules.md`) — handy for personal rules you want in every project.

When the variable is unset, the default `.claude/live-rules.md` is used. When the file does not exist,
the hooks stay silent and never block anything.

## How it works

The plugin ships two hooks (Node, standard library only, cross-platform, and fail-soft: any error or
a missing rules file produces no output and never blocks anything).

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

## File format reference

The rules file is a sequence of rules. Each rule is a YAML frontmatter block between `---` fences,
followed by its body, and the next `---` begins the next rule:

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
- Anything before the first `---` fence is treated as a title or intro and ignored.
- A rule body must **not** contain a line that is exactly `---` (it would be read as the next rule's
  fence). For a horizontal rule inside a body, use `***` or `___`.
- The file is read fresh on every prompt and every edit, so all changes are live.

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
and split unrelated guidance into separate rules.

## Skills

| Skill | Invoke with | Does |
|-------|-------------|------|
| `add-rule` | "add a rule that...", "make a guardrail for...", or `/live-rules:add-rule` | Appends or edits a rule in your live-rules file, picking the right scope and writing valid frontmatter |
| `manage-rules` | "list my rules", "audit my rules", "disable the X rule", or `/live-rules:manage-rules` | Lists, audits, enables/disables rules, and explains which rules are active when |

You never have to use the skills: hand-editing the file works exactly as well, since the hooks just
read whatever is on disk.

## Sharing with your team

Commit `.claude/live-rules.md` (or whatever `LIVE_RULES_PATH` points at, as long as it is in the
repo). Everyone who pulls the repo and has the plugin installed gets the same rules, injected the same
way. Disabling a rule (`enabled: false`) is a reviewable one-line diff, so you can pause a strict gate
during a refactor and turn it back on later.

## Troubleshooting

- **A rule is not showing up.** Check the scope: a glob rule only fires on an edit to a matching file,
  not on a plain prompt. Ask `manage-rules` to "explain what is active when I edit `path/to/file`".
- **A glob never matches.** Globs are repo-relative. Remember the gitignore rule: use `**/*.ext` (or a
  slash-free `*.ext`) to match at any depth; `*.ext` with no `**` and no `/` still matches at any
  depth, but `dir/*.ext` only matches direct children of `dir`. `manage-rules` can test a glob
  against your actual files.
- **A rule got mangled or two rules merged.** A bare `---` line in a body is read as the next rule's
  fence. Use `***` or `___` for a horizontal rule inside a body.
- **Nothing happens at all.** The hooks are silent when the rules file does not exist. Confirm
  `.claude/live-rules.md` exists at the project root (or that `LIVE_RULES_PATH` points at a real
  file), that the plugin is enabled (`/plugin`), then reload plugins.
- **Too much context.** If many rules match at once you will hit the size note; raise `priority` on
  the few that matter and trim or split the rest.
- **It is safe by design.** Every hook exits cleanly on any error and never blocks a prompt or an
  edit, so a broken section degrades to "that one rule is skipped", nothing worse.

## Clean up

- Rules: delete `.claude/live-rules.md` (or individual sections inside it).
- Plugin: `/plugin uninstall live-rules@claude-toolshed`.

## License

MIT (c) Eigenwise
