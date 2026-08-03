---
title: Model Gateway setup
description: Use your ChatGPT and Codex subscription models from Claude Code.
---

Model Gateway runs a local proxy and puts `claude-gpt-*` models in Claude Code's `/model` picker. It uses your ChatGPT/Codex subscription through the supported proxy, so no OpenAI API key is required.

Model Gateway must be installed for your user account:

```text
/plugin install model-gateway@eigenwise-toolshed --scope user
/model-gateway:model-gateway setup
```

Gateway wiring is global-only. `env --write-user` writes `~/.claude/settings.json`, `--write-project` is retired, and the keepalive hook must be live in every project and every executor worktree. Do not choose a project-scoped wiring mode.

The setup skill installs or updates the proxy, checks authentication, and starts the local gateway. To update an installed gateway, run exactly `node ~/.claude/model-gateway/update.js`. It downloads and verifies the proxy, swaps the executable by rename while the old process keeps serving, restarts it when it can, and reports the resulting state. Use `/model-gateway:model-gateway doctor` when the picker is missing models or the gateway port is unavailable. Once it is healthy, choose a `claude-gpt-*` model with `/model`; regular Claude model ids continue to use the Anthropic API.

The gateway rows are named after the model they run, with the `claude-` prefix Claude Code's discovery requires: `claude-gpt-5.6-sol`, `claude-gpt-5.6-terra`, `claude-gpt-5.6-luna`, and their `-fast` variants. The older `claude-codex-gpt-*` ids still resolve, so a project that remembers one of them keeps working; the picker only lists the new names.

The Codex path depends on `claude-code-proxy` on purpose, because OpenAI gates non-Codex clients by request fingerprint. Grok does not use the proxy.

### Choosing between the models

The [Playbook](./playbook/) plugin's `/playbook:pick-model` skill describes what each reachable
model is good at, including the Codex and Grok models this gateway adds, so a model gets suggested
with a stated reason rather than picked by habit.

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

The `doctor` output also includes a model fallback diagnostic. If the model used by a dispatch and the served model appear different, reproduce the problem in a throwaway session with `CLAUDE_CODE_NO_MODEL_FALLBACK=true`. That turns silent fallback into a thrown error identifying the call site. Unset the variable afterwards; normal operation keeps graceful fallback for transient 5xx errors.

### Migrating from codex-gateway

`codex-gateway` was renamed to `model-gateway` in 0.38.0. Install and invoke Model Gateway, then run setup, `env --write-user`, and restart Claude Code. Existing `claude-codex-*` model ids still resolve, while the picker advertises current `claude-gpt-*` and `claude-grok-*` ids. `/workbench:update-toolshed` migrates older per-project wiring to the global user block. Remove old wiring before uninstalling the legacy plugin so open sessions do not keep pointing at its shim.

### Settings, state, and overrides

The plugin owns one gateway `env` block in `~/.claude/settings.json`: the local base URL, model discovery, non-streaming fallback protection, tool search, output-token limit, and native Opus, Sonnet, and Fable pins. It removes only those keys, plus its legacy auto-compact key, when you run `env --remove`. Runtime state lives under `~/.claude/model-gateway/`, including the downloaded proxy, logs, model catalog, route metadata, dispatch metadata, and supervisor failure markers. ChatGPT/Codex credentials stay with `claude-code-proxy` under `~/.config/claude-code-proxy/` (or `%APPDATA%\\claude-code-proxy\\` on Windows); Grok credentials stay in `~/.grok/auth.json`.

Optional process overrides cover ports, context and compaction thresholds, streaming retries, request-route logs, trace and usage telemetry, and the request-body high-water directory. Restart the gateway after changing them. `ANTHROPIC_BASE_URL` resolves from process environment, project-local settings, project shared settings, then user settings; `doctor` marks the effective winner and flags compat/default contradictions.

### Upgrade behavior

The gateway uses one supervisor and reports both installed and serving versions. If the proxy on disk differs from the process still serving, `ensure` retries the restart on its next run. The stable updater leaves a locked old executable as a `.old-*` file and cleans it up on a later setup or ensure, once the operating system releases it.

### Add Grok subscription models

Install the official Grok CLI and run `grok` once to sign in with your SuperGrok subscription. Model Gateway reads that CLI login from `~/.grok/auth.json`, refreshes it when needed, and adds `claude-grok-*` rows to `/model`. No xAI API key is needed. If `doctor` reports Grok auth missing or refresh fails, run `grok` and log in again. Update the Grok CLI if it reports an outdated version header.

