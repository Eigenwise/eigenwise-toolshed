---
title: Workbench setup
description: Set up and maintain a Claude Code workspace with Workbench.
---

Workbench sets up a Claude Code workspace, keeps Eigenwise Toolshed plugins current, and checks workspace health.

## Install

Run these in Claude Code:

```text
/plugin marketplace add Eigenwise/eigenwise-toolshed
/plugin install workbench@eigenwise-toolshed --scope user
```

Reload plugins or start a new Claude Code session. Workbench belongs at user scope because it is the workspace manager you use across projects.

## Set up a project

From the project directory, tell Claude:

> Set up this project as a Claude Code workspace with Workbench.

Workbench asks about telemetry, the project, and the plugins and workspace choices that fit. After you approve the plan, it installs the selected plugins, writes the project `.claude/` files, asks for one plugin reload, and verifies the setup. It keeps existing Claude configuration and rules when it adds its own files.

If you choose telemetry, Claude handles the Observability setup and tells you when a restart is needed. You can also decline and continue without it.

## Daily use

Tell Claude what you want to do:

> Update my Eigenwise Toolshed plugins.

> Check whether this workspace and its Toolshed plugins are healthy.

> Why is this session using an older Workbench version?

Claude uses the bundled update or doctor skill, tells you what it found, and asks you to reload or restart when the installed code is newer than the session. Updates cover the Eigenwise Toolshed marketplace and Model Gateway when it is installed. Third-party plugins are left alone.

## TypeScript code intelligence

Workbench includes a local `code-intel` MCP server with three pull-only tools: `typescript_definition`, `typescript_references`, and `typescript_diagnostics`. Each call binds to an explicit project root and uses that project's own TypeScript install. TypeScript 7 projects use the native TypeScript language server. TypeScript 5 projects use `typescript-language-server` instead.

This replaces the official `typescript-lsp` plugin. Its push diagnostics are process-global and cannot tell which agent owns them, so diagnostics from parallel isolated worktrees can land in the wrong transcript. If it is installed, remove it and reload plugins:

```text
/plugin uninstall typescript-lsp@claude-plugins-official
```

The tools need a TypeScript 7 install resolvable from the project, for example:

```text
npm install -D typescript@latest
```

For a TypeScript 5 project, install `typescript-language-server` instead.

## If something stops working

- **Setup stopped before the workspace was ready:** tell Claude to resume or rerun the Workbench workspace setup and include the last error.
- **A prompt says the Toolshed is stale:** ask Claude to update the Toolshed, then run `/reload-plugins` or restart Claude Code before resubmitting the prompt.
- **A plugin or workspace check fails:** say which plugin or workflow failed and ask Claude to run a Workbench health check. It will give you the smallest next step.
- **New plugin skills are missing after an install:** reload plugins or start a new session.

The [generated Workbench reference](/reference/workbench/) contains the agent-facing skill and command details.
