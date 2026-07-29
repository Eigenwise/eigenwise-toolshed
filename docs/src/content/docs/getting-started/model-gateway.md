---
title: Model Gateway setup
description: Use your ChatGPT and Codex subscription models from Claude Code.
---

Model Gateway runs a local proxy and puts `claude-gpt-*` models in Claude Code's `/model` picker. It uses your ChatGPT/Codex subscription through the supported proxy, so no OpenAI API key is required.

```text
/plugin install model-gateway@eigenwise-toolshed --scope user
/model-gateway:model-gateway setup
```

The setup skill installs or updates the proxy, checks authentication, and starts the local gateway. Gateway updates replace the worker behind a listener that stays bound, so open sessions keep their connection while an in-flight request drains or retries. Use `/model-gateway:model-gateway doctor` when the picker is missing models or the gateway port is unavailable. Once it is healthy, choose a `claude-gpt-*` model with `/model`; regular Claude model ids continue to use the Anthropic API.

The gateway rows are named after the model they run, with the `claude-` prefix Claude Code's discovery requires: `claude-gpt-5.6-sol`, `claude-gpt-5.6-terra`, `claude-gpt-5.6-luna`, and their `-fast` variants. The older `claude-codex-gpt-*` ids still resolve, so a project that remembers one of them keeps working; the picker only lists the new names.

The Codex path depends on `claude-code-proxy` on purpose, because OpenAI gates non-Codex clients by request fingerprint. Grok does not use the proxy.

### Codex readiness and recovery

The gateway exposes one Codex readiness signal that `ensure`, `doctor`, and Sidequest read. If the proxy is missing, the exact recovery is `node <plugin>/bin/model-gateway.js setup`, then retry. If ChatGPT sign-in is required, run `node <plugin>/bin/model-gateway.js login`, finish browser OAuth, then run `node <plugin>/bin/model-gateway.js setup` and retry. Credentials live in `~/.config/claude-code-proxy/`, not `~/.claude`.

If a Windows upgrade hits a locked executable, the old proxy is retained. Reboot, then run `node <plugin>/bin/model-gateway.js setup`. If Codex is blocked by an OpenAI rejection, run `node <plugin>/bin/model-gateway.js setup`; if it persists, wait for a `claude-code-proxy` update or explicitly re-route the ticket.

### Add Grok subscription models

Install the official Grok CLI and run `grok` once to sign in with your SuperGrok subscription. Model Gateway reads that CLI login from `~/.grok/auth.json`, refreshes it when needed, and adds `claude-grok-*` rows such as `claude-grok-4.5`, `claude-grok-build`, and `claude-grok-4.1-fast` to `/model`. No xAI API key is needed. If `doctor` reports Grok auth missing or refresh fails, run `grok` and log in again. Update the Grok CLI if it reports an outdated version header.

A Sidequest-routed agent keeps its resolved Codex route through compaction. A child agent can inherit that route only when Claude Code supplies same-session parent lineage; unrelated markerless agents stay rejected. Route logs label these requests `dispatch-inherited` with the parent agent ID and never include prompt content.

Gateway wiring uses each recorded project's private `.claude/settings.local.json`, so it does not write the team's committed `settings.json`. On a machine with no saved wiring mode, the first interactive setup asks once: "Global (all projects wired automatically via user settings) or per-project (each project opts in via its private settings.local.json — recommended)?" It persists the answer and never asks again. Non-interactive runs default to per-project with a printed notice. Change the saved mode later with `/workbench:update-toolshed --wiring-mode global|local`; switching to global keeps existing local blocks and lists them as redundant. Run `/workbench:update-toolshed` to wire recorded projects and migrate an older global gateway block. If it reports the `codex-gateway` rename, close every Claude Code session using Codex, then run its printed `--migrate-model-gateway --confirm-sessions-closed` command from a terminal. That deferred migration installs `model-gateway` at the old scopes, moves only its `~/.claude/codex-gateway` state, verifies and rewires the new gateway, and retires the old registry entry without stopping a gateway another session may use. For a project that has not been recorded, run `node <plugin>/bin/model-gateway.js env --write-project` from that project. Wiring applies to new Claude Code sessions, so restart open sessions after changing it.

The gateway pins Claude's Opus, Sonnet, and Fable aliases to their shipped 1M model ids. Pin a different native model persistently with `node <plugin>/bin/model-gateway.js pin --opus claude-opus-4-8[1m]`; `--sonnet` and `--fable` work the same way. Run `pin --opus default` to clear one, or `pin` to see the effective pins and which ones are overridden. After changing a pin, re-run `env --write-project` (or `/workbench:update-toolshed`) and start a new Claude Code session. The override is saved outside the plugin cache, so an update and a re-wire preserve it.

`/compact` on a Codex model used to fail with `websocket_missing_terminal` or "Server error mid-response" while the same conversation compacted fine on a Claude model. The proxy streams over a WebSocket that can only recover from a dropped connection before its first chunk of output, and a compaction turn spends minutes past that point. The gateway now buffers the translated stream for compaction requests only and retries the whole turn on the same model if it ends without a terminal event, so a failed attempt never reaches your session. Normal turns keep streaming live. If retries run out you get the real upstream error rather than a truncated summary presented as a complete one. Set `CODEX_GATEWAY_COMPACT_STREAM_RETRIES` to change the retry count (default 2) or `CODEX_GATEWAY_COMPACT_STREAM_GUARD=0` to turn it off; `/healthz` reports the live settings under `compaction`.

Claude Code Remote Control cannot use a local `ANTHROPIC_BASE_URL` in the same way. Run `/model-gateway:remote-control-compatibility` to safely switch compatibility mode on or off before using Remote Control, then restore gateway mode when you return.
