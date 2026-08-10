---
title: Quartermaster setup
description: Set up workspaces from your session history, and run retros that turn friction into approved fixes.
---

Quartermaster looks after your Claude Code setup the way a quartermaster looks after gear: it outfits new workspaces, watches what actually gets used, and retires or adds equipment based on evidence. The evidence is your own session history, mined locally by a script and reduced to counts before any model sees it.

## Install

Quartermaster works across every project, so install it once at user scope:

```text
/plugin marketplace add Eigenwise/eigenwise-toolshed
/plugin install quartermaster@eigenwise-toolshed --scope user
```

Reload plugins or start a new Claude Code session.

## Set up a workspace

In any project, new or existing:

> /quartermaster:setup

It reads the project, mines your history across all projects (which plugins you lean on, which permission denials repeat, which corrections you keep giving), interviews you briefly, and proposes a plan: Toolshed core (codebase-mapper, live-rules, sidequest where it fits), stack plugins, starter rules, and permission allowlist entries. Every item is approved individually before anything is installed or written, and the result is verified against a really-loaded session rather than assumed.

## Run a retro

After a stretch of real work, or when the SessionStart nudge suggests it:

> /quartermaster:retro

The miner streams your recent transcripts (subagents included) and emits a bounded aggregate: permission denials with their targets, interrupts, corrections with themes, repeated commands, per-plugin and per-MCP attribution. The skill turns that into at most seven findings, each proposed one at a time with evidence and the exact change. Say no and that recommendation never comes back; say yes and the next retro reports whether it actually reduced the friction it targeted.

Findings route to the cheapest durable fix: a plugin install from the catalog (2,500+ plugins searchable locally, install counts included), a live rule or CLAUDE.md line, a `permissions.allow` entry, a plugin disable, or a new skill.

## How the loop closes

A SessionEnd hook tallies each session's friction locally: no LLM, no network, one streamed pass. Applied recommendations record which signal they target, and `verify` compares that signal per session before and after. A SessionStart nudge (one line, 72-hour cooldown) fires only when enough unanalyzed sessions or friction pile up. Nothing is ever analyzed or changed without you asking.

## What it stores

Tallies and decisions live under `~/.claude/quartermaster-state/`: per-session counters and a decision ledger with fingerprints. Raw transcripts are never loaded into model context; the retro skill is explicitly forbidden from opening them. Quotes shown as evidence are clipped to 300 characters.
