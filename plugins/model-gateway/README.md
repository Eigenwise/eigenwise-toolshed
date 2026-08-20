# Model Gateway

Model Gateway adds ChatGPT/Codex and Grok subscription models to Claude Code. It keeps normal Claude models on Anthropic and routes only the selected gateway models through your subscription.

[Setup guide](https://eigenwise.github.io/eigenwise-toolshed/getting-started/model-gateway/) · [Generated reference](https://eigenwise.github.io/eigenwise-toolshed/reference/model-gateway/) · [Toolshed marketplace](../../README.md)

## Install

Run these in Claude Code:

```text
/plugin marketplace add Eigenwise/eigenwise-toolshed
/plugin install model-gateway@eigenwise-toolshed --scope user
```

Reload plugins or start a new Claude Code session, then tell Claude:

> Set up Model Gateway for me.

Claude uses the bundled skill to install and start the local gateway, check your login, write the required settings, and confirm that models are available. If a browser sign-in or restart is needed, Claude tells you exactly when to do it.

## Use a model

Open `/model` and choose a row labeled `From gateway`.

- `claude-gpt-*` uses your ChatGPT/Codex subscription. Current built-in rows are `claude-gpt-5.6-sol`, `claude-gpt-5.6-terra`, and `claude-gpt-5.6-luna`.
- `claude-grok-*` uses your Grok subscription when the Grok CLI is installed and signed in. The current built-in Grok row is `claude-grok-4.5`.
- Claude models keep using Anthropic normally.

That’s it for daily use. The plugin keeps the gateway running: its shim supervisor checks the proxy's `/v1/models` endpoint, recovers an unavailable proxy with bounded backoff, and leaves a healthy proxy alone. An older session left open through an update leaves a newer shim running and tells you to reload plugins or restart Claude Code. Sidequest can select gateway models automatically when both plugins are installed.

## If something stops working

Tell Claude what happened, for example:

> My gateway models disappeared from `/model`. Diagnose and fix it.

> Codex models fail, but Claude models still work. Repair Model Gateway.

Claude checks authentication, local processes, ports, model discovery, updates, and settings precedence through the bundled skill. You don’t need to run the gateway’s internal commands yourself.

## Remote Control

Remote Control gives each project two choices.

### Use RC-compatibility mode

RC-compatibility keeps Model Gateway routed for the project. It maps `api.anthropic.com` to loopback in the hosts file and needs the gateway shim to bind port 80. Gateway rows disappear from `/model`, but only in RC-compatibility mode, explicit gateway ids such as `/model claude-gpt-5.6-terra` still work.

Ask Claude to enable, disable, or diagnose RC-compatibility. Its read-only diagnosis checks port 80 before any hosts-file change. If another process already holds the port, RC-compatibility cannot start until that process releases it. Docker Desktop is a common holder and is named in the refusal.

### Turn the gateway off for this project

To get Remote Control without RC-compatibility, remove only `ANTHROPIC_BASE_URL` from the `env` object in that project's `.claude/settings.local.json`. Keep every other gateway setting, then restart Claude Code. The project talks to `api.anthropic.com` directly and Remote Control becomes available.

That project has no gateway models after the restart: gateway rows disappear from `/model` and typed gateway ids do not work either. A manually exported `ANTHROPIC_BASE_URL` still wins over the file edit, so remove that environment variable before restarting if the project remains wired.

## License

MIT
