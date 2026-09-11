---
title: Quartermaster setup
description: Set up workspaces, keep Toolshed plugins current, and find missing capabilities after real work.
---

Quartermaster helps with project setup, Toolshed maintenance, workspace health, and the next capability your work is missing. Its local scripts read transcript files and emit a bounded summary. The active model sees that summary when the setup or resupply skill reads it, not the raw transcripts.

## Install

Install Quartermaster in the project you want to set up. This example uses project scope:

```text
/plugin marketplace add Eigenwise/eigenwise-toolshed
/plugin install quartermaster@eigenwise-toolshed --scope project
```

Activate it with `/reload-plugins` or start a new Claude Code session.

## Set up a workspace

From the project directory, run:

> /quartermaster:setup

Setup reads the project, mines recent session history across your projects, asks a few setup questions, and proposes a plan covering Toolshed plugins, stack plugins, starter rules, and permission entries. You approve each item before it installs or writes anything. Its starter rules teach agents to trace the real flow, question whether new code is needed, and reuse existing code, the standard library, native platform features, or installed dependencies before adding anything. Every workspace gets the clean-code baseline as a live rule. When a change is needed, they favor the smallest shared-root fix, preserve trust, data-loss, security, and accessibility safeguards, use focused regression checks, and leave the full gate to the integration owner.

Setup installs the approved plugins and writes the approved project files, then pauses at the activation boundary. Run `/reload-plugins`, or restart Claude Code when the change affects the process environment, and tell Claude `continue`. Setup verifies the selected plugins and project configuration after that boundary.

When setup wires Model Gateway or Sidequest routing, Quartermaster can offer the optional `325000` `autoCompactWindow` setting for a consistent Codex compaction point. Setup asks before writing it. If user or project settings already has a value, it reports which one wins and preserves that value.

If you choose telemetry, Claude hands the setup to Observability and tells you when a restart is needed. You can also decline and continue without it.

## Keep a workspace current

Tell Claude what you want to do:

> Update my Eigenwise Toolshed plugins.

> Check whether this workspace and its Toolshed plugins are healthy.

Or run the maintenance skills directly:

> /quartermaster:update-toolshed

> /quartermaster:toolshed-doctor

The requested updater reads Claude Code's installed-plugin registry and updates every active Eigenwise Toolshed install at its recorded user, project, or local scope and project path. It can update installs in other recorded projects, not only the project where you invoked it. Third-party plugins and marketplaces are left alone.

Freshness hooks are advisory. They report cached availability and loaded-version mismatches, and they point to `/quartermaster:update-toolshed`; they do not install, restart, or replace the requested updater. Marketplace auto-update is optional and must be enabled for the Eigenwise Toolshed marketplace in Claude Code. An open session still needs `/reload-plugins` after plugin code changes. Restart Claude Code when process-level gateway wiring or model discovery changed.

The health check is read-only. It identifies stale installs, dead `enabledPlugins` entries, and Model Gateway startup-check results when that plugin is present. It also reports managed Observability storage limits without running a repair. Run the updater when you want installs changed.

## The in-the-moment loop

Quartermaster's SessionStart hook can flag a repeated task that may belong in a skill, codebase-map entry, rule, or measurement. It offers to capture the improvement when it notices one; otherwise it stays silent. Setup also re-grounds unchanged rules and surfaces changed matching rules on the next prompt or edit.

## Resupply an existing workspace

After real work has accumulated, run it directly or accept Quartermaster's offer of a focused resupply round:

> /quartermaster:resupply

The miner reads local transcript files and emits a bounded aggregate. The active model can see the aggregate, which may include:

- session titles clipped to 120 characters;
- opening asks clipped to 240 characters;
- explicit goals, whether each goal was met, and bounded goal samples;
- the two directory segments nearest touched files, with scratch and opaque paths removed;
- counts for prompts, tool calls, errors, denials, interrupts, and corrections;
- a denial meaning that identifies `permission-rule` as a host-reported policy block, not proof of
  whether a permission rule or PreToolUse hook blocked the call;
- repeated command names, plugin, skill, and MCP attribution, and fetched hostnames; and
- short correction or denial evidence quotes clipped to 300 characters.

Raw transcript files are never loaded into model context, and the resupply skill is forbidden from opening them. The default pass mines the current project. Setup explicitly requests the all-projects summary, while resupply only uses `--all-projects` for a global pass. A host policy label alone never justifies a permission allowlist or hook change; existing approval requirements still apply.

Automatic permission learning excludes bare `PowerShell` rules as too broad. It does not create scoped PowerShell rules or remove older bare `PowerShell` entries, which need user review. A manually approved scoped rule remains a user decision.

The skill ranks findings in this order: a missing measurement, manual work, existing capabilities that underperform, knowledge being re-derived, then setup friction. It first checks whether an existing project capability can meet the goal or be improved, and only proposes a new capability when the evidence says the existing choices do not fit. It keeps what works and changes a concrete weakness, never the workspace for novelty. Before it offers a change, it identifies the benefit, smallest approach, and boundary; focused research is only for an unknown that could change that call. It never starts a resupply pass without current or standing approval. It proposes at most seven findings one at a time with evidence and an exact change. A rejected recommendation is recorded and does not return; an accepted one is checked in a later pass.

## How the loop closes

A SessionEnd hook tallies each session locally in one streamed pass. Once enough unreviewed sessions or friction accumulates, the SessionStart nudge records that an offer is due and a Stop hook holds one real pause open for Claude to offer a focused optimization round. It blocks once per session, ignores its own continuation, and uses a separate 24-hour cross-session offer cooldown. Declining the whole round resets the evidence window until new sessions or friction accumulate. Applied recommendations record their targets, and later checks compare the signal before and after. Recommendations still need separate approval unless standing permission covers their exact class.

## What it stores

Tallies and decisions live under `~/.claude/quartermaster-state/`: per-session counters and a decision ledger with fingerprints. The bounded aggregate is the model-facing summary for setup and resupply. Raw transcripts are not loaded into model context, and the resupply skill must not open them. Transcript-derived text in the aggregate is clipped, and scratch directories are dropped from path areas.

The [generated Quartermaster reference](../../reference/quartermaster/) contains the agent-facing skill and command details. See [contributing](../../contributing/) for maintainer workflows and the separate [support page](https://eigenwise.github.io/eigenwise-toolshed/support/) for ways to help.
