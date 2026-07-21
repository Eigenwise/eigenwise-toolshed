---
title: Getting started
description: Install the marketplace, reload Claude Code, and start a workspace.
---

Eigenwise Toolshed is a Claude Code plugin marketplace. Add it once, install the plugins you need, then reload Claude Code so the new skills and hooks are discovered.

```text
/plugin marketplace add Eigenwise/eigenwise-toolshed
/plugin install workbench@eigenwise-toolshed --scope user
```

Install project plugins with `--scope project` when their settings should travel with the repository. Claude Code only loads a plugin at the reload boundary, so start a new session after installing or updating one.

## First workspace

With Workbench installed, run the workspace setup skill from the project you want to prepare:

```text
/workbench:init-workspace
```

It walks through project-side configuration, then writes the `.claude/` files the project selected. Install `codebase-mapper` when you want a maintained map of the codebase, and `live-rules` when rules should be injected as prompts and edits happen. When Sidequest is also installed and ready for bounded map artifacts, codebase-mapper tracks existing-project mapping there and leaves the generated map in the working tree for review.

For local usage data, opt in separately with `/workbench:enable-project-telemetry`. See [observability](./observability/) before enabling it.
