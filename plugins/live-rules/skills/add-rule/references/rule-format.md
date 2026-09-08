# Rule Format

New workspaces use **atomic storage**: one Markdown file per rule under `.claude/live-rules/rules/` and
a generated `.claude/live-rules/manifest.json`. Rule files are authoritative. Run the plugin-owned
sync command after every rule-file change; never hand-edit the manifest.

```text
node "${CLAUDE_PLUGIN_ROOT}/scripts/sync-atomic-rules.js" --project "${CLAUDE_PROJECT_DIR}"
```

A rule file contains exactly one frontmatter block and its body:

```markdown
---
description: React component conventions
globs: ["**/*.tsx", "**/*.jsx"]
priority: 10
enabled: true
---
- Prefer function components with hooks over class components.
- No inline styles; use CSS modules.
- Co-locate the test file next to the component.
```

A stable filename such as `react-components.md` is easier to maintain than a generated-looking name.
The manifest records the file path, hash, and parsed metadata. Sync validates the files and atomically
replaces the manifest. If sync fails, fix the named rule file and run it again.

## Legacy single-file storage

Existing projects may still use a sequence of rule sections in one Markdown file. The default path is
`.claude/live-rules.md`; `LIVE_RULES_PATH` may point to a project-relative, absolute, or `~`-relative
file. This format is for automatic migration or an explicit `LIVE_RULES_PATH` override, not for new
rules.

On SessionStart, the plugin migrates a readable default legacy file into `.claude/live-rules/`, verifies
that the atomic rules match, and removes the old default file. An explicit `LIVE_RULES_PATH` file is
preserved. If verification fails, the legacy file stays in place so it can be recovered. Review and
commit the resulting project files.

When maintaining an explicit legacy override, each section still uses this shape:

```markdown
---
description: House style
---
- Prefer plain words over jargon.

---
description: SQL safety
globs: ["*.sql"]
---
- Always use parameterized queries.
```

A file with no complete frontmatter block is treated as one global rule whose body is the whole file.
Anything before the first `---` fence is ignored. Once a complete block exists, fences pair as
open/close blocks and the body runs until the next opening fence. A rule body must not contain a line
that is exactly `---`; use `***` or `___` for a horizontal rule. Parsing is fail-soft, so malformed
sections are skipped and a missing file produces no output.

## Frontmatter fields

| Field | Type | Default | Purpose |
|-------|------|---------|---------|
| `description` | string | `""` | Human title shown when the rule is injected and in `manage-rules` listings. |
| `globs` | list of strings | none | Path/glob scope. Injected before editing a matching file. |
| `dirs` | list of strings | none | Directory scope. Injected before editing under a directory and on prompts when the session cwd is inside it. |
| `prompt` | list of strings | none | Prompt-keyword scope. Injected when the submitted prompt matches a literal or `/regex/flags`. |
| `include` | string or list | none | Live file payload. Matching injections read these files fresh and append their contents. |
| `priority` | number | `0` | Higher numbers are injected first when several rules match. |
| `enabled` | boolean | `true` | Set `false` to switch a rule off without deleting it. |

Singular aliases are accepted (`glob`, `dir`), as are `prompts`/`keywords` for the prompt field and
`includes` for `include`.

## Scope and cadence

Scope follows from the fields present. There is no separate `type` field:

- **Global:** no `globs`, `dirs`, or `prompt`. Eligible on normal prompts.
- **Path/glob:** has `globs`. Eligible before an edit to a matching file.
- **Directory:** has `dirs`. Eligible before an edit under that directory and on prompts when the
  session cwd is inside it.
- **Prompt-keyword:** has `prompt`. Eligible when the submitted prompt matches.

A rule may declare more than one scope. Conditions are combined with **OR**.

SessionStart injects the applicable startup rules first. During the session, the ledger remembers each
rule's source path and content hash. UserPromptSubmit and PreToolUse inject only rules that newly match
or whose hash changed and have not been seen in that session. An unchanged rule is not repeated on
every prompt or edit. Editing, adding, disabling, or deleting a rule takes effect on the next prompt
or relevant edit, with no restart.

Global, prompt-keyword, and cwd rules arrive through UserPromptSubmit. Glob and directory rules arrive
through PreToolUse just before an edit. A rule with both kinds of scope is eligible on both paths.

## Including a live file

`include:` is a payload, not a scope. When a matching rule fires, the current contents of each listed
file are read fresh and appended under an `--- included: <path> ---` block. If none of the files can be
read, the rule is dropped for that injection. Project-relative paths are resolved from the project
root; absolute and `~`-relative paths are also honored.

```markdown
---
description: Codebase map protocol
include: .claude/.codebase-info/INDEX.md
---
This repo has a maintained codebase map. Read only the relevant map document before exploring.
```

Included content counts against the same roughly 10,000-character injection budget as the rule body.
Point `include:` at a compact hub such as `INDEX.md`, not a giant document.

## Glob syntax

Globs match gitignore-style against the repo-relative path of the file being edited:

- A pattern with no `/` matches that name at any depth: `*.sql` matches `db/schema.sql`.
- A pattern containing `/` is anchored to the repo-relative path: `src/*.ts` matches `src/index.ts`.

| Token | Meaning |
|-------|---------|
| `*` | Any run of characters within one path segment. |
| `**` | Any number of segments, including zero. |
| `?` | Exactly one non-`/` character. |
| `{a,b,c}` | Alternation. |

Trailing `**` also matches the bare directory. A leading `/` is accepted and ignored. POSIX character
classes, extglobs, numeric ranges, and nested braces are not supported.

## Prompt-keyword syntax

A `prompt` entry is either a case-insensitive literal substring or a regex written as `/pattern/flags`.
An invalid regex is ignored and does not match.

## Directory syntax

Each `dirs` entry is a repo-relative directory path, such as `packages/api` or `services/worker`. A
file is inside the directory when its repo-relative path equals it or starts with it plus `/`.

## Keep rules small

All matching rules for one event share a context budget of about 10,000 characters. The hooks inject
higher-priority rules first and note when matching rules are held back. Keep each body to a few tight
lines, use `priority` for the important rules, and split unrelated guidance into separate files.
