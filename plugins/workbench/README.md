# Workbench

Workbench sets up a Claude Code workspace, keeps Eigenwise Toolshed plugins current, and checks workspace health.

[Setup guide](https://eigenwise.github.io/eigenwise-toolshed/getting-started/workbench/) · [Generated reference](https://eigenwise.github.io/eigenwise-toolshed/reference/workbench/) · [Toolshed marketplace](../../README.md)

## Install

Run these in Claude Code:

```text
/plugin marketplace add Eigenwise/eigenwise-toolshed
/plugin install workbench@eigenwise-toolshed --scope user
```

Reload plugins or start a new Claude Code session, then tell Claude:

> Set up this project as a Claude Code workspace with Workbench.

Claude asks about the project and the workspace tools you want, installs the selected plugins, writes the project `.claude/` files, and verifies the result. Workbench stays at user scope so it is available across projects.

## Daily use

Tell Claude what you need:

> Update my Eigenwise Toolshed plugins.

> Check whether this workspace and its Toolshed plugins are healthy.

Workbench updates only Eigenwise Toolshed plugins and Model Gateway when installed. It leaves third-party plugins alone and tells you when an affected session needs `/reload-plugins` or a restart.

## If something stops working

Tell Claude the symptom and ask it to run a Workbench health check. For a stale-plugin warning, ask Claude to update the Toolshed, then reload plugins or restart Claude Code before retrying. If setup stopped with an error, include that error when you ask Claude to resume or rerun the setup.

## License

MIT
