---
name: user-story
description: >-
  Take a feature or a reported problem from request to integrated work with the engineer in the loop:
  investigate, reproduce a problem, lay out the options, agree the approach with the user, then plan
  and dispatch. A story or wave needs 3+ independently checkable pieces and a stated reason. Bounded
  fixes default to one owner; small fixes in a few known files may run inline without tickets.
  Read-only investigations need no ticket: prefer the route_recipe research spawn over native Explore.
---

# user-story

A guided path from "build me X" or "this is broken" to integrated, verified work on `main`. Three
ideas run through all of it:

**The engineer decides what gets built and how it is shaped.** This flow is for software engineers
who own their code and will have to explain every line of the diff. Before anything is built they see
what you found, with `file:line` anchors, the options that exist and what each one costs, and they
choose. Nothing is implemented from the request alone. Once they have agreed the plan, execution is
yours: dispatch, merge, verify and ship without asking for a go-ahead again.

**The orchestrator holds the plan; executors hold implementation.** Before dispatch, the orchestrator decides
what improvement is worth making, its concrete benefit, the approach, and boundaries. Researchers return facts
and bounded alternatives for that judgment. Executors use ordinary local coding judgment to implement the
selected plan, then return concrete evidence when it cannot work. They do not silently replace the agenda,
architecture, or scope.

**The ceremony scales to the evidence.** A deterministic done-oracle is enough when it covers the
contract. Add independent review only for a named untested seam or safety-sensitive risk.

Board mechanics live in the `sidequest` skill (claim lifecycle, dispatch fields, routing, publish
transaction) and its `references/`. Read `../sidequest/references/orchestration.md` before a first
wave. This skill is the sequence and the sizing, not a second copy of those rules.

## Size it first

Sizing is a call you make and state in a line, not a question you ask the user. They can overrule it
in a word. Read these signals:

- **Independently checkable pieces**: one, a handful, or many.
- **Surfaces crossed**: one module, or store plus CLI plus MCP plus UI plus hooks plus docs.
- **Reversibility**: a schema, migration, on-disk format, wire format, or public API is expensive to
  undo. Internal helpers are not.
- **Is the approach contested?** More than one defensible architecture, with real trade-offs between
  them, is the single strongest reason to run a design panel.
- **Blast radius**: does existing behavior change for people already using this?
- **Stakes**: data loss, auth, money, the release path itself.

A bounded fix defaults to one owner and a focused check. Small fixes in a few files at known locations may run inline without tickets. Read-only investigations need no ticket: on a routed project spawn `route_recipe(category).research` so they run on the category route; native Explore or general-purpose agents stay for tiny lookups or unrouted projects. A story or wave needs 3+ independently checkable pieces and a stated reason. A review panel needs a named risk for each lens.

Three sizes, and what each dial does at each:

| Dial | One ticket | One wave | Multi-wave |
| --- | --- | --- | --- |
| Recon | inline `Read`/`Grep`/`Explore` | plus one exploration ticket when the seam is unclear | 2-3 parallel exploration tickets on distinct angles |
| Reproduction | a reported problem fails on demand before any fix is designed | the same, per defect | the same, per defect |
| Options | the fix and the one alternative worth naming | 2-3 approaches written from recon | a design panel when the approach is contested and hard to reverse |
| Discussion | one line to confirm the approach when there is a real choice; none for an exact fix | findings and options walked through with the user until the approach is agreed | the same, plus sign-off on the contract before any ticket is filed |
| Design | write the contract yourself | the agreed approach written as one contract | the agreed proposals judged and merged into one contract |
| Backlog | one ticket, no story | story plus the wave's full backlog | story plus the full backlog for every wave, dependency-linked |
| Execution | one executor | one parallel wave | wave after wave, re-planned between |
| Review | the done-oracle | a `review-audit` only for a named untested seam | a `review-audit` only where the contract names a seam it cannot test |
| Integration | integrate and close | integrate the wave, one combined full gate | integrate per wave, one combined full gate per wave, decisions logged between |

