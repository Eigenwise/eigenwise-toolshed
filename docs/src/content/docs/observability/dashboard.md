---
title: Observability dashboard
description: Read the local usage views after a repository starts reporting.
---

After setup, open the configured loopback dashboard. The default URL is `http://127.0.0.1:3000`. The global **Claude Code Usage** view compares all opted-in repositories. A project view filters the same signals to one repository.

A project appears after Claude Code metrics arrive for it. Restart sessions after opt-in, create activity, and allow the first records to arrive before treating an empty project view as a failure.

## Start with the main views

Use the dashboard to answer three practical questions:

- Which models and projects account for token use and estimated cost?
- Which tools and MCP servers are active?
- Which Sidequest stories are consuming the most work?

The global view is organized into four rows: **At a glance**, **Where the spend goes**, **Failures and source activity**, and **Context recharge**. It includes total spend, work routed to Codex, tool failure rate, hook and gateway failures, source activity, and context recharge. Choose a smaller time bucket for investigation, then use the legend or data inspection view for exact series values.

The screenshots below use fixed synthetic records from the documentation capture pipeline. They show the shape of the views without exposing a real project, session, or cost record.

![Synthetic Tokens & models dashboard view showing model totals and roles](../../../assets/screenshots/observability-tokens-models.png)

The **At a glance** row gives a quick read on model usage, roles, spend, and failures.

![Synthetic Who is burning tokens dashboard view showing model token totals and synthetic costs](../../../assets/screenshots/observability-who-is-burning.png)

The **Where the spend goes** row breaks down model totals and estimated cost before you change routing or prompts.

![Synthetic MCP dashboard view showing definition tokens and call activity by server](../../../assets/screenshots/observability-mcp.png)

The **Failures and source activity** row shows hook and gateway failures alongside source activity.

![Synthetic Sidequest board costs dashboard view showing story ticket counts and synthetic costs](../../../assets/screenshots/observability-board-costs.png)

The **Context recharge** row shows context-related activity alongside the rest of the global usage signals.

## If a view is missing

- **The dashboard does not open:** tell Claude the local Observability dashboard is unavailable and ask it to diagnose the setup.
- **A project is missing:** restart sessions in that repository, create activity, then ask Claude to verify project telemetry.
- **The project says `not-found`:** run the same skill with an audit request. Claude checks which session directories are wired and tells you what needs a restart or repair.
- **The dashboard has no recent data:** check the selected time range and whether the source cards have received records in the last few minutes.

Resetting a generated dashboard does not disable telemetry or delete local history. Ask Claude to repair or reset it when the dashboard definition is stale.

See the generated [Observability reference](/reference/observability/) for the dashboard and verification details.
