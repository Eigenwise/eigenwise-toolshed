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

1. Confirm the user wants metadata-only usage telemetry for the current project. Say it writes this project's
   `.claude/settings.local.json`, starts or reuses the local loopback observer and Collector, and records a
   machine-local registry entry. It does not capture prompts, responses, tool content, raw request bodies,
   credentials, or environment values.
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