Escalate mid-flight when evidence says so. A spike that comes back reporting the seam is worse than
expected raises the size; write that in the story log so the jump is on the record and not a vibe.
De-escalating is equally fine: if the panel converges on one obvious answer, stop paying for the
panel.

### Fan-out investigations

When the work is "gather evidence from several sources, then conclude", split by source: one `research.evidence` ticket per source, each saving what it finds under the story evidence root, plus one dependent synthesis ticket that reads the parents' evidence (the briefing's `Parent evidence:` section, where present, and the story evidence root) and writes the conclusion. The evidence tickets run in parallel, close with `done` (no commit), and checkpoint with a cursor if they hit budget, so a redispatch resumes instead of restarting. Children dedupe by sha256 against a `manifest.sha256.json` kept in the story evidence root (a convention the tickets follow, not a store table); the synthesis ticket treats the manifest as the authority on what was saved.

Prefer this over plain Agent spawns for any run that must leave files behind or may hit budget. A plain research spawn from `route_recipe` stays right for a lookup whose whole answer fits in the reply. External data that belongs outside the repository needs a path in `board_config investigationDataRoots` first. Details: `references/orchestration.md`, Investigations.

## Planning checkpoint

Before dispatching a substantial or ambiguous feature, put one visible, pinned contract on the story,
a planning ticket, or the ticket descriptions. It is the handoff from planning to execution, not a
second design process. For substantial or safety-sensitive work, first check architecture and feasibility
before expensive implementation or tests: use the preflight in
`../sidequest/references/ticket-authoring.md`. Consume evidence from the project's configured quality gate, if any, through its dedicated owner,
check genuine native baseline/candidate ownership and the oracle's real deadline/resource fit. Small
deterministic fixes keep one owner and a focused check; no mandatory planning panel. Pin:

- **Outcome and explicit non-goals**, so later work has a boundary to cut against.
- **Smallest authority and intervention**, the actual call flow and source of truth that decide behavior.
  Question whether a change is needed; reuse local code, stdlib, native features, or installed dependencies;
  make one minimal shared-root fix. Prefer measured deletion over hypothetical guards, forced extractions,
  and unrelated cleanup. Preserve validation at trust boundaries, data-loss prevention, accessibility,
  permissions, and immutable candidate/review authority.
- **Surgical boundaries**, the files each piece may change and every public surface it may expose or
  deliberately leave alone.
- **A bounded executable done-oracle per piece**, the behavior it observes, and the named consumer or
  regression input that would fail if the piece were wrong.
- **Review budget**, from the sizing table, including the exact reason an oracle alone is enough or the
  lens a review ticket must cover.
- **Design-reopen evidence**, concrete findings that would invalidate the contract, such as a consumer
  that cannot use the pinned seam, a required compatibility break, or an oracle that cannot observe the
  claimed outcome.

Exact small work keeps one owner: state the outcome and oracle, then work inline when bounded to a few known files. A
pinned contract does not earn proposal theater. Write one authored contract for settled work; use two
or three bounded proposals only when the approach is genuinely contested.

## The shape

1. Frame the outcome, check this flow applies, and state the size.
2. Investigate: list the unknowns, then recon. Sub-agents resolve what the code can answer.
3. Reproduce a reported problem before anyone designs a fix for it.
4. Lay out the options: what could be done, where in the code, and what each one costs.
5. Discuss it with the user until the approach is agreed. Their decisions, your recommendations.
6. Write the agreed approach as one contract, play it back, and get a yes.
7. Story plus the complete backlog for every planned wave, filed before anything dispatches.
8. Dispatch each ready wave in full, keep routine supervision quiet, allow declared live advice, and re-plan between waves.
9. Review at the sized depth, integrate by oracle, publish, close out.

Steps 2 to 6 are the conversation. Nothing is filed or built until step 6 ends in a yes. Steps 7 to 9
are execution, and they never go back to the user for a go-ahead: only for a decision the agreed plan
did not cover.

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
- A small bounded fix in a few known files: edit inline and run a focused check.
- A single bug with a known cause: reproduce it first (step 3), then keep one owner, inline when it
  fits the bounded path.

