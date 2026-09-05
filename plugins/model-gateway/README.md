# Model Gateway

Model Gateway adds ChatGPT/Codex and Grok subscription models to Claude Code. It keeps normal Claude models on Anthropic and routes only the selected gateway models through your subscription.

[Setup guide](https://eigenwise.github.io/eigenwise-toolshed/getting-started/model-gateway/) · [Generated reference](https://eigenwise.github.io/eigenwise-toolshed/reference/model-gateway/) · [Toolshed marketplace](../../README.md)

## Install

Run these in Claude Code:

```text
/plugin marketplace add Eigenwise/eigenwise-toolshed
/plugin install model-gateway@eigenwise-toolshed --scope project
```

Any install scope works: user, project, or local. User scope makes the plugin available in every project, while project and local scopes keep it out of repositories that did not opt in.

Reload plugins or start a new Claude Code session, then tell Claude:

> Set up Model Gateway for me.

Claude uses the bundled skill to install and start the local gateway, check your login, wire the current project's `.claude/settings.local.json`, and confirm that models are available. Setup uses that project-local target by default. The bundled `env --write-user` command enables machine-wide wiring, while `env --write-project` wires one project. If a browser sign-in or restart is needed, Claude tells you exactly when to do it.

## Use a model

Open `/model` and choose a row labeled `From gateway`. Claude Code only refetches gateway discovery
with an API-key credential. Model Gateway writes its discovery cache for OAuth subscriptions, and
new rows appear after restarting Claude Code. `/reload-plugins` does not reload the picker cache.

- `lib/runtime.js`'s `MODEL_WINDOW_POLICY` is the authority for every gateway picker row. GPT-5.6 Sol, Terra, Luna, and GPT-6 Astra are measured at 920,012 accepted and 935,012 refused on 2026-09-05, so the gateway advertises 920k. Other Codex proxy rows use the table's explicit unmeasured 920k default until measured.
- Any gateway row above Claude Code's 200k unknown-model window gets a `[1m]` picker alias. Codex rows remove it before forwarding. Grok 4.5 is now `claude-grok-4.5[1m]`, advertises its measured 500k window, and routes to the Grok subscription.
- Claude models keep using Anthropic normally.

That’s it for daily use. The plugin keeps the gateway running: its shim supervisor checks the proxy's `/v1/models` endpoint, recovers an unavailable proxy with bounded backoff, and leaves a healthy proxy alone. An older session left open through an update leaves a newer shim running and tells you to reload plugins or restart Claude Code. Sidequest can select gateway models automatically when both plugins are installed.

On Windows, startup uses WMI to launch the supervisor outside the calling terminal or hook's process tree and Job Object. Closing or timing out that caller therefore leaves the shared gateway running. Startup preserves the caller's environment, hides the launcher window, and reports a launch failure instead of falling back to a process that can be killed with the hook.

SessionStart stops waiting after 12 seconds, well inside its 30-second hook budget. The supervisor keeps starting in the background, and Claude tells you to retry a Codex model in a few seconds if it is not ready yet.

When the gateway disappears or restarts, ask Claude to run `doctor`. It names the lifecycle evidence at `~/.claude/model-gateway/logs/lifecycle.jsonl` and distinguishes an observed supervisor, worker, or proxy exit from no exit evidence. The bounded records identify PIDs, orderly setup/stop/restart requests, signals, and recovery outcomes. A force-killed supervisor or OS termination can leave no final record, so a missing exit entry does not prove an orderly shutdown.

Running this plugin's test suite uses its own gateway home and never touches the installed gateway. If Codex sessions dropped while you tested in an earlier version, that was a supervisor cleanup bug fixed in this version. Cleanup uses this home's recorded PIDs and targeted ownership checks only: the live command must still identify this install, and the record must match its command or start time. A stale record is deleted without stopping its reused PID; `doctor` reports `stale pid file guardian: PID <pid> is now <command>` so you can see why. The serving supervisor limits each ownership probe with `CODEX_GATEWAY_PROBE_TIMEOUT_MS` (2 seconds by default). When it cannot identify an owner before that limit, it records `owner-unknown`, refuses to kill the listener, and retries recovery on its next tick. The supervisor owns those probe children too: it kills their tree and waits for them to close before shutdown, so they cannot hold a fixture home open. A confirmed foreign owner is refused too.

## Claude model pins

Pins follow the installed Claude CLI's resolved alias. Pin detection runs an isolated local probe that disables Claude Code's nonessential network traffic while preserving proxy observation and bypassing the local endpoint. If one alias probe misses, that alias uses its shipped known-good pin and is marked stale so the next refresh probes it again automatically.

Already-wired projects need `model-gateway env --write-project` (or update-toolshed), then a new Claude Code session, to pick up a changed pin.

## If something stops working

Tell Claude what happened, for example:

> My gateway models disappeared from `/model`. Diagnose and fix it.

> Codex models fail, but Claude models still work. Repair Model Gateway.

Claude checks authentication, local processes, ports, model discovery, updates, and settings precedence through the bundled skill. You don’t need to run the gateway’s internal commands yourself.

## Remote Control

Remote Control gives each project two choices.

### Use RC-compatibility mode

RC-compatibility keeps Model Gateway routed for the project. It maps `api.anthropic.com` to loopback in the hosts file and needs the gateway shim to bind port 80. Gateway rows disappear from `/model`, but only in RC-compatibility mode, explicit gateway ids such as `/model claude-gpt-5.6-terra[1m]` still work.

Ask Claude to enable, disable, or diagnose RC-compatibility. Its read-only diagnosis checks port 80 before any hosts-file change. If another process already holds the port, RC-compatibility cannot start until that process releases it. Docker Desktop is a common holder and is named in the refusal.

### Turn the gateway off for this project

To get Remote Control without RC-compatibility, remove only `ANTHROPIC_BASE_URL` from the `env` object in that project's `.claude/settings.local.json`. Keep every other gateway setting, then restart Claude Code. The project talks to `api.anthropic.com` directly and Remote Control becomes available.

That project has no gateway models after the restart: gateway rows disappear from `/model` and typed gateway ids do not work either. A manually exported `ANTHROPIC_BASE_URL` still wins over the file edit, so remove that environment variable before restarting if the project remains wired.

## License

MIT
