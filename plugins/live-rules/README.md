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

Claude writes the rule with the right scope. Global rules land at session start; file, directory, and keyword rules arrive the first time they match. After that a rule comes back only when its text changes, so rules do not repeat on every prompt. Content changes take effect on the next prompt or relevant edit, with no restart.

Commit the project rules so your team gets the same guidance.

## Daily use

Tell Claude what you need:

> List and audit the live rules in this project.

> Which rules are active when you edit `src/api/client.ts`?

> Disable the strict lint rule for now.

Ask Claude to add or edit rule content with `add-rule`. Use `manage-rules` to list, audit, explain, enable, or disable rules. Live Rules does not edit `CLAUDE.md`.

## If something stops working

Tell Claude the symptom and ask it to audit the live rules. If no rules appear, check that the plugin is enabled and the project has its rules file, then reload plugins or restart Claude Code. If rules stopped after an install or update, the current session has stale hook wiring and needs the same reload or restart.

## License

MIT
