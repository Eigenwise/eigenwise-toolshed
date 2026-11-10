---
title: Getting started
description: Install Quartermaster, prepare a project, and choose the Toolshed plugin that fits the job.
---

Eigenwise Toolshed is seven independent Claude Code plugins. Start with Quartermaster when you want a guided project setup. Install a different plugin directly when you already know what you need.

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

Setup does the work and you make the calls. It reads the project, mines a bounded history summary, asks a few questions, and proposes Toolshed plugins, stack plugins, starter rules, and permission entries one at a time. Nothing installs or gets written until you approve it. It then installs and writes what you approved and stops at the reload boundary. Run `/reload-plugins` to activate the new plugin code, or restart Claude Code when setup changed the process environment or wiring that a reload cannot replace. Tell Claude `continue` and setup verifies each piece it installed.

Every Toolshed component is an opt-in. Setup does not install the full bundle, and it says so when a plugin is probably not needed. The only commands you type yourself are the marketplace bootstrap above and the reload. The [Quartermaster guide](./quartermaster/) has a table of what setup does itself, where it asks you, and what it leaves to you.

Try one real request after verification:

> Explain the main parts of this codebase and point me to the files I should read first.

If you enabled Codebase Mapper, Claude can use the maintained project map to answer that request. If you chose another plugin, use its guide below for the first workflow.

## Choose your next workflow

Toolshed includes these seven plugins, and each one is its own opt-in:

- [Set up and maintain a workspace](./quartermaster/)
- [Track and deliver owned work](./sidequest/)
- [Add GPT or Grok subscription models](./model-gateway/)
- [Keep a project map nearby](./codebase-mapper/)
- [Load project rules when they apply](./live-rules/)
- [View selected local usage](../observability/)
- [Measure the code Claude writes](./quality-gate/)

Quartermaster's updater covers every active Eigenwise Toolshed install in Claude Code's registry, at its recorded user, project, or local scope and project path. It can update an install in another project even when you invoke it from here. Third-party marketplaces are left alone.

Freshness hooks report cached availability and loaded-version mismatches. They do not install plugins or restart Claude Code. Marketplace auto-update is optional and must be enabled for the Eigenwise Toolshed marketplace. After any plugin update, reload affected open sessions. Restart Claude Code when process-level gateway wiring or model discovery changed.

Quality Gate is an optional extra install. Quality Gate measures the code Claude writes: it scores each new or changed function by complexity and test coverage (CRAP), not by pattern matching on text, and works the moment you install it. See the [Quality Gate guide](./quality-gate/).

The [generated plugin reference](../reference/) lists the agent-facing skills, hooks, and commands. Maintainer material lives under [contributing](../contributing/), and the separate [support page](https://eigenwise.github.io/eigenwise-toolshed/support/) covers ways to help.
