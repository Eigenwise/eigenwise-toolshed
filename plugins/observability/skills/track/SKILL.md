---
name: track
description: Enable, disable, or check per-project local usage recording, or open the Observability board.
---

# Track local usage

Use the registered commands directly:

- `/observability:track on|off|status` controls recording for the current project. Choose one argument. Installing the plugin does not enable recording.
- `/observability:board` rebuilds and opens the self-contained local board.

Recording is metadata only: project, session identifier and name (sidebar title or first prompt line, up to 60 characters), model, turn outcome, timing, token usage, tool counts/errors/denials, agent types, context and quota usage, compaction, and an optional ticket identifier. Cost is the engine's own /cost figure, never an estimate. Do not promise that session names contain no user text.

Ledgers are append-only JSONL at `<claude config dir>/observability/ledger/<project-slug>.jsonl`; the board is `<claude config dir>/observability/board.html`. The config directory is `CLAUDE_CONFIG_DIR` or `~/.claude` (`%USERPROFILE%\.claude` on Windows). The slug is the project root basename (unsafe characters replaced by underscores) plus a six-character hash of the full path, so equal basenames in different folders keep separate files.

Nothing leaves the machine. No full prompts, responses, code, tool inputs/results, credentials, or environment values are recorded. Tracking off stops future recording and preserves history. Do not delete history or change another project's opt-in as part of these commands.
