---
title: live-rules
description: "Project rules in a Markdown file that Claude re-injects right when they apply: every prompt, or just before it edits a matching file. Edits apply on the next prompt, no restart. A SessionStart hook injects the always-on rules once as a fallback, and it's a way to tell whether per-prompt injection is actually wired."
---

<!-- AUTO-GENERATED — do not edit; run npm run generate -->
# live-rules

Project rules in a Markdown file that Claude re-injects right when they apply: every prompt, or just before it edits a matching file. Edits apply on the next prompt, no restart. A SessionStart hook injects the always-on rules once as a fallback, and it's a way to tell whether per-prompt injection is actually wired.

**Version:** `2.7.0`

## Skills

- - `add-rule`: Create or edit a live-rules rule: a frontmatter-plus-body section in the project's live-rules file (.claude/live-rules.md by default, or wherever LIVE_RULES_PATH points) that gets injected into Claude's context automatically when it applies. Use when the user asks to "add a rule", "create a rule", "make a rule that...", "add a coding guideline/guardrail/convention", "enforce that ...", "always do X", "whenever I edit *.tsx do Y", "when I work in packages/api do Z", "when my prompt mentions 'deploy' remind me to ...", "load my codebase map into every session", "keep file X in front of you", or "set up live-rules". Picks the right scope (global, path/glob, directory, or prompt-keyword) and writes valid frontmatter, including an `include:` payload to inject a live file's contents. To list, audit, enable, or disable existing rules instead, use manage-rules.
- - `manage-rules`: Inspect and maintain the live-rules in the project's live-rules file (.claude/live-rules.md by default, or wherever LIVE_RULES_PATH points): list every rule with its scope and status, audit them for problems (broken frontmatter, globs that match nothing, duplicates, oversized bodies, conflicts), enable or disable a rule, or explain which rules are currently active. Use when the user asks to "list my rules", "what rules are active", "show live-rules", "audit my rules", "disable the X rule", "enable the X rule", "turn off that rule", "why did Claude get that instruction", or "clean up my rules". To create or edit a rule, use add-rule instead.

## Hooks

- **SessionStart**: `node "${CLAUDE_PLUGIN_ROOT}/hooks/session-start-rules.js"`
- **UserPromptSubmit**: `node "${CLAUDE_PLUGIN_ROOT}/hooks/inject-prompt-rules.js"`
- **PreToolUse** (Edit|Write|MultiEdit|NotebookEdit): `node "${CLAUDE_PLUGIN_ROOT}/hooks/inject-edit-rules.js"`

## Bin entrypoints

- None

[Source on GitHub](https://github.com/Eigenwise/eigenwise-toolshed/tree/main/plugins/live-rules)