## 2. Investigate: unknowns first, then recon, bounded

Before any reading, write down what the request leaves unclear: the outcome itself, which existing
behavior it replaces, who consumes the result, what "done" looks like, and anything the user said in a
way that has two readings. Then sort each unknown by who can answer it. The codebase, the git history,
or an external source answers most of them; only the user answers the rest. That sort decides the next
steps that follow: unknowns the code can answer become exploration tickets, and unknowns only the
user can answer go into the discussion in step 5. Do not guess at either kind and call the guess a contract.

Recon answers exactly one question: **what does the contract need to say?** Stop the moment you can
write the shared interfaces, the file boundaries, and a verify command per piece.

Launch one read-only sub-agent per code-answerable unknown, in parallel, and let them run while you
write the contract skeleton. In the orchestrator, bounded recon may `Read`, `Glob`, or `Grep` named anchors and make one narrow location sweep. Route unfamiliar path tracing, deep investigation, or multi-angle research through the live taxonomy: use a read-only `codebase-exploration` ticket for repository behavior, `source-lookup` for a bounded external question, or `evidence-research` when sources need reconciliation. Give each ticket one distinct angle and run independent investigations in parallel. At
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

## 3. Reproduce a reported problem

When the request is "this is broken", make it fail on demand before anyone designs a fix. A fix for a
problem nobody reproduced is a guess, and its test proves nothing.

You orchestrate this step. A reproduction or measurement that takes more than one command you already
know goes to a routed executor: a `debugging` ticket, or the `route_recipe` research spawn when it only
reads. Tell the user what is running and on which model, and show what came back.

- Find the shortest command, test or input that shows the failure, and run it. Keep the exact
  command and what it printed.
- Say what you observed against what was expected, and where the two part ways: the function and
  line where the wrong value is first produced, when recon can name it.
- If it does not reproduce, stop and say so with what you tried. Ask the user for the missing
  condition (version, data, environment, steps). Never design around a failure you could not see.
- The reproduction becomes the regression check: it goes into the ticket as the thing that fails
  before the change and passes after it.

A feature request skips this step. A change to existing behavior does the nearest equivalent: show
the current behavior first, so the discussion is about something everyone can see.

## 4. Options: what could be done

Before the user is asked to choose, they need something real to choose between. For anything with a
design choice, write down the approaches that would work. Two or three is usual. One is honest when
the fix is exact, and then say why there is no second.

For each option:

- **Where**: the files and functions it touches, as `file:line` anchors from recon.
- **What changes**: the mechanism, in the terms the code already uses. An engineer should be able to
  picture the diff.
- **Why it works**: the cause it removes or the seam it extends, tied to the reproduction or the
  finding that supports it.
- **Cost and risk**: what it forecloses, what existing behavior shifts for people already using
  this, what is hard to reverse, how it would be tested.

Then give your recommendation and the reason, and name the option you would reject first and why.
Also say plainly when the evidence suggests the request should change: it contradicts how the code
works, it is larger than the problem needs, or a cheaper route exists (an existing feature, a smaller
change, nothing at all). Raise that here, before the discussion, so the user reacts to it.

**When the approach is settled**, one option with its reason is the whole step. Three proposals for a
foregone conclusion is three tickets of cost for an answer you already had.

**When the approach is genuinely contested** and hard to reverse, run a design panel. Two or three
`spike-investigation` tickets, `readonly: true`, same problem, deliberately different mandates:

- **Smallest change**: maximum reuse of what already exists, least new surface.
- **Cleanest seams**: what you would build if this area took three more features after this one.
- **Risk-first**: what breaks, what is hard to reverse, what the migration and rollback actually cost.

They run in parallel, on category-appropriate routes, with a bounded deliverable: the seam it
introduces, the signatures it pins, file boundaries per piece, what it costs, and what it forecloses.
Cap each proposal at roughly two thousand tokens. Three uncapped design docs landing in the
orchestrator's context is the failure mode the panel is supposed to avoid.

