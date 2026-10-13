---
name: enable-project-telemetry
description: >-
  Opt the current project into local Claude Code usage telemetry, or verify its setup. Use to enable,
  disable, or check project telemetry.
---

# Enable Project Telemetry

Telemetry capture and log export are gated on the canonical repository ID in the local opt-in registry. Installing this plugin at user, project, or local scope does not itself choose every repository. Disabling this repository stops future capture and future export of still-queued log rows while local history is retained. Collector traces and metrics are not covered by this gate. This skill asks for the shared service choice, then writes the current repository's opt-in wiring.

Claude Code reads `OTEL_RESOURCE_ATTRIBUTES` from the settings of the directory a session started in and does
not walk up to the repository root. That is why the enable command writes the env into the repository root
**and** into each subdirectory that has hosted Claude Code sessions, all carrying the repository's
`project.id`. Hook events from linked worktrees resolve to the enclosing main repository identity, but native
Claude Code metrics from a linked-worktree-started session need wiring in that exact start directory. Do not
promise linked-worktree native coverage from this repository opt-in alone.

Since Claude Code 2.1.282, project and local settings can no longer turn telemetry export on. Claude Code ignores
`CLAUDE_CODE_ENABLE_TELEMETRY`, `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA`, `OTEL_{METRICS,LOGS,TRACES}_EXPORTER` and
every `OTEL_EXPORTER_OTLP_*` there; they only count from user settings (`~/.claude/settings.json`, or
`$CLAUDE_CONFIG_DIR/settings.json`), managed settings, `--settings`, or the launch environment.
`OTEL_RESOURCE_ATTRIBUTES` is still read from project settings, so the per-directory `project.id` wiring keeps
attributing sessions. On 2.1.282 and later a project is wired only when both hold: `project.id` in the session
directory and export turned on at user level. Before 2.1.282 the project files alone are enough. SessionStart
warns when an opted-in machine runs 2.1.282 or later without user-level export; it never writes settings.

Read `setup-reference.md` before the first enable on a machine. It owns the separate shared-service consent question, the
`setup-observability.js` commands that install the pinned Collector and choose a sink, dashboard, and ports,
and the deletion rules. Do the shared service setup pass first, then the per-project wiring below.

## Enable

Gateway wiring is per-scope. If the gateway is unwired for the current project, invoke `/model-gateway:model-gateway` and use its `env --write-project` command to wire this project. Use `env --write-user` only when machine-wide wiring is wanted. Do not invoke a bare `codex-gateway` shell command, since the installed plugin command is not on PATH.

1. Confirm the user wants the shared local observer and Collector, then separately confirm that the current repository should opt in. Say the repository opt-in writes only this repository's `.claude/settings.local.json` files and adds it to the local project registry. The shared service can send local metadata through the loopback observer and Collector to local Grafana, or to a remote sink only when the user chooses one. Bare setup is SQLite-only with no dashboard; `--dashboard` explicitly requests the Docker-backed dashboard. Explain that API-equivalent cost estimates are not subscription charges, and models without a published API price remain visible without an invented USD total. The intended telemetry schema excludes prompt or response text, code or file contents, tool inputs or results, raw request bodies, credentials, and environment values. Exporter settings the user provides, including OTLP headers or tokens, are stored locally in `%LOCALAPPDATA%\Eigenwise\Workbench\observability.json` on Windows, or `~/.local/share/Eigenwise/Workbench/observability.json` when `LOCALAPPDATA` is not set, so an exporter can authenticate.

   Telemetry capture and log export are gated on the canonical repository ID in the local opt-in registry. Installing this plugin at user, project, or local scope does not itself choose every repository. Disabling this repository stops future capture and future export of still-queued log rows while local history is retained. Collector traces and metrics are not covered by this gate.
2. Run it from anywhere inside the repository; it resolves the repository root itself:

   ```sh
   node "${CLAUDE_PLUGIN_ROOT}/bin/project-telemetry.js" --project "<absolute-current-project-dir>"
   ```

   This creates or merges the `env` object without dropping unrelated keys. It adds the Claude Code telemetry
   settings, including `OTEL_RESOURCE_ATTRIBUTES` with the SHA-256 repository ID as `project.id`, the sanitized
   repository basename as `project.name`, and `service.name=claude-code`. The registry stores the same sanitized
   name plus the SHA-256 repository ID used by this plugin's hooks. Re-running enable rewrites this repository's
   env with those values; it never rewrites any other project's settings. Session-hosting subdirectories are found by encoding each real subdirectory the way
   Claude Code encodes `~/.claude/projects/` names and keeping the ones that exist there; `.claude/worktrees`,
   `.git`, `node_modules`, dot-directories, and nested repositories are skipped.
   On Claude Code 2.1.282 or later the command ends with `Nothing exports yet` when user-level export is off.
   Relay that, then ask the user before turning export on: it writes to their user settings and makes every
   Claude Code session on this machine export to the local Collector. The observer keeps only opted-in projects,
   but traces and metrics from other projects reach a configured sink or dashboard without the opt-in gate. Only
   after an explicit yes, run:

   ```sh
   node "${CLAUDE_PLUGIN_ROOT}/bin/project-telemetry.js" --user-export
   ```

   It adds only the missing export variables, never replaces a key the user already set, and prints exactly
   what it wrote and which existing values it left alone. Report that output verbatim. On a no, say that no
   `claude_code` metrics or events will arrive until export is on.
