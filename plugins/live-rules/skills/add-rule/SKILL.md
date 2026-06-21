---
name: add-rule
description: >-
  Create or edit a live-rules rule: an atomic Markdown file in .claude/rules/ that gets injected into
  Claude's context automatically when it applies. Use when the user asks to "add a rule", "create a
  rule", "make a rule that...", "add a coding guideline/guardrail/convention", "enforce that ...",
  "always do X", "whenever I edit *.tsx do Y", "when I work in packages/api do Z", "when my prompt
  mentions 'deploy' remind me to ...", or "set up live-rules". Picks the right scope (global,
  path/glob, directory, or prompt-keyword) and writes valid frontmatter. To list, audit, enable, or
  disable existing rules instead, use manage-rules.
---

# Add Rule

Turn a request like *"always run the linter before committing"* or *"when editing `*.tsx`, prefer
function components"* into a **rule file** under `.claude/rules/`. The plugin's hooks inject each
rule automatically, at the moment it applies, so the user does not have to remember to paste it.

Read `references/rule-format.md` for the full frontmatter spec and `references/example-rules.md` for
ready-to-adapt examples before writing your first rule.

**Do not edit `CLAUDE.md`.** The hooks are the only delivery mechanism; rules live entirely in
`.claude/rules/`.

## Process

### Step 1 - Make sure the rules directory exists

Rules live in `.claude/rules/` at the project root. If it does not exist yet, create it. On the very
first rule, also drop a short `README.md` in that folder (it is ignored by the hooks) so a teammate
opening the repo understands what the folder is:

```
.claude/rules/README.md
```
> These are live-rules: Markdown rule files that Claude Code injects into context automatically when
> they apply. See the live-rules plugin for the format. Edit or add files freely; changes take effect
> on the next prompt. Commit this folder so the whole team shares the rules.

### Step 2 - Understand the rule

Pin down two things from the user's request:

1. **The instruction** itself: what should Claude do, prefer, or avoid? Keep it concrete and
   testable (*"use `httpx`, not `requests`"*) rather than vague (*"write good code"*).
2. **When it applies** (the scope). Listen for the trigger in how they phrase it:

| The user says... | Scope | Frontmatter |
|------------------|-------|-------------|
| "always", "in general", "house style", no condition | **global** | no scope fields |
| "when editing / for / in *.tsx", a file type or path | **path/glob** | `globs:` |
| "when working in packages/api", a directory/area | **directory** | `dirs:` |
| "when I ask about / mention deploy/migration/auth" | **prompt-keyword** | `prompt:` |

A rule can combine scopes (e.g. `globs` + `prompt`); it is injected when any of its conditions
match. If you are unsure whether something is global or scoped, ask one short question rather than
guessing, because an over-broad rule adds noise to every prompt.

### Step 3 - Write the rule file

Pick a short, descriptive kebab-case filename ending in `.md` (e.g. `no-em-dashes.md`,
`react-components.md`, `sql-parameterized.md`). Then write the file:

```markdown
---
description: Short human title (also shown as the rule's heading when injected)
globs: ["**/*.tsx"]        # include only the scope fields that apply; omit the rest
priority: 0                 # optional; higher injects first (default 0)
enabled: true              # optional; default true
---
- Write the rule body as tight, imperative bullet points.
- One concern per file; create a second rule file rather than overloading this one.
```

Guidelines for a good rule:
- **Imperative and concrete.** "Do X", "Never Y", with a real symbol/path/command where possible.
- **Short.** Injected context is capped (~10k chars across all matching rules), so keep each body to
  a handful of lines. Long rationale belongs in a linked doc, not the rule.
- **Atomic.** One rule per file. It keeps scoping precise and lets the user disable just that one.
- **Globs are gitignore-style:** a pattern with no `/` (like `*.sql`) matches that name at any depth;
  a pattern with a `/` (like `src/**/*.ts`) is anchored to the repo-relative path. See
  `references/rule-format.md`.

### Step 4 - Validate

Before finishing:
- Confirm any `globs` actually correspond to files that exist (or clearly will) in this repo, so the
  rule will really fire. If a glob matches nothing, say so.
- If a `prompt` entry is a `/regex/flags`, make sure it is a valid expression.
- Re-read the body: is it short, concrete, and free of contradictions with existing rules? Skim the
  other files in `.claude/rules/` for overlap or conflicts.

### Step 5 - Confirm

Tell the user what you created: the filename, the scope (when it will fire), and a one-line summary.
Remind them that it takes effect on the **next prompt** (no restart) and to **commit
`.claude/rules/`** so the team shares it. Note they can disable it any time by setting
`enabled: false` (or via the manage-rules skill) instead of deleting it.

## Guidelines

- **Never touch `CLAUDE.md`** (or `CLAUDE.local.md`). Rules live only in `.claude/rules/`.
- **One concern per file.** Prefer several small rules over one big one.
- **Scope tightly.** Global rules hit every prompt; reserve them for things that truly always apply.
- **Don't leak secrets.** A rule can say where config lives, never actual credential values.

## Success criteria

- [ ] `.claude/rules/` exists (with a `README.md` if it was just created)
- [ ] New rule file written with a `description`, the correct scope fields, and a concise body
- [ ] Scope verified (globs match real paths; any regex compiles)
- [ ] User told the filename, when it fires, and to commit `.claude/rules/`
- [ ] `CLAUDE.md` left untouched

## References

- `references/rule-format.md` - full frontmatter spec, scope semantics, and glob syntax
- `references/example-rules.md` - copy-and-adapt examples for each scope type
