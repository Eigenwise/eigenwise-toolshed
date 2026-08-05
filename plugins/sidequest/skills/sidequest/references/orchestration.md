# Orchestration: fan-out and agent teams

Read this when you're about to run more than a couple of executors at once or when agent teams is on. The baseline
delegation rule (gather enough evidence with read-only tools or native `Explore`, write precise tickets,
route implementation by default, batch small same-model tickets, and fan out over independent waves) lives
in the main skill — this file is the detail on the bigger shapes.

## Decomposition in depth

### Solo-fit gate before decomposition

Apply the inline-safe gate before solo-fit or ticket filing. A user-directed mechanical edit to one or two named files with stated content, including an exact one-line `.gitignore` entry, is inline work: edit it directly, do not file a ticket or spawn an executor.

Before filing several tickets, use solo-fit only to choose the dispatch shape. **SOLO-FIT picks
one-executor vs wave; it NEVER means you implement inline.** File **one ticket and dispatch one
executor** when the work is small and coherent enough for one executor to finish comfortably in one
context, or its contract cannot be pinned without doing the work. Keep that ticket whole when the work
must land and verify together.

When a written spec can pin shared types/interfaces, file boundaries, and per-piece verification, and
there are 3+ independently checkable pieces, prefer a contract-first fan-out: put the contract directly
in the ticket descriptions or create one short planning ticket, then dispatch one parallel wave to
category-appropriate cheaper models and integrate once per wave. With a written spec and executable
done-oracle, this is the presumptive default. Claiming the contract cannot be pinned requires either a
completed exploration/planning ticket that tried and names the specific interface resisting a written
contract, or a request with no written contract surface. “Feels coupled” is not evidence: when unsure,
file the short planning ticket first, then decide from its report. One ticket still equals one bounded,
independently checkable piece: a code change with a verify command, or an investigation, spike, or
review whose "done" is a concrete answer or artifact. Cut along real independent surfaces, not merely a
list of deliverables. Several named pieces can still be one feature with a shared contract; split them
only when they can progress and verify independently.

**Maximize the ready set.** Decompose to maximize the ready set: prefer cuts along disjoint surfaces so more tickets can dispatch together. A cut that forces a serial chain needs a stated reason. In isolated worktrees, same-file overlap alone is not a conflict. Serialize only when tickets change the same functions, constants, or regions; share a runtime resource; or semantically couple because one defines what another consumes. Otherwise dispatch them in parallel and resolve the rare merge conflict at integration.

After solo-fit chooses wave mode, file the complete planned backlog before dispatching: every planned
ticket for every wave, each with declared files, dependency links, and per-ticket verify. Then dispatch
the entire ready wave in parallel. Filing one ticket, dispatching, waiting, then filing the next
serializes work and hides the plan until the user cannot steer it. Later discoveries still become normal
mid-run tickets.

Wave mode files its complete backlog under a story. A planning investigation can pin shared decisions and
anchors before a wave starts. Put frozen orchestrator decisions, invariants, acceptance evidence, and
durable artifact links in the story execution contract once (`story contract US-n --body-file path` or
MCP `story_contract`) rather than repeating them in steering messages. The contract is capped at 4 KiB
and arrives before ticket scope in every member briefing. The `story log` is the executor-to-executor
channel for live cross-ticket discoveries; at integration, the orchestrator promotes durable entries into
the contract, then clears the log. If the contract changes after a member is claimed, `pulse`/`changes` and the next dispatch warn
about revision drift. This keeps context completeness cheap without the orchestrator rediscovering the
codebase inline.

When a package commits build output, the source ticket scopes its generated output too. For content-hashed output, assign exactly one rebuild ticket per wave: parallel rebuilds choose different filenames and collide at merge.

**The planning pass is for concrete scope, not ceremony.** Before filing a complexity-4+ ticket:
direct `Read`/`Glob`/`Grep` when the affected surfaces are obvious; when they are unfamiliar, a
proportional investigation ticket whose result pins the scope, executor anchors, and exact verify
command before implementation tickets are filed. For a wave ticket, make that verify command a
scoped test or reproduction for its declared files; reserve full-suite green for the integration or
ship ticket. Shrink until the complexity drops — a piece still scoring 7+ is usually a small design
ticket plus a mechanical application ticket.

