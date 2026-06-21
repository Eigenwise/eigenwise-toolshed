---
name: manage-rules
description: >-
  Inspect and maintain the live-rules in .claude/rules/: list every rule with its scope and status,
  audit them for problems (broken frontmatter, globs that match nothing, duplicates, oversized
  bodies, conflicts), enable or disable a rule, or explain which rules are currently active. Use when
  the user asks to "list my rules", "what rules are active", "show live-rules", "audit my rules",
  "disable the X rule", "enable the X rule", "turn off that rule", "why did Claude get that
  instruction", or "clean up my rules". To create or edit a rule, use add-rule instead.
---

# Manage Rules

Read, audit, and toggle the rules in `.claude/rules/` without changing what any of them say. For
authoring or editing rule content, use the `add-rule` skill. The full format is documented in
`../add-rule/references/rule-format.md`.

If `.claude/rules/` does not exist, there are no rules yet; point the user at `add-rule` to create
the first one.

## Tasks

### List the rules

Read every `*.md` file in `.claude/rules/` (recursively; skip `README.md` and dotfiles), parse the
frontmatter, and present a compact table:

| Rule (file) | Scope | Fires when | Priority | Enabled |
|-------------|-------|-----------|----------|---------|
| house-style.md | global | every prompt | 0 | yes |
| react-components.md | glob | editing `**/*.tsx` | 0 | yes |
| api-layer.md | dir | editing under `packages/api` | 0 | yes |
| deploy-checklist.md | prompt | prompt matches `deploy` | 0 | yes |
| strict-lint.md | glob | editing `**/*.ts` | 0 | **no** |

Derive the scope the same way the hooks do: no scope fields means **global**; otherwise list whichever
of `globs` / `dirs` / `prompt` are present. A rule can have more than one scope.

### Audit the rules

Check each rule and report concrete issues (with the filename):

- **Broken or empty frontmatter** that the parser would skip (e.g. an unterminated `[...]`, a missing
  closing `---`, no body at all).
- **Globs that match nothing** in the repo: compile the glob and test it against the tracked files
  (`git ls-files`, or a recursive listing minus the usual noise dirs). A glob matching zero files is
  probably a typo or a stale path.
- **Invalid prompt regexes** (`/.../flags` that does not compile).
- **Duplicates / conflicts:** two rules giving contradictory instructions, or near-identical rules
  that should be merged.
- **Oversized rules:** a body long enough to crowd the ~10k-char injection budget. Suggest trimming
  or splitting.
- **Over-broad global rules** that would be better scoped (a `*.tsx`-only instruction living as a
  global rule, so it hits every unrelated prompt).

Summarize findings as a short list of "file: problem, suggested fix". Only change files if the user
asks; `add-rule` is the right tool for rewrites.

### Enable or disable a rule

Toggle a rule without deleting it: read the file, set `enabled: true` or `enabled: false` in the
frontmatter (add the field if it is absent), and save. The change takes effect on the next prompt or
edit. Confirm which rule you toggled and its new state.

### Explain what is active

Given a situation ("for a normal prompt", "when I edit `src/app/page.tsx`", "when I say 'deploy'"),
walk the rules and report which ones would be injected and why, mirroring the hook logic:

- **On a prompt:** global rules, plus prompt rules whose pattern matches the text, plus dir rules
  whose directory contains the session's working dir.
- **Before an edit to a file:** glob rules matching that file (gitignore-style: a slash-free pattern
  matches at any depth; a pattern with `/` is repo-anchored), plus dir rules whose directory contains
  it. Global and prompt rules do not fire on edits.

This is the fastest way to answer "why did Claude just follow rule X" or "why didn't it".

## Guidelines

- **Read-and-toggle, not rewrite.** This skill lists, audits, and flips `enabled`. Send content
  changes to `add-rule`.
- **Verify before claiming.** When you say a glob matches nothing, actually test it against the repo
  file list first.
- **Never touch `CLAUDE.md`.** Rules live only in `.claude/rules/`.
- After any change, remind the user to commit `.claude/rules/` so the team stays in sync.

## Success criteria

- [ ] Rules listed with scope, trigger, priority, and enabled state
- [ ] Audit reports real, file-specific issues (globs tested against actual files)
- [ ] Any enable/disable change applied correctly and confirmed
- [ ] `CLAUDE.md` left untouched
