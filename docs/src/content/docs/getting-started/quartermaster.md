---
title: Quartermaster setup
description: Set up workspaces from your session history, and work out what they are short of.
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

## Resupply an existing workspace

After a stretch of real work, or when the SessionStart nudge suggests it:

> /quartermaster:resupply

The miner streams your recent transcripts (subagents included) and emits a bounded aggregate. Every session carries what it was for: its own title, its first real prompt, any explicit `/goal` and whether that goal was ever met. An explicit goal is the strongest signal and also the rarest, so the title and the opening ask carry most sessions. Sessions nobody typed into twice are flagged, because a hook that spawns fifty review sessions would otherwise report its purpose back to you as yours.

Alongside that: the areas of the tree your work landed in, repeated commands, per-plugin and per-MCP attribution, documentation lookups, per-session cost, and friction (denials with their targets, interrupts, corrections with themes).

The skill looks for what is missing against that purpose, in value order: something you have no way to measure, work you keep doing by hand, knowledge you keep re-deriving, and only then the setup pushing back. That is the order it looks in. What it leads with is whatever your history actually attests, so a missing measurement comes first when the evidence carries it (a goal restated and never met, a check improvised dozens of times, one question answered two different ways) and gets labelled as inference when it is a guess, which puts it below the cheap fixes it is sure about. At most seven findings, each proposed one at a time with evidence and the exact change. Say no and that recommendation never comes back; say yes and the next pass reports whether it helped.

Friction is last on purpose. Fixing what went wrong returns you to the speed you already expected; adding a capability you never had moves that baseline, and the best capabilities leave no friction trace at all. A measurement you are missing throws no errors, gets nothing denied, and happens exactly once, so anything that watches for repeated pain will never find it.

Findings route to the cheapest durable fix: a measurement built as a committed skill, a plugin install from the catalog (2,500+ plugins searchable locally, install counts included), a workflow skill, a codebase-map or CLAUDE.md entry, a live rule, a `permissions.allow` entry, or a plugin disable.

## How the loop closes

A SessionEnd hook tallies each session locally: no LLM, no network, one streamed pass. Applied recommendations record what they target, and `verify` compares that signal per session before and after. For a capability no counter tracks, the check is whether the new skill or plugin shows up in attribution at all. A SessionStart nudge (one line, 72-hour cooldown) fires only when enough unreviewed sessions or friction pile up. Nothing is ever analyzed or changed without you asking.

## What it stores

Tallies and decisions live under `~/.claude/quartermaster-state/`: per-session counters and a decision ledger with fingerprints. Raw transcripts are never loaded into model context; the resupply skill is explicitly forbidden from opening them. Everything taken from a transcript is clipped: session titles to 120 characters, opening asks to 240, goal conditions and evidence quotes to 300. Paths are reduced to the two directory segments nearest the file, and scratch directories are dropped entirely.
