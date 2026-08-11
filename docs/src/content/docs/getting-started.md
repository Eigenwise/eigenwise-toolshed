---
title: Getting started
description: Install Workbench, prepare a project, and choose the next Toolshed workflow.
---

Eigenwise Toolshed is a set of Claude Code plugins for setting up a project and keeping work moving. Start with Workbench, then add the plugin that matches the job.

## Install Workbench

Run these in Claude Code:

```text
/plugin marketplace add Eigenwise/eigenwise-toolshed
/plugin install workbench@eigenwise-toolshed --scope user
```

Reload plugins or start a new Claude Code session. Workbench is user-scoped so it can prepare more than one project.

## Prepare your first project

From the project directory, tell Claude:

> Set up this project as a Claude Code workspace with Workbench.

Workbench asks which project tools you want, installs the selected plugins, writes the project configuration, and checks the result. You approve the plan before it changes the workspace.

When setup finishes, try one real request in the same project:

> Explain the main parts of this codebase and point me to the files I should read first.

If you enabled Codebase Mapper, Claude can use the maintained project map to answer that request. If you chose other plugins, their guides show the first workflow to try.

## Choose your next workflow

- [Set up and maintain a workspace](./getting-started/workbench/)
- [Plan and deliver tracked work](./getting-started/sidequest/)
- [Add GPT or Grok subscription models](./getting-started/model-gateway/)
- [Keep a project map nearby](./getting-started/codebase-mapper/)
- [Load project rules when they apply](./getting-started/live-rules/)
- [Set up workspaces, and work out what they are short of](./getting-started/quartermaster/)
- [Run a human-judged comparison](./getting-started/experiments/)
- [View selected local usage](./observability/)

You can ask Workbench to install or update the Toolshed plugins later. Claude handles the plugin-owned setup, checks, and recovery steps. Reload plugins or start a new session after an install or update so Claude sees the new version.

The [generated plugin reference](/reference/) lists the agent-facing skills, hooks, and commands for each plugin.