Which Grok models are actually served comes from the CLI's own model cache (`~/.grok/models_cache.json`), which is authoritative over the ids listed here or in the plugin's built-in list. As of August 2026 the cache serves `grok-4.5` alone, and `grok-build` is that same model running inside xAI's agentic coding harness rather than separate weights. xAI retires `grok-4.1-fast` on 2026-08-15, after which the id stops resolving.

A Sidequest-routed agent keeps its resolved Codex route through compaction. A child agent can inherit that route only when Claude Code supplies same-session parent lineage; unrelated markerless agents stay rejected. Route logs label these requests `dispatch-inherited` with the parent agent ID and never include prompt content.

Model Gateway records each session's largest forwarded request body locally. The Observability plugin shows that real request-body peak in its status line and warns at 24MB of the 32MB limit. It no longer estimates size from the Claude Code transcript, so old compactions and transcript length cannot trigger a false warning.

`Request too large (max 32MB)` normally means the raw HTTP body hit Claude Code's byte limit. Model Gateway also returns HTTP 413 to ask Claude Code to compact a Codex context before its model limit. Read the error details: `Prompt is too long for the Codex context window; compact and retry. (<actual> tokens > <trigger> tokens)` identifies the token-based gateway signal. It is separate from the 32MB body cap, so reduce the task's context or start a fresh, tighter-scoped agent instead of removing parent-session attachments.

Gateway wiring is global-only: `env --write-user` writes `~/.claude/settings.json` once and reaches every project and every executor worktree. The `--write-project` mode is retired. The hosts file is machine-wide, so global wiring is what makes RC-compatibility manageable. Run `/workbench:update-toolshed` to migrate older wiring. Wiring applies to new Claude Code sessions, so restart open sessions after changing it. Claude Code resolves `ANTHROPIC_BASE_URL` from process environment first, then the current project's `.claude/settings.local.json`, project `.claude/settings.json`, and user `~/.claude/settings.json`. `doctor` marks the winner `[effective]`; a compat/default contradiction is a hard failure. A process-environment winner must be unset outside settings. Remote Control and the Codex/Grok rows in `/model` cannot both work: RC-compatibility points the base URL at `api.anthropic.com`, which disables gateway model discovery. Type an explicit id such as `/model claude-gpt-5.6-terra` to keep using the gateway model; it persists as the default. Disabling compatibility restores the picker rows.

`env --write-user --reconcile` is a separate confirmation-gated command. Plain `env --write-user` lists recorded projects whose local URL differs and leaves their `.claude/settings.local.json` files unchanged. Confirming reconciliation writes to OTHER projects and removes only Model Gateway-owned wiring keys, leaving unrelated settings alone. It cannot change an inherited process environment, and cleanup takes effect for the next session after a restart.

The gateway pins Claude's Opus, Sonnet, and Fable aliases to their shipped 1M model ids. Pin a different native model persistently with `node <plugin>/bin/model-gateway.js pin --opus claude-opus-4-8[1m]`; `--sonnet` and `--fable` work the same way. Run `pin --opus default` to clear one, or `pin` to see the effective pins and which ones are overridden. After changing a pin, re-run `env --write-user` (or `/workbench:update-toolshed`) and start a new Claude Code session. The override is saved outside the plugin cache, so an update and a re-wire preserve it.

### Troubleshooting

:::caution
If the operating system still holds an old proxy executable, the stable updater keeps it as a `.old-*` file and tries to remove it on later setup or ensure runs. The new proxy is already installed at the canonical path, so keep using the gateway normally.
:::

`/compact` on a Codex model used to fail with `websocket_missing_terminal` or "Server error mid-response" while the same conversation compacted fine on a Claude model. The proxy streams over a WebSocket that can only recover from a dropped connection before its first chunk of output, and a compaction turn spends minutes past that point. The gateway now buffers the translated stream for compaction requests only and retries the whole turn on the same model if it ends without a terminal event, so a failed attempt never reaches your session. Normal turns keep streaming live. Set `CODEX_GATEWAY_COMPACT_STREAM_RETRIES` to change the retry count (default 2) or `CODEX_GATEWAY_COMPACT_STREAM_GUARD=0` to turn it off; `/healthz` reports the live settings under `compaction`.

:::caution
If retries run out you get the real upstream error rather than a truncated summary presented as a complete one.
:::

Claude Code Remote Control and the Codex/Grok rows in `/model` cannot both work. Run `/model-gateway:remote-control-compatibility` to switch compatibility mode on or off before using Remote Control. Compatibility points `ANTHROPIC_BASE_URL` at `api.anthropic.com`, so Claude Code disables gateway model discovery and the rows disappear from the picker. Type an explicit id such as `/model claude-gpt-5.6-terra`; it still works and persists as the default. Disabling compatibility restores the rows. Sidequest dispatch resolves its route directly and is unaffected.
