---
name: manage-rules
description: >-
  Inspect, audit, enable, or disable project live-rules. Use to list rules, check active instructions,
  explain an injected rule, or clean up rules.
---

# Manage Rules

Read, audit, and toggle the rules in the project's live-rules file without changing what any of them
say. For authoring or editing rule content, use the `add-rule` skill. The full format is documented in
`../add-rule/references/rule-format.md`.

## Find the rules file

All rules live in **one Markdown file**. Resolve it in this order:

1. If `LIVE_RULES_PATH` is set (commonly in `.claude/settings.json` under `env`), that path is the
   file (project-relative, absolute, or `~`-relative).
2. Otherwise it is `.claude/live-rules.md` at the project root.

If the file does not exist, there are no rules yet; point the user at `add-rule` to create the first
one.

## How to read the file

The file is a sequence of rule sections. Each rule is a frontmatter block between `---` fences
followed by its body, and the next `---` begins the next rule. Anything before the first fence is a
title or intro and is ignored. Parse each section's frontmatter to get its scope, priority, and
enabled state; the body is the instruction text.

## Tasks

### List the rules

Parse every section and present a compact table (use the `description` as the rule's name, falling
back to its position in the file):

| Rule | Scope | Fires when | Priority | Enabled |
|------|-------|-----------|----------|---------|
| House style | global | every prompt | 0 | yes |
| React component conventions | glob | editing `**/*.tsx` | 0 | yes |
| API layer rules | dir | editing under `packages/api` | 0 | yes |
| Deploy checklist | prompt | prompt matches `deploy` | 0 | yes |
| Strict lint gate | glob | editing `**/*.ts` | 0 | **no** |

Derive the scope the same way the hooks do: no scope fields means **global**; otherwise list whichever
of `globs` / `dirs` / `prompt` are present. A rule can have more than one scope. If a rule also
declares `include:`, note it (e.g. "+ includes `.claude/.codebase-info/INDEX.md`"); `include:` is a
payload, not a scope, so a rule with only `include:` is still global.

### Audit the rules

Check each rule and report concrete issues (name the rule by its description):

- **Broken or empty frontmatter** that the parser would skip (e.g. an unterminated `[...]`, a missing
  closing `---`, no body at all).
- **A stray `---` line inside a body**, which the parser reads as the next rule's fence and which will
  silently split or merge rules. Suggest replacing it with `***` or `___`.
- **Globs that match nothing** in the repo: compile the glob and test it against the tracked files
  (`git ls-files`, or a recursive listing minus the usual noise dirs). A glob matching zero files is
  probably a typo or a stale path.
- **Invalid prompt regexes** (`/.../flags` that does not compile).
- **An `include:` target that does not exist:** resolve each include path (project-relative, or
  absolute / `~`-relative) and check the file is there. A rule whose includes are *all* missing is
  silently dropped and injects nothing, so a broken path means the rule never fires. Flag it.
- **Duplicates / conflicts:** two rules giving contradictory instructions, or near-identical rules
  that should be merged.
- **Oversized rules:** a body long enough to crowd the ~10k-char injection budget. Suggest trimming
  or splitting.
- **Over-broad global rules** that would be better scoped (a `*.tsx`-only instruction living as a
  global rule, so it hits every unrelated prompt).

Summarize findings as a short list of "rule: problem, suggested fix". Only change the file if the user
asks; `add-rule` is the right tool for rewrites.

### Enable or disable a rule

Toggle a rule without deleting it: find its section, set `enabled: true` or `enabled: false` in that
section's frontmatter (add the field if it is absent), and save. Leave the other sections untouched.
The change takes effect on the next prompt or edit. Confirm which rule you toggled and its new state.

### Explain what is active

Given a situation ("for a normal prompt", "when I edit `src/app/page.tsx`", "when I say 'deploy'"),
walk the rules and report which ones would be injected and why, mirroring the hook logic:

- **On a prompt:** global rules, plus prompt rules whose pattern matches the text, plus dir rules
  whose directory contains the session's working dir.
- **Before an edit to a file:** glob rules matching that file (gitignore-style: a slash-free pattern
  matches at any depth; a pattern with `/` is repo-anchored), plus dir rules whose directory contains
  it. Global and prompt rules do not fire on edits.

A rule that carries `include:` only fires if at least one of its included files exists; if they are all
missing it is dropped, so factor that in when explaining why a rule did or did not appear.

This is the fastest way to answer "why did Claude just follow rule X" or "why didn't it".

## Guidelines

- **Read-and-toggle, not rewrite.** This skill lists, audits, and flips `enabled`. Send content
  changes to `add-rule`.
- **Edit surgically.** When toggling one rule, change only that section's frontmatter; do not reflow
  or reorder the rest of the file.
- **Verify before claiming.** When you say a glob matches nothing, actually test it against the repo
  file list first.
- **Never touch `CLAUDE.md`.** Rules live only in the live-rules file.
- After any change, remind the user to commit the live-rules file so the team stays in sync.

## Success criteria

- [ ] Rules listed with scope, trigger, priority, and enabled state
- [ ] Audit reports real, rule-specific issues (globs tested against actual files)
- [ ] Any enable/disable change applied to the right section only and confirmed
- [ ] `CLAUDE.md` left untouched
