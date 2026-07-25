# Why Sidequest exists

Sidequest exists because my brain does not work one project at a time.

I have ADHD. I usually have about five projects open, and while I'm working on one of
them my brain keeps producing things for the others:

- "Oh, and the contact form is still broken."
- "By the way, this setup should be reusable."
- "We should really fix that agent flow."
- "I just remembered why the other project got stuck."

Those thoughts are often useful. The problem is what happens next.

If I follow one immediately, I lose the thread of the thing I was already doing. If I
don't follow it, I forget it. If I write it in a random note, the note becomes another
place I have to remember to check. And if I switch to a different project to record it
properly, I may spend twenty minutes reconstructing that project's state before I can
even explain the thought.

Sidequest is the third option: capture the thought where it happens, with enough context
to make it real, then keep going.

## The original problem was continuity

Sidequest did not start as a model router.

It started as a quest log for interruptions. The earliest surviving Sidequest-specific
request, from July 4, 2026, was:

> "turn all grievances that are not yet done into sidequests and remove those that are done"

That was the first shape of the idea: unfinished things should survive outside the
conversation that noticed them, and finished things should leave the active queue.

The important word in the name is **sidequest**. A sidequest matters, but it does not
have to replace the main quest the moment it appears.

This is not about training myself to stop having "oh and..." thoughts. That would fight
the way I actually work, and it would throw away a lot of good ideas. The goal is to
make that multitasking pattern useful without letting every new thought destroy the
current thread.

## One board across the work I actually do

A separate task list inside every repository sounds tidy. In practice, I have to
remember which repository contains the thing I forgot, open it, reconstruct the state,
and then find its list. That is the same memory problem with more steps.

Sidequest keeps durable project context while giving me one place to see the whole
queue. A ticket still belongs to a project, has project-specific files and evidence,
and must be executed in that project's repository. The board spans projects because my
attention spans projects.

That is why the dashboard is local and cross-project. It is not a public project
management service and it is not another account to maintain. It is a live view of the
work already happening on this machine.

The board gives me answers a conversation cannot reliably keep giving after hours of
work, compactions, restarts, and parallel sessions:

- What was I doing in this project?
- What did I notice while I was doing something else?
- Which things are being worked on right now?
- What is blocked, and why?
- What finished while my attention was elsewhere?
- What evidence exists that it actually works?

## Remembering a task is only half the job

A perfect backlog that only grows is another source of guilt. Sidequests need to get
done, not merely remembered.

That led to agents, dispatch, and the orchestrator/executor split. A sidequest can be
captured while I stay on the main thread, then handed to an executor that starts with
the ticket's project, files, constraints, and verification contract.

The ticket has to be atomic enough for that to work. An executor should not need the
entire conversation that produced the thought. The ticket carries the context needed to
act: what is wrong, why it matters, where to look, what may change, and how to prove the
result.

This is why Sidequest is more than a Kanban board. The board is also the handoff format
between attention, sessions, and agents.

## Model routing came later

Once Sidequest could execute tickets, a second problem became obvious.

The main Claude Code session usually runs a powerful model because the main thread has
to plan, arbitrate, integrate, and recover when something goes wrong. But many of the
sidequests it discovers do not need that model. A typo, a small test repair, a bounded
documentation update, and a hard debugging problem are different kinds of work.

On July 15, after the execution system already existed, I described the failure this
way:

> "the orchestrator basically does everything almost always in other projects and it's almost never delegated which means we are now using even more tokens by having the expensive model do everything in the main thread"

That is where automatic routing enters the story.

Manual model switching has the wrong shape for this. The selected model belongs to the
session, but the decision belongs to the task. It is sticky, easy to forget, and often
made before the real difficulty is known. The safe manual habit is to leave the best
model selected for everything, which quietly wastes the capacity I wanted to reserve
for hard work.

