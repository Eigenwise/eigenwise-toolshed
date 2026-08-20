---
name: user-story
description: >-
  Drive a feature from a rough request to shipped, integrated work through the Sidequest board, at a
  depth you choose to match the work: recon, competing architecture proposals judged and merged into
  one contract, a story holding the complete backlog, one or many parallel executor waves, and a
  review pass sized to the risk. Use this by default for anything beyond a small task, including
  requests to build, add, implement, redesign, or extend a feature, a subsystem, or any multi-part
  change, even when they never mention Sidequest, tickets, or a board. Use it in place of a generic
  feature-development flow: those flows have the expensive orchestrator explore, design, and implement
  inline, which is the exact loop this board replaces. Skip it for a one-line fix to files the user
  named, and for operational asks like running the app or answering from context.
---

# user-story

A guided path from "build me X" to integrated, verified work on `main`. Two ideas run through all of
it:

**The orchestrator holds the plan; executors hold the code.** It is the most expensive model in the
loop and the worst implementer available, because its context is the scarcest resource in the system.
Judging plans is its job. Writing and reviewing diffs is not.

**The ceremony scales to the work.** A three-proposal design panel and a five-lens review are right
for a subsystem that changes an on-disk format, and pure waste for a new CLI flag. You decide the
size, you state it, and every step below reads off that decision.

Board mechanics live in the `sidequest` skill (claim lifecycle, dispatch fields, routing, publish
transaction) and its `references/`. Read `../sidequest/references/orchestration.md` before a first
wave. This skill is the sequence and the sizing, not a second copy of those rules.

## Size it first

Sizing is a call you make and state in a line, not a question you ask the user. Read these signals:

- **Independently checkable pieces**: one, a handful, or many.
- **Surfaces crossed**: one module, or store plus CLI plus MCP plus UI plus hooks plus docs.
- **Reversibility**: a schema, migration, on-disk format, wire format, or public API is expensive to
  undo. Internal helpers are not.
- **Is the approach contested?** More than one defensible architecture, with real trade-offs between
  them, is the single strongest reason to run a design panel.
- **Blast radius**: does existing behavior change for people already using this?
- **Stakes**: data loss, auth, money, the release path itself.

Three sizes, and what each dial does at each:

| Dial | One ticket | One wave | Multi-wave |
| --- | --- | --- | --- |
| Recon | inline `Read`/`Grep`/`Explore` | plus one exploration ticket when the seam is unclear | 2-3 parallel exploration tickets on distinct angles |
| Questions | none, state assumptions | one batched round if a contract-changing call exists | one batched round, expect a real decision |
| Design | write the contract yourself | one planning or spike ticket when the approach is open | 2-3 competing proposals, judged and merged into one contract |
| Backlog | one ticket, no story | story plus the wave's full backlog | story plus the full backlog for every wave, dependency-linked |
| Execution | one executor | one parallel wave | wave after wave, re-planned between |
| Review | the done-oracle | oracle plus one `review-audit` when the oracle is thin | a review panel with distinct lenses, by default |
| Integration | integrate and close | integrate the wave, full suite once | integrate per wave, full suite per wave, decisions logged between |

Escalate mid-flight when evidence says so. A spike that comes back reporting the seam is worse than
expected raises the size; write that in the story log so the jump is on the record and not a vibe.
De-escalating is equally fine: if the panel converges on one obvious answer, stop paying for the
panel.

## Planning checkpoint

Before dispatching a substantial or ambiguous feature, put one visible, pinned contract on the story,
a planning ticket, or the ticket descriptions. It is the handoff from planning to execution, not a
second design process. Pin:

- **Outcome and explicit non-goals**, so later work has a boundary to cut against.
- **Smallest authority**, the source of truth or existing seam that decides behavior. Prefer deleting
  competing ambiguous authorities or fallbacks over another heuristic layer.
- **Surgical boundaries**, the files each piece may change and every public surface it may expose or
  deliberately leave alone.
- **A bounded executable done-oracle per piece**, the behavior it observes, and the named consumer or
  regression input that would fail if the piece were wrong.
- **Review budget**, from the sizing table, including the exact reason an oracle alone is enough or the
  lens a review ticket must cover.
- **Design-reopen evidence**, concrete findings that would invalidate the contract, such as a consumer
  that cannot use the pinned seam, a required compatibility break, or an oracle that cannot observe the
  claimed outcome.

