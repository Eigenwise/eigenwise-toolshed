---
name: add-rule
description: >-
  Create or edit a live-rules rule: a frontmatter-plus-body section in the project's live-rules file
  (.claude/live-rules.md by default, or wherever LIVE_RULES_PATH points) that gets injected into
  Claude's context automatically when it applies. Use when the user asks to "add a rule", "create a
  rule", "make a rule that...", "add a coding guideline/guardrail/convention", "enforce that ...",
  "always do X", "whenever I edit *.tsx do Y", "when I work in packages/api do Z", "when my prompt
  mentions 'deploy' remind me to ...", "load my codebase map into every session", "keep file X in
  front of you", or "set up live-rules". Picks the right scope (global, path/glob, directory, or
  prompt-keyword) and writes valid frontmatter, including an `include:` payload to inject a live file's
  contents. To list, audit, enable, or disable existing rules instead, use manage-rules.
---

# Add Rule

Turn a request like *"always run the linter before committing"* or *"when editing `*.tsx`, prefer
function components"* into a **rule** in the project's live-rules file. The plugin's hooks inject each
rule automatically, at the moment it applies, so the user does not have to remember to paste it.

Read `references/rule-format.md` for the full frontmatter spec and `references/example-rules.md` for
ready-to-adapt examples before writing your first rule.

**Do not edit `CLAUDE.md`.** The hooks are the only delivery mechanism; rules live entirely in the
live-rules file.

## Atomic storage

For new workspaces, write each rule as `.claude/live-rules/rules/<stable-name>.md` and maintain
`.claude/live-rules/manifest.json`. Every manifest entry needs the relative rule path, SHA-256 hash, and the
rule's `description`, `globs`, `dirs`, `prompt`, and `enabled` metadata. Write the replacement rule file and
manifest to temporary sibling paths, then rename them so readers never observe half an update. Keep the old
`.claude/live-rules.md` format only for existing projects until it has been migrated.

### Step 1 - Find the rules file

New workspaces use the atomic directory described above. Existing projects may still have one Markdown
file. Resolve that legacy file in this order when migrating or maintaining an existing project:

1. If the `LIVE_RULES_PATH` environment variable is set (commonly in `.claude/settings.json` under
   `env`), that path is the file (it may be project-relative, absolute, or `~`-relative).
2. Otherwise it is `.claude/live-rules.md` at the project root.

If the file does not exist yet, create it with a short title line so a teammate opening it understands
what it is:

```markdown
# Live rules

These rules are re-injected into Claude's context every turn (and before relevant edits) so they stay
in front of the model. Each rule below is a frontmatter block plus body. Edit freely; changes take
effect on the next prompt. Commit this file so the team shares the rules.
```

Anything above the first `---` fence is ignored by the hooks, so this intro is safe.

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

**Including a live file.** If the request is "load my codebase map", "keep `<file>` in front of you",
or "inject the contents of `<file>` every prompt", that is the `include:` field, not a scope. Add
`include: <path>` to the rule and write the body as the protocol for using that file (for a codebase
map: "say which docs you will read, read them before exploring, review the map after edits"). The file
is read fresh each injection, and if it does not exist the rule stays silent. A pure-include rule (no
`globs`/`dirs`/`prompt`) is global, so the file rides along on every prompt. See the "Including a live
file" section of `references/rule-format.md`.

### Step 3 - Append the rule section

Add a new section to the file: a frontmatter block followed by the body. Separate it from the
previous rule with a blank line; the `---` fence is what actually starts a new rule.

```markdown
---
description: Short human title (also shown as the rule's heading when injected)
globs: ["**/*.tsx"]        # include only the scope fields that apply; omit the rest
priority: 0                 # optional; higher injects first (default 0)
enabled: true              # optional; default true
---
- Write the rule body as tight, imperative bullet points.
- One concern per section; add a separate section rather than overloading this one.
```

Guidelines for a good rule:
- **Imperative and concrete.** "Do X", "Never Y", with a real symbol/path/command where possible.
- **Short.** Injected context is capped (~10k chars across all matching rules), so keep each body to
  a handful of lines. Long rationale belongs in a linked doc, not the rule.
- **Atomic.** One concern per section. It keeps scoping precise and lets the user disable just that
  one.
- **No bare `---` in the body.** A line that is exactly `---` would be read as the next rule's fence.
  Use `***` or `___` for a horizontal rule inside a body.
- **Globs are gitignore-style:** a pattern with no `/` (like `*.sql`) matches that name at any depth;
  a pattern with a `/` (like `src/**/*.ts`) is anchored to the repo-relative path. See
  `references/rule-format.md`.

### Step 4 - Validate

Before finishing:
- Confirm any `globs` actually correspond to files that exist (or clearly will) in this repo, so the
  rule will really fire. If a glob matches nothing, say so.
- If a `prompt` entry is a `/regex/flags`, make sure it is a valid expression.
- Re-read the body: is it short, concrete, and free of contradictions with the other sections already
  in the file? Skim them for overlap or conflicts.
- Make sure the new section's fences are intact (an opening `---`, the frontmatter, a closing `---`,
  then the body) so the file still parses cleanly.

### Step 5 - Confirm

Tell the user what you added: the rule's title, the scope (when it will fire), and a one-line summary.
Remind them that it takes effect on the **next prompt** (no restart) and to **commit the live-rules
file** so the team shares it. Note they can disable it any time by setting `enabled: false` (or via
the manage-rules skill) instead of deleting it.

## Guidelines

- **Never touch `CLAUDE.md`** (or `CLAUDE.local.md`). Rules live only in the live-rules file.
- **One concern per section.** Prefer several small rules over one big one.
- **Scope tightly.** Global rules hit every prompt; reserve them for things that truly always apply.
- **Don't leak secrets.** A rule can say where config lives, never actual credential values.

## Success criteria

- [ ] The live-rules file exists (resolved from `LIVE_RULES_PATH` or defaulting to `.claude/live-rules.md`)
- [ ] New rule section appended with a `description`, the correct scope fields, and a concise body
- [ ] Scope verified (globs match real paths; any regex compiles)
- [ ] File still parses (intact fences; no stray `---` in any body)
- [ ] User told the rule's title, when it fires, and to commit the file
- [ ] `CLAUDE.md` left untouched

## References

- `references/rule-format.md` - full frontmatter spec, scope semantics, and glob syntax
- `references/example-rules.md` - copy-and-adapt examples for each scope type