Sidequest attaches the decision to the ticket instead. The work gets a category such as
`coding.easy`, `debugging`, `research`, or `docs-writing`. The category routes to a
concrete model and reasoning effort. I describe the kind of work I see; the system
chooses the executor that fits it.

This has three benefits:

1. Small work stops consuming the expensive main-loop model just because that model was
   already selected.
2. Hard work can still get the strongest model without making that the permanent
   default for everything else.
3. Work can use separate provider capacity. Codex-backed executors and Claude executors
   draw from different subscription pools, so the queue can use both.

Right-sized model use is an important reason Sidequest grew, but it is not why
Sidequest was born. It is an optimization made possible by first turning interruptions
into durable units of work.

## Fresh context is part of the routing win

A long-running orchestrator carries the history of planning, screenshots, tool results,
failed attempts, and every other ticket it has touched. Every new turn has to process
that context again.

A dispatched executor starts with one ticket and a fresh context. Even when it uses the
same model, the same task can be cheaper and easier to reason about because the executor
is not carrying the rest of my day with it.

This separation also lets work happen in parallel. I can stay with the thing that needs
my attention while several bounded sidequests move independently. The point is not to
create as many agents as possible. It is to keep unrelated context out of each task and
let independent work stop waiting on my attention.

## Durable state matters because sessions are temporary

Claude Code sessions compact. Agents stop. Terminals close. A provider request fails.
A computer restarts. None of those events should erase the plan or make finished work
impossible to recover.

Sidequest keeps tickets, claims, comments, checkpoints, dispatch records, submissions,
and completion evidence outside any one conversation. A new session can reconstruct
what happened by reading the board instead of relying on whatever survived in context.

That durability is especially important for the way I multitask. I may return to a
project after several other projects have occupied my attention. "Remember what I was
doing" is a core feature, not a convenience.

## Trust is part of the product

Delegating work only helps if I can trust what comes back.

That is why tickets declare scope, executors verify their work, parallel changes use
git worktrees, and publishing stays with the orchestrator. Those constraints protect
the repository while several agents and projects move at once.

The system also has to protect the work itself. A guard should prevent damage without
stranding a verified result behind an impossible recovery path. A claim should prevent
duplicate assignment without becoming permission to submit. Liveness should come from
observed agent state, not a timer guessing whether a long task died.

The standard is simple: failures should be visible, explain what happened, and name the
next safe action. Silent degradation is worse than a loud stop because it makes the
board look trustworthy while its guarantees have already disappeared.

## What Sidequest optimizes for

In order:

1. **Cognitive continuity.** Capture an interruption without losing the current thread.
2. **Durable memory across projects.** Return later and know what mattered, what changed,
   and what remains.
3. **Execution without attention switching.** Let bounded work move while I stay with
   the problem that needs me.
4. **The right model for the work.** Spend strong-model capacity where it changes the
   result, and use cheaper or separate capacity where it does not.
5. **Recoverable parallelism.** Several things can move at once without corrupting the
   repository or losing finished work.
6. **Visibility.** The dashboard should explain what the system is doing well enough
   that I can steer it without reconstructing its internals.

The order matters. A system that saves tokens but makes me lose the thread has failed.
A system that tracks every thought but never ships any of them has also failed.

## What Sidequest is not

**It is not a cure for ADHD or a system for forcing linear work.** It accepts that my
attention moves and gives those movements somewhere useful to land.

**It is not project management for a team of humans.** It is a local work queue and
memory layer for one person working with agents across many projects.

**It is not a token minimizer.** The goal is right-sized spend. Using the strongest
model on a problem that needs it is correct. Using it on every small sidequest because I
forgot to switch is the waste.

**It is not an excuse to delegate everything.** Tiny named edits can be faster inline.
Ambiguous, high-impact decisions still need my judgment. Sidequest should remove
unnecessary context switching, not remove me from the work.

## The whole reason, in one sentence

Sidequest lets me say "oh, and..." without either derailing what I am doing or losing
the thought, then gives that thought enough context, memory, and execution machinery to
come back as finished work.
