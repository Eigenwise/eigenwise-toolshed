---
title: sidequest
description: "A Trello-light quest log for Claude Code. The side issues you mention mid-task (\"oh, and the contact form doesn't send\") get captured as tickets on the spot, with any pasted images attached, and managed on a live, self-hosted Kanban dashboard that spans every project you work in."
---

<!-- AUTO-GENERATED — do not edit; run npm run generate -->
# sidequest

A Trello-light quest log for Claude Code. The side issues you mention mid-task ("oh, and the contact form doesn't send") get captured as tickets on the spot, with any pasted images attached, and managed on a live, self-hosted Kanban dashboard that spans every project you work in.

**Version:** `2.42.0`

## Skills

- - `board`: Open the sidequest board (live Kanban of your tickets) in the browser
- - `groom`: Run a full board-grooming pass over a sidequest project, like a sprint grooming session: sweep every ticket, cross-check it against reality (git log, docs, recent session work) to find done-but-open tickets, superseded ones, stale claims, duplicates, and missing tickets for work that already exists in the repo, then act on what's clearly safe and batch the unclear ones into a few interactive questions for the user before closing anything ambiguous. Use when the user says "groom the board", "board grooming", "sprint grooming", "clean up the board", "tidy tickets", "audit the tickets", or "is the board still accurate". Never deletes tickets (closes with an evidence-bearing comment instead) and never touches a claim held by an active agent.
- - `sidequest`: Open the sidequest board (a live Kanban of tickets) or manage tickets from the CLI/MCP: file, list, update, move, close, prioritize, label, or delete tickets — "show me the dashboard", "close SQ-3". Use to WORK the board ("grab the next task") — atomically CLAIM first. Use when the user hands you substantial or multi-part work — decompose it into linked tickets BEFORE implementing. Use to comment, ask the user on-ticket questions (a question means pause-and-wait), or relate tickets. Categories drive model/effort routing. For a mid-task side issue, file it with `add` and keep working. Filing never asks you to work it.

## Hooks

- **PreToolUse** (*): `node "${CLAUDE_PLUGIN_ROOT}/hooks/near-turn-cap.js"`
- **PreToolUse** (Agent): `node "${CLAUDE_PLUGIN_ROOT}/hooks/force-exec-bypass.js"`
- **PreToolUse** (TaskOutput): `node "${CLAUDE_PLUGIN_ROOT}/hooks/guard-task-output.js"`
- **PreToolUse** (SendMessage): `node "${CLAUDE_PLUGIN_ROOT}/hooks/guard-peer-message.js"`
- **PreToolUse** (Bash|PowerShell): `node "${CLAUDE_PLUGIN_ROOT}/hooks/guard-home-delete.js"`
- **PostToolUseFailure** (Agent): `node "${CLAUDE_PLUGIN_ROOT}/hooks/quota-fallback.js"`
- **SessionStart**: `node "${CLAUDE_PLUGIN_ROOT}/hooks/registry-writer.js"`
- **SessionStart**: `node "${CLAUDE_PLUGIN_ROOT}/hooks/session-start.js"`
- **SessionEnd**: `node "${CLAUDE_PLUGIN_ROOT}/hooks/session-end.js"`
- **SubagentStart**: `node "${CLAUDE_PLUGIN_ROOT}/hooks/subagent-start.js"`
- **SubagentStop**: `node "${CLAUDE_PLUGIN_ROOT}/hooks/subagent-stop.js"`

## Bin entrypoints

- `sidequest-mcp.js`
- `sidequest.js`

[Source on GitHub](https://github.com/Eigenwise/eigenwise-toolshed/tree/main/plugins/sidequest)
