# Sidequest

Sidequest is a local board for planning, tracking, and delivering Claude Code work. It keeps a visible backlog across your projects, groups related tickets into stories, and routes delegated work through a consistent review and delivery flow. The same lifecycle covers Git codebases and immutable revisions from wikis, documentation vaults, document sets, and research collections.

[Setup guide](https://eigenwise.github.io/eigenwise-toolshed/getting-started/sidequest/) · [Generated reference](https://eigenwise.github.io/eigenwise-toolshed/reference/sidequest/) · [Toolshed marketplace](../../README.md)

## Install

Install Sidequest at project scope:

```text
/plugin marketplace add Eigenwise/eigenwise-toolshed
/plugin install sidequest@eigenwise-toolshed --scope project
```

Reload Claude Code or start a new session. You can also run `/quartermaster:setup` and let Quartermaster install and configure Sidequest for a project.

Open the board with `/sidequest:board`, or tell Claude to show it. The dashboard is local and ticket data stays on your machine.

## Plan work

Tell Claude what you want to change and ask it to plan the work on Sidequest:

> Plan the checkout refresh as a Sidequest story and show me the backlog.

Claude can create the story, split it into tickets, connect dependencies, and choose the configured work categories. You decide whether the plan is ready to run.

## Run and deliver tickets

Once the backlog looks right, ask Claude to dispatch the ready work. Claude handles routing, executor startup, verification, and the ticket updates. Independent tickets can run in parallel when their dependencies allow it.

A codebase submission pins a verified Git range. A project without Git pins its native immutable revision and changed surfaces, then records review or attestation evidence. Missing Git, process, and worktree capabilities are explicit, so delivery does not probe or invoke those adapters.

When work is ready, ask Claude to review and integrate it:

> Review and integrate the submitted checkout tickets if their checks pass.

Larger or higher-risk changes may need an additional review before integration. Claude reports what passed, what needs attention, and what is waiting for your decision.

## Use the board every day

Use the dashboard to switch projects, scan todo, doing, and done work, search and filter tickets, and open full ticket details. You can edit tickets, add comments, connect related work, and set reminders from the board.

Sidequest also works through natural-language requests:

- `Show me the Sidequest backlog for this project.`
- `What is ready to dispatch for the checkout story?`
- `Add a ticket for the empty-state bug with the reproduction steps.`
- `What is blocking SQ-7?`
- `Review and integrate SQ-7 if verification passed.`

## If something stops working

Tell Claude the symptom:

> The Sidequest board will not open. Diagnose it.

> SQ-7 will not dispatch. Explain what is blocking it.

> A submitted ticket is waiting. Check it and finish the integration if it is safe.

Claude checks the local plugin connection, ticket state, dependencies, configured route, and delivery status, then gives you the next action. After an install or upgrade, start a new Claude Code session or reload plugins so the session picks up the current Sidequest connection. A session loaded with Sidequest 4.48.1 or newer can finish compatible dispatches across a newer installed version, but it reports the skew and still requires a reload before schema-incompatible work.

## License

MIT (c) Eigenwise
