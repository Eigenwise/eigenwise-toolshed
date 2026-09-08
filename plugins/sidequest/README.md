# Sidequest

Sidequest is a local board for planning, tracking, and delivering Claude Code work. It keeps a visible backlog across your projects, groups related tickets into stories, and gives Claude a consistent way to delegate, verify, review, and hand work back.

[Setup guide](https://eigenwise.github.io/eigenwise-toolshed/getting-started/sidequest/) · [Generated reference](https://eigenwise.github.io/eigenwise-toolshed/reference/sidequest/) · [Toolshed marketplace](../../README.md)

## Install

Install Sidequest at project scope:

```text
/plugin marketplace add Eigenwise/eigenwise-toolshed
/plugin install sidequest@eigenwise-toolshed --scope project
```

Reload Claude Code or start a new session. You can also run `/quartermaster:setup` and let Quartermaster install and configure Sidequest for a project.

Open the board with `/sidequest:board`, or tell Claude to show it. The dashboard is local and ticket data stays on your machine.

## Start with Claude

Tell Claude the outcome you want:

> Plan the checkout refresh as a Sidequest story and show me the backlog.

Claude can create the story, split it into tickets, connect dependencies, and classify the work from the board's configured categories. Review the backlog, then ask Claude to dispatch the ready tickets. Claude handles routing, executor startup, verification, and ticket updates.

When work is ready, ask Claude to review and integrate it:

> Review and integrate the submitted checkout tickets if their checks pass.

A codebase ticket hands back a verified revision. Non-Git work hands back a verified project snapshot. Larger or higher-risk changes can get an independent review when the verification evidence needs one.

## Use the board every day

Use the dashboard to switch projects, scan todo, doing, and done work, search and filter tickets, and open full ticket details. You can edit tickets, add comments, connect related work, and set reminders from the board.

Sidequest also works through natural-language requests:

- `Show me the Sidequest backlog for this project.`
- `What is ready to dispatch for the checkout story?`
- `Add a ticket for the empty-state bug with the reproduction steps.`
- `What is blocking the checkout ticket?`
- `Review and integrate the checkout ticket if verification passed.`

## If something stops working

Tell Claude the symptom:

> The Sidequest board will not open. Diagnose it.

> The checkout ticket will not dispatch. Explain what is blocking it.

> A submitted ticket is waiting. Check it and finish the integration if it is safe.

Claude checks the local plugin connection, ticket state, dependencies, configured route, and delivery status, then gives you the next action. After an install or upgrade, start a new Claude Code session or reload plugins so the session picks up the current Sidequest connection and its bundled executors.

For worktree storage, recovery, and command details, see the [generated reference](https://eigenwise.github.io/eigenwise-toolshed/reference/sidequest/). Ask Claude to inspect or clean up local worktrees rather than guessing at lifecycle commands.

## Support

Optional, if Sidequest saves you time: [Ko-fi](https://ko-fi.com/eigenwise) or [GitHub Sponsors](https://github.com/sponsors/Eigenwise).

## License

MIT (c) Eigenwise
