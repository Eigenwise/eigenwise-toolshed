---
title: Quartermaster setup
description: Set up workspaces, keep Toolshed plugins current, and work out what they are short of.
---

Quartermaster sets up Claude Code projects, keeps Eigenwise Toolshed plugins current, checks workspace health, and looks for missing capabilities in your session history. The history is mined locally by a script and reduced to counts before any model sees it.

## Install

Install Quartermaster in the project you want to set up. This example uses project scope:

```text
/plugin marketplace add Eigenwise/eigenwise-toolshed
/plugin install quartermaster@eigenwise-toolshed --scope project
```

Reload plugins or start a new Claude Code session.

## Set up a workspace

From the project directory, run:

> /quartermaster:setup

It reads the project, mines recent session history across your projects, asks a few setup questions, and proposes a plan covering Toolshed plugins, stack plugins, starter rules, and permission entries. You approve each item before it installs or writes anything. After you reload plugins, it verifies the selected plugins and project configuration.

If you choose telemetry, Claude handles the Observability setup and tells you when a restart is needed. You can also decline and continue without it.

## Keep a workspace current

Tell Claude what you want to do:

> Update my Eigenwise Toolshed plugins.

> Check whether this workspace and its Toolshed plugins are healthy.

Or run the maintenance skills directly:

> /quartermaster:update-toolshed

> /quartermaster:toolshed-doctor

The updater covers the Eigenwise Toolshed marketplace and Model Gateway when it is installed. Third-party plugins are left alone. The health check identifies stale installs and an `enabledPlugins` entry that has no matching install, because its hooks are not running. Claude can install the plugin at the reported project scope or remove the dead entry from the named settings file. It also names Model Gateway startup check failures precisely: a missing checker, a launch error, a three-second timeout, a nonzero doctor result, or empty output. A nonzero doctor result keeps one short diagnostic line rather than being reported as a missing checker. Reload plugins or start a new session after an update so Claude sees the new version.

## The in-the-moment loop

Quartermaster's SessionStart hook can flag a repeated task that may belong in a skill, codebase-map entry, rule, or measurement. It offers to capture the improvement when it notices one; otherwise it stays silent. Setup also re-grounds unchanged rules and surfaces changed matching rules on the next prompt or edit.

## Resupply an existing workspace

After real work has accumulated, run it directly or accept Quartermaster's offer of a focused optimization round:

> /quartermaster:resupply

The miner includes subagents and emits a bounded aggregate from recent transcripts. It records each session's title, opening prompt, explicit `/goal` and outcome, and flags sessions with little direct user input so hook-created work does not look like user intent.

It also aggregates changed tree areas, repeated commands, plugin and MCP attribution, documentation lookups, per-session cost, and friction such as denials, interrupts, and recurring corrections.

The skill ranks findings in this order: a missing measurement, manual work, existing capabilities
that underperform, knowledge being re-derived, then setup friction. It proposes at most seven
findings one at a time with evidence and an exact change. A rejected recommendation is recorded and
does not return; an accepted one is checked in a later pass. Each pass also checks whether existing
skills, rules, or instruments need improvement, favoring that over parallel new capabilities.

Findings route to the cheapest durable fix: a measurement built as a committed skill, a plugin install from the catalog, a workflow skill, a codebase-map or CLAUDE.md entry, a live rule, a `permissions.allow` entry, or a plugin disable.

## How the loop closes

A SessionEnd hook tallies each session locally in one streamed pass. Once enough unreviewed sessions or friction accumulates, the SessionStart nudge records that an offer is due and a Stop hook holds one real pause open for Claude to offer a focused optimization round. It blocks once per session, ignores its own continuation, and uses a separate 24-hour cross-session offer cooldown, so a fresh SessionStart nudge cannot suppress that first offer. Declining the whole round runs `decline-resupply`, which resets the evidence window until new sessions or friction accumulate. Applied recommendations record their targets, and later checks compare the signal before and after. Recommendations still need separate approval unless standing permission covers their exact class.

## What it stores

Tallies and decisions live under `~/.claude/quartermaster-state/`: per-session counters and a decision ledger with fingerprints. Raw transcripts are never loaded into model context; the resupply skill is explicitly forbidden from opening them. Everything taken from a transcript is clipped: session titles to 120 characters, opening asks to 240, goal conditions and evidence quotes to 300. Paths are reduced to the two directory segments nearest the file, and scratch directories are dropped entirely.

The [generated Quartermaster reference](../../reference/quartermaster/) contains the agent-facing skill and command details.
