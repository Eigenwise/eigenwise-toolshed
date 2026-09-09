---
title: Sidequest
description: Plan, track, and deliver Claude Code work from a local board.
---

Sidequest gives Claude Code a local board for planned work. It groups tickets into stories, keeps the backlog visible, and runs delegated work through a repeatable review and delivery flow. That flow works for Git codebases and filesystem snapshots of non-Git documentation trees, vaults, and research collections.

## Install

Install Sidequest for the project you are working in:

```text
/plugin marketplace add Eigenwise/eigenwise-toolshed
/plugin install sidequest@eigenwise-toolshed --scope project
```

Reload Claude Code or start a new session after installing. Sidequest packages its executor roster with the plugin, so Claude discovers every routed executor when it loads the plugin, before SessionStart maintenance. You can also run `/quartermaster:setup` and let Quartermaster install and configure Sidequest for the project.

Sidequest is local. The dashboard runs on your machine and ticket data stays in the local Sidequest store.

## Your first workflow

1. Open the board with `/sidequest:board`, or tell Claude to show your Sidequest board.
2. Describe the outcome you want and ask Claude to plan it as Sidequest work. For example: `Plan the checkout refresh as a Sidequest story and show me the backlog.` If work belongs on a feature branch, name that branch in the request.
3. Review the proposed tickets, dependencies, and scope in the board. Adjust the plan before work starts.
4. Ask Claude to dispatch the ready tickets. Claude chooses the configured route, starts the work, and reports verification results. Dispatch freezes each ticket's intended target branch, so two concurrent feature branches get separate targets without changing the board default.
5. When a ticket is ready, ask Claude to review and integrate it if the checks pass. Larger or higher-risk work may need an extra review before integration.

Each ticket carries a check that decides whether its work is ready. Claude records that check against the final candidate and reports what passed, failed, or needs your decision. The agent-facing reference covers capture, evidence, and delivery mechanics.

### Choose the planning depth

Use the lightest planning that fits. Exact small changes and operational asks can stay lightweight. Substantial or ambiguous work starts with a visible surgical contract: the outcome, non-goals, smallest authority needed, scope, bounded oracle (the check that decides whether it worked), and review limit.

Claude asks one batched question round for consequential choices. If the approach is genuinely contested, it may offer bounded agent proposals. `Do your thing`, `use your judgment`, and similar phrases delegate decisions for the current feature or story, not for future work.

Review stays tied to the pinned contract. If two candidate fixes are rejected in the same defect chain, stop patching and replan before trying another candidate.

The board keeps the work visible while Claude and its executors handle the ticket lifecycle. A Git ticket submits a verified range; a non-Git ticket submits a verified project snapshot. Claude reports any unavailable capability or failed delivery instead of guessing around it.

## Use the dashboard

The project rail keeps every registered board in one place, with ticket counts and status progress beside each project. The combined view is useful when you want to scan ownership, priorities, labels, stories, and routes across the whole queue.

![Sidequest dashboard with three synthetic projects and populated todo, doing, and done columns](../../../assets/screenshots/sidequest-kanban.png)

*Synthetic demo data showing three active project boards and 25 tickets.*

Select a project in the rail when you need its focused board. The columns keep that project's open and completed work visible without losing the rest of the rail.

![Acme Fulfillment synthetic board selected in the Sidequest project rail](../../../assets/screenshots/sidequest-second-project.png)

*Synthetic demo data showing nine active Fulfillment tickets across todo, doing, and done.*

The toolbar searches refs, titles, and labels, then combines that query with priority, story, assignee, and sort controls. Active filters stay visible, so you can tell why a card is in the result.

![Sidequest board with mobile typed into search and the normal priority filter active](../../../assets/screenshots/sidequest-filtered-board.png)

*Synthetic demo data showing six mobile tickets narrowed to normal priority.*

The inbox collects comments, reminders, ticket creation, and status activity across projects. Its tabs separate work that needs you from the wider activity stream.

![Sidequest notification inbox open over a populated synthetic board](../../../assets/screenshots/sidequest-notifications.png)

*Synthetic demo data showing several unread comment notifications from different tickets.*

Open a ticket to edit its fields and read the working context in one place. The detail view keeps a scheduled reminder, dependency links, and the full comment thread beside the ticket fields.

![Sidequest ticket detail with a populated reminder, dependency link, story, and comment thread](../../../assets/screenshots/sidequest-ticket-detail.png)

*Synthetic demo data showing the Build cart summary ticket and its team discussion.*

Stories group tickets into a plan you can filter and discuss before dispatch. The toolbar story filter keeps the story list visible while you scan the combined board.

![Sidequest story filter showing synthetic stories across the combined board](../../../assets/screenshots/sidequest-stories.png)

*Synthetic demo data showing the Checkout confidence, Storefront discovery, and fulfillment story groups.*

Links show which tickets block or relate to each other. Use the dependency list to inspect the existing chain, then choose a link type and target when you add another relationship.

![Sidequest ticket links editor showing two populated dependency relationships and the add-link controls](../../../assets/screenshots/sidequest-ticket-links.png)

