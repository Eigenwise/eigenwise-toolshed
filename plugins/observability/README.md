# observability

A local record of what each turn cost: one line per finished turn, per project, on your machine. Off until you switch it on. A usage page draws the charts, and Claude reads you the figures when you ask.

One line per finished turn goes to a file in your Claude config folder: the session's first prompt line (up to 60 characters), a ticket id, models, tokens, the engine's cost, timings, and tool and agent counts. Never your prompts, answers, code or tool inputs.

Nothing leaves your machine: no network calls, and the usage page is a local HTML file.

```bash
claude plugin marketplace add Eigenwise/eigenwise-toolshed
```

```bash
claude plugin install observability@eigenwise-toolshed
```

## Use it

```
/track on       start recording this project
/track off      stop (history stays)
/track status   say whether this project is recorded, and where the ledger is
/usage-page     build the usage page from every recorded project and open it
```

These are the names to type: a plugin's command is a bare name, with no `observability:` in front. They answer at once, with no model turn. Then ask Claude things like "what did this project cost this week" or "which kind of work costs the most". The `usage-report` skill runs a small script over the ledger and reads you the result. If nothing is recorded, it says "not recorded".

Switch it on in an interactive session; `claude -p` runs record once it is on.

The ledger lives on the machine the session runs on.

A session in a worktree records into the main checkout's ledger, with the main checkout's switch.

## The usage page

`/usage-page` reads the last 90 days of every recorded project and writes one self-contained page, `<claude config dir>/observability/board.html` (the file keeps the name the older version gave it, so a bookmark still opens it): cost, agent time, tokens and sessions with their trend, plan usage, cost per project and day, models, tools with their errors and denials, tickets, sessions and an activity calendar. Filter by project, period or session name. Cost is the engine's own figure. Nothing is estimated and there are no price tables.

The page is written in one write, only when you ask for it, so a run that ends early never leaves half a page. Typed at the terminal, the command also opens it. Asked from your phone over Remote Control or run by another plugin, it writes the page and answers `observability: usage page written to <file> on this computer; open it there.` A `claude -p` run cannot type a command, so it never writes the page.

## What a row holds

Every figure is what the engine reported. A field is left out when the engine did not give it.

- turn time, outcome, duration, session id, a short task name, and a ticket id when a prompt in that turn starts with one (`SQ-12`, `PL-12` or `Ticket PL-12:`, any board's prefix; a ref further in is a mention)
- session cost and this turn's cost
- tokens by model: input, output, cache read, cache write, request count, latency
- tool calls, errors and denials per tool
- agents started, by type
- context fill and rate-limit windows, when the engine exposes them
- whether the session compacted

The task name is the first line of the first prompt you typed in the session (at the terminal, from your phone or in a `claude -p` run), kept until `/clear`. A message from another session, a task notification, a scheduled prompt or a plugin's prompt never names it.

When Sidequest is installed and publishes `sidequest.runs`, each spawned agent also gets `{ agentId, agentType, resolvedModel, ticket, category, model, requestedModel }`, leaving out whatever Sidequest did not publish. Without Sidequest the row has no `spawns` field. Nothing here needs another plugin.

## Where it lives

`<claude config dir>/observability/ledger/<project>-<hash>.<session>.jsonl`, one file per session, so two sessions in one project never rewrite each other. Each turn reads and rewrites its own session's file whole, because the host has no append call. The config dir is `CLAUDE_CONFIG_DIR`, or `.claude` under the home folder (`USERPROFILE`, then `HOME`). With neither, nothing is recorded and the status line says so. The hash comes from the full project path, so two folders both called `app` get separate ledgers. A ledger past 3 MiB is rolled aside as `<name>.<millis>.jsonl`.

The switch is kept per project in the plugin's own store, under the project's path.

## Coming from version 1

2.0.0 updates version 1 in place. A project that was recording keeps recording, `/track` is the same, and every row version 1 wrote is still read: its one file per project (`<project>-<hash>.jsonl` and its rolled-aside files), also when it sits under `HOME` where that differs from `USERPROFILE`, since version 1 looked at `HOME` first. A `quality` field on an older row is ignored.

Two things changed. The page's command is `/usage-page`, where version 1 called it `/board`: in this version `/board` is the work board's command, and a command name belongs to one plugin. And the page is no longer rebuilt after every turn: it is built when you ask for it.

If another plugin already holds `/track` or `/usage-page` in a session, the status line says so and the other command still works.

## The script

`scripts/summarize.mjs` has no dependencies. Run it yourself if you like:

```
node scripts/summarize.mjs <project path or ledger file> --by day|model|category|ticket|routing [--since 2026-11-01] [--top 10]
```

It prints a small JSON table. Without `--by` it lists the costliest turns. A turn's cost goes to one ticket or category only when the turn has exactly one. A turn that spawned for several lands under `(none or mixed)`. Cost is never split by guesswork.

## What `/usage` already answers

The built-in `/usage` (also `/cost`, `/stats`) has the current session's cost, plan limits and when they reset, and `/context` has the context window breakdown. This plugin does not repeat them.

What only this ledger answers: cost per day, per ticket and per kind of work across sessions, your costliest turns with the task each belonged to, tool errors and denials over time, and which model each routed agent really ran on against the one requested.

## Checks

```
claude plugin validate plugins/observability
claude plugin test plugins/observability
node --test plugins/observability/scripts/summarize.test.mjs plugins/observability/scripts/board-page.test.mjs
```
