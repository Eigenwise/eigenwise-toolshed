---
title: Model Gateway
description: Add ChatGPT/Codex and Grok subscription models to Claude Code.
---

Model Gateway adds subscription-backed GPT and Grok models to Claude Code. Claude Code v2.1.129+ can show those gateway models in its `/model` picker. Claude models keep using Anthropic normally.

## Install

Run these in Claude Code:

```text
/plugin marketplace add Eigenwise/eigenwise-toolshed
/plugin install model-gateway@eigenwise-toolshed --scope project
```

Reload the plugin, then start the Model Gateway skill:

> Set up Model Gateway for me.

The skill runs `setup` with project-local wiring, installs and starts the local gateway, checks your subscription login, and confirms the current project's `.claude/settings.local.json`. If setup asks for login, complete the browser sign-in, then let Claude run `setup` again to finish and confirm the project wiring.

After the wiring is confirmed, fully restart the Claude Code process for that same project. A plugin reload alone does not reload the picker cache or the settings in the new process. Select a gateway model only after that restart.

Model Gateway writes `ANTHROPIC_BASE_URL` to `.claude/settings.local.json`, never the committed `.claude/settings.json`. That keeps your local gateway endpoint out of other people's checkouts. You can opt into one shared fallback URL in `~/.claude/settings.json`, but a project's local setting wins. `model-gateway doctor` marks the effective source and calls out conflicting gateway modes.

A process `ANTHROPIC_BASE_URL` has higher precedence than either settings file. If `doctor` or SessionStart says it shadows a wired file, Model Gateway is bypassed. If you control the Claude Code CLI launch, correct or unset that value, then restart. If the host replaces it, use the supported Claude Code CLI on the wired project instead. Model Gateway does not support Desktop routing under forced overrides on Windows or macOS, and settings, parent, or User-scope edits cannot be promised to win.

You may need to complete a browser sign-in or restart Claude Code. Claude will ask only when either step is actually needed.

## Pick a model

In Claude Code v2.1.129+, open `/model` and choose a row labeled `From gateway`. Claude Code only refetches gateway discovery
with an API-key credential. Model Gateway writes its discovery cache for OAuth subscriptions, and
new rows appear after a full Claude Code restart. `/reload-plugins` does not reload the picker cache.

- `claude-gpt-*[1m]` uses your ChatGPT/Codex subscription. `MODEL_WINDOW_POLICY` in Model Gateway's runtime is the authority for every gateway picker row. GPT-5.6 Sol, Terra, Luna, and GPT-6 Astra are measured rows; other Codex proxy rows use its explicit unmeasured 920k default until measured.
- A `[1m]` alias gives Claude Code a 1M client window, but a lower explicit `autoCompactWindow` still wins. The optional `325000` setting is a cap, and with that cap the client compacts around `292000`. The alias is removed before forwarding to the backend and does not promise a 1M backend input limit. Use `/context` to inspect the selected model and effective cap.
- `claude-grok-4.5[1m]` uses your Grok subscription when the Grok CLI is installed and signed in. Its measured backend window is 500k. The alias is removed before requests reach the backend.
- Claude models keep using Anthropic.

Codex rejects some JSON Schema regex Unicode property escapes, including `\p{Cc}` and `\P{Cf}`. When a deferred tool resolves, Model Gateway can make a narrow Codex-only compatibility copy of its `input_schema`. It supports a missing dialect or Draft 2020-12, and only a `pattern` on the documented positive paths: `properties`, compatible `patternProperties` values, `additionalProperties`, `items`, `prefixItems`, `allOf`, `anyOf`, `dependentSchemas`, `propertyNames`, and `unevaluatedProperties` or `unevaluatedItems`. Each real property atom has to be a standalone member of a negated character class, with no range, set syntax, capture, backreference, or negative regex context. The lexer consumes every allowed escape as one token, so escaped parentheses, brackets, and backslashes stay literal data rather than group or class structure. The copy removes only that atom and keeps every other regex byte. Unsupported affected schemas return a local 400 with the tool name, JSON Pointer, and reason code, before any request is forwarded or sent to another provider. Claude Code still holds the original tool schema and Anthropic requests stay byte-identical.

Sidequest can select these models automatically when both plugins are installed.

## Daily use

There are no routine Model Gateway commands to remember. The shim supervisor checks the proxy's `/v1/models` endpoint while it runs and confirms a failed probe through a fresh connection before recovering an unavailable proxy with bounded backoff. It leaves a healthy proxy alone. If a session survives a plugin update, its older plugin copy leaves the newer shim running and asks you to reload plugins or restart Claude Code. Claude handles setup, updates, authentication checks, model discovery, and settings repair through the skill.

SessionStart launches a missing supervisor outside the hook's process tree, then waits no more than 12 seconds inside its 30-second hook budget. A slow proxy keeps starting in the background. Claude asks you to retry the Codex model in a few seconds instead of holding the session-start hook open.