**Spec completeness scales inversely with the executor's model.** Work routed to a cheap model
needs a near-patch-level spec — exact anchors, expected strings, precise verification commands —
because the spec substitutes for judgment. Everything you already know goes in the description: a
weaker executor fails on missing context, not on the work itself, so front-load what your
investigation found (paths, the surrounding contract, the gotcha you spotted). If finishing the
ticket would need context its description does not carry, gather it first and put what you learned
in the spec, or split it further.

**Non-repo deliverables need a durable rendezvous.** A report, analysis, or dataset must land on an agent-independent surface: the ticket comment thread when it fits the comment cap, a declared artifact root under the project (for example `.claude/.codebase-info`) for larger artifacts, or a user-named absolute path outside any session temp tree. Never pin a session scratchpad path in a ticket as the deliverable location or its verify command, because different agents resolve different scratchpad roots for the same project. Put the durable location and the exact verification step in the ticket before dispatch.

## Inline-safe direct work

Run this check before filing. Do the user-directed 1–2 named-file carve-out inline without creating a ticket; an exact one-line `.gitignore` entry is the canonical case. If a routed ticket already exists, direct work still records a 20+ character reason. Other inline work is limited to a failing integration gate that pinpoints a known small mechanical diff (strict-TS null guard, deliberate assertion-string sync, byte-checked golden regeneration, or merge-conflict resolution preserving both intents) or release bookkeeping (fragment, cut, or evidence closeout). `direct-ok` is optional user signal only, never a gate.

Route a ticket to an executor for work needing investigation or other-file reading to be confident,
new behavior or API surface, a failing test that does not pinpoint the location, or any rationale
like "context already loaded", "small change", or "faster myself". The blocked-step and never-inline
invariants still apply to substantive work.

## Acceptance evidence and audit gates

Set the acceptance boundary before splitting fixes:

- **Front-load adversarial evidence.** Before filing behavior patches, build and freeze the
  acceptance matrix or lifecycle-acceptance ticket that can reject the whole behavior. Do not run a
  patch chain before its benchmark exists, or split UI identity, teardown, resize, and reopen into
  separate tickets before one matrix covers the lifecycle.
- **Skip an audit wave when the done-oracle is deterministic.** If the ticket's executable
  acceptance commands or test suite pass, do not append a `review-audit` + fix wave by default.
  Audit when the work has no deterministic done-oracle or high-stakes flags demand independent
  scrutiny. A normal integration diff review still checks the combined change.
- **Keep one implementation ticket open through a required independent review.** Attach findings as
  comments on the open implementation claim and correct them there. Submit only after that required
  review is clean, rather than closing each narrow step and filing a follow-up fix chain.
- **Record stable facts once.** Put local-only git, artifact lifecycle, and frozen acceptance wording
  in the ticket or board record that owns them. Executors consume that source instead of receiving
  the same steering repeatedly.

When full-suite failures move between runs but each failing test passes alone, reproduce under load and inspect runner concurrency or shared resources. Do not add sleeps, retries, or looser assertions. Accept the runner fix only after several consecutive green runs.

### Live review checkpoints

Use a **live review checkpoint** when an implementation needs an independent review before submission:

1. The implementation executor verifies the candidate, then calls `checkpoint` with its commit or
   absolute worktree path, verification evidence, and the same `by` identity that holds the claim.
2. The board returns a checkpoint id, keeps the claim and dispatch active, and writes a durable
   `Live review checkpoint` comment. Link each review ticket to the implementation ticket. Review
   findings go on the implementation thread and name that checkpoint id.
3. A clean review lets the implementation executor submit. Findings resume the same named executor
   with `SendMessage`; it corrects, reverifies, and creates a new live review checkpoint for the new
   candidate. The healthy gated relay is implement → checkpoint → review → correct → submit.

