---
name: enable-project-telemetry
description: >-
  Opt this project into local Claude Code usage telemetry. Writes only this project's private settings,
  prepares Workbench's loopback observer and Collector, records the local project registry, and verifies
  whether metrics arrive. Use when the user asks to enable, disable, or verify project telemetry.
---

# Enable Project Telemetry

Telemetry is opt-in per project. Never write user-scope settings and never enable it for a different project.
The local registry only includes projects that explicitly opted in, so dashboard work can exclude every other
project.

## Enable

Before the telemetry consent, invoke `/codex-gateway:codex-gateway` and use its `env --show-mode` command to inspect the machine-local gateway mode. Do not invoke a bare `codex-gateway` shell command, since the installed plugin command is not on PATH. When no mode is saved, ask exactly once: **"Global (all projects wired automatically via user settings) or per-project (each project opts in via its private settings.local.json — recommended)?"** Global gives zero-friction coverage everywhere. Per-project keeps personal wiring out of shared repos and makes each opt-in explicit. Persist the answer through that skill with its `env --mode global` or `env --mode local` command; never ask again once it exists. For a non-interactive invocation, leave the mode unset, use local behavior, and report `wiring mode defaulted to per-project; use /codex-gateway:codex-gateway to run its env --mode global command to change`.

1. Confirm the user wants local, metadata-only usage telemetry for the current project. Say it writes only this
   project's `.claude/settings.local.json`, then sends metadata through the local loopback observer and Collector
   to local Grafana: API-equivalent cost; input, output, and cache token totals; tool-call names, counts, and
   result-token estimates; and model, session, agent, and activity information. It does not capture prompt or
   response text, code or file contents, tool inputs or results, raw request bodies, credentials, or environment
   values.
2. Run:

   ```sh
   node "${CLAUDE_PLUGIN_ROOT}/bin/project-telemetry.js" --project "<absolute-current-project-dir>"
   ```

   This creates or merges the `env` object without dropping unrelated keys. It adds the Claude Code telemetry
   settings, including `OTEL_RESOURCE_ATTRIBUTES` with the sanitized project basename and `service.name=claude-code`.
   The registry stores the same sanitized name plus the SHA-256 project ID used by Workbench hooks.
3. Tell the user settings environment changes apply only to **new Claude Code sessions**. They should restart
   Claude Code, then do a small request in the project.
4. After that new session creates activity, verify honestly:

   ```sh
   node "${CLAUDE_PLUGIN_ROOT}/bin/verify-project-telemetry.js" --project "<absolute-current-project-dir>"
   ```

   `found` means the local observer is healthy and the local Grafana/Loki stack has a
   `claude_code_token_usage_tokens_total` metric tagged with this project. `not-found` means the command did
   not see it yet, or no dashboard is configured. Report that result as-is, never claim telemetry is flowing
   before the command says `found`.

## Disable

Run:

```sh
node "${CLAUDE_PLUGIN_ROOT}/bin/project-telemetry.js" --project "<absolute-current-project-dir>" --disable
```

It restores only env values this flow replaced, preserves later user edits and unrelated settings, and removes
that project from the machine-local opted-in registry. It leaves the shared observer, Collector, and historical
local data alone because another opted-in project may still use them. Restart Claude Code for the removed env
block to take effect.

## Manual scratch-project check

Use this only when validating the flow itself. Set a temporary home and project directory, invoke the enable
command from that directory, inspect `.claude/settings.local.json` for the telemetry block, then run the verify
command before any new session activity. Its expected honest result is `not-found` until a restarted Claude Code
session emits telemetry.
