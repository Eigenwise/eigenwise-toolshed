---
title: Model Gateway
description: Add ChatGPT/Codex and Grok subscription models to Claude Code.
---

Model Gateway adds subscription-backed GPT and Grok models to Claude Code. Claude models keep using Anthropic normally.

## Install

Run these in Claude Code:

```text
/plugin marketplace add Eigenwise/eigenwise-toolshed
/plugin install model-gateway@eigenwise-toolshed --scope project
```

Reload plugins or start a new Claude Code session. Then tell Claude:

> Set up Model Gateway for me.

Claude takes care of the rest through the bundled Model Gateway skill. It installs and starts the local gateway, checks your subscription login, writes this project's local settings, and confirms that model discovery works.

Model Gateway writes `ANTHROPIC_BASE_URL` to `.claude/settings.local.json`, never the committed `.claude/settings.json`. That keeps your local gateway endpoint out of other people's checkouts. You can opt into one shared fallback URL in `~/.claude/settings.json`, but a project's local setting wins. `model-gateway doctor` marks the effective source and calls out conflicting gateway modes.

You may need to complete a browser sign-in or restart Claude Code. Claude will ask only when either step is actually needed.

## Pick a model

Open `/model` and choose a row labeled `From gateway`.

- `claude-gpt-*` uses your ChatGPT/Codex subscription. Current built-in rows are `claude-gpt-5.6-sol`, `claude-gpt-5.6-terra`, and `claude-gpt-5.6-luna`.
- `claude-grok-*` uses your Grok subscription when the Grok CLI is installed and signed in. The current built-in Grok row is `claude-grok-4.5`.
- Claude models keep using Anthropic.

Sidequest can select these models automatically when both plugins are installed.

## Daily use

There are no routine Model Gateway commands to remember. The shim supervisor checks the proxy's `/v1/models` endpoint while it runs and recovers an unavailable proxy with bounded backoff. It leaves a healthy proxy alone. If a session survives a plugin update, its older plugin copy leaves the newer shim running and asks you to reload plugins or restart Claude Code. Claude handles setup, updates, authentication checks, model discovery, and settings repair through the skill.

When the gateway disappears or restarts, ask Claude to run `doctor`. It names `~/.claude/model-gateway/logs/lifecycle.jsonl` and says whether it found an observed supervisor, worker, or proxy exit. The bounded records include PIDs, orderly setup/stop/restart requests, signals, and recovery outcomes. A force-killed supervisor or OS termination can leave no final record, so a missing exit entry does not prove an orderly shutdown.

Running Model Gateway's own suite uses a separate test home and never touches the installed gateway. Codex sessions dropping while tests ran was a supervisor cleanup bug, fixed in this version.

If something breaks, describe the symptom:

> My gateway models disappeared from `/model`. Diagnose and fix it.

> Codex fails, but Claude models still work. Repair Model Gateway.

Claude checks the relevant state and tells you if a browser sign-in or restart needs your help.

## Remote Control

Remote Control gives each project two choices.

### Use RC-compatibility mode

RC-compatibility keeps Model Gateway routed for the project. It maps `api.anthropic.com` to loopback in the hosts file and needs the gateway shim to bind port 80. Gateway rows disappear from `/model`, but only in RC-compatibility mode, explicit gateway ids such as `/model claude-gpt-5.6-terra` still work.

Tell Claude you want to enable, disable, or diagnose RC-compatibility. Its read-only diagnosis checks port 80 before any hosts-file change. If another process already holds the port, RC-compatibility cannot start until that process releases it. Docker Desktop is a common holder and is named in the refusal.

### Turn the gateway off for this project

To get Remote Control without RC-compatibility, remove only `ANTHROPIC_BASE_URL` from the `env` object in that project's `.claude/settings.local.json`. Keep every other gateway setting, then restart Claude Code. The project talks to `api.anthropic.com` directly and Remote Control becomes available.

That project has no gateway models after the restart: gateway rows disappear from `/model` and typed gateway ids do not work either. A manually exported `ANTHROPIC_BASE_URL` still wins over the file edit, so remove that environment variable before restarting if the project remains wired.

The generated [Model Gateway reference](../../reference/model-gateway/) records the agent-facing commands and configuration details used by the skill.
