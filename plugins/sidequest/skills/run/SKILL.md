---
name: run
description: Use to execute the board's frontier. Starts each ready ticket on its routed agent in parallel, records each result when the agent returns, and reviews finished work.
---

# Run

Execute every frontier ticket in parallel and write each result back. Never ask whether to start: the plan already got a yes.

## 1. Read the frontier

Call `mcp__sidequest__board` for the frontier: `ready`, `afk`, blockers all `done`, or passed review when every run shares the one checkout (`settings.worktrees` false).

- `hitl` tickets are never dispatched. List the ones whose blockers are finished as waiting on the human, with what each needs.
- A **checkpoint** is a `hitl` ticket of kind `review`. Once everything blocking it is `done` or in `review`, load the `land` skill for those tickets, show the human the result, and wait. Their yes moves it to `done`. A correction becomes a new ticket the checkpoint is blocked by.
- A frontier ticket marked as waiting for a held shared thing is left alone. Start what can start; pass `alongside` only when the person says so.
- An empty frontier with `doing` tickets means agents still run: say so and stop.
- A `doing` or `review` ticket with no agent started for it in this session is interrupted. It stays where it is and is never requeued. The board marks it `interrupted` with what it knows, like `last activity 3h ago`. A `doing` ticket this session started whose agent call never happened is named the same way in the `now` and `list` views: doing with no agent running here. Name it to the person in one line with those words and start nothing on it.
- The person's verbs for it: **resume** starts a `doing` one again, and the brief says what changed since; a `review` one carries on from its review. **Set aside** moves it to `parked`. **Drop** is the `ticket` op `drop`: it removes only what is safe and names what it kept. When they type continue or go on while this conversation has no work of its own, that resumes an interrupted plan, with no question about which; once it has, those words are about that work. A ticket whose branch someone else committed to last is not offered for resume.

## 2. Start each ticket

For each frontier ticket, call `mcp__sidequest__start` with its id. It marks the ticket `doing` and returns the exact `Agent` call: `subagent_type`, `model`, `effort`, `isolation`, `name` and the brief.

A rule you were handed on where commits go (no branch, no pull request), and an approval the project's rules ask for before a commit, go into `start` as `delivery`; the brief then carries it.

Make that call exactly as returned, changing no field. A ticket's work happens in the worktree its `isolation` gives it, never one added by hand. When the board's folder is not a git repository the call comes back with no `isolation`, and the answer says why: the worker makes its own worktree in the repository the ticket names. If the answer says the ticket names no repository folder, add it and call `start` again. Start independent tickets together, in the background.

With five or more frontier tickets and workflows available, start each with `forWave: true` and pass the entries it returns to the saved wave workflow, per `references/wave.md`. If the name fails, use `scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/wave.js"` and the same `args`.

## 3. Say what else can move

When a ticket that holds a shared thing starts, or anything likely to run for minutes, say one line from the `start` answer or the `now` view: what holds what and roughly how long, what runs beside it, what waits and behind whom, and what the person could do now, ending with "say which". Work they did not ask for is offered there, never started. When they ask what they can do or what is going on, paste the `now` view.

When the person says the shared thing is busy (their own job, or in use), create one ticket that waits on them, is `doing` and uses it, titled in their words, and close it when they say it is free.

**After starting agents, end your turn.** The host hands you each agent's return as a new turn, and it cannot reach you while you sleep, loop or poll: a session that waited in a loop sat seven minutes on a return that had already come. Never sleep, or read the board, the tree or a branch to see whether an agent is done. If other work can move, do that first, then end the turn with one line on what runs. In a turn nobody typed, record what finished and continue only what it unblocks inside the plan the person started. Parked tickets, the inbox and a stopped plan wait for the person. After a typed stop, a returning agent's result is recorded and nothing new starts from it.

## 4. Finish each ticket

Say when a build is back (`Build is back: 16 tests pass. Review and proof running.`). When a commit waits on their yes, the review's wait is their reading time: fill the ticket's `forYou.sayingYesTo` in the two steps the `land` page gives, and say in the chat what each reply hands you.