Then do the orchestrator's planning work: **judge the plans and merge them** into the option you
recommend in the discussion. Pick a spine, graft the parts of the runners-up that are better than the
winner's version, and bring that merged proposal to the user beside the alternatives it came from. A
panel whose output is "we went with proposal B" wasted the other two; the point is that the merged
proposal beats every individual one. Record in the story log why the losers lost, because the next
session will otherwise re-propose them.

## 5. Discuss it with the user

This is the step the rest of the flow is cut against. Walk the user through what you found and the
options, then work through the decisions with them until the approach is agreed.

Open with a short brief they can check against their own knowledge of the code: what exists today
(anchors), the reproduction if there is one, the options, your recommendation. Then ask.

- **Facts are your job, decisions are theirs.** Anything the code, the history or a source can
  answer, you look up, with a read-only sub-agent where it helps. Never ask the user for something
  you could find. Never record your own conclusion as their decision.
- **Ask in rounds.** Put every decision whose prerequisites are settled into one round. A question
  that depends on an answer still open waits for the next round. Keep going until nothing is left
  that would change what gets built: there is no fixed number of rounds or questions.
- **Every question carries what you found and your recommended answer**, worded so "yes" accepts it.
  Closed choices with a clear default go through `AskUserQuestion`, recommended option first. Open
  questions (how should this behave, what did you mean by X) go out as a short numbered list the user
  answers in their own words.
- **Ask about what gets built and how it is shaped**: user-visible behavior, the approach where
  options differ, scope boundaries, compatibility, migration, public API, dependencies, anything
  expensive to reverse, and any part of the request two careful readers would build differently.
- **Do not ask about** naming, file layout, test placement, error copy or ordering. Make those calls,
  state them in the contract, and let the user object there.
- **Never ask for a go-ahead.** "Shall I proceed", "which should I start with" and "is it OK to
  dispatch" are not decisions. Once the plan is agreed in step 6 the answer is always yes.

If the engineer wants to go deeper (why this function, what calls it, what breaks if it moves),
that is the point of the step: answer from the code, with anchors, and let the answer change the
plan.

Explicit phrases such as "do your thing", "use your judgment", or "whatever you think" delegate the
current feature: take your recommended answer for everything still open, record each as decided by
default, and move on. They do not create a durable standing preference.

For story-sized work, an independent intake review (`../sidequest/references/intake.md`) can run
before the first round to strike questions the evidence already answers. It is a filter on your
draft, never a substitute for the discussion.

## 6. The contract, played back

The output of the discussion is always the same artifact: **one contract**, written from what the
user agreed. What changes with size is how much you spent arriving at it.

Whatever the route, a contract that makes fan-out safe pins:

- **Shared surface**: the types, interfaces, and function signatures pieces hand each other, written
  out. This is the whole reason parallel executors compose instead of producing five conflicting
  interpretations of the same seam.
- **File boundaries per piece**, the blast radius each piece may touch, and any committed build output. Content-hashed output gets one rebuild ticket per wave.
- **Dependency order**, so `ready` partitions the backlog into waves by itself.
- **The exact scoped verify command per piece**, runnable and deterministic. The integrator runs the full merged-tree gate once per wave.
- **Shared runtime resources**: fixed ports, servers, databases, fixture paths. Worktrees isolate
  files, not runtime. Name the shared resource and current holder; serialize commands using it,
  not entire tickets. Non-owners continue independent read/edit/commit work, record readiness, and
  end the turn retaining their claim until the parent explicitly hands off. Heavy commands use
  at most two workers, finite owned deadlines, and descendant cleanup, within the two-core heavy budget.

Play the contract back before anything is filed: the outcome and non-goals, what changes where and
why (the agreed option, with its anchors), how each piece will be verified, and every assumption you
made without asking. Keep it short enough to read in a minute. Get an explicit yes. A correction
goes back into the contract, and the changed part is played back again.