When the gateway disappears or restarts, ask Claude to run `doctor`. It names `~/.claude/model-gateway/logs/lifecycle.jsonl` and says whether it found an observed supervisor, worker, or proxy exit. The bounded records include PIDs, orderly setup/stop/restart requests, signals, and recovery outcomes. A force-killed supervisor or OS termination can leave no final record, so a missing exit entry does not prove an orderly shutdown.

Running Model Gateway's own suite uses a separate test home and never touches the installed gateway. Codex sessions dropping while tests ran was a supervisor cleanup bug, fixed in this version. Cleanup uses this home's recorded PIDs and targeted ownership checks only: the live command must still identify this install, and the recorded command or start time must match. A stale record is deleted without stopping its reused PID; `doctor` reports `stale pid file guardian: PID <pid> is now <command>`. If startup, restart, or drain cannot confirm who owns a listener, it leaves that listener alone and startup records `owner-unknown`; confirmed foreign listeners are refused too.

If something breaks, describe the symptom:

> My gateway models disappeared from `/model`. Diagnose and fix it.

> Codex fails, but Claude models still work. Repair Model Gateway.

## Troubleshooting model visibility

If GPT-6 Astra is missing from `/model`, check the installed and serving claude-code-proxy version before diagnosing account access. Astra requires version 0.1.36 or newer. Version 0.1.35 does not include its backend allowlist, and the current `doctor` check can still report `PASS` when Astra is the missing row. Ask Claude to rerun `setup`, which fetches the latest GitHub release, then fully restart Claude Code. A `models.json` edit cannot add a backend that the proxy does not allow.

Authentication recovery has a different boundary. Complete `login` and let Claude run `setup` again; the refreshed credential can serve the already-running proxy, so a process restart is not required just for auth. Settings, discovery-cache, plugin, or model-row changes do require a full restart of the affected project process. `/reload-plugins` alone is not enough.

## Local gateway records

The shim writes request-route metadata to `~/.claude/model-gateway/logs/request-routes.jsonl` by default. Records contain the time, backend, model, request path, route and effort when present, and safe session or agent correlation fields. They do not contain request bodies, prompts, messages, tools, authentication, or arbitrary headers. Set `CODEX_GATEWAY_REQUEST_LOG=0` before the shim starts, then restart the shim through `setup` or `ensure`, to disable this route log. The setting is read by the shim process at startup. `CODEX_GATEWAY_REQUEST_LOG_PATH` changes the file location.

Usage observability also keeps one high-water JSON file per valid session under `~/.claude/model-gateway/request-body/`. It records only the largest forwarded request-body byte count seen for that session and an observation timestamp. It does not contain the request body. No retention period is promised for either local record.

Remote Control gives each project two choices.

### Use RC-compatibility mode

RC-compatibility keeps Model Gateway routed for the project. It maps `api.anthropic.com` to loopback in the hosts file and needs the gateway shim to bind port 80. Gateway rows disappear from `/model`, but only in RC-compatibility mode, explicit gateway ids such as `/model claude-gpt-5.6-terra` still work.

Tell Claude you want to enable, disable, or diagnose RC-compatibility. Its read-only diagnosis checks port 80 before any hosts-file change. If another process already holds the port, RC-compatibility cannot start until that process releases it. Docker Desktop is a common holder and is named in the refusal. Enabling refuses before any backup, hosts write, gateway startup, or reconciliation when effective process `ANTHROPIC_BASE_URL` is HTTPS `api.anthropic.com` (including port 443), because the loopback mapping would send TLS traffic to an unsupported endpoint. If you control the Claude Code CLI launch, correct or unset that value, then restart. If the host replaces it, use the supported Claude Code CLI on the wired project instead. Desktop routing is unsupported under forced overrides on Windows and macOS, and settings, parent, or User-scope edits cannot be promised to win. Disabling stays available.

### Turn the gateway off for this project

To get Remote Control without RC-compatibility, remove only `ANTHROPIC_BASE_URL` from the `env` object in that project's `.claude/settings.local.json`. Keep every other gateway setting, then restart Claude Code. The project talks to `api.anthropic.com` directly and Remote Control becomes available.

That project has no gateway models after the restart: gateway rows disappear from `/model` and typed gateway ids do not work either. A process-exported `ANTHROPIC_BASE_URL` still wins over the file edit. If you control the Claude Code CLI launch, correct or unset that value, then restart. If the host replaces it, use the supported Claude Code CLI on the wired project instead. Desktop routing is unsupported under forced overrides on Windows and macOS, and settings, parent, or User-scope edits cannot be promised to win.

The generated [Model Gateway reference](../../reference/model-gateway/) records the agent-facing commands and configuration details used by the skill.
