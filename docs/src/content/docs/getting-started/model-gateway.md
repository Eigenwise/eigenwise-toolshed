---
title: Model Gateway
description: Add ChatGPT/Codex and Grok subscription models to Claude Code.
---

Model Gateway adds subscription-backed GPT and Grok models to Claude Code. Claude models keep using Anthropic normally.

## Install

Run these in Claude Code:

```text
/plugin marketplace add Eigenwise/eigenwise-toolshed
/plugin install model-gateway@eigenwise-toolshed --scope user
```

Reload plugins or start a new Claude Code session. Then tell Claude:

> Set up Model Gateway for me.

Claude takes care of the rest through the bundled Model Gateway skill. It installs and starts the local gateway, checks your subscription login, writes the required user settings, and confirms that model discovery works.

You may need to complete a browser sign-in or restart Claude Code. Claude will ask only when either step is actually needed.

## Pick a model

Open `/model` and choose a row labeled `From gateway`.

- `claude-gpt-*` uses your ChatGPT/Codex subscription.
- `claude-grok-*` uses your Grok subscription when the Grok CLI is installed and signed in.
- Claude models keep using Anthropic.

Sidequest can select these models automatically when both plugins are installed.

## Daily use

There are no routine Model Gateway commands to remember. The shim supervisor checks the proxy's `/v1/models` endpoint while it runs and recovers an unavailable proxy with bounded backoff. It leaves a healthy proxy alone. Claude handles setup, updates, authentication checks, model discovery, and settings repair through the skill.

If something breaks, describe the symptom:

> My gateway models disappeared from `/model`. Diagnose and fix it.

> Codex fails, but Claude models still work. Repair Model Gateway.

Claude checks the relevant state and tells you if a browser sign-in or restart needs your help.

## Remote Control

Remote Control conflicts with gateway model discovery. Tell Claude you want to enable or disable Model Gateway’s Remote Control compatibility. It will explain which model rows will disappear before making the change.

The generated [Model Gateway reference](/reference/model-gateway/) records the agent-facing commands and configuration details used by the skill.