That yes is the last approval this feature needs. From here, do not ask whether to file, dispatch,
merge or publish. Come back to the user only for a decision the agreed contract did not cover, or
when evidence invalidates it (the design-reopen evidence pinned above).

Read-only native agents can resolve unclear call flows without tickets. Keep one owner once the bounded fix is clear. Use investigation tickets when routed execution or durable board tracking is useful.

## 7. Story plus the whole backlog

One owner covers a bounded fix. Inline work is allowed for small fixes in a few known files. A story or wave requires 3+ independently checkable pieces and a stated reason. For that admitted wave, pin the contract and every planned ticket under the story before the first dispatch: category from the live taxonomy, file scope, anchors,
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
already made, the reproduction if it is a bug, and the verify command. Front-load evidence so the executor
starts from the selected plan rather than re-deciding it.

A feature almost always has a docs piece. Any change to what a user sees or does either updates the
affected prose page inside the story or gets a linked ticket classified from the live taxonomy. Decide
that here, while the backlog is being written, not at ship time.

Flag the tickets that deserve `highStakes: true` now: data loss, auth, money, the release path, an
irreversible migration. That flag is what pulls deeper verification and a required review pass into
the ticket instead of relying on you to remember at the end.

Size implementation plus final verification to fit comfortably before 75 tool rounds; otherwise
split along actual cohesive boundaries before dispatch. A resource pause does not automatically
release/restart an executor or prove death.

## 8. Run the waves

Fresh `dispatch <ref>` per ticket, every spawn field passed through unchanged, all of it in one
message so the wave actually runs in parallel. Dispatch everything whose dependencies are met.
Same-file overlap across isolated worktrees deserves a look, not automatic serialization.

Then leave routine supervision quiet: no pulses, comment reads or arbitrary worktree peeks between
dispatch and submission. Explicitly assigned builders and readonly advisors may collaborate directly
through available native messaging and inspect authorized source snapshots under
`../sidequest/references/readonly-guidance.md`. Advice stays advisory; final `review-audit` acceptance
still binds the terminal immutable submission. Preauthorize ordinary implementation/check/measurement
steps within the contract, with one producer owning capture and submit. Pause only the blocked step;
continue unaffected source work. Relay real scope/resource/authority decisions, not routine checkpoint
or acknowledgement loops. Executors report on their own, and `changes --since` is the read when needed.
Steer instead of restarting: answer scope
requests, use `SendMessage` for what a message can fix, and never stop-then-redispatch work that is
still moving. For resource transfers, require the actual owner's acknowledgement that its owned
heavy command and descendants ended, then a parent `SendMessage` naming the next holder. A terminal
submit/done/release suffices when it really ends owned work; an authenticated explicit mid-claim
return is valid too. Never infer availability from elapsed time, process counts, failed sends,
model labels, or absence.

Comment `since` is exclusive and only a read cursor. Include the exact instruction/comment in a
handoff or direct bounded inclusive/all-comments recovery; advance the processed cursor only after
consuming instructions, not merely observing a watermark.

When a confirmed blocker falls within the user's delegated work, dispatch its existing ticket once
ready. If preparation is needed, start that preparation rather than ending with a status report. If
blocked, record the concrete dependency, responsible owner, and condition for resuming. Unrelated CI
or review is not a dependency. Acknowledging a report or raising its priority does not transfer
ownership. Preserve permission boundaries and required review throughout.

**Between waves is where re-planning belongs.** Close the wave (every ticket integrated or explicitly
deferred), read the story log for what the wave learned, then promote each finding needed by the next
executor into that ticket's description, dependency contract, comment, or the story execution contract
before dispatching it. The story log is orchestrator planning history, never executor orientation. It
automatically archives older entries when its live briefing window fills; use `full: true` to read that
archive with the live log. Adjust the next wave's tickets after that promotion. That is legitimate
precisely because those tickets already exist and the user could see them; it is the opposite of
inventing the plan one ticket at a time. New discoveries become normal tickets, linked into the wave
they belong to.

