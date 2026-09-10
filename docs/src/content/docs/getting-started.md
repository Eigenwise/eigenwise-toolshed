---
title: Getting started
description: Install Quartermaster, prepare a project, and choose the Toolshed plugin that fits the job.
---

Eigenwise Toolshed is six independent Claude Code plugins. Start with Quartermaster when you want a guided project setup. Install a different plugin directly when you already know what you need.

## Install Quartermaster

Run these in Claude Code from the project you want to prepare:

```text
/plugin marketplace add Eigenwise/eigenwise-toolshed
/plugin install quartermaster@eigenwise-toolshed --scope project
```

This example uses project scope, which keeps the activation in the repository's settings. After the install, activate the plugin with `/reload-plugins` or by starting a new Claude Code session.

## Choose a scope

Every Toolshed plugin works at user, project, or local scope. Use `--scope project` when the plugin belongs to one repository, `--scope user` when you want it in every project, or `--scope local` when it should stay out of shared settings. The setup examples use project scope, but the choice is yours.

## Prepare your first project

From the project directory, run:

> /quartermaster:setup

Quartermaster reads the project, mines a bounded history summary, asks a few setup questions, and proposes Toolshed plugins, stack plugins, starter rules, and permission entries. It shows the change list and waits for approval before installing or writing anything.

After setup installs the approved plugins and writes the approved files, it pauses. Run `/reload-plugins` to activate the new plugin code. Restart Claude Code instead when setup changed the process environment or wiring that a reload cannot replace. Tell Claude `continue`, then let setup verify each selected workflow after the boundary.

Try one real request after verification:

> Explain the main parts of this codebase and point me to the files I should read first.

If you enabled Codebase Mapper, Claude can use the maintained project map to answer that request. If you chose another plugin, use its guide below for the first workflow.

## Choose your next workflow

Toolshed includes these six plugins:

- [Set up and maintain a workspace](./quartermaster/)
- [Track and deliver owned work](./sidequest/)
- [Add GPT or Grok subscription models](./model-gateway/)
- [Keep a project map nearby](./codebase-mapper/)
- [Load project rules when they apply](./live-rules/)
- [View selected local usage](../observability/)

Quartermaster's updater covers every active Eigenwise Toolshed install in Claude Code's registry, at its recorded user, project, or local scope and project path. It can update an install in another project even when you invoke it from here. Third-party marketplaces are left alone.

Freshness hooks report cached availability and loaded-version mismatches. They do not install plugins or restart Claude Code. Marketplace auto-update is optional and must be enabled for the Eigenwise Toolshed marketplace. After any plugin update, reload affected open sessions. Restart Claude Code when process-level gateway wiring or model discovery changed.

The [generated plugin reference](../reference/) lists the agent-facing skills, hooks, and commands. Maintainer material lives under [contributing](../contributing/), and the separate [support page](https://eigenwise.github.io/eigenwise-toolshed/support/) covers ways to help.
