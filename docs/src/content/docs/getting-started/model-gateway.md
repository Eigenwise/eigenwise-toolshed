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

The gateway exposes one Codex readiness contract that `ensure`, `doctor`, and Sidequest read. `GET /healthz` includes a `codexReadiness` object, and the model catalog includes the same readiness projection under its top-level `codexReadiness` field. Both expose `ready`, `state`, `message`, `checks`, and `upstreamBlocked`. The CLI `doctor` command prints the same state as `Codex readiness: <state>` and includes the recovery message when it is not ready.

A `ready` result proves only local setup:

- `proxyBinary`: `claude-code-proxy` exists.
- `proxyModels`: the proxy answers `GET /v1/models`.
- `codexAuth`: `claude-code-proxy codex auth status` reports an account.
- `shimRunning`: the model-gateway shim health check is OK.
- `servingVersionMatches`: the running shim version matches the installed plugin version.

Those checks do not prove that a streaming Codex request will succeed. A request can still fail upstream after local readiness is green. When a request gets an unambiguous OpenAI rejection, readiness becomes `upstream-blocked` and stays there through later health checks. A successful proxied Codex request clears that state.

The `state` value points at the repair path:

| State | Recovery |
| --- | --- |
| `binary-missing` | Run `node <plugin>/bin/model-gateway.js setup`, then retry. |
| `auth-missing` | Run `node <plugin>/bin/model-gateway.js login`, finish browser OAuth, then run `setup` and retry. Credentials live in `~/.config/claude-code-proxy/`, not `~/.claude`. |
| `proxy-down` | Run `node <plugin>/bin/model-gateway.js ensure`, then retry. |
| `shim-down` | Run `node <plugin>/bin/model-gateway.js ensure`, then retry. |
| `serving-version-mismatch` | Run `node <plugin>/bin/model-gateway.js ensure`, then retry. |
| `upstream-blocked` | Run `node <plugin>/bin/model-gateway.js setup`. If it persists, wait for a `claude-code-proxy` update or explicitly re-route the ticket. Codex tickets remain blocked. |

### Add Grok subscription models

Install the official Grok CLI and run `grok` once to sign in with your SuperGrok subscription. Model Gateway reads that CLI login from `~/.grok/auth.json`, refreshes it when needed, and adds `claude-grok-*` rows such as `claude-grok-4.5`, `claude-grok-build`, and `claude-grok-4.1-fast` to `/model`. No xAI API key is needed. If `doctor` reports Grok auth missing or refresh fails, run `grok` and log in again. Update the Grok CLI if it reports an outdated version header.

A Sidequest-routed agent keeps its resolved Codex route through compaction. A child agent can inherit that route only when Claude Code supplies same-session parent lineage; unrelated markerless agents stay rejected. Route logs label these requests `dispatch-inherited` with the parent agent ID and never include prompt content.

Model Gateway records each session's largest forwarded request body locally. Workbench shows that real request-body peak in its status line and warns at 24MB of the 32MB limit. It no longer estimates size from the Claude Code transcript, so old compactions and transcript length cannot trigger a false warning.

`Request too large (max 32MB)` normally means the raw HTTP body hit Claude Code's byte limit. Model Gateway also returns HTTP 413 to ask Claude Code to compact a Codex context before its model limit. Read the error details: `Prompt is too long for the Codex context window; compact and retry. (<actual> tokens > <trigger> tokens)` identifies the token-based gateway signal. It is separate from the 32MB body cap, so reduce the task's context or start a fresh, tighter-scoped agent instead of removing parent-session attachments.

Gateway wiring can use each recorded project's private `.claude/settings.local.json`, so it does not write the team's committed `settings.json`. Global wiring is the recommended default because it reaches every project and executor worktree. Per-project wiring is an escape hatch: it does not reach executor worktrees and Sidequest cannot detect a half-wired project. On a machine with no saved wiring mode, the first interactive setup asks once: "Global (recommended: it wires every project and executor worktree automatically) or per-project (a private-settings escape hatch that does not reach executor worktrees, and Sidequest cannot detect when it is half-wired)?" It persists the answer and never asks again. Choosing per-project immediately runs `env --write-project` from the current project. Non-interactive runs default to global with a printed notice. Change the saved mode later with `/workbench:update-toolshed --wiring-mode global|local`; switching to global keeps existing local blocks and lists them as redundant. Run `/workbench:update-toolshed` to wire recorded projects and migrate an older global gateway block. If it reports the `codex-gateway` rename, close every Claude Code session using Codex, then run its printed `--migrate-model-gateway --confirm-sessions-closed` command from a terminal. That deferred migration installs `model-gateway` at the old scopes, moves only its `~/.claude/codex-gateway` state, verifies and rewires the new gateway, and retires the old registry entry without stopping a gateway another session may use. For a project that has not been recorded, run `node <plugin>/bin/model-gateway.js env --write-project` from that project. Wiring applies to new Claude Code sessions, so restart open sessions after changing it.

The gateway pins Claude's Opus, Sonnet, and Fable aliases to their shipped 1M model ids. Pin a different native model persistently with `node <plugin>/bin/model-gateway.js pin --opus claude-opus-4-8[1m]`; `--sonnet` and `--fable` work the same way. Run `pin --opus default` to clear one, or `pin` to see the effective pins and which ones are overridden. After changing a pin, re-run `env --write-project` (or `/workbench:update-toolshed`) and start a new Claude Code session. The override is saved outside the plugin cache, so an update and a re-wire preserve it.

### Troubleshooting

:::caution
If a Windows upgrade hits a locked executable, the old proxy is retained. Reboot, then run `node <plugin>/bin/model-gateway.js setup`.
:::

`/compact` on a Codex model used to fail with `websocket_missing_terminal` or "Server error mid-response" while the same conversation compacted fine on a Claude model. The proxy streams over a WebSocket that can only recover from a dropped connection before its first chunk of output, and a compaction turn spends minutes past that point. The gateway now buffers the translated stream for compaction requests only and retries the whole turn on the same model if it ends without a terminal event, so a failed attempt never reaches your session. Normal turns keep streaming live. Set `CODEX_GATEWAY_COMPACT_STREAM_RETRIES` to change the retry count (default 2) or `CODEX_GATEWAY_COMPACT_STREAM_GUARD=0` to turn it off; `/healthz` reports the live settings under `compaction`.

:::caution
If retries run out you get the real upstream error rather than a truncated summary presented as a complete one.
:::

Claude Code Remote Control cannot use a local `ANTHROPIC_BASE_URL` in the same way. Run `/model-gateway:remote-control-compatibility` to safely switch compatibility mode on or off before using Remote Control, then restore gateway mode when you return.