A live review checkpoint lasts 60 minutes by default and accepts an explicit TTL from 1 minute to 24
hours. `pulse` and `changes` report `active`, `resumed`, `recoverable`, `expired`, `submitted`, or
`completed`. Expired evidence stays on the ticket but needs a fresh verification checkpoint before a
review gate can pass. If the executor is dead, salvage its commit or declared-scope diff, release the
claim, and redispatch. The stored checkpoint and its automatic comment survive that recovery, and the
replacement claim reports the checkpoint as `resumed` while its TTL is live.

Keep the two checkpoint names exact. A **live review checkpoint** uses the `checkpoint` operation and
holds the claim so the same executor remains addressable. A **Continuation checkpoint** is the
100-tool-round handoff: commit, comment, release to `todo`, then start a fresh executor with a fresh
dispatch. Only the continuation flow releases during a healthy handoff.

### Scope expansion without a bounce

When an executor needs an undeclared path, it calls `scope-request <ref> --file <path>` and pauses with
its claim intact. The request records only the uncovered additions and prints the authoritative
`sidequest update <ref> --files ...` approval command. Run that exact update to approve the full request,
then resume the same executor. A plain `update --files` is also authoritative only when its resulting scope
covers every pending requested path; otherwise Sidequest reports the request is still pending and prints the
full command. Scope lint still rejects out-of-scope commits and submissions. Do not release and redispatch a
healthy executor just to add a path.

## Fan-out mechanics

When several tickets are **ready and independent**, work them in parallel — one executor per ticket,
all spawned in a **single message** (true parallel). This is safe precisely because claiming is
atomic: each subagent claims a different ticket, and any race just sends the loser onward.

- **Never invent a worker name.** `dispatch` returns `spawn.name` already built from the board:
  ticket ref plus a short title slug (`sq-843-release-engine`), counting up on a relaunch
  (`-2`, `-3`) so a reworked or resumed launch never shadows a live sibling. That name is what shows
  in the fleet view (filter `a:<name>`) and what `SendMessage {to: name}` resumes, and the PreToolUse
  guard rewrites anything else back to it. Pass it through; the same goes for `spawn.description`,
  which leads with `<model>, <effort> ·` so the route stays visible in the agent list mid-run. The trailing model label the harness prints there is always `claude-codex-auto` for gateway routes and cannot be changed, so this description is the only place the real route shows.
  Every Agent launch must be a freshly dispatched Sidequest executor.
- **The `--by` id is separate and must be genuinely random per session** (not the ticket ref, not a
  fixed label): a second session fanning out over the same board would derive the identical value
  and silently coexist as the same worker. The launch name is board-derived and stable; the worker id
  is session-random.
- **One wave at a time.** `ready --json --brief` partitions the set into parallel-safe waves by declared file scope and named contract edges. MCP `ready` returns the same wave data with a count plus ref/title rows by default; use `full:true` only when a ticket record is needed. A ticket can declare free-form `produces`, `changes`, and `consumes` metadata for interfaces it touches; a produce/consume or change/change match sequences otherwise disjoint tickets. Read `waveDependencies` for the named reason before spawning. `contractWaiver:true` is an explicit reviewed override, so use it only after checking the real integration seam. Before spawning a wave, assess the runtime
  resources each ticket needs: fixed ports, domains, shared databases, existing servers, and files
  outside the declared scopes. Worktrees isolate files, not those resources. Serialize tickets that
  share one, and name the orchestrator/worker ownership before launch. Spawn wave 1, wait, re-run
  `ready`, repeat.
- **Workers record operational state on the board.** The orchestrator owns wave admission and shared-resource
  coordination; each worker owns its ticket. Its terminal submit or done comment says conflicts found,
  server lifecycle (started, reused, or stopped), files changed, blockers, cleanup performed, and
  verification output. Tickets with no declared scope never mechanically conflict, so eyeball whether
  they'd edit the same files before parallelizing them.
- **Integrate and verify by wave.** Each executor runs its scoped verification before submission.
  When the quiet wave lands, read each submit report, run each ticket's exact verify command, then run the
  full suite once for the combined wave. On green, integrate. The oracle is the review: never open source
  or inspect diffs to re-review executor work. When the stakes need human-grade review, dispatch a
  `review-audit` for the affected files; do not turn the orchestrator into the reviewer.
