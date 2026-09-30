---
title: Per-project opt-in
description: Enable, verify, or disable local usage telemetry for one repository.
---

Observability is opt-in per repository. From anywhere inside the repository, run:

```text
/observability:enable-project-telemetry
```

Approve the setup when Claude asks. It handles the machine-shared local services you selected, then wires this repository for the intended metadata-only Claude Code usage and checks for incoming metrics. A bare setup keeps SQLite only; `--dashboard` explicitly requests the Docker dashboard. Repository opt-in is enforced before capture: a hook event for a repository that has not opted in is gated at the spool write and never persisted.

## What one opt-in covers

An opt-in wires the repository root and its eligible descendant directories. Native Claude Code metrics require telemetry settings in the exact directory where the session starts. Hook events from a linked worktree can still resolve to the enclosing main repository identity, but the repository opt-in does not promise native metrics for that linked-worktree session. Runtime coverage for that case is separate.

Settings changes apply to new Claude Code sessions. Restart existing sessions in every listed directory before creating activity or expecting their native metrics to appear. `/reload-plugins` alone does not apply the new environment. The restart reloads project wiring; an older session leaves a newer live observer untouched.

## Which settings Claude Code reads, by version

Since Claude Code 2.1.282, project settings (`.claude/settings.json`) and local settings (`.claude/settings.local.json`) can't turn telemetry export on. Claude Code ignores these variables there:

- `CLAUDE_CODE_ENABLE_TELEMETRY`, `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA`, `ENABLE_ENHANCED_TELEMETRY_BETA`
- `OTEL_METRICS_EXPORTER`, `OTEL_LOGS_EXPORTER`, `OTEL_TRACES_EXPORTER`
- every `OTEL_EXPORTER_OTLP_*` endpoint, header, protocol and certificate variable, and `OTEL_EXPORTER_PROMETHEUS_*`
- the content switches `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_ASSISTANT_RESPONSES`, `OTEL_LOG_TOOL_CONTENT`, `OTEL_LOG_TOOL_DETAILS`, `OTEL_LOG_MANAGED_SETTINGS`

Those only count from user settings (`~/.claude/settings.json`, or `$CLAUDE_CONFIG_DIR/settings.json`), managed settings, a `--settings` file, or the environment Claude Code starts in. `OTEL_RESOURCE_ATTRIBUTES` is not on that list, so each session directory's `project.id` still attributes its sessions once export is on.

We checked this against Claude Code 2.1.285 with a local OTLP receiver. With all the variables in `.claude/settings.local.json` and nothing else, the session sent nothing. With export turned on from the launch environment and only `OTEL_RESOURCE_ATTRIBUTES=project.id=...` in the project's local settings, every log record and metric carried that `project.id`.

So what the opt-in needs depends on the version:

| Claude Code | Where export is turned on | Where `project.id` comes from |
| --- | --- | --- |
| before 2.1.282 | the wired project directories | the wired project directories |
| 2.1.282 and later | user settings or the launch environment, once per machine | the wired project directories |

On 2.1.282 and later the skill wires the project directories as before, then asks before turning export on in your user settings. That step makes every Claude Code session on the machine export to the local Collector. The observer keeps only opted-in repositories, but traces and metrics from other repositories reach a configured sink or dashboard, since that path has no opt-in gate. It adds only missing variables and never replaces a value you already set. At session start, Observability warns when an opted-in machine runs 2.1.282 or later with export still off; it never writes the setting itself.

Stored rows carry no session id because the wiring sets `OTEL_METRICS_INCLUDE_SESSION_ID=false`, which in current Claude Code also drops `session.id` from events. That keeps one Prometheus series per project instead of one per session.

## Verify the first workflow

After restarting a session, create some activity, then run the same skill again and ask Claude to verify the project. The result is:

- `found` when the local setup has seen a Claude Code usage sample for the project.
- `not-found` when no sample has arrived yet or no dashboard is configured.

If it is still `not-found`, restart the listed session directories and create another small piece of activity. Then ask Claude to audit the project wiring. The audit checks the installed Claude Code version, where the export variables actually live, and whether the local store received `claude_code` data for the project recently. It marks each session directory `wired`, `NO-EXPORT` (the project id is there but export is off for this Claude Code version) or `UNWIRED`, and gives a verdict: `wired`, `export-disabled`, `unwired`, `no-data`, or `unconfirmed` when there's no local store to check.

## Disable one repository

Run the same skill and ask Claude to disable telemetry for the current repository. It unwires the settings environment, removes the repository from the opted-in registry, and stops native Claude Code metrics for new sessions, while leaving other opted-in repositories alone. Disabling stops future hook capture and future export of any rows still queued for that repository, while local history is retained; Collector traces and metrics are not covered by this gate. Deleting history is a separate global cleanup of the shared local store, not a per-repository disable action. Disable leaves the user-level export variables in place because other opted-in repositories may still need them.

The [dashboard guide](../dashboard/) explains how to read project and global views after verification.
