---
name: enable-project-telemetry
description: >-
  Opt the current project into local Claude Code usage telemetry, or verify its setup. Use to enable,
  disable, or check project telemetry.
---

# Enable Project Telemetry

Telemetry is opt-in per repository. A project is its enclosing git repository, so every working directory
inside it (subdirectories, linked worktrees) reports under the repository's identity and lands on one
dashboard. Never write user-scope settings and never enable it for a different project. The local registry
only includes repositories that explicitly opted in, so dashboard work can exclude every other project.

Claude Code reads `OTEL_RESOURCE_ATTRIBUTES` from the settings of the directory a session started in and does
not walk up to the repository root. That is why the enable command writes the env into the repository root
**and** into each subdirectory that has hosted Claude Code sessions, all carrying the repository's
`project.id`. Hook-based observer data needs none of that: it is repository-rooted from the first event.

Read `setup-reference.md` before the first enable on a machine. It owns the consent question, the
`setup-observability.js` commands that install the pinned Collector and choose a sink, dashboard, and ports,
and the deletion rules. Do the setup pass first, then the per-project wiring below.

## Enable

Gateway wiring is per-scope. If the gateway is unwired for the current project, invoke `/model-gateway:model-gateway` and use its `env --write-project` command to wire this project. Use `env --write-user` only when machine-wide wiring is wanted. Do not invoke a bare `codex-gateway` shell command, since the installed plugin command is not on PATH.

1. Confirm the user wants local, metadata-only usage telemetry for the current repository. Say it writes only
   this repository's own `.claude/settings.local.json` files, then sends metadata through the local loopback
   observer and Collector to local Grafana: API-equivalent cost; input, output, and cache token totals;
   tool-call names, counts, and result-token estimates; and model, session, agent, and activity information. It
   does not capture prompt or response text, code or file contents, tool inputs or results, raw request bodies,
   credentials, or environment values.
2. Run it from anywhere inside the repository; it resolves the repository root itself:

   ```sh
   node "${CLAUDE_PLUGIN_ROOT}/bin/project-telemetry.js" --project "<absolute-current-project-dir>"
   ```

   This creates or merges the `env` object without dropping unrelated keys. It adds the Claude Code telemetry
   settings, including `OTEL_RESOURCE_ATTRIBUTES` with the sanitized repository basename and
   `service.name=claude-code`. The registry stores the same sanitized name plus the SHA-256 repository ID used
   by this plugin's hooks. Session-hosting subdirectories are found by encoding each real subdirectory the way
   Claude Code encodes `~/.claude/projects/` names and keeping the ones that exist there; `.claude/worktrees`,
   `.git`, `node_modules`, dot-directories, and nested repositories are skipped.
3. Report every directory the command printed, and tell the user settings environment changes apply only to
   **new Claude Code sessions**. Any session already running in one of those directories has to restart before
   its metrics appear, not only the session in the repository root.
4. After that new session creates activity, verify honestly:

   ```sh
   node "${CLAUDE_PLUGIN_ROOT}/bin/verify-project-telemetry.js" --project "<absolute-current-project-dir>"
   ```

   `found` means the local observer is healthy and the local Grafana/Loki stack has a
   `claude_code_token_usage_tokens_total` metric tagged with this project. `not-found` means the command did
   not see it yet, or no dashboard is configured. Report that result as-is, never claim telemetry is flowing
   before the command says `found`. If the dashboard is unavailable, keep the observer and SQLite ingestion running; diagnose and report the observer, collector, downstream sink, and dashboard as separate planes.
5. When `not-found` persists after a restart and real activity, add `--audit` to the same command. It lists the
   repository's session directories with their wiring state, names any opted-in project sending observer events
   with no `claude_code_*` samples, and prints the command that fixes it.

## Storage pressure

The observer reserves 128 MiB below its 4 GiB database limit. It prunes expired observations first, then oldest whole days inside the 30-day window only when pressure remains, and records the exact windows and row counts in `/health`. A health failure of `storage_headroom_unrecoverable` means no removable data restored that reserve. Explain that committed ingestion still receives its normal acknowledgement, then diagnose disk and retention pressure from the health response. Do not tell the user to run `VACUUM`: the managed path compacts reusable pages when it can, and the manual prune command checks free space before a full vacuum.

## Disable

Run:

```sh
node "${CLAUDE_PLUGIN_ROOT}/bin/project-telemetry.js" --project "<absolute-current-project-dir>" --disable
```

It unwires the same set enable wired, from wherever in the repository it is run, using each directory's own
state file. It restores only env values this flow replaced, preserves later user edits and unrelated settings,
and removes the repository from the machine-local opted-in registry. It leaves the shared observer, Collector,
and historical local data alone because another opted-in project may still use them. Restart Claude Code in
each listed directory for the removed env block to take effect.

## Manual scratch-project check

Use this only when validating the flow itself. Set a temporary home and project directory, invoke the enable
command from that directory, inspect `.claude/settings.local.json` for the telemetry block, then run the verify
command before any new session activity. Its expected honest result is `not-found` until a restarted Claude Code
session emits telemetry. A scratch directory with no `.git` above it is its own project, which is what makes it
a scratch project rather than part of the surrounding repository.
