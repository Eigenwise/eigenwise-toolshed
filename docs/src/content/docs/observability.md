---
title: Observability
description: See local Claude Code usage for the repositories you choose.
---

Observability shows local Claude Code usage without sending project content to a hosted service. It records metadata such as token totals, tool activity, models, sessions, and costs. It is off until you opt a repository in.

The data stays on your machine in local storage by default. If you configure a remote sink, it receives only the allowed redacted metadata. You can use the local report only, add the loopback dashboard, or choose a remote sink yourself. Prompt and response text, code and file contents, tool inputs and results, credentials, and environment values are not recorded.

## Start here

1. Install the [Observability plugin](./observability/setup/).
2. From the repository you want to watch, run `/observability:enable-project-telemetry`.
3. Approve local metadata-only telemetry and choose whether to use the local dashboard.
4. Restart Claude Code sessions that were already open in that repository.
5. Open the [dashboard](./observability/dashboard/) after the new session creates activity.

The skill handles the observer, dashboard setup, project wiring, and verification. You only choose whether to enable telemetry, which local or remote sink to use, and any external sign-in or endpoint required by that sink.

## Daily use

Open the configured loopback dashboard, usually `http://127.0.0.1:3000`, to compare usage across opted-in repositories or focus on one project. Use it to spot model and token use, tool activity, MCP activity, Sidequest costs, and failures. See the [dashboard guide](./observability/dashboard/) for the main views.

To check setup or disable telemetry, run the same skill and describe what you want. Claude reports whether a project is sending data and tells you when a restart or more activity is needed.

## If the dashboard is empty

Tell Claude:

> My Observability dashboard is empty. Check the project setup and tell me what to fix.

Existing sessions need a restart after opt-in. A project also needs fresh Claude Code activity before its panels appear. If the local service is unavailable, ask Claude to diagnose Observability; it can check the managed local processes and configuration without making you run their internal commands.

See the generated [Observability reference](/reference/observability/) for the agent-facing setup and command contract.