- **Executor prompts stay lean and cannot narrow the ticket**: add only the ref, worker id, claim/done commands, stamped effort/model, and logistics the ticket does not carry. The ticket contract is authoritative and must travel in full, unchanged scope. If the plan changed, update the ticket before dispatching. **Anti-pattern: dispatch narrower than ticket.** In Cantizans SQ-87, the ticket required extracting the done block across every lesson route and two commits, while the dispatch limited work to intervals as a reference. The executor bounced correctly, then the orchestrator had to re-plan. Never create that contradiction.
- **Read bounded briefing comments from the newest end.** A brief can carry a compact newest-first comment packet instead of the full thread. Read compact `comments` pages first, following their cursor only when needed. Read the full chronological thread only when the brief flags a decision or constraint in omitted history; otherwise the latest packet and compact pages carry the current handoff.
- **Resume Continuation checkpoints with a fresh dispatch.** Executors create a Continuation checkpoint around 100 tool rounds by committing verified declared-scope work, writing a `Continuation checkpoint` comment with the commit, files touched, next steps, and verification state, then releasing to `todo`. On a natural wakeup, use `pulse` and the latest comment to confirm that header, commit, and no live claim. Read the checkpoint before `dispatch <ref>`, then spawn its returned continuation unchanged so it gets a fresh token and context. A live claim means the checkpoint has not completed, so do not launch beside it; use the normal salvage path if that worker stopped.
- **Record wave links from board results.** Never write an `SQ-n` ref you did not read back from a board response. File related tickets first, collect their returned refs, then use `update` or, preferably, `link` (`blocks`, `depends-on`, or `related`) to record relationships. Links are board data, so they stay correct without prose cross-references.
- **Read liveness from the board, not notifications.** Notifications wake the orchestrator but do not prove executor state. An idle notification can describe a working, dead, or already-finished executor, so read board truth before acting: use `pulse <ref>` for the ticket's `{claim:{by,at,ageMs}|null, comments, lastComment, git:{commit,dirty}|null}` state. Until `pulse` is available, read claim age, comments, and `git log`. If several tickets need checking, use `changes --since <iso>` for the `{tickets:[...]}` delta, sorted oldest first.
- **Read completion from the board.** An executor stop notification wakes the orchestrator; its terminal
  submit or done state plus closing comment is the completion signal. Do not expect or request a routine
  `SendMessage` report. Read the board record for what changed, verification evidence, commit hash or
  close confirmation, and anything deliberately skipped. `SendMessage` remains for blockers,
  `kind=question` needs, scope conflicts, and failures the board cannot express.
- **Recover one dormant completion (SQ-715 findings comment).** A task-completed notification with no submission or terminal board state while its claim is live means the executor is dormant, not finished. `pulse`; if dispatch is still claimed and fresh, `SendMessage` the same named agent once to continue, keeping its claim and token. A second silent stop means dead: salvage, release, fresh-dispatch, then spawn one new executor. Never respawn beside a live claim or `TaskStop` without terminal board evidence.
- **Salvage before redispatch.** When a worker is dead or stopped, inspect its worktree before releasing or
  replacing it. If an isolated worker's recorded worktree is gone, do not `SendMessage` it: redispatch after
  reading the ticket instead, because a resumed agent must never fall back to the shared checkout. Preserve a
  verified commit, or recover the declared-scope diff, then read the ticket and its thread again before deciding
  whether a replacement is needed. Never overwrite stranded work by blindly redispatching. Use `sidequest worktrees sweep --dry-run` to review old executor worktrees; it only
  removes worktrees that are clean, at least three hours old, and whose commits are patch-equivalent to
  `origin/main`. Pass `--yes` only after reviewing the list. When a natural wakeup shows that an executor has no claim and no commit past the
  2–3 minute grace period, stop it, then diagnose before retrying: `pulse <ref>` and read the denial or
  terminal reason verbatim. Make ONE retry only when that diagnosis changes the dispatch; never blindly
  respawn the identical spec. When native Agent reports the exact supported Claude quota-limit signature before claim, the failure hook records that primary attempt
  and prepares the ticket's configured fallback with a fresh token. Run `dispatch` for the ref again, then
  spawn the returned fallback spec unchanged. Do not edit or detach the category: the recovered route is
  ticket-local, survives a session restart, and normal category policy resumes when that dispatch ends.
  Treat any other model-access or API error as generic. Surface it without guessing a fallback or retrying
  the route. Never message a dormant executor and spawn its replacement together: after its second silent stop,
  release first. Two failures on one
  dispatch are a user-visible failure: comment the ticket with the verbatim denial/terminal evidence, surface
  it, do not try a third spawn, and do not pull substantial work inline by default. Other `SendMessage` calls
  carry new information such as a scope change or unblock, never a "wake up" poke.
