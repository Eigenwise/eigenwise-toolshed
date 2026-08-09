---
title: Sidequest
description: Plan, track, and deliver Claude Code work from a local board.
---

Sidequest gives Claude Code a local board for planned work. It groups tickets into stories, keeps the backlog visible, and runs delegated work through a repeatable review and delivery flow.

## Install

Install Sidequest for the project you are working in:

```text
/plugin marketplace add Eigenwise/eigenwise-toolshed
/plugin install sidequest@eigenwise-toolshed --scope project
```

Reload Claude Code or start a new session after installing. You can also run `/workbench:init-workspace` and let Workbench install and configure Sidequest for the project.

Sidequest is local. The dashboard runs on your machine and ticket data stays in the local Sidequest store.

## Your first workflow

1. Open the board with `/sidequest:board`, or tell Claude to show your Sidequest board.
2. Describe the outcome you want and ask Claude to plan it as Sidequest work. For example: `Plan the checkout refresh as a Sidequest story and show me the backlog.`
3. Review the proposed tickets, dependencies, and scope in the board. Adjust the plan before work starts.
4. Ask Claude to dispatch the ready tickets. Claude chooses the configured route, starts the work, and reports verification results.
5. When a ticket is ready, ask Claude to review and integrate it if the checks pass. Larger or higher-risk work may need an extra review before integration.

The board keeps the work visible while Claude and its executors handle the ticket lifecycle.

## Use the dashboard

The dashboard shows every project you have registered in Sidequest. Use it to switch boards, scan todo, doing, and done work, search tickets, filter the view, and open a ticket's full details.

![Sidequest dashboard showing a synthetic board with todo, doing, and done columns](../../../assets/screenshots/sidequest-kanban.png)

*Synthetic Acme Webshop demo data showing the board view and ticket status columns.*

Open a ticket to read its details, comments, links, reminders, story, and current ownership. You can edit tickets and leave a note from the detail view.

![Sidequest ticket detail view showing synthetic details, status, story, links, reminder, and comment controls](../../../assets/screenshots/sidequest-ticket-detail.png)

*Synthetic demo ticket detail view. The names, titles, timestamps, and comments are fixtures created for documentation.*

## Daily use

Ask Claude to do the board work in plain language:

- `Show me the Sidequest backlog for this project.`
- `What is ready to dispatch for the checkout story?`
- `Add a ticket for the empty-state bug and include the reproduction steps.`
- `What is blocking SQ-7?`
- `Review and integrate SQ-7 if its verification passed.`

For substantial changes, Claude can turn the request into a story with linked tickets so you can see the whole plan before execution. Side issues that come up during a session can become separate tickets instead of disappearing into the current task.

## If something stops working

**The board does not open.** Reload Claude Code after installing Sidequest, then ask Claude to open the board again. If the browser still does not open, ask Claude to start the Sidequest dashboard and report its local URL.

**Claude cannot use Sidequest after an install or upgrade.** Start a new Claude Code session or reload plugins. An already-open session may still have the previous plugin connection.

**A ticket will not dispatch.** Ask Claude to diagnose the ticket. Common causes are an incomplete work description, a blocked dependency, or an unavailable configured route. Claude reports the specific recovery instead of silently changing the work's route.

**Work looks stuck in doing.** Ask Claude to inspect the ticket's current status and executor activity. A running ticket can stay in doing until its verification and delivery steps finish.

**A submitted ticket is not integrated.** Ask Claude to inspect the submission and complete the review and integration step. Do not start the same ticket again while a submitted result is waiting.

See the [generated Sidequest reference](../reference/sidequest/) for the agent-facing tool and configuration details, or the [Sidequest plugin README](https://github.com/Eigenwise/eigenwise-toolshed/tree/main/plugins/sidequest) for the project landing page.
