# Rule Format

All rules live in **one Markdown file**: by default `.claude/live-rules.md` at the project root, or
wherever the `LIVE_RULES_PATH` environment variable points (project-relative, absolute, or
`~`-relative; usually set in `.claude/settings.json` under `env`).

The file is a sequence of rules. Each rule is a YAML frontmatter block between `---` fences, followed
by its body, and the next `---` begins the next rule. The body is the instruction Claude sees; the
frontmatter decides **when** it is injected.

```markdown
# Live rules (optional title; anything before the first --- is ignored)

---
description: React component conventions
globs: ["**/*.tsx", "**/*.jsx"]
priority: 10
enabled: true
---
- Prefer function components with hooks over class components.
- No inline styles; use CSS modules.
- Co-locate the test file next to the component.

---
description: House style
---
- No em dashes. Use commas, colons, parentheses, or periods.
```

## How the file is parsed

- The `---` lines pair up as open/close, open/close, ... Each pair fences one rule's frontmatter, and
  the body runs from the closing fence to the next opening fence (or the end of the file).
- **Anything before the first fence** (a title or intro) is ignored.
- A **rule body must not contain a line that is exactly `---`**: it would be read as the next rule's
  fence and split the rule in two. For a horizontal rule inside a body, use `***` or `___`.
- A dangling unmatched `---` at the very end is skipped.
- Parsing is **fail-soft**: a malformed section is skipped, never fatal, and a missing file produces
  no output at all.

## Frontmatter fields

| Field | Type | Default | Purpose |
|-------|------|---------|---------|
| `description` | string | `""` | Human title for the rule. Shown as the heading when the rule is injected, and in `manage-rules` listings. Recommended. |
| `globs` | list of strings | none | **Path/glob scope.** Injected right before Claude edits a file matching any of these globs. |
| `dirs` | list of strings | none | **Directory scope.** Injected before editing a file under any of these directories, and on prompts when the session's working dir is inside one. |
| `prompt` | list of strings | none | **Prompt-keyword scope.** Injected on a prompt whose text matches any entry (literal substring, case-insensitive, or `/regex/flags`). |
| `priority` | number | `0` | Higher numbers are injected first when several rules match. |
| `enabled` | boolean | `true` | Set `false` to switch a rule off without deleting it. |

Singular aliases are accepted (`glob`, `dir`) as are `prompts`/`keywords` for the prompt field, so a
quick hand-edit does not trip on a missing `s`.

## Scope is inferred from the fields present

You do not declare a "type". The scope follows from which fields exist:

- **Global (always-on):** none of `globs`, `dirs`, `prompt`. Injected on **every prompt**.
- **Path/glob:** has `globs`. Injected before an edit to a matching file.
- **Directory:** has `dirs`. Injected before an edit under that directory, and on prompts when the
  session cwd is inside it.
- **Prompt-keyword:** has `prompt`. Injected when the submitted prompt matches.

A rule may declare more than one scope. Conditions are combined with **OR**: the rule fires when any
applicable condition matches. (Global and prompt-keyword rules arrive via the `UserPromptSubmit`
hook; glob and directory rules arrive via the `PreToolUse` hook just before the edit. A rule with
both is simply eligible on both paths.)

## How injection works

- **Global / prompt / cwd rules** are re-evaluated and re-injected on **every prompt**. This is
  deliberate: it keeps them salient deep into a long session instead of getting buried once and
  forgotten.
- **Glob / directory rules** are injected each time Claude is about to edit a matching file, so the
  reminder lands exactly when it is relevant.
- The hooks read the file **fresh every time**. Editing, adding, disabling, or deleting a rule takes
  effect on the next prompt or next edit. No restart, no `/reload`.
- Everything is **fail-soft**: a malformed section is skipped, never fatal, and a project with no
  live-rules file produces no output at all.

## Glob syntax

Globs are matched gitignore-style against the **repo-relative** path of the file being edited:

- A pattern with **no `/`** matches that name **at any depth**: `*.sql` matches `db/schema.sql` and
  `migrations/001.sql`.
- A pattern **containing `/`** is anchored to the repo-relative path: `src/*.ts` matches
  `src/index.ts` but not `src/util/x.ts` or `lib/index.ts`.

Supported tokens:

| Token | Meaning |
|-------|---------|
| `*` | any run of characters within one path segment (does not cross `/`) |
| `**` | any number of segments, including zero (`**/*.ts` matches `a.ts` and `a/b/c.ts`) |
| `?` | exactly one non-`/` character |
| `{a,b,c}` | alternation: `*.{ts,tsx}` matches both extensions |

Trailing `**` also matches the bare directory: `packages/api/**` matches both `packages/api/x.ts`
and `packages/api` itself. A leading `/` is accepted and ignored (patterns are already repo-anchored),
so `/src/**` and `src/**` mean the same thing. Brace alternation may be written unquoted
(`globs: [src/**/*.{ts,tsx}]`) or quoted; both parse correctly.

**Not supported** (document the limitation rather than relying on it): POSIX character classes
(`[a-z]`), extglobs (`!(...)`, `@(...)`), numeric ranges (`{1..3}`), and nested braces. An unmatched
`{` is treated as a literal. For the common cases (extensions, directory subtrees, test-file
patterns) the supported subset is plenty.

## Prompt-keyword syntax

Each `prompt` entry is one of:

- A **literal substring**, matched case-insensitively: `"deploy"` fires on *"let's deploy"* and
  *"DEPLOYMENT done"*.
- A **regex** written as `/pattern/flags`: `"/migrat(e|ion)/i"` fires on *"migrate"* and
  *"migration"*. If the regex is invalid it is ignored (the rule simply will not match on it).

## Directory syntax

Each `dirs` entry is a repo-relative directory path (no leading `./`, trailing slash optional):
`packages/api`, `services/worker`, `infra`. A file is "in" the directory if its repo-relative path
equals it or starts with it plus `/`.

## Keep rules small

All matching rules for one event share a budget of about **10,000 characters** of injected context
(Claude Code's cap). The hooks stay safely under it and, if too many rules match at once, inject the
highest-priority ones and note how many were held back. So: keep each body to a few tight lines, use
`priority` to float the important rules to the top, and split unrelated guidance into separate
sections rather than growing one giant rule.
