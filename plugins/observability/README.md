# Observability

Local, metadata-only usage telemetry for Claude Code. Choose the repositories you want to track, keep reports on your machine, and optionally use a loopback dashboard or a remote sink.

[Observability guide](https://eigenwise.github.io/eigenwise-toolshed/observability/) · [Generated reference](https://eigenwise.github.io/eigenwise-toolshed/reference/observability/) · [Toolshed marketplace](../../README.md)

Prompt and response text, code and file contents, tool inputs and results, credentials, and environment values are not recorded. Telemetry stays off until you approve a repository.

## Install

Run these in Claude Code:

```text
/plugin marketplace add Eigenwise/eigenwise-toolshed
/plugin install observability@eigenwise-toolshed --scope user
```

Reload plugins or start a new Claude Code session. Then, from the repository you want to track, run:

```text
/observability:enable-project-telemetry
```

Claude asks for consent, handles the local observer and optional dashboard, and verifies that the project is reporting. You choose whether to keep the data local or configure a remote sink. Any external endpoint or sign-in stays your call.

## Use the dashboard

Open the configured loopback dashboard, usually `http://127.0.0.1:3000`, to compare opted-in projects and inspect one project at a time. It shows token and model use, tool and MCP activity, Sidequest costs, failures, and context recharge.

There are no routine observer commands to remember. Claude keeps the managed local services running and handles setup, verification, repair, and disable flows through the bundled skill.

## If something stops working

Tell Claude what happened:

> My Observability dashboard is empty. Diagnose the project setup.

> Disable Observability for this repository, but keep its local history.

Claude checks project wiring, recent activity, and the local services. Existing Claude Code sessions need a restart after opt-in or settings changes.

## License

MIT