- **Recover partial reasoning from an infrastructure death.** When an executor dies mid-run on a transient
  infrastructure error, release its claim first. Then use the one diagnose-first respawn: pass the dead
  executor's last visible output to the replacement only as a lead to confirm or refute with its own evidence.
  Never pass partial reasoning as a conclusion to inherit. The replacement still owns its investigation and
  evidence; this recovery prevents a transient death from discarding a useful starting point.
- **Diagnose a 32 MB launch failure before recovering.** Claude Code uses `Request too large (max 32MB)` for an HTTP body-byte cap, but Model Gateway deliberately uses HTTP 413 `request_too_large` as its Codex context-compaction signal too. Read the underlying error details. `Prompt is too long for the Codex context window; compact and retry. (<actual> tokens > <trigger> tokens)` is the gateway's token-overflow signature, not inherited parent images or attachments. If a dispatched native Agent dies before its first model turn with that signature, do not compact the orchestrator or resume it. If it claimed the ticket, run `release --status todo` first, then dispatch one fresh executor with a tighter scope and briefing. It has its own briefing and history, so it does not inherit the parent request body. If that replacement hits the same signature, report the token counts and narrow the task again rather than blindly retrying. A genuine byte-cap rejection does not carry that token signature; follow Claude Code's body-size recovery there (`/compact`, Esc twice, or smaller attachments). The salvage rule above still governs any partial commit.
- **Use steerable background execution by default.** Executors are background teammates, so `TaskOutput`
  cannot resolve their names (`No task found`) and polling is banned regardless. When
  `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` is enabled, the teammate shape IS how executors run — treat it
  as the required dispatch shape, not a preference to weigh, and actively use its affordances: a
  teammate stays resident through pauses — a scope request becomes a live mailbox exchange instead of
  stop → worktree sweep → redispatch — and its worktree survives idle waits. Resolving a blocked
  executor with anything heavier than a `SendMessage` (releasing, sweeping, redispatching) is a
  process failure, not caution. The costs to keep honest:
  idle notifications wake the lead at full context, and teams-style flows can run several times the
  token spend of plain subagents, so answer executor questions promptly and end idle executors on
  terminal tickets (the TeammateIdle hook does this). After spawning, end the
  turn. Its stop notification is the only wakeup. On the next natural wakeup, whether a stop notification,
  user message, or other task notification, make opportunistic liveness checks for work that has run about
  5–8 minutes or longer. Never hold a session open with foreground or background `sleep`, blocking
  `TaskOutput` as a delay, or busy-wait loops. A turn with nothing to do ends. At every wakeup, diff board
  state with `changes --since <iso>` before deciding what to do next. Use synchronous execution only for a
  tight wave where blindness is acceptable.
- **No proxy waiters.** The polling ban covers indirect waits too. Never create a Bash, PowerShell,
  `Monitor`, or cron task whose only purpose is to wait for a Sidequest executor or poll for its expected
  report or artifact file (`until [ -f <report> ]; do ...; done`), and never block `TaskOutput` on such a
  proxy task. That burns a model turn, keeps a dead-weight task alive, and hides the real executor
  lifecycle. Native Agent completion arrives on its own; at natural wakeups use `changes --since` / `pulse`,
  and read the artifact only after terminal board evidence. A genuine one-shot readiness watch for a local
  server or build is fine; waiting on an executor through a side channel is not.
