# code-and-ode: a Live Rules example

This is the small companion to [`../haiku-jar`](../haiku-jar). Its one project rule asks Claude to
write code with the old Poetry of Code spirit.

Install Live Rules once from Claude Code, then reload plugins or start a new session:

```text
/plugin marketplace add Eigenwise/eigenwise-toolshed
/plugin install live-rules@eigenwise-toolshed --scope project
```

The committed `.claude/settings.json` enables that installed plugin without pointing at a local
checkout. The atomic rule lives in `.claude/live-rules/rules/code-as-poetry.md`; its generated manifest
keeps the file hash and metadata. Edit the rule through Live Rules' `add-rule` flow so the manifest
stays in sync.

SessionStart supplies applicable rules to the main session and SubagentStart supplies them to native
subagents. Later prompt or edit hooks inject a rule only when it newly applies or its hash changes,
so unchanged guidance does not keep repeating.

## Toolshed support and task continuity

Toolshed plugin code is free and MIT-licensed. Optional [Ko-fi](https://ko-fi.com/eigenwise) or [GitHub Sponsors](https://github.com/sponsors/Eigenwise) donations support maintenance and are never required to install or use the plugins. Claude, configured model providers and external services may have their own costs.

For durable task tracking, the independently installable [Sidequest](../../plugins/sidequest/README.md) plugin keeps every task saved as a ticket through context compaction and new sessions. Record progress, decisions and next steps on the ticket so the next session can resume from them.