A wave that straggles on one ticket while you sit idle is a sizing error, not a reason to poke it.
Note it, and cut thinner slices next time.

## 9. Review at the sized depth, then integrate

The floor is always the same: read the submission report, deliver the range, and run the merged-tree
full gate once for the wave before versioning. Preserve the real pinned delivery verifier; reuse
assembled-tree proof only under the runtime's exact authority checks. A changed tree after rebase
needs a fresh gate. On green, finish the publish transaction under the publish lock.

How much review sits on top of that floor scales with the work:

- **One ticket, deterministic oracle**: the oracle is the review. Adding a review pass to a passing
  deterministic verify buys nothing.
- **Named uncertainty or safety-sensitive seam**: add a `review-audit` only when the done-oracle
  cannot exercise a stated seam, such as a consumer the wave did not test. The contract names the
  seam and the review mandate. A required high-stakes review also applies. Multiple lenses need
  distinct named risks, never merely multiple waves. Bind required candidate reviews before delivery
  and preserve the immutable candidate and source-review guards.

Give reviewers an adversarial mandate: try to break the named seam, identify the failing input or
broken consumer, and record evidence. Review verifies the pinned contract and its oracle, never silently
expands the active feature. Route unrelated concerns into separately prioritized tickets; they block this
ship only when the contract or a proven regression requires it. Findings that do block ship become fix
tickets, and their verdicts land as comments starting `reviewed-by:`.

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
- **A short report**: use `completion <ref|US-n> --text` output, plus decisions logged on the story. Do not re-describe the work by hand. Add what an engineer reviewing the change needs and the completion text does not carry: where the change landed (files and functions), why that shape, and what was not checked.

---

## Coming from a generic feature-dev flow

Same beats, different owner for each, and every one of them sized:

| Generic flow | Here |
| --- | --- |
| Parallel explorer agents reporting into main context | `codebase-exploration` tickets returning compressed findings |
| Orchestrator reads every file the explorers named | contract written from the findings |
| Ask, then wait, per ambiguity | findings and options first, then discussion rounds with a recommended answer on every question, until the approach is agreed |
| No reproduction step | a reported problem fails on demand before a fix is designed |
| Three architect agents, always, then pick one | options written from recon; a panel when the approach is contested, merged, and the user chooses |
| Orchestrator implements the chosen design | story, full backlog, one or many parallel waves |
| Three reviewer agents on the finished diff, always | done-oracle, plus a `review-audit` for a named untested seam |
| Summary | integrate per wave, publish, docs, story decisions, report |

## Failure modes worth naming

- **"I already have the context, I'll just write it."** The cheapest-looking move in the moment and
  the most expensive over the feature. Loaded context is not a reason to inline.
- **One size for everything.** A blanket review panel on a new flag is theater; an untested seam on a
  format migration needs named scrutiny. Both are the same mistake.
- **A panel that picks a winner and discards the rest.** Merge, or do not run the panel.
- **Reading the whole subsystem before filing anything.** Recon has a stopping condition: the contract
  is writable.
- **Building before the engineer agreed the approach.** A plan the user never saw is a wave of work
  they have to reverse-engineer at review. Findings, options, discussion, yes: then build.
- **Fixing a problem nobody reproduced.** The failing command comes first.
- **Asking for a go-ahead.** After the yes in step 6, "shall I proceed" is noise. Decisions only.
- **Guessing past an unclear request.** An unknown the code could have answered gets a sub-agent; one
  only the user can answer gets asked. Neither gets an assumption dressed up as a contract.
- **A backlog that grows one ticket at a time.** Nobody can steer a plan they cannot see.
- **Polling.** Pulses, worktree peeks, or a shell loop waiting on an executor. Reports arrive on their
  own.
- **Re-reviewing the wave's diffs yourself.** That is what the verify command and a contract-required
  review ticket are for.
- **Shipping without the docs decision.** Cheap while the backlog is open, annoying at ship time.
