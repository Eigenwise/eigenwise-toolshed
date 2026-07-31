---
title: Live Rules setup
description: Add project rules that Claude Code injects when they apply.
---

Live Rules keeps project instructions in front of Claude Code at the prompts and edits where they apply.

```text
/plugin install live-rules@eigenwise-toolshed
```

1. Ask Claude to add a rule in plain language, such as “always run the linter before committing.” The `add-rule` skill writes the rule under `.claude/live-rules/rules/` for new workspaces.
2. The plugin runs `node "${CLAUDE_PLUGIN_ROOT}/scripts/sync-atomic-rules.js" --project "${CLAUDE_PROJECT_DIR}"` to validate the rule files and atomically update the generated manifest. Rule files remain the source of truth, so don't edit the manifest by hand.
3. Rules can apply globally, to a file glob, to a directory, or when a prompt matches a keyword pattern. A change is live immediately, no restart needed — a global or prompt-keyword rule injects on your very next prompt, while a glob or directory rule injects the next time you edit a matching file or work in that directory.

Use `manage-rules` to list and audit rules, explain which rules are active, or enable and disable a rule. Use `add-rule` when you need to create or edit the rule's content.

## Upgrading from the old layout

Older installs stored all rules in one `.claude/live-rules.md` file. That monolith is retired. On session start, the plugin migrates it to `.claude/live-rules/rules/*.md` and the generated manifest, then loads the migrated set back and compares every rule field for field. Only after the rules match is the monolith removed. The deletion shows up in git, so commit it with the rest of the migration.

If verification fails, both files stay in place and the injected notice names the rule that differs. If `LIVE_RULES_PATH` points to an explicit file, the plugin respects that path and never deletes it.
