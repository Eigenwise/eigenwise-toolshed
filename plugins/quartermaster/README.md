# Quartermaster

Quartermaster sets up a workspace and then keeps improving it with you.
It notices what you keep doing by hand, proposes one change at a time with the evidence behind it, and applies it only when you say yes.
Later it checks whether the change got used, and offers to roll back the ones that didn't.

```bash
claude plugin marketplace add Eigenwise/eigenwise-toolshed
```

```bash
claude plugin install quartermaster@eigenwise-toolshed
```

Then run `/quartermaster:outfit` in the project, new or existing. It checks what is already there, proposes what is missing, installs Sidequest if you don't have it, and asks you to reload plugins once.

## The pipeline

```
evidence → candidate → proposal → decision → change → verdict
```

- **Evidence.** The mod records events in-process while you work: permission denials, tool failures (a shell failure is named after the command that failed; a call you rejected and a `grep` that found nothing are not failures; a fix is offered only for a setup error that comes back, like a command not found, not for a failing test or build), shell commands you typed in bash mode (first two words only; the model's own calls are not counted), skill and command use, long turns, compactions. It's append-only JSONL, one file per session per day, and the model never sees it unless a skill asks.
- **Candidate.** A detector crossed a named threshold, like "ran `npm run build:x` by hand 14 times in 6 sessions". There's no friction score.
- **Proposal.** One markdown file with a kind, a target, the evidence, a countable check with today's baseline, the exact diff or command, and the rollback.
- **Decision.** Approve, reject, already handled or later. A rejection is kept with its reason and never proposed again. Already handled closes the proposal with your words and is not remembered. Silence is recorded as silence.
- **Change.** Before anything is written, the prior bytes of every file it touches are saved. Rollback is a file restore, and only for a file that still holds what the change wrote: one edited since is left alone and named.
- **Verdict.** `applied → loaded → exercised → useful`, then keep, improve or roll back. A change nobody used is a failed trial, and retiring it is normal.

Proposal states: `draft`, `offered`, `accepted`, `declined`, `handled`, `applied`, `loaded`, `exercised`, `useful`, `rolled-back`, `expired`. `declined` is a Reject, remembered as never again. `handled` is Already handled: the proposal was right and already dealt with, it is closed with your words, and it is not remembered, so the same evidence may be proposed again once it is still piling up 30 days after the day you answered.

Proposal kinds: `skill`, `skill-improvement`, `rule`, `permission`, `setting`, `plugin`, `routing`, `script`, `retire`, `upstream`, `docs`.

## The four surfaces

1. **Status entry.** `Quartermaster: 1 to review: <what it is> (/quartermaster)` when a proposal waits, and with more it names the first and says how many more (`... and 2 more`). A proposal set aside with Later is not counted. With nothing waiting the entry is cleared. When the events folder refuses a write twice, they go to `.claude/quartermaster/events/` and the status adds the error until a write works.
2. **The `/quartermaster` inbox.** A pane listing each proposal with its evidence, Approve, Reject, Already handled and Later buttons, and a reason field (a label, a hint, then the field; Enter keeps the words and answers nothing). On Reject or Already handled, a reason you typed reaches the open session as one line, so the agent hears why. That line is a message, so the agent answers it; with no reason typed nothing is sent. A proposal set aside with Later shows as a dim row saying until when. The pane reads the proposal files again each time it opens, so a proposal written by another session or by hand is seen. When a press cannot write its file, the pane says so in red and keeps the row, until the next press or Back. When a Reject wrote the proposal but not its never-again line, the pane says the proposal is rejected and that line was not written, with the error, and keeps your reason. A long title is cut at 60 characters in the status entry. Reject, Already handled and Later are recorded by code; only a typed reason sends the session a line, and that one starts a turn. Approve queues `/quartermaster:apply` for that proposal, so the change happens in the open.
3. **One offer at a real pause.** For a named candidate it is a short toast that points at `/quartermaster`, where the buttons Draft a fix, Later and Ignore in this project live, with a line saying what each does. Later takes the line out of the list until its wait is over. The list holds only what Quartermaster has a fix for (a command typed by hand, a blocked call, an unused skill); a failure that keeps coming back stays evidence for a resupply round. Two more offers name a skill and start nothing: `/quartermaster:resupply` after 15 sessions on 7 days and 30 snags since the last resupply round, with a candidate nobody has proposed for, and `/quartermaster:review` 3 sessions after a change (one offer for all due). Every impression is logged, and an ignored offer waits 3 days, then 6, then twice as long.
4. **The files.** Everything above is a projection of plain files under `.claude/quartermaster/`. Where nothing draws (`claude -p`, an SDK host, mods off) the skills read and write those files directly.

The model gets two tools: `mcp__quartermaster__evidence` (read what was sensed) and `mcp__quartermaster__proposal` (create, list, decide, record a change, update, roll back). A subagent can only list; the main session writes.

## The verbs

A resupply round is a round of improvement proposals.

| Skill | Does |
| --- | --- |
| `/quartermaster:outfit` | Sets up the workspace. Explores the project and mines your history first, says in one line when the project is on the older version (and points at `upgrade`), records any current plugin it finds installed by hand so the undo covers it, then asks one section at a time, each with a recommended answer: plugins, routing, rules, permission rules, codebase map. |
| `/quartermaster:resupply` | Runs a resupply round: checks each candidate against existing skills and rules, then drafts at most three proposals, or none. |
| `/quartermaster:apply` | Applies one accepted proposal by id. Records prior bytes first, makes exactly that change, runs its check, tells you the rollback. You or `/quartermaster` start it, never the model. |
| `/quartermaster:inspect` | Read-only health check: is each Toolshed plugin installed, loaded in this session and actually used; are routing killers set (`CLAUDE_CODE_EFFORT_LEVEL`, `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`, a blocking `availableModels`); did any hook get cancelled, named. It lists only this project's plugin rows, with enabled as it is in that project's folder. |
| `/quartermaster:review` | The verdict pass. For each applied change, was it used since and did its check move? Asks keep, improve or roll back only where there's evidence either way. |
| `/quartermaster:upgrade` | Moves a project off the older Toolshed with you. A read-only scan (`scripts/upgrade-scan.mjs`) says which projects still have the older version on and, for this one, its shape (team, solo, half-moved, or moved once only kept things are left) and every leftover with its verdict: keep, convert, remove or ask, as still to do or kept with its reason. A path git tracks, and the committed settings file, is never on its deletion list and never edited on the plain run, whatever the author count: one committed-change question covers them (a team's is a drafted branch, a solo repository's is applied in the working tree with `git diff` shown), and your own plugins are switched in the local settings file meanwhile. It prints a count for the other projects and this one's own line (`--all-projects` lists them; several `--project` values give a section each), a ready line per custom routing category, and says that an older Quality Gate has no plugin here, so it is only switched off and the report says it is gone. An older Observability is not a leftover: it updates in place with the other plugins and keeps recording. What you keep on an answer (the gateway, tickets left in the archive) is recorded, and so is what the run leaves in your memory notes after editing the ones that name an older tool with an equivalent here (it states its own reason; no one has to answer), so the next scan lists it as kept with when and why. A key in a settings file git tracks, the local one included, is never on its deletion list and waits for the committed change. When everything still to do waits for a yes, the scan says so in one line and the run is done. `--open-tickets` lists the old board's open tickets one per line, and the scripts no longer print the runtime's SQLite warning, and a project whose only older plugin on is a kept gateway no longer holds the home cleanup. An old map of more than 400 lines is not converted in the run: it is listed as a later step (`codebase-mapper:map` when you next work in the project), with its line count, and the project still reads as moved. Older rules (the `.claude/live-rules/` folder or the single `.claude/live-rules.md` page) it converts itself with `scripts/upgrade-rules-convert.mjs` into `.claude/rules/` and project skills, plan first, no rules plugin needed. Then the reversible steps, at most three questions in one message, and the home folder once, after the last project. Its one stop has two ways through: `/reload-plugins`, or a new session in the folder told `continue the upgrade`, which is the way over a remote connection. Nothing is pushed, created or opened on a tracker. The scan says when each project was last used (its newest session on record or its last commit, whichever is newer) and how many of the projects with an older plugin switched on were used in the last 30 days, since that count is of settings keys and not of live projects. `scripts/upgrade-quiet-projects.mjs` lists the ones not used in that time and writes nothing; after your one yes for that list, `--switch-off` copies each project's local settings file and switches the older plugins off there, leaving committed files and the gateway plugin alone. |
| `/quartermaster:report` | Drafts a sanitized upstream issue when the friction comes from a shipped plugin. Searches existing issues first. You send it. |

### Install-day hindsight

The mod only sees forward from the day it's installed. `outfit` also runs a small script over the transcripts you already have:

From a checkout of this repository (an installed copy has the same script in its install folder, and the skills run it for you):

```bash
node plugins/quartermaster/scripts/mine.mjs <project path>
```

It streams the project's transcripts (and its `.claude/worktrees/` ones) from the last 90 days, newest 60 sessions, skips subagent records and sessions nobody typed into twice, and prints one JSON object under 8 KB: command prefixes by count, tool failures, permission denials, hook blocks, skills and slash commands used, sessions scanned and the date range. It never prints prompts, arguments or file contents and never writes anything. No dependencies.

## What it will never do

- **No runtime gates.** Quartermaster never blocks a tool call, a prompt or a stop. If its mod breaks, your work carries on.
- **No scoring.** No friction score, no quality score, no CRAP numbers. Candidates are named counts, verdicts are counts against a baseline you can read.
- **No auto-apply.** Every change to your setup is offered, approved per item and reversible. A request to apply is not an approval; only an `accepted` proposal gets applied.
- **No orchestration.** Running work is Sidequest's job.
- **One thing in your home directory**: what it notices in each session, under `~/.claude/quartermaster/events/<project>/`, so that noticing never writes into someone's repository. Nothing else goes there unless you ask for it by name.

## Where its files live

| What | Where |
| --- | --- |
| Evidence | `~/.claude/quartermaster/events/<project-slug>/<date>.<session>.jsonl` (personal, never committed) |
| Proposals | `.claude/quartermaster/proposals/P-0007.md` |
| Changes and prior bytes | `.claude/quartermaster/changes/C-0007/change.json` and `prior/` |
| Rejections | `.claude/quartermaster/rejected.md` |
| What you kept on purpose in the upgrade | `.claude/quartermaster/upgrade-kept.md`, one line each with the date and your reason |
| Offer impressions | `~/.claude/quartermaster/events/<project-slug>/impressions.jsonl` (with the events) |

The project files are plain markdown. The folder ignores itself with its own `.gitignore`, because it also holds the saved bytes of files a change touched, your local settings among them. A team that wants to share what was tried, kept and rejected deletes that file.

## What the older Toolshed left

The first session in a project says once what the older Toolshed left there that nothing uses now (the older map, board or rules, the older Quality Gate or model gateway plugins) and that `/quartermaster:upgrade` moves it. A project still wired to the older model gateway gets that first, with the settings file and the line to delete by hand, because a session there may not reach a model. When Quartermaster is installed it speaks for Codebase Mapper, Sidequest and Live Rules too, which then stay quiet. A plugin installed from the private `toolshed-next` marketplace also gets the commands that move it to `eigenwise-toolshed`, once per machine. What was said is remembered in the plugin's own store.

## Versus the older one

| | Older | Now |
| --- | --- | --- |
| Capture | Transcript regexes after the fact, a node process per Stop and prompt | In-process events, zero processes per tool call |
| Trigger | "6 sessions, 25 friction events" | A named candidate with its count |
| Offer | A UI-only line the model never saw. 0 of 14 answered | A pane with buttons, every impression logged |
| Proposals | Not recorded, only decisions | First-class files with an expected check and baseline |
| Verification | Before/after friction ratio, 91% came back insufficient data | Was it used, did its own check move |
| Rollback | A spoken verdict, never once performed | Prior bytes stored before every write |
| Self-maintenance | Updater, freshness probes, doctor: half the code | Native auto-update; `inspect` is read-only |
| Upstream bugs | Filed by hand under `other` | Its own kind and the `report` skill |

Kept from the older one: capability before friction, the bounded private miner for hindsight, rejection memory, per-item approval with exact diffs, and the permission veto list.
