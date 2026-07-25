# Why Sidequest exists

This is the reasoning behind the plugin. Not what it does (the README and the docs
site cover that), but the problem it came from, the bet it makes, and the parts of
that bet that have and haven't paid off.

## The thing that started it

I kept forgetting to switch models.

That's it. That's the origin. Claude Code has a model picker, the picker is sticky,
and whatever I last selected carries into the next hour of work whether or not it
fits. So I'd set the best available model to think through something hard, and then
stay on it while renaming a variable, fixing a typo in a doc, and running the same
test suite eleven times. Enormous models doing trivial work, all day, quietly.

The reverse happened too and hurt more. Something cheap would still be selected when
the work turned genuinely hard, and I'd get a confidently wrong answer that cost an
hour to unwind.

## Why "just be disciplined about it" doesn't work

I tried. It fails for structural reasons, not character reasons.

**You don't know the shape of the task until you're inside it.** Half the time a
"quick fix" opens into a real design problem three files down. The model choice was
made before the information that should have driven it existed.

**Both failure directions are silent.** Overshooting produces a correct answer and an
invisible bill. Undershooting produces a plausible answer and an invisible defect.
Nothing errors. Nothing warns. There is no feedback signal to learn from, so the
habit never forms.

**The safe default is the expensive one.** Given silent failure in both directions and
no feedback, the rational move is to always pick the strongest model. Which is exactly
the waste I was trying to avoid, arrived at by sound reasoning.

**It's a decision with the wrong cadence.** Model choice is a per-task decision, and
tasks turn over every few minutes. Any decision you have to make dozens of times an
hour, while concentrating on something else, will not get made well.

So the problem isn't that I forget. It's that the decision is attached to the wrong
thing. It's attached to the session, and it needs to be attached to the work.

## The bet

**Make routing a property of the work, not a property of the session.**

If a unit of work is written down before it's done, with enough about it to classify
it, then the model can be derived instead of chosen. I describe what needs doing.
The system decides who does it.

That's the whole idea. Everything else in Sidequest is a consequence.

Concretely: work becomes a ticket, a ticket gets a category, and a category names a
concrete model and reasoning effort. Categories are things like `coding.easy`,
`debugging`, `research`, `spike-investigation`, `docs-writing`. They're descriptions
of the kind of thinking a task needs, which is the thing I actually know at the moment
I file it.

Two design choices inside that are worth stating, because both were reversals:

**Categories name concrete models, not tiers.** An earlier version had complexity
grades and a ladder that mapped grades onto models. It was a layer of indirection that
made every routing question require two lookups and hid the actual decision. Routes now
say `opus·xhigh` or `codex-gpt-5.6-terra·high` in plain text. You can read the routing
table and know exactly what will run.

**Classification happens from the ticket text, not from a score I assign.** Asking a
human (or me) to rate complexity 1-10 reintroduces the same per-task judgment call that
failed in the first place. Category descriptions are written as classifier prompts, so
the routing decision comes out of the work description itself.

## What falls out of the bet

Once work is ticketed and routed, three other things follow that weren't the original
goal but turned out to matter as much.

### The session that plans stops being the session that executes

If a ticket carries its own model, it also has to carry its own execution context.
That splits the loop into an orchestrator (reads the board, files tickets, dispatches,
integrates, publishes) and executors (one ticket, fresh context, verified commit,
stop).

This is where most of the actual token savings live, and it's not the part I set out
to build.

A long orchestrator session carries a huge context and re-bills all of it on every
single turn. An executor starts near-empty and bills a small context per turn for the
same work. Same task, different denominator. Measured on 2026-07-25 across 24 hours:
the main loop spent 310 billed tokens for every token it produced. Executors spent 170.
Roughly half as wasteful, doing most of the work.

It also buys parallelism (several tickets at once) and model diversity inside a single
piece of work (an Opus executor debugging while a cheaper one writes docs), neither of
which a single session can do.

### Capacity across providers, not just across models

`codex-gateway` puts GPT-5.6 models into the same `/model` picker by routing
`claude-codex-*` model ids to a Codex backend. Once routing is automatic, that stops
being a novelty and becomes a second pool of capacity on a separate subscription.

On 2026-07-25, 34% of a day's total token spend ran on Codex models. That work does not
touch the Anthropic usage limit at all. Inside the executor pool specifically it was
close to an even split: $327 notional on Opus against $313 on Codex.

The point isn't that one provider is better. It's that a routing layer can spend from
whichever bucket has room.

### State that survives the session

Context windows compact, sessions die, agents crash mid-run. If the plan lives in the
conversation, the plan dies with the conversation. I lost work this way enough times
that durable external state stopped being optional.

So the board is a SQLite database outside any session: tickets, claims, checkpoints,
submissions, comments, dispatch records, route history. An agent that dies leaves a
ticket that still knows what it was doing. A session that compacts away its own memory
can read the board and recover.

This is also why the board spans every project rather than living per-repo. Work moves
between projects; the queue shouldn't care.

## What the numbers actually say

