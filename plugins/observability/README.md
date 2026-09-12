# Observability

Local, metadata-only usage telemetry for Claude Code. Choose the repositories you want to track, keep reports on your machine, and optionally use a loopback dashboard or a remote sink.

[Observability guide](https://eigenwise.github.io/eigenwise-toolshed/observability/) · [Generated reference](https://eigenwise.github.io/eigenwise-toolshed/reference/observability/) · [Toolshed marketplace](../../README.md)

The intended policy is per-repository opt-in. A separate machine-level setup consent starts the shared local observer and Collector, and can add a dashboard or remote sink. The project command then opts the current repository into that shared service. Telemetry records are designed to contain metadata such as session IDs, prompt IDs, agent IDs, task IDs, tool-use IDs, and SendMessage recipient IDs, with no prompt or response text, code or file contents, tool inputs or results, credentials, or environment values. Sink configuration you provide stays in the private observability config file so the exporter can authenticate.

Repository opt-in is enforced on the local capture path and on the single export path. Hook capture is gated before the spool write, ingest is gated before persistence, and the observer's outbox is the only route by which a log record reaches a configured sink. Disabling a repository stops future capture and withholds still-queued rows from export while local history is preserved. Traces and metrics still reach a configured sink through the Collector without this gate.

## Install

Run these in Claude Code:

```text
/plugin marketplace add Eigenwise/eigenwise-toolshed
/plugin install observability@eigenwise-toolshed --scope project
```

Any scope works (user, project, or local). Pick user scope to cover every project at once, or project/local scope to keep the plugin out of repositories that did not opt in.

Reload plugins or start a new Claude Code session. Then, from the repository you want to track, run:

```text
/observability:enable-project-telemetry
```

Claude first gets consent for the machine-shared observer and Collector, then handles this repository's opt-in and the optional dashboard. A bare setup keeps data in local SQLite with no dashboard. The `--dashboard` choice explicitly requests the Docker-backed loopback dashboard. You choose whether to keep the data local or configure a remote sink. Any external endpoint or sign-in stays your call.

Settings and environment wiring apply only to new Claude Code sessions. The project command writes the repository SHA-256 identity as `OTEL_RESOURCE_ATTRIBUTES` `project.id` and its sanitized basename as `project.name`, matching the local opt-in registry. Re-run the command to rewrite this repository's env after an update; it never changes another repository's settings. Restart every affected session in the listed repository directories before creating activity or running verification. `/reload-plugins` alone is not enough for environment changes.

## Use the dashboard

Open the configured loopback dashboard, usually `http://127.0.0.1:3000`, to compare opted-in projects and inspect one project at a time. It shows token and model use, API list-price-equivalent costs, tool and MCP activity, Sidequest costs, failures, and context recharge. Those cost panels are estimates, not subscription charges. Models without a published API price stay visible in **Unpriced model token usage** with token volumes instead of a made-up dollar total.

There are no routine observer commands to remember. Claude keeps the managed local services running and handles setup, verification, repair, and disable flows through the bundled skill.

## Storage pressure

The observer keeps a 128 MiB writable reserve below its 4 GiB database limit. Its normal retention window is 30 days. When pressure remains after expired data is removed, it prunes the oldest whole days inside that window, so data can disappear earlier than 30 days under pressure. Health records the removed windows and row counts. That retention pruning is separate from deleting all local observability data.

Freed SQLite pages stay reusable for ingestion. Do not recommend a managed full `VACUUM`; the observer's normal path uses incremental compaction, and the standalone prune command checks free space before any blocking file-space reclaim.

## If something stops working

Tell Claude what happened:

> My Observability dashboard is empty. Diagnose the project setup.

> Disable Observability for this repository, but keep its local history.

Claude checks project wiring, recent activity, and the local services. Existing Claude Code sessions need a restart after opt-in or settings changes, and that restart must happen before new activity or verification. A dashboard outage does not stop local observer ingestion. The outbox retries a failed delivery up to eight times. If rows become exhausted, ask Claude to show the pre-requeue outbox count and health, get approval for the explicit requeue action, then report the post-requeue count and health. `POST /v1/outbox/requeue` resets every exhausted row in the shared local outbox, not just rows from one project, so never describe it as project-scoped recovery.

If generated dashboards were reprovisioned or reset, create fresh activity, let setup or SessionStart provision the current dashboards, fully reload the Grafana browser tab, and then verify. Grafana Refresh reruns queries already loaded in the page and does not replace stale dashboard definitions.

## Support

If Observability saves you time, you can support its maintenance through [Ko-fi](https://ko-fi.com/eigenwise) or [GitHub Sponsors](https://github.com/sponsors/Eigenwise).

## License

MIT
