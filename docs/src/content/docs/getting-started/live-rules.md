---
title: Live Rules setup
description: Add project rules that Claude Code injects when they apply.
---

Live Rules keeps project instructions in front of Claude Code when they apply to a prompt or edit. Use it for conventions, guardrails, and reminders that should follow the project instead of relying on memory.

## Install

Run these in Claude Code from the project where the rules should live:

```text
/plugin marketplace add Eigenwise/eigenwise-toolshed
/plugin install live-rules@eigenwise-toolshed --scope project
```

Reload plugins or start a new Claude Code session. If you use Quartermaster to set up a workspace, it can install and configure Live Rules as part of that setup.

## Add your first rule

From the project directory, tell Claude what should happen and when:

> Add a rule that runs the linter before every commit.

New workspaces use atomic storage. Claude creates one Markdown file under `.claude/live-rules/rules/` for the rule and runs the plugin-owned sync command to generate `.claude/live-rules/manifest.json`. The rule files are authoritative, so the manifest is never edited by hand. The `add-rule` skill reads the full format and examples before authoring.

SessionStart injects the rules that apply at startup. During the session, a rule is injected again only when it newly matches or its content/hash changes and has not been seen in that session. Unchanged rules do not repeat on every prompt or edit. A rule change takes effect on the next prompt or relevant edit, with no restart.

Existing projects may still use the legacy `.claude/live-rules.md` format. It is for migration or an explicit `LIVE_RULES_PATH` override, not the default for new rules. On SessionStart, the plugin automatically converts the default legacy file into atomic storage, verifies that the rules match, and removes the old file. An explicit `LIVE_RULES_PATH` file is preserved. If verification fails, the old file stays in place. Review and commit the resulting rule files and manifest so your team gets the same guidance.

## Daily use

Tell Claude what you need:

> List and audit the live rules in this project.

> Which rules are active when you edit `src/api/client.ts`?

> Disable the strict lint rule for now.

Use `add-rule` when the instruction itself needs to change. Use `manage-rules` to list, audit, explain, enable, or disable rules. Live Rules does not edit `CLAUDE.md`.

## If something stops working

- **A rule does not appear:** ask Claude to explain which rules are active for the prompt or file. The rule may be scoped to a different trigger, or it may already have been seen unchanged in this session.
- **Atomic rule files exist but no rules appear:** ask Claude to audit the live rules. A missing or malformed `.claude/live-rules/manifest.json` is a manifest recovery problem, not a clean no-rules result. The audit runs the plugin-owned sync command to rebuild it from `.claude/live-rules/rules/`.
- **No atomic directory exists:** check the legacy path resolved from `LIVE_RULES_PATH` or the default `.claude/live-rules.md`. An existing default legacy file is migrated automatically at SessionStart; an explicit path is preserved.
- **Migration verification fails:** the old legacy file remains in place. Fix the named rule or storage issue, then run the migration or sync again. Do not delete the old file by hand.
- **Rules worked earlier but stopped after installing or updating the plugin:** reload plugins or start a new session so Claude loads the current hooks.
- **A rule is malformed or two rules run together:** ask Claude to audit and repair the rule file, then sync the atomic manifest and review the resulting project changes.

The [generated Live Rules reference](../../reference/live-rules/) contains the agent-facing format and hook details.
