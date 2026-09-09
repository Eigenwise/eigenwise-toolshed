# Model Gateway

Model Gateway adds ChatGPT/Codex and Grok subscription models to Claude Code. Claude Code v2.1.129+ can show those gateway models in its `/model` picker. It keeps normal Claude models on Anthropic and routes only the selected gateway models through your subscription.

[Setup guide](https://eigenwise.github.io/eigenwise-toolshed/getting-started/model-gateway/) · [Generated reference](https://eigenwise.github.io/eigenwise-toolshed/reference/model-gateway/) · [Toolshed marketplace](../../README.md)

## Install

Run these in Claude Code:

```text
/plugin marketplace add Eigenwise/eigenwise-toolshed
/plugin install model-gateway@eigenwise-toolshed --scope project
```

Any install scope works: user, project, or local. User scope makes the plugin available in every project, while project and local scopes keep it out of repositories that did not opt in.

Reload the plugin, then start the Model Gateway skill:

> Set up Model Gateway for me.

The skill runs `setup`, which installs and starts the local gateway, checks your login, writes the current project's `.claude/settings.local.json`, and confirms the project wiring. If setup asks for login, complete the browser sign-in, then let Claude run `setup` again to finish the wiring and confirmation. The bundled `env --write-user` command enables machine-wide wiring, while `env --write-project` wires one project.

After the project wiring is confirmed, fully restart the Claude Code process for that same project. A plugin reload alone does not reload the model picker or settings from the new process. Select a gateway model only after that restart.

## Use a model

In Claude Code v2.1.129+, open `/model` and choose a row labeled `From gateway`. Claude Code only refetches gateway discovery
with an API-key credential. Model Gateway writes its discovery cache for OAuth subscriptions, and
new rows appear after a full Claude Code restart. `/reload-plugins` does not reload the picker cache.

- `lib/runtime.js`'s `MODEL_WINDOW_POLICY` is the authority for every gateway picker row. GPT-5.6 Sol, Terra, Luna, and GPT-6 Astra are measured at 920,012 accepted and 935,012 refused on 2026-09-05, so the gateway advertises 920k. Other Codex proxy rows use the table's explicit unmeasured 920k default until measured.
- A gateway row above Claude Code's 200k unknown-model window gets a `[1m]` picker alias. That alias gives Claude Code a 1M client window, but a lower explicit `autoCompactWindow` still wins. The optional `325000` setting is a cap, and with that cap the client compacts around `292000`. The alias is removed before forwarding to Codex or Grok, and it does not promise a 1M backend input limit. Use `/context` to inspect the selected model and effective cap.
- Claude models keep using Anthropic normally.

That’s it for daily use. The plugin keeps the gateway running: its shim supervisor checks the proxy's `/v1/models` endpoint, recovers an unavailable proxy with bounded backoff, and leaves a healthy proxy alone. A newer Model Gateway cache version replaces an older sibling version from the same marketplace and plugin name. An older session left open through an update leaves a newer shim running and tells you to reload plugins or restart Claude Code. A different marketplace, plugin name, or non-cache install stays foreign and is never stopped. Sidequest can select gateway models automatically when both plugins are installed.

On Windows, startup uses WMI to launch the supervisor outside the calling terminal or hook's process tree and Job Object. Closing or timing out that caller therefore leaves the shared gateway running. Startup preserves the caller's environment, hides the launcher window, and reports a launch failure instead of falling back to a process that can be killed with the hook.

SessionStart stops waiting after 12 seconds, well inside its 30-second hook budget. The supervisor keeps starting in the background, and Claude tells you to retry a Codex model in a few seconds if it is not ready yet.

## Local gateway records

The shim writes request-route metadata to `~/.claude/model-gateway/logs/request-routes.jsonl` by default. Each JSONL record contains the time, backend, model, request path, and, when available, route, effort, session, agent, parent-agent, dispatch-marker length, and session-source fields. It does not write request bodies, prompts, messages, tools, authentication, or arbitrary headers. Set `CODEX_GATEWAY_REQUEST_LOG=0` before the shim starts, then restart the shim through the normal setup or ensure path, to disable this route log. The setting is read by the shim process at startup, not by `/reload-plugins` in an already-running process. The path can be changed with `CODEX_GATEWAY_REQUEST_LOG_PATH`.

For each session, usage observability also keeps a small high-water file under `~/.claude/model-gateway/request-body/`. The filename is derived from the session id. The JSON contains only the largest forwarded request-body byte count seen for that session and its observation time. It does not contain the request body. The gateway does not promise a retention period for either record; manage or delete local files according to your own policy.

When the gateway disappears or restarts, ask Claude to run `doctor`. It names the lifecycle evidence at `~/.claude/model-gateway/logs/lifecycle.jsonl` and distinguishes an observed supervisor, worker, or proxy exit from no exit evidence. The bounded records identify PIDs, orderly setup/stop/restart requests, signals, and recovery outcomes. A force-killed supervisor or OS termination can leave no final record, so a missing exit entry does not prove an orderly shutdown.

Doctor also prints a model-window table for Codex, Grok, and native Claude pins: backend and picker ids,
backend and advertised windows, Claude Code's client window and compaction point, sentry mode and trigger,
and the measurement date. It compares the live shim ids with the installed policy when those ids are
available, but a `PASS` does not prove that every supported model is present. In particular, an older
claude-code-proxy can omit GPT-6 Astra while the check still passes. If Astra is missing from `/model`,
check the installed and serving proxy version, then rerun setup and fully restart Claude Code. Astra
requires claude-code-proxy 0.1.36 or newer; 0.1.35 does not include its backend allowlist. Setup
fetches the latest GitHub release. Do not use `models.json` to work around a missing backend allowlist.
A `FAIL` naming missing or extra ids means the running shim is stale even if its version matches. Have
Claude restart it through the normal `ensure` or `setup` path, then restart Claude Code sessions so the
picker re-discovers the rows.

Running this plugin's test suite uses its own gateway home and never touches the installed gateway. If Codex sessions dropped while you tested in an earlier version, that was a supervisor cleanup bug fixed in this version. Cleanup kills recorded PIDs only when the live command still identifies this install and the record matches its command or start time. A stale record is deleted without stopping its reused PID; `doctor` reports `stale pid file guardian: PID <pid> is now <command>` so you can see why. Proxy recovery treats the shared proxy binary differently: it stops a listener only when the live process tree proves that proxy descends from the recovering supervisor. A matching shared binary alone never proves ownership. Startup, recovery, restart, and drain bound each ownership probe with `CODEX_GATEWAY_PROBE_TIMEOUT_MS` (2 seconds by default). When ownership cannot be confirmed, they leave that listener alone and startup records `owner-unknown`; a confirmed foreign owner is refused too. Recovery keeps the listener for its next tick. The supervisor owns those probe children too: it kills their tree and waits for them to close before shutdown, so they cannot hold a fixture home open.

## Claude model pins

Pins follow the installed Claude CLI's resolved alias. Pin detection runs an isolated local probe that disables Claude Code's nonessential network traffic while preserving proxy observation and bypassing the local endpoint. If one alias probe misses, that alias uses its shipped known-good pin and is marked stale so the next refresh probes it again automatically.

Already-wired projects need `model-gateway env --write-project` (or update-toolshed), then a new Claude Code session, to pick up a changed pin.

## If something stops working

Tell Claude what happened, for example:

> My gateway models disappeared from `/model`. Diagnose and fix it.

> Codex models fail, but Claude models still work. Repair Model Gateway.

Claude checks authentication, local processes, ports, model discovery, updates, and settings precedence through the bundled skill. You don’t need to run the gateway’s internal commands yourself.

Authentication recovery and picker recovery have different boundaries. If auth is missing, complete `login` and let Claude run `setup` again; the already-running proxy can use the refreshed credential without killing the current Claude Code process. If settings, discovery cache, plugin files, or model rows changed, fully restart the Claude Code process for the affected project. `/reload-plugins` alone does not refresh the picker.

## Remote Control

Remote Control gives each project two choices.

### Use RC-compatibility mode

RC-compatibility keeps Model Gateway routed for the project. It maps `api.anthropic.com` to loopback in the hosts file and needs the gateway shim to bind port 80. Gateway rows disappear from `/model`, but only in RC-compatibility mode, explicit gateway ids such as `/model claude-gpt-5.6-terra[1m]` still work.

Ask Claude to enable, disable, or diagnose RC-compatibility. Its read-only diagnosis checks port 80 before any hosts-file change. If another process already holds the port, RC-compatibility cannot start until that process releases it. Docker Desktop is a common holder and is named in the refusal.

### Turn the gateway off for this project

To get Remote Control without RC-compatibility, remove only `ANTHROPIC_BASE_URL` from the `env` object in that project's `.claude/settings.local.json`. Keep every other gateway setting, then restart Claude Code. The project talks to `api.anthropic.com` directly and Remote Control becomes available.

That project has no gateway models after the restart: gateway rows disappear from `/model` and typed gateway ids do not work either. A manually exported `ANTHROPIC_BASE_URL` still wins over the file edit, so remove that environment variable before restarting if the project remains wired.

## Support

If Model Gateway saves you time, you can support its maintenance through [Ko-fi](https://ko-fi.com/eigenwise) or [GitHub Sponsors](https://github.com/sponsors/Eigenwise).

## License

MIT