Exact small work keeps its lightweight path: state the outcome and oracle and dispatch one ticket. A
pinned contract does not earn proposal theater. Write one authored contract for settled work; use two
or three bounded proposals only when the approach is genuinely contested.

## The shape

1. Frame the outcome, check this flow applies, and state the size.
2. Recon, bounded, at the depth the size calls for.
3. One question round, or none.
4. Design: write the contract, or run a panel and merge the winner.
5. Story plus the complete backlog for every planned wave, filed before anything dispatches.
6. Dispatch each ready wave in full, go quiet, re-plan between waves.
7. Review at the sized depth, integrate by oracle, publish, close out.

Track these with the task tools so the user can see where the feature is.

---

## 1. Frame it

Say back the outcome in a line or two, name the surfaces it touches, and state the size with the
signal that drove it ("multi-wave: this changes the on-disk format, so the migration has to land
before anything reads it"). That framing is what every later step is cut against, so a vague frame
produces vague tickets.

Drop out of this flow when it does not fit, and say so plainly:

- Operational asks (run the build, start the dev server, open the dashboard, answer from what is
  already on screen): just do them.
- A trivial edit to one or two files the user named, with no investigation: edit inline.
- A single bug with a known cause: that is one ticket, not a user-story flow.

## 2. Recon, bounded

Recon answers exactly one question: **what does the contract need to say?** Stop the moment you can
write the shared interfaces, the file boundaries, and a verify command per piece.

In the orchestrator, allow yourself `Read`, `Glob`, `Grep` on named anchors, plus native `Explore` for
a fan-out sweep when you do not know where something lives. Anything deeper goes to executors: file
`codebase-exploration` tickets, `readonly: true`, one per distinct angle, all in parallel. At
multi-wave size the angles that earn their keep are the closest existing feature traced end to end,
the extension point and who else depends on it, and the convention plus test pattern to match.

Give an exploration ticket a deliverable, not a topic. It should come back with anchors as
`file:line`, the seam to extend, the convention to copy, the existing verify command, and the
consumers that would break. Findings return as compressed comments of roughly one to two thousand
tokens.

Then build the contract from those findings. Do not go read every file they named. That habit is what
makes the expensive loop expensive, and it buys nothing the finding did not already carry. When a
finding is too thin to write a contract from, the fix is a sharper deliverable on the next exploration
ticket, not the orchestrator crawling the tree itself.

## 3. One question round, or none

Collect every genuinely contract-changing ambiguity and ask them together in a single
`AskUserQuestion` (up to four). Ask only when the answer changes user-visible behavior,
compatibility, migration, public API, dependencies, or expensive-to-reverse scope. One round respects
the user's attention and gets better answers, because they see the whole shape of the decision at once.
Asking one question per ambiguity trains them to stop reading.

Worth asking: a user-visible behavior with two defensible answers, a scope boundary that changes how
much gets built, a compatibility break, a data migration, anything else expensive to reverse.

Not worth asking: naming, file layout, test placement, error copy, ordering, and every other call you
can make and change later. State the assumption in the contract and keep going. Explicit phrases such
as "do your thing", "use your judgment", or "whatever you think" delegate the current feature: pick,
record the pick, and move on. They do not create a durable standing preference.

This is where the generic flow is deliberately narrowed. It waits for answers before designing;
Sidequest defaults autonomous, because a stalled feature costs the user more than a decision they can
correct at review.

## 4. Design: contract, or a panel

The output of this step is always the same artifact: **one contract**. What changes with size is how
much you spend arriving at it.

**When the approach is settled**, write it. Three proposals for a foregone conclusion is three tickets
of cost for an answer you already had.

**When the approach is genuinely contested** and hard to reverse, run a design panel. Two or three
`spike-investigation` tickets, `readonly: true`, same problem, deliberately different mandates:

- **Smallest change**: maximum reuse of what already exists, least new surface.
- **Cleanest seams**: what you would build if this area took three more features after this one.
- **Risk-first**: what breaks, what is hard to reverse, what the migration and rollback actually cost.

They run in parallel, on category-appropriate models, with a bounded deliverable: the seam it
introduces, the signatures it pins, file boundaries per piece, what it costs, and what it forecloses.
Cap each proposal at roughly two thousand tokens. Three uncapped design docs landing in the
orchestrator's context is the failure mode the panel is supposed to avoid.

Then do the one thing the expensive model is uniquely good at: **judge the plans and merge them.**
Pick a spine, graft the parts of the runners-up that are better than the winner's version, and write
one contract out of the result. A panel whose output is "we went with proposal B" wasted the other
two; the point is that the merged contract beats every individual proposal. Record in the story log
why the losers lost, because the next session will otherwise re-propose them.

Whatever the route, a contract that makes fan-out safe pins:

- **Shared surface**: the types, interfaces, and function signatures pieces hand each other, written
  out. This is the whole reason parallel executors compose instead of producing five conflicting
  interpretations of the same seam.
- **File boundaries per piece**, the blast radius each piece may touch, and any committed build output. Content-hashed output gets one rebuild ticket per wave.
- **Dependency order**, so `ready` partitions the backlog into waves by itself.
- **The exact scoped verify command per piece**, runnable and deterministic. The integrator runs the full merged-tree gate once per wave.
- **Shared runtime resources**: fixed ports, servers, databases, fixture paths. Worktrees isolate
  files, not runtime, so two tickets sharing a port serialize even inside one wave.

Present the chosen approach and its main trade-off in a few lines. Ask for approval only when the
choice is expensive to reverse: a schema or migration, a public API, a user-visible default, a new
dependency. Otherwise state what you picked and proceed.

Cannot pin the contract at all? That is a real answer, and it means one ticket and one executor, not
inline work. Claiming it needs either a completed planning ticket that names the interface that
resisted, or no written contract surface in the request. "Feels coupled" is a reason to file planning
first.

## 5. Story plus the whole backlog

One ticket and one executor covers small coherent work, and work whose contract only becomes knowable
by doing it. No story needed. This never means the orchestrator implements it.

Everything larger gets a story, the contract pinned on it, and **every ticket for every planned wave
filed under it before the first dispatch**: category from the live taxonomy, file scope, anchors,
exact scoped verify, and `depends-on` links. Never hand-pick a model or effort.

Filing the whole thing up front is what makes the plan steerable. The user sees the entire feature on
the board and can cut, reorder, or reshape it while that is still cheap. Drip-filing one ticket,
dispatching, waiting, then filing the next hides the plan and serializes work that had no reason to be
serial.

At multi-wave size the shape that usually works:

- **Wave 1 pins the shared surface in code**: the types, the schema and its migration, the seam
  itself. Once this is real, wave 2 physically cannot diverge from it.
- **Wave 2 is the wide parallel wave**: every independent piece built against that surface.
- **Wave 3 is the work that can only exist once the pieces do**: end-to-end tests, UI wiring, the
  performance pass, the docs.

You do not declare those waves anywhere. Dependency links make them, and `ready` hands you each one.

Each description is a developer-to-developer spec: anchors, behavior and edge cases, bounds, decisions
already made, the reproduction if it is a bug, and the verify command. Front-load evidence, because
cheaper executors cannot recover context you left out.

A feature almost always has a docs piece. Any change to what a user sees or does either updates the
affected prose page inside the story or gets a linked `docs-writing` ticket. Decide that here, while
the backlog is being written, not at ship time.

Flag the tickets that deserve `highStakes: true` now: data loss, auth, money, the release path, an
irreversible migration. That flag is what pulls deeper verification and a required review pass into
the ticket instead of relying on you to remember at the end.

## 6. Run the waves

Fresh `dispatch <ref>` per ticket, every spawn field passed through unchanged, all of it in one
message so the wave actually runs in parallel. Dispatch everything whose dependencies are met.
Same-file overlap across isolated worktrees deserves a look, not automatic serialization.

Then stop touching it. No pulses, no comment reads, no worktree peeks between dispatch and submission.
Each peek costs a full-context turn at the top model rate and returns nothing you can act on, since a
half-finished executor's state is not a decision point. Executors report on their own, and
`changes --since` is the read when you do need one. Steer instead of restarting: answer scope
requests, use `SendMessage` for what a message can fix, and never stop-then-redispatch work that is
still moving.

**Between waves is where re-planning belongs.** Close the wave (every ticket integrated or explicitly
deferred), read the story log for what the wave learned, then promote each finding needed by the next
executor into that ticket's description, dependency contract, comment, or the story execution contract
before dispatching it. The story log is orchestrator planning history, never executor orientation. Adjust
the next wave's tickets after that promotion. That is legitimate precisely because those tickets already
exist and the user could see them; it is the opposite of inventing the plan one ticket at a time. New
discoveries become normal tickets, linked into the wave they belong to.

A wave that straggles on one ticket while you sit idle is a sizing error, not a reason to poke it.
Note it, and cut thinner slices next time.

## 7. Review at the sized depth, then integrate

The floor is always the same: read the submission report, deliver the range, and run the merged-tree
full gate once for the wave. On green, finish the publish transaction under the publish lock.

How much review sits on top of that floor scales with the work:

- **One ticket, deterministic oracle**: the oracle is the review. Adding a review pass to a passing
  deterministic verify buys nothing.
- **One wave**: one `review-audit` ticket when the oracle is thin, when the change touches consumers
  the wave did not test, or when a piece came back looking different from its contract.
- **Multi-wave, or anything high-stakes**: a review panel is the default, not an upgrade. Parallel
  `review-audit` tickets with deliberately distinct lenses, so they do not all find the same thing:
  correctness and regression on existing consumers; **contract conformance**, meaning did the wave
  actually build the surface the story pinned; security and data integrity; performance and resource
  use; convention plus public-surface and docs accuracy.

Give reviewers an adversarial mandate: try to break it, name the failing input or the broken consumer,
and default to "not proven" when uncertain. A verdict of "looks good" with no evidence is not a review
pass, and treating it as one is worse than not having run it. Review verifies the pinned contract and
its oracle, never silently expands the active feature. Route unrelated concerns into separately
prioritized tickets; they block this ship only when the contract or a proven regression requires it.
Findings that do block ship become fix tickets, and their verdicts land as comments starting
`reviewed-by:`.

After two independently rejected candidates in one defect chain, stop local patching. Re-plan, narrow
the contract, or replace the authority or architecture before another candidate. Involve the user when
the current feature was not delegated.

Through all of it, do not reopen the diff yourself. Judging code you did not write, on the priciest
model in the loop, is slower and less reliable than the verify command the ticket already carried and
the reviewer whose whole job it was. You judge plans and route fixes.

## Close out

- **Docs**: the prose page updated, or the linked docs ticket on the board. A user-facing change with
  no docs ticket is not done.
- **Decisions**: log the contract calls, the rejected proposals and why, and the assumptions you made
  without asking, on the story, so the next session inherits the reasoning instead of re-deriving it.
- **A short report**: what shipped, the refs, the decisions that matter, and anything deferred with
  the reason.

---

## Coming from a generic feature-dev flow

Same beats, different owner for each, and every one of them sized:

| Generic flow | Here |
| --- | --- |
| Parallel explorer agents reporting into main context | `codebase-exploration` tickets returning compressed findings |
| Orchestrator reads every file the explorers named | contract written from the findings |
| Ask, then wait, per ambiguity | one batched round for contract-changing calls only |
| Three architect agents, always, then pick one | a panel when the approach is contested, and the winner gets merged with the runners-up |
| Orchestrator implements the chosen design | story, full backlog, one or many parallel waves |
| Three reviewer agents on the finished diff, always | oracle at the floor, a lens-partitioned `review-audit` panel where the risk earns it |
| Summary | integrate per wave, publish, docs, story decisions, report |

## Failure modes worth naming

- **"I already have the context, I'll just write it."** The cheapest-looking move in the moment and
  the most expensive over the feature. Loaded context is not a reason to inline.
- **One size for everything.** A panel and a five-lens review on a new flag is theater; the oracle
  alone on a format migration is negligence. Both are the same mistake.
- **A panel that picks a winner and discards the rest.** Merge, or do not run the panel.
- **Reading the whole subsystem before filing anything.** Recon has a stopping condition: the contract
  is writable.
- **A backlog that grows one ticket at a time.** Nobody can steer a plan they cannot see.
- **Polling.** Pulses, worktree peeks, or a shell loop waiting on an executor. Reports arrive on their
  own.
- **Re-reviewing the wave's diffs yourself.** That is what the verify command and the review panel are
  for.
- **Shipping without the docs decision.** Cheap while the backlog is open, annoying at ship time.