When an agent returns, call `mcp__sidequest__finish` with the ticket id and its result as returned, in the shape of `references/result-contract.md`, to add what you checked and move the ticket. Pass `checked` and `uncertain` through unchanged; a check that did not run stays `not checked`. When a worker's result says what it had to find out to run the checks, write it into `settings.checks` before the next start, so the next brief carries it. When workers keep reporting `not checked`, make one offer and write it on their yes: `worktree.baseRef: "head"` in `.claude/settings.local.json` when the worktree lacks local commits, else `settings.worktrees` false for missing ignored files. A running service is named in `settings.shared` instead.

Before a returned `needs` leaves a ticket at `needs-you`, apply this rule: A decision reaches the person only when it cannot be undone, spends money or reaches outside the project, or is taste or product direction only they have. Any other choice with a recommended answer is taken: say in one line what you chose and how to undo it, and move on. When it stays, write the ticket with `forYou`, in the shape the `sidequest:plan` skill gives. A failed run lands in `needs-you` with its result, so it never loops. For a wave, call `finish` once per ticket from the workflow's results, then record each review as step 5 says. A ticket that came back with no review gets `review skipped: quick`.

## 5. Review

A `quick` ticket skips the review: record `review skipped: quick`; the verify in `land` is its check. An `outside-code` ticket is its own review: on `pass`, read `${CLAUDE_PLUGIN_ROOT}/skills/sidequest/references/outside-code.md` before anything of it runs. When you run its reviewer directly, record the verdict as below. `land` looks for the pass note, and without it the ticket stays in `review`.

Every other ticket that lands in `review` from a direct run gets one independent review, in parallel. With `settings.worktrees` false the next run holds the checkout, so the review reads and runs nothing: the worker's check and the one verify in `land` are the tests.

```
Agent({ subagent_type: "sidequest:scout", description: "Review PL-12",
  prompt: "PL-12 [route:review] Review the work on branch <branch>. The brief the worker got is in <the file start named>: read it in full first. ..." })
```

That file holds the decisions, the `Done when` and how checks run here, so add only what it lacks: where the branch is checked out and what the review must not touch.

Record the verdict with `mcp__sidequest__ticket` as a note starting `review pass:` or `review fail:`. A pass stays in `review`; a first fail goes back to `ready` with the findings; the next `start` puts that note and the last branch in the brief.

Only a behaviour finding or a clear break of a guideline written in the repository (rules files by their `paths`, a contributing or style page, linter or formatter config) is a fail: the change misses what the ticket says, breaks something, claims a check that never ran, or breaks a written guideline, with the file that states it and the file and line that break it. Anything else, including a rule that is not written in the repository, fix yourself or leave on the log. What you change in a ticket's work after its pass goes on that ticket as a note with the commit; a change in behaviour beyond what the review found gets a second review.

**Two failures stop a ticket.** Each failure is a log note starting `review fail:`, `verify fail:` or `ci fail:`. On a ticket's second, of any kind, stop running it: when what is left is small and clear, fix it yourself, prove it for real, log what you ran and land it; otherwise move it to `needs-you` once, with both findings and your read of why, written to be read cold. No third run. Before blaming a ticket for a red verify or CI, run the same check on the base, or read the base's CI: a red base is said in one line and sends no ticket back.

When the human answers a question about a ticket mid-run, write the answer on that ticket as a note before acting on it. When they correct work that is running (a name, a scope, leave that file alone), it never waits silently: note it on the ticket, pass it to the running agent when you can message it, else apply it yourself when the agent returns or send the ticket back with the note, and tell them in one line which of those happened.

## 6. Keep going

When results move tickets to `done`, new tickets join the frontier. Start them the same way, except a ticket with two failure notes. When nothing is left to start or running, load the `land` skill for everything in `review`.

## Report

In the shape the `sidequest` skill gives, with the branches linked and the `board` view `waiting` pasted as it is.

If the sidequest tools are missing, the mod is not loaded. Say so, read `.sidequest/tickets/`, spawn each ticket with `model` and `effort` from `.sidequest/board.json` or the defaults and the ticket id first in the prompt, and update the ticket files yourself.