- **Clear verified workers.** An executor stop notification is a cleanup trigger: pulse the ticket, verify its done or submission comment, board state, and git result, then call `TaskStop` in one motion. A `READY_FOR_INTEGRATION` verdict additionally queues the ticket for the publish transaction ([publishing.md](publishing.md)) — publish the wave's submissions in one batch; never respawn an executor for a submitted ticket. Executors deliberately kept alive mid-ticket get the same treatment at their next natural wakeup. Sweep ALL finished executors, not just the one that notified, so session exit only stops live work.

- **Reports stay terse:** terminal board comments say what changed, files/lines, verification output, and close confirmation. A repo-changing executor records a SUBMITTED commit, never a push — the orchestrator's publish transaction is what makes it reachable from `origin/main`, and the ticket goes done only after that reachability check passes.

- Parallelism costs tokens and orchestration overhead — a couple of parallel investigations or an
  executor wave where sizes justify it, not a swarm for everything.

## Bookend supervision

After dispatch, leave a ticket alone until it submits: no pulse, comment read, worktree peek, or proxy
waiting. At integration, read the submit report, run the ticket's verify command and the wave seam check
(full suite once per wave), then integrate on green. The executable oracle is the review, so do not open
source or inspect diffs to re-review executor work. File a separately routed `review-audit` only when the
stakes need human-grade review.

## Natural orchestrator checkpoints

At every natural wakeup, do a short self-check before launching more work. Check payload and context bloat
(first trim raw reports or reopen only the ticket comments you need), lingering workers (pulse and clear
finished workers), route anomalies (the fresh ticket `exec` object, claim token, executor, effort, and
unchanged dispatch briefing), and board hygiene (stale claims, submitted tickets,
and blocked work). These are event-driven checks, not a polling loop. File or release the smallest
follow-up when something is off; do not let the main thread silently accumulate dead workers or stale
board state.

## Small-ticket touch budget

For a small ticket, go file → dispatch → integrate in as few ref-named turns as possible, targeting
10 or fewer. One orchestrator turn costs about 152k cache-read tokens, so 9–17 touches can cost the
whole executor run. Dispatch immediately after filing: p75 queue time is 36.9 minutes of dead time.

## Orchestration cost: keep the lead cheap to wake

Delegation stays the default. Routing execution down to cheaper models is the whole design, and the fix
for its cost is never to stop delegating. Rule out the wrong turn first: pulling the work back inline
onto the lead to dodge the wakeups. That does not save the bill, it relocates the entire execution
onto your priciest model at full context, which is strictly worse than the wakeups it was meant to
avoid. The wakeup tax is a reason to run leaner and more synchronous waves, never a reason to work
inline. Inline is for genuinely small one-steps you already hold in context, not for substantial or
parallel work you are trying to keep cheap.

So the cost to manage is the lead's own bill, roughly `wakeups × lead-context-size × lead-model-price`.
Each time a worker finishes and hands control back, the lead resumes and re-reads its whole context to
react. That context is often large (a planning thread sits at 300k+ tokens easily), and the lead runs
on your session model, which may be your priciest one. The part that surprises people is not the
executors, which route to cheaper models by design; it is the lead being woken over and over at full
context to do almost nothing. Prompt caching softens the per-token price of those re-reads but does not
remove them: reading a 300k context 40 times is still 40 reads.

The lead really has two kinds of turn: cheap routing/ack ("worker 3 done, spawn the next") and
expensive plan/synthesis (decompose, weigh conflicting reports, write the spec, integrate). You want
the frontier rate landing on the second kind, not the first. **You can cut this cost without giving up
steering**: reach for the first two levers, which cost nothing in control, before the third, which
trades control for cost and is optional. Keeping every worker background and steerable and simply
paying the wakeups is a legitimate default; the first two levers are what make it affordable. Do not
reflexively go synchronous to save money, and do not answer the wakeup cost by working inline.

