---
name: manage-rules
description: >-
  Inspect, audit, enable, or disable project live-rules. Use to list rules, check active instructions,
  explain an injected rule, or recover an atomic manifest.
---

# Manage Rules

Read, audit, and toggle live rules without changing what a rule says. For authoring or editing rule
content, use the `add-rule` skill. The full format is documented in
`../add-rule/references/rule-format.md`.

New workspaces use one rule per Markdown file under `.claude/live-rules/rules/` and a generated
`.claude/live-rules/manifest.json`. Never edit the manifest directly. After every rule-file change,
run:

```text
node "${CLAUDE_PLUGIN_ROOT}/scripts/sync-atomic-rules.js" --project "${CLAUDE_PROJECT_DIR}"
```

Existing projects may still use a legacy file. The default is `.claude/live-rules.md`; an explicit
`LIVE_RULES_PATH` may point to another project-relative, absolute, or `~`-relative file. The legacy
format is for migration or an explicit override only. SessionStart automatically migrates the default
legacy file, verifies the atomic result, and removes the old file. An explicit path is preserved, and a
failed verification keeps the legacy file.

## Find the rules and manifest

Check the atomic directory first:

1. If `.claude/live-rules/rules/` exists, inspect its `.md` files and the generated manifest.
2. If the directory exists but `manifest.json` is missing, malformed JSON, or has the wrong schema,
   report an **atomic manifest recovery problem**, not "no rules". Run the sync command above to rebuild
   the manifest from the rule files, then audit again.
3. If the manifest is parseable but hashes or metadata do not match the rule files, report a stale
   manifest. The runtime reads the rule files directly and marks the mismatch; run sync to resync it.
4. If the atomic directory is absent, resolve the legacy file from `LIVE_RULES_PATH` or the default
   path. If that file exists, report legacy storage and explain that SessionStart can migrate it. If no
   atomic directory and no legacy file exist, report that no rules are configured and point the user to
   `add-rule`.

A missing or malformed manifest with atomic rule files is never a clean no-rules result. Preserve the
rule files while recovering it. If sync names a malformed rule file, repair that file and run sync again.

## How to read the files

For atomic storage, inspect every `.md` rule under `.claude/live-rules/rules/`. Each file must contain
exactly one rule. Compare its parsed metadata and content hash with the corresponding manifest entry.
For legacy storage, parse the file as a sequence of frontmatter sections. Anything before the first
fence is an intro; a bare file with no complete frontmatter block is one global rule.

## Tasks

### List the rules

Parse every section or atomic file and present a compact table. Use the `description` as the rule name,
fallback to the filename or position:

| Rule | Storage | Scope | Fires when | Priority | Enabled |
|------|---------|-------|-----------|----------|---------|
| House style | atomic | global | matching prompt when unseen or changed | 0 | yes |
| React component conventions | atomic | glob | editing `**/*.tsx` when unseen or changed | 0 | yes |
| API layer rules | atomic | dir | editing under `packages/api`, or matching cwd | 0 | yes |
| Deploy checklist | atomic | prompt | prompt matches `deploy` when unseen or changed | 0 | yes |
| Strict lint gate | atomic | glob | matching edit | 0 | **no** |

Derive scope the same way as the hooks: no `globs`, `dirs`, or `prompt` means global; otherwise list
whichever are present. A rule with only `include:` is still global. Note the include payload and
whether its target exists.

### Audit the rules

Check the storage and manifest before checking individual rules. Report concrete issues and the exact
recovery:

- **Missing or malformed atomic manifest:** `.claude/live-rules/rules/` exists but `manifest.json` is
  absent, invalid JSON, or has an unsupported shape. Run the owned sync command; do not report no rules.
- **Stale atomic manifest:** a rule hash, path, or metadata field differs from the generated value. The
  rule files are the authority; run sync to resync the manifest.
- **Dropped atomic rule:** a manifest entry points to a missing or unsafe path, or a file contains more
  than one rule. Name the file, repair it, and run sync.
- **Broken or empty frontmatter** that the parser would skip, such as an unterminated array, missing
  closing `---`, or no body.
- **A stray `---` inside a body**, which the parser reads as the next rule's fence. Suggest `***` or
  `___` instead.
- **Globs that match nothing** in the repo. Compile the glob and test it against tracked files before
  reporting it.
- **Invalid prompt regexes** written as `/.../flags`.
- **An `include:` target that does not exist.** A rule whose includes are all missing is dropped and
  injects nothing.
- **Duplicates or conflicts:** contradictory instructions or near-identical rules that should be merged.
- **Oversized rules:** a body long enough to crowd the roughly 10k-character injection budget.
- **Over-broad global rules** that should be scoped to a file, directory, or prompt.
- **Unexpected legacy storage:** explain the migration or explicit `LIVE_RULES_PATH` exception and
  check whether SessionStart can migrate it.

Summarize findings as a short list of "rule or manifest: problem, suggested fix". Only change content
if the user asks. `add-rule` is the right tool for content rewrites; manifest recovery uses the sync
command.

### Enable or disable a rule

Toggle a rule without deleting it: find its atomic file or legacy section, set `enabled: true` or
`enabled: false` in its frontmatter, and save. For atomic storage, run sync after saving so the
manifest records the new metadata. Leave other files and sections untouched. Confirm which rule you
toggled and its new state.

### Explain what is active

Given a situation such as "for a normal prompt", "when I edit `src/app/page.tsx`", or "when I say
'tdeploy'", walk the rules and report which ones are eligible and why, mirroring the hook logic:

- **At SessionStart:** applicable startup rules are injected and the session ledger is reset.
- **On a prompt:** global rules, matching prompt rules, and directory rules whose directory contains the
  session cwd are selected; only new or changed unseen hashes are emitted after SessionStart.
- **Before an edit:** glob rules matching that file and directory rules containing it are selected;
  only new or changed unseen hashes are emitted.

A rule carrying `include:` fires only if at least one included file exists. If all are missing it is
dropped. Explain whether a selected rule was already seen unchanged in this session or is newly matching,
so "why did Claude follow this?" and "why didn't it?" have a concrete answer.

## Guidelines

- **Read and toggle, not rewrite.** Send content changes to `add-rule`.
- **Recover manifests from source files.** Never hand-edit generated JSON.
- **Verify before claiming.** Test a glob against the repo file list and inspect include targets.
- **Never touch `CLAUDE.md`** or `CLAUDE.local.md`.
- After a change, remind the user to review and commit the atomic rule files and generated manifest so
the team stays in sync.

## Success criteria

- [ ] Atomic directory, rule files, manifest, and legacy fallback are distinguished
- [ ] Missing or malformed manifests are reported as recovery problems, never as clean no-rules
- [ ] Existing resync command is run or clearly directed when the manifest is missing or stale
- [ ] Rules are listed with storage, scope, trigger, priority, and enabled state
- [ ] Audit reports real, rule-specific issues and tests globs against actual files
- [ ] Any enable/disable change applies to the right file or section and is synced when atomic
- [ ] `CLAUDE.md` is untouched
