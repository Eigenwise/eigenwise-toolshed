---
name: add-rule
description: >-
  Create or edit a live-rules instruction in the project's atomic rule set. Use to add a rule,
  coding guideline, guardrail, convention, or automatic reminder.
---

# Add Rule

Turn a request like *"always run the linter before committing"* or *"when editing `*.tsx`, prefer
function components"* into a **rule**. New workspaces keep one rule per Markdown file under
`.claude/live-rules/rules/`, with a generated manifest beside them. The hooks inject a rule at
SessionStart when it applies, then only when it newly matches or its content/hash changes during the
session.

Read `references/rule-format.md` for the full frontmatter spec and `references/example-rules.md` for
ready-to-adapt examples before writing a rule.

**Do not edit `CLAUDE.md`.** Live Rules owns its rule files and generated manifest; the hooks are the
delivery mechanism.

## Atomic storage

For new workspaces, create or edit one rule file under `.claude/live-rules/rules/`. Use a stable,
descriptive filename such as `commit-checks.md`. After adding or editing a rule, run the plugin-owned
sync command from the project root:

```text
node "${CLAUDE_PLUGIN_ROOT}/scripts/sync-atomic-rules.js" --project "${CLAUDE_PROJECT_DIR}"
```

Sync derives every manifest hash and metadata field from the rule files, validates a stable read, and
atomically replaces only the generated manifest under a writer lock. Rule files remain authoritative
and are never rewritten by sync. Never author or repair `.claude/live-rules/manifest.json` by hand. If
sync fails, fix the exact file it names, then run the same command again.

Existing projects may still have a legacy `.claude/live-rules.md` file. The default SessionStart
migration converts it to atomic files, verifies that the rules match, and removes the old file. An
explicit `LIVE_RULES_PATH` is preserved, and a failed verification keeps the legacy file. Treat the
single-file format as migration or explicit-override storage only. Do not choose it for new work.

## Step 1: Understand the rule

Pin down two things from the user's request:

1. **The instruction** itself: what should Claude do, prefer, or avoid? Keep it concrete and testable
   (*"use `httpx`, not `requests`*) rather than vague (*"write good code"*).
2. **When it applies** (the scope). Listen for the trigger in how they phrase it:

| The user says... | Scope | Frontmatter |
|------------------|-------|-------------|
| "always", "in general", "house style", no condition | **global** | no scope fields |
| "when editing / for / in *.tsx", a file type or path | **path/glob** | `globs:` |
| "when working in packages/api", a directory/area | **directory** | `dirs:` |
| "when I ask about / mention deploy/migration/auth" | **prompt-keyword** | `prompt:` |

A rule can combine scopes, such as `globs` plus `prompt`; it is injected when any condition matches.
If you are unsure whether something is global or scoped, ask one short question rather than guessing,
because an over-broad rule adds noise.

**Including a live file.** If the request is "load my codebase map", "keep `<file>` in front of
you", or "inject the contents of `<file>`", use the `include:` field, not a scope. Add
`include: <path>` and write the body as the protocol for using that file. The file is read fresh each
time the rule is injected, and a missing include makes the rule silent. A pure-include rule is global.
See the "Including a live file" section of `references/rule-format.md`.

## Step 2: Write the rule and sync it

Create or edit one file under `.claude/live-rules/rules/`, then run the sync command from **Atomic
storage**. Do not edit the manifest. A rule file contains one frontmatter block and one body:

```markdown
---
description: Short human title (also shown as the rule's heading when injected)
globs: ["**/*.tsx"]     # include only the scope fields that apply; omit the rest
priority: 0              # optional; higher injects first (default 0)
enabled: true            # optional; default true
---
- Write the rule body as tight, imperative bullet points.
- One concern per file; add another rule file rather than overloading this one.
```

For a project that deliberately sets `LIVE_RULES_PATH`, maintain the explicitly requested legacy file
only when the user wants that override. Keep the same frontmatter and body rules, and do not claim it
is the default storage path.

Guidelines for a good rule:

- **Imperative and concrete.** "Do X", "Never Y", with a real symbol, path, or command where possible.
- **Short.** Injected context is capped at about 10k characters across all matching rules, so keep each
  body to a handful of lines. Long rationale belongs in a linked doc.
- **Atomic.** One concern per file. It keeps scoping precise and lets the user disable just that one.
- **No bare `---` in the body.** A line that is exactly `---` would be read as another rule's fence.
  Use `***` or `___` for a horizontal rule inside a body.
- **Globs are gitignore-style:** a pattern with no `/` (like `*.sql`) matches that name at any depth;
  a pattern with a `/` (like `src/**/*.ts`) is anchored to the repo-relative path.

## Step 3: Validate

Before finishing:

- Confirm any `globs` correspond to files that exist, or clearly will, in this repo. If a glob matches
  nothing, say so.
- If a `prompt` entry is a `/regex/flags`, make sure it is valid.
- Re-read the body: is it short, concrete, and free of contradictions with the other rules? Skim them
  for overlap or conflicts.
- Make sure the frontmatter fences are intact and the file contains exactly one rule.
- Run the sync command and confirm it succeeds. If the manifest is missing or malformed, sync rebuilds
  it from the rule files; do not patch the JSON by hand.

## Step 4: Confirm

Tell the user what you added: the rule's title, the scope, and a one-line summary. Explain that
SessionStart injects applicable rules first, then the hooks inject only newly matching or changed
unseen hashes during the session. A content change takes effect on the next prompt or relevant edit;
unchanged rules do not repeat on every prompt. Remind them to review and commit the atomic rule files
and generated manifest so the team shares the rules. They can disable a rule any time by setting
`enabled: false` or using `manage-rules`.

## Guidelines

- **Never touch `CLAUDE.md`** or `CLAUDE.local.md`.
- **One concern per file.** Prefer several small rules over one large one.
- **Scope tightly.** Global rules hit every prompt that has not already seen that rule in the session;
  reserve them for instructions that truly apply everywhere.
- **Don't leak secrets.** A rule can say where config lives, never actual credential values.

## Success criteria

- [ ] A new or edited rule file exists under `.claude/live-rules/rules/`, unless the user explicitly
      requested a `LIVE_RULES_PATH` override
- [ ] The rule has a `description`, the correct scope fields, and a concise body
- [ ] Scope is verified (globs match real paths; any regex compiles)
- [ ] The rule file parses as exactly one rule with intact fences and no stray `---` in its body
- [ ] The plugin-owned sync command succeeds and the generated manifest matches the rule files
- [ ] User told the rule's title, when it fires, and the SessionStart/changed-hash cadence
- [ ] `CLAUDE.md` is untouched

## References

- `references/rule-format.md` - full frontmatter spec, atomic storage, migration, cadence, scope semantics, and glob syntax
- `references/example-rules.md` - copy-and-adapt examples for each scope type
