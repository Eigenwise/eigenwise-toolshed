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
