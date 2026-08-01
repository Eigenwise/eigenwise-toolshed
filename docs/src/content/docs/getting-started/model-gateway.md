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

Gateway wiring is global: `env --write-user` writes `~/.claude/settings.json` once and reaches every project and every executor worktree. Per-project wiring existed as a mode and was removed, because a project `.claude/settings.local.json` outranks user settings and a stale project block silently overrode the gateway URL with nothing on screen to explain it. To exempt one project deliberately, set `ANTHROPIC_BASE_URL` in that project's `settings.local.json` yourself; `doctor` marks whichever file wins as `[effective]`. Run `/workbench:update-toolshed` to wire recorded projects and migrate an older global gateway block. If it reports the `codex-gateway` rename, close every Claude Code session using Codex, then run its printed `--migrate-model-gateway --confirm-sessions-closed` command from a terminal. That deferred migration installs `model-gateway` at the old scopes, moves only its `~/.claude/codex-gateway` state, verifies and rewires the new gateway, and retires the old registry entry without stopping a gateway another session may use. Wiring applies to new Claude Code sessions, so restart open sessions after changing it. Claude Code resolves `ANTHROPIC_BASE_URL` from process environment first, then the current project's `.claude/settings.local.json`, project `.claude/settings.json`, and user `~/.claude/settings.json`. `doctor` marks the winner `[effective]`; a compat/default contradiction is a hard failure. A process-environment winner must be unset outside settings.

`env --write-user --reconcile` is a separate confirmation-gated command. Plain `env --write-user` lists recorded projects whose local URL differs and leaves their `.claude/settings.local.json` files unchanged. Confirming reconciliation writes to OTHER projects and removes only Model Gateway-owned wiring keys, leaving unrelated settings alone. It cannot change an inherited process environment, and cleanup takes effect for the next session after a restart.

The gateway pins Claude's Opus, Sonnet, and Fable aliases to their shipped 1M model ids. Pin a different native model persistently with `node <plugin>/bin/model-gateway.js pin --opus claude-opus-4-8[1m]`; `--sonnet` and `--fable` work the same way. Run `pin --opus default` to clear one, or `pin` to see the effective pins and which ones are overridden. After changing a pin, re-run `env --write-user` (or `/workbench:update-toolshed`) and start a new Claude Code session. The override is saved outside the plugin cache, so an update and a re-wire preserve it.

### Troubleshooting

:::caution
If a Windows upgrade hits a locked executable, the old proxy is retained. Reboot, then run `node <plugin>/bin/model-gateway.js setup`.
:::

`/compact` on a Codex model used to fail with `websocket_missing_terminal` or "Server error mid-response" while the same conversation compacted fine on a Claude model. The proxy streams over a WebSocket that can only recover from a dropped connection before its first chunk of output, and a compaction turn spends minutes past that point. The gateway now buffers the translated stream for compaction requests only and retries the whole turn on the same model if it ends without a terminal event, so a failed attempt never reaches your session. Normal turns keep streaming live. Set `CODEX_GATEWAY_COMPACT_STREAM_RETRIES` to change the retry count (default 2) or `CODEX_GATEWAY_COMPACT_STREAM_GUARD=0` to turn it off; `/healthz` reports the live settings under `compaction`.

:::caution
If retries run out you get the real upstream error rather than a truncated summary presented as a complete one.
:::

Claude Code Remote Control cannot use a local `ANTHROPIC_BASE_URL` in the same way. Run `/model-gateway:remote-control-compatibility` to safely switch compatibility mode on or off before using Remote Control, then restore gateway mode when you return. In compatibility mode, Claude Code may show its built-in first-party `/model` list instead of the Codex rows. Pin a visible Claude alias to a Codex id, rewire, and restart if needed, for example `pin --opus claude-gpt-5.6-terra` followed by `env --write-user`; Sidequest dispatch resolves its route directly and is unaffected.
