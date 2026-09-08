# Live Rules

Live Rules keeps project instructions in front of Claude Code when they apply to a prompt or edit. Use it for conventions, guardrails, and reminders that should follow the project instead of relying on memory.

[Setup guide](https://eigenwise.github.io/eigenwise-toolshed/getting-started/live-rules/) · [Generated reference](https://eigenwise.github.io/eigenwise-toolshed/reference/live-rules/) · [Toolshed marketplace](../../README.md)

## Install

Run these in Claude Code from the project where the rules should live:

```text
/plugin marketplace add Eigenwise/eigenwise-toolshed
/plugin install live-rules@eigenwise-toolshed --scope project
```

Reload plugins or start a new Claude Code session. The workspace setup flow can also install and configure Live Rules.

## Add a rule

Tell Claude the instruction and when it applies:

> Add a rule that runs the linter before every commit.

New workspaces use atomic storage: one Markdown rule per file under `.claude/live-rules/rules/`, plus a generated `.claude/live-rules/manifest.json`. The `add-rule` skill reads the rule format and examples before authoring, then runs the plugin-owned sync command. Rule files are the source of truth; never hand-edit the manifest.

SessionStart injects the rules that apply at startup. During the session, a rule is injected again only when it newly matches or its content/hash changes. An unchanged rule does not repeat on every prompt or edit. Content changes take effect on the next prompt or relevant edit, with no restart.

Existing projects may still use the legacy `.claude/live-rules.md` format. It is migration or explicit-override storage, not the default for new rules. On SessionStart, the plugin automatically migrates the default legacy file into atomic storage, verifies that the rules match, and removes the old file. A `LIVE_RULES_PATH` override is preserved, and a failed verification keeps the old file in place. Review the resulting files and commit the project rules so your team gets the same guidance.

## Daily use

Tell Claude what you need:

> List and audit the live rules in this project.

> Which rules are active when you edit `src/api/client.ts`?

> Disable the strict lint rule for now.

Ask Claude to add or edit rule content with `add-rule`. Use `manage-rules` to list, audit, explain, enable, or disable rules. Live Rules does not edit `CLAUDE.md`.

## If something stops working

Tell Claude the symptom and ask it to audit the live rules. The audit checks both the rule files and generated manifest. If `.claude/live-rules/rules/` exists but `manifest.json` is missing, malformed, or out of sync, run the plugin-owned sync command to rebuild it. If no atomic rules exist, check the legacy path resolved from `LIVE_RULES_PATH` or the default `.claude/live-rules.md`, then reload plugins or restart Claude Code after an install or update.

Migration can write and remove tracked project files at SessionStart as described above. Review those changes before committing. An explicit `LIVE_RULES_PATH` is never deleted by automatic migration, and verification failure leaves the legacy file for recovery.

## Support

Optional support is welcome through [Ko-fi](https://ko-fi.com/eigenwise) or [GitHub Sponsors](https://github.com/sponsors/Eigenwise).

## License

MIT