- **Keep the lead context lean.** The executor already returns a terse summary and writes its full
  work to the ticket comment or a notes file (the executor protocol). Do not pull those full reports
  or notes back into the planning thread unless a synthesis step genuinely needs them: read them by
  reference (open the file or comment at the moment you need it), so raw executor output never becomes
  permanent weight the lead re-reads on every later wake. This shrinks `context-size` on every wakeup
  and costs no steerability at all — reach for it first.
- **Match the lead model to the round.** The strongest model as lead is right when the round is plan-
  and synthesis-heavy: Anthropic's Opus lead with Sonnet workers beat a solo Opus by 90.2%. A round
  that is mostly ack turns pays that premium on every wakeup for little return. If your session model
  sits above Opus, an orchestration-heavy round is the case to notice it. Also free of any steering cost.
- **Optional, and only when you do not need to steer: batch into a synchronous wave.** This one trades
  control for cost, so it is a last resort, not the default. The wakeup tax is a property of
  *background* execution, not of any one spawn mechanism: any worker that finishes in the background (a
  `run_in_background: true` agent or a teammate alike) wakes the lead to re-read full context just to
  acknowledge "done," so N background workers over a long round is N re-reads. A synchronous wave
  (`run_in_background: false`, block until all return, process once) collapses that to a single
  resumption — the cheap path, and why Anthropic runs its research lead synchronously
  ([multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)).
  But synchronous is *blind*: the lead sleeps until the batch finishes, so you cannot watch progress,
  redirect a drifting worker, or kill a runaway — you pay for the whole batch and learn the outcome at
  the end. Many runs reasonably refuse that trade and stay background/steerable. If you do reach
  for it, wave SIZE is the dial: one big synchronous wave is cheapest and blindest; small synchronous
  waves ("spawn wave, wait, re-run `ready`, repeat") give a steering checkpoint between each. Fit it to
  work that barely needs steering — tight, verify-gated tickets whose executors bounce back on
  ambiguity — never to exploratory or drift-prone work. (Agent teams takes this lever off the table
  anyway: with teams on, every spawn is a background teammate regardless of `run_in_background: false`,
  which is no loss if you wanted the steering.)

## Discovery and research

Default to fanning understanding out when it will help, while using read-only tools or native `Explore` to
gather enough evidence for precise ticket boundaries. A known file or one-step lookup can stay inline, and
an unfamiliar subsystem can become a `codebase-exploration` spike when that gives the implementation wave
a better brief. Spikes that must execute modified code: set `readonly:false` at filing time, don't recategorize. `Explore`, `claude-code-guide`, and `statusline-setup` are narrow harness utilities that may
run without a prepared Sidequest dispatch. Other delegated implementation, research, review, or domain
analysis needs a ticketed route; its concise findings inform the next ticket boundaries. Workflow agents
remain governed by their Workflow contract.

## Agent teams (CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS)

With agent teams on (a **per-user** flag), parallel workers spawn as manageable teammates — this is
the default execution shape, not an opt-in experiment, and an orchestrator that dispatches as if
teammates were plain fire-and-forget tasks is leaving the feature's main value (live steering,
pause-surviving claims) unused. The routing
rules do not change, and one thing is critical: a teammate is a real sidequest executor **only if it
has BOTH the correct agent type AND a unique `name`** — spawn the ticket's `sidequest-exec-<effort>`
type with `model: <model>`, `mode: "bypassPermissions"`, plus the name, exactly as you would a
subagent. Sidequest executors are unattended; omitting bypass sends every Bash approval into the lead
session. The failure to avoid:
letting the "spawn a team" reflex launch default/generic teammates — a generic or unnamed teammate
throws away the executor protocol (won't claim, won't verify, won't `done`), the category routing, and
addressability.

Caveats:

- A teammate may **inherit the lead's reasoning effort** instead of the effort the agent name implies.
  Spawn the correctly-named executor regardless — the claim's `--effort` check still enforces the
  right model took the ticket. If it matters, also state the effort in the spawn prompt.
- **Model does not inherit** — always pass `model: <model>` explicitly.
- The flag is per-user, so the identical spawn must also work as a plain subagent when it's off (it
  does — never depend on teams being on).