*Synthetic demo data showing the existing and newly added dependencies for the Build cart summary ticket.*

The lower ticket context keeps declared files, attachment previews, and the full discussion visible without putting the link picker over the comments.

![Sidequest ticket context showing affected files, three checkout attachment previews, and four complete comments](../../../assets/screenshots/sidequest-ticket-context.png)

*Synthetic demo data showing the declared checkout files, visual references, and team decisions attached to the same ticket.*

Completed work can move into the archive without disappearing. The archive view keeps the source board, priority, age, and restore action with each ticket.

![Sidequest archive containing nine synthetic tickets from three projects](../../../assets/screenshots/sidequest-archive.png)

*Synthetic demo data showing archived storefront, fulfillment, and support work.*

Settings covers routing profiles, model fallback, theme, notification preferences, and the guided tour. Open it when you need to change how the board behaves rather than the work on a ticket.

![Sidequest settings dialog showing routing, appearance, tour, and notification controls](../../../assets/screenshots/sidequest-settings.png)

*Synthetic demo data behind the Sidequest settings dialog.*

## Daily use

Ask Claude to do the board work in plain language:

- `Show me the Sidequest backlog for this project.`
- `What is ready to dispatch for the checkout story?`
- `Add a ticket for the empty-state bug and include the reproduction steps.`
- `What is blocking the checkout ticket?`
- `Review and integrate the checkout ticket if its verification passed.`

For substantial changes, Claude can turn the request into a story with linked tickets so you can see the whole plan before execution. Side issues that come up during a session can become separate tickets instead of disappearing into the current task.

Sidequest keeps ticket activity visible in the board. Ask Claude to check active work after a restart or when you need help with a ticket that was started in another session.

## If something stops working

**The board does not open.** Reload Claude Code after installing Sidequest, then ask Claude to open the board again. If the browser still does not open, ask Claude to start the Sidequest dashboard and report its local URL.

**Claude reports an older loaded Sidequest after an upgrade.** Reload plugins or start a new session to pick up the current connection and packaged executor roster. Unknown versions, schema changes, and incompatible older loaded versions refuse dispatch until reload.

**Claude says an executor is missing.** Update Sidequest, reload plugins in the affected session, and ask Claude to dispatch again. Do not create replacement agents or disable the dispatch guard.

**Claude's Agent tool rejects `name` or `mode`.** Ask Claude to inspect the Agent schema it can see, then use Sidequest's reduced-schema dispatch only when those two fields are absent. Sidequest keeps the board label separately and refuses the first claim unless the host hook reports both the real agent identity and `bypassPermissions`; reload into a host that reports those facts instead of adding unsupported fields or changing permissions.

**A ticket will not dispatch.** Ask Claude to diagnose the ticket. Common causes are an incomplete work description, a blocked dependency, or an unavailable configured route. Claude reports the specific recovery instead of silently changing the work's route.

**A read-only ticket cannot start in a new repository.** Claude reports the checkout choice and keeps the ticket read-only. You do not need to commit notes or change board settings.

**A worktree-isolated executor cannot write.** Ask Claude to redispatch if the recorded checkout is missing or does not match the assigned checkout.

**Work looks stuck in doing.** Ask Claude to inspect the ticket's current status and executor activity. Sidequest keeps the intended integration branch that was frozen at dispatch, even if you later change branches or the board default. For two feature branches, name the intended target on each ticket instead of changing that board-wide default between dispatches.

**A ticketed helper is refused while writing verification evidence.** Only the ticket's active owner and helpers admitted through that owner's recorded identity can write the ticket's exact board-owned evidence directory. Helpers cannot use another ticket's folder or a lookalike path. Ask Claude to inspect the ticket binding, not to request repository scope.

**Stale agent worktrees keep accumulating.** Ask Claude to inspect local worktree storage and clean up entries it can safely remove. The generated reference has the lifecycle and recovery details.

**A ticket contract forbids commits.** Ask Claude to declare working-tree delivery before dispatch. After verification, the declared edits stay uncommitted and unpushed in the shared checkout for your normal team handoff. Ticket closure records that handoff; it does not replace your project's commit, review, or push process.

**A POSIX verify command fails on Windows.** Ask Claude to inspect the recorded verification result and the shell it used.

**A submitted ticket is not integrated.** Ask Claude to inspect the submission and complete the review and integration step. Do not start the same ticket again while a submitted result is waiting.

**A wave left out submitted work.** Ask Claude to inspect the assembled wave and its declared participant set.

**A submission sat so long it can no longer be integrated.** Ask Claude to check whether the requested behavior already reached the intended branch. If it did, Claude records that evidence; if it did not, the work needs a fresh ticket against current source.

## Support

Optional, if Sidequest saves you time: [Ko-fi](https://ko-fi.com/eigenwise) or [GitHub Sponsors](https://github.com/sponsors/Eigenwise).

See the [generated Sidequest reference](../../reference/sidequest/) for agent-facing tool and configuration details, or the [Sidequest plugin README](https://github.com/Eigenwise/eigenwise-toolshed/tree/main/plugins/sidequest) for the project landing page.
