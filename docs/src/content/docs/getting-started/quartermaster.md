---
title: Quartermaster setup
description: Set up workspaces, keep Toolshed plugins current, and work out what they are short of.
---

Quartermaster sets up Claude Code projects, keeps Eigenwise Toolshed plugins current, checks workspace health, and looks for missing capabilities in your session history. The history is mined locally by a script and reduced to counts before any model sees it.

## Install

Install Quartermaster in the project you want to set up. Every Toolshed plugin uses project scope:

```text
/plugin marketplace add Eigenwise/eigenwise-toolshed
/plugin install quartermaster@eigenwise-toolshed --scope project
```

Reload plugins or start a new Claude Code session.

## Set up a workspace

From the project directory, run:

> /quartermaster:setup

It reads the project, mines your history across your projects (which plugins you lean on, which permission denials repeat, and which corrections you keep giving), interviews you briefly, and proposes a plan: Toolshed core, stack plugins, starter rules, and permission allowlist entries. Every item is approved individually before anything is installed or written. Selected Toolshed plugins are installed for the project, and the result is verified against a really-loaded session rather than assumed.

If you choose telemetry, Claude handles the Observability setup and tells you when a restart is needed. You can also decline and continue without it.

## Keep a workspace current

Tell Claude what you want to do:

> Update my Eigenwise Toolshed plugins.

> Check whether this workspace and its Toolshed plugins are healthy.

Or run the maintenance skills directly:

> /quartermaster:update-toolshed

> /quartermaster:toolshed-doctor

The updater covers the Eigenwise Toolshed marketplace and Model Gateway when it is installed. Third-party plugins are left alone. The health check identifies stale installs and an `enabledPlugins` entry that has no matching install, because its hooks are not running. Claude can install the plugin at the reported project scope or remove the dead entry from the named settings file. Reload plugins or start a new session after an update so Claude sees the new version.

## The in-the-moment loop

Most self-improvement happens without any pass at all. A SessionStart line keeps one question in front of Claude while it works: is this the thing being done for the third time that should become a skill, a codebase-map entry, a rule, or a committed measurement? When it notices one, it says so and offers to capture it right then; if nothing was missing, it stays silent. Workspaces that ran setup get the stronger version. Unchanged rules are re-grounded at SessionStart, and a changed matching rule appears on the next prompt or edit; the session line steps aside for it.

## Resupply an existing workspace

After a stretch of real work, run it directly, or accept Quartermaster's proactive offer of a focused optimization round:

> /quartermaster:resupply

The miner streams your recent transcripts (subagents included) and emits a bounded aggregate. Every session carries what it was for: its own title, its first real prompt, any explicit `/goal` and whether that goal was ever met. An explicit goal is the strongest signal and also the rarest, so the title and the opening ask carry most sessions. Sessions nobody typed into twice are flagged, because a hook that spawns fifty review sessions would otherwise report its purpose back to you as yours.

Alongside that: the areas of the tree your work landed in, repeated commands, per-plugin and per-MCP attribution, documentation lookups, per-session cost, and friction (denials with their targets, interrupts, corrections with themes).

The skill looks for what is missing against that purpose, in value order: something you have no way to measure, work you keep doing by hand, knowledge you keep re-deriving, and only then the setup pushing back. That is the order it looks in. What it leads with is whatever your history actually attests, so a missing measurement comes first when the evidence carries it and gets labelled as inference when it is a guess. At most seven findings, each proposed one at a time with evidence and the exact change. Say no and that recommendation never comes back; say yes and the next pass reports whether it helped.

Friction is last on purpose. Fixing what went wrong returns you to the speed you already expected; adding a capability you never had moves that baseline, and the best capabilities leave no friction trace at all. A measurement you are missing throws no errors, gets nothing denied, and happens exactly once, so anything that watches for repeated pain will never find it.

Findings route to the cheapest durable fix: a measurement built as a committed skill, a plugin install from the catalog, a workflow skill, a codebase-map or CLAUDE.md entry, a live rule, a `permissions.allow` entry, or a plugin disable.

## How the loop closes

A SessionEnd hook tallies each session locally: no LLM, no network, one streamed pass. Applied recommendations record what they target, and `verify` compares that signal per session before and after. For a capability no counter tracks, the check is whether the new skill or plugin shows up in attribution at all. A SessionStart nudge (one line, 24-hour cooldown) fires only when enough unreviewed sessions or friction pile up, then proactively asks whether you want a focused optimization round for your development system, setup, tooling, or workflow. It mines the sessions after you say yes, or automatically if you have explicitly given standing permission for optimization rounds. Each change is proposed separately unless that standing permission already covers its exact class.

## What it stores

Tallies and decisions live under `~/.claude/quartermaster-state/`: per-session counters and a decision ledger with fingerprints. Raw transcripts are never loaded into model context; the resupply skill is explicitly forbidden from opening them. Everything taken from a transcript is clipped: session titles to 120 characters, opening asks to 240, goal conditions and evidence quotes to 300. Paths are reduced to the two directory segments nearest the file, and scratch directories are dropped entirely.

The [generated Quartermaster reference](/reference/quartermaster/) contains the agent-facing skill and command details.