Measured 2026-07-25, 24 hours, from the local telemetry stack. Notional USD (these are
subscription-covered, the dollar figures are list-price equivalents used as a common
unit):

| | | |
|---|---:|---:|
| Executors (subagent) | $656 | 60% |
| Orchestrator (main) | $361 | 33% |
| Auxiliary (compaction, background) | $84 | 8% |
| **Total** | **$1,101** | |

Two things to read from this.

**Most of the spend is delegated work.** If the routing layer were ceremony, the main
loop would dominate and executors would be a rounding error. It's the other way around.

**A third of it is off the Anthropic limit entirely.** $378 of that $1,101 ran on Codex.

The counterfactual can't be measured directly, but the direction is clear: without
routing, that $378 of executor work would have run inline, in the orchestrator's fat
context, on whatever model happened to be selected. More expensive per token, and
billed against a much larger context per turn.

## The guards, and why each one exists

Every constraint in Sidequest is scar tissue. Listing them is the honest way to explain
why the system is more complicated than "pick a model."

- **Worktree isolation.** Parallel executors in one checkout overwrite each other. Each
  gets its own git worktree.
- **Scoped commits.** A ticket declares the files it may touch, and a commit outside
  that scope is refused. Prevents an executor from quietly rewriting things nobody
  reviewed.
- **Claims.** One agent per ticket, so two dispatches don't duplicate work.
- **Verify before submit.** An executor runs the project's real verification and can't
  hand in work that doesn't pass.
- **Orchestrator owns publishing.** Executors stop at a verified commit. Merging,
  version bumps, and pushes happen in one place, because version bumps in this repo
  touch two files that must agree and concurrent executors can't coordinate that.

The lesson that took longest to learn, and the one that generalizes past this project:

> A coordination record must never become an authorization gate on work already done.

Three separate bugs in one evening had that exact shape. A claim's 60-minute timer
expired while an agent was still verifying, so it couldn't commit its own finished
work. A submit released the claim, so an executor sent back for a correction couldn't
commit the correction. An isolation guard correctly refused a shared-tree commit from
an executor that the platform had put in the shared tree without telling it.

Every one of those guards was individually right. Collectively they stranded verified
work behind a wall of correct refusals, none of which named the next step. Guards
protect the repository. They must not hold finished work hostage.

The related rule, from the same evening: **observe, don't guess.** The claim timeout was
a wall-clock TTL standing in for liveness, and wall-clock time is uncorrelated with
whether an agent is alive. Worse, the error was biased toward maximum damage: short
tasks never tripped it, long valuable ones always did, and it tripped near the end of a
run when the most unsaved work was at stake. Death is directly observable here
(`SubagentStop`, `SessionEnd`). Key on the real signal and keep age only as a
conjunctive backstop.

## Non-goals

Worth stating, because a few of these have been proposed and rejected.

- **Not project management for humans.** It's a work queue for agents that a human can
  read and steer. Tickets are written to be executed, not to be reported on.
- **Not a token minimizer.** The goal is right-sized spend. Spending Opus-level money
  on an Opus-level problem is a success, not a regression.
- **Not multi-tenant.** This runs locally against a local board. Hardening against a
  hostile tenant is not a priority and shouldn't hold releases.
- **Not a separate router.** A standalone routing plugin was built and scrapped. Routing
  is inseparable from the work queue that feeds it; splitting them produced two things
  that each knew half the story.
- **Not a replacement for judgment.** Hard problems still need the expensive model and a
  human in the loop. The system's job is to stop spending that on everything else.

## The honest cost

Three things this doesn't fix, stated plainly.

**The orchestrator is still the expensive part.** A third of spend, at the worst
billed-to-produced ratio in the system. Long high-context sessions woken repeatedly by
executor notifications are the single largest remaining inefficiency, and routing
doesn't touch it.

**Orchestration has real overhead.** Writing a complete ticket, dispatching, reading
results, integrating, verifying again, bumping, publishing. For a genuinely small change
that overhead exceeds the work. There's an explicit escape hatch for user-named trivial
edits, and it exists because the system was slower than doing it by hand often enough to
matter.

**The system needs maintaining.** A representative evening shipped four releases, and
most of them were fixes to Sidequest itself rather than to anything it was built to
help with. That's the tax on building your own tooling. It's worth it here because the
frictions are real and recurring, but it isn't free and pretending otherwise would be
dishonest.

## How you'd know it stopped working

Concrete falsifiers, so this doesn't stay a story:

- Executor share of spend drops below the orchestrator's. Means work is drifting back
  inline and the routing layer is being bypassed.
- Off-provider share collapses toward zero. Means categories are all routing to one
  model and classification has degenerated.
- The billed-per-output ratio for executors approaches the orchestrator's. Means
  executors are carrying too much context and the fresh-context advantage is gone.
- Ticket count grows while integration rate flattens. Means the board is accumulating
  intent instead of shipping.

These are being built as dashboard panels rather than left as things to reason about,
because a claim you have to hand-verify with ad-hoc queries is a claim that will quietly
stop being true.
