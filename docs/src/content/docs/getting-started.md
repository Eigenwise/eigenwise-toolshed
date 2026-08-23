---
title: Getting started
description: Install Quartermaster, prepare a project, and choose the next Toolshed workflow.
---

Eigenwise Toolshed is a set of Claude Code plugins for setting up a project and keeping work moving. Start with Quartermaster, then add the plugin that matches the job.

## Install Quartermaster

Run these in Claude Code from the project you want to prepare:

```text
/plugin marketplace add Eigenwise/eigenwise-toolshed
/plugin install quartermaster@eigenwise-toolshed --scope project
```

This example uses project scope. Reload plugins or start a new Claude Code session.

## Choosing a scope

Every Toolshed plugin works at user, project, or local scope. The examples use `--scope project`: use `--scope user` to load a plugin in every project, `--scope project` to record it in this repository, or `--scope local` to keep it out of shared settings.

## Prepare your first project

From the project directory, run:

> /quartermaster:setup

Quartermaster asks which project tools fit, installs the selected plugins for that project, writes the project configuration, and asks you to reload before verifying the result. You approve the plan before it changes the workspace.

When setup finishes, try one real request in the same project:

> Explain the main parts of this codebase and point me to the files I should read first.

If you enabled Codebase Mapper, Claude can use the maintained project map to answer that request. If you chose other plugins, their guides show the first workflow to try.

## Choose your next workflow

The marketplace currently publishes six plugins: Quartermaster, Sidequest, Model Gateway, Codebase Mapper, Live Rules, and Observability.

- [Set up and maintain a workspace](./quartermaster/)
- [Plan and deliver tracked work](./sidequest/)
- [Add GPT or Grok subscription models](./model-gateway/)
- [Keep a project map nearby](./codebase-mapper/)
- [Load project rules when they apply](./live-rules/)
- [Run a human-judged comparison](./experiments/)
- [View selected local usage](../observability/)

![Sidequest board with three synthetic projects and a populated work queue](../../assets/screenshots/sidequest-kanban.png)

*An isolated synthetic board view from the Sidequest workflow guide.*

Quartermaster can install selected plugins during setup, update Toolshed plugins later, and check workspace health. Reload plugins or start a new session after an install or update so Claude sees the new version.

The [generated plugin reference](../reference/) lists the agent-facing skills, hooks, and commands for each plugin.