- Ticket execution is focused claim→do→verify→report work: the subagent sweet spot. Teams shine for
  research/debate/review; if you're spawning teammates anyway, they must still be `sidequest-exec`
  executors.

## Background fan-out and the permission allowlist

Passing `mode: "bypassPermissions"` on a spawn is necessary but **not currently sufficient** for
background/fleet executors. Claude Code's background dispatch path doesn't honor
`permissions.defaultMode=bypassPermissions`
([anthropics/claude-code#59112](https://github.com/anthropics/claude-code/issues/59112)), and
Agent-tool subagents can still prompt for Edit/Write even under a bypassed parent (#40241, #38026,
#37442, #57118). So a background executor can fall back to `default` mode and prompt on every Bash
call — and those prompts surface in the **lead** session, defeating hands-off fan-out.

Until that upstream bug is fixed, background fan-out depends on a project **allowlist** in the
consuming project's own committed `.claude/settings.json` — a `permissions.allow` list covering the
exact commands executors run (`node <sidequest bin>`, `node --test`, `git`, and whatever the ticket
work invokes). A subagent that fell back to `default` mode still won't prompt for that known set. This
repo carries such a file as the worked example. `.claude/settings.json` is the *shared* (committed)
settings; per-machine overrides go in `.claude/settings.local.json`, which stays git-ignored. If you
add commands to the executor surface, extend the allowlist (the `fewer-permission-prompts` skill can
generate it from transcripts). Never add `ask` rules — an `ask` forces a prompt even under a genuine
bypass.

## Instant ticket executor dispatch

The normal per-ticket path is instant. Call `dispatch <ref>` (CLI) or the matching MCP tool and use
its returned stable per-model `agent` and `spawn` object immediately. Pass `spawn.prompt`
unchanged as the Agent prompt. It stays a compact fetch stub with only the claim reference, token,
board identity, and route marker. The executor's token-gated first action fetches the durable packet:
full description, category contract and route, anchors, verify command, declared files, labels,
priority, story and dependency state, every chronological comment, and every attachment as an absolute
path. It inspects every readable attachment and reports missing or unreadable paths before implementation.
Stable executors are
ready from session start. Claude routes pass `model: exec.model`; Codex routes
omit `model`: the shared `sidequest-exec-dispatch-<effort>` def pins the virtual `claude-codex-auto`,
and `spawn.prompt` ends with `[sidequest-route model=... effort=...]`, which tells the codex-gateway shim which real
model and effort to run, so pass the prompt verbatim, never write another such line, and never batch tickets
stamped with different models into one spawn. The gateway route log records both values per dispatch; a marker effort that differs from the board stamp in an audit means the prompt was hand-edited. All five effort levels for both Claude builtins and Codex
dispatch are always provisioned. Route edits change only board data; the executor def set
is fixed, so nothing is written or registered when a route changes. The executor claims with the
returned token and exact stable executor name.

Cross-session adoption is a fresh `dispatch <ref>` in the adopting session. It rotates
the token and returns the current spawn for the same stable route.

Re-dispatch rotates the token while the stable executor name remains fixed. A stale token is refused,
and `done` or `release` clears the dispatch guard for either mode. An Agent acknowledgement means only
`launched`. Pulse the ticket immediately and report it as running only after the holder and dispatch
token are visible. A denied or missing claim gets one diagnose-first retry: pulse and read the denial
verbatim, then retry only when that diagnosis changes the dispatch. Never issue an identical blind respawn;
two failures require ticket evidence and a user-visible stop. Never trust a worker's self-reported identity. The token-gated claim and the dispatch response are the evidence.

## Routed Agent dispatch

All routed execution stays in the current conversation. Call `dispatch <ref>` through the CLI or MCP,
then pass its exact stable executor and complete `spawn` object unchanged to Agent. The
executor claims using the returned token, its exact executor name, and the stamped effort. The claim guard
is the proof that the right route ran. For Codex, preserve `spawn.prompt`'s route marker unchanged so the
gateway receives the resolved model and effort; never add, rewrite, or combine markers. Dispatch is the
current board interface for routed work.