3. Report every directory the command printed, and tell the user settings environment changes apply only to
   **new Claude Code sessions**. Restart every already-running session in those directories before creating
   activity or running verification. `/reload-plugins` alone does not apply the new environment. Hook-based
   linked-worktree attribution can still resolve to the main repository, but native metrics require the exact
   session-start directory to be wired.
4. After that new session creates activity, verify honestly:

   ```sh
   node "${CLAUDE_PLUGIN_ROOT}/bin/verify-project-telemetry.js" --project "<absolute-current-project-dir>"
   ```

   `found` reports that Prometheus returned a `claude_code_token_usage_tokens_total` metric tagged with this project; it does not report observer health. Read the separate `observer=healthy` or `observer=unavailable` field too, because output can be `found` with `observer=unavailable`. `not-found` means the command did not see the metric yet, or no dashboard is configured. Report both fields as returned, and never infer observer health from `found` alone. If the dashboard is unavailable, keep the observer and SQLite ingestion running; diagnose and report the observer, collector, downstream sink, and dashboard as separate planes.
5. When `not-found` persists after a restart and real activity, add `--audit` to the same command. It reads the
   installed Claude Code version, where the export variables actually live, and how many `claude_code` rows the
   local store received for this project in the window. Each session directory is `wired`, `NO-EXPORT`
   (`project.id` present but export off for this Claude Code version) or `UNWIRED`, and `verdict=` is `wired`,
   `export-disabled`, `unwired`, `no-data` (wired, no rows yet) or `unconfirmed` (no local store). It prints the
   fix for each gap: `--project` for unwired directories, `--user-export` for export, which still needs the
   user's yes as in step 2. It also names opted-in projects sending observer events with no `claude_code_*`
   samples.

## Storage pressure

The observer reserves 128 MiB below its 4 GiB database limit. It prunes expired observations first, then oldest whole days inside the 30-day window only when pressure remains, and records the exact windows and row counts in `/health`. A health failure of `storage_headroom_unrecoverable` means no removable data restored that reserve. Explain that committed ingestion still receives its normal acknowledgement, then diagnose disk and retention pressure from the health response. Do not tell the user to run `VACUUM`: the managed path compacts reusable pages when it can, and the manual prune command checks free space before a full vacuum.

## Exhausted outbox recovery

When `/health` or the outbox view reports exhausted rows, show the user the pre-action `pending_count` and `exhausted_count` plus the current health result. Ask for approval before sending `POST /v1/outbox/requeue` to the local observer. The endpoint resets **all** exhausted rows in the shared local outbox, so do not offer or imply a project-scoped requeue. After the approved request, read the counts and health again, report the post-action values, and let the normal drainer retry delivery. A requeue does not prove delivery succeeded.

## Recover a generated dashboard

If the generated dashboard is stale, reset it with the setup command's `--reset-dashboards` action. The
reset removes generated definitions and records a reset boundary; it does not disable telemetry or delete
local history. Create fresh activity, then run setup or let SessionStart reprovision the dashboards. Fully
reload the Grafana browser tab after reprovisioning. Grafana's Refresh reruns queries already loaded in the
page, so it does not replace stale dashboard definitions. Verify the project after the new activity arrives,
and report `found` or `not-found` as returned.

## Disable


```sh
node "${CLAUDE_PLUGIN_ROOT}/bin/project-telemetry.js" --project "<absolute-current-project-dir>" --disable
```

It unwires the same set enable wired, from wherever in the repository it is run, using each directory's own
state file. It restores only env values this flow replaced, preserves later user edits and unrelated settings,
and removes the repository from the machine-local opted-in registry. It leaves the shared observer, Collector,
and historical local data alone because another opted-in project may still use them. It also leaves the
user-level export variables alone for the same reason; if no project stays opted in and the user wants export
off, those keys come out of their user settings `env`. Restart Claude Code in each listed directory for the
removed env block to take effect.

## Manual scratch-project check

Use this only when validating the flow itself. Set a temporary home and project directory, invoke the enable
command from that directory, inspect `.claude/settings.local.json` for the telemetry block, then run the verify
command before any new session activity. Its expected honest result is `not-found` until a restarted Claude Code
session emits telemetry. A scratch directory with no `.git` above it is its own project, which is what makes it
a scratch project rather than part of the surrounding repository.
