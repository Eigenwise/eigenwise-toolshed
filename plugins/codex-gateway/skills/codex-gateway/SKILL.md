---
name: codex-gateway
description: >-
  Manage the local gateway that puts ChatGPT/Codex subscription models in Claude Code's /model
  picker. Use for: "set up codex gateway", "codex models missing from /model", "switch to
  GPT/codex model isn't working", "codex gateway is down/broken", "stop routing through the
  gateway", or any setup/login/diagnosis of the Codex-in-Claude-Code integration.
---

# codex-gateway

Two local processes give Claude Code native access to the user's ChatGPT subscription models:
`claude-code-proxy` (does OpenAI OAuth and translates Anthropic Messages API to the Codex
backend) and a shim router this plugin owns. `ANTHROPIC_BASE_URL` points at the shim: requests
for `claude-codex-*` models are un-prefixed and go to the proxy, everything else passes through
to api.anthropic.com with the user's normal claude.ai login. The shim's `/v1/models` advertises
Codex models with the `claude-codex-` prefix because Claude Code's model discovery drops ids
that don't start with `claude`/`anthropic`.

All commands: `node "${CLAUDE_PLUGIN_ROOT}/bin/codex-gateway.js" <command>`

## First-time setup

The SessionStart hook injects a one-line nudge while the gateway is in any half-configured
state; act on it. `setup` is one-shot and idempotent: it downloads the claude-code-proxy binary
(sha256-verified), starts everything, and wires `env --write-user` automatically when ChatGPT
auth is already valid. Re-running it later is also the upgrade path.

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/codex-gateway.js" setup
# only if setup says sign-in is needed:
node "${CLAUDE_PLUGIN_ROOT}/bin/codex-gateway.js" login    # browser OAuth; --device for headless
node "${CLAUDE_PLUGIN_ROOT}/bin/codex-gateway.js" setup    # finishes the wiring
```

`login` opens the user's browser; they complete it themselves (suggest `! node ... login` if it
needs a real TTY). Prefer `env --write-project` over the default user-wide wiring only if the
user wants Codex models in this repo alone. After `env --write-user`, the user restarts Claude Code and
the Codex rows appear in `/model` labeled "From gateway". Discovery needs Claude Code v2.1.129+
and fails silently if the shim answers slowly; `models` shows exactly what's advertised.

## Selecting models

- `/model` picker: rows like "GPT-5.6-sol (Codex)".
- Typed: `/model claude-codex-gpt-5.6-sol[1m]` (any string passes through on a custom base URL).
- The `[1m]` suffix is a Claude Code compaction hint; the shim strips it and the prefix before
  forwarding. Codex GPT-5.6 models have a 372k window.
- The advertised catalog is a built-in list (proxy v0.1.10 serves no /v1/models); override it in
  `~/.claude/codex-gateway/models.json` (JSON array of ids).
- Claude models keep working normally at the same time (passthrough path); subagents can mix
  tiers freely.

## Day-2 operations

```bash
... status      # what's running
... doctor      # binary, auth, ports, model count, settings wiring
... ensure      # start whatever is down (SessionStart hook runs this with --quiet)
... stop
... env --remove   # unwire Claude Code (do this BEFORE uninstalling the plugin)
```

Logs live in `~/.claude/codex-gateway/logs/`. Ports: shim 18764, proxy 18765 (override with
`CODEX_GATEWAY_PORT` / `CODEX_GATEWAY_PROXY_PORT`, but the env block and running processes must
agree).

## Failure modes worth knowing

- **Every request fails after wiring**: shim is down and the hook couldn't start it. Run
  `doctor`, check logs. Worst case `env --remove` restores stock behavior instantly.
- **Codex models error, Claude models fine**: proxy or OpenAI side. Check `login` state
  (`doctor` shows auth), then proxy log. OpenAI gates non-Codex clients by request fingerprint;
  when they tighten it, requests die mid-stream until claude-code-proxy ships a fix, so
  suggest re-running `setup` (it fetches the latest release).
- **No "From gateway" rows in /model**: discovery is off (`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY`
  missing), Claude Code < v2.1.129, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set (it
  disables discovery), or the shim had no model cache yet; check `models`, restart the session.
- **Thinking/reasoning**: the Codex backend doesn't return thinking blocks into Claude Code's
  UI; that's an upstream limitation, not a bug here.
